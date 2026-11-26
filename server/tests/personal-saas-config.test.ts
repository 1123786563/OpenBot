import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));

// Synthetic values only: the entry refuses each partial setup before any connection.
const trial = {
  OPENBOT_PERSONAL_SAAS_MODE: "private-trial",
  OPENBOT_PERSONAL_SAAS_URL: "https://personal.example/",
  CASDOOR_ISSUER: "https://casdoor.example/",
  CASDOOR_DISCOVERY_URL:
    "https://casdoor.example/.well-known/openid-configuration",
  CASDOOR_ACCOUNT_STATUS_URL: "https://casdoor.example/api/status",
  CASDOOR_CLIENT_ID: "synthetic-client",
  CASDOOR_CLIENT_SECRET: "synthetic-secret",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  DATABASE_URL: "postgres://openbot:openbot@127.0.0.1:1/openbot",
  PORT: "39999",
};
const flash = {
  OPENBOT_AGENT_SANDBOX_FLASH_REGION: "cn-hangzhou",
  OPENBOT_AGENT_SANDBOX_FLASH_TEMPLATE: "synthetic-template",
  OPENBOT_AGENT_SANDBOX_FLASH_ARTIFACT:
    "/nonexistent/openbot-flash-runtime.tar.gz",
  E2B_API_KEY: "synthetic-flash-key",
};
const nasPair = {
  OPENBOT_AGENT_SANDBOX_NAS_ACCESS_KEY_ID: "synthetic-nas-key",
  OPENBOT_AGENT_SANDBOX_NAS_ACCESS_KEY_SECRET: "synthetic-nas-secret",
};

async function start(env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", "src/personal-saas/index.ts"],
    cwd: serverRoot,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot ?? "",
            WINDIR: process.env.WINDIR ?? "",
            TEMP: process.env.TEMP ?? "",
            TMP: process.env.TMP ?? "",
          }
        : {}),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 4_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { output: `${stdout}\n${stderr}`, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

test("Personal SaaS refuses Flash without the NAS key pair that admits allocation", async () => {
  // Either half alone would otherwise leave a deployment with no Computer provider.
  for (const env of [flash, nasPair]) {
    const { output, exitCode } = await start({ ...trial, ...env });
    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      "Configure the Flash region, template, worker artifact, E2B API key and NAS access key pair together",
    );
  }
}, 10_000);
