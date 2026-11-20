import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { botSeat, seatText } from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import {
  attachments,
  channelAgents,
  channelMemberships,
  channels,
  computerSnapshot,
  users,
  workItems,
} from "../src/db/schema";
import { personalSaasNativeCodes } from "../src/db/schema/personal-saas";
import { createPersonalSaasApp } from "../src/personal-saas/app";
import { workspaceIntegrationGrants } from "../src/personal-saas/integration-grants";
import { personalSaasStore } from "../src/personal-saas/store";
import { workspaceBots } from "../src/personal-saas/workspace-bots";
import { createWorkQueue } from "../src/work/queue";
import { testDatabaseUrl } from "./support/database";
import { assertWorkspaceIsolation } from "./support/workspace-isolation";

const origin = "https://trial.openbot.example";
const supportSubject = crypto.randomUUID();
const otherSupportSubject = crypto.randomUUID();
const clientId = "openbot-trial";
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
const accessTokens = new Map<string, Account>();
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

function newApp(db = database) {
  return createPersonalSaasApp(
    {
      origin,
      supportSubjects: [supportSubject, otherSupportSubject],
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      casdoor: {
        issuer,
        discoveryUrl: new URL(
          "/.well-known/openid-configuration",
          provider.url,
        ),
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
  const session = cookie(
    await authenticate(account),
    "__Host-openbot-personal=",
  );
  account.active = undefined;
  expect((await enter(session)).status).toBe(503);
  account.active = true;
  expect(
    (await send("/api/workspace", { headers: { cookie: session } })).status,
  ).toBe(202);
  expect((await enter(session)).headers.get("location")).toBe("/workspace");
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

test("Web, iOS, and Android share the owner’s workspace and conversation history", async () => {
  const owner = {
    sub: crypto.randomUUID(),
    email: "mobile@example.com",
    active: true,
    verified: true,
  };
  const native = async (client: "ios" | "android") => {
    const { start, ...proof } = await nativeAttempt(client);
    const finish = await completeBrowserLogin(start, owner);
    expect(
      finish.headers
        .getSetCookie()
        .some((value) => value.startsWith("__Host-openbot-personal=")),
    ).toBe(false);
    const deepLink = new URL(finish.headers.get("location") ?? "");
    expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe(
      "openbotmobile://auth/personal-saas",
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
  const [web, ios, android] = await Promise.all([
    authenticate(owner).then((reply) =>
      cookie(reply, "__Host-openbot-personal="),
    ),
    native("ios"),
    native("android"),
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
  const preparing = await send("/api/workspace", { headers: ios });
  expect(preparing.status).toBe(202);
  const [webReady, iosReady, androidReady] = await Promise.all([
    enter(web),
    send("/workspace/prepare", { method: "POST", headers: ios }),
    send("/workspace/prepare", { method: "POST", headers: android }),
  ]);
  expect([webReady.status, iosReady.status, androidReady.status]).toEqual([
    303, 204, 204,
  ]);
  const expected = await workspace(web);
  for (const headers of [ios, android]) {
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
  for (const headers of [{ cookie: web }, ios, android]) {
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
  const sessions = personalSaasStore(database);
  const sharedToken = await sessions.signIn({
    issuer,
    subject: account.sub,
    email: account.email,
    encryptedAccessToken: "not used at the store boundary",
  });
  expect(await sessions.session(sharedToken)).toBeDefined();
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
  expect(await sessions.session(sharedToken)).toBeUndefined();
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
  [
    "Export download",
    "/api/workspaces/:workspace/exports/:resource/download",
    "GET",
  ],
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
}, 15000);
