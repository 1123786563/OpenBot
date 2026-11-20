import { mintRunAssertion } from "../src/agents/callback-token";
import { createApprovalService } from "../src/approvals/service";
import { withApprovalContext } from "../src/approvals/types";
import { createCredentialStore } from "../src/credentials";
import { createCorsairCutover } from "../src/plugins/corsair/cutover";
import { createPluginStore } from "../src/plugins/store";
import { beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createApprovalStore } from "../src/approvals/store";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  brokeredConnections,
  mcpServers,
  mcpTools,
  slackSharedInstallations,
  responsibilities,
  responsibilityEvents,
  responsibilityRuns,
  users,
} from "../src/db/schema";
import { createSharedSlackProvider } from "../src/plugins/corsair/slack/shared-provider";
import {
  createSharedUseGate,
  createSharedUseStore,
} from "../src/plugins/shared-use-store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

import { testEnvironment } from "./support/environment";

const db = createDatabase(testDatabaseUrl(), TEST_POOL);
const admin = {
  id: randomUUID(),
  email: "admin@example.test",
  role: "admin" as const,
};
const member = {
  id: randomUUID(),
  email: "member@example.test",
  role: "user" as const,
};
const botId = randomUUID();
const identity = {
  appId: "A123",
  teamId: "T123",
  botId: "B123",
  botUserId: "U123",
};
let authenticatedBot = identity.botId;
let memberOfChannel = true;
let revocationAttempts = 0;
const writes: unknown[] = [];
const provider = createSharedSlackProvider(
  { ...identity, token: "xoxb-fixture" },
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      expect(req.headers.get("authorization")).toBe("Bearer xoxb-fixture");
      switch (url.pathname) {
        case "/api/auth.revoke":
          revocationAttempts++;
          return Response.json({ ok: true, revoked: true });
        case "/api/auth.test":
          return Response.json({
            ok: true,
            team_id: "T123",
            bot_id: authenticatedBot,
            user_id: "U123",
          });
        case "/api/conversations.info":
          return Response.json({
            ok: true,
            channel: {
              id: url.searchParams.get("channel"),
              context_team_id: "T123",
              is_archived: false,
              is_ext_shared: false,
              is_member: memberOfChannel,
            },
          });
        case "/api/chat.postMessage": {
          const body = await req.json();
          writes.push(body);
          return Response.json({
            ok: true,
            channel: body.channel,
            ts: "123.456",
            message: { bot_id: "B123" },
          });
        }
        default:
          throw new Error("Unexpected Slack request");
      }
    },
    { preconnect: fetch.preconnect },
  ),
);

beforeAll(async () => {
  await db.insert(users).values(
    [admin, member].map(({ id }) => ({
      id,
      name: id,
      email: `${id}@example.test`,
    })),
  );
  await db.insert(agents).values({
    id: botId,
    name: "Slack fixture",
    type: "built_in",
    configuration: {},
  });
  await db.insert(agentProfiles).values({
    agentId: botId,
    ownerUserId: admin.id,
    title: "Slack fixture",
    roleDescription: "Test shared Slack posts",
    avatarSeed: botId,
    visibility: "public",
  });
});

function pilot() {
  const args: Parameters<typeof createApp> = [
    loadConfig(
      testEnvironment({
        DATABASE_URL: testDatabaseUrl(),
        KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      }),
    ),
    {
      handler: () => new Response(null, { status: 204 }),
      api: {
        getSession: async ({ headers }) => ({
          user: headers.has("x-fixture-admin") ? admin : member,
        }),
      },
    },
    { rolesForUser: async () => [] },
  ];
  args[9] = createAgentProfileStore(db, undefined);
  args[34] = {
    sharedSlackPilot: {
      workspaceId: randomUUID(),
      database: db,
      provider,
      audit: createAuditStore(db),
      approvals: createApprovalStore(db),
      sharedUse: createSharedUseStore(db, "composio"),
    },
  };
  return createApp(...args);
}
function call(
  app: ReturnType<typeof pilot>,
  path: string,
  method: string,
  body?: object,
  asAdmin = false,
) {
  return app.request(`/api/corsair/slack/shared${path}`, {
    method,
    body: body && JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "X-OpenBot-Pilot": "slack",
      ...(asAdmin ? { "x-fixture-admin": "true" } : {}),
    },
  });
}

