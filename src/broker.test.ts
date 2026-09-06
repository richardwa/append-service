import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import mqtt from "mqtt";

// Broker + config must be imported after the env is set so the ephemeral
// port and topic filters are picked up (ESM imports are hoisted, so these
// are dynamic imports inside the test).
process.env.MQTT_PORT = "0"; // ephemeral port
process.env.MQTT_TOPICS = "tele/+/SENSOR";

// --- topic filter matching ---------------------------------------------------

test("topicMatches: MQTT wildcards", async () => {
  const { topicMatches } = await import("./broker.js");

  // '+' matches exactly one level
  assert.equal(topicMatches("tele/tesla/SENSOR", "tele/+/SENSOR"), true);
  assert.equal(topicMatches("tele/Albert/SENSOR", "tele/+/SENSOR"), true);
  assert.equal(topicMatches("tele/tesla/STATE", "tele/+/SENSOR"), false);
  assert.equal(topicMatches("tele/tesla/LWT", "tele/+/SENSOR"), false);
  assert.equal(
    topicMatches("tasmota/discovery/08F9E063B92D/sensors", "tele/+/SENSOR"),
    false,
  );
  assert.equal(topicMatches("tele/a/b/SENSOR", "tele/+/SENSOR"), false);

  // '#' matches remaining levels
  assert.equal(topicMatches("tele/tesla/SENSOR", "tele/#"), true);
  assert.equal(topicMatches("a/b/c/d", "a/#"), true);
  assert.equal(topicMatches("a/b/c/d", "b/#"), false);

  // exact match
  assert.equal(topicMatches("tele/tesla/SENSOR", "tele/tesla/SENSOR"), true);
  assert.equal(topicMatches("tele/other/SENSOR", "tele/tesla/SENSOR"), false);
});

// --- end-to-end: publish over MQTT, only power telemetry reaches the DB ------

test(
  "broker records power only for filtered topics with registered devices",
  { timeout: 20_000 },
  async (t) => {
    const { startBroker, stopBroker } = await import("./broker.js");
    const { initDb, close, query } = await import("./db.js");
    const { config } = await import("./config.js");

    await initDb();
    let client: mqtt.MqttClient | undefined;
    t.after(async () => {
      // tear down in order: client socket first, then broker, then db
      if (client)
        await new Promise<void>((resolve) =>
          client!.end(true, {}, () => resolve()),
        );
      await stopBroker();
      await close();
    });

    // Register devices like the production device table does: the topic's
    // second segment (e.g. "tasmota_63B92D", Tasmota's default topic id =
    // last 6 MAC digits) must match device.external_id case-insensitively.
    await query(
      `INSERT INTO ${config.postgres.schema}.device (name, type, external_id, location)
       VALUES ('Sonoff1', 'Sonoff', 'tasmota_63B92D', 'Albert'),
              ('Sonoff2', 'Sonoff', 'tasmota_63B50E', 'TV')`,
    );

    const server = await startBroker();
    const address = server.address() as net.AddressInfo;
    const url = `mqtt://localhost:${address.port}`;

    // Replay a representative slice of power-sample.log: the power
    // telemetry plus the message types that must be ignored.
    client = mqtt.connect(url, { clientId: "broker-test" });
    await new Promise<void>((resolve, reject) => {
      client!.on("error", reject);
      client!.on("connect", () => resolve());
    });

    const publish = (topic: string, payload: string) =>
      new Promise<void>((resolve, reject) => {
        client!.publish(topic, payload, { qos: 1 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });

    await publish("tele/Albert/LWT", "Online"); // ignored (no filter match)
    await publish("tele/tasmota_63B92D/STATE", '{"POWER":"ON"}'); // ignored (no filter match)
    await publish("tasmota/discovery/08F9E063B92D/config", '{"t":"Albert"}'); // ignored (no filter match)
    await publish(
      "tele/tasmota_63b50e/SENSOR",
      '{"Time":"2026-08-19T04:01:51","ENERGY":{"Total":5554.210,"Period":0,"Power":4,"Voltage":121,"Current":0.067}}',
    );
    await publish(
      "tele/tasmota_63B92D/SENSOR",
      '{"Time":"2026-08-19T05:02:09","ENERGY":{"Total":136.088,"Period":0,"Power":3,"Voltage":117,"Current":0.078}}',
    );

    // Give the broker's async inserts a moment to land
    await new Promise((resolve) => setTimeout(resolve, 250));

    const result = await query<{
      external_id: string;
      device_id: number;
      watts: number;
    }>(
      `SELECT d.external_id, p.device_id, p.watts
       FROM ${config.postgres.schema}.power p
       JOIN ${config.postgres.schema}.device d ON d.id = p.device_id
       ORDER BY p.watts`,
    );

    // Only the two power telemetry messages were recorded, keyed by device
    assert.deepEqual(
      result.rows.map((r) => r.external_id),
      ["tasmota_63B92D", "tasmota_63B50E"],
    );
    assert.deepEqual(
      result.rows.map((r) => r.watts),
      [3, 4],
    );
  },
);
