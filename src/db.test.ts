import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import {
  close,
  countTableRows,
  getDeviceIdByExternalId,
  getRowCounts,
  initDb,
  insertPowerReading,
  insertSwitchbotReading,
  listTables,
  listTableRows,
  query,
} from "./db.js";

test(
  "in-memory db: schema init, device read-back helpers, row counts",
  { timeout: 15_000 },
  async (t) => {
    await initDb();
    t.after(() => close());
    const schema = config.postgres.schema;

    // Register devices like the production device table does
    await query(
      `INSERT INTO ${schema}.device (name, type, external_id, location)
       VALUES ('Sonoff1', 'Sonoff', 'tasmota_63B92D', 'Albert')`,
    );
    await query(
      `INSERT INTO ${schema}.device (name, type, external_id)
       VALUES ('SwitchBot1', 'SwitchBot', 'DD:42:05:86:36:8A')`,
    );

    // Device lookup used by both ingestion paths (external_id, case-insensitive):
    // Tasmota devices use tasmota_<last 6 MAC digits>, SwitchBots keep the MAC.
    assert.equal(await getDeviceIdByExternalId("tasmota_63b92d"), 1);
    assert.equal(await getDeviceIdByExternalId("dd:42:05:86:36:8a"), 2);
    assert.equal(await getDeviceIdByExternalId("tasmota_000000"), null); // unknown

    // Append a power reading through the same helper the broker uses
    const deviceId = await getDeviceIdByExternalId("TASMOTA_63B92D");
    assert.ok(deviceId);
    await insertPowerReading(deviceId!, 42);

    // Row counts reflect the insert
    const counts = await getRowCounts();
    assert.ok(counts.length >= 1);
    const power = counts.find((c) => c.table === "power");
    assert.ok(power);
    assert.equal(power.count, 1);

    // Per-table helpers back the generic /:table/count and /:table/list routes
    assert.deepEqual(await listTables(), [
      "device",
      "temperature",
      "humidity",
      "power",
    ]);
    assert.equal(await countTableRows("power"), 1);
    const rows = await listTableRows("power", 2);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0] as Record<string, unknown>).sort(), [
      "device_id",
      "time",
      "watts",
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

    // Unknown external_id => lookup returns null, nothing inserted
    assert.equal(await getDeviceIdByExternalId("11:22:33:44:55:66"), null);
    // Known MAC (case-insensitive) => device id resolved
    const deviceId = await getDeviceIdByExternalId("dd:42:05:86:36:8a");
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
  "mqtt power reading: external_id lookup gates insert into power",
  { timeout: 15_000 },
  async (t) => {
    await initDb();
    t.after(() => close());
    const schema = config.postgres.schema;

    await query(
      `INSERT INTO ${config.postgres.schema}.device (name, type, external_id, location)
       VALUES ('Sonoff1', 'Sonoff', 'tasmota_63B92D', 'Albert')`,
    );

    // Case-insensitive external_id match, like the broker does for
    // tele/tasmota_63B92D/SENSOR
    const deviceId = await getDeviceIdByExternalId("tasmota_63b92d");
    assert.ok(deviceId);

    // Unknown external_id => null, nothing inserted
    assert.equal(await getDeviceIdByExternalId("tasmota_000000"), null);

    await insertPowerReading(deviceId!, 52);
    const rows = await query<{ device_id: number; watts: number }>(
      `SELECT device_id, watts FROM ${config.postgres.schema}.power`,
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(Number(rows.rows[0]!.device_id), deviceId);
    assert.equal(rows.rows[0]!.watts, 52);
  },
);
