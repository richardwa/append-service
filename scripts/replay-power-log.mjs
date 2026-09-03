#!/usr/bin/env node
// Replays a captured MQTT log (one "topic payload" line per message, e.g.
// power-2026-08-19.log from Tasmota devices) into the service's embedded
// MQTT broker, so real data can be exercised end-to-end.
//
// Usage:
//   node scripts/replay-power-log.mjs                          # publish every line, exit
//   node scripts/replay-power-log.mjs --count 10               # first 10 messages
//   node scripts/replay-power-log.mjs --skip 100 --count 5     # window into the log
//   node scripts/replay-power-log.mjs --interval 1             # 1s between messages, loop
//
// Env: MQTT_URL (default mqtt://localhost:1883), POWER_LOG (default ../power-2026-08-19.log)

import { readFile } from "node:fs/promises";
import path from "node:path";
import mqtt from "mqtt";

// --- simple arg parsing ------------------------------------------------------
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}

const url = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const logFile = process.env.POWER_LOG ?? path.resolve(import.meta.dirname, "..", "..", "power-2026-08-19.log");
const intervalSec = Number(argValue("--interval", 0)); // 0 = as fast as possible
const delayMs = intervalSec > 0 ? intervalSec * 1000 : 0;
let count = Number(argValue("--count", Infinity)); // max messages to publish
let skip = Number(argValue("--skip", 0)); // lines to skip first

// --- parse log: "<topic> <payload...>" ---------------------------------------
const raw = await readFile(logFile, "utf8");
const messages = raw
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => {
    const sep = line.indexOf(" ");
    return sep === -1
      ? { topic: line, payload: "" }
      : { topic: line.slice(0, sep), payload: line.slice(sep + 1) };
  });

if (skip > 0) {
  messages.splice(0, skip);
}
if (Number.isFinite(count) && count < messages.length) {
  messages.length = count;
}

console.log(
  `[replay] ${messages.length} messages from ${path.basename(logFile)} -> ${url}`,
);

// --- publish -------------------------------------------------------------------
const client = mqtt.connect(url, {
  clientId: "power-log-replay",
  reconnectPeriod: 2000,
  connectTimeout: 5000,
});

client.on("error", (err) => {
  console.error(`[replay] error: ${err.message}`);
  process.exitCode = 1;
  client.end(true);
});

client.on("connect", () => {
  console.log(`[replay] connected, publishing...`);
  publishNext(0);
});

function publishNext(i) {
  if (i >= messages.length || client.connected === false) {
    client.end(false, {}, () => console.log("[replay] done"));
    return;
  }
  const { topic, payload } = messages[i];
  client.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) {
      console.error(`[replay] publish failed (${topic}): ${err.message}`);
      process.exitCode = 1;
      client.end(true);
      return;
    }
    if (i % 100 === 0 || i === messages.length - 1) {
      console.log(`[replay] ${i + 1}/${messages.length} ${topic}`);
    }
    setTimeout(() => publishNext(i + 1), delayMs);
  });
}