test("only workspace admins can enroll a verified Slack Bot and its member channels", async () => {
  const app = pilot();
  const enrollment = { channelIds: ["C123"] };
  expect((await call(app, "/installation", "PUT", enrollment)).status).toBe(
    403,
  );
  authenticatedBot = "B999";
  expect(
    (await call(app, "/installation", "PUT", enrollment, true)).status,
  ).toBe(502);
  authenticatedBot = identity.botId;
  memberOfChannel = false;
  expect(
    (await call(app, "/installation", "PUT", enrollment, true)).status,
  ).toBe(502);
  memberOfChannel = true;
  const enrolled = await call(app, "/installation", "PUT", enrollment, true);
  expect(enrolled.status).toBe(200);
  expect(await enrolled.json()).toMatchObject({
    identity,
    channelIds: ["C123"],
  });
  expect(
    (await call(pilot(), "/installation", "GET", undefined, true)).status,
  ).toBe(404);
});

const action = { botId, channelId: "C123", text: "Reviewed message" };
const access = { audience: "team", outsideInput: false, members: [] };
async function enroll(app: ReturnType<typeof pilot>, channelIds = ["C123"]) {
  expect(
    (await call(app, "/installation", "PUT", { channelIds }, true)).status,
  ).toBe(200);
}
async function grant(app: ReturnType<typeof pilot>, enabled = true) {
  expect(
    (await call(app, `/bots/${botId}/grant`, "PUT", { enabled }, true)).status,
  ).toBe(200);
}
async function policy(
  app: ReturnType<typeof pilot>,
  approval: object | null = access,
) {
  expect(
    (await call(app, `/bots/${botId}/shared-use`, "PUT", { approval }, true))
      .status,
  ).toBe(200);
}
async function approve(app: ReturnType<typeof pilot>, id: string) {
  expect(
    (
      await call(app, `/approvals/${id}/decision`, "POST", {
        decision: "allow_once",
      })
    ).status,
  ).toBe(200);
}

test("a Slack installation write requires each grant, the channel scope, and a one-time Approval", async () => {
  const app = pilot();
  await enroll(app);
  const start = () => call(app, "/approvals", "POST", action);
  const count = writes.length;
  expect((await start()).status).toBe(403);
  await grant(app);
  expect((await start()).status).toBe(403);
  await policy(app, {
    ...access,
    audience: "people",
    members: [{ kind: "user", value: admin.id }],
  });
  expect((await start()).status).toBe(403);
  await policy(app);
  expect(
    (await call(app, "/approvals", "POST", { ...action, channelId: "C999" }))
      .status,
  ).toBe(403);
  const requested = await start();
  expect(requested.status).toBe(201);
  const { id } = await requested.json();
  const execute = () => call(app, `/approvals/${id}/execute`, "POST");
  expect((await execute()).status).toBe(409);
  await approve(app, id);
  await grant(app, false);
  expect((await execute()).status).toBe(403);
  expect(writes).toHaveLength(count);
  await grant(app);
  const results = await Promise.all([execute(), execute()]);
  expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(await results.find((response) => response.ok)?.json()).toMatchObject({
    message: { identity, channel: "C123", timestamp: "123.456" },
  });
  expect(writes.slice(count)).toEqual([
    {
      channel: "C123",
      text: action.text,
      unfurl_links: false,
      unfurl_media: false,
    },
  ]);
});

test("webhook Goal Runs require outside-input permission and retain their origin in the audit trail", async () => {
  const app = pilot();
  await enroll(app);
  await grant(app);
  await policy(app);
  const goalId = randomUUID();
  const eventId = randomUUID();
  const runId = randomUUID();
  await db.insert(responsibilities).values({
    id: goalId,
    ownerUserId: member.id,
    agentId: botId,
    channelId: "fixture",
    threadId: "fixture",
    title: "Webhook Goal",
    instruction: "Send a Slack message",
    successCriteria: "The message is sent",
  });
  await db.insert(responsibilityEvents).values({
    id: eventId,
    ownerUserId: member.id,
    source: "webhook",
    externalId: eventId,
    type: "test",
    payload: {},
  });
  await db
    .insert(responsibilityRuns)
    .values({ id: runId, responsibilityId: goalId, eventId });
  const count = writes.length;
  const request = () =>
    call(app, `/goal-runs/${runId}/approvals`, "POST", action);
  expect((await request()).status).toBe(403);
  expect(writes).toHaveLength(count);
  await policy(app, { ...access, outsideInput: true });
  const requested = await request();
  expect(requested.status).toBe(201);
  const { id } = await requested.json();
  await approve(app, id);
  const execute = () => call(app, `/approvals/${id}/execute`, "POST");
  await policy(app);
  expect((await execute()).status).toBe(403);
  expect(writes).toHaveLength(count);
  await policy(app, { ...access, outsideInput: true });
  expect((await execute()).status).toBe(200);
  expect(writes).toHaveLength(count + 1);
  const refused = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "corsair.slack.write_refused"));
  expect(
    refused.some(({ payload }) => JSON.stringify(payload).includes(runId)),
  ).toBe(true);
  const succeeded = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, "corsair.slack.write_succeeded"));
  expect(succeeded.map(({ payload }) => payload)).toContainEqual(
    expect.objectContaining({
      approvalId: id,
      identityKind: "slack_installation_bot",
      identity,
      target: expect.objectContaining({
        origin: { kind: "goal", runId, goalId, eventId, source: "webhook" },
      }),
    }),
  );
});

