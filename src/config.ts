import "dotenv/config";

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function envEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `Invalid value for ${name}: ${value} (expected one of ${allowed.join("|")})`,
  );
}

export const config = {
  port: envInt("PORT", 8401),

  // Log verbosity: "debug" enables request-body logging for MQTT and HTTP
  // messages; "info" (default) only logs connections, requests and errors.
  logLevel: envEnum(
    "LOG_LEVEL",
    ["debug", "info", "warn", "error"] as const,
    "info",
  ),

  db: {
    // "postgres" = real database, "memory" = embedded pg-mem (dev/testing)
    mode: envEnum("DB_MODE", ["postgres", "memory"] as const, "postgres"),
  },

  postgres: {
    host: envString("PGHOST", "localhost"),
    port: envInt("PGPORT", 5432),
    database: envString("PGDATABASE", "home"),
    user: envString("PGUSER", "sensors_rw"),
    password: envString("PGPASSWORD", "CHANGE_ME_RW"),
    // Schema the messages table lives in. In postgres mode the table (and
    // grants) are owned by the my-db init scripts; this service only appends.
    schema: envString("PGSCHEMA", "sensors"),
  },

  mqtt: {
    // The service embeds its own MQTT broker (aedes); this is the port
    // devices connect to.
    port: envInt("MQTT_PORT", 1883),
    // Topic filters (comma-separated, MQTT wildcards + and # allowed).
    // Only published messages matching at least one filter are persisted;
    // every other MQTT message is ignored. Default collects the Tasmota
    // power telemetry (tele/<device>/SENSOR) and nothing else.
    topics: envString("MQTT_TOPICS", "tele/+/SENSOR")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  },
} as const;

export type Config = typeof config;
