# Infisical

See the [OpenBot deployment overview](../README.md) for the service layout and startup order.

Self-hosted [Infisical](https://infisical.com) that holds OpenBot's configuration, so the root `.env` is generated instead of edited by hand.

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

It works the same for `bun run dev`. Both run `server/scripts/infisical-env.ts` before the server's entry point; with no `.env.openbot-client` present it does nothing and `.env` is all there is, so a checkout without Infisical starts as before.

A value can come from three places, and the earlier one wins: the shell, then Infisical, then `.env`. `start.sh` works out ports and tokens and passes them through the shell, so those stay final; it does not pass `.env` to the server. `bun run dev` does pass it, for anything Infisical lacks, and Infisical replaces what `.env` supplied.

If Infisical is not running, the backend does not start. The reason is in `.logs/server.log`.

Everything else still reads the `.env` file: the worker, the agent containers, the app's generated configuration, and the ports `start.sh` itself reads. After changing one of those in Infisical, bring the file back in step and restart:

```sh
bun run sync:env
bash scripts/start.sh
```

`scripts/infisical-env.ts` does that with `@infisical/sdk`, a devDependency of the repository root. It logs in as the read-only machine identity in `.env.openbot-client` (git-ignored) and writes the file in one step. It leaves the file alone when Infisical is unreachable or empty, and when the local file holds a filled-in value that Infisical lacks, other than `MANAGED_AGENT_TOKEN` and `AGENT_TOOL_TOKEN`, which `start.sh` generates and the sync carries over. It takes the output file as an optional argument.

## Connect another checkout

In Infisical, create a machine identity with Universal Auth, give it the `viewer` role on the project, and copy its client ID and secret into a new `.env.openbot-client`:

```
INFISICAL_SITE_URL=http://localhost:18082
INFISICAL_PROJECT_ID=<project id>
INFISICAL_ENV=dev
INFISICAL_CLIENT_ID=<client id>
INFISICAL_CLIENT_SECRET=<client secret>
```
