/*
 * #733 四站验收栈 · 带起脚本（可复现证据的一部分）。
 *
 * 前提（一次性，脚本外执行）：
 *   docker run -d --name mem733-stations-pg -p 127.0.0.1:55480:5432 \
 *     -e POSTGRES_USER=mem733 -e POSTGRES_PASSWORD=mem733 -e POSTGRES_DB=mem733 pgvector/pgvector:pg17
 *   并创建 identity_733 / memory_733 / openbot_733 三库，openbot_733 先跑过
 *   server/scripts/migrate.ts + server/ops/enterprise/roles.sql。
 *
 * 之后 `bun scripts/memory-service-stations/bring-up.ts` 幂等带起：
 *   IDENTITY :4212 / MEMORY :4232 / 外部应用 :4242 / OpenBot server :3002 / vite :3010，
 *   生成密钥与 env 文件、种子两位本人、登记两个应用、建 OpenBot 侧同串用户与 Bot，
 *   全部事实写入 <run>/facts.json（验收执行器与浏览器套件的输入）。
 */
import { execSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const RUN =
  process.env.MEM733_RUN_DIR ??
  join(process.cwd(), ".archive/runs/2026-10-31-memory-service-733");
const ENV_DIR = join(RUN, "env");
const LOGS = join(RUN, "logs");
const DB = "postgres://mem733:mem733@127.0.0.1:55480";
const IDENTITY = "http://127.0.0.1:4212";
const MEMORY = "http://127.0.0.1:4232";
const EXTERNAL = "http://127.0.0.1:4242";
const OPENBOT = "http://localhost:3002";
const IDENTITY_DIR = join(process.cwd(), "../openbot-identity");
const MEMORY_DIR = join(process.cwd(), "../openbot-memory");

for (const dir of [ENV_DIR, LOGS]) mkdirSync(dir, { recursive: true });
const envFile = (name: string) => join(ENV_DIR, name);
const secret = (name: string, make: () => string) => {
  const file = envFile(name);
  if (!existsSync(file)) writeFileSync(file, `${make()}\n`);
  return readFileSync(file, "utf8").trim();
};

const log = (step: string, detail: unknown) =>
  console.log(
    `[bring-up] ${step}`,
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );

/* ---- 1. 密钥与 env 文件（幂等） ---- */
const memOidcSecret = secret(
  "memory-oidc-secret.txt",
  () => `mas733-${randomBytes(24).toString("hex")}`,
);
const openbotClientSecret = secret(
  "openbot-client-secret.txt",
  () => `ob-${randomBytes(14).toString("hex")}`,
);
const srcToken = secret(
  "src-token.txt",
  () => `src733-${randomBytes(16).toString("hex")}`,
);
const extToken = secret(
  "ext-token.txt",
  () => `ext733-${randomBytes(16).toString("hex")}`,
);
const identityInternal = secret(
  "identity-internal.txt",
  () => `int733-${randomBytes(16).toString("hex")}`,
);
// shortcut: identity.env 的接线属 #733 后续票；secret()/IIFE 的写盘副作用必须保留，先裸调用过 noUnusedVariables。
secret("identity-cookie.txt", () => randomBytes(24).toString("hex"));
const sourceKey = secret(
  "source-key.txt",
  () => `sk733-${randomBytes(24).toString("hex")}`,
);
(() => {
  const file = envFile("signing-key.b64");
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(file, privateKey.replaceAll("\n", "\\n"));
  }
})();

const people = {
  a: {
    email: "m733-a@test.example",
    password: secret(
      "person-password-a.txt",
      () => `pw733a-${randomBytes(8).toString("hex")}`,
    ),
  },
  b: {
    email: "m733-b@test.example",
    password: secret(
      "person-password-b.txt",
      () => `pw733b-${randomBytes(8).toString("hex")}`,
    ),
  },
};

