#!/bin/sh
set -eu
for app in openbot bifrost hindsight infisical openobserve spire flexprice temporal; do
  key=$(printf '%s' "$app" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD
  password=$(printenv "$key")
  [ -n "$password" ] || { echo "Missing $key" >&2; exit 1; }
  psql -X -v ON_ERROR_STOP=1 -v role="$app" -v password="$password" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'role', :'role')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'role') \gexec
SQL
done
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE DATABASE temporal_visibility OWNER temporal'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal_visibility') \gexec
SQL
for database in openbot hindsight; do
  psql -X -v ON_ERROR_STOP=1 -d "$database" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
done
