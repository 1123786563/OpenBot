## Introduction

OpenBot is a self-hosted AI collaboration app. The package includes the web app, API, and browser, and uses an existing PostgreSQL instance.

## Features

- Chat with bots and run approved tasks in the browser.
- Connect a model provider or Bifrost.
- Sign in with Google OAuth.

## Database

During installation, select an existing PostgreSQL instance in 1Panel and enter the existing database name, user, and password.

Use a PostgreSQL instance with pgvector available. On a fresh database, OpenBot 1.0.3 creates and drops the vector extension. Temporarily grant SUPERUSER to the dedicated application role and revoke it as soon as the migrate service finishes or installation is aborted.
