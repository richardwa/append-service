# AGENTS.md — append-service

## Project description

**append-service** is a Node.js (TypeScript) service that ingests messages from two
sources and persists them to PostgreSQL:

1. **MQTT** — the service **is** the MQTT broker (embedded `aedes`): devices
   connect to it directly and every published message is written to the database.
2. **HTTP** — an Express API for writing messages programmatically and reading
   stored messages back.

Both paths converge on a single `messages` table. String payloads that parse as
JSON are stored as JSONB; anything else is stored as a JSON string, so no data
is ever dropped.

## Tech stack

- **Runtime:** Node.js (ES modules), TypeScript (strict)
- **HTTP:** Express 5
- **MQTT:** `aedes` embedded broker (the `mqtt` package is only used by the simulator scripts)
- **Database:** PostgreSQL via `pg` (connection pool)
- **Dev/testing DB:** `pg-mem` embedded in-memory Postgres (no services needed)
- **Dev tooling:** `tsx` for dev running, `tsc` for builds, `node:test` for tests,
  Prettier for formatting

## Project layout

```
src/
  server.ts   Entry point: wires everything together, graceful shutdown
  config.ts   Env-var configuration with defaults (no config => localhost services)
  http.ts     Express app: write/read endpoints
  broker.ts   Embedded MQTT broker (aedes): listen + persist published messages
  db.ts       pg pool, insert helpers (single + transactional batch)
  types.ts    Shared types (IncomingMessage, StoredMessage, MessageSource)
scripts/
  init.sql       Schema (messages table + indexes), applied idempotently on boot
  init-db.sh     Creates the database and applies init.sql (optional now)
  simulate-tasmota.mjs   MQTT simulator: Tasmota power meter (tele/tasmota_<id>/SENSOR)
  send-temperature.mjs   HTTP simulator: temperature/humidity readings via POST /messages
env.example  Template for environment configuration
```

## Data model

`scripts/init.sql`:

| Column      | Type        | Notes                                  |
| ----------- | ----------- | -------------------------------------- |
| id          | BIGSERIAL   | Primary key                            |
| source      | TEXT        | `mqtt` or `http` (CHECK constraint)    |
| topic       | TEXT        | MQTT topic, or client-supplied topic   |
| payload     | JSONB       | Parsed JSON, or JSON string scalar     |
| qos         | SMALLINT    | MQTT QoS (0–2), null for HTTP writes   |
| retained    | BOOLEAN     | MQTT retain flag, false for HTTP       |
| received_at | TIMESTAMPTZ | Defaults to `now()`                    |

Indexes: `received_at DESC`, `topic`, `source`.

The schema is applied **automatically and idempotently on server start**
(`initDb()` in `src/db.ts` reads `scripts/init.sql` and runs each statement;
all DDL uses `IF NOT EXISTS`).

## API

- `GET /health` — 200 if the DB responds, 503 otherwise.
- `POST /messages` — write one message. Body: `{"topic": "...", "payload": <any>, "qos"?: 0|1|2}` → `201 {"id", "receivedAt"}`.
- `POST /messages/batch` — write many messages atomically. Body: `{"messages": [{"topic", "payload"}, ...]}` → `201 {"inserted": n}`.
- `GET /messages` — list newest first. Query params: `source=mqtt|http`, `topic=...`,
  `since=<ISO 8601>`, `limit=1..1000` (default 100).

## Configuration (environment variables)

| Variable         | Default                  | Purpose                         |
| ---------------- | ------------------------ | ------------------------------- |
| `PORT`           | `8401`                   | HTTP listener port              |
| `MQTT_PORT`      | `1883`                   | Embedded MQTT broker listener port |
| `DB_MODE`        | `postgres`               | `postgres` or `memory` (pg-mem) |
| `PGHOST`         | `localhost`              | Postgres host                   |
| `PGPORT`         | `5432`                   | Postgres port                 |
| `PGDATABASE`     | `messages`               | Postgres database             |
| `PGUSER`         | `postgres`               | Postgres user                 |
| `PGPASSWORD`     | `postgres`               | Postgres password             |

Copy `env.example` to `.env` to override; everything defaults to local services.

## Running / testing

```bash
npm run dev           # dev server with EMBEDDED in-memory db (pg-mem), no services needed
npm test              # node:test suite against the in-memory db
npm run build         # format + compile to dist/
npm start             # prod: node dist/server.js (requires a real Postgres, DB_MODE=postgres)
```

Notes:

- `DB_MODE=memory` swaps the `pg` pool for a `pg-mem` in-memory Postgres; the
  same SQL and schema run against both, so dev behaves like prod. Data is
  lost on restart — that is the point.
- `npm run init-db` is **optional** now (the server creates tables on boot);
  it is still useful to create the database/user ahead of time in prod.
- The service runs **two listeners**: the HTTP app on `PORT` and the embedded
  aedes MQTT broker on `MQTT_PORT`. MQTT persistence failures are logged
  per-message without crashing the process. SIGINT/SIGTERM trigger a
  graceful shutdown (broker close → pool close).
- **Testing without real services:** `npm run dev` + `npm run test:mqtt` /
  `npm run test:http` simulators cover both ingestion paths end-to-end (the
  MQTT simulator publishes to the embedded broker). Simulators accept
  `--count N` / `--interval S` and default to a single reading.

## Development notes for agents

- **Formatting:** Prettier runs automatically via `prebuild` (`npm run build`).
  Run `npm run format` to format without building.
- **Type checking:** `npm run typecheck` — must pass with zero errors before
  considering work done.
- **Imports within `src/`** use the `.js` extension (NodeNext ESM resolution).
- **No ORM** — raw SQL through the `pg` pool in `db.ts`. Keep SQL in `db.ts`.
  `initDb()` is the only place that creates the pool; `DB_MODE=memory` swaps
  in pg-mem for dev/tests. Never add pg-mem-specific or real-pg-specific SQL
  — both backends run the same statements.
- **Schema:** `scripts/init.sql` is the single source of truth. It is applied
  idempotently on every server start (all DDL must use `IF NOT EXISTS`), so
  adding a table or index there is enough — no separate migration runner.
- **Error handling convention:** per-message failures are logged and skipped
  (the broker keeps serving); request failures return 4xx/5xx JSON
  (`{"error": "..."}`). Never let a single bad message crash the process.
- **Batch inserts** use a single transaction (`insertMessages`) — either all
  messages persist or none.
- When adding endpoints, validate inputs explicitly and return 400 with a
  descriptive `error` message on bad input.