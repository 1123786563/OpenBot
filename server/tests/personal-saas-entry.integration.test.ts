import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApprovalStore } from "../src/approvals/store";
import { approvalAction } from "../src/approvals/types";
import { botSeat, seatText } from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import {
  agents,
  attachments,
  brokeredConnections,
  channelAgents,
  channelMemberships,
  channels,
  computerSnapshot,
  personalMemories,
  routines,
  users,
  workItems,
} from "../src/db/schema";
import {
  personalSaasAccounts,
  personalSaasNativeCodes,
} from "../src/db/schema/personal-saas";
import {
  type AccountDisablement,
  createAccountAccess,
} from "../src/personal-saas/account-access";
import { createPersonalSaasApp } from "../src/personal-saas/app";
import { PERSONAL_BOT_WORK } from "../src/personal-saas/bot-work";
import { workspaceIntegrationGrants } from "../src/personal-saas/integration-grants";
import { personalSaasStore } from "../src/personal-saas/store";
import { workspaceBots } from "../src/personal-saas/workspace-bots";
import type { WorkspaceComputerConfig } from "../src/personal-saas/workspace-computer";
import { createWorkQueue } from "../src/work/queue";
import { testDatabaseUrl } from "./support/database";
import { assertWorkspaceIsolation } from "./support/workspace-isolation";

const origin = "https://trial.openbot.example";
const supportSubject = crypto.randomUUID();
const otherSupportSubject = crypto.randomUUID();
const clientId = "openbot-trial";
const operatorToken = "s".repeat(43);
const clientSecret = "casdoor-test-secret";
const database = createDatabase(testDatabaseUrl(), { max: 4 });
const botProfiles = createAgentProfileStore(database, undefined);
const profileReader = { id: "saas53-test-reader", role: "admin" } as const;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const signingKey = await exportJWK(publicKey);
const issuer = "https://casdoor.example";
const callback = `${origin}/auth/casdoor/callback`;
const reverifyCallback = `${origin}/auth/casdoor/reverify/callback`;

type Account = {
  sub: string;
  email: string;
  verified?: boolean;
  active?: boolean;
  disablements?: AccountDisablement[];
};
const authorizeCodes = new Map<
  string,
  {
    account: Account;
    nonce: string;
    challenge: string;
    authTime?: number;
    redirectUri?: string;
  }
>();
const statusAccounts = new Map<string, Account>();
let clockTime: number | undefined;
const now = () => clockTime ?? Date.now();
const accessTokens = new Map<string, Account>();
const snapshotGates = new WeakMap<Account, () => Promise<void>>();
const introspectionGates = new WeakMap<Account, () => Promise<void>>();
let provider: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createPersonalSaasApp>;

beforeAll(() => {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const base = url.origin;
      switch (url.pathname) {
        case "/.well-known/openid-configuration":
          return Response.json({
            issuer,
            authorization_endpoint: `${base}/login/oauth/authorize`,
            token_endpoint: `${base}/api/login/oauth/access_token`,
            userinfo_endpoint: `${base}/api/userinfo`,
            introspection_endpoint: `${base}/api/login/oauth/introspect`,
            jwks_uri: `${base}/.well-known/jwks`,
          });
        case "/.well-known/jwks":
          return Response.json({
            keys: [{ ...signingKey, kid: "trial", alg: "RS256", use: "sig" }],
          });
        case "/api/login/oauth/access_token": {
          const form = await request.formData();
          const code = String(form.get("code"));
          const entry = authorizeCodes.get(code);
          authorizeCodes.delete(code);
          if (
            !entry ||
            form.get("redirect_uri") !== (entry.redirectUri ?? callback) ||
            form.get("client_id") !== clientId ||
            form.get("client_secret") !== clientSecret ||
            new Bun.CryptoHasher("sha256")
              .update(String(form.get("code_verifier")))
              .digest("base64url") !== entry.challenge
          )
            return new Response(null, { status: 400 });
          const access = crypto.randomUUID();
          accessTokens.set(access, entry.account);
          if ((entry.redirectUri ?? callback) === callback) {
            statusAccounts.set(entry.account.sub, entry.account);
          }
          const id = await new SignJWT({
            nonce: entry.nonce,
            auth_time: entry.authTime,
          })
            .setProtectedHeader({ alg: "RS256", kid: "trial" })
            .setSubject(entry.account.sub)
            .setIssuer(issuer)
            .setAudience(clientId)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
          return Response.json({
            access_token: access,
            id_token: id,
            token_type: "Bearer",
          });
        }
        case "/api/userinfo": {
          const account = accessTokens.get(
            request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          );
          if (!account) return new Response(null, { status: 401 });
          return Response.json({
            iss: issuer,
            aud: clientId,
            sub: account.sub,
            email: account.email,
            email_verified: account.verified,
          });
        }
        case "/account-status": {
          const form = await request.formData();
          const subject = String(form.get("subject"));
          const account = statusAccounts.get(subject);
          if (
            form.get("client_id") !== clientId ||
            form.get("client_secret") !== clientSecret ||
            account?.active === undefined
          )
            return new Response(null, { status: 503 });
          const snapshot = Response.json({
            issuer,
            subject,
            active: account.active,
            observedAt: now(),
            disablements: account.disablements ?? [],
          });
          const gate = snapshotGates.get(account);
          snapshotGates.delete(account);
          await gate?.();
          return snapshot;
        }
        case "/api/login/oauth/introspect": {
          const form = await request.formData();
          if (
            form.get("client_id") !== clientId ||
            form.get("client_secret") !== clientSecret
          )
            return new Response(null, { status: 401 });
          const account = accessTokens.get(String(form.get("token")));
          if (account) await introspectionGates.get(account)?.();
          return Response.json({
            active: account?.active,
            client_id: clientId,
            iss: issuer,
            sub: account?.sub,
          });
        }
      }
      return new Response(null, { status: 404 });
    },
  });
  app = newApp();
});

function newApp(
  db = database,
  dependency?: WorkspaceComputerConfig | TurnRunner,
  computer?: WorkspaceComputerConfig,
) {
  return createPersonalSaasApp(
    {
      origin,
      supportSubjects: [supportSubject, otherSupportSubject],
      now,
      computer: typeof dependency === "function" ? computer : dependency,
      runPersonalBot: typeof dependency === "function" ? dependency : undefined,
      suspensionOperator: { id: "trial-operator", token: operatorToken },
      suspensionSupport: "support@example.com",
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      casdoor: {
        issuer,
        discoveryUrl: new URL(
          "/.well-known/openid-configuration",
          provider.url,
        ),
        accountStatusUrl: new URL("/account-status", provider.url),
        clientId,
        clientSecret,
        allowLoopbackHttp: true,
      },
    },
    db,
  );
}

afterAll(async () => {
  await provider?.stop(true);
  await database.$client.close();
});

function send(path: string, init?: RequestInit) {
  return app.fetch(new Request(new URL(path, origin), init));
}

function cookie(response: Response, prefix: string) {
  const header = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(prefix));
  if (!header) throw new Error(`Missing ${prefix} cookie`);
  return header.split(";", 1)[0];
}

async function authenticate(account: Account) {
  const start = await send("/auth/casdoor/start");
  return completeBrowserLogin(start, account);
}

async function completeBrowserLogin(start: Response, account: Account) {
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.get("location") ?? "");
  const state = authorization.searchParams.get("state") ?? "";
  const code = crypto.randomUUID();
  authorizeCodes.set(code, {
    account,
    nonce: authorization.searchParams.get("nonce") ?? "",
    challenge: authorization.searchParams.get("code_challenge") ?? "",
  });
  return send(
    `/auth/casdoor/callback?${new URLSearchParams({ state, code, iss: issuer })}`,
    { headers: { cookie: cookie(start, "__Host-openbot-oidc-") } },
  );
}

async function enter(session: string) {
  return send("/workspace/prepare", {
    method: "POST",
    headers: { cookie: session, origin },
  });
}

async function workspace(session: string) {
  const reply = await send("/api/workspace", { headers: { cookie: session } });
  expect(reply.status).toBe(200);
  return reply.json();
}

test("a verified active ordinary email can reach its private workspace and default assistant", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "person@example.com",
    verified: true,
    active: true,
  };
  const signedIn = await authenticate(account);
  expect(signedIn.status).toBe(303);
  const session = cookie(signedIn, "__Host-openbot-personal=");
  const preparing = await send(signedIn.headers.get("location") ?? "", {
    headers: { cookie: session },
  });
  expect(await preparing.text()).toContain("Preparing your Personal Workspace");
  expect((await enter(session)).headers.get("location")).toBe("/workspace");
  const landing = await send("/workspace", { headers: { cookie: session } });
  const landingPage = await landing.text();
  expect(landingPage).toContain("Personal Assistant");
  expect(landingPage).toContain("No conversations yet.");
  const result = await workspace(session);
  expect(result).toEqual({
    id: expect.any(String),
    personalAssistant: { id: expect.any(String), name: "Personal Assistant" },
  });
  const headers = { cookie: session, origin };
  const botId = result.personalAssistant.id;
  expect((await send(`/api/agents/${botId}`, { headers })).status).toBe(404);
  expect((await send("/api/plugins", { headers })).status).toBe(404);
  expect(
    (await send(`/api/computers/${botId}/status`, { headers })).status,
  ).toBe(404);
  expect(
    (await send("/api/copilotkit", { method: "POST", headers })).status,
  ).toBe(404);
  expect((await send("/api/workspace")).status).toBe(401);
});

test.each([
  ["unverified email", undefined, true, 403, "Verify your email"],
  ["inactive account", true, false, 403, "Account unavailable"],
  ["unknown account status", true, undefined, 503, "Sign-in unavailable"],
] as const)(
  "first entry refuses %s",
  async (_, verified, active, status, heading) => {
    const account = {
      sub: crypto.randomUUID(),
      email: "person@example.com",
      verified,
      active,
    };
    const refused = await authenticate(account);
    expect(refused.status).toBe(status);
    expect(await refused.text()).toContain(heading);
    expect(
      refused.headers
        .getSetCookie()
        .some((value) => value.startsWith("__Host-openbot-personal=")),
    ).toBe(false);
    const admitted = await authenticate({
      ...account,
      verified: true,
      active: true,
    });
    const session = cookie(admitted, "__Host-openbot-personal=");
    const beforeProvisioning = await send("/api/workspace", {
      headers: { cookie: session },
    });
    expect(beforeProvisioning.status).toBe(202);
  },
);

test("concurrent first entries converge and email changes never link a different subject", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "original@example.com",
    active: true,
    verified: true,
  };
  const before = await botProfiles.list(profileReader);
  const sessions = await Promise.all(
    Array.from({ length: 4 }, async () =>
      cookie(await authenticate(owner), "__Host-openbot-personal="),
    ),
  );
  const entries = await Promise.all(sessions.map(enter));
  for (const entry of entries)
    expect(entry.headers.get("location")).toBe("/workspace");
  const results = await Promise.all(sessions.map(workspace));
  const [first] = results;
  for (const result of results) expect(result).toEqual(first);
  expect(
    await botProfiles.get(profileReader, first.personalAssistant.id),
  ).toMatchObject({ ...first.personalAssistant, visibility: "private" });
  const bots = await botProfiles.list(profileReader);
  expect(bots.filter((bot) => !before.some(({ id }) => id === bot.id))).toEqual(
    [expect.objectContaining(first.personalAssistant)],
  );

  const recovered = cookie(
    await authenticate({ ...owner, email: "changed@example.com" }),
    "__Host-openbot-personal=",
  );
  expect(await workspace(recovered)).toEqual(results[0]);
  const different = cookie(
    await authenticate({
      ...owner,
      sub: crypto.randomUUID(),
      email: "changed@example.com",
    }),
    "__Host-openbot-personal=",
  );
  await enter(different);
  const otherWorkspace = await workspace(different);
  expect(otherWorkspace.id).not.toBe(results[0].id);
  expect(otherWorkspace.personalAssistant.id).not.toBe(
    results[0].personalAssistant.id,
  );
  expect(
    (
      await send(`/api/workspace/${results[0].id}`, {
        headers: { cookie: different },
      })
    ).status,
  ).toBe(404);
  expect(
    (await send(`/api/computer/status`, { headers: { cookie: recovered } }))
      .status,
  ).toBe(404);
});

