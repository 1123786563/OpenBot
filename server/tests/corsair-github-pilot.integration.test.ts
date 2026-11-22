import { mintRunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createApprovalService } from "../src/approvals/service";
import { withApprovalContext } from "../src/approvals/types";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createPluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";
import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditReader, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  agentProfiles,
  corsairAccounts,
  brokeredAccounts,
  brokeredConnections,
  mcpServers,
  mcpTools,
  githubPilotRepositories,
  users,
} from "../src/db/schema";
import { createGithubPilotProvider } from "../src/plugins/corsair/github";
import { createGithubPilotRoutes } from "../src/plugins/corsair/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { forgetWorkItemsOf } from "./support/work-items";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
/** Everyone this file creates, so the Approvals they leave are forgotten with them. */
const people: string[] = [];
afterAll(async () => {
  try {
    await forgetWorkItemsOf(database, ...people);
  } finally {
    await database.$client.close();
  }
});

test("only the initiating workspace and Person can finish a single-use GitHub authorization", async () => {
  const person = randomUUID();
  people.push(person);
  await database.insert(users).values({
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
      if (request.url === "https://api.github.com/applications/fixture/token") {
        expect(request.method).toBe("DELETE");
        expect(await request.json()).toEqual({ access_token: "ghu_fixture" });
        return new Response(null, { status: 204 });
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
          role: c.req.header("x-admin") ? "admin" : "user",
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
      defaultConnectionId: null,
    });

    const listed = await (await a.request("/connections")).json();
    const connectionId = listed.connections[0].id;
    const path = `/connections/${connectionId}/revocation`;
    const headers = { "X-OpenBot-Pilot": "github" };
    expect((await b.request(path, { method: "DELETE", headers })).status).toBe(
      404,
    );
    const disconnected = await a.request(path, { method: "DELETE", headers });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({
      status: "pending",
      access: "provider",
      refresh: "unconfirmed",
    });
    expect(await (await a.request("/connections")).json()).toEqual({
      connections: [],
      defaultConnectionId: null,
    });
    const manual = {
      method: "PUT",
      body: JSON.stringify({
        capability: "refresh",
        evidenceRef: "provider-review/42",
      }),
    };
    expect(
      (await a.request(`${path}/evidence`, { ...manual, headers })).status,
    ).toBe(403);
    const confirmed = await a.request(`${path}/evidence`, {
      ...manual,
      headers: { ...headers, "x-admin": "true" },
    });
    expect(await confirmed.json()).toMatchObject({
      status: "revoked",
      access: "provider",
      refresh: "manual",
    });
    const [retired] = await database
      .select({ credential: corsairAccounts.credential })
      .from(corsairAccounts)
      .where(eq(corsairAccounts.id, connectionId));
    expect(retired?.credential).toBe("");
    const { events } = await createAuditReader(database).list({
      actorUserId: person,
      eventType: "corsair.authorization.revocation_checked",
      limit: 10,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        targetId: connectionId,
        payload: expect.objectContaining({
          access: "provider",
          refresh: "manual",
          evidenceRef: "provider-review/42",
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("ghu_fixture");
  } finally {
    await database.delete(users).where(eq(users.id, person));
  }
});

test("a reviewed GitHub write needs a live Bot Grant, selected repository, matching personal Approval, and verified user access", async () => {
  const person = randomUUID();
  people.push(person);
  const bot = randomUUID();
  const workspaceId = randomUUID();
  const registration = "pilot/9";
  await database.insert(users).values({
    id: person,
    name: "Pilot Admin",
    email: `${person}@example.test`,
  });
  await database.insert(agents).values({
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
  const deps = {
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
  };
  const routes = createGithubPilotRoutes({
    ...deps,
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
  const serverId = randomUUID();
  const normalBot = randomUUID();
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
    await database.insert(agents).values({
      id: normalBot,
      name: "Normal Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: normalBot,
      title: "Normal Bot",
      roleDescription: "",
      avatarSeed: normalBot,
      visibility: "public",
    });
    expect(
      (await send(`/bots/${bot}/grant`, { enabled: false }, "PUT", true))
        .status,
    ).toBe(200);
    const name = "GITHUB_CREATE_AN_ISSUE";
    const ref = `${serverId}/${name}`;
    const token = "fixture-corsair-agent-token";
    const config = loadConfig(
      testEnvironment({
        AGENT_TOOL_TOKEN: token,
        KEY_ENCRYPTION_KEY: deps.encryptionKey,
      }),
    );
    const approvals = createApprovalService(deps.approvals);
    const store = createPluginStore({
      database,
      deploymentId: workspaceId,
      brokerProvider: "composio",
      approvalGate: approvals.gate,
      auditStore: deps.audit,
      credentials: createCredentialStore(database),
      encryptionKey: deps.encryptionKey,
      policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      callVendor: async () => {
        throw new Error("Broker write must not run after cutover");
      },
    });
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Brokered GitHub",
      vendor: "GitHub",
      url: "composio://github",
      provenance: "composio",
      accountMode: "personal",
    });
    await database.insert(mcpTools).values({ serverId, name, effect: "write" });
    await store.grant("mcp", ref, normalBot, person);
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: "github",
      holder: "person",
      userId: person,
      vendorUserId: person,
      verified: true,
    });
    const appArgs: Parameters<typeof createApp> = [
      config,
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id: person, email: `${person}@example.test` },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
    ];
    appArgs[9] = createAgentProfileStore(database, undefined);
    appArgs[14] = store;
    appArgs[34] = {
      approvals,
      githubPilot: {
        ...deps,
        enforceCutover: true,
        legacyPolicy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
      },
      corsairReadiness: {
        database,
        workspaceId,
        includeDeploymentLegacy: true,
        registrations: { github: registration },
      },
    };
    const app = createApp(...appArgs);
    const migrationPath = "/api/corsair/migration/github";
    const migrate = (path: string, data: unknown) =>
      app.request(migrationPath + path, {
        method: "POST",
        headers: { "X-OpenBot-Pilot": "github" },
        body: JSON.stringify(data),
      });
    const { inventoryRevision } = await (
      await app.request(migrationPath)
    ).json();
    for (const [capability, targetId] of [
      [`tool:${ref}`, undefined],
      [`legacy-account:composio:${person}`, connectionId],
    ]) {
      expect(
        (
          await migrate("/decisions", {
            capability,
            decision: {
              kind: "verified",
              inventoryRevision,
              targetId,
              addedPermissions: [],
              checks: {
                identity: "fixture/identity",
                resourceScope: "fixture/repo",
                approval: "fixture/approval",
                event: "fixture/event",
                revocation: "fixture/revoke",
              },
            },
          })
        ).status,
      ).toBe(204);
    }
    const copied = await migrate("/policies", {
      legacyTool: ref,
      botId: normalBot,
      inventoryRevision,
      binding: { kind: "personal", connections: [connectionId] },
      resources: ["23"],
      evidence: {
        equivalentAppAndAction: "fixture/action",
        identityAndResources: "fixture/identity",
        preservedRestrictions: "fixture/restrictions",
      },
    });
    expect(await copied.text()).toBe("");
    expect(copied.status).toBe(204);
    expect(
      (await migrate("/cutover", { kind: "activate", inventoryRevision }))
        .status,
    ).toBe(200);
    expect(
      (await store.listForAgent(normalBot)).tools.map((tool) => tool.ref),
    ).toContain(ref);

    const toolName = `mcp__${serverId}__${name}`;
    const callArgs = {
      owner: "acme",
      repo: "pilot",
      title: "Normal Bot issue",
    };
    const run = {
      actorId: person,
      botId: normalBot,
      runId: randomUUID(),
      threadId: randomUUID(),
    };
    const continuation = {
      ...run,
      toolName,
      args: callArgs,
      toolCallId: randomUUID(),
      messages: [],
      context: [],
      state: {},
      forwardedProps: {},
    };
    const invoke = (args: Record<string, unknown>, conversational = true) => {
      const request = async () =>
        app.request("/api/agent-tools/call", {
          method: "POST",
          headers: {
            "x-openbot-agent-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: toolName,
            args,
            run: mintRunAssertion(run, config.keyEncryptionKey),
          }),
        });
      return conversational
        ? withApprovalContext(continuation, request)
        : request();
    };
    expect(await (await invoke(callArgs, false)).json()).toMatchObject({
      isError: true,
    });
    expect(
      await (await invoke({ ...callArgs, labels: ["ignored"] })).json(),
    ).toMatchObject({ isError: true });
    expect(await (await invoke(callArgs)).json()).toMatchObject({
      isError: true,
      text: expect.stringContaining("waiting for your approval"),
    });
    const pending = (await deps.approvals.list(person)).find(
      ({ action }) => action.toolRef === ref,
    );
    expect(pending?.action.target).toMatchObject({
      corsair: { connectionId, repositoryId: "23" },
    });
    expect(pending?.action.policy).toMatchObject({ closed: true });
    expect(writes).toHaveLength(1);
    if (!pending) throw new Error("Missing normal Bot Approval");
    await deps.approvals.decide(person, pending.id, "allow_once");
    const executeApproved = async () => {
      const result = await store.callTool({
        ref,
        botId: normalBot,
        actorId: person,
        args: callArgs,
      });
      return result.text;
    };
    const outcomes: string[] = [];
    await approvals.resume(person, pending.id, {
      validate: (action) => approvals.validateReentry(action, executeApproved),
      execute: executeApproved,
      continue: async ({ result }) => {
        outcomes.push(result.content);
      },
    });
    expect(outcomes).toEqual([expect.stringContaining("/acme/pilot/issues/7")]);
    expect(await (await invoke(callArgs)).json()).toMatchObject({
      isError: false,
      text: expect.stringContaining("/acme/pilot/issues/7"),
    });
    expect(writes).toHaveLength(2);
    await database
      .update(brokeredConnections)
      .set({ verified: false })
      .where(eq(brokeredConnections.userId, person));
    expect(await (await invoke(callArgs)).json()).toMatchObject({
      isError: true,
    });
    expect(writes).toHaveLength(2);
  } finally {
    await database
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.userId, person));
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.userId, person));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await database
      .delete(githubPilotRepositories)
      .where(eq(githubPilotRepositories.workspaceId, workspaceId));
    await database.delete(agents).where(eq(agents.id, normalBot));
    await database.delete(agents).where(eq(agents.id, bot));
    await database.delete(users).where(eq(users.id, person));
  }
});
