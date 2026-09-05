import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config } from "./config.js";
import {
  countTableRows,
  getDeviceIdByMac,
  getRowCounts,
  insertSwitchbotReading,
  listTables,
  listTableRows,
  query,
} from "./db.js";
import { debugLog } from "./log.js";

const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  let finished = false;
  res.on("finish", () => {
    finished = true;
    console.log(
      `[http] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`,
    );
  });
  // clients that hang up mid-request never emit "finish" — log those too
  res.on("close", () => {
    if (!finished) {
      console.log(
        `[http] ${req.method} ${req.originalUrl} -> client disconnected after ${Date.now() - start}ms`,
      );
    }
  });
  next();
});

app.use(express.json({ limit: "1mb" }));

const APP_NAME = "append-service";

app.get("/", (_req: Request, res: Response) => {
  res.json({ app: APP_NAME, status: "ok" });
});

interface HealthRow {
  ok: boolean;
}

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await query<HealthRow>("SELECT true AS ok");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "degraded", database: "unreachable" });
  }
});

app.get("/row-counts", async (_req: Request, res: Response) => {
  try {
    const counts = await getRowCounts();
    res.json({
      schema: config.postgres.schema,
      tables: counts,
      total: counts.reduce((sum, c) => sum + c.count, 0),
    });
  } catch (err) {
    console.error("[http] failed to read row counts:", err);
    res.status(500).json({ error: "failed to read row counts" });
  }
});

/**
 * POST /switchbot — accept a reading from a SwitchBot-scanner device.
 * Expected body (from the ESP32 scanner):
 * {
 *   "uptime_ms": 12345, "mac": "DD:42:05:86:36:8A", "rssi": -60,
 *   "manufacturer": "0x004c", "temperature_c": 21.3, "temperature_f": 70.3,
 *   "humidity": 47, "battery": 85
 * }
 *
 * The MAC is looked up against device.external_id (case-insensitive). If a
 * registered device exists, temperature_c and humidity are appended to the
 * existing sensors.temperature / sensors.humidity tables keyed by device id;
 * if the MAC is unknown, nothing is inserted (404).
 */
app.post("/switchbot", async (req: Request, res: Response) => {
  const body = req.body as {
    mac?: unknown;
    temperature_c?: unknown;
    humidity?: unknown;
  };
  debugLog(`[http] switchbot body: ${JSON.stringify(body)}`);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    res.status(400).json({ error: "body must be a JSON object" });
    return;
  }
  if (typeof body.mac !== "string" || body.mac.trim().length === 0) {
    res.status(400).json({ error: '"mac" (string) is required' });
    return;
  }
  const mac = body.mac.trim();

  const temperatureC = parseOptionalNumber(
    body.temperature_c,
    "temperature_c",
    res,
  );
  if (temperatureC === null) return;
  const humidity = parseOptionalNumber(body.humidity, "humidity", res);
  if (humidity === null) return;
  if (temperatureC === undefined && humidity === undefined) {
    res.status(400).json({
      error: "nothing to insert: provide temperature_c and/or humidity",
    });
    return;
  }

  try {
    const deviceId = await getDeviceIdByMac(mac);
    if (deviceId === null) {
      res.status(404).json({ error: `unknown device: ${mac}` });
      return;
    }

    const result = await insertSwitchbotReading(deviceId, {
      temperatureC,
      humidity,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error("[http] failed to persist switchbot reading:", err);
    res.status(500).json({ error: "failed to persist switchbot reading" });
  }
});

/** Validate one optional numeric body field; returns null after 400 on bad input. */
function parseOptionalNumber(
  raw: unknown,
  name: string,
  res: Response,
): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    res.status(400).json({ error: `"${name}" must be a number` });
    return null;
  }
  return raw;
}

/**
 * Shared limit parsing for list endpoints: integer 1..1000, default 100.
 * Returns the parsed limit, or null after responding with 400.
 */
function parseLimit(raw: unknown, res: Response): number | null {
  if (raw === undefined) return 100;
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 1000) {
    res
      .status(400)
      .json({ error: '"limit" must be an integer between 1 and 1000' });
    return null;
  }
  return parsed;
}

/**
 * Per-table read endpoints. The table name comes from the URL, so it is
 * validated against the actual tables in the service schema (404 if unknown)
 * before being used in SQL.
 */
app.get("/:table/list", async (req: Request, res: Response) => {
  const table = String(req.params.table);
  if (!(await listTables()).includes(table)) {
    res.status(404).json({ error: `unknown table: ${table}` });
    return;
  }
  const limit = parseLimit(req.query.limit, res);
  if (limit === null) return;

  try {
    const rows = await listTableRows(table, limit);
    res.json({ table, count: rows.length, limit, rows });
  } catch (err) {
    console.error(`[http] failed to list table ${table}:`, err);
    res.status(500).json({ error: `failed to list table ${table}` });
  }
});

app.get("/:table/count", async (req: Request, res: Response) => {
  const table = String(req.params.table);
  if (!(await listTables()).includes(table)) {
    res.status(404).json({ error: `unknown table: ${table}` });
    return;
  }

  try {
    const count = await countTableRows(table);
    res.json({ table, count });
  } catch (err) {
    console.error(`[http] failed to count table ${table}:`, err);
    res.status(500).json({ error: `failed to count table ${table}` });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  console.error("[http] unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "internal server error" });
  }
});

export function startHttp(): ReturnType<typeof app.listen> {
  return app.listen(config.port, () => {
    console.log(`[http] listening on port ${config.port}`);
  });
}

export { app };
