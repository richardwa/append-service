export type MessageSource = "mqtt" | "http";

/** A message received from either MQTT or HTTP, before persistence. */
export interface IncomingMessage {
  source: MessageSource;
  topic: string;
  /** String payloads are parsed as JSON at insert time when possible. */
  payload: unknown;
  qos?: number;
  retained?: boolean;
}

/** A persisted message as returned by the read API. */
export interface StoredMessage {
  id: number;
  source: MessageSource;
  topic: string;
  payload: unknown;
  qos: number | null;
  retained: boolean;
  received_at: Date;
}
