import { afterAll, beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import { createPersonalSaasApp } from "../src/personal-saas/app";
import { testDatabaseUrl } from "./support/database";

const origin = "https://trial.openbot.example";
const clientId = "openbot-trial";
const clientSecret = "casdoor-test-secret";
const database = createDatabase(testDatabaseUrl(), { max: 4 });
const botProfiles = createAgentProfileStore(database, undefined);
const profileReader = { id: "saas53-test-reader", role: "admin" } as const;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const signingKey = await exportJWK(publicKey);
const issuer = "https://casdoor.example";
const callback = `${origin}/auth/casdoor/callback`;

type Account = {
  sub: string;
  email: string;
  verified?: boolean;
  active?: boolean;
};
const authorizeCodes = new Map<
  string,
  { account: Account; nonce: string; challenge: string }
>();
const accessTokens = new Map<string, Account>();
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
            form.get("redirect_uri") !== callback ||
            form.get("client_id") !== clientId ||
            form.get("client_secret") !== clientSecret ||
            new Bun.CryptoHasher("sha256")
              .update(String(form.get("code_verifier")))
              .digest("base64url") !== entry.challenge
          )
            return new Response(null, { status: 400 });
          const access = crypto.randomUUID();
          accessTokens.set(access, entry.account);
          const id = await new SignJWT({ nonce: entry.nonce })
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
  app = createPersonalSaasApp(
    {
      origin,
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
    database,
  );
});

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
  expect(await landing.text()).toContain("Personal Assistant");
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
