-- Schema for append-service. Applied automatically on first run of
-- scripts/init-db.sh, or manually with:
--   psql "$DATABASE_URL" -f scripts/init.sql

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT        NOT NULL CHECK (source IN ('mqtt', 'http')),
  topic       TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  qos         SMALLINT    CHECK (qos BETWEEN 0 AND 2),
  retained    BOOLEAN     NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_topic       ON messages (topic);
CREATE INDEX IF NOT EXISTS idx_messages_source      ON messages (source);
