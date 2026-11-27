import { createRequire } from "node:module";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const required = {
  "/server": "DATABASE_URL",
  "/worker": "DATABASE_URL",
  "/flexprice": "FLEXPRICE_POSTGRES_PASSWORD",
  "/temporal": "POSTGRES_PWD",
};

export async function settings(environment) {
  const names = [
    "INFISICAL_SITE_URL",
    "INFISICAL_PROJECT_ID",
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
  ];
  if (names.some((name) => !environment[name]))
    throw new Error("Missing Infisical bootstrap configuration");
  const path = environment.INFISICAL_SECRET_PATH;
  if (!Object.hasOwn(required, path))
    throw new Error("Unknown runtime configuration folder");
  const { InfisicalSDK } = createRequire("/app/package.json")("@infisical/sdk");
  const client = new InfisicalSDK({ siteUrl: environment.INFISICAL_SITE_URL });
  await client.auth().universalAuth.login({
    clientId: environment.INFISICAL_CLIENT_ID,
    clientSecret: environment.INFISICAL_CLIENT_SECRET,
  });
  const response = await client.secrets().listSecrets({
    projectId: environment.INFISICAL_PROJECT_ID,
    environment: environment.INFISICAL_ENV || "prod",
    secretPath: path,
    expandSecretReferences: false,
  });
  const values = Object.create(null);
  for (const { secretKey, secretValue } of response.secrets) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretKey) ||
      typeof secretValue !== "string"
    )
      throw new Error("Invalid runtime secret");
    values[secretKey] = secretValue;
  }
  if (!values[required[path]])
    throw new Error("Required runtime configuration is absent");
  return values;
}

if (import.meta.main) {
  try {
    const values = await settings(process.env);
    const args = process.argv.slice(2);
    if (args[0] === "--export") {
      const target = args[1];
      if (!target || args.length !== 2)
        throw new Error("Expected one export path");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const text = Object.entries(values)
        .map(
          ([key, value]) =>
            `${key}=${JSON.stringify(value.replaceAll("$", "$$"))}\n`,
        )
        .join("");
      await writeFile(`${target}.tmp`, text, { mode: 0o600 });
      await rename(`${target}.tmp`, target);
      console.error(
        `Infisical: exported ${Object.keys(values).length} settings`,
      );
    } else {
      if (args.length === 0) throw new Error("Expected a runtime command");
      const env = { ...process.env, ...values };
      delete env.INFISICAL_CLIENT_SECRET;
      delete process.env.INFISICAL_CLIENT_SECRET;
      console.error(
        `Infisical: loaded ${Object.keys(values).length} settings from ${process.env.INFISICAL_SECRET_PATH}`,
      );
      const child = Bun.spawn(args, {
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      for (const signal of ["SIGTERM", "SIGINT"])
        process.on(signal, () => child.kill(signal));
      process.exitCode = await child.exited;
    }
  } catch {
    console.error(
      "Infisical configuration unavailable; runtime was not started. Check the identity, permissions and Infisical service.",
    );
    process.exitCode = 1;
  }
}
