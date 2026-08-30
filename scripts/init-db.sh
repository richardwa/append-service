#!/usr/bin/env bash
# Creates the database (if needed) and applies scripts/init.sql.
# Requires: psql, and PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE env or .env
set -euo pipefail

cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
export PGDATABASE="${PGDATABASE:-messages}"

echo "Ensuring database '${PGDATABASE}' exists..."
if ! psql -tAc "SELECT 1 FROM pg_database WHERE datname='${PGDATABASE}'" | grep -q 1; then
  psql -d postgres -c "CREATE DATABASE \"${PGDATABASE}\""
  echo "Created database '${PGDATABASE}'."
fi

echo "Applying scripts/init.sql..."
psql -f scripts/init.sql
echo "Done."
