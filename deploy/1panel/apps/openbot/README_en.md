## Introduction

OpenBot is a self-hosted AI collaboration app. The package runs the web app, API, and worker with an existing PostgreSQL instance and a separate Agents deployment.

## Features

- Chat with bots and run approved tasks in the browser.
- Connect a model provider or Bifrost.
- Sign in with Google OAuth.

## Database

Select a database instance managed by 1Panel. The form generates a database name, user, and password. 1Panel uses these values to create the database and its dedicated user. To reuse a registered database, enter its current credentials. If the password contains URI special characters, enter the original password and fill the separate URL-encoded password field.

Use a PostgreSQL instance with pgvector available. On a fresh database, OpenBot 1.0.3 creates and drops the vector extension. Temporarily grant SUPERUSER to the dedicated application role and revoke it as soon as the migrate service finishes or installation is aborted.