test("interruption after writing the Bot rolls back first entry and the same session can retry", async () => {
  const before = await botProfiles.list(profileReader);
  const account = {
    sub: crypto.randomUUID(),
    email: "retry@example.com",
    active: true,
    verified: true,
  };
  const session = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await database.$client.unsafe(`
    CREATE FUNCTION saas53_fail_first_assistant() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT FROM personal_workspaces w JOIN personal_saas_accounts a ON a.id = w.owner_id
        WHERE w.id = NEW.workspace_id AND a.subject = '${account.sub}') THEN
        RAISE EXCEPTION 'injected assistant write failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER saas53_fail_first_assistant BEFORE INSERT ON personal_workspace_default_bots
      FOR EACH ROW EXECUTE FUNCTION saas53_fail_first_assistant();
  `);
  try {
    const interrupted = await enter(session);
    expect(interrupted.status).toBe(503);
    expect(await interrupted.text()).toContain("Retry");
    expect(await botProfiles.list(profileReader)).toHaveLength(before.length);
    expect(
      (await send("/api/workspace", { headers: { cookie: session } })).status,
    ).toBe(202);
  } finally {
    await database.$client.unsafe(
      "DROP TRIGGER saas53_fail_first_assistant ON personal_workspace_default_bots; DROP FUNCTION saas53_fail_first_assistant();",
    );
  }
  expect((await enter(session)).headers.get("location")).toBe("/workspace");
  const first = await workspace(session);
  expect((await enter(session)).headers.get("location")).toBe("/workspace");
  expect(await workspace(session)).toEqual(first);
  expect(
    await botProfiles.get(profileReader, first.personalAssistant.id),
  ).toMatchObject({ ...first.personalAssistant, visibility: "private" });
  const bots = await botProfiles.list(profileReader);
  expect(bots.filter((bot) => !before.some(({ id }) => id === bot.id))).toEqual(
    [expect.objectContaining(first.personalAssistant)],
  );
});

test("status loss during preparation blocks entry and the original session can retry after confirmation", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "later@example.com",
    verified: true,
    active: true,
  };
  const confirmedAt = Date.now();
  clockTime = confirmedAt;
  try {
    const session = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    account.active = undefined;
    clockTime = confirmedAt + 59_999;
    const headers = { cookie: session };
    expect((await send("/api/workspace", { headers })).status).toBe(202);
    clockTime = confirmedAt + 60_000;
    const denied = await send("/api/workspace", { headers });
    expect(denied.status).toBe(503);
    expect(await denied.json()).toEqual({
      error: "account_status_unconfirmed",
      cutoffAt: confirmedAt + 60_000,
    });
    expect((await enter(session)).status).toBe(503);
    account.active = true;
    expect((await send("/api/workspace", { headers })).status).toBe(202);
    expect((await enter(session)).headers.get("location")).toBe("/workspace");
  } finally {
    clockTime = undefined;
  }
});

test("cross-site forms cannot provision or end a Personal SaaS session", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "forms@example.com",
    active: true,
    verified: true,
  };
  const session = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  const crossSite = {
    method: "POST",
    headers: { cookie: session, origin: "https://elsewhere.example" },
  };
  expect((await send("/workspace/prepare", crossSite)).status).toBe(403);
  expect((await send("/auth/sign-out", crossSite)).status).toBe(403);
  expect(
    (await send("/api/workspace", { headers: { cookie: session } })).status,
  ).toBe(202);
  const signedOut = await send("/auth/sign-out", {
    method: "POST",
    headers: { origin, cookie: session },
  });
  expect(signedOut.status).toBe(303);
  expect(
    (await send("/api/workspace", { headers: { cookie: session } })).status,
  ).toBe(401);
});

test("the registered redirect refuses a callback without its initiating browser", async () => {
  const start = await send("/auth/casdoor/start");
  const authorization = new URL(start.headers.get("location") ?? "");
  const callbackQuery = new URLSearchParams({
    state: authorization.searchParams.get("state") ?? "",
    code: crypto.randomUUID(),
    iss: issuer,
  });
  const unsolicited = await send(`/auth/casdoor/callback?${callbackQuery}`);
  expect(unsolicited.status).toBe(400);
  expect(
    unsolicited.headers
      .getSetCookie()
      .some((value) => value.startsWith("__Host-openbot-personal=")),
  ).toBe(false);
});

async function nativeAttempt(client: "ios" | "android" | "desktop") {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const code_challenge = new Bun.CryptoHasher("sha256")
    .update(verifier)
    .digest("base64url");
  const start = await send(
    `/auth/native/start?${new URLSearchParams({ client, state, code_challenge })}`,
  );
  return { start, state, client, code_verifier: verifier };
}

function exchangeNative(body: Record<string, unknown>, requestOrigin?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (requestOrigin !== undefined) headers.set("origin", requestOrigin);
  return send("/api/auth/native/exchange", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function nativeSessionHeaders(
  client: "ios" | "android" | "desktop",
  account: Account,
) {
  const { start, ...proof } = await nativeAttempt(client);
  const finish = await completeBrowserLogin(start, account);
  const code = new URL(finish.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const exchange = await exchangeNative({ ...proof, code });
  expect(exchange.status).toBe(200);
  const { token } = await exchange.json();
  return { authorization: `Bearer ${token}` };
}

test("Web, Desktop, iOS, and Android share the owner’s workspace and conversation history", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "mobile@example.com",
    active: true,
    verified: true,
  };
  const native = async (client: "ios" | "android" | "desktop") => {
    const { start, ...proof } = await nativeAttempt(client);
    const finish = await completeBrowserLogin(start, owner);
    expect(
      finish.headers
        .getSetCookie()
        .some((value) => value.startsWith("__Host-openbot-personal=")),
    ).toBe(false);
    const deepLink = new URL(finish.headers.get("location") ?? "");
    expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe(
      client === "desktop"
        ? "openbot://auth/personal-saas"
        : "openbotmobile://auth/personal-saas",
    );
    expect(deepLink.searchParams.get("state")).toBe(proof.state);
    const exchange = await exchangeNative({
      ...proof,
      code: deepLink.searchParams.get("code"),
    });
    expect(exchange.status).toBe(200);
    const { token } = await exchange.json();
    expect(typeof token).toBe("string");
    return { authorization: `Bearer ${token}` };
  };
  const before = await botProfiles.list(profileReader);
  const [web, ios, android, desktop] = await Promise.all([
    authenticate(owner).then((reply) =>
      cookie(reply, "__Host-openbot-personal="),
    ),
    native("ios"),
    native("android"),
    native("desktop"),
  ]);
  expect(ios.authorization).not.toBe(android.authorization);
  expect(web).not.toContain(ios.authorization.slice(7));
  expect(web).not.toContain(android.authorization.slice(7));
  expect(
    (
      await send("/api/workspace", {
        headers: { ...ios, origin: "https://elsewhere.example" },
      })
    ).status,
  ).toBe(403);
  const preparing = await send("/api/workspace", { headers: desktop });
  expect(preparing.status).toBe(202);
  const [webReady, iosReady, androidReady, desktopReady] = await Promise.all([
    enter(web),
    send("/workspace/prepare", { method: "POST", headers: ios }),
    send("/workspace/prepare", { method: "POST", headers: android }),
    send("/workspace/prepare", { method: "POST", headers: desktop }),
  ]);
  expect([
    webReady.status,
    iosReady.status,
    androidReady.status,
    desktopReady.status,
  ]).toEqual([303, 204, 204, 204]);
  const expected = await workspace(web);
  for (const headers of [ios, android, desktop]) {
    const ready = await send("/api/workspace", { headers });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual(expected);
  }
  expect(expected.personalAssistant.name).toBe("Personal Assistant");
  const bots = await botProfiles.list(profileReader);
  expect(bots.filter((bot) => !before.some(({ id }) => id === bot.id))).toEqual(
    [expect.objectContaining(expected.personalAssistant)],
  );
  const otherWeb = cookie(
    await authenticate({ ...owner, sub: crypto.randomUUID() }),
    "__Host-openbot-personal=",
  );
  await enter(otherWeb);
  const otherWorkspace = await workspace(otherWeb);
  const historyPath = "/api/workspace/conversations";
  const ownChannel = crypto.randomUUID();
  const deletedChannel = crypto.randomUUID();
  const otherChannel = crypto.randomUUID();
  const sharedChannel = crypto.randomUUID();
  const enterpriseChannel = crypto.randomUUID();
  const enterpriseUser = crypto.randomUUID();
  await database.insert(channels).values([
    {
      id: ownChannel,
      name: "Personal Assistant",
      description: "",
      title: "Weekend <plans>",
      lastMessage: "Saturday at nine",
    },
    {
      id: deletedChannel,
      name: "Deleted conversation",
      description: "",
      deletedAt: new Date(),
    },
    { id: otherChannel, name: "Other account conversation", description: "" },
    { id: sharedChannel, name: "Shared conversation", description: "" },
    { id: enterpriseChannel, name: "Enterprise conversation", description: "" },
  ]);
  await database.insert(channelAgents).values([
    ...[ownChannel, deletedChannel, sharedChannel, enterpriseChannel].map(
      (channelId) => ({
        channelId,
        agentId: expected.personalAssistant.id,
      }),
    ),
    ...[otherChannel, sharedChannel].map((channelId) => ({
      channelId,
      agentId: otherWorkspace.personalAssistant.id,
    })),
  ]);
  await database.insert(users).values({
    id: enterpriseUser,
    email: `${enterpriseUser}@example.com`,
  });
  await database.insert(channelMemberships).values({
    userId: enterpriseUser,
    channelId: enterpriseChannel,
  });

  const ownHistory = [
    { id: ownChannel, title: "Weekend <plans>", preview: "Saturday at nine" },
  ];
  for (const headers of [{ cookie: web }, ios, android, desktop]) {
    const history = await send(historyPath, { headers });
    expect(history.status).toBe(200);
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(await history.json()).toEqual({ conversations: ownHistory });
  }
  const webPage = await send("/workspace", { headers: { cookie: web } });
  const html = await webPage.text();
  expect(html).toContain("Weekend &lt;plans&gt;");
  expect(html).toContain("Saturday at nine");
  expect(html).not.toContain("Other account conversation");
  const otherHistory = await send(
    `${historyPath}?workspaceId=${expected.id}&botId=${expected.personalAssistant.id}&conversationId=${ownChannel}`,
    { headers: { cookie: otherWeb } },
  );
  expect(otherHistory.status).toBe(200);
  expect(await otherHistory.json()).toEqual({
    conversations: [
      { id: otherChannel, title: "Other account conversation", preview: null },
    ],
  });
  const foreignIds = new URLSearchParams({
    workspaceId: otherWorkspace.id,
    botId: otherWorkspace.personalAssistant.id,
    conversationId: otherChannel,
  });
  const nativeHistory = await send(`${historyPath}?${foreignIds}`, {
    headers: android,
  });
  expect(nativeHistory.status).toBe(200);
  expect(await nativeHistory.json()).toEqual({ conversations: ownHistory });
  expect((await send(historyPath)).status).toBe(401);

  const returningIos = await native("ios");
  expect(returningIos.authorization).not.toBe(ios.authorization);
  const returningWorkspace = await send("/api/workspace", {
    headers: returningIos,
  });
  expect(returningWorkspace.status).toBe(200);
  expect(await returningWorkspace.json()).toEqual(expected);
  const returningHistory = await send(historyPath, { headers: returningIos });
  expect(await returningHistory.json()).toEqual({ conversations: ownHistory });
  expect(
    (await send("/auth/sign-out", { method: "POST", headers: ios })).status,
  ).toBe(204);
  expect((await send(historyPath, { headers: ios })).status).toBe(401);
  const androidHistory = await send(historyPath, { headers: android });
  expect(await androidHistory.json()).toEqual({ conversations: ownHistory });
});

test("native exchange is bound to its app proof and can only start one session", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "desktop@example.com",
    active: true,
    verified: true,
  };
  const { start, ...proof } = await nativeAttempt("desktop");
  const finish = await completeBrowserLogin(start, account);
  const link = new URL(finish.headers.get("location") ?? "");
  expect(`${link.protocol}//${link.host}${link.pathname}`).toBe(
    "openbot://auth/personal-saas",
  );
  const exchange = { ...proof, code: link.searchParams.get("code") };
  for (const invalid of [
    { ...exchange, client: "ios" },
    { ...exchange, state: randomBytes(32).toString("base64url") },
    { ...exchange, code_verifier: randomBytes(32).toString("base64url") },
  ])
    expect((await exchangeNative(invalid)).status).toBe(400);
  expect(
    (await exchangeNative(exchange, "https://elsewhere.example")).status,
  ).toBe(403);
  const outcomes = await Promise.all([
    exchangeNative(exchange),
    exchangeNative(exchange),
  ]);
  expect(outcomes.map((reply) => reply.status).sort()).toEqual([200, 400]);
  expect((await exchangeNative(exchange)).status).toBe(400);
});

