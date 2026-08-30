#!/usr/bin/env node
// Simulates a Tasmota energy-monitoring plug publishing power readings
// to `tele/tasmota_<id>/SENSOR`, like real hardware does.
//
// Usage:
//   node scripts/simulate-tasmota.mjs                 # publish one reading, exit
//   node scripts/simulate-tasmota.mjs --interval 5    # publish every 5s until Ctrl-C
//   node scripts/simulate-tasmota.mjs --count 10      # publish 10 readings, 1s apart
//
// Env: MQTT_URL (default mqtt://localhost:1883), MQTT_USERNAME, MQTT_PASSWORD

import mqtt from "mqtt";

// --- simple arg parsing -----------------------------------------------------
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}
const intervalSec = argValue("--interval", 0); // 0 = no loop
const count = argValue("--count", intervalSec > 0 ? Infinity : 1);
const delaySec = intervalSec > 0 ? intervalSec : 1;

const url = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const deviceId = process.env.TASMOTA_DEVICE_ID ?? "A4C138";
const topic = `tele/tasmota_${deviceId}/SENSOR`;

// --- simulated device state (random walk) -----------------------------------
let watts = 120; // current power draw
let totalKwh = 1523.42; // lifetime energy counter
const totalStartTime = new Date(Date.now() - 30 * 24 * 3600 * 1000);

function nextReading() {
  // power wanders between 30 W (idle) and 2400 W (kettle on)
  watts = Math.min(2400, Math.max(30, watts + (Math.random() - 0.48) * 90));
  const voltage = 228 + Math.random() * 5; // ~230 V nominal
  const current = watts / voltage;
  const periodWh = (watts * delaySec) / 3600; // energy consumed this interval
  totalKwh += periodWh / 1000;

  return {
    Time: new Date().toISOString().slice(0, 19),
    ENERGY: {
      TotalStartTime: totalStartTime.toISOString().slice(0, 19),
      Total: Math.round(totalKwh * 1000) / 1000,
      Yesterday: 3.842,
      Today: Math.round((totalKwh % 5) * 1000) / 1000,
      Period: Math.round(periodWh * 1000) / 1000,
      Power: Math.round(watts),
      ApparentPower: Math.round(watts / 0.96),
      ReactivePower: Math.round(watts * 0.28),
      Factor: 0.96,
      Voltage: Math.round(voltage * 10) / 10,
      Current: Math.round(current * 100) / 100,
    },
  };
}

// --- publish loop ------------------------------------------------------------
let published = 0;

const client = mqtt.connect(url, {
  clientId: "tasmota-simulator",
  reconnectPeriod: 2000,
  connectTimeout: 5000,
});

client.on("connect", () => {
  console.log(`[tasmota-sim] connected to ${url}, publishing to ${topic}`);
  publishNext();
});

client.on("error", (err) => {
  console.error(`[tasmota-sim] error: ${err.message}`);
  process.exitCode = 1;
  client.end(true);
});

function publishNext() {
  if (count <= 0 || client.connected === false) return;
  const reading = nextReading();
  const payload = JSON.stringify(reading);
  client.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) {
      console.error(`[tasmota-sim] publish failed: ${err.message}`);
      return;
    }
    console.log(`[tasmota-sim] ${reading.ENERGY.Power} W, ${reading.ENERGY.Voltage} V, total ${reading.ENERGY.Total} kWh`);
  });
  if (Number.isFinite(count)) published++;
  if (published < count) {
    setTimeout(publishNext, delaySec * 1000);
  } else {
    setTimeout(() => client.end(false, {}, () => console.log("[tasmota-sim] done")), 500);
  }
}
