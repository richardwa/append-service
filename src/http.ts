import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config } from "./config.js";
import {
  countTableRows,
  getRowCounts,
  insertMessage,
  insertMessages,
  listTables,
  listTableRows,
  query,
} from "./db.js";
import type { IncomingMessage, MessageSource, StoredMessage } from "./types.js";
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

interface WriteBody {
  topic?: unknown;
  payload?: unknown;
  qos?: unknown;
}

app.post("/messages", async (req: Request, res: Response) => {
  const body = req.body as WriteBody;
  debugLog(`[http] message body: ${JSON.stringify(body)}`);
  if (typeof body.topic !== "string" || body.topic.length === 0) {
    res.status(400).json({ error: '"topic" (string) is required' });
    return;
  }
  if (!("payload" in body)) {
    res.status(400).json({ error: '"payload" is required' });
    return;
  }

  const msg: IncomingMessage = {
    source: "http",
    topic: body.topic,
    payload: body.payload,
    qos: typeof body.qos === "number" ? body.qos : undefined,
  };

  try {
    const { id, receivedAt } = await insertMessage(msg);
    res.status(201).json({ id, receivedAt });
  } catch (err) {
    console.error("[http] failed to persist message:", err);
    res.status(500).json({ error: "failed to persist message" });
  }
});

interface BatchBody {
  messages?: unknown;
}

app.post("/messages/batch", async (req: Request, res: Response) => {
  const body = req.body as BatchBody;
  debugLog(`[http] message body (batch): ${JSON.stringify(body)}`);
  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: '"messages" (array) is required' });
    return;
  }

  const msgs: IncomingMessage[] = [];
  for (const [i, raw] of body.messages.entries()) {
    const item = raw as WriteBody;
    if (
      typeof item.topic !== "string" ||
      item.topic.length === 0 ||
      !("payload" in item)
    ) {
      res.status(400).json({
        error: `messages[${i}]: "topic" (string) and "payload" are required`,
      });
      return;
    }
    msgs.push({
      source: "http",
      topic: item.topic,
      payload: item.payload,
      qos: typeof item.qos === "number" ? item.qos : undefined,
    });
  }

  try {
    const count = await insertMessages(msgs);
    res.status(201).json({ inserted: count });
  } catch (err) {
    console.error("[http] failed to persist batch:", err);
    res.status(500).json({ error: "failed to persist batch" });
  }
});

interface ListQuery {
  source?: unknown;
  topic?: unknown;
  limit?: unknown;
  since?: unknown;
}

app.get("/messages", async (req: Request, res: Response) => {
  const q = req.query as ListQuery;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (q.source === "mqtt" || q.source === "http") {
    params.push(q.source);
    conditions.push(`source = $${params.length}`);
  } else if (q.source !== undefined) {
    res.status(400).json({ error: '"source" must be "mqtt" or "http"' });
    return;
  }

  if (typeof q.topic === "string" && q.topic.length > 0) {
    params.push(q.topic);
    conditions.push(`topic = $${params.length}`);
  }

  if (typeof q.since === "string" && q.since.length > 0) {
    const since = new Date(q.since);
    if (Number.isNaN(since.getTime())) {
      res.status(400).json({ error: '"since" must be an ISO 8601 timestamp' });
      return;
    }
    params.push(since.toISOString());
    conditions.push(`received_at >= $${params.length}`);
  }

  const limit = parseLimit(q.limit, res);
  if (limit === null) return;

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, source, topic, payload, qos, retained, received_at
    FROM ${config.postgres.schema}.messages
    ${whereClause}
    ORDER BY received_at DESC
    LIMIT $${params.length + 1}
  `;
  params.push(limit);

  try {
    const result = await query<StoredMessage>(sql, params);
    res.json({ count: result.rows.length, messages: result.rows });
  } catch (err) {
    console.error("[http] failed to list messages:", err);
    res.status(500).json({ error: "failed to list messages" });
  }
});

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
export type { MessageSource };