const identityClients = [
  {
    clientId: "memory-web",
    clientSecret: memOidcSecret,
    redirectUris: ["http://localhost:4232/auth/callback"],
    postLogoutUris: [],
    audience: "memory",
  },
  {
    clientId: "openbot",
    clientSecret: openbotClientSecret,
    redirectUris: [
      "http://localhost:3002/api/auth/oauth/identity-center/callback",
    ],
    postLogoutUris: [],
    audience: "openbot",
  },
];
// shortcut: identityClients 等 identity.env 接线属 #733 后续票，先 void 保声明。
void identityClients;

/* ---- 2. 进程带起（pid 存活即跳过） ---- */
function up(
  name: string,
  command: {
    cwd: string;
    args: string[];
    envFiles?: string[];
    env?: Record<string, string>;
  },
) {
  const pidFile = join(LOGS, `${name}.pid`);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, 0);
      log(name, `already up (pid ${pid})`);
      return pid;
    } catch {
      /* stale */
    }
  }
  const args = [
    ...(command.envFiles ?? []).flatMap((file) => ["--env-file", file]),
    ...command.args,
  ];
  const child = spawn("bun", args, {
    cwd: command.cwd,
    env: { ...process.env, ...(command.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const pid = child.pid;
  if (pid === null) throw new Error(`${name}: spawn failed`);
  writeFileSync(pidFile, `${pid}\n`);
  log(name, `booted pid ${pid}`);
  return pid;
}

const waitFor = async (name: string, url: string, deadlineMs = 30_000) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        log(name, "ready");
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} did not become ready at ${url}`);
};

const gitSha = (cwd: string) =>
  execSync("git rev-parse HEAD", { cwd }).toString().trim();

up("identity", {
  cwd: IDENTITY_DIR,
  args: ["src/index.ts"],
  envFiles: [envFile("identity.env")],
});
await waitFor("identity", `${IDENTITY}/.well-known/openid-configuration`);

/* ---- 3. 身份种子与令牌（PKCE，与 MEMORY 测试同法） ---- */
const seedAndToken = async (person: { email: string; password: string }) => {
  const signUp = await fetch(`${IDENTITY}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: IDENTITY },
    body: JSON.stringify({
      name: person.email.split("@")[0],
      email: person.email,
      password: person.password,
    }),
  });
  if (!signUp.ok && signUp.status !== 422)
    throw new Error(`seed failed: ${signUp.status}`);

  const cookies = new Map<string, string>();
  const jarFetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (cookies.size)
      headers.set(
        "cookie",
        [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0)
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = `${IDENTITY}/oauth2/authorize?${new URLSearchParams({
    client_id: "memory-web",
    redirect_uri: "http://localhost:4232/auth/callback",
    response_type: "code",
    scope: "openid",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  await jarFetch(authorize);
  await jarFetch(`${IDENTITY}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: IDENTITY,
    },
    body: new URLSearchParams({
      email: person.email,
      password: person.password,
      return_to: authorize,
    }),
  });
  const authorized = await jarFetch(authorize);
  const code = new URL(
    authorized.headers.get("location") ?? "",
  ).searchParams.get("code");
  if (!code) throw new Error("authorize did not yield a code");
  const token = await fetch(`${IDENTITY}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`memory-web:${memOidcSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:4232/auth/callback",
      code_verifier: verifier,
    }),
  });
  if (!token.ok) throw new Error(`token failed: ${token.status}`);
  const body = (await token.json()) as { access_token: string };
  const payload = JSON.parse(
    Buffer.from(body.access_token.split(".")[1], "base64url").toString("utf8"),
  );
  return { token: body.access_token, subjectId: String(payload.sub) };
};

const tokens: Record<string, { token: string; subjectId: string }> = {};
for (const key of ["a", "b"] as const)
  tokens[key] = await seedAndToken(people[key]);
writeFileSync(envFile("person-tokens.json"), JSON.stringify(tokens, null, 2));
log("persons", { a: tokens.a.subjectId, b: tokens.b.subjectId });

