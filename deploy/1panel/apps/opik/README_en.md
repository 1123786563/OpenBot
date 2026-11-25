## Introduction

OpenBot Opik for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

Select a database instance managed by 1Panel. The form generates a database name, user, and password. 1Panel uses these values to create the database and its dedicated user. To reuse a registered database, enter its current credentials.

Use MySQL 8.4. ClickHouse, ZooKeeper, and MinIO ship with the app. The API joins the shared 1Panel network for use by trusted containers.

## Redis

During installation, select an existing Redis instance in 1Panel. The Redis password field is filled from the selected instance; leave it empty if the instance has no password. If the password contains URI special characters, also fill in the URL-encoded Redis password, using the same encoding as for the database password. Opik uses Redis for caching and for queueing evaluation jobs.

When upgrading from a version that bundled its own Redis, jobs queued in the old Redis are not migrated.
