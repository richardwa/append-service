-- 03: temperature readings (requires sensors.device from 01-device.sql)
-- Idempotent: safe to run on an already-initialized database.

CREATE TABLE IF NOT EXISTS sensors.temperature (
    "time" timestamptz NOT NULL,
    device_id bigint NOT NULL,
    value_c double precision NOT NULL
);

CREATE INDEX IF NOT EXISTS temperature_time_idx ON sensors.temperature USING btree ("time" DESC);
CREATE INDEX IF NOT EXISTS temperature_device_time_idx ON sensors.temperature USING btree (device_id, "time" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'temperature_device_id_fkey' AND conrelid = 'sensors.temperature'::regclass
  ) THEN
    ALTER TABLE sensors.temperature
      ADD CONSTRAINT temperature_device_id_fkey FOREIGN KEY (device_id) REFERENCES sensors.device(id);
  END IF;
END
$$;
