import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  close,
  countTableRows,
  getDeviceIdByLocation,
  getDeviceIdByMac,
  getRowCounts,
  initDb,
  insertMessage,
  insertMessages,
  insertPowerReading,
  insertSwitchbotReading,
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
    assert.deepEqual(await listTables(), [
      "messages",
      "device",
      "temperature",
      "humidity",
      "power",
    ]);
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

test(
  "switchbot reading: mac lookup gates insert into temperature/humidity",
  { timeout: 15_000 },
  async (t) => {
    await initDb();
    t.after(() => close());
    const schema = config.postgres.schema;

    // Register one device like the production device table does
    await query(
      `INSERT INTO ${config.postgres.schema}.device (name, type, external_id)
       VALUES ('SwitchBot1', 'SwitchBot', 'DD:42:05:86:36:8A')`,
    );

    // Unknown MAC => lookup returns null, nothing inserted
    assert.equal(await getDeviceIdByMac("11:22:33:44:55:66"), null);

    // Known MAC (case-insensitive) => device id resolved
    const deviceId = await getDeviceIdByMac("dd:42:05:86:36:8a");
    assert.ok(deviceId);

    // Insert a reading with both temperature and humidity
    const result = await insertSwitchbotReading(deviceId!, {
      temperatureC: 21.3,
      humidity: 47,
    });
    assert.equal(result.temperature, true);
    assert.equal(result.humidity, true);

    // Temperature-only reading also works
    const tempOnly = await insertSwitchbotReading(deviceId!, {
      temperatureC: 22.5,
    });
    assert.equal(tempOnly.temperature, true);
    assert.equal(tempOnly.humidity, false);

    const temps = await query<{ value_c: number }>(
      `SELECT value_c FROM ${config.postgres.schema}.temperature
       WHERE device_id = $1 ORDER BY time`,
      [deviceId],
    );
    assert.deepEqual(
      temps.rows.map((r) => r.value_c),
      [21.3, 22.5],
    );

    const hums = await query<{ value_pct: number }>(
      `SELECT value_pct FROM ${config.postgres.schema}.humidity
       WHERE device_id = $1`,
      [deviceId],
    );
    assert.deepEqual(
      hums.rows.map((r) => r.value_pct),
      [47],
    );
  },
);

test(
  "mqtt power reading: location lookup gates insert into power",
  { timeout: 15_000 },
  async (t) => {
    await initDb();
    t.after(() => close());
    const schema = config.postgres.schema;

    await query(
      `INSERT INTO ${config.postgres.schema}.device (name, type, external_id, location)
       VALUES ('Sonoff1', 'Sonoff', '08:F9:E0:63:B9:2D', 'Albert')`,
    );

    // Case-insensitive location match, like the broker does for tele/Albert/SENSOR
    const deviceId = await getDeviceIdByLocation("albert");
    assert.ok(deviceId);

    // Unknown location => null, nothing inserted
    assert.equal(await getDeviceIdByLocation("tesla"), null);

    await insertPowerReading(deviceId!, 52);
    const rows = await query<{ device_id: number; watts: number }>(
      `SELECT device_id, watts FROM ${config.postgres.schema}.power`,
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(Number(rows.rows[0]!.device_id), deviceId);
    assert.equal(rows.rows[0]!.watts, 52);
  },
);
