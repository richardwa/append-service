import { config } from "./config.js";
import { onPoolError, close as closeDb } from "./db.js";
import { startHttp } from "./http.js";
import { startMqtt, stopMqtt } from "./mqtt.js";

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down...`);
  void (async () => {
    try {
      await stopMqtt();
      await closeDb();
      console.log("shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("error during shutdown:", err);
      process.exit(1);
    }
  })();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

onPoolError((err) => {
  console.error("[db] idle client error:", err.message);
});

const server = startHttp();
startMqtt();

console.log(
  `append-service starting (http :${config.port}, mqtt ${config.mqtt.url})`,
);

// Keep the process alive; the express server handle holds the event loop open.
server.on("error", (err) => {
  console.error("[http] server error:", err.message);
  process.exit(1);
});
