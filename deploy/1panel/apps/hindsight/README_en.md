## Introduction

OpenBot Hindsight for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

The app ships its own PostgreSQL (`pgvector/pgvector:pg17`, service name `postgres`, reachable only on the app's internal network, with its data in the `postgres-data` volume) and uses it by default. Fill in the database name, user and password in the install parameters; the database is created from them on first start. Changing them afterwards does not alter the database that was already created; to change the credentials, recreate the data volume.

A PostgreSQL instance managed by 1Panel can be used instead: enter that instance's container name as the **PostgreSQL host**. The instance must provide pgvector, and pgvector must run on this machine's CPU. The pgvector in the PostgreSQL cluster image 1Panel ships is built for AVX-512; on a machine without AVX-512 a single vector write crashes the database backend and drops every connection on that instance, so on such a machine keep the default built-in database. When reusing an existing database, have the administrator run `CREATE EXTENSION IF NOT EXISTS vector;` in the target database. If the password contains URI special characters, enter the original password as the **database password** and then fill the separate URL-encoded password field.

The API joins the shared 1Panel network for use by trusted containers.

## Console

The console is the app's web UI and its primary 1Panel access port (`PANEL_APP_PORT_HTTP`, default 19999), so the install's access link opens the console. The API uses a separate port, `PANEL_APP_PORT_API` (default 18888); OpenBot calls it over the container network at `http://hindsight:8888` and does not depend on that host port.

The console is protected by the console access key from the install form: it opens on a login page, and neither the pages nor the console API answer until the key is entered. The key can be changed in the app's parameters after installation and takes effect when the app is rebuilt, which also signs out every existing session.

The console binds to a host loopback port. Open `http://127.0.0.1:19999` on the host, or reach it through a reverse proxy. The API port has no login gate; do not proxy it to the public internet. If it must be exposed, proxy only `/v1/` and require callers to carry the API key.
