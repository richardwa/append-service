import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  close,
  countTableRows,
  getRowCounts,
  initDb,
  insertMessage,
  insertMessages,
  listTables,
  listTableRows,
  query,
} from "./db.js";

test(
  "in-memory db: schema init, insert, batch, read-back",
  { timeout: 15_000 },
  async (t) => {
    await initDb();
    t.after(() => close());

    // Single insert with a JSON string payload (stored as JSONB)
    const one = await insertMessage({
      source: "mqtt",
      topic: "sensors/temp",
      payload: '{"celsius": 21.5}',
      qos: 1,
      retained: false,
    });
    assert.ok(one.id > 0);
    assert.ok(one.receivedAt instanceof Date);

    // Non-JSON payload survives as a JSON string scalar
    const raw = await insertMessage({
      source: "http",
      topic: "raw",
      payload: "not json at all",
    });
    assert.ok(raw.id > one.id);

    // Transactional batch insert
    const inserted = await insertMessages([
      { source: "mqtt", topic: "sensors/hum", payload: { pct: 40 }, qos: 0 },
      { source: "http", topic: "sensors/co2", payload: { ppm: 620 } },
    ]);
    assert.equal(inserted, 2);

    // Read back through the same SQL the API uses
    const result = await query<{
      id: number;
      source: string;
      topic: string;
      payload: unknown;
    }>(
      `SELECT id, source, topic, payload FROM ${config.postgres.schema}.messages ORDER BY id`,
    );
    assert.equal(result.rows.length, 4);

    const temp = result.rows[0];
    assert.ok(temp);
    assert.equal(temp.topic, "sensors/temp");
    assert.deepEqual(temp.payload, { celsius: 21.5 }); // parsed to JSONB

    const rawRow = result.rows[1];
    assert.ok(rawRow);
    assert.equal(rawRow.payload, "not json at all");

    const hum = result.rows[2];
    assert.ok(hum);
    assert.deepEqual(hum.payload, { pct: 40 });

    // Empty batch is a no-op
    assert.equal(await insertMessages([]), 0);

    // Row counts reflect the inserts (4 messages in one table)
    const counts = await getRowCounts();
    assert.ok(counts.length >= 1);
    const messages = counts.find((c) => c.table === "messages");
    assert.ok(messages);
    assert.equal(messages.count, 4);

    // Per-table helpers back the generic /:table/count and /:table/list routes
    assert.deepEqual(await listTables(), ["messages"]);
    assert.equal(await countTableRows("messages"), 4);
    const rows = await listTableRows("messages", 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0] as Record<string, unknown>).sort(), [
      "id",
      "payload",
      "qos",
      "received_at",
      "retained",
      "source",
      "topic",
    ]);
  },
);
