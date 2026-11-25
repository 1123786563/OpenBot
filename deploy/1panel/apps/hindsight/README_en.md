## Introduction

OpenBot Hindsight for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

Select a database instance managed by 1Panel. The form generates a database name, user, and password. 1Panel uses these values to create the database and its dedicated user. To reuse a registered database, enter its current credentials. If the password contains URI special characters, enter the original password and fill the separate URL-encoded password field.

Use a PostgreSQL instance with pgvector. Have the administrator run `CREATE EXTENSION IF NOT EXISTS vector;` in the target database. The API joins the shared 1Panel network for use by trusted containers.

## Console

The console binds to host loopback port 19999 and has no login gate by default. Open `http://127.0.0.1:19999` on the host, or reach it through an access-controlled reverse proxy. Do not expose it to the public internet.
