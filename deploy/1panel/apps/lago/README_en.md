## Introduction

OpenBot Lago for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

During installation, select an existing PostgreSQL instance in 1Panel and enter the existing database name, user, and password.

Use PostgreSQL 15 or later with pg_partman installed. Lago 1.57.0 requires a temporary SUPERUSER grant to its dedicated role when initializing a fresh database. Revoke it right after migration or if installation is aborted.
