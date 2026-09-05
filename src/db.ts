import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.js";

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
      `[db] schema ${config.postgres.schema} (device/temperature/humidity/power) assumed to exist (managed by my-db init)`,
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
    tables = {
      rows: [
        { table_name: "device" },
        { table_name: "temperature" },
        { table_name: "humidity" },
        { table_name: "power" },
      ],
    } as typeof tables;
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

export async function close(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/**
 * Look up a device id by MAC address. Matches case-insensitively against
 * device.external_id (production stores MACs like "DD:42:05:86:36:8A").
 * Returns null when no device is registered for the MAC.
 */
export async function getDeviceIdByMac(mac: string): Promise<number | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM ${config.postgres.schema}.device
     WHERE upper(external_id) = upper($1)
     LIMIT 1`,
    [mac],
  );
  const raw = result.rows[0]?.id;
  return raw === undefined ? null : Number(raw);
}

/**
 * Look up a device id by location name (case-insensitive). The MQTT path
 * uses this: Tasmota publishes to tele/<location>/SENSOR and device.location
 * holds the same name (e.g. "Albert", stored with any capitalization).
 * Returns null when no device is registered for the location.
 */
export async function getDeviceIdByLocation(
  location: string,
): Promise<number | null> {
  const result = await query<{ id: string }>(
    `SELECT id FROM ${config.postgres.schema}.device
     WHERE lower(location) = lower($1)
     LIMIT 1`,
    [location],
  );
  const raw = result.rows[0]?.id;
  return raw === undefined ? null : Number(raw);
}

/**
 * Append a watts reading to the existing power table, keyed by device id.
 * Used by the MQTT path for Tasmota ENERGY.Power telemetry.
 */
export async function insertPowerReading(
  deviceId: number,
  watts: number,
): Promise<void> {
  await query(
    `INSERT INTO ${config.postgres.schema}.power (time, device_id, watts)
     VALUES (now(), $1, $2)`,
    [deviceId, watts],
  );
}

/** What was persisted for a SwitchBot reading. */
export interface SwitchbotInsertResult {
  deviceId: number;
  temperature: boolean;
  humidity: boolean;
}

/**
 * Append a SwitchBot reading to the existing temperature/humidity tables
 * (same tables the HTTP /switchbot path feeds). Each present value becomes
 * one row keyed by device_id; both inserts happen in a single transaction.
 * Returns which tables were written.
 */
export async function insertSwitchbotReading(
  deviceId: number,
  reading: { temperatureC?: number; humidity?: number },
): Promise<SwitchbotInsertResult> {
  const schema = config.postgres.schema;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let temperature = false;
    let humidity = false;
    if (reading.temperatureC !== undefined) {
      await client.query(
        `INSERT INTO ${schema}.temperature (time, device_id, value_c)
         VALUES (now(), $1, $2)`,
        [deviceId, reading.temperatureC],
      );
      temperature = true;
    }
    if (reading.humidity !== undefined) {
      await client.query(
        `INSERT INTO ${schema}.humidity (time, device_id, value_pct)
         VALUES (now(), $1, $2)`,
        [deviceId, reading.humidity],
      );
      humidity = true;
    }
    await client.query("COMMIT");
    return { deviceId: Number(deviceId), temperature, humidity };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
