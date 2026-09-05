#!/usr/bin/env node
// Sends temperature (and humidity) readings to the service's HTTP endpoint,
// simulating a SwitchBot-scanner sensor reporting over HTTP.
//
// Usage:
//   node scripts/send-temperature.mjs                 # send one reading, exit
//   node scripts/send-temperature.mjs --interval 5    # send every 5s until Ctrl-C
//   node scripts/send-temperature.mjs --count 10      # send 10 readings, 1s apart
//   node scripts/send-temperature.mjs --mac DD:42:05:86:36:8A
//
// Env: BASE_URL (default http://localhost:3000)

// --- simple arg parsing ------------------------------------------------------
function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const mac = argValue("--mac", "DD:42:05:86:36:8A");
const intervalSec = Number(argValue("--interval", 0)); // 0 = no loop
const count = Number(argValue("--count", intervalSec > 0 ? Infinity : 1));
const delaySec = intervalSec > 0 ? intervalSec : 1;

// --- simulated sensor state ---------------------------------------------------
let celsius = 21.5; // random walk around a base temperature
let humidity = 48;

function nextReading() {
  celsius = Math.min(35, Math.max(12, celsius + (Math.random() - 0.5) * 0.6));
  humidity = Math.min(90, Math.max(25, humidity + (Math.random() - 0.5) * 2));
  return {
    mac,
    temperature_c: Math.round(celsius * 10) / 10,
    humidity: Math.round(humidity),
  };
}

async function send() {
  const payload = nextReading();
  try {
    const res = await fetch(`${baseUrl}/switchbot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[temp-sim] HTTP ${res.status}: ${body}`);
      process.exitCode = 1;
      return false;
    }
    const body = await res.json();
    console.log(
      `[temp-sim] sent ${payload.temperature_c} °C, ${payload.humidity} % RH (${payload.mac}) -> device ${body.deviceId}`,
    );
    return true;
  } catch (err) {
    console.error(`[temp-sim] request failed: ${err.message}`);
    process.exitCode = 1;
    return false;
  }
}

let sent = 0;
while (sent < count) {
  const ok = await send();
  sent++;
  if (!ok || sent >= count) break;
  if (Number.isFinite(count) || intervalSec > 0) {
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }
}
if (sent >= count && count !== Infinity) {
  console.log("[temp-sim] done");
}
