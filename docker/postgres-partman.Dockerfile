# Plain PostgreSQL plus the two extensions the migration chain walks through.
#
# This image used to build on pgvector/pgvector:pg17, then moved to stock postgres:17 when the
# last Postgres-side vector column (chunks.embedding) was dropped in
# server/drizzle/0010_drop_the_document_index.sql — but a deployment starting from nothing still
# WALKS the chain, and migration 0000 creates that column before 0010 drops it. A stock image
# fails 0000 with `extension "vector" is not available` (SQLSTATE 0A000) before any of that
# matters. So pgvector stays, installed from the PGDG apt repo the base image already carries —
# the same source the pgvector base image itself uses — just without pinning the whole base:
#
#   vector   → migration 0000's chunks.embedding (dropped by 0010; kept for chain replay)
#   partman  → Lago (docker-compose.lago.yml), which installs from db/structure.sql and
#              unconditionally DROPs and re-CREATEs pg_partman (getlago/lago v1.53,
#              structure.sql lines 1435-1464). Without the binary in this image that load
#              fails with "extension pg_partman is not available", and pre-installing it is
#              no escape because the same load drops it first. So the binary has to be here.
FROM postgres:17

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    postgresql-17-pgvector \
    postgresql-17-partman \
  && rm -rf /var/lib/apt/lists/*
