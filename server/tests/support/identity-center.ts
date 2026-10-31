import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Identity-center-provider.test bootstrap helpers (#714/#715).
 *
 * openbot-identity 是独立仓库的独立进程：这里只负责在 OpenBot 的 e2e 进程里
 * 把它作为真实 Bun 子进程拉起（隔离测试库 + 临时签名密钥），并给出 OpenBot 侧
 * RP 配置的生成入口。凭据全部测试专用，不读生产库。
 */

export function generateSigningKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey;
}

export function identityTestDatabaseUrl(): string {
  if (process.env.OPENBOT_IDENTITY_TEST_DATABASE_URL) {
    return process.env.OPENBOT_IDENTITY_TEST_DATABASE_URL;
  }
  const envFile = join(process.cwd(), "..", "openbot-identity", ".env.local");
  if (existsSync(envFile)) {
    const match = readFileSync(envFile, "utf8").match(
      /TEST_IDENTITY_DATABASE_URL=(\S+)/,
    );
    if (match) return match[1];
  }
  throw new Error(
    "identity test database URL missing: set OPENBOT_IDENTITY_TEST_DATABASE_URL or create ../openbot-identity/.env.local",
  );
}

/**
 * True when BOTH halves of the fixture exist: the sibling openbot-identity
 * checkout (this repo's CI never clones it) and a test database URL. Suites
 * built on startIdentityCenter skip on false instead of failing their hooks —
 * the checkout is a developer-machine artifact, not something a red CI could
 * act on (#755 CI baseline).
 */
export function identityCenterAvailable(): boolean {
  const identityDir = join(process.cwd(), "..", "openbot-identity");
  if (!existsSync(join(identityDir, "src", "index.ts"))) return false;
  if (process.env.OPENBOT_IDENTITY_TEST_DATABASE_URL) return true;
  return existsSync(join(identityDir, ".env.local"));
}

export type IdentityCenterProcess = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stop: () => Promise<void>;
};

export async function startIdentityCenter(
  options: {
    port?: number;
    clientId?: string;
    /** 额外环境变量（#715 内部主体 API 的服务令牌等）。 */
    env?: Record<string, string>;
  } = {},
): Promise<IdentityCenterProcess> {
  const port = options.port ?? 4210;
  const issuer = `http://127.0.0.1:${port}`;
  const clientId = options.clientId ?? "openbot-web";
  const clientSecret =
    "itc-" +
    createHash("sha256").update(`itc-${port}`).digest("hex").slice(0, 24);
  const callbackUrl =
    "http://127.0.0.1:3000/api/auth/oauth2/callback/identity-center";

  const identityDir = join(process.cwd(), "..", "openbot-identity");
  if (!existsSync(join(identityDir, "src", "index.ts"))) {
    throw new Error(`openbot-identity checkout not found at ${identityDir}`);
  }

  const env = {
    IDENTITY_ISSUER: issuer,
    IDENTITY_DATABASE_URL: identityTestDatabaseUrl(),
    IDENTITY_SIGNING_KEY_PEM: generateSigningKeyPem(),
    IDENTITY_COOKIE_SECRET:
      "e2e-" +
      createHash("sha256").update(`secret-${port}`).digest("hex").slice(0, 32),
    IDENTITY_PORT: String(port),
    IDENTITY_CLIENTS: JSON.stringify([
      {
        clientId,
        clientSecret,
        redirectUris: [callbackUrl],
        postLogoutUris: ["http://127.0.0.1:3000/"],
        audience: "openbot",
      },
    ]),
  };

  // e2e 的 node target 用 Node 执行测试进程，被测身份中心是 Bun 子进程。
  const child = spawn("bun", ["src/index.ts"], {
    cwd: identityDir,
    env: { ...process.env, ...(env as Record<string, string>), ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const _stop = () =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    });

  const deadline = Date.now() + 15_000;
  let ready = false;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${issuer}/.well-known/openid-configuration`,
      );
      if (response.ok) {
        ready = true;
        break;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    child.kill();
    throw new Error(
      `identity center did not become ready on ${issuer}: ${lastError}`,
    );
  }

  return {
    issuer,
    clientId,
    clientSecret,
    callbackUrl,
    stop,
  };
}
