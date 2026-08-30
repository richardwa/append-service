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

  db: {
    // "postgres" = real database, "memory" = embedded pg-mem (dev/testing)
    mode: envEnum("DB_MODE", ["postgres", "memory"] as const, "postgres"),
  },

  postgres: {
    host: envString("PGHOST", "localhost"),
    port: envInt("PGPORT", 5432),
    database: envString("PGDATABASE", "messages"),
    user: envString("PGUSER", "postgres"),
    password: envString("PGPASSWORD", "postgres"),
  },

  mqtt: {
    url: envString("MQTT_URL", "mqtt://localhost:1883"),
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: envString("MQTT_CLIENT_ID", "append-service"),
    // Topic filter to subscribe to; "#" receives everything.
    topicFilter: envString("MQTT_TOPIC", "#"),
    qos: envInt("MQTT_QOS", 1) as 0 | 1 | 2,
  },
} as const;

export type Config = typeof config;
