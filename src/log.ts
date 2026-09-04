import { config } from "./config.js";

/**
 * Debug-level logging: only emitted when LOG_LEVEL=debug. Used for verbose
 * output like message request bodies (MQTT payloads, HTTP write bodies).
 */
export function debugLog(message: string): void {
  if (config.logLevel === "debug") {
    console.log(message);
  }
}
