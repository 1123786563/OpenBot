# pgvector, plus the one extension Lago's fresh-install path needs.
#
# The stock pgvector image is OpenBot's database; Lago (docker-compose.yml's `lago` profile,
# sharing this postgres through a dedicated database) installs from db/structure.sql, which
# unconditionally DROPs and re-CREATEs the pg_partman extension (getlago/lago v1.53,
# structure.sql lines 1435-1464). Without the binary in this image that load fails with
# "extension pg_partman is not available", and pre-installing it is no escape because the same
# load drops it first. So the binary has to be here, and it comes from the PGDG apt repo the
# base image already carries.
FROM pgvector/pgvector:pg17

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-partman \
  && rm -rf /var/lib/apt/lists/*
