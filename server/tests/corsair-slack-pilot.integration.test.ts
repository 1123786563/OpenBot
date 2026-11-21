import { eq } from "drizzle-orm";
import { mintRunAssertion } from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createApprovalService } from "../src/approvals/service";
import { withApprovalContext } from "../src/approvals/types";
import { loadConfig } from "../src/config";
import { createCredentialStore } from "../src/credentials";
import { createPluginStore } from "../src/plugins/store";
import { testEnvironment } from "./support/environment";
import { createCorsairCutover } from "../src/plugins/corsair/cutover";
import { createCorsairReadinessRoutes } from "../src/plugins/corsair/readiness";
import { beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createApprovalStore } from "../src/approvals/store";
import { type AuditStore, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  agentProfiles,
  brokeredAccounts,
  brokeredConnections,
  mcpServers,
  mcpTools,
  users,
} from "../src/db/schema";
import type { SlackLegacyDefault } from "../src/plugins/corsair/slack/accounts";
import { createSlackPilotProvider } from "../src/plugins/corsair/slack/provider";
import { createSlackPilotRoutes } from "../src/plugins/corsair/slack/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const person = randomUUID();
const outsider = randomUUID();
const bot = randomUUID();
const workspaceId = randomUUID();
const credential = (user: string) => ({
  token_type: "user",
  access_token: `xoxe.xoxp-${user}`,
  refresh_token: `xoxe-${user}`,
  expires_in: 3600,
  scope: "chat:write,channels:read,groups:read",
});
let now = Date.now();
const writes: { user: string; channel: string; text: string }[] = [];
let membership = true;
let refreshedUser = "U111";
let refreshes = 0;
let exchanges = 0;
let refuseRefreshRevocation = true;
const revocations: string[] = [];
const provider = createSlackPilotProvider(
  {
    appId: "A123",
    teamId: "T123",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://openbot.test/api/corsair/slack/callback",
  },
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/oauth.v2.access")) {
        const form = new URLSearchParams(await request.text());
        const code = form.get("code");
        const installation = {
          ok: true,
          app_id: "A123",
          team: { id: code === "wrong" ? "T999" : "T123" },
          is_enterprise_install: false,
        };
        if (form.get("grant_type") === "refresh_token") {
          refreshes++;
          return Response.json({
            ...installation,
            ...credential(`${refreshedUser}-new`),
          });
        }
        exchanges++;
        const id = code === "second" ? "U222" : "U111";
        return Response.json({
          ...installation,
          authed_user: { id, ...credential(id) },
        });
      }
      if (url.pathname.endsWith("/auth.revoke")) {
        const token = request.headers.get("authorization") ?? "";
        revocations.push(token);
        if (token.startsWith("Bearer xoxe-") && refuseRefreshRevocation)
          return new Response(null, { status: 503 });
        return Response.json({ ok: true, revoked: true });
      }
      const user = request.headers
        .get("authorization")
        ?.match(/^Bearer xoxe\.xoxp-(U\d+)(?:-new)?$/)?.[1];
      if (!user) throw new Error("Expected a Slack user token");
      if (url.pathname.endsWith("/auth.test"))
        return Response.json({
          ok: true,
          user_id: user,
          user: "same-label",
          team_id: "T123",
        });
      if (url.pathname.endsWith("/conversations.info"))
        return Response.json({
          ok: true,
          channel: {
            id: url.searchParams.get("channel"),
            context_team_id: "T123",
            is_archived: false,
            is_ext_shared: false,
          },
        });
      if (url.pathname.endsWith("/conversations.members")) {
        const cursor = url.searchParams.get("cursor");
        return Response.json(
          cursor
            ? { ok: true, members: membership ? [user] : ["U999"] }
            : {
                ok: true,
                members: ["U999"],
                response_metadata: { next_cursor: "page-two" },
              },
        );
      }
      if (url.pathname.endsWith("/chat.postMessage")) {
        const { channel, text } = await request.json();
        writes.push({ user, channel, text });
        if (text === "committed without a response")
          throw new Error("connection closed");
        return Response.json({
          ok: true,
          channel,
          ts: "12345.67890",
          message: { user },
        });
      }
      throw new Error("Unexpected Slack endpoint");
    },
    { preconnect: fetch.preconnect },
  ),
);
const encryptionKey = randomBytes(32).toString("base64");
const routes = (
  workspace: string,
  legacyDefaults: SlackLegacyDefault[] = [],
  audit: AuditStore = createAuditStore(db),
  enforceCutover = false,
) =>
  createSlackPilotRoutes({
    database: db,
    enforceCutover,
    legacyDefaults,
    workspaceId: workspace,
    registration: "A123/client/T123",
    provider,
    allowedChannels: new Set(["C123"]),
    approvals: createApprovalStore(db),
    audit,
    encryptionKey,
    clock: () => new Date(now),
    canUseBot: async (_actor, id) => id === bot,
    requireUser: async (c, next) => {
      c.set("actor", {
        id: c.req.header("x-person") ?? person,
        email: "fixture@example.test",
        role: c.req.header("x-admin") ? "admin" : "user",
      });
      await next();
    },
  });
