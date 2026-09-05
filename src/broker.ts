import { Aedes } from "aedes";
import net from "node:net";
import { config } from "./config.js";
import { getDeviceIdByLocation, insertPowerReading } from "./db.js";
import { debugLog } from "./log.js";

let broker: Aedes | null = null;
let server: net.Server | null = null;

/**
 * MQTT topic-filter match: '+' matches exactly one level, '#' matches any
 * number of remaining levels (only valid as the last filter level).
 */
export function topicMatches(topic: string, filter: string): boolean {
  const topicLevels = topic.split("/");
  const filterLevels = filter.split("/");
  for (let i = 0; i < filterLevels.length; i++) {
    const level = filterLevels[i]!;
    if (level === "#") return true;
    if (i >= topicLevels.length) return false;
    if (level === "+") continue;
    if (level !== topicLevels[i]) return false;
  }
  return topicLevels.length === filterLevels.length;
}

/** True when the topic matches at least one configured filter. */
function shouldProcess(topic: string): boolean {
  return config.mqtt.topics.some((filter) => topicMatches(topic, filter));
}

/**
 * Record an ENERGY.Power reading from a matching MQTT topic into the power
 * table. The topic's second segment (e.g. "Albert" in tele/Albert/SENSOR) is
 * matched case-insensitively against device.location; when no device is
 * registered the reading is skipped. Failures are logged per-message; the
 * broker keeps serving.
 */
async function recordPowerReading(
  topic: string,
  payloadText: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(payloadText) as {
      ENERGY?: { Power?: unknown };
      Power?: unknown;
    };
    const raw = parsed.ENERGY?.Power ?? parsed.Power;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return;

    const location = topic.split("/")[1];
    if (!location) return;
    const deviceId = await getDeviceIdByLocation(location);
    if (deviceId === null) {
      debugLog(
        `[mqtt] no device for location "${location}", watts not recorded`,
      );
      return;
    }

    await insertPowerReading(deviceId, raw);
    debugLog(`[mqtt] power recorded: ${raw} W (device ${deviceId}, ${topic})`);
  } catch (err) {
    console.error(`[mqtt] failed to record power for "${topic}":`, err);
  }
}

/**
 * Start the embedded MQTT broker (aedes). The service IS the broker:
 * devices connect directly to config.mqtt.port (default 1883), and every
 * published message matching a configured topic filter is processed into
 * the power table.
 */
export async function startBroker(): Promise<net.Server> {
  const aedes = await Aedes.createBroker();
  broker = aedes;

  aedes.on("client", (client) => {
    console.log(`[mqtt] client connected: ${client.id}`);
  });

  aedes.on("clientDisconnect", (client) => {
    console.log(`[mqtt] client disconnected: ${client.id}`);
  });

  aedes.on("clientError", (client, err) => {
    console.error(`[mqtt] client error (${client.id}):`, err.message);
  });

  // Process every message published by a client that matches a configured
  // topic filter (default: tele/+/SENSOR power telemetry); all other MQTT
  // messages are ignored. Failures are logged per-message; the broker keeps
  // serving (a single bad message never crashes the process).
  aedes.on("publish", (packet, client) => {
    if (!client) return; // internal publish, e.g. $SYS topics
    if (!shouldProcess(packet.topic)) {
      console.log(`[mqtt] ignored (no filter match): ${packet.topic}`);
      return;
    }
    debugLog(
      `[mqtt] message body: ${packet.topic} -> ${packet.payload.toString("utf8")}`,
    );
    void recordPowerReading(packet.topic, packet.payload.toString("utf8"));
  });

  server = net.createServer(aedes.handle);
  server.on("error", (err) => {
    console.error("[mqtt] broker error:", err.message);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server!.once("error", onError);
    server!.listen(config.mqtt.port, () => {
      server!.removeListener("error", onError);
      resolve();
    });
  });

  console.log(`[mqtt] broker listening on port ${config.mqtt.port}`);
  return server;
}

export async function stopBroker(): Promise<void> {
  if (server) {
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  if (broker) {
    const b: Aedes = broker;
    broker = null;
    await new Promise<void>((resolve) => b.close(() => resolve()));
  }
  console.log("[mqtt] broker stopped");
}
