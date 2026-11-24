// Loads OpenBot's settings from Infisical before the server starts, so a restart picks up a change made
// in Infisical with nothing in between. start.sh and `bun run dev` preload it when the machine identity
// in deploy/infisical/.env.openbot-client is present; without it nothing happens and .env is all there is.
//
// A value can arrive from three places, and the order is: the shell, then Infisical, then .env. start.sh
// works out ports and tokens and passes them through the shell, so they must stay final. A value that
// came from .env is stale the moment Infisical changes, so Infisical replaces those. One that the shell
// set to the same thing cannot be told from it, which is why start.sh does not pass .env alongside.
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseEnv } from "node:util";
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
  const dotEnv = process.execArgv
    .filter((argument) => argument.startsWith("--env-file="))
    .map((argument) => argument.slice("--env-file=".length))
    .find((path) => basename(path) === ".env");
  const fromDotEnv = new Set(
    Object.keys(
      parseEnv(dotEnv ? await readFile(resolve(dotEnv), "utf8") : ""),
    ),
  );

  const { InfisicalSDK } = await import("@infisical/sdk");
  const client = new InfisicalSDK({ siteUrl: INFISICAL_SITE_URL });
  let secrets: { secretKey: string; secretValue: string }[];
  try {
    await client.auth().universalAuth.login({
      clientId: INFISICAL_CLIENT_ID,
      clientSecret: INFISICAL_CLIENT_SECRET,
    });
    // expandSecretReferences: false, so a value holding "$X" or backticks comes out as written.
    ({ secrets } = await client.secrets().listSecrets({
      projectId: INFISICAL_PROJECT_ID,
      environment,
      secretPath: "/",
      expandSecretReferences: false,
    }));
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
    if (fromDotEnv.has(secretKey) || process.env[secretKey] === undefined) {
      process.env[secretKey] = secretValue;
    }
  }
  // On stderr, so it stays out of whatever the entry point prints.
  console.error(`Settings: ${secrets.length} loaded from Infisical (${environment})`);
}