test("a Desktop handoff issued before a disablement cannot create a session after recovery", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "desktop-cutoff@example.com",
    active: true,
    verified: true,
  };
  const { start, ...proof } = await nativeAttempt("desktop");
  const finish = await completeBrowserLogin(start, account);
  const link = new URL(finish.headers.get("location") ?? "");
  const code = link.searchParams.get("code");
  expect(code).toBeTruthy();

  account.disablements = [{ id: crypto.randomUUID(), effectiveAt: now() }];
  await app.refreshAccounts();
  expect((await exchangeNative({ ...proof, code })).status).toBe(400);

  const next = await nativeAttempt("desktop");
  const nextFinish = await completeBrowserLogin(next.start, account);
  const nextLink = new URL(nextFinish.headers.get("location") ?? "");
  expect(
    (
      await exchangeNative({
        client: next.client,
        state: next.state,
        code_verifier: next.code_verifier,
        code: nextLink.searchParams.get("code"),
      })
    ).status,
  ).toBe(200);
});

test("the native handoff expires and only returns to registered apps", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "expired@example.com",
    active: true,
    verified: true,
  };
  const { start, ...proof } = await nativeAttempt("ios");
  const before = Date.now();
  const finish = await completeBrowserLogin(start, account);
  const handoff = new URL(finish.headers.get("location") ?? "");
  const code = handoff.searchParams.get("code");
  if (!code) throw new Error("Missing native handoff code");
  const codeDigest = createHash("sha256").update(code).digest("base64url");
  const matchingCode = eq(personalSaasNativeCodes.codeHash, codeDigest);
  const [record] = await database
    .select()
    .from(personalSaasNativeCodes)
    .where(matchingCode);
  expect(record.expiresAt.getTime()).toBeWithin(
    before + 60_000,
    Date.now() + 60_001,
  );
  await database
    .update(personalSaasNativeCodes)
    .set({ expiresAt: new Date(before - 1) })
    .where(matchingCode);
  expect((await exchangeNative({ ...proof, code })).status).toBe(400);

  const query = new URLSearchParams({
    client: proof.client,
    state: proof.state,
    code_challenge: codeDigest,
    redirect_uri: "https://elsewhere.example/callback",
  });
  const rejected = await send(`/auth/native/start?${query}`);
  expect(rejected.status).toBe(400);
  expect(rejected.headers.has("location")).toBe(false);
});

test("a rejected native browser return can be retried and cannot bind to a different owner", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "private@example.com",
    active: true,
    verified: true,
  };
  const ownerSession = cookie(
    await authenticate(owner),
    "__Host-openbot-personal=",
  );
  await enter(ownerSession);
  const ownerWorkspace = await workspace(ownerSession);
  const other = { ...owner, sub: crypto.randomUUID() };
  const first = await nativeAttempt("android");
  const browser = new URL(first.start.headers.get("location") ?? "");
  const query = new URLSearchParams({
    state: browser.searchParams.get("state") ?? "",
    error: "access_denied",
  });
  const cancelled = await send(`/auth/casdoor/callback?${query}`, {
    headers: { cookie: cookie(first.start, "__Host-openbot-oidc-") },
  });
  const cancellation = new URL(cancelled.headers.get("location") ?? "");
  expect(cancellation.searchParams.get("state")).toBe(first.state);
  expect(cancellation.searchParams.get("error")).toBe("sign_in_incomplete");
  expect(cancellation.searchParams.has("code")).toBe(false);

  const { start, ...proof } = await nativeAttempt("android");
  const finish = await completeBrowserLogin(start, other);
  const handoff = new URL(finish.headers.get("location") ?? "");
  const session = await exchangeNative({
    ...proof,
    code: handoff.searchParams.get("code"),
  });
  expect(session.status).toBe(200);
  const { token } = await session.json();
  const authorization = `Bearer ${token}`;
  const prepare = await send("/workspace/prepare", {
    method: "POST",
    headers: { authorization },
  });
  expect(prepare.status).toBe(204);
  const entry = await send(`/api/workspace?id=${ownerWorkspace.id}`, {
    headers: { authorization, cookie: ownerSession },
  });
  expect(entry.status).toBe(200);
  expect((await entry.json()).id).not.toBe(ownerWorkspace.id);
  const signedOut = await send("/auth/sign-out", {
    method: "POST",
    headers: { authorization, cookie: ownerSession },
  });
  expect(signedOut.status).toBe(204);
  expect(
    (
      await send("/api/workspace", {
        headers: { authorization, cookie: ownerSession },
      })
    ).status,
  ).toBe(401);
  expect(await workspace(ownerSession)).toEqual(ownerWorkspace);
});

async function withReplica(
  run: (connect: (session: string) => Promise<Response>) => Promise<void>,
) {
  const replicaDatabase = createDatabase(testDatabaseUrl(), { max: 2 });
  const replica = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: newApp(replicaDatabase).fetch,
  });
  try {
    await run((session) =>
      fetch(new URL("/api/auth/session/events", replica.url), {
        headers: { cookie: session },
        signal: AbortSignal.timeout(20_000),
      }),
    );
  } finally {
    await replica.stop(true);
    await replicaDatabase.$client.close();
  }
}

async function readSessionStream(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing session stream");
  expect((await reader.read()).done).toBe(false);
  return reader;
}

async function expectRevoked(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let events = "";
  for (
    let chunk = await reader.read();
    !chunk.done;
    chunk = await reader.read()
  ) {
    events += decoder.decode(chunk.value, { stream: true });
  }
  expect(events).toContain("event: signed-out");
}

function signOut(session: string) {
  return send("/auth/sign-out", {
    method: "POST",
    headers: { cookie: session, origin },
  });
}

test("signing out ends its live connection on another server and leaves the second session in the workspace", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "multi-device@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await enter(first);
  const original = await workspace(second);
  await withReplica(async (connect) => {
    const [firstStream, secondStream] = await Promise.all([
      connect(first).then(readSessionStream),
      connect(second).then(readSessionStream),
    ]);
    expect((await signOut(first)).status).toBe(303);
    expect(
      (await send("/api/workspace", { headers: { cookie: first } })).status,
    ).toBe(401);
    expect((await connect(first)).status).toBe(401);
    await expectRevoked(firstStream);
    expect((await secondStream.read()).done).toBe(false);
    expect(await workspace(second)).toEqual(original);
    await secondStream.cancel();
  });
});

async function beginRevocation(session: string) {
  const response = await send("/auth/sign-out-all", {
    method: "POST",
    headers: { origin, cookie: session },
  });
  expect(response.status).toBe(303);
  const authorization = new URL(response.headers.get("location") ?? "");
  expect(authorization.searchParams.get("prompt")).toBe("login");
  expect(authorization.searchParams.get("max_age")).toBe("0");
  expect(authorization.searchParams.get("redirect_uri")).toBe(reverifyCallback);
  return {
    authorization,
    pending: cookie(response, "__Host-openbot-reverify-"),
  };
}

async function finishRevocation(
  { authorization, pending }: Awaited<ReturnType<typeof beginRevocation>>,
  session: string,
  account: Account,
  authTime: number | undefined,
) {
  const code = crypto.randomUUID();
  authorizeCodes.set(code, {
    account,
    nonce: authorization.searchParams.get("nonce") ?? "",
    challenge: authorization.searchParams.get("code_challenge") ?? "",
    redirectUri: reverifyCallback,
    authTime,
  });
  const query = new URLSearchParams({
    code,
    state: authorization.searchParams.get("state") ?? "",
    iss: issuer,
  });
  return send(`${new URL(reverifyCallback).pathname}?${query}`, {
    headers: { cookie: `${session}; ${pending}` },
  });
}

test("fresh same-identity verification revokes every old session and a later sign-in retains the workspace", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "reverify@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  const unrelated = cookie(
    await authenticate({ ...account, sub: crypto.randomUUID() }),
    "__Host-openbot-personal=",
  );
  await enter(first);
  await enter(unrelated);
  const original = await workspace(second);
  const nativeHeaders = await Promise.all(
    (["ios", "android", "desktop"] as const).map((client) =>
      nativeSessionHeaders(client, account),
    ),
  );
  for (const headers of nativeHeaders)
    expect(
      (await send("/api/workspace/conversations", { headers })).status,
    ).toBe(200);
  await withReplica(async (connect) => {
    const live = await Promise.all(
      [first, second, unrelated].map((session) =>
        connect(session).then(readSessionStream),
      ),
    );
    const [firstStream, secondStream, unrelatedStream] = live;
    if (!firstStream || !secondStream || !unrelatedStream)
      throw new Error("Missing session streams");
    const pending = await beginRevocation(first);
    // ID tokens use whole seconds. Advance beyond the challenge's second before authenticating.
    await Bun.sleep(1_000);
    const response = await finishRevocation(
      pending,
      first,
      account,
      Math.floor(Date.now() / 1_000),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(cookie(response, "__Host-openbot-personal=")).toBe(
      "__Host-openbot-personal=",
    );
    for (const session of [first, second]) {
      expect(
        (await send("/api/workspace", { headers: { cookie: session } })).status,
      ).toBe(401);
      expect((await connect(session)).status).toBe(401);
    }
    await Promise.all([
      expectRevoked(firstStream),
      expectRevoked(secondStream),
    ]);
    expect((await unrelatedStream.read()).done).toBe(false);
    await unrelatedStream.cancel();
  });
  for (const headers of nativeHeaders) {
    const response = await send("/api/workspace/conversations", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("OpenBot-Access-Ms")).toBeNull();
  }
  expect((await workspace(unrelated)).id).not.toBe(original.id);
  const next = cookie(await authenticate(account), "__Host-openbot-personal=");
  expect(await workspace(next)).toEqual(original);
});