test("workspaces sharing one Slack installation keep independent channels, grants and Approvals", async () => {
  const first = pilot();
  const second = pilot();
  await enroll(first);
  await grant(first);
  await policy(first);
  await enroll(second, ["C456"]);
  const count = writes.length;
  const requested = await call(first, "/approvals", "POST", action);
  expect(requested.status).toBe(201);
  const { id } = await requested.json();
  const decision = `/approvals/${id}/decision`;
  const execute = `/approvals/${id}/execute`;
  expect(
    (await call(second, decision, "POST", { decision: "allow_once" })).status,
  ).toBe(404);
  await approve(first, id);
  expect((await call(second, execute, "POST")).status).toBe(404);
  await grant(second);
  expect(
    (await call(second, "/approvals", "POST", { ...action, channelId: "C456" }))
      .status,
  ).toBe(403);
  await policy(second);
  expect((await call(second, "/approvals", "POST", action)).status).toBe(403);
  expect(writes).toHaveLength(count);
  const ownRequest = await call(second, "/approvals", "POST", {
    ...action,
    channelId: "C456",
  });
  expect(ownRequest.status).toBe(201);
  const { id: secondId } = await ownRequest.json();
  await approve(second, secondId);
  expect(
    (await call(second, `/approvals/${secondId}/execute`, "POST")).status,
  ).toBe(200);
  expect(writes.slice(count)).toEqual([
    expect.objectContaining({ channel: "C456" }),
  ]);
});

test("Shared Slack disconnect is local and remote revocation requires a current impact confirmation", async () => {
  const first = pilot();
  const second = pilot();
  await enroll(first);
  await grant(first);
  await policy(first);
  const requested = await call(first, "/approvals", "POST", action);
  expect(requested.status).toBe(201);
  const { id } = await requested.json();
  await approve(first, id);
  const local = await call(first, "/installation", "DELETE", undefined, true);
  expect(await local.json()).toMatchObject({ status: "pending" });
  expect(revocationAttempts).toBe(0);
  expect((await call(first, `/approvals/${id}/execute`, "POST")).status).toBe(
    404,
  );
  const impact = "/installation/revocation/impact";
  const revoke = "/installation/revocation";
  const preview = await (
    await call(first, impact, "GET", undefined, true)
  ).json();
  await enroll(second);
  expect(
    (
      await call(
        first,
        revoke,
        "POST",
        { confirmation: preview.confirmation },
        true,
      )
    ).status,
  ).toBe(409);
  const updated = await (
    await call(first, impact, "GET", undefined, true)
  ).json();
  expect(updated.installations.length).toBeGreaterThan(
    preview.installations.length,
  );
  const body = { confirmation: updated.confirmation };
  expect((await call(first, revoke, "POST", body)).status).toBe(403);
  expect(revocationAttempts).toBe(0);
  const result = await call(first, revoke, "POST", body, true);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    status: "revoked",
    access: "provider",
    refresh: "not_applicable",
  });
  expect(revocationAttempts).toBe(1);
  const status = await call(second, "/installation", "GET", undefined, true);
  expect(await status.json()).toMatchObject({
    revocation: { status: "pending" },
  });
});

