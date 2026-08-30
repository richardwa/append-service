# AGENTS.md — append-service

## Project description

**append-service** is a Node.js (TypeScript) service that ingests messages from two
sources and persists them to PostgreSQL:

1. **MQTT** — connects to an MQTT broker, subscribes to a configurable topic filter
   (default `#`, i.e. everything), and writes every received message to the database.
2. **HTTP** — an Express API for writing messages programmatically and reading
   stored messages back.

Both paths converge on a single `messages` table. String payloads that parse as
JSON are stored as JSONB; anything else is stored as a JSON string, so no data
is ever dropped.

## Tech stack

- **Runtime:** Node.js (ES modules), TypeScript (strict)
- **HTTP:** Express 5
- **MQTT:** `mqtt` (MQTT.js) package
- **Database:** PostgreSQL via `pg` (connection pool)
- **Dev tooling:** `tsx` for dev running, `tsc` for builds, Prettier for formatting

## Project layout

```
src/
  server.ts   Entry point: wires everything together, graceful shutdown
  config.ts   Env-var configuration with defaults (no config => localhost services)
  http.ts     Express app: write/read endpoints
  mqtt.ts     MQTT client: subscribe + persist incoming messages
  db.ts       pg pool, insert helpers (single + transactional batch)
  types.ts    Shared types (IncomingMessage, StoredMessage, MessageSource)
scripts/
  init.sql    Schema (messages table + indexes)
  init-db.sh  Creates the database and applies init.sql
.env.example  Template for environment configuration
```

## Data model

`messages` table (see `scripts/init.sql`):

| Column      | Type        | Notes                                  |
| ----------- | ----------- | -------------------------------------- |
| id          | BIGSERIAL   | Primary key                            |
| source      | TEXT        | `mqtt` or `http` (CHECK constraint)    |
| topic       | TEXT        | MQTT topic, or client-supplied topic   |
| payload     | JSONB       | Parsed JSON, or JSON string fallback   |
| qos         | SMALLINT    | MQTT QoS (0–2), null for HTTP writes   |
| retained    | BOOLEAN     | MQTT retain flag, false for HTTP       |
| received_at | TIMESTAMPTZ | Defaults to `now()`                    |

Indexes: `received_at DESC`, `topic`, `source`.

## API

- `GET /health` — 200 if the DB responds, 503 otherwise.
- `POST /messages` — write one message. Body: `{"topic": "...", "payload": <any>, "qos"?: 0|1|2}` → `201 {"id", "receivedAt"}`.
- `POST /messages/batch` — write many messages atomically. Body: `{"messages": [{"topic", "payload"}, ...]}` → `201 {"inserted": n}`.
- `GET /messages` — list newest first. Query params: `source=mqtt|http`, `topic=...`,
  `since=<ISO 8601>`, `limit=1..1000` (default 100).

## Configuration (environment variables)

| Variable         | Default                  | Purpose                       |
| ---------------- | ------------------------ | ----------------------------- |
| `PORT`           | `3000`                   | HTTP port                     |
| `PGHOST`         | `localhost`              | Postgres host                 |
| `PGPORT`         | `5432`                   | Postgres port                 |
| `PGDATABASE`     | `messages`               | Postgres database             |
| `PGUSER`         | `postgres`               | Postgres user                 |
| `PGPASSWORD`     | `postgres`               | Postgres password             |
| `MQTT_URL`       | `mqtt://localhost:1883`  | Broker URL (`mqtts://` works) |
| `MQTT_USERNAME`  | unset                    | Broker username               |
| `MQTT_PASSWORD`  | unset                    | Broker password               |
| `MQTT_CLIENT_ID` | `append-service`         | MQTT client id                |
| `MQTT_TOPIC`     | `#`                      | Subscription topic filter     |
| `MQTT_QOS`       | `1`                      | Subscription QoS              |

Copy `.env.example` to `.env` to override; everything defaults to local services.

## Running locally

```bash
npm install
npm run init-db        # creates DB + schema (uses scripts/init-db.sh)
npm start              # tsx src/server.ts (dev mode)
# or
npm run build && npm run start:dist   # compiled JS from dist/
```

The service is resilient: the MQTT client auto-reconnects every 5 s, and MQTT
persistence failures are logged per-message without crashing the process.
SIGINT/SIGTERM trigger a graceful shutdown (MQTT disconnect → pool close).

## Development notes for agents

- **Formatting:** Prettier runs automatically via `prebuild` (`npm run build`).
  Run `npm run format` to format without building.
- **Type checking:** `npm run typecheck` — must pass with zero errors before
  considering work done.
- **Imports within `src/`** use the `.js` extension (NodeNext ESM resolution).
- **No ORM** — raw SQL through the `pg` pool in `db.ts`. Keep SQL in `db.ts`.
- **Schema changes:** update `scripts/init.sql`. For existing deployments, write
  an idempotent migration (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
  or an ALTER-based migration file in `scripts/`.
- **Error handling convention:** per-message failures are logged and skipped
  (MQTT keeps consuming); request failures return 4xx/5xx JSON
  (`{"error": "..."}`). Never let a single bad message crash the process.
- **Batch inserts** use a single transaction (`insertMessages`) — either all
  messages persist or none.
- When adding endpoints, validate inputs explicitly and return 400 with a
  descriptive `error` message on bad input.