test("failed re-verification preserves both existing sessions", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "reject-proof@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await enter(first);
  const original = await workspace(first);
  const foreignForm = await send("/auth/sign-out-all", {
    method: "POST",
    headers: { origin: "https://elsewhere.example", cookie: first },
  });
  expect(foreignForm.status).toBe(403);
  const stale = await beginRevocation(first);
  expect(
    (
      await finishRevocation(
        stale,
        first,
        account,
        Math.floor(Date.now() / 1_000) - 60,
      )
    ).status,
  ).toBe(403);
  const missing = await beginRevocation(first);
  expect(
    (await finishRevocation(missing, first, account, undefined)).status,
  ).toBe(403);
  const switched = await beginRevocation(first);
  const otherIdentity = await beginRevocation(first);
  await Bun.sleep(1_000);
  const authTime = Math.floor(Date.now() / 1_000);
  expect(
    (await finishRevocation(switched, second, account, authTime)).status,
  ).toBe(403);
  expect(
    (
      await finishRevocation(
        otherIdentity,
        first,
        { ...account, sub: crypto.randomUUID() },
        authTime,
      )
    ).status,
  ).toBe(403);
  expect(await workspace(first)).toEqual(original);
  expect(await workspace(second)).toEqual(original);
});

test("a pending all-device request cannot revoke a sibling after its initiating session signs out", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "race-proof@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await enter(first);
  const original = await workspace(second);
  const pending = await beginRevocation(first);
  const enteredProvider = Promise.withResolvers<void>();
  const resumeProvider = Promise.withResolvers<void>();
  const proofAccount = { ...account };
  introspectionGates.set(proofAccount, () => {
    enteredProvider.resolve();
    return resumeProvider.promise;
  });
  await Bun.sleep(1_000);
  const callbackResponse = finishRevocation(
    pending,
    first,
    proofAccount,
    Math.floor(Date.now() / 1_000),
  );
  try {
    await Promise.race([
      enteredProvider.promise,
      callbackResponse.then(() => {
        throw new Error("The callback did not reach Casdoor introspection");
      }),
    ]);
    expect((await signOut(first)).status).toBe(303);
  } finally {
    resumeProvider.resolve();
  }
  expect((await callbackResponse).status).toBe(403);
  expect(await workspace(second)).toEqual(original);
});

test("durable background work keeps its lease and queued work remains claimable through both types of sign-out", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "background-work@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await enter(first);
  const { id: workspaceId } = await workspace(first);
  const queue = createWorkQueue(database);
  const kind = `test.personal-session.${crypto.randomUUID()}`;
  const worker = { kind, owner: "worker", leaseMs: 30_000 };
  try {
    expect(
      await queue.offer({ kind, key: "in-flight", payload: { workspaceId } }),
    ).toBe("queued");
    expect(await queue.claim(worker)).toMatchObject([
      { key: "in-flight", payload: { workspaceId } },
    ]);
    expect(
      await queue.offer({ kind, key: "waiting", payload: { workspaceId } }),
    ).toBe("queued");
    expect((await signOut(first)).status).toBe(303);
    expect(await queue.renew({ ...worker, key: "in-flight" })).toBe(true);
    const pending = await beginRevocation(second);
    await Bun.sleep(1_000);
    expect(
      (
        await finishRevocation(
          pending,
          second,
          account,
          Math.floor(Date.now() / 1_000),
        )
      ).status,
    ).toBe(303);
    expect(
      (await send("/api/workspace", { headers: { cookie: second } })).status,
    ).toBe(401);
    expect(await queue.finish({ ...worker, key: "in-flight" })).toBe(true);
    expect(await queue.claim(worker)).toMatchObject([
      { key: "waiting", payload: { workspaceId } },
    ]);
    expect(await queue.finish({ ...worker, key: "waiting" })).toBe(true);
  } finally {
    await database.delete(workItems).where(eq(workItems.kind, kind));
  }
});

async function isolationOwner() {
  const account = {
    sub: crypto.randomUUID(),
    email: "isolation@example.com",
    verified: true,
    active: true,
  };
  const signedIn = await authenticate(account);
  expect(signedIn.status).toBe(303);
  const session = cookie(signedIn, "__Host-openbot-personal=");
  expect((await enter(session)).status).toBe(303);
  const own = await workspace(session);
  return {
    account,
    session,
    workspaceId: own.id,
    botId: own.personalAssistant.id,
  };
}

function botPath(workspaceId: string, botId: string) {
  return `/api/workspaces/${workspaceId}/bots/${botId}`;
}

test("an owner can read and rename their Assistant while swapped workspace and Bot IDs return the same result as missing IDs", async () => {
  const alice = await isolationOwner();
  const bob = await isolationOwner();
  const own = botPath(alice.workspaceId, alice.botId);
  const get = (path: string, session = alice.session) =>
    send(path, { headers: { cookie: session } });
  const rename = (
    path: string,
    session = alice.session,
    requestOrigin = origin,
  ) =>
    send(`${path}/name`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: requestOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Alice's Assistant" }),
    });
  expect(await (await get(own)).json()).toEqual({
    id: alice.botId,
    name: "Personal Assistant",
  });
  const missing = botPath(alice.workspaceId, "agent_missing");
  for (const path of [
    botPath(bob.workspaceId, bob.botId),
    botPath(alice.workspaceId, bob.botId),
    botPath(bob.workspaceId, alice.botId),
    missing,
  ]) {
    const read = await get(path);
    const change = await rename(path);
    expect(read.status).toBe(404);
    expect(change.status).toBe(404);
    expect(await read.json()).toEqual(await (await get(missing)).json());
    expect(read.headers.get("cache-control")).toBe("no-store");
  }
  expect((await get(own, "")).status).toBe(401);
  expect(
    (await rename(own, alice.session, "https://other.example")).status,
  ).toBe(403);
  const changed = await rename(own);
  expect(changed.status).toBe(200);
  expect(changed.headers.get("cache-control")).toBe("no-store");
  expect(await (await get(own)).json()).toEqual({
    id: alice.botId,
    name: "Alice's Assistant",
  });
  expect((await workspace(alice.session)).personalAssistant.name).toBe(
    "Alice's Assistant",
  );
  expect(
    await (await get(botPath(bob.workspaceId, bob.botId), bob.session)).json(),
  ).toEqual({ id: bob.botId, name: "Personal Assistant" });
});

