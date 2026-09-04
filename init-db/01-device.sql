-- 01: sensors schema + device table (must run first: power/temperature/
-- humidity reference sensors.device.id)
-- Idempotent: safe to run on an already-initialized database.

CREATE SCHEMA IF NOT EXISTS sensors;

CREATE SEQUENCE IF NOT EXISTS sensors.device_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE IF NOT EXISTS sensors.device (
    id bigint NOT NULL DEFAULT nextval('sensors.device_id_seq'::regclass),
    name text NOT NULL,
    type text NOT NULL,
    external_id text,
    location text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER SEQUENCE sensors.device_id_seq OWNED BY sensors.device.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_pkey' AND conrelid = 'sensors.device'::regclass
  ) THEN
    ALTER TABLE sensors.device ADD CONSTRAINT device_pkey PRIMARY KEY (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_name_key' AND conrelid = 'sensors.device'::regclass
  ) THEN
    ALTER TABLE sensors.device ADD CONSTRAINT device_name_key UNIQUE (name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_external_id_key' AND conrelid = 'sensors.device'::regclass
  ) THEN
    ALTER TABLE sensors.device ADD CONSTRAINT device_external_id_key UNIQUE (external_id);
  END IF;
END
$$;
