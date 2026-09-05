-- Schema for append-service, used in "memory" mode (pg-mem) and by
-- scripts/init-db.sh. In production ("postgres" mode) the table and
-- grants are owned by the my-db deployment init scripts (06-messages.sql)
-- and this file is NOT applied on boot.

CREATE SCHEMA IF NOT EXISTS sensors;

CREATE TABLE IF NOT EXISTS sensors.messages (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT        NOT NULL CHECK (source IN ('mqtt', 'http')),
  topic       TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  qos         SMALLINT    CHECK (qos BETWEEN 0 AND 2),
  retained    BOOLEAN     NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_received_at ON sensors.messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_topic       ON sensors.messages (topic);
CREATE INDEX IF NOT EXISTS idx_messages_source      ON sensors.messages (source);

-- Mirror of the production tables this service reads and appends to
-- (owned by the my-db init scripts and created here only for memory mode so
-- dev and tests run the same SQL as prod).
CREATE TABLE IF NOT EXISTS sensors.device (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  external_id TEXT        NOT NULL,
  location    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensors.temperature (
  time      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  device_id BIGINT           NOT NULL REFERENCES sensors.device (id),
  value_c   DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS sensors.humidity (
  time      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  device_id BIGINT           NOT NULL REFERENCES sensors.device (id),
  value_pct DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS sensors.power (
  time      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  device_id BIGINT           NOT NULL REFERENCES sensors.device (id),
  watts     DOUBLE PRECISION NOT NULL
);
