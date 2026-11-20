import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditReader, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, githubPilotRepositories, users } from "../src/db/schema";
import { createGithubPilotProvider } from "../src/plugins/corsair/github";
import { createGithubPilotRoutes } from "../src/plugins/corsair/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

test("only the initiating workspace and Person can finish a single-use GitHub authorization", async () => {
  const person = randomUUID();
  await database
    .insert(users)
    .values({
      id: person,
      name: "Pilot Person",
      email: `${person}@example.test`,
    });
  const exchangeCodes: string[] = [];
  const challenges = new Map<string, string>();
  let now = new Date();
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === "https://github.com/login/oauth/access_token") {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        exchangeCodes.push(code);
        if (
          challenges.get(code) !==
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url")
        )
          return Response.json({ error: "bad_verification_code" });
        return Response.json({
          access_token: "ghu_fixture",
          token_type: "bearer",
          expires_in: 28800,
        });
      }
      if (
        request.url === "https://api.github.com/user" &&
        request.headers.get("Authorization") === "Bearer ghu_fixture"
      )
        return Response.json({ id: 12, login: "octocat" });
      throw new Error("Unexpected request in fixture");
    },
    { preconnect: fetch.preconnect },
  );
  const provider = createGithubPilotProvider(
    {
      appId: "9",
      clientId: "fixture",
      clientSecret: "fixture",
      redirectUri: "https://openbot.test/api/corsair/github/callback",
    },
    transport,
  );
  const deps = {
    database,
    provider,
    approvals: createApprovalStore(database),
    audit: createAuditStore(database),
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const workspace = randomUUID();
  const routes = (workspaceId: string) =>
    createGithubPilotRoutes({
      ...deps,
      workspaceId,
      registration: "fixture/9",
      clock: () => now,
      canUseBot: async () => true,
      requireUser: async (c, next) => {
        c.set("actor", {
          id: c.req.header("x-person") ?? person,
          email: "person@example.test",
          role: "user",
        });
        await next();
      },
    });
  try {
    const a = routes(workspace);
    const b = routes(randomUUID());
    async function start(code: string) {
      const response = await a.request("/connect", {
        method: "POST",
        headers: { "X-OpenBot-Pilot": "github" },
      });
      expect(response.status).toBe(201);
      const authorization = new URL((await response.json()).authorizationUrl);
      const challenge = authorization.searchParams.get("code_challenge");
      if (!challenge) throw new Error("Expected PKCE challenge");
      challenges.set(code, challenge);
      expect(authorization.searchParams.get("scope")).toBeNull();
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      return `/callback?code=${code}&state=${authorization.searchParams.get("state")}`;
    }
    const expired = await start("expired-code");
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await a.request(expired)).status).toBe(409);
    const first = await start("first-code");
    await start("second-code");
    expect(
      (await a.request(first.replace("first-code", "second-code"))).status,
    ).toBe(502);
    expect((await a.request(first)).status).toBe(409);
    const callback = await start("fixture-code");
    expect((await b.request(callback)).status).toBe(409);
    expect(
      (await a.request(callback, { headers: { "x-person": randomUUID() } }))
        .status,
    ).toBe(409);
    const results = await Promise.all([
      a.request(callback),
      a.request(callback),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await results.find((result) => result.ok)?.json()).toMatchObject({
      identity: { id: 12, login: "octocat" },
    });
    expect(exchangeCodes).toEqual(["second-code", "fixture-code"]);
    expect(
      (await (await a.request("/connections")).json()).connections,
    ).toHaveLength(1);
    expect(await (await b.request("/connections")).json()).toEqual({
      connections: [],
    });
  } finally {
    await database.delete(users).where(eq(users.id, person));
  }
});

