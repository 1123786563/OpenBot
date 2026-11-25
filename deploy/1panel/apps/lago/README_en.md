## Introduction

OpenBot Lago for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

During installation, select an existing PostgreSQL instance in 1Panel. The form generates the database name, user, and password. Replace these values with the current credentials when reusing an existing database.

Use PostgreSQL 15 or later with pg_partman installed. 1Panel creates the database and its dedicated user before Lago starts. Its generated PostgreSQL role has SUPERUSER privileges for initialization. Revoke them after migration or if installation is aborted.

## Redis

During installation, select an existing Redis instance in 1Panel. The Redis password field is filled from the selected instance; leave it empty if the instance has no password. Lago uses Redis for caching, background job queues, and live updates.

When upgrading from a version that bundled its own Redis, pending background jobs in the old Redis are not migrated. Let the queues drain before rebuilding.

## Admin account

Fill in the initial organization name, admin email, and password in the install form. On an empty database, the migration creates the organization, the admin, and the organization's API key. Sign in with that email and password after the installation. Copy the `LAGO_API_KEY` for OpenBot usage export from **Settings → Developers**.

Self-registration is closed. The admin adds other accounts in **Settings → Members**. Password recovery requires a configured mail sender.

When updating an existing installation to this version, enter the current admin email, the current organization name, and any password. The migration only creates missing records and never changes an existing user's password. Leave all three empty to skip initialization.