test("background and integration entry points require the exact owned workspace, Bot and bound action", async () => {
  const alice = await isolationOwner();
  const bob = await isolationOwner();
  const owned = { workspaceId: alice.workspaceId, botId: alice.botId };
  const other = { workspaceId: bob.workspaceId, botId: bob.botId };
  const signedInAccountId = async (account: Account) => {
    // Background jobs carry the stable account id from trusted enqueue provenance.
    const { personalSaasAccounts } = await import(
      "../src/db/schema/personal-saas"
    );
    const { and, eq } = await import("drizzle-orm");
    const [row] = await database
      .select({ id: personalSaasAccounts.id })
      .from(personalSaasAccounts)
      .where(
        and(
          eq(personalSaasAccounts.issuer, issuer),
          eq(personalSaasAccounts.subject, account.sub),
        ),
      );
    if (!row) throw new Error("Missing fixture account");
    return row.id;
  };
  const accountId = await signedInAccountId(alice.account);
  const bobId = await signedInAccountId(bob.account);
  const bots = workspaceBots(database);
  const grants = workspaceIntegrationGrants(database);
  expect(await bots.get({ ...owned, accountId })).toEqual({
    id: alice.botId,
    name: "Personal Assistant",
  });
  expect(await bots.get({ ...other, accountId })).toBeUndefined();
  expect(
    await bots.rename({ ...owned, accountId: bobId, name: "Cross-owner" }),
  ).toBeUndefined();
  const expiresAt = new Date(Date.now() + 60_000);
  expect(
    await grants.issueAssistantRead({ ...other, accountId, expiresAt }),
  ).toBeUndefined();
  expect(
    await grants.issueAssistantRead({
      ...owned,
      accountId,
      expiresAt: new Date(0),
    }),
  ).toBeUndefined();
  const grant = await grants.issueAssistantRead({
    ...owned,
    accountId,
    expiresAt,
  });
  if (!grant) throw new Error("Owner could not issue Assistant read grant");
  const { credential } = grant;
  const dispatch = workspaceIntegrationGrants(database);
  expect(
    await dispatch.execute({ ...owned, credential, action: "assistant.read" }),
  ).toEqual({ id: alice.botId, name: "Personal Assistant" });
  for (const input of [
    { ...other, credential, action: "assistant.read" },
    { ...owned, botId: bob.botId, credential, action: "assistant.read" },
    {
      ...owned,
      workspaceId: bob.workspaceId,
      credential,
      action: "assistant.read",
    },
    { ...owned, credential, action: "assistant.rename" },
    { ...owned, credential, action: "conversation.history" },
    {
      ...owned,
      credential: credential.replace(/^./, (first) =>
        first === "A" ? "B" : "A",
      ),
      action: "assistant.read",
    },
  ]) {
    expect(await dispatch.execute(input)).toBeUndefined();
  }
  const replay = await send(botPath(alice.workspaceId, alice.botId), {
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(replay.status).toBe(401);
  for (const workspace of [owned, other]) {
    const query = new URLSearchParams(workspace);
    const history = await send(`/api/workspace/conversations?${query}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(history.status).toBe(401);
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(await history.json()).toEqual({ error: "sign_in_required" });
  }
});

const closedWorkspaceSurfaces = [
  ["Bot execution", "/api/copilotkit", "POST"],
  ["Conversation", "/api/delivery/conversations/:resource/history", "GET"],
  [
    "Conversation mutation",
    "/api/delivery/conversations/:resource/messages",
    "POST",
  ],
  ["Connection listing", "/api/plugins/connections", "GET"],
  ["Connection operation", "/api/plugins/servers/:resource/connect", "POST"],
  ["Computer control", "/api/computers/:bot/control/request", "POST"],
  [
    "Computer download",
    "/api/computers/:bot/files/download?path=report.txt",
    "GET",
  ],
  ["Attachment download", "/api/attachments/:resource", "GET"],
  ["Attachment cached download", "/api/attachments/:resource", "HEAD"],
  ["Personal Memory", "/api/memory?botId=:bot", "GET"],
  ["Visible log", "/api/agents/:bot/activity", "GET"],
  ["Search index", "/api/search?workspaceId=:workspace&q=:resource", "GET"],
  ["Invitation", "/api/workspaces/:workspace/invitations", "POST"],
  ["Co-owner", "/api/workspaces/:workspace/members", "POST"],
  ["Public share", "/api/workspaces/:workspace/shares", "POST"],
  [
    "Realtime Conversation",
    "/api/channels/events?workspaceId=:workspace",
    "UPGRADE",
  ],
  ["Realtime Computer", "/api/computers/:resource/stream", "UPGRADE"],
] as const;

test("two-owner isolation matrix for enabled and closed trial surfaces", async () => {
  const owners = await Promise.all([isolationOwner(), isolationOwner()]);
  const resourceIds = [crypto.randomUUID(), crypto.randomUUID()];
  await assertWorkspaceIsolation({
    state: "enabled",
    async request(viewer, subject) {
      const { workspaceId, botId } = owners[subject];
      return send(botPath(workspaceId, botId), {
        headers: { cookie: owners[viewer].session, "if-none-match": "*" },
      });
    },
    async assertOwned(response, owner) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: owners[owner].botId,
        name: "Personal Assistant",
      });
    },
    missing: async (viewer) =>
      send(botPath(owners[viewer].workspaceId, "agent_missing"), {
        headers: { cookie: owners[viewer].session, "if-none-match": "*" },
      }),
  });
  for (const [surface, template, method] of closedWorkspaceSurfaces) {
    await assertWorkspaceIsolation({
      state: "closed",
      async request(viewer, subject) {
        const { workspaceId, botId } = owners[subject];
        const response = await send(
          template
            .replace(":workspace", workspaceId)
            .replace(":bot", botId)
            .replace(":resource", resourceIds[subject] ?? ""),
          {
            method: method === "UPGRADE" ? "GET" : method,
            headers: {
              cookie: owners[viewer].session,
              origin,
              "if-none-match": "*",
              ...(method === "UPGRADE"
                ? {
                    connection: "Upgrade",
                    upgrade: "websocket",
                    "sec-websocket-version": "13",
                    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                  }
                : {}),
            },
          },
        );
        expect(response.status, surface).toBe(404);
        return response;
      },
    });
  }
});

test("support content requires the owner's approval for the exact operator, ticket, workspace and resource", async () => {
  const signIn = async (sub: string) =>
    cookie(
      await authenticate({
        sub,
        email: "verified@example.com",
        verified: true,
        active: true,
      }),
      "__Host-openbot-personal=",
    );
  const owner = await signIn(crypto.randomUUID());
  const otherOwner = await signIn(crypto.randomUUID());
  const operator = await signIn(supportSubject);
  const otherOperator = await signIn(otherSupportSubject);
  await enter(owner);
  await enter(otherOwner);
  const own = await workspace(owner);
  const other = await workspace(otherOwner);
  const resourceId = crypto.randomUUID();
  await database.insert(channels).values({
    id: resourceId,
    name: "Private conversation",
    description: "",
    lastMessage: "protected conversation content",
  });
  await database
    .insert(channelAgents)
    .values({ channelId: resourceId, agentId: own.personalAssistant.id });
  const fileId = crypto.randomUUID();
  const uploaderId = crypto.randomUUID();
  await database.insert(users).values({
    id: uploaderId,
    name: "Fixture uploader",
    email: `${uploaderId}@example.com`,
  });
  await database.insert(attachments).values({
    id: fileId,
    channelId: resourceId,
    uploadedBy: uploaderId,
    attachedAt: new Date(),
    name: "private.txt",
    mimeType: "text/plain",
    sizeBytes: 6,
    bytes: Buffer.from("secret"),
  });
  const computerSession = crypto.randomUUID();
  await database.insert(computerSnapshot).values({
    computerId: seatText(botSeat(own.personalAssistant.id)),
    session: computerSession,
    snapshotId: 1,
    url: "https://private.example/",
    elements: {},
  });
  const supportPath = `/api/support/workspaces/${own.id}`;
  const ownerPath = `/api/workspaces/${own.id}/support-requests`;
  const api = (path: string, session: string, body?: object) =>
    send(path, {
      method: body ? "POST" : "GET",
      headers: { cookie: session, origin, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  const metadata = await api(`${supportPath}/metadata`, operator);
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    status: "ready",
    usage: expect.any(Object),
    errorIds: expect.any(Array),
  });
  expect((await api(`${supportPath}/metadata`, otherOwner)).status).toBe(403);
  expect((await api(ownerPath, operator)).status).toBe(404);
  expect((await api(`${supportPath}/metadata`, "")).status).toBe(401);
  const ticketId = "CASE-67";
  const resource = { kind: "conversation", id: resourceId };
  const file = { kind: "file", id: fileId };
  const computer = { kind: "computer-session", id: computerSession };
  const draft = {
    resources: [resource, file, computer],
    durationSeconds: 60,
    reason: "Investigate reported delivery failure",
  };
  const request = await api(
    `${supportPath}/tickets/${ticketId}/requests`,
    operator,
    draft,
  );
  expect(request.status).toBe(201);
  const { id } = await request.json();
  const readPath = `${supportPath}/tickets/${ticketId}/requests/${id}/read`;
  const read = { resource, reason: "Confirm last conversation update" };
  expect((await api(readPath, operator, read)).status).toBe(404);
  expect((await api(ownerPath, otherOwner)).status).toBe(404);
  expect(await (await api(ownerPath, owner)).json()).toMatchObject({
    requests: [{ id, ticketId, ...draft, approvedAt: null }],
    accesses: [],
  });
  expect((await api(`${ownerPath}/${id}/approve`, otherOwner, {})).status).toBe(
    404,
  );
  const ownerPage = await api(`${ownerPath}/view`, owner);
  expect(await ownerPage.text()).toContain("Approve access for ticket CASE-67");
  expect(
    (
      await send(`${ownerPath}/${id}/approve`, {
        method: "POST",
        headers: {
          cookie: owner,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(`${ownerPath}/${id}/approve`, {
        method: "POST",
        headers: {
          cookie: owner,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "",
      })
    ).status,
  ).toBe(303);
  expect((await api(readPath, otherOperator, read)).status).toBe(404);
  expect(
    (await api(readPath.replace(ticketId, "CASE-OTHER"), operator, read))
      .status,
  ).toBe(404);
  expect(
    (await api(readPath.replace(own.id, other.id), operator, read)).status,
  ).toBe(404);
  expect(
    (
      await api(readPath, operator, {
        ...read,
        resource: { ...resource, id: "outside-scope" },
      })
    ).status,
  ).toBe(404);
  const content = await api(readPath, operator, read);
  expect(content.status).toBe(200);
  expect(content.headers.get("cache-control")).toBe("no-store");
  expect(await content.json()).toMatchObject({
    preview: "protected conversation content",
  });
  expect(
    await (await api(readPath, operator, { ...read, resource: file })).json(),
  ).toEqual({
    name: "private.txt",
    mimeType: "text/plain",
    base64: "c2VjcmV0",
  });
  expect(
    await (
      await api(readPath, operator, { ...read, resource: computer })
    ).json(),
  ).toMatchObject({
    session: computerSession,
    url: "https://private.example/",
  });
  await database
    .update(computerSnapshot)
    .set({ session: crypto.randomUUID() })
    .where(
      eq(
        computerSnapshot.computerId,
        seatText(botSeat(own.personalAssistant.id)),
      ),
    );
  expect(
    (await api(readPath, operator, { ...read, resource: computer })).status,
  ).toBe(404);
  await database.insert(channelAgents).values({
    channelId: resourceId,
    agentId: other.personalAssistant.id,
  });
  expect((await api(readPath, operator, read)).status).toBe(404);
  expect(
    (await api(readPath, operator, { ...read, resource: file })).status,
  ).toBe(404);
  expect((await api(`${ownerPath}/${id}/revoke`, owner, {})).status).toBe(204);
  expect((await api(readPath, operator, read)).status).toBe(404);
  expect((await api(`${ownerPath}/${id}/approve`, owner, {})).status).toBe(404);
  expect(await (await api(ownerPath, owner)).json()).toMatchObject({
    requests: [{ id, revokedAt: expect.any(String) }],
    accesses: expect.arrayContaining(
      [resource, file, computer].map((resource) =>
        expect.objectContaining({
          requestId: id,
          actorSubject: supportSubject,
          reason: read.reason,
          resource,
        }),
      ),
    ),
  });

  const expiring = await api(
    `${supportPath}/tickets/${ticketId}/requests`,
    operator,
    {
      ...draft,
      durationSeconds: 1,
    },
  );
  const { id: expiringId } = await expiring.json();
  expect(
    (await api(`${ownerPath}/${expiringId}/approve`, owner, {})).status,
  ).toBe(204);
  await Bun.sleep(1100);
  expect(
    (await api(readPath.replace(id, expiringId), operator, read)).status,
  ).toBe(404);
  expect(
    (await api(`${ownerPath}/${expiringId}/approve`, owner, {})).status,
  ).toBe(404);
  const history = await (await api(ownerPath, owner)).json();
  expect(history.accesses).toHaveLength(3);
  expect(await (await api(`${ownerPath}/view`, owner)).text()).toContain(
    "Expired",
  );

  await database
    .delete(channelAgents)
    .where(eq(channelAgents.agentId, other.personalAssistant.id));
  const interrupted = await api(
    `${supportPath}/tickets/${ticketId}/requests`,
    operator,
    draft,
  );
  const { id: interruptedId } = await interrupted.json();
  expect(
    (await api(`${ownerPath}/${interruptedId}/approve`, owner, {})).status,
  ).toBe(204);
  const suspend = (action: string) =>
    send(`/api/operator/workspaces/${own.id}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, reason: "Trial review" }),
    });
  const interruptedPath = `/api/support/workspaces/${own.id}/tickets/${ticketId}/requests/${interruptedId}/read`;
  expect((await suspend("pause")).status).toBe(201);
  expect((await api(interruptedPath, operator, read)).status).toBe(404);
  expect((await suspend("resume")).status).toBe(201);
  expect((await api(interruptedPath, operator, read)).status).toBe(404);
}, 25000);
test("a short disablement revokes both sessions even after Casdoor recovers", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "brief@example.com",
    verified: true,
    active: true,
  };
  const first = cookie(await authenticate(account), "__Host-openbot-personal=");
  const second = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  const stream = await send("/api/auth/session/events", {
    headers: { cookie: second },
  });
  expect(stream.status).toBe(200);
  account.active = false;
  account.disablements = [{ id: crypto.randomUUID(), effectiveAt: now() - 1 }];
  account.active = true;
  expect(
    (await send("/api/workspace", { headers: { cookie: first } })).status,
  ).toBe(401);
  expect(await stream.text()).toContain("event: signed-out");
  expect(
    (await send("/api/workspace", { headers: { cookie: second } })).status,
  ).toBe(401);
  expect((await authenticate(account)).status).toBe(303);
});

test("a late active response cannot undo a recorded disablement across replicas", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "race@example.com",
    verified: true,
    active: true,
  };
  const session = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  const stored = await personalSaasStore(database).session(
    session.split("=")[1],
  );
  if (!stored) throw new Error("Expected an Application Session");
  const access = createAccountAccess(
    database,
    () => Promise.reject(new Error("offline")),
    now,
  );
  const permit = await access.decision(stored.accountId);
  if (permit.kind !== "active") throw new Error("Expected an execution grant");
  const grant = {
    accountId: stored.accountId,
    epoch: permit.epoch,
    expiresAt: permit.expiresAt,
  };

  const captured = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  snapshotGates.set(account, () => {
    captured.resolve();
    return release.promise;
  });
  const request = new Request(new URL("/api/workspace", origin), {
    headers: { cookie: session },
  });
  const pending = newApp().fetch(request.clone());
  try {
    await captured.promise;
    account.active = false;
    const effectiveAt = now();
    account.disablements = [{ id: crypto.randomUUID(), effectiveAt }];
    expect((await app.fetch(request)).status).toBe(401);
    expect(await access.verify(grant)).toEqual({
      kind: "denied",
      reason: "account_disabled",
      cutoffAt: effectiveAt + 60_000,
    });
    release.resolve();
    expect((await pending).status).toBe(401);
    expect((await access.verify(grant)).kind).toBe("denied");
    account.active = true;
    expect((await authenticate(account)).status).toBe(303);
    expect((await access.verify(grant)).kind).toBe("denied");
  } finally {
    release.resolve();
    await pending;
  }
});

