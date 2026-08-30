# append-service

A TypeScript Node server that ingests messages from **MQTT** and **HTTP** into **PostgreSQL**.

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Entry point — wires MQTT + HTTP, graceful SIGINT/SIGTERM shutdown |
| `src/config.ts` | Env-var config with sensible localhost defaults |
| `src/mqtt.ts` | MQTT client: subscribes to a topic filter (default `#`), auto-reconnects every 5s |
| `src/http.ts` | Express 5 API (write + read endpoints) |
| `src/db.ts` | `pg` pool, JSONB-aware inserts, transactional batch insert |
| `src/types.ts` | Shared `IncomingMessage` / `StoredMessage` types |
| `scripts/init.sql` | `messages` table (source, topic, payload JSONB, qos, retained, received_at) + indexes |
| `scripts/init-db.sh` | Creates the DB and applies the schema |
| `.env.example` | Config template |
| `AGENTS.md` | Project description, API docs, config table, dev conventions |

## How it works

- **MQTT path:** every message on the subscribed filter is persisted with its topic, QoS, and retain flag; parse failures are logged per-message without crashing.
- **HTTP path:**
  - `POST /messages` — write one (`{topic, payload, qos?}`)
  - `POST /messages/batch` — atomic multi-write in one transaction
  - `GET /messages` — read with `source`, `topic`, `since`, `limit` filters
  - `GET /health` — 200 if DB reachable, 503 otherwise
- Payloads parsing as JSON are stored as **JSONB**; raw strings fall back to JSON strings so nothing is dropped.

## Verification

- `npm run build` and `npm run typecheck` pass clean (strict mode)
- Live smoke test: server boots, HTTP returns correct 400/500/503 codes with the DB down, MQTT retries in the background, and SIGTERM shuts down gracefully

## Running with real services

```bash
cp .env.example .env   # point PG* and MQTT_URL at your services
npm run init-db
npm start              # or: npm run build && npm run start:dist
```
