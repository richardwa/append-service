#!/usr/bin/env node
// Minimal embedded MQTT broker for local testing (wraps aedes).
// Lets you test the full MQTT ingestion path without installing mosquitto.
//
// Usage: node scripts/local-broker.mjs
// Env:   MQTT_PORT (default 1883)

import { Aedes } from "aedes";
import net from "node:net";

const port = Number(process.env.MQTT_PORT ?? 1883);
const broker = await Aedes.createBroker();

broker.on("client", (client) => {
  console.log(`[broker] client connected: ${client.id}`);
});

broker.on("clientDisconnect", (client) => {
  console.log(`[broker] client disconnected: ${client.id}`);
});

broker.on("publish", (packet, client) => {
  if (!client) return; // internal/system publish
  const payload = packet.payload.toString("utf8");
  console.log(`[broker] ${client.id} -> ${packet.topic}: ${payload.slice(0, 200)}`);
});

net.createServer(broker.handle).listen(port, () => {
  console.log(`[broker] listening on mqtt://localhost:${port}`);
});
