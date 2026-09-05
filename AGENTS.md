# AGENTS.md — append-service

## Project description

**append-service** is a Node.js (TypeScript) service that ingests device readings
from two sources and persists them to PostgreSQL:

1. **MQTT** — the service **is** the MQTT broker (embedded `aedes`): devices
   connect to it directly and power telemetry is extracted from published
   messages and written to the database.
2. **HTTP** — an Express API for device-gated reading ingestion and reading
   stored rows back.

Device-gated structured appends: both ingestion paths look up the source device
in the existing `device` table (owned by the my-db init scripts) and append
readings to the existing `temperature`/`humidity`/`power` tables — nothing is
inserted for unregistered devices:

- `POST /switchbot` — matches `device.external_id` (MAC, case-insensitive);
  inserts `temperature_c` → `temperature`, `humidity` → `humidity`.
- MQTT `tele/<location>/SENSOR` — matches `device.location`
  (case-insensitive); inserts `ENERGY.Power` → `power` (watts). Messages that
  do not match a device (or don't contain `ENERGY.Power`) are ignored.

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
  http.ts     Express app: read endpoints + /switchbot ingestion
  broker.ts   Embedded MQTT broker (aedes): listen + record power telemetry
  db.ts       pg pool, device lookups, reading insert helpers
scripts/
  init.sql       Schema (device/temperature/humidity/power tables), applied idempotently on boot
  init-db.sh     Creates the database and applies init.sql (optional now)
  simulate-tasmota.mjs   MQTT simulator: Tasmota power meter (tele/tasmota_<id>/SENSOR)
  send-temperature.mjs   HTTP simulator: temperature/humidity readings via POST /switchbot
env.example  Template for environment configuration
```

## Data model

`scripts/init.sql` (memory-mode mirrors of the production tables):

- `device` — `id`, `name`, `type`, `external_id` (e.g. MAC), `location`, `created_at`
- `temperature` — `time`, `device_id` (FK), `value_c`
- `humidity` — `time`, `device_id` (FK), `value_pct`
- `power` — `time`, `device_id` (FK), `watts`

The schema is applied **automatically and idempotently on server start**
(`initDb()` in `src/db.ts` reads `scripts/init.sql` and runs each statement;
all DDL uses `IF NOT EXISTS`). In postgres mode the tables are owned by the
my-db init scripts and this file is not applied.

## API

- `GET /health` — 200 if the DB responds, 503 otherwise.
- `GET /row-counts` — row count of every table in the service schema.
  → `{"schema", "tables": [{"table", "count"}...], "total"}`.
- `POST /switchbot` — SwitchBot-scanner readings. Body: `{"mac": "DD:42:05:86:36:8A",
"temperature_c"?: n, "humidity"?: n, ...}`. The MAC is looked up (case-insensitive)
  against `device.external_id`; when the device is registered, `temperature_c`/`humidity`
  are appended to the existing `temperature`/`humidity` tables keyed by device id
  (→ `201 {"deviceId", "temperature", "humidity"}`), otherwise nothing is inserted
  (→ `404 {"error": "unknown device: <mac>"}`).
- `GET /:table/list?limit=N` — rows from any table in the schema (e.g.
  `/power/list?limit=10`). `limit` 1..1000, default 100. 404 for unknown
  tables (the name is whitelist-validated against the schema before use).
  → `{"table", "count": <rows returned>, "limit", "rows": [...]}`.
- `GET /:table/count` — row count of one table. → `{"table", "count"}`.

## Configuration (environment variables)

| Variable     | Default     | Purpose                            |
| ------------ | ----------- | ---------------------------------- |
| `PORT`       | `8401`      | HTTP listener port                 |
| `MQTT_PORT`  | `1883`      | Embedded MQTT broker listener port |
| `DB_MODE`    | `postgres`  | `postgres` or `memory` (pg-mem)    |
| `PGHOST`     | `localhost` | Postgres host                      |
| `PGPORT`     | `5432`      | Postgres port                      |
| `PGDATABASE` | `messages`  | Postgres database                  |
| `PGUSER`     | `postgres`  | Postgres user                      |
| `PGPASSWORD` | `postgres`  | Postgres password                  |

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
  aedes MQTT broker on `MQTT_PORT`. MQTT processing failures are logged
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
- **Multi-row inserts** (e.g. a SwitchBot reading with both temperature and
  humidity) use a single transaction — either all rows persist or none.
- When adding endpoints, validate inputs explicitly and return 400 with a
  descriptive `error` message on bad input.