const app = () => routes(workspaceId);
function call(
  app: ReturnType<typeof routes>,
  path: string,
  {
    method = "GET",
    body,
    actor,
    admin,
  }: { method?: string; body?: object; actor?: string; admin?: boolean } = {},
) {
  return app.request(path, {
    method,
    headers: {
      "X-OpenBot-Pilot": "slack",
      "Content-Type": "application/json",
      ...(actor ? { "x-person": actor } : {}),
      ...(admin ? { "x-admin": "true" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  await db.insert(agents).values({
    id: bot,
    name: "Slack Bot",
    type: "built_in",
    configuration: {},
  });
  await db.insert(users).values(
    [person, outsider].map((id) => ({
      id,
      name: "Slack Person",
      email: `${id}@example.test`,
    })),
  );
});

async function start(a: ReturnType<typeof routes>, code: string) {
  const result = await call(a, "/connect", { method: "POST" });
  expect(result.status).toBe(201);
  const { authorizationUrl } = await result.json();
  return `/callback?code=${code}&state=${new URL(authorizationUrl).searchParams.get("state")}`;
}

test("Slack Connect lists two same-name users and isolates OAuth state and explicit defaults", async () => {
  const a = app();
  const first = await start(a, "first");
  expect((await call(routes(randomUUID()), first)).status).toBe(409);
  expect((await call(a, first, { actor: outsider })).status).toBe(409);
  expect(exchanges).toBe(0);
  expect((await call(a, await start(a, "wrong"))).status).toBe(502);
  expect((await call(a, first)).status).toBe(200);
  expect((await call(a, first)).status).toBe(409);
  expect((await call(a, await start(a, "second"))).status).toBe(200);
  const { connections, defaultConnectionId } = await (
    await call(a, "/connections")
  ).json();
  expect(defaultConnectionId).toBeNull();
  expect(connections).toHaveLength(2);
  const selected = connections.find(
    (entry: { userId: string }) => entry.userId === "U111",
  );
  expect(selected).toMatchObject({
    userId: "U111",
    label: "same-label",
    subjectScope: "T123",
  });
  expect(
    (
      await call(a, "/connections/default", {
        method: "PUT",
        body: { connectionId: selected.id },
        actor: outsider,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call(a, "/connections/default", {
        method: "PUT",
        body: { connectionId: selected.id },
      })
    ).status,
  ).toBe(200);
  expect(await (await call(a, "/connections")).json()).toMatchObject({
    defaultConnectionId: selected.id,
  });
});

test("Slack writes require a Bot Grant and immutable one-time Approval and use the pinned user after refresh", async () => {
  const a = routes(randomUUID());
  for (const code of ["first", "second"])
    expect((await call(a, await start(a, code))).status).toBe(200);
  const { connections } = await (await call(a, "/connections")).json();
  const first = connections.find(
    (entry: { userId: string }) => entry.userId === "U111",
  ).id;
  const second = connections.find(
    (entry: { userId: string }) => entry.userId === "U222",
  ).id;
  const post = (path: string, body: object) =>
    call(a, path, { method: "POST", body });
  const grant = (enabled: boolean, admin = true) =>
    call(a, `/bots/${bot}/grant`, { method: "PUT", body: { enabled }, admin });
  const setDefault = (connectionId: string) =>
    call(a, "/connections/default", { method: "PUT", body: { connectionId } });
  expect((await setDefault(first)).status).toBe(200);
  const input = { botId: bot, channelId: "C123", text: "approved text" };
  expect((await post("/approvals", input)).status).toBe(403);
  expect((await grant(true, false)).status).toBe(403);
  expect((await grant(true)).status).toBe(200);
  expect(await (await call(a, `/bots/${bot}/tools`)).json()).toMatchObject({
    tools: [{ ref: "corsair/slack.post_message" }],
  });
  expect(
    (await post("/approvals", { ...input, channelId: "C999" })).status,
  ).toBe(403);
  async function approve(
    args: typeof input & { connectionId?: string } = input,
    decision = "allow_once",
  ) {
    const response = await post("/approvals", args);
    expect(response.status).toBe(201);
    const { id, action } = await response.json();
    expect((await post(`/approvals/${id}/decision`, { decision })).status).toBe(
      200,
    );
    return {
      id,
      action,
      execute: (body: object = args) => post(`/approvals/${id}/execute`, body),
    };
  }
  const denied = await approve(input, "deny");
  expect((await denied.execute()).status).toBe(409);
  const selected = await approve();
  expect(selected.action.target).toMatchObject({
    connectionId: first,
    userId: "U111",
    teamId: "T123",
    channelId: "C123",
  });
  expect(
    (await selected.execute({ ...input, connectionId: second })).status,
  ).toBe(409);
  expect((await selected.execute({ ...input, text: "changed" })).status).toBe(
    409,
  );
  expect((await selected.execute({ ...input, channelId: "C999" })).status).toBe(
    403,
  );
  expect(
    (
      await call(a, `/approvals/${selected.id}/execute`, {
        method: "POST",
        body: input,
        actor: outsider,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(routes(randomUUID()), `/approvals/${selected.id}/execute`, {
        method: "POST",
        body: input,
      })
    ).status,
  ).toBe(404);
  membership = false;
  expect((await selected.execute()).status).toBe(403);
  membership = true;
  expect((await grant(false)).status).toBe(200);
  expect((await selected.execute()).status).toBe(403);
  expect(writes).toEqual([]);
  expect((await grant(true)).status).toBe(200);
  expect((await setDefault(second)).status).toBe(200);
  now += 3600_000;
  const executions = await Promise.all([
    selected.execute(),
    selected.execute(),
  ]);
  expect(executions.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  expect(refreshes).toBe(1);
  expect(writes).toEqual([
    { user: "U111", channel: "C123", text: "approved text" },
  ]);
  now -= 3600_000;
  const explicit = await approve({ ...input, connectionId: second });
  expect((await explicit.execute()).status).toBe(200);
  expect(writes.at(-1)?.user).toBe("U222");
  const mismatched = await approve({ ...input, connectionId: second });
  now += 3600_000;
  refreshedUser = "U333";
  expect((await mismatched.execute()).status).toBe(409);
  expect((await mismatched.execute()).status).toBe(409);
  expect(refreshes).toBe(2);
  expect(writes).toHaveLength(2);
  const state = await (await call(a, "/connections")).json();
  expect(
    state.connections.find((entry: { id: string }) => entry.id === second)
      .verificationRequiredAt,
  ).toBeTruthy();
});

test("only verified evidence for the exact stable Slack subject inherits a current Broker default", async () => {
  const workspace = randomUUID();
  const [broker] = await db
    .insert(brokeredAccounts)
    .values({
      provider: "arcade",
      app: "slack",
      userId: person,
      vendorUserId: person,
      identity: "same-label",
      isDefault: true,
    })
    .returning({ id: brokeredAccounts.id });
  if (!broker) throw new Error("Broker fixture was not saved");
  try {
    const a = routes(workspace, [
      {
        workspaceId: workspace,
        registration: "A123/client/T123",
        personId: person,
        brokeredAccountId: broker.id,
        subjectScope: "T123",
        userId: "U111",
        evidenceRef: "provider-fixture",
      },
    ]);
    expect((await call(a, await start(a, "second"))).status).toBe(200);
    expect(await (await call(a, "/connections")).json()).toMatchObject({
      defaultConnectionId: null,
    });
    const linked = await call(a, await start(a, "first"));
    expect(linked.status).toBe(200);
    const { connection } = await linked.json();
    expect(await (await call(a, "/connections")).json()).toMatchObject({
      defaultConnectionId: connection.id,
    });
    const relinked = await call(a, await start(a, "first"));
    expect(await relinked.json()).toMatchObject({
      connection: { id: connection.id, userId: "U111" },
    });
  } finally {
    await db.delete(brokeredAccounts).where(eq(brokeredAccounts.id, broker.id));
  }
});

test("disconnect immediately blocks an approved Slack write and retries missing refresh evidence", async () => {
  const a = routes(randomUUID());
  const linked = await call(a, await start(a, "first"));
  const { connection } = await linked.json();
  const path = `/connections/${connection.id}/revocation`;
  const input = {
    botId: bot,
    connectionId: connection.id,
    channelId: "C123",
    text: "queued",
  };
  expect(
    (
      await call(a, `/bots/${bot}/grant`, {
        method: "PUT",
        body: { enabled: true },
        admin: true,
      })
    ).status,
  ).toBe(200);
  const requested = await call(a, "/approvals", {
    method: "POST",
    body: input,
  });
  expect(requested.status).toBe(201);
  const { id } = await requested.json();
  expect(
    (
      await call(a, `/approvals/${id}/decision`, {
        method: "POST",
        body: { decision: "allow_once" },
      })
    ).status,
  ).toBe(200);

  expect(
    (await call(a, path, { method: "DELETE", actor: outsider })).status,
  ).toBe(404);
  const lateCallback = await start(a, "first");
  const disconnected = await call(a, path, { method: "DELETE" });
  expect(disconnected.status).toBe(200);
  expect(await disconnected.json()).toMatchObject({
    status: "pending",
    access: "provider",
    refresh: "unconfirmed",
  });
  expect((await call(a, path)).status).toBe(200);
  expect(
    await (await call(a, "/connections/revocations")).json(),
  ).toMatchObject({
    connections: [{ id: connection.id, revocation: { status: "pending" } }],
  });
  expect(
    (await call(a, "/approvals", { method: "POST", body: input })).status,
  ).toBe(403);
  const count = writes.length;
  expect(
    (
      await call(a, `/approvals/${id}/execute`, {
        method: "POST",
        body: input,
      })
    ).status,
  ).toBe(403);
  expect(writes).toHaveLength(count);
  expect((await call(a, await start(a, "first"))).status).toBe(409);

  refuseRefreshRevocation = false;
  const retry = await call(a, path, { method: "POST" });
  expect(await retry.json()).toMatchObject({
    status: "revoked",
    access: "provider",
    refresh: "provider",
  });
  expect(revocations).toEqual([
    "Bearer xoxe.xoxp-U111",
    "Bearer xoxe-U111",
    "Bearer xoxe-U111",
  ]);
  expect((await call(a, lateCallback)).status).toBe(409);
  now += 1;
  expect((await call(a, await start(a, "first"))).status).toBe(200);
});

test("disconnect wins if an approved Slack write has been consumed but has not reached dispatch", async () => {
  const began = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const audit = createAuditStore(db);
  const workspace = randomUUID();
  await createCorsairCutover(db, {
    workspaceId: workspace,
    app: "slack",
  }).activate(person, async () => []);
  const a = routes(
    workspace,
    [],
    {
      async insert(event) {
        await audit.insert(event);
        if (event.eventType === "corsair.slack.write_started") {
          began.resolve();
          await resume.promise;
        }
      },
    },
    true,
  );
  const linked = await call(a, await start(a, "first"));
  const { connection } = await linked.json();
  const input = {
    botId: bot,
    connectionId: connection.id,
    channelId: "C123",
    text: "staged",
  };
  expect(
    (
      await call(a, `/bots/${bot}/grant`, {
        method: "PUT",
        body: { enabled: true },
        admin: true,
      })
    ).status,
  ).toBe(200);
  const opened = await call(a, "/approvals", { method: "POST", body: input });
  expect(opened.status).toBe(201);
  const { id } = await opened.json();
  expect(
    (
      await call(a, `/approvals/${id}/decision`, {
        method: "POST",
        body: { decision: "allow_once" },
      })
    ).status,
  ).toBe(200);
  const count = writes.length;
  const executing = Promise.resolve(
    call(a, `/approvals/${id}/execute`, { method: "POST", body: input }),
  );
  try {
    await Promise.race([
      began.promise,
      executing.then((result) => {
        throw new Error(`Execution returned early with ${result.status}`);
      }),
    ]);
    const disconnected = await call(
      a,
      `/connections/${connection.id}/revocation`,
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(200);
  } finally {
    resume.resolve();
  }
  expect((await executing).status).toBe(409);
  expect(writes).toHaveLength(count);
});

test("a lost Slack response is queryable and a second approval cannot duplicate the remote write", async () => {
  const workspace = randomUUID();
  await createCorsairCutover(db, {
    workspaceId: workspace,
    app: "slack",
  }).activate(person, async () => []);
  const a = routes(workspace, [], createAuditStore(db), true);
  const administration = createCorsairReadinessRoutes({
    database: db,
    workspaceId: workspace,
    registrations: { slack: "A123/client/T123" },
    includeDeploymentLegacy: false,
    requireUser: async (c, next) => {
      c.set("actor", {
        id: person,
        email: "fixture@example.test",
        role: "admin",
      });
      await next();
    },
  });
  const linked = await call(a, await start(a, "first"));
  const { connection } = await linked.json();
  const input = {
    botId: bot,
    connectionId: connection.id,
    channelId: "C123",
    text: "committed without a response",
  };
  expect(
    (
      await call(a, `/bots/${bot}/grant`, {
        method: "PUT",
        body: { enabled: true },
        admin: true,
      })
    ).status,
  ).toBe(200);
  async function approve() {
    const opened = await call(a, "/approvals", { method: "POST", body: input });
    expect(opened.status).toBe(201);
    const { id } = await opened.json();
    expect(
      (
        await call(a, `/approvals/${id}/decision`, {
          method: "POST",
          body: { decision: "allow_once" },
        })
      ).status,
    ).toBe(200);
    return id;
  }
  const execute = (id: string) =>
    call(a, `/approvals/${id}/execute`, { method: "POST", body: input });
  const id = await approve();
  const count = writes.length;
  expect((await execute(id)).status).toBe(502);
  expect((await execute(id)).status).toBe(409);
  expect((await execute(await approve())).status).toBe(409);
  expect(writes).toHaveLength(count + 1);
  expect(
    await (await administration.request("/slack/unknown-writes")).json(),
  ).toMatchObject([{ approvalId: id, targetId: "C123", canReconcile: true }]);
  // This is the provider-side history in the fixture. Reconcile the recorded write as applied.
  expect(writes[count]).toEqual({
    user: "U111",
    channel: "C123",
    text: input.text,
  });
  const resolved = await administration.request(`/slack/unknown-writes/${id}`, {
    method: "PUT",
    headers: { "X-OpenBot-Pilot": "slack", "Content-Type": "application/json" },
    body: JSON.stringify({
      outcome: "applied",
      evidenceRef: "fixture/slack/history/1",
    }),
  });
  expect(resolved.status).toBe(204);
  expect(
    await (await administration.request("/slack/unknown-writes")).json(),
  ).toEqual([]);
  expect((await execute(await approve())).status).toBe(409);
  expect(writes).toHaveLength(count + 1);
});

test("normal Slack Bot writes use the verified Broker account mapping instead of the Corsair default", async () => {
  const workspaceId = randomUUID();
  const serverId = randomUUID();
  const botId = randomUUID();
  const brokerAccountId = randomUUID();
  const actorId = outsider;
  const registration = "A123/client/T123";
  const token = "fixture-slack-normal-bot-token";
  const config = loadConfig(
    testEnvironment({
      AGENT_TOOL_TOKEN: token,
      KEY_ENCRYPTION_KEY: encryptionKey,
    }),
  );
  const stored = createApprovalStore(db);
  const approvals = createApprovalService(stored);
  const audit = createAuditStore(db);
  const policy = () => ({
    mode: "enforce" as const,
    allow: ["true"],
    deny: [],
  });
  const pluginStore = createPluginStore({
    database: db,
    deploymentId: workspaceId,
    brokerProvider: "composio",
    policy,
    approvalGate: approvals.gate,
    auditStore: audit,
    credentials: createCredentialStore(db),
    encryptionKey,
    callVendor: async () => {
      throw new Error("Unexpected Broker dispatch");
    },
  });
  const args: Parameters<typeof createApp> = [
    config,
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async () => ({
          user: { id: actorId, email: `${actorId}@example.test` },
        }),
      },
    },
    { rolesForUser: async () => ["admin"] },
  ];
  args[9] = createAgentProfileStore(db, undefined);
  args[14] = pluginStore;
  args[34] = {
    approvals,
    corsairReadiness: {
      database: db,
      workspaceId,
      includeDeploymentLegacy: true,
      slackChannels: ["C123"],
      registrations: { slack: registration },
    },
    slackPilot: {
      workspaceId,
      database: db,
      registration,
      provider,
      allowedChannels: new Set(["C123"]),
      approvals: stored,
      audit,
      encryptionKey,
      legacyPolicy: policy,
      enforceCutover: true,
    },
  };
  const mounted = createApp(...args);
  const request = (path: string, method = "GET", body?: unknown) =>
    mounted.request(path, {
      method,
      headers: {
        "X-OpenBot-Pilot": "slack",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const native = "/api/corsair/slack";
  const migration = "/api/corsair/migration/slack";
  const name = "SLACK_CHAT_POST_MESSAGE";
  const ref = `${serverId}/${name}`;
  async function connect(code: string): Promise<string> {
    const started = await request(`${native}/connect`, "POST");
    expect(started.status).toBe(201);
    const { authorizationUrl } = await started.json();
    const state = new URL(authorizationUrl).searchParams.get("state");
    const callback = await request(
      `${native}/callback?code=${code}&state=${state}`,
    );
    expect(callback.status).toBe(200);
    return (await callback.json()).connection.id;
  }
  await db.insert(agents).values({
    id: botId,
    name: "Slack migrated Bot",
    type: "built_in",
    configuration: {},
  });
  try {
    await db.insert(agentProfiles).values({
      agentId: botId,
      title: "Slack migrated Bot",
      roleDescription: "",
      avatarSeed: botId,
      visibility: "public",
    });
    await db.insert(mcpServers).values({
      id: serverId,
      url: "composio://slack",
      vendor: "Slack",
      title: "Brokered Slack",
      provenance: "composio",
      accountMode: "personal",
    });
    await db.insert(mcpTools).values({ serverId, name, effect: "write" });
    await pluginStore.grant("mcp", ref, botId, actorId);
    await db.insert(brokeredConnections).values({
      provider: "composio",
      app: "slack",
      holder: "person",
      userId: actorId,
      vendorUserId: actorId,
      verified: true,
    });
    await db.insert(brokeredAccounts).values({
      id: brokerAccountId,
      provider: "composio",
      app: "slack",
      userId: actorId,
      vendorUserId: actorId,
      accountId: "verified-broker-account",
      isDefault: true,
    });
    const defaultId = await connect("first");
    const mappedId = await connect("second");
    expect(
      (
        await request(`${native}/connections/default`, "PUT", {
          connectionId: defaultId,
        })
      ).status,
    ).toBe(200);
    const { inventoryRevision, capabilities } = await (
      await request(migration)
    ).json();
    for (const { key } of capabilities) {
      const binding = key === `legacy-account:${brokerAccountId}`;
      const decision =
        key === `tool:${ref}` || binding
          ? {
              kind: "verified",
              inventoryRevision,
              targetId: binding ? mappedId : undefined,
              addedPermissions: [],
              checks: {
                identity: "fixture/identity",
                resourceScope: "fixture/channel",
                approval: "fixture/approval",
                event: "fixture/event",
                revocation: "fixture/revocation",
              },
            }
          : {
              kind: "disabled",
              inventoryRevision,
              reason: "Outside fixture scope",
            };
      expect(
        (
          await request(`${migration}/decisions`, "POST", {
            capability: key,
            decision,
          })
        ).status,
      ).toBe(204);
    }
    expect(
      (
        await request(`${migration}/policies`, "POST", {
          legacyTool: ref,
          botId,
          inventoryRevision,
          binding: { kind: "personal", connections: [mappedId] },
          resources: ["C123"],
          evidence: {
            equivalentAppAndAction: "fixture/action",
            identityAndResources: "fixture/identity",
            preservedRestrictions: "fixture/policy",
          },
        })
      ).status,
    ).toBe(204);
    const ready = await (await request(migration)).json();
    expect(ready).toMatchObject({ ready: true, inventoryRevision });
    const route = await createCorsairCutover(db, {
      workspaceId,
      app: "slack",
    }).activate(actorId, async () =>
      ready.capabilities
        .filter(({ status }: { status: string }) => status === "disabled")
        .map(({ key }: { key: string }) => key),
    );
    expect(route?.kind).toBe("observing");
    expect(
      (await pluginStore.listForAgent(botId)).tools.map((tool) => tool.ref),
    ).toEqual([ref]);
    const toolName = `mcp__${serverId}__${name}`;
    const run = { actorId, botId, runId: randomUUID(), threadId: randomUUID() };
    const input = { channel: "C123", text: "Normal Slack Bot write" };
    const invoke = (callArgs: Record<string, unknown>) =>
      withApprovalContext(
        {
          ...run,
          toolName,
          toolCallId: "fixture-call",
          args: callArgs,
          messages: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        async () =>
          mounted.request("/api/agent-tools/call", {
            method: "POST",
            headers: {
              "x-openbot-agent-token": token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: toolName,
              args: callArgs,
              run: mintRunAssertion(run, encryptionKey),
            }),
          }),
      );
    const count = writes.length;
    expect(
      await (await invoke({ ...input, channel: "C999" })).json(),
    ).toMatchObject({ isError: true });
    expect(await (await invoke(input)).json()).toMatchObject({
      isError: true,
      text: expect.stringContaining("waiting for your approval"),
    });
    const approval = (await stored.list(actorId)).find(
      ({ action }) => action.toolRef === ref,
    );
    expect(approval?.action.target).toMatchObject({
      corsair: { connectionId: mappedId, userId: "U222" },
    });
    if (!approval) throw new Error("Missing Slack approval");
    await stored.decide(actorId, approval.id, "allow_once");
    expect(await (await invoke(input)).json()).toMatchObject({
      isError: false,
    });
    expect(writes.slice(count)).toEqual([
      { text: input.text, channel: "C123", user: "U222" },
    ]);
  } finally {
    await db
      .delete(brokeredAccounts)
      .where(eq(brokeredAccounts.id, brokerAccountId));
    await db
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.userId, actorId));
    await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await db.delete(agents).where(eq(agents.id, botId));
  }
});
