-- 02: power readings (requires sensors.device from 01-device.sql)
-- Idempotent: safe to run on an already-initialized database.

CREATE TABLE IF NOT EXISTS sensors.power (
    "time" timestamptz NOT NULL,
    device_id bigint NOT NULL,
    watts double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS power_time_idx ON sensors.power USING btree ("time" DESC);
CREATE INDEX IF NOT EXISTS power_device_time_idx ON sensors.power USING btree (device_id, "time" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'power_device_id_fkey' AND conrelid = 'sensors.power'::regclass
  ) THEN
    ALTER TABLE sensors.power
      ADD CONSTRAINT power_device_id_fkey FOREIGN KEY (device_id) REFERENCES sensors.device(id);
  END IF;
END
$$;