test("an idle live stream closes at the established deadline during an account status outage", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "offline@example.com",
    verified: true,
    active: true,
  };
  const confirmedAt = Date.now();
  clockTime = confirmedAt;
  try {
    const session = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    const headers = { cookie: session };
    const response = await send("/api/auth/session/events", { headers });
    const reader = await readSessionStream(response);
    try {
      account.active = undefined;
      clockTime = confirmedAt + 60_000;
      const denial = await send("/api/workspace", { headers });
      expect(denial.status).toBe(503);
      expect(await denial.json()).toEqual({
        error: "account_status_unconfirmed",
        cutoffAt: confirmedAt + 60_000,
      });
      const decoder = new TextDecoder();
      let events = "";
      for (
        let chunk = await reader.read();
        !chunk.done;
        chunk = await reader.read()
      ) {
        events += decoder.decode(chunk.value, { stream: true });
      }
      expect(events).toContain("event: account-status-unconfirmed");
      account.active = true;
      expect((await send("/api/workspace", { headers })).status).toBe(202);
    } finally {
      await reader.cancel();
    }
  } finally {
    clockTime = undefined;
  }
});

test("only a suspension operator can pause one workspace and revoke all of its sessions", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "owner@example.com",
    verified: true,
    active: true,
  };
  const other = { ...owner, sub: crypto.randomUUID() };
  const first = cookie(await authenticate(owner), "__Host-openbot-personal=");
  const second = cookie(await authenticate(owner), "__Host-openbot-personal=");
  const unaffected = cookie(
    await authenticate(other),
    "__Host-openbot-personal=",
  );
  await enter(first);
  await enter(unaffected);
  const target = await workspace(first);
  const nativeHeaders = [];
  for (const client of ["ios", "android", "desktop"] as const) {
    const { start, ...proof } = await nativeAttempt(client);
    const finish = await completeBrowserLogin(start, owner);
    const code = new URL(finish.headers.get("location") ?? "").searchParams.get(
      "code",
    );
    const response = await exchangeNative({ ...proof, code });
    expect(response.status).toBe(200);
    const { token } = await response.json();
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await send("/api/workspace/conversations", { headers })).status,
    ).toBe(200);
    nativeHeaders.push(headers);
  }
  const persisted = await personalSaasStore(database).session(
    first.split("=")[1],
  );
  if (!persisted) throw new Error("Expected an Application Session");
  const accountAccess = createAccountAccess(
    database,
    () => Promise.reject(new Error("offline")),
    now,
  );
  const decision = await accountAccess.decision(persisted.accountId);
  if (decision.kind !== "active") throw new Error("Expected an active grant");
  const executionGrant = {
    accountId: persisted.accountId,
    epoch: decision.epoch,
    expiresAt: decision.expiresAt,
  };
  const grants = workspaceIntegrationGrants(database);
  const targetGrant = {
    accountId: persisted.accountId,
    workspaceId: target.id,
    botId: target.personalAssistant.id,
    expiresAt: new Date(now() + 60_000),
  };
  const issued = await grants.issueAssistantRead(targetGrant);
  if (!issued) throw new Error("Expected an Assistant credential");
  const readAssistant = {
    workspaceId: target.id,
    botId: target.personalAssistant.id,
    credential: issued.credential,
    action: "assistant.read",
  };
  expect(await grants.execute(readAssistant)).toBeDefined();
  const pause = (headers: Record<string, string>) =>
    send(`/api/operator/workspaces/${target.id}/suspension`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify({
        action: "pause",
        reason: "Contact support to review your workspace.",
      }),
    });
  expect((await pause({ cookie: first })).status).toBe(403);
  expect((await pause({ authorization: "Bearer wrong" })).status).toBe(403);
  const credential = { authorization: `Bearer ${operatorToken}` };
  expect(
    (await send("/api/workspace/conversations", { headers: credential }))
      .status,
  ).toBe(401);
  expect(
    (
      await send(botPath(target.id, target.personalAssistant.id), {
        headers: credential,
      })
    ).status,
  ).toBe(401);
  await withReplica(async (connect) => {
    const stream = await readSessionStream(await connect(second));
    try {
      const response = await pause(credential);
      expect(response.status).toBe(201);
      const { effectiveAt } = await response.json();
      expect(await accountAccess.verify(executionGrant)).toEqual({
        kind: "denied",
        reason: "workspace_paused",
        cutoffAt: Date.parse(effectiveAt),
      });
      expect(await grants.execute(readAssistant)).toBeUndefined();
      expect(await grants.issueAssistantRead(targetGrant)).toBeUndefined();
      await expectRevoked(stream);
      expect(now() - Date.parse(effectiveAt)).toBeLessThan(60_000);
    } finally {
      await stream.cancel();
    }
  });
  for (const session of [first, second])
    expect(
      (await send("/api/workspace", { headers: { cookie: session } })).status,
    ).toBe(401);
  for (const headers of nativeHeaders) {
    expect((await send("/api/workspace", { headers })).status).toBe(401);
    expect(
      (await send("/api/workspace/conversations", { headers })).status,
    ).toBe(401);
  }
  expect((await workspace(unaffected)).id).not.toBe(target.id);
});

test("fresh verification shows only the owner's public suspension details and resume requires sign-in", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "paused@example.com",
    verified: true,
    active: true,
  };
  const other = { ...owner, sub: crypto.randomUUID() };
  const session = cookie(await authenticate(owner), "__Host-openbot-personal=");
  await enter(session);
  const target = await workspace(session);
  const operate = (action: "pause" | "resume") =>
    send(`/api/operator/workspaces/${target.id}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action,
        reason: "Internal-only note",
        displayReason: "Contact us about your trial.",
      }),
    });
  const pause = await operate("pause");
  expect(pause.status).toBe(201);
  const { operationId } = await pause.json();
  const response = await authenticate(owner);
  expect(response.status).toBe(403);
  expect(
    response.headers
      .getSetCookie()
      .some((value) =>
        /^__Host-openbot-personal=[A-Za-z0-9_-]{43};/.test(value),
      ),
  ).toBe(false);
  const page = await response.text();
  expect(page).toContain("Contact us about your trial.");
  expect(page).toContain("support@example.com");
  expect(page).toContain(operationId);
  expect(page).not.toContain("Internal-only note");
  expect(page).not.toContain(target.id);
  expect((await authenticate(other)).status).toBe(303);
  expect((await operate("resume")).status).toBe(201);
  expect(
    (await send("/api/workspace", { headers: { cookie: session } })).status,
  ).toBe(401);
  owner.active = false;
  expect((await authenticate(owner)).status).toBe(403);
  owner.active = true;
  const fresh = cookie(await authenticate(owner), "__Host-openbot-personal=");
  expect((await workspace(fresh)).id).toBe(target.id);
});

test("native verified handoffs return only the signed-in owner's suspension status", async () => {
  const owner = await isolationOwner();
  const { start: oldStart, ...oldProof } = await nativeAttempt("desktop");
  const oldFinish = await completeBrowserLogin(oldStart, owner.account);
  const oldCode = new URL(
    oldFinish.headers.get("location") ?? "",
  ).searchParams.get("code");
  expect(oldCode).toBeTruthy();
  const operate = (action: "pause" | "resume") =>
    send(`/api/operator/workspaces/${owner.workspaceId}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action,
        reason: "Private operations note",
        displayReason: "Trial paused for review.",
      }),
    });
  const response = await operate("pause");
  expect(response.status).toBe(201);
  const { operationId } = await response.json();
  for (const client of ["ios", "android", "desktop"] as const) {
    const { start, ...proof } = await nativeAttempt(client);
    const finish = await completeBrowserLogin(start, owner.account);
    const link = new URL(finish.headers.get("location") ?? "");
    expect(link.search).not.toContain(operationId);
    const input = { ...proof, code: link.searchParams.get("code") };
    const status = await exchangeNative(input);
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({
      status: "paused",
      operationId,
      reason: "Trial paused for review.",
      supportEmail: "support@example.com",
    });
    expect((await exchangeNative(input)).status).toBe(400);
  }
  const other = await isolationOwner();
  const { start, ...proof } = await nativeAttempt("desktop");
  const finish = await completeBrowserLogin(start, other.account);
  const code = new URL(finish.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const result = await exchangeNative({ ...proof, code });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ token: expect.any(String) });
  expect((await operate("resume")).status).toBe(201);
  expect((await exchangeNative({ ...oldProof, code: oldCode })).status).toBe(
    400,
  );
});