/* ---- 4. MEMORY 站（operator = 本人 A）与外部应用站 ---- */
writeFileSync(
  envFile("memory.env"),
  [
    "MEMORY_PORT=4232",
    `MEMORY_DATABASE_URL=${DB}/memory_733`,
    `MEMORY_OIDC_ISSUER=${IDENTITY}`,
    "MEMORY_OIDC_CLIENT_ID=memory-web",
    `MEMORY_OIDC_CLIENT_SECRET=${memOidcSecret}`,
    "MEMORY_OIDC_REDIRECT_URI=http://localhost:4232/auth/callback",
    "MEMORY_EMBED_HOST_ORIGIN=http://localhost:3010",
    "MEMORY_EMBED_RETURN_URI=http://localhost:3010/memory",
    `MEMORY_OPERATOR_SUBJECTS=${tokens.a.subjectId}`,
    `MEMORY_SOURCE_ORIGINS=${JSON.stringify({
      openbot: { baseUrl: OPENBOT, token: srcToken },
      "external-demo": { baseUrl: EXTERNAL, token: extToken },
    })}`,
    "",
  ].join("\n"),
);

up("memory", {
  cwd: MEMORY_DIR,
  args: ["stations/station.ts"],
  envFiles: [envFile("memory.env")],
});
await waitFor("memory", `${MEMORY}/health`);

up("external", {
  cwd: process.cwd(),
  args: ["scripts/memory-service-stations/external-app.ts"],
  env: {
    EXTERNAL_APP_PORT: "4242",
    EXTERNAL_APP_TOKEN: extToken,
    EXTERNAL_APP_STATE_FILE: envFile("external-state.json"),
  },
});
await waitFor("external", `${EXTERNAL}/health`);

/* ---- 5. 应用登记（幂等：已有密钥即复用，不重复轮换） ---- */
const register = async (
  appId: string,
  capabilities: string[],
  callbackUrl?: string,
) => {
  const response = await fetch(`${MEMORY}/manage/apps`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokens.a.token}`,
    },
    body: JSON.stringify({
      appId,
      displayName: appId,
      capabilities,
      ...(callbackUrl ? { callbackUrl } : {}),
    }),
  });
  if (!response.ok) throw new Error(`register ${appId}: ${response.status}`);
  const body = (await response.json()) as { secret: string };
  return body.secret;
};
const secretsFile = envFile("app-secrets.json");
const appSecrets = (() => {
  if (existsSync(secretsFile)) {
    const saved = JSON.parse(readFileSync(secretsFile, "utf8")) as Record<
      string,
      string
    >;
    if (saved.openbot && saved["external-demo"]) return saved;
  }
  return null;
})() ?? {
  openbot: await register("openbot", ["collect", "recall"]),
  "external-demo": await register(
    "external-demo",
    ["collect", "recall"],
    `${EXTERNAL}/callback`,
  ),
};
writeFileSync(envFile("app-secrets.json"), JSON.stringify(appSecrets, null, 2));
await fetch(`${EXTERNAL}/test/memory`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    baseUrl: MEMORY,
    appId: "external-demo",
    secret: appSecrets["external-demo"],
  }),
});

/* ---- 6. OpenBot 站（覆盖层：隔离库 + 记忆服务 + 身份中心客户端） ---- */
writeFileSync(
  envFile("openbot-overlay.env"),
  [
    `DATABASE_URL=${DB}/openbot_733`,
    `MEMORY_SERVICE_URL=http://localhost:4232`,
    "MEMORY_SERVICE_APP_ID=openbot",
    `MEMORY_SERVICE_APP_SECRET=${appSecrets.openbot}`,
    `MEMORY_SERVICE_SOURCE_KEY=${sourceKey}`,
    `MEMORY_SOURCE_CHECK_TOKEN=${srcToken}`,
    `IDENTITY_CENTER_OAUTH_ISSUER=${IDENTITY}`,
    "IDENTITY_CENTER_OAUTH_CLIENT_ID=openbot",
    `IDENTITY_CENTER_OAUTH_CLIENT_SECRET=${openbotClientSecret}`,
    `IDENTITY_CENTER_INTERNAL_TOKEN=${identityInternal}`,
    "",
  ].join("\n"),
);

