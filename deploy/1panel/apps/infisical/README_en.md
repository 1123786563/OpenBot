## Introduction

OpenBot Infisical for OpenBot. See the OpenBot 1Panel deployment guide for dependencies and configuration.

## Database

Select a database instance managed by 1Panel. The form generates a database name, user, and password. 1Panel uses these values to create the database and its dedicated user. To reuse a registered database, enter its current credentials. If the password contains URI special characters, enter the original password and fill the separate URL-encoded password field.

Prepare a dedicated Infisical database and role. Keep the original encryption key when restoring data.
## Redis

During installation, select an existing Redis instance in 1Panel. The Redis password field is filled from the selected instance; leave it empty if the instance has no password. If the password contains URI special characters, also fill in the URL-encoded Redis password, using the same encoding as for the database password.