test("web and native cloud reads expose only the remaining authorization during a status outage", async () => {
  const account: Account = {
    sub: crypto.randomUUID(),
    email: "client-lease@example.com",
    verified: true,
    active: true,
  };
  const issuedAt = Date.now();
  clockTime = issuedAt;
  try {
    const session = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    const otherSession = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    await enter(session);
    const page = await send("/workspace", { headers: { cookie: session } });
    const markup = await page.text();
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(markup).toContain('id="protected-workspace" hidden');
    const binding = markup.match(/data-workspace-view="([^"]+)"/)?.[1];
    if (!binding) throw new Error("Missing workspace view binding");

    const signedOutDevice = await nativeSessionHeaders("android", account);
    const native = await Promise.all(
      (["ios", "android", "desktop"] as const).map((client) =>
        nativeSessionHeaders(client, account),
      ),
    );
    expect(
      (
        await send("/auth/sign-out", {
          method: "POST",
          headers: signedOutDevice,
        })
      ).status,
    ).toBe(204);
    expect(
      (await send("/api/workspace/conversations", { headers: signedOutDevice }))
        .status,
    ).toBe(401);
    const checks = [
      {
        path: "/api/auth/session/access",
        headers: { cookie: session, "OpenBot-Workspace-View": binding },
        status: 204,
      },
      ...native.flatMap((headers) =>
        ["/api/workspace", "/api/workspace/conversations"].map((path) => ({
          path,
          headers,
          status: 200,
        })),
      ),
    ];
    const switched = await send("/api/auth/session/access", {
      headers: { cookie: otherSession, "OpenBot-Workspace-View": binding },
    });
    expect(switched.status).toBe(403);
    expect(switched.headers.get("OpenBot-Access-Ms")).toBeNull();

    account.active = undefined;
    clockTime = issuedAt + 59_000;
    for (const { path, headers, status } of checks) {
      const response = await send(path, { headers });
      expect(response.status).toBe(status);
      expect(response.headers.get("OpenBot-Access-Ms")).toBe("1000");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    clockTime = issuedAt + 60_000;
    for (const { path, headers } of checks) {
      const response = await send(path, { headers });
      expect(response.status).toBe(503);
      expect(response.headers.get("OpenBot-Access-Ms")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    account.active = true;
    for (const { path, headers, status } of checks) {
      const response = await send(path, { headers });
      // An old web document is tied to the expired epoch. The session can render a fresh document.
      expect(response.status).toBe(status === 204 ? 403 : status);
    }
    expect(
      (await send("/workspace", { headers: { cookie: session } })).status,
    ).toBe(200);

    account.active = false;
    account.disablements = [{ id: crypto.randomUUID(), effectiveAt: now() }];
    for (const { path, headers } of checks) {
      const response = await send(path, { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("OpenBot-Access-Ms")).toBeNull();
    }
  } finally {
    clockTime = undefined;
  }
});

test("managed Computer owner status and explicit start are scoped to the signed-in workspace", async () => {
  const priorApp = app;
  const starts: string[] = [];
  const renewed: string[] = [];
  const computers: Array<{ id: string; epoch: number }> = [];
  app = newApp(database, {
    supervisorUrl: "http://supervisor.example",
    supervisorToken: "fixture-supervisor-token",
    async fetch(input, init) {
      const req = new Request(input, init);
      const path = new URL(req.url).pathname;
      expect(req.headers.get("authorization")).toBe(
        "Bearer fixture-supervisor-token",
      );
      if (path === "/workspace-computers") return Response.json({ computers });
      if (req.method === "POST") {
        if (path.endsWith("/renew")) {
          renewed.push(path);
        } else {
          starts.push(path);
          const grant = (await req.json()) as { epoch: number };
          computers.push({ id: path.split("/")[2], epoch: grant.epoch });
        }
        return new Response(null, { status: 204 });
      }
      return Response.json({
        status: starts.includes(`${path}/start`) ? "running" : "not_started",
        address: "http://private-computer:4100",
      });
    },
  });
  try {
    const signIn = async () => {
      const response = await authenticate({
        sub: crypto.randomUUID(),
        email: "managed-computer@example.com",
        verified: true,
        active: true,
      });
      const session = cookie(response, "__Host-openbot-personal=");
      await enter(session);
      return { session, workspaceId: (await workspace(session)).id };
    };
    const owner = await signIn();
    const other = await signIn();
    const computer = "/api/workspace/computer";
    const headers = { cookie: owner.session, origin };
    expect((await send(computer)).status).toBe(401);
    expect(await (await send(computer, { headers })).json()).toEqual({
      status: "not_started",
    });
    expect(starts).toEqual([]);
    expect(
      (
        await send(`${computer}/start`, {
          method: "POST",
          headers: { cookie: owner.session },
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(`${computer}/start`, { method: "POST", headers })).status,
    ).toBe(202);
    expect(starts).toEqual([`/workspace-computers/${owner.workspaceId}/start`]);
    expect(await (await send(computer, { headers })).json()).toEqual({
      status: "running",
    });
    expect(
      await (
        await send(computer, { headers: { cookie: other.session } })
      ).json(),
    ).toEqual({ status: "not_started" });
    await app.renewWorkspaceComputers?.();
    expect(renewed).toEqual([
      `/workspace-computers/${owner.workspaceId}/renew`,
    ]);
    const paused = await send(
      `/api/operator/workspaces/${owner.workspaceId}/suspension`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "pause",
          reason: "Computer cutoff fixture",
        }),
      },
    );
    expect(paused.status).toBe(201);
    expect(
      (await send(`${computer}/start`, { method: "POST", headers })).status,
    ).toBe(401);
    expect(starts).toHaveLength(1);
    await app.renewWorkspaceComputers?.();
    expect(renewed).toHaveLength(1);
  } finally {
    app = priorApp;
  }
});

test("only the current workspace owner can create and download an export", async () => {
  const owner = await isolationOwner();
  const other = await isolationOwner();
  const path = `/api/workspaces/${owner.workspaceId}/exports`;
  const create = (session: string) =>
    send(path, { method: "POST", headers: { cookie: session, origin } });

  expect((await create(other.session)).status).toBe(404);
  const issued = await create(owner.session);
  expect(issued.status).toBe(201);
  const { downloadUrl, expiresAt } = await issued.json();
  const otherUrl = downloadUrl.replace(owner.workspaceId, other.workspaceId);
  expect(
    (await send(otherUrl, { headers: { cookie: other.session } })).status,
  ).toBe(404);
  const tampered = downloadUrl.replace(
    /\.([\w-])/,
    (_: string, first: string) => (first === "A" ? ".B" : ".A"),
  );
  expect(
    (await send(tampered, { headers: { cookie: owner.session } })).status,
  ).toBe(404);
  expect((await send(downloadUrl)).status).toBe(401);
  expect(
    (await send(downloadUrl, { headers: { cookie: other.session } })).status,
  ).toBe(404);
  const download = await send(downloadUrl, {
    headers: { cookie: owner.session },
  });
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(await download.json()).toMatchObject({
    workspaceId: owner.workspaceId,
    bots: [{ id: owner.botId, name: "Personal Assistant" }],
    conversations: [],
    attachments: [],
    personalMemory: [],
    routines: [],
    connections: [],
  });
  try {
    clockTime = Date.parse(expiresAt);
    expect(
      (await send(downloadUrl, { headers: { cookie: owner.session } })).status,
    ).toBe(404);
    expect((await workspace(owner.session)).id).toBe(owner.workspaceId);
  } finally {
    clockTime = undefined;
  }
});

async function exportFixture(
  owner: Awaited<ReturnType<typeof isolationOwner>>,
  marker: string,
) {
  const principal = `personal-workspace:${owner.workspaceId}`;
  const channelId = crypto.randomUUID();
  const memoryId = crypto.randomUUID();
  const routineId = crypto.randomUUID();
  await database
    .insert(users)
    .values({ id: principal, email: `${channelId}@example.com` });
  await database
    .update(agents)
    .set({
      configuration: {
        systemPrompt: `${marker} prompt`,
        apiKey: "fixture-private-bot-key",
      },
    })
    .where(eq(agents.id, owner.botId));
  await database.insert(channels).values({
    id: channelId,
    name: `${marker} conversation`,
    description: "",
    opening: `${marker} opening`,
    lastMessage: `${marker} reply`,
  });
  await database
    .insert(channelAgents)
    .values({ channelId, agentId: owner.botId });
  const bytes = Buffer.from([0, 32, 127, 255]);
  await database.insert(attachments).values([
    {
      channelId,
      uploadedBy: principal,
      name: `${marker}.bin`,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.length,
      bytes,
      attachedAt: new Date(),
    },
    {
      channelId,
      uploadedBy: principal,
      name: "staged-private-file.bin",
      mimeType: "application/octet-stream",
      sizeBytes: bytes.length,
      bytes,
    },
  ]);
  await database.insert(personalMemories).values({
    id: memoryId,
    ownerUserId: principal,
    content: `${marker} memory`,
    provenance: "person",
  });
  await database.insert(routines).values({
    id: routineId,
    ownerUserId: principal,
    agentId: owner.botId,
    channelId,
    title: `${marker} routine`,
    instruction: "Read the briefing",
    cron: "0 9 * * *",
    nextRunAt: new Date(),
  });
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app: `${marker} calendar`,
    holder: "person",
    userId: principal,
    vendorUserId: "fixture-private-vendor-id",
    connectedBy: "fixture-private-authorization",
    verified: true,
  });
  return { channelId, memoryId, routineId, bytes };
}

