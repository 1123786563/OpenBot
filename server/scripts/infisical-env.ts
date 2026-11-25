// Loads OpenBot's settings from Infisical before the server starts, so a restart picks up a change made
// in Infisical with nothing in between. start.sh and `bun run dev` preload it when the machine identity
// in deploy/infisical/.env.openbot-client is present; without it nothing happens and the env files are
// all there is.
//
// A value can arrive from three places, and the order is: the shell, then Infisical, then the env files.
// start.sh works out ports and tokens and passes them through the shell, so they must stay final. A value
// that came from an env file is stale the moment Infisical changes, so Infisical replaces those. One that
// the shell set to the same thing cannot be told from it, which is why start.sh does not pass the files
// alongside.
//
// Read from Infisical: `/`, `/server` and `/agents`, the three folders behind the files the server is
// started with (SERVER_ENV_FILES). The worker and the Agent containers have no preload: they read the
// files `bun run sync:env` renders.

import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import {
  isMissingInfisicalFolder,
  SERVER_ENV_FILES,
} from "@openbot/shared/env-files";

const {
  INFISICAL_SITE_URL,
  INFISICAL_PROJECT_ID,
  INFISICAL_CLIENT_ID,
  INFISICAL_CLIENT_SECRET,
} = process.env;
const environment = process.env.INFISICAL_ENV ?? "dev";

if (
  INFISICAL_SITE_URL &&
  INFISICAL_PROJECT_ID &&
  INFISICAL_CLIENT_ID &&
  INFISICAL_CLIENT_SECRET
) {
  // The files given on the command line that hold the server's settings; the machine identity is not one.
  const settingsFiles = process.execArgv
    .filter((argument) => argument.startsWith("--env-file="))
    .map((argument) => argument.slice("--env-file=".length))
    .filter((path) =>
      // Spelled with forward slashes on the command line or with backslashes, as Windows does.
      SERVER_ENV_FILES.some((file) =>
        path.replaceAll("\\", "/").endsWith(file),
      ),
    );
  const fromEnvFiles = new Set(
    (
      await Promise.all(
        settingsFiles.map((path) => readFile(path, "utf8").catch(() => "")),
      )
    ).flatMap((text) => Object.keys(parseEnv(text))),
  );

  const { InfisicalSDK } = await import("@infisical/sdk");
  const client = new InfisicalSDK({ siteUrl: INFISICAL_SITE_URL });
  let secrets: { secretKey: string; secretValue: string }[];
  const listAt = (secretPath: string) =>
    client
      .secrets()
      .listSecrets({
        projectId: INFISICAL_PROJECT_ID,
        environment,
        secretPath,
        // expandSecretReferences: false, so a value holding "$X" or backticks comes out as written.
        expandSecretReferences: false,
      })
      .then(({ secrets }) => secrets)
      // A service folder nobody has created yet reads as empty; `/` itself must exist.
      .catch((error: unknown) => {
        if (secretPath !== "/" && isMissingInfisicalFolder(error)) return [];
        throw error;
      });
  try {
    await client.auth().universalAuth.login({
      clientId: INFISICAL_CLIENT_ID,
      clientSecret: INFISICAL_CLIENT_SECRET,
    });
    // Read whole: the server picks each Bot's model, so it needs the agents' settings as well as its own.
    secrets = (
      await Promise.all(["/", "/server", "/agents"].map((path) => listAt(path)))
    ).flat();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read settings from Infisical at ${INFISICAL_SITE_URL}: ${reason}`,
    );
  }
  // Its one job is done, and the server starts processes that inherit this environment.
  delete process.env.INFISICAL_CLIENT_SECRET;

  for (const { secretKey, secretValue } of secrets) {
    // A name that is not a variable name, such as "db.url", cannot be read back.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretKey)) continue;
    if (fromEnvFiles.has(secretKey) || process.env[secretKey] === undefined) {
      process.env[secretKey] = secretValue;
    }
  }
  // On stderr, so it stays out of whatever the entry point prints.
  console.error(
    `Settings: ${secrets.length} loaded from Infisical (${environment})`,
  );
}
