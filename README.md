# append-service

A TypeScript Node server that ingests device readings from **MQTT** and **HTTP** into **PostgreSQL**. The service **is** the MQTT broker — devices connect directly to it.

## Files

| File                 | Purpose                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `src/server.ts`      | Entry point — wires the broker + HTTP listeners, graceful SIGINT/SIGTERM shutdown            |
| `src/config.ts`      | Env-var config with sensible localhost defaults                                              |
| `src/broker.ts`      | Embedded MQTT broker (aedes): listens on `MQTT_PORT`, records power telemetry into `power`   |
| `src/http.ts`        | Express 5 API (read endpoints + `/switchbot` ingestion)                                      |
| `src/db.ts`          | `pg` pool, device lookups, device-gated reading inserts                                      |
| `scripts/init.sql`   | `device`/`temperature`/`humidity`/`power` tables (memory-mode mirrors), applied idempotently |
| `scripts/init-db.sh` | Creates the DB and applies the schema                                                        |
| `env.example`        | Config template                                                                              |
| `AGENTS.md`          | Project description, API docs, config table, dev conventions                                 |

## How it works

- **MQTT path:** the embedded broker (aedes) accepts devices on `MQTT_PORT` (default 1883); messages matching the configured topic filters (default `tele/+/SENSOR`) are parsed and `ENERGY.Power` is appended to the `power` table (gated by `device.location`); failures are logged per-message without crashing.
- **HTTP path:**
  - `POST /switchbot` — SwitchBot-scanner readings, gated by `device.external_id` (MAC)
  - `GET /row-counts` — row count of every table in the schema
  - `GET /:table/list?limit=N` — rows from any schema table (limit 1..1000, default 100)
  - `GET /:table/count` — row count of one table
  - `GET /health` — 200 if DB reachable, 503 otherwise
- **Device gating:** nothing is inserted for unregistered devices — the source is looked up in the `device` table first (MAC for `/switchbot`, location for MQTT).
- **Schema is created automatically on server start** (idempotent `IF NOT EXISTS` DDL from `scripts/init.sql`).
- **Embedded in-memory DB:** with `DB_MODE=memory` the `pg` pool is replaced by [pg-mem](https://github.com/oguimbal/pg-mem) — the same SQL runs, no Postgres needed for dev/testing.

## Running

```bash
npm run dev           # dev: in-memory DB (pg-mem), no services required
npm test              # tests against the in-memory DB
npm run build         # format + compile to dist/
npm start             # prod: node dist/server.js (set PG*; DB_MODE=postgres)
```

## Test scripts (device simulators)

Scripts to exercise both ingestion paths without real hardware:

| Script                         | Command             | What it does                                                                          |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------- |
| `scripts/simulate-tasmota.mjs` | `npm run test:mqtt` | Simulates a Tasmota energy-monitoring plug publishing to `tele/tasmota_A4C138/SENSOR` |
| `scripts/send-temperature.mjs` | `npm run test:http` | POSTs temperature/humidity readings to `POST /switchbot`                              |

Simulator options (both): `--count N` (send N readings), `--interval S` (continuous loop every S seconds), `--mac` (temperature script only). Env: `MQTT_URL` (broker to publish to), `BASE_URL`.

Example — full local loop with zero external services:

```bash
npm run dev        # terminal 1: server (in-memory DB) — both listeners come up
npm run test:mqtt  # terminal 2: publish Tasmota power readings over MQTT
npm run test:http  # terminal 2: POST temperature readings over HTTP
curl 'localhost:8401/row-counts'             # verify what was stored
curl 'localhost:8401/power/list?limit=10'    # inspect stored power readings
```

## Verification

- `npm run build` and `npm run typecheck` pass clean (strict mode)
- `npm test` passes: schema init, device lookups, power/temperature/humidity inserts
- Live smoke test: server boots, HTTP returns correct 400/500/503 codes with the DB down, and SIGTERM shuts down gracefully
- End-to-end sim test: 3 Tasmota MQTT readings (qos 1) recorded into `power` + 2 HTTP temperature readings recorded into `temperature`/`humidity`, all queryable via the `/row-counts` and `/:table/list` endpoints