test("a reviewed GitHub write needs a live Bot Grant, selected repository, matching personal Approval, and verified user access", async () => {
  const person = randomUUID();
  const bot = randomUUID();
  const workspaceId = randomUUID();
  const registration = "pilot/9";
  await database
    .insert(users)
    .values({
      id: person,
      name: "Pilot Admin",
      email: `${person}@example.test`,
    });
  await database
    .insert(agents)
    .values({
      id: bot,
      name: "Pilot Bot",
      type: "built_in",
      configuration: {},
    });
  let userCanAccess = true;
  let identity = 12;
  const writes: unknown[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.hostname === "github.com" &&
        url.pathname === "/login/oauth/access_token"
      )
        return Response.json({
          access_token: "ghu_fixture",
          token_type: "bearer",
          expires_in: 28800,
        });
      if (
        url.hostname !== "api.github.com" ||
        request.headers.get("Authorization") !== "Bearer ghu_fixture"
      )
        throw new Error("Unexpected request in fixture");
      if (url.pathname === "/user")
        return Response.json({ id: identity, login: "octocat" });
      if (url.pathname === "/user/installations")
        return Response.json({
          installations: [
            {
              id: 819,
              app_id: 9,
              suspended_at: null,
              permissions: { issues: "write" },
            },
          ],
        });
      if (url.pathname === "/user/installations/819/repositories")
        return Response.json({
          repositories: userCanAccess
            ? [
                {
                  id: 23,
                  node_id: "R_pilot",
                  name: "pilot",
                  owner: { login: "acme" },
                  has_issues: true,
                  archived: false,
                },
              ]
            : [],
        });
      if (url.pathname === "/graphql" && request.method === "POST") {
        const payload: unknown = await request.json();
        writes.push(payload);
        return Response.json({
          data: {
            createIssue: {
              issue: {
                databaseId: 901,
                number: 7,
                repository: { id: "R_pilot" },
                url: "https://github.com/acme/pilot/issues/7",
                author: { databaseId: 12, login: "octocat" },
              },
            },
          },
        });
      }
      throw new Error("Unexpected request in fixture");
    },
    { preconnect: fetch.preconnect },
  );
  const routes = createGithubPilotRoutes({
    workspaceId,
    registration,
    database,
    provider: createGithubPilotProvider(
      {
        appId: "9",
        clientId: "fixture",
        clientSecret: "fixture",
        redirectUri: "https://openbot.test/api/corsair/github/callback",
      },
      transport,
    ),
    approvals: createApprovalStore(database),
    audit: createAuditStore(database),
    encryptionKey: randomBytes(32).toString("base64"),
    canUseBot: async (_, id) => id === bot,
    requireUser: async (c, next) => {
      c.set("actor", {
        id: person,
        email: "admin@example.test",
        role: c.req.header("x-fixture-admin") ? "admin" : "user",
      });
      await next();
    },
  });
  const send = (path: string, value: unknown, method = "POST", admin = false) =>
    routes.request(path, {
      method,
      headers: {
        "X-OpenBot-Pilot": "github",
        "Content-Type": "application/json",
        ...(admin ? { "x-fixture-admin": "yes" } : {}),
      },
      body: JSON.stringify(value),
    });
  try {
    const start = await send("/connect", {});
    const { authorizationUrl } = await start.json();
    const state = new URL(authorizationUrl).searchParams.get("state");
    const { connectionId } = await (
      await routes.request(`/callback?code=github-code&state=${state}`)
    ).json();
    expect(
      (
        await send("/repositories", {
          connectionId,
          installationId: 819,
          repositoryId: 23,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          "/repositories",
          { connectionId, installationId: 819, repositoryId: 23 },
          "POST",
          true,
        )
      ).status,
    ).toBe(200);
    expect(await (await routes.request(`/bots/${bot}/tools`)).json()).toEqual({
      tools: [],
    });
    const args = {
      botId: bot,
      connectionId,
      repositoryId: 23,
      title: "Pilot evidence",
    };
    expect((await send("/approvals", args)).status).toBe(403);
    expect(
      (await send(`/bots/${bot}/grant`, { enabled: true }, "PUT", true)).status,
    ).toBe(200);
    expect(await (await routes.request(`/bots/${bot}/tools`)).json()).toEqual({
      tools: [
        {
          ref: "corsair/github.create_issue",
          effect: "write",
          identity: "github_app_user",
          resource: "registered_installation_repository",
          permissions: { issues: "write" },
        },
      ],
    });
    expect(
      (await send("/approvals", { ...args, repositoryId: 33 })).status,
    ).toBe(403);
    async function approval() {
      const opened = await send("/approvals", args);
      expect(opened.status).toBe(201);
      return (await opened.json()).id;
    }
    const denied = await approval();
    expect(
      (await send(`/approvals/${denied}/decision`, { decision: "deny" }))
        .status,
    ).toBe(200);
    expect((await send(`/approvals/${denied}/execute`, args)).status).toBe(409);
    const approved = await approval();
    expect(
      (
        await send(`/approvals/${approved}/decision`, {
          decision: "allow_always",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(`/approvals/${approved}/decision`, {
          decision: "allow_once",
        })
      ).status,
    ).toBe(200);
    const execute = (input: unknown = args) =>
      send(`/approvals/${approved}/execute`, input);
    expect((await execute({ ...args, title: "Changed title" })).status).toBe(
      409,
    );
    expect((await execute({ ...args, title: "Pilot evidence " })).status).toBe(
      409,
    );
    expect((await execute({ ...args, repositoryId: 33 })).status).toBe(403);
    expect(
      (await send(`/bots/${bot}/grant`, { enabled: false }, "PUT", true))
        .status,
    ).toBe(200);
    expect((await execute()).status).toBe(403);
    expect(
      (await send(`/bots/${bot}/grant`, { enabled: true }, "PUT", true)).status,
    ).toBe(200);
    userCanAccess = false;
    expect((await execute()).status).toBe(403);
    userCanAccess = true;
    identity = 99;
    expect((await execute()).status).toBe(403);
    identity = 12;
    expect(writes).toEqual([]);
    const race = await Promise.all([execute(), execute()]);
    expect(race.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await race.find((response) => response.ok)?.json()).toMatchObject({
      issue: { number: 7, user: { id: 12, login: "octocat" } },
    });
    expect(writes).toEqual([
      {
        query: expect.stringContaining("createIssue"),
        variables: {
          input: { repositoryId: "R_pilot", title: "Pilot evidence" },
        },
      },
    ]);
    const { events } = await createAuditReader(database).list({
      actorUserId: person,
      eventType: "corsair.github.write_succeeded",
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: "23",
      payload: {
        approvalId: approved,
        connectionId,
        githubUserId: "12",
        issueNumber: 7,
      },
    });
  } finally {
    await database
      .delete(githubPilotRepositories)
      .where(eq(githubPilotRepositories.workspaceId, workspaceId));
    await database.delete(agents).where(eq(agents.id, bot));
    await database.delete(users).where(eq(users.id, person));
  }
});
