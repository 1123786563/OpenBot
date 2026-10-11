# Plain PostgreSQL plus the one extension Lago's fresh-install path needs.
#
# This image used to build on pgvector/pgvector:pg17. Embeddings now live in Qdrant
# (the `qdrant` service in docker-compose.yml); the last Postgres-side vector column
# (chunks.embedding) was dropped in server/drizzle/0010_drop_the_document_index.sql and
# the `vector` extension went with it, so the pgvector base buys nothing anymore and the
# stock postgres image carries everything that is left:
#
# Lago (docker-compose.yml's `lago` profile, sharing this postgres through a dedicated
# database) installs from db/structure.sql, which unconditionally DROPs and re-CREATEs
# the pg_partman extension (getlago/lago v1.53, structure.sql lines 1435-1464). Without
# the binary in this image that load fails with "extension pg_partman is not available",
# and pre-installing it is no escape because the same load drops it first. So the binary
# has to be here, and it comes from the PGDG apt repo the base image already carries.
FROM postgres:17

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-partman \
  && rm -rf /var/lib/apt/lists/*
