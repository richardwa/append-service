import pg from "pg";
import { config } from "./config.js";
import type { IncomingMessage } from "./types.js";

const pool = new pg.Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  database: config.postgres.database,
  user: config.postgres.user,
  password: config.postgres.password,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export function onPoolError(handler: (err: Error) => void): void {
  pool.on("error", handler);
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

const INSERT_SQL = `
  INSERT INTO messages (source, topic, payload, qos, retained)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id, received_at
`;

/**
 * Persist a single message. Payload is stored as JSONB when it is valid
 * JSON, otherwise as a JSON string so no data is ever dropped.
 */
export async function insertMessage(
  msg: IncomingMessage,
): Promise<{ id: number; receivedAt: Date }> {
  let payload: unknown = msg.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      // keep the raw string; JSONB accepts JSON string scalars too
    }
  }

  const result = await query<{ id: number; received_at: Date }>(INSERT_SQL, [
    msg.source,
    msg.topic,
    payload,
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const msg of batch) {
      let payload: unknown = msg.payload;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload) as unknown;
        } catch {
          // keep raw string
        }
      }
      await client.query(INSERT_SQL, [
        msg.source,
        msg.topic,
        payload,
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
  await pool.end();
}
