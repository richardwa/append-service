import { Aedes } from "aedes";
import net from "node:net";
import { config } from "./config.js";
import { insertMessage } from "./db.js";

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

/** True when the topic matches at least one configured persist filter. */
function shouldPersist(topic: string): boolean {
  return config.mqtt.topics.some((filter) => topicMatches(topic, filter));
}

/**
 * Start the embedded MQTT broker (aedes). The service IS the broker:
 * devices connect directly to config.mqtt.port (default 1883), and every
 * published message is persisted.
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

  // Persist every message published by a client that matches a configured
  // topic filter (default: tele/+/SENSOR power telemetry); all other MQTT
  // messages are ignored. Failures are logged per-message; the broker keeps
  // serving (a single bad message never crashes the process).
  aedes.on("publish", (packet, client) => {
    if (!client) return; // internal publish, e.g. $SYS topics
    if (!shouldPersist(packet.topic)) {
      console.log(`[mqtt] ignored (no filter match): ${packet.topic}`);
      return;
    }
    insertMessage({
      source: "mqtt",
      topic: packet.topic,
      payload: packet.payload.toString("utf8"),
      qos: packet.qos,
      retained: packet.retain,
    }).catch((err: unknown) => {
      console.error(
        `[mqtt] failed to persist message on "${packet.topic}":`,
        err,
      );
    });
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