test("concurrent workspace exports contain only their own readable resources", async () => {
  const alice = await isolationOwner();
  const bob = await isolationOwner();
  const cases = [
    { owner: alice, marker: "Alice fixture" },
    { owner: bob, marker: "Bob fixture" },
  ];
  const fixtures = await Promise.all(
    cases.map(({ owner, marker }) => exportFixture(owner, marker)),
  );

  // A channel shared by the two assistants is outside both workspace scopes.
  const sharedId = crypto.randomUUID();
  await database
    .insert(channels)
    .values({ id: sharedId, name: "shared-private-channel", description: "" });
  await database
    .insert(channelAgents)
    .values(
      cases.map(({ owner }) => ({ channelId: sharedId, agentId: owner.botId })),
    );

  await Promise.all(
    cases.map(async ({ owner, marker }, index) => {
      const path = `/api/workspaces/${owner.workspaceId}/exports`;
      const page = await send("/workspace", {
        headers: { cookie: owner.session },
      });
      expect(await page.text()).toContain(`action="${path}"`);
      const issued = await send(path, {
        method: "POST",
        headers: { cookie: owner.session, origin, accept: "text/html" },
      });
      expect(issued.status).toBe(303);
      const link = issued.headers.get("location") ?? "";
      const foreign = await send(link, {
        headers: { cookie: cases[1 - index].owner.session },
      });
      expect(foreign.status).toBe(404);
      const download = await send(issued.headers.get("location") ?? "", {
        headers: { cookie: owner.session },
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("cache-control")).toBe("no-store");
      const json = await download.text();
      expect(json).not.toContain("fixture-private-");
      expect(json).not.toContain("staged-private-file.bin");
      expect(json).not.toContain("shared-private-channel");
      expect(json).not.toContain(cases[1 - index].marker);
      const { channelId, memoryId, routineId, bytes } = fixtures[index];
      expect(JSON.parse(json)).toMatchObject({
        workspaceId: owner.workspaceId,
        bots: [
          {
            id: owner.botId,
            configuration: { systemPrompt: `${marker} prompt` },
          },
        ],
        conversations: [
          {
            id: channelId,
            opening: `${marker} opening`,
            preview: `${marker} reply`,
          },
        ],
        attachments: [
          {
            conversationId: channelId,
            name: `${marker}.bin`,
            contentBase64: bytes.toString("base64"),
          },
        ],
        personalMemory: [{ id: memoryId, content: `${marker} memory` }],
        routines: [
          {
            id: routineId,
            title: `${marker} routine`,
            conversationId: channelId,
          },
        ],
        connections: [
          { service: "composio", name: `${marker} calendar`, verified: true },
        ],
      });
    }),
  );
});

test("the workspace shows owner-scoped invalidated approval history after access returns", async () => {
  const owner = await isolationOwner();
  const other = await isolationOwner();
  const [account] = await database
    .select({ id: personalSaasAccounts.id })
    .from(personalSaasAccounts)
    .where(eq(personalSaasAccounts.subject, owner.account.sub));
  if (!account) throw new Error("Personal account missing");
  await database
    .insert(users)
    .values({ id: account.id, email: `${account.id}@example.test` });
  const approval = await createApprovalStore(database).open(
    approvalAction({
      actorId: account.id,
      botId: owner.botId,
      toolRef: "computer_write_file",
      scope: "notes",
      effect: "write",
      target: { filePath: "notes.txt" },
      args: { path: "notes.txt" },
      continuation: {
        runId: crypto.randomUUID(),
        threadId: crypto.randomUUID(),
        toolCallId: crypto.randomUUID(),
        toolName: "computer_write_file",
        args: { path: "notes.txt" },
        messages: [],
        state: {},
        context: [],
        forwardedProps: {},
      },
    }),
  );
  const operate = (action: "pause" | "resume") =>
    send(`/api/operator/workspaces/${owner.workspaceId}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, reason: "Test approval cutoff" }),
    });
  const history = (session: string) =>
    send("/api/workspace/approvals", { headers: { cookie: session } });
  expect((await operate("pause")).status).toBe(201);
  expect((await history(owner.session)).status).toBe(403);
  expect((await operate("resume")).status).toBe(201);
  // New sign-in evidence must be strictly later than the resume operation.
  await Bun.sleep(2);
  const session = cookie(
    await authenticate(owner.account),
    "__Host-openbot-personal=",
  );
  expect(await (await history(session)).json()).toMatchObject({
    requests: [
      { id: approval.id, tool: "computer_write_file", invalidated: true },
    ],
  });
  expect(await (await history(other.session)).json()).toEqual({ requests: [] });
  const page = await send("/workspace", { headers: { cookie: session } });
  expect(await page.text()).toContain("computer_write_file · Invalidated");
});

test("workspace suspension blocks export creation and download and invalidates earlier links", async () => {
  const owner = await isolationOwner();
  const other = await isolationOwner();
  const path = `/api/workspaces/${owner.workspaceId}/exports`;
  const create = (session: string, target = path) =>
    send(target, { method: "POST", headers: { cookie: session, origin } });
  const issued = await create(owner.session);
  expect(issued.status).toBe(201);
  const { downloadUrl } = await issued.json();
  const operate = (action: "pause" | "resume") =>
    send(`/api/operator/workspaces/${owner.workspaceId}/suspension`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, reason: "Test export suspension" }),
    });
  expect((await operate("pause")).status).toBe(201);
  expect((await create(owner.session)).status).toBe(401);
  expect(
    (await send(downloadUrl, { headers: { cookie: owner.session } })).status,
  ).toBe(401);
  expect(
    (
      await create(
        other.session,
        `/api/workspaces/${other.workspaceId}/exports`,
      )
    ).status,
  ).toBe(201);
  expect((await operate("resume")).status).toBe(201);
  await Bun.sleep(2);
  const signedIn = await authenticate(owner.account);
  const newSession = cookie(signedIn, "__Host-openbot-personal=");
  const reissued = await create(newSession);
  expect(reissued.status).toBe(201);
  const fresh = await reissued.json();
  expect(
    (await send(fresh.downloadUrl, { headers: { cookie: newSession } })).status,
  ).toBe(200);
  expect(
    (await send(downloadUrl, { headers: { cookie: newSession } })).status,
  ).toBe(404);
});

for (const reason of [
  "workspace_paused",
  "account_disabled",
  "account_status_unconfirmed",
] as const) {
  test(`Bot worker stops and shows individually recoverable work after ${reason}`, async () => {
    const account: Account = {
      sub: crypto.randomUUID(),
      email: "work-cutoff@example.com",
      verified: true,
      active: true,
    };
    const signedIn = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    const otherSession = cookie(
      await authenticate(account),
      "__Host-openbot-personal=",
    );
    await enter(signedIn);
    const target = await workspace(signedIn);
    const started = Promise.withResolvers<string>();
    const calls: string[] = [];
    const runApp = newApp(
      database,
      async ({ routineId, signal, onText, beforeDispatch }) => {
        await beforeDispatch?.();
        calls.push(routineId);
        if (calls.length > 1) return { replyText: "New run completed" };
        onText?.("Partial reply");
        started.resolve(routineId);
        if (!signal?.aborted) {
          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        signal?.throwIfAborted();
        return { replyText: "" };
      },
    );
    const request = (path: string, session: string, body?: object) =>
      runApp.fetch(
        new Request(new URL(path, origin), {
          method: body ? "POST" : "GET",
          headers: {
            origin,
            cookie: session,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const queueRun = (instruction: string) =>
      request("/api/workspace/bot-runs", signedIn, {
        workspaceId: target.id,
        botId: target.personalAssistant.id,
        instruction,
      });
    const operate = (action: "pause" | "resume") =>
      send(`/api/operator/workspaces/${target.id}/suspension`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, reason: "Test suspension" }),
      });
    const first = await queueRun("Already running");
    expect(first.status).toBe(202);
    const { runId } = await first.json();
    const swept = runApp.sweepBotWork();
    try {
      expect(
        await Promise.race([started.promise, swept.then(() => null)]),
      ).toBe(runId);
      expect((await queueRun("Still queued")).status).toBe(202);
      expect((await signOut(signedIn)).status).toBe(303);
      expect(
        await Promise.race([swept, Bun.sleep(80).then(() => "still running")]),
      ).toBe("still running");
      const stored = await personalSaasStore(database).session(
        otherSession.split("=")[1],
      );
      if (!stored) throw new Error("Expected a live session");
      if (reason === "workspace_paused") {
        expect((await operate("pause")).status).toBe(201);
      } else if (reason === "account_disabled") {
        account.disablements = [
          { id: crypto.randomUUID(), effectiveAt: now() - 1 },
        ];
        // The current state is already active, but the brief disablement still invalidates work.
        await app.refreshAccounts();
      } else {
        account.active = undefined;
        clockTime = now() + 60_001;
      }
      expect(await swept).toBe(true);
      expect(await runApp.sweepBotWork()).toBe(false);
      const queue = createWorkQueue(database, now);
      if (reason !== "account_disabled")
        expect(
          await queue.offer({
            kind: PERSONAL_BOT_WORK,
            key: crypto.randomUUID(),
            accountId: stored.accountId,
          }),
        ).toBe("refused");
      if (reason === "workspace_paused")
        expect((await operate("resume")).status).toBe(201);
      account.active = true;
      const restored =
        reason === "account_status_unconfirmed"
          ? otherSession
          : cookie(await authenticate(account), "__Host-openbot-personal=");
      const state = await request("/api/workspace", restored);
      expect(state.status).toBe(200);
      const { recovery } = await state.json();
      expect(recovery).toHaveLength(2);
      const [active, queued] = recovery;
      expect(active).toMatchObject({
        key: runId,
        reason,
        output: "Partial reply",
        outcomeUnknown: true,
        endedAt: expect.any(Number),
      });
      expect(queued).toMatchObject({
        reason,
        outcomeUnknown: false,
        instruction: "Still queued",
      });
      expect(await (await request("/workspace", restored)).text()).toContain(
        "Check any external actions before retrying",
      );
      const resolve = (
        key: string,
        action: "cancel" | "retry",
        acknowledged = false,
      ) =>
        request(`/api/workspace/recovery/${key}`, restored, {
          action,
          acknowledged,
        });
      expect((await resolve(runId, "retry")).status).toBe(409);
      const concurrent = await Promise.all([
        resolve(runId, "retry", true),
        resolve(runId, "retry", true),
      ]);
      const retries = await Promise.all(
        concurrent.map((response) => response.json()),
      );
      expect(retries[0]).toEqual(retries[1]);
      expect(retries[0].key).not.toBe(runId);
      expect(await (await resolve(queued.key, "cancel")).json()).toEqual({
        action: "cancel",
      });
      expect(await runApp.sweepBotWork()).toBe(true);
      expect(calls).toEqual([runId, retries[0].key]);
      const newRun = await request(
        `/api/workspace/bot-runs/${retries[0].key}`,
        restored,
      );
      expect(await newRun.json()).toMatchObject({
        state: "completed",
        output: "New run completed",
      });
      const original = await request(
        `/api/workspace/bot-runs/${runId}`,
        restored,
      );
      expect(await original.json()).toMatchObject({
        state: "stopped",
        output: "Partial reply",
      });
    } finally {
      clockTime = undefined;
    }
  }, 30_000);
}

test("a running Bot aborts on its local grant deadline while its database check is blocked", async () => {
  const account = {
    sub: crypto.randomUUID(),
    email: "worker-offline@example.com",
    verified: true,
    active: true,
  };
  const session = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  await enter(session);
  const target = await workspace(session);
  const stored = await personalSaasStore(database).session(
    session.split("=")[1],
  );
  if (!stored?.status?.confirmedAt)
    throw new Error("Expected an account grant");
  const cutoff = stored.status.confirmedAt + 60_000;

  const running = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const runApp = newApp(database, async ({ signal }) => {
    running.resolve();
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    aborted.resolve();
    signal?.throwIfAborted();
    return { replyText: "" };
  });
  const queue = createWorkQueue(database, now);
  clockTime = cutoff - 2_500;
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let blocking: Promise<unknown> | undefined;
  try {
    const key = crypto.randomUUID();
    expect(
      await queue.offer({
        kind: PERSONAL_BOT_WORK,
        key,
        accountId: stored.accountId,
        payload: {
          workspaceId: target.id,
          botId: target.personalAssistant.id,
          instruction: "Wait for the cutoff",
        },
      }),
    ).toBe("queued");
    const sweep = runApp.sweepBotWork();
    await Promise.race([
      running.promise,
      sweep.then(() => {
        throw new Error("Bot did not start");
      }),
    ]);
    blocking = database.transaction(async (tx) => {
      await tx
        .select()
        .from(personalSaasAccounts)
        .where(eq(personalSaasAccounts.id, stored.accountId))
        .for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    expect(
      await Promise.race([
        aborted.promise.then(() => "aborted"),
        Bun.sleep(4_000).then(() => "still running"),
      ]),
    ).toBe("aborted");
    release.resolve();
    await blocking;
    expect(await sweep).toBe(true);
    expect(
      await queue.personalStatus(PERSONAL_BOT_WORK, stored.accountId, key),
    ).toMatchObject({
      state: "stopped",
      interruption: { cutoffAt: cutoff, reason: "account_status_unconfirmed" },
    });
  } finally {
    release.resolve();
    await blocking;
    clockTime = undefined;
  }
}, 15_000);

test("the Bot worker rejects Computer work authorized before a restart and dispatches a fresh manual retry", async () => {
  const session = cookie(
    await authenticate({
      sub: crypto.randomUUID(),
      email: "computer-work@example.com",
      verified: true,
      active: true,
    }),
    "__Host-openbot-personal=",
  );
  await enter(session);
  const target = await workspace(session);
  const dispatched: string[] = [];
  const taskTimes: number[] = [];
  let startedWith = Number.POSITIVE_INFINITY;
  const runApp = newApp(
    database,
    async ({ beforeDispatch, runId }) => {
      await beforeDispatch?.();
      if (!runId) throw new Error("Expected a persistent run ID");
      dispatched.push(runId);
      return { replyText: "Completed" };
    },
    {
      supervisorUrl: "http://supervisor.example",
      supervisorToken: "fixture-supervisor-token",
      async fetch(input) {
        const url = new URL(String(input));
        expect(url.pathname).toBe(`/workspace-computers/${target.id}`);
        expect(url.searchParams.has("epoch")).toBe(true);
        const authorizedAt = Number(url.searchParams.get("authorizedAt"));
        taskTimes.push(authorizedAt);
        return Response.json(
          authorizedAt >= startedWith
            ? {
                status: "running",
                address: "http://computer:4100",
                token: "fixture-computer",
              }
            : { status: "running" },
        );
      },
    },
  );
  const request = (path: string, body?: object) =>
    runApp.fetch(
      new Request(new URL(path, origin), {
        method: body ? "POST" : "GET",
        headers: {
          origin,
          cookie: session,
          "content-type": "application/json",
        },
        body: body && JSON.stringify(body),
      }),
    );

  const queued = await request("/api/workspace/bot-runs", {
    workspaceId: target.id,
    botId: target.personalAssistant.id,
    instruction: "Use the Computer",
    requiresComputer: true,
  });
  expect(queued.status).toBe(202);
  const { runId } = await queued.json();
  startedWith = Date.now();
  await Bun.sleep(15);
  expect(await runApp.sweepBotWork()).toBe(true);
  expect(dispatched).toEqual([]);
  expect(taskTimes).toHaveLength(1);
  expect(taskTimes[0]).toBeLessThan(startedWith);
  const stopped = await request(`/api/workspace/bot-runs/${runId}`);
  expect(await stopped.json()).toMatchObject({
    state: "stopped",
    interruption: { reason: "computer_unavailable", outcomeUnknown: false },
  });
  const retry = await request(`/api/workspace/recovery/${runId}`, {
    action: "retry",
  });
  expect(retry.status).toBe(200);
  const { key } = await retry.json();
  expect(key).not.toBe(runId);
  expect(await runApp.sweepBotWork()).toBe(true);
  expect(dispatched).toEqual([key]);
  expect(taskTimes[1]).toBeGreaterThanOrEqual(startedWith);
});
