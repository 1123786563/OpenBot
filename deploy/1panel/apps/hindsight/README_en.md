## Introduction

OpenBot Hindsight for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

During installation, select an existing PostgreSQL instance in 1Panel and enter the existing database name, user, and password.

Use a PostgreSQL instance with pgvector. Have the administrator run `CREATE EXTENSION IF NOT EXISTS vector;` in the target database. The API joins the shared 1Panel network for use by trusted containers.
