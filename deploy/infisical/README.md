# Infisical

See the [OpenBot deployment overview](../README.md) for the service layout and startup order.

Self-hosted [Infisical](https://infisical.com) that holds OpenBot's configuration, one folder per service, so OpenBot's settings files are generated instead of edited by hand.

## Start it

```sh
cp .env.example .env              # then set ENCRYPTION_KEY, AUTH_SECRET, POSTGRES_PASSWORD
docker compose up -d              # opens at http://localhost:18082
```

Create the first account in the browser at `http://localhost:18082`, or with `POST /api/v1/admin/signup`, which is how this instance's was made. The password must be at least 14 characters.

## How OpenBot reads it

The backend loads its settings from Infisical every time it starts, so a change made in Infisical is live after a restart and nothing else:

```sh
bash scripts/start.sh               # from the repository root
```

It works the same for `bun run dev`. Both run `server/scripts/infisical-env.ts` before the server's entry point; with no `.env.openbot-client` present it does nothing and the settings files are all there is, so a checkout without Infisical starts as before.

## Folders

OpenBot's settings live in one file per service, and each file comes from one Infisical folder. There is no `.env` in the repository root.

| Infisical folder | File | Holds |
| --- | --- | --- |
| `/` | `deploy/openbot/.env` | The database address, the ports, and the secret the server and the worker share. |
| `/server` | `deploy/openbot/.env.server` | Everything only the API server reads. |
| `/worker` | `deploy/openbot/.env.worker` | Everything only the worker reads. The worker reads `.env` and `.env.server` as well, since it runs the server's billing and sign-in code. |
| `/agents` | `deploy/agents/.env` | The Agent containers' model address and key, model names and tokens. |

The service folders need not exist yet. Until an administrator creates one and moves keys into it, every key sits in `/`, the server reads it there and the sync writes it all into `deploy/openbot/.env`, so an existing Infisical works unchanged and moves into the folders in its own time. Only `/` itself must exist.

A key has one folder. The API server reads `/`, `/server` and `/agents`, because it picks each Bot's model from the settings the Bots run with, so a key in two of those would reach it twice: the sync refuses that and names the key.

A value can come from three places, and the earlier one wins: the shell, then Infisical, then the settings files. `start.sh` works out ports and tokens and passes them through the shell, so those stay final; it does not pass the files to the server. `bun run dev` does pass them, for anything Infisical lacks, and Infisical replaces what they supplied.

If Infisical is not running, the backend does not start. The reason is in `.logs/server.log`.

Everything else still reads the files: the worker, the agent containers, the app's generated configuration, and the ports `start.sh` itself reads. After changing one of those in Infisical, bring the files back in step and restart:

```sh
bun run sync:env
bash scripts/start.sh
```

`scripts/infisical-env.ts` does that with `@infisical/sdk`, a devDependency of the repository root. It logs in as the read-only machine identity in `.env.openbot-client` (git-ignored), reads the four folders and writes the four files in one step. It leaves every file alone when Infisical is unreachable or empty, and when a local file holds a filled-in value that Infisical lacks, other than `MANAGED_AGENT_TOKEN` and `AGENT_TOOL_TOKEN`, which `start.sh` generates into the agents' file and the sync carries over. It takes the repository root to write into as an optional argument.

## Connect another checkout

In Infisical, create a machine identity with Universal Auth, give it the `viewer` role on the project, and copy its client ID and secret into a new `.env.openbot-client`:

```
INFISICAL_SITE_URL=http://localhost:18082
INFISICAL_PROJECT_ID=<project id>
INFISICAL_ENV=dev
INFISICAL_CLIENT_ID=<client id>
INFISICAL_CLIENT_SECRET=<client secret>
```
