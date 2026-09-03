import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";
import type { IncomingMessage } from "./types.js";

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return pool;
}

/** Path to the schema DDL, resolved from the project root in both dev (src/) and prod (dist/). */
function schemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "scripts", "init.sql");
}

/**
 * Create the database connection pool and apply the schema idempotently.
 *
 * - mode "postgres": real PostgreSQL via a pg.Pool.
 * - mode "memory":   embedded in-memory Postgres (pg-mem). Data lives only
 *                    for the lifetime of the process — used for dev/testing.
 *
 * The DDL in scripts/init.sql is written with IF NOT EXISTS, so re-running
 * it against an existing database is a no-op.
 */
export async function initDb(): Promise<void> {
  if (config.db.mode === "memory") {
    const { newDb } = await import("pg-mem");
    const mem = newDb();
    const PgAdapter = mem.adapters.createPg();
    pool = new PgAdapter.Pool() as unknown as pg.Pool;
    console.log("[db] using embedded in-memory postgres (pg-mem)");
    await applySchema();
  } else {
    const real = new pg.Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    real.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
    pool = real;
    console.log(
      `[db] using postgres at ${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`,
    );
    // In postgres mode the schema is owned by the my-db deployment init
    // scripts (this user has no CREATE privilege); nothing to apply here.
    console.log(
      `[db] schema ${config.postgres.schema}.messages assumed to exist (managed by my-db init)`,
    );
  }
}

/** Apply scripts/init.sql. Statements are executed one-by-one so the file also works with pg-mem. */
async function applySchema(): Promise<void> {
  const ddl = await readFile(schemaPath(), "utf8");
  const statements = ddl
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter((s) => s.length > 0);

  const p = getPool();
  for (const statement of statements) {
    await p.query(statement);
  }
  console.log(
    `[db] schema applied (${statements.length} statements, idempotent)`,
  );
}

export interface TableRowCount {
  table: string;
  count: number;
}

/**
 * Row count of every table in the service schema, ordered by table name.
 */
/**
 * Names of all tables in the service schema, ordered by name.
 */
export async function listTables(): Promise<string[]> {
  const schema = config.postgres.schema;
  let tables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  // pg-mem does not populate information_schema; fall back to the known
  // table set from scripts/init.sql (keep in sync when tables are added).
  if (tables.rows.length === 0) {
    tables = { rows: [{ table_name: "messages" }] } as typeof tables;
  }
  return tables.rows.map((r) => r.table_name);
}

/**
 * Row count of every table in the service schema, ordered by table name.
 */
export async function getRowCounts(): Promise<TableRowCount[]> {
  const schema = config.postgres.schema;
  const counts: TableRowCount[] = [];
  for (const table of await listTables()) {
    // table names come from the catalog, not user input
    const result = await query<{ count: string }>(
      `SELECT count(*) AS count FROM ${schema}.${table}`,
    );
    const raw = result.rows[0]?.count;
    if (raw !== undefined) counts.push({ table, count: Number(raw) });
  }
  return counts;
}

/**
 * Count rows in a single table. The caller must have validated `table`
 * against listTables() — it is interpolated, never parameterized.
 */
export async function countTableRows(table: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT count(*) AS count FROM ${config.postgres.schema}.${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Read rows from a single table (natural table order), capped at `limit`.
 * The caller must have validated `table` against listTables() — it is
 * interpolated, never parameterized.
 */
export async function listTableRows(
  table: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await query<Record<string, unknown>>(
    `SELECT * FROM ${config.postgres.schema}.${table} LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/** Log the row count of every table in the service schema (best effort). */
export async function logRowCounts(): Promise<void> {
  try {
    const counts = await getRowCounts();
    const schema = config.postgres.schema;
    console.log(
      `[db] row counts: ${
        counts.map((c) => `${schema}.${c.table}=${c.count}`).join(", ") ||
        "(no tables)"
      }`,
    );
  } catch (err) {
    console.error(
      `[db] failed to read row counts: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

const INSERT_SQL = `
  INSERT INTO ${config.postgres.schema}.messages (source, topic, payload, qos, retained)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id, received_at
`;

/**
 * Coerce a payload for JSONB storage: JSON strings are parsed into real
 * JSON values; non-JSON strings are JSON-stringified so they are stored
 * as a JSON string scalar (a bare string would fail the jsonb cast).
 */
function coercePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return JSON.stringify(payload);
    }
  }
  return payload;
}

/**
 * Persist a single message. Payload is stored as JSONB when it is valid
 * JSON; anything else is stored as a JSON string scalar so no data is
 * ever dropped.
 */
export async function insertMessage(
  msg: IncomingMessage,
): Promise<{ id: number; receivedAt: Date }> {
  const result = await query<{ id: number; received_at: Date }>(INSERT_SQL, [
    msg.source,
    msg.topic,
    coercePayload(msg.payload),
    msg.qos ?? null,
    msg.retained ?? false,
  ]);

  const row = result.rows[0];
  if (!row) throw new Error("Insert returned no rows");
  return { id: row.id, receivedAt: row.received_at };
}

/** Persist a batch of messages in a single transaction. */
export async function insertMessages(
  batch: IncomingMessage[],
): Promise<number> {
  if (batch.length === 0) return 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const msg of batch) {
      await client.query(INSERT_SQL, [
        msg.source,
        msg.topic,
        coercePayload(msg.payload),
        msg.qos ?? null,
        msg.retained ?? false,
      ]);
    }
    await client.query("COMMIT");
    return batch.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
