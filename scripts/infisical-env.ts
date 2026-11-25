// Render OpenBot's per-service env files from Infisical, which is the source of truth: one Infisical
// folder per file (ENV_FILES in ./infisical-env-file). Edit a value in Infisical, then run
// `bun run sync:env` from the repository root and restart OpenBot.
// Usage: bun run sync:env [repository-root]   default: this repository

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { InfisicalSDK } from "@infisical/sdk";
import { ENV_FILES, isMissingInfisicalFolder } from "../shared/env-files";
import { planEnvFiles } from "./infisical-env-file";

const {
  INFISICAL_SITE_URL,
  INFISICAL_PROJECT_ID,
  INFISICAL_ENV = "dev",
  INFISICAL_CLIENT_ID,
  INFISICAL_CLIENT_SECRET,
} = process.env;
if (
  !INFISICAL_SITE_URL ||
  !INFISICAL_PROJECT_ID ||
  !INFISICAL_CLIENT_ID ||
  !INFISICAL_CLIENT_SECRET
) {
  throw new Error(
    "Run `bun run sync:env` from the repository root: it loads the machine identity",
  );
}
const projectRoot = resolve(import.meta.dir, "..");
const root = resolve(process.argv[2] ?? projectRoot);

const client = new InfisicalSDK({ siteUrl: INFISICAL_SITE_URL });
await client.auth().universalAuth.login({
  clientId: INFISICAL_CLIENT_ID,
  clientSecret: INFISICAL_CLIENT_SECRET,
});
const folders: Record<string, Record<string, string>> = {};
let listed = 0;
for (const { folder } of ENV_FILES) {
  // expandSecretReferences: false, so a value holding "$X" or backticks comes out as written.
  const { secrets } = await client
    .secrets()
    .listSecrets({
      projectId: INFISICAL_PROJECT_ID,
      environment: INFISICAL_ENV,
      secretPath: folder,
      expandSecretReferences: false,
    })
    // A service folder nobody has created yet reads as empty; `/` itself must exist.
    .catch((error: unknown) => {
      if (folder !== "/" && isMissingInfisicalFolder(error))
        return { secrets: [] };
      throw error;
    });
  listed += secrets.length;
  // A name that is not a variable name, such as "db.url", cannot be loaded.
  folders[folder] = Object.fromEntries(
    secrets
      .filter((secret) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.secretKey))
      .map((secret) => [secret.secretKey, secret.secretValue]),
  );
}
// Nothing below can leave a half-written or emptied file behind.
if (listed === 0)
  throw new Error(
    `Infisical returned no secrets in ${INFISICAL_ENV}; every file left untouched`,
  );

const plans = planEnvFiles(folders, (file) => {
  try {
    return parseEnv(readFileSync(join(root, file), "utf8"));
  } catch {
    return {};
  }
});
// A filled-in value that only exists locally would be lost by the rewrite.
const local = plans.flatMap(({ file, localOnly }) =>
  localOnly.map((key) => `${file}: ${key}`),
);
if (local.length > 0) {
  throw new Error(
    `Only in the local files, which are left untouched. Add them to Infisical first: ${local.join(", ")}`,
  );
}

for (const { file, text } of plans) {
  const out = join(root, file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}.tmp`, text, { mode: 0o600 });
  await rename(`${out}.tmp`, out);
}
console.log(`Wrote ${plans.map(({ file }) => file).join(", ")} under ${root}`);
