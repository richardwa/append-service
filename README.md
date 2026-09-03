# append-service

A TypeScript Node server that ingests messages from **MQTT** and **HTTP** into **PostgreSQL**. The service **is** the MQTT broker — devices connect directly to it.

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Entry point — wires the broker + HTTP listeners, graceful SIGINT/SIGTERM shutdown |
| `src/config.ts` | Env-var config with sensible localhost defaults |
| `src/broker.ts` | Embedded MQTT broker (aedes): listens on `MQTT_PORT`, persists every published message |
| `src/http.ts` | Express 5 API (write + read endpoints) |
| `src/db.ts` | `pg` pool, JSONB-aware inserts, transactional batch insert |
| `src/types.ts` | Shared `IncomingMessage` / `StoredMessage` types |
| `scripts/init.sql` | `messages` table (source, topic, payload JSONB, qos, retained, received_at) + indexes |
| `scripts/init-db.sh` | Creates the DB and applies the schema |
| `env.example` | Config template |
| `AGENTS.md` | Project description, API docs, config table, dev conventions |

## How it works

- **MQTT path:** the embedded broker (aedes) accepts devices on `MQTT_PORT` (default 1883); every published message is persisted with its topic, QoS, and retain flag; persistence failures are logged per-message without crashing.
- **HTTP path:**
  - `POST /messages` — write one (`{topic, payload, qos?}`)
  - `POST /messages/batch` — atomic multi-write in one transaction
  - `GET /messages` — read with `source`, `topic`, `since`, `limit` filters
  - `GET /row-counts` — row count of every table in the schema
  - `GET /:table/list?limit=N` — rows from any schema table (limit 1..1000, default 100)
  - `GET /:table/count` — row count of one table
  - `GET /health` — 200 if DB reachable, 503 otherwise
- Payloads parsing as JSON are stored as **JSONB**; anything else is stored as a JSON string scalar so no data is dropped.
- **Schema is created automatically on server start** (idempotent `IF NOT EXISTS` DDL from `scripts/init.sql`).
- **Embedded in-memory DB:** with `DB_MODE=memory` the `pg` pool is replaced by [pg-mem](https://github.com/oguimbal/pg-mem) — the same SQL runs, no Postgres needed for dev/testing.

## Running

```bash
npm run dev           # dev: in-memory DB (pg-mem), no services required
npm test              # tests against the in-memory DB
npm run build         # format + compile to dist/
npm start             # prod: node dist/server.js (set PG*; DB_MODE=postgres)
```

## Test scripts (message simulators)

Scripts to exercise both ingestion paths without real hardware:

| Script | Command | What it does |
| --- | --- | --- |
| `scripts/simulate-tasmota.mjs` | `npm run test:mqtt` | Simulates a Tasmota energy-monitoring plug publishing to `tele/tasmota_A4C138/SENSOR` |
| `scripts/send-temperature.mjs` | `npm run test:http` | POSTs temperature/humidity readings to `POST /messages` |

Simulator options (both): `--count N` (send N readings), `--interval S` (continuous loop every S seconds), `--location` (temperature script only). Env: `MQTT_URL` (broker to publish to), `BASE_URL`.

Example — full local loop with zero external services:

```bash
npm run dev        # terminal 1: server (in-memory DB) — both listeners come up
npm run test:mqtt  # terminal 2: publish Tasmota power readings over MQTT
npm run test:http  # terminal 2: POST temperature readings over HTTP
curl 'localhost:8401/messages?source=mqtt'   # verify what was stored
```

## Verification

- `npm run build` and `npm run typecheck` pass clean (strict mode)
- `npm test` passes: schema init, single insert, batch insert, JSONB read-back
- Live smoke test: server boots, HTTP returns correct 400/500/503 codes with the DB down, and SIGTERM shuts down gracefully
- Dev smoke test (`npm run dev`): health ok, single + batch writes, read-back with JSON objects and raw string scalars
- End-to-end sim test: 3 Tasmota MQTT readings (qos 1) + 2 HTTP temperature readings all persisted and queryable via `GET /messages` with `source`/`topic` filters
