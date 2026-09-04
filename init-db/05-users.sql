-- 05: application users and grants (run in the "home" database)
--   sensors_rw : read/write on sensors tables
--   sensors_ro : read-only on sensors tables
-- Idempotent: safe to run on an already-initialized database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sensors_rw') THEN
    CREATE ROLE sensors_rw LOGIN PASSWORD 'SENSORS_RW_PW';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sensors_ro') THEN
    CREATE ROLE sensors_ro LOGIN PASSWORD 'SENSORS_RO_PW';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA sensors TO sensors_rw, sensors_ro;

-- read/write user: full DML on the sensor tables + sequence for device.id
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sensors.device, sensors.power, sensors.temperature, sensors.humidity
TO sensors_rw;
GRANT USAGE, SELECT ON SEQUENCE sensors.device_id_seq TO sensors_rw;

-- read-only user
GRANT SELECT ON
  sensors.device, sensors.power, sensors.temperature, sensors.humidity
TO sensors_ro;

-- future tables/sequences created by postgres in sensors get the same
-- treatment automatically (e.g. new hypertables or lookup tables)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sensors
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sensors_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sensors
  GRANT SELECT ON TABLES TO sensors_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA sensors
  GRANT USAGE, SELECT ON SEQUENCES TO sensors_rw;