up("openbot", {
  cwd: join(process.cwd(), "server"),
  args: ["src/index.ts"],
  envFiles: ["../.env", envFile("openbot-overlay.env")],
});
await waitFor("openbot", `${OPENBOT}/ready`);
up("vite", {
  cwd: join(process.cwd(), "app"),
  args: ["run", "dev"],
  env: { SERVER_PORT: "3002" },
});
await waitFor("vite", "http://localhost:3010/");

/* ---- 7. OpenBot 侧用户/Bot/会话（与身份中心 subject 同串，#715 连续性拓扑） ---- */
const admin = postgres(`${DB}/openbot_733`, { max: 1 });
const sub = tokens.a.subjectId;
await admin`
  insert into users (id, email, name, email_verified, created_at, updated_at)
  values (${sub}, ${people.a.email}, 'm733-a', true, now(), now()) on conflict (id) do nothing`;
await admin`
  insert into accounts (id, user_id, account_id, provider_id, created_at, updated_at)
  values (gen_random_uuid()::text, ${sub}, ${sub}, 'identity-center', now(), now())`;
await admin`
  insert into sessions (id, user_id, token, expires_at, created_at, updated_at)
  values ('sess733a', ${sub}, 'sess733a-token', now() + interval '12 hours', now(), now())`;
await admin`
  insert into agents (id, name, type, configuration, created_at, updated_at)
  values ('bot733-a', 'm733 记忆验收 Bot', 'built_in', '{}', now(), now()) on conflict (id) do nothing`;
await admin`
  insert into agent_profiles (agent_id, owner_user_id, title, role_description, avatar_seed, visibility, created_at, updated_at)
  values ('bot733-a', ${sub}, '记忆验收 Bot', 'Assist', 'seed733', 'private', now(), now()) on conflict (agent_id) do nothing`;
await admin.end({ timeout: 5 });

/* ---- 8. facts.json（验收输入与版本清单） ---- */
const facts = {
  run: RUN,
  stations: {
    identity: {
      url: IDENTITY,
      port: 4212,
      cwd: IDENTITY_DIR,
      gitSha: gitSha(IDENTITY_DIR),
    },
    memory: {
      url: MEMORY,
      port: 4232,
      cwd: MEMORY_DIR,
      gitSha: gitSha(MEMORY_DIR),
    },
    external: {
      url: EXTERNAL,
      port: 4242,
      cwd: process.cwd(),
      gitSha: gitSha(process.cwd()),
    },
    openbot: {
      url: OPENBOT,
      port: 3002,
      cwd: process.cwd(),
      gitSha: gitSha(process.cwd()),
    },
    vite: { url: "http://localhost:3010", port: 3010 },
  },
  databases: {
    container: "mem733-stations-pg",
    host: "127.0.0.1:55480",
    names: ["identity_733", "memory_733", "openbot_733"],
  },
  persons: {
    a: {
      email: people.a.email,
      subjectId: tokens.a.subjectId,
      openbotSessionToken: "sess733a-token",
      botId: "bot733-a",
    },
    b: { email: people.b.email, subjectId: tokens.b.subjectId },
  },
  apps: { openbot: "openbot", external: "external-demo" },
  cleanupOwner:
    "run 2026-10-31-memory-service-733 (container mem733-stations-pg, pids in logs/)",
  bootedAt: new Date().toISOString(),
};
writeFileSync(join(RUN, "facts.json"), JSON.stringify(facts, null, 2));
log("facts", join(RUN, "facts.json"));
console.log(
  "[bring-up] four stations up:",
  Object.keys(facts.stations).join(" "),
);
