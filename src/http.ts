import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config } from "./config.js";
import { insertMessage, insertMessages, query } from "./db.js";
import type { IncomingMessage, MessageSource, StoredMessage } from "./types.js";

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

interface WriteBody {
  topic?: unknown;
  payload?: unknown;
  qos?: unknown;
}

app.post("/messages", async (req: Request, res: Response) => {
  const body = req.body as WriteBody;
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

  let limit = 100;
  if (q.limit !== undefined) {
    const parsed = Number.parseInt(String(q.limit), 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 1000) {
      res
        .status(400)
        .json({ error: '"limit" must be an integer between 1 and 1000' });
      return;
    }
    limit = parsed;
  }

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
