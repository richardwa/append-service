import { startBroker, stopBroker } from "./broker.js";
import { config } from "./config.js";
import { initDb, close as closeDb, logRowCounts } from "./db.js";
import { startHttp } from "./http.js";

function shutdown(signal: string): void {
  console.log(`\n${signal} received, shutting down...`);
  void (async () => {
    try {
      await stopBroker();
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

async function main(): Promise<void> {
  // Creates the pool (real postgres or embedded pg-mem) and applies the
  // schema idempotently before accepting any traffic.
  await initDb();
  await logRowCounts();

  const server = startHttp();
  await startBroker();

  console.log(
    `append-service started (db mode: ${config.db.mode}, http :${config.port}, mqtt :${config.mqtt.port})`,
  );

  server.on("error", (err) => {
    console.error("[http] server error:", err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("fatal: failed to start:", err);
  process.exit(1);
});
