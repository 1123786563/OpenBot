## Introduction

OpenBot Observability for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

Select a database instance managed by 1Panel. The form generates a database name, user, and password. 1Panel uses these values to create the database and its dedicated user. To reuse a registered database, enter its current credentials. If the password contains URI special characters, enter the original password and fill the separate URL-encoded password field.

PostgreSQL stores OpenObserve metadata. Back up the data volume for log data. OTel Collector ships with the app.
