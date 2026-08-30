import mqtt from "mqtt";
import { config } from "./config.js";
import { insertMessage } from "./db.js";
import type { IClientOptions, MqttClient } from "mqtt";

let client: MqttClient | null = null;

export function startMqtt(onReady?: () => void): MqttClient {
  const options: IClientOptions = {
    clientId: config.mqtt.clientId,
    clean: true,
    reconnectPeriod: 5_000,
    connectTimeout: 10_000,
  };
  if (config.mqtt.username !== undefined)
    options.username = config.mqtt.username;
  if (config.mqtt.password !== undefined)
    options.password = config.mqtt.password;

  client = mqtt.connect(config.mqtt.url, options);

  client.on("connect", () => {
    console.log(`[mqtt] connected to ${config.mqtt.url}`);
    client?.subscribe(
      config.mqtt.topicFilter,
      { qos: config.mqtt.qos },
      (err) => {
        if (err) {
          console.error(
            `[mqtt] failed to subscribe to "${config.mqtt.topicFilter}":`,
            err.message,
          );
        } else {
          console.log(
            `[mqtt] subscribed to "${config.mqtt.topicFilter}" (qos ${config.mqtt.qos})`,
          );
          onReady?.();
        }
      },
    );
  });

  client.on("message", (topic, payloadBuffer, packet) => {
    const payload = payloadBuffer.toString("utf8");
    insertMessage({
      source: "mqtt",
      topic,
      payload,
      qos: packet.qos,
      retained: packet.retain,
    }).catch((err: unknown) => {
      console.error(`[mqtt] failed to persist message on "${topic}":`, err);
    });
  });

  client.on("error", (err) => {
    console.error("[mqtt] error:", err.message);
  });

  client.on("reconnect", () => {
    console.log("[mqtt] reconnecting...");
  });

  return client;
}

export async function stopMqtt(): Promise<void> {
  if (!client) return;
  const c: MqttClient = client;
  client = null;
  await new Promise<void>((resolve) => {
    c.end(false, {}, () => resolve());
  });
  console.log("[mqtt] disconnected");
}