test("normal Slack Shared Bot calls use the reviewed installation and still enforce its audience", async () => {
  const workspaceId = randomUUID();
  const serverId = randomUUID();
  const sharedVendorUserId = randomUUID();
  const registration = provider.identity.appId;
  const token = "shared-slack-agent-fixture-token";
  const encryptionKey = randomBytes(32).toString("base64");
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
  const sharedUse = createSharedUseStore(db, "composio");
  const pluginStore = createPluginStore({
    database: db,
    deploymentId: workspaceId,
    brokerProvider: "composio",
    policy,
    approvalGate: approvals.gate,
    auditStore: audit,
    sharedUse: createSharedUseGate(sharedUse, audit),
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
      api: { getSession: async () => ({ user: admin }) },
    },
    { rolesForUser: async (id) => (id === admin.id ? ["admin"] : ["user"]) },
  ];
  args[9] = createAgentProfileStore(db, undefined);
  args[14] = pluginStore;
  args[34] = {
    approvals,
    corsairReadiness: {
      database: db,
      workspaceId,
      includeDeploymentLegacy: true,
      registrations: {},
      sharedSlackRegistration: registration,
    },
    sharedSlackPilot: {
      workspaceId,
      database: db,
      provider,
      approvals: stored,
      audit,
      sharedUse,
      legacyPolicy: policy,
      enforceCutover: true,
    },
  };
  const mounted = createApp(...args);
  const migration = "/api/corsair/migration/slack";
  const post = (path: string, data: unknown) =>
    mounted.request(migration + path, {
      method: "POST",
      headers: { "X-OpenBot-Pilot": "slack" },
      body: JSON.stringify(data),
    });
  const name = "SLACK_CHAT_POST_MESSAGE";
  const ref = `${serverId}/${name}`;
  try {
    await enroll(mounted);
    const [installation] = await db
      .select({ id: slackSharedInstallations.id })
      .from(slackSharedInstallations)
      .where(eq(slackSharedInstallations.workspaceId, workspaceId));
    if (!installation) throw new Error("Missing Slack installation");
    await db.insert(mcpServers).values({
      id: serverId,
      url: "composio://slack",
      vendor: "Slack",
      title: "Brokered Shared Slack",
      provenance: "composio",
      accountMode: "shared",
      sharedVendorUserId,
    });
    await db.insert(mcpTools).values({ serverId, name, effect: "write" });
    await pluginStore.grant("mcp", ref, botId, admin.id);
    await db.insert(brokeredConnections).values({
      provider: "composio",
      app: "slack",
      holder: "deployment",
      vendorUserId: sharedVendorUserId,
      verified: true,
    });
    await sharedUse.setApproval({
      botId,
      serverId,
      by: admin.id,
      as: "admin",
      approval: { audience: "owner", outsideInput: false, members: [] },
    });
    const { inventoryRevision, capabilities } = await (
      await mounted.request(migration)
    ).json();
    for (const { key } of capabilities) {
      const binding = key === "legacy-account:composio:";
      const decision =
        key === `tool:${ref}` || binding
          ? {
              kind: "verified",
              inventoryRevision,
              targetId: binding ? installation.id : undefined,
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
        (await post("/decisions", { capability: key, decision })).status,
      ).toBe(204);
    }
    expect(
      (
        await post("/policies", {
          legacyTool: ref,
          botId,
          inventoryRevision,
          binding: { kind: "shared", installationId: installation.id },
          resources: ["C123"],
          evidence: {
            equivalentAppAndAction: "fixture/action",
            identityAndResources: "fixture/identity",
            preservedRestrictions: "fixture/policy",
            sharedAudienceAndOutsideInput: "fixture/audience",
          },
        })
      ).status,
    ).toBe(204);
    const ready = await (await mounted.request(migration)).json();
    expect(ready).toMatchObject({ ready: true, inventoryRevision });
    await createCorsairCutover(db, { workspaceId, app: "slack" }).activate(
      admin.id,
      async () =>
        ready.capabilities
          .filter(({ status }: { status: string }) => status === "disabled")
          .map(({ key }: { key: string }) => key),
    );
    const toolName = `mcp__${serverId}__${name}`;
    const callArgs = { channel: "C123", text: "Normal shared Bot post" };
    const invoke = (run: {
      actorId: string;
      botId: string;
      runId: string;
      threadId: string;
    }) =>
      withApprovalContext(
        {
          ...run,
          toolName,
          toolCallId: "shared-fixture-call",
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
    const run = {
      actorId: admin.id,
      botId,
      runId: randomUUID(),
      threadId: randomUUID(),
    };
    const count = writes.length;
    expect(
      await (await invoke({ ...run, actorId: member.id })).json(),
    ).toMatchObject({ isError: true });
    expect(await (await invoke(run)).json()).toMatchObject({
      isError: true,
      text: expect.stringContaining("waiting for your approval"),
    });
    const approval = (await stored.list(admin.id)).find(
      ({ action }) => action.toolRef === ref,
    );
    expect(approval?.action.target).toMatchObject({
      corsair: { installationId: installation.id },
    });
    expect(writes).toHaveLength(count);
    if (!approval) throw new Error("Missing Slack Shared approval");
    await stored.decide(admin.id, approval.id, "allow_once");
    expect(await (await invoke(run)).json()).toMatchObject({ isError: false });
    expect(writes.slice(count)).toMatchObject([
      { channel: callArgs.channel, text: callArgs.text },
    ]);
  } finally {
    await db
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.vendorUserId, sharedVendorUserId));
    await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
});
