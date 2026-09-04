-- 04: humidity readings (requires sensors.device from 01-device.sql)
-- Idempotent: safe to run on an already-initialized database.

CREATE TABLE IF NOT EXISTS sensors.humidity (
    "time" timestamptz NOT NULL,
    device_id bigint NOT NULL,
    value_pct double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS humidity_time_idx ON sensors.humidity USING btree ("time" DESC);
CREATE INDEX IF NOT EXISTS humidity_device_time_idx ON sensors.humidity USING btree (device_id, "time" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'humidity_device_id_fkey' AND conrelid = 'sensors.humidity'::regclass
  ) THEN
    ALTER TABLE sensors.humidity
      ADD CONSTRAINT humidity_device_id_fkey FOREIGN KEY (device_id) REFERENCES sensors.device(id);
  END IF;
END
$$;
