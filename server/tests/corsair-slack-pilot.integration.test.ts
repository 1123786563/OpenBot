import { createCorsairCutover } from "../src/plugins/corsair/cutover";
import { createCorsairReadinessRoutes } from "../src/plugins/corsair/readiness";
import { beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createApprovalStore } from "../src/approvals/store";
import { type AuditStore, createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents, brokeredAccounts, users } from "../src/db/schema";
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
  await db.insert(agents).values({
    id: bot,
    name: "Slack Bot",
    type: "built_in",
    configuration: {},
  });
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
