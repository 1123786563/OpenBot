import { afterAll, expect, test } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agents,
  corsairEventDispatches,
  corsairEvents,
  responsibilities,
  responsibilityRuns,
  responsibilityTriggers,
  slackPilotConnections,
  slackSharedInstallations,
  users,
  workItems,
} from "../src/db/schema";
import { createSlackEventReader } from "../src/plugins/corsair/slack/event-reader";
import { createSlackEventPilot } from "../src/plugins/corsair/slack/events";
import { RESPONSIBILITY_RUN_KIND } from "../src/responsibilities/engine";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const fixtureGoalIds: string[] = [];
afterAll(async () => {
  try {
    if (fixtureGoalIds.length) {
      const runIds = database
        .select({ id: responsibilityRuns.id })
        .from(responsibilityRuns)
        .where(inArray(responsibilityRuns.responsibilityId, fixtureGoalIds));
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
            inArray(workItems.key, runIds),
          ),
        );
    }
  } finally {
    await database.$client.close();
  }
});

const envelopeIdentity = {
  appId: "A123",
  teamId: "T123",
  botId: "B123",
  botUserId: "U123",
};
const secret = "slack-fixture-signing-secret";
const timestamp = Math.floor(Date.now() / 1000);
const envelope = {
  type: "event_callback",
  api_app_id: envelopeIdentity.appId,
  team_id: envelopeIdentity.teamId,
  event_id: "Ev123",
  event_time: timestamp,
  authorizations: [
    {
      team_id: envelopeIdentity.teamId,
      user_id: envelopeIdentity.botUserId,
      is_bot: true,
    },
  ],
  event: {
    type: "message",
    channel: "C123",
    user: "U456",
    ts: `${timestamp}.123`,
    text: "hello",
  },
};

function request(
  body = JSON.stringify(envelope),
  signingSecret = secret,
  time = timestamp,
) {
  return {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(time),
      "x-slack-signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${time}:${body}`).digest("hex")}`,
    },
    body,
  };
}

test("acknowledges signed events only after recording a durable workspace receipt", async () => {
  const workspaceId = randomUUID();
  await database.insert(slackSharedInstallations).values({
    ...envelopeIdentity,
    workspaceId,
    channelIds: ["C123"],
  });
  const deliver = (input: ReturnType<typeof request>) => {
    const pilot = createSlackEventPilot({
      database,
      workspaceId,
      identity: envelopeIdentity,
      secret,
      checkMember: async () => "allowed",
    });
    const args: Parameters<typeof createApp> = [
      loadConfig(
        testEnvironment({
          DATABASE_URL: testDatabaseUrl(),
          KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        }),
      ),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => null },
      },
      { rolesForUser: async () => [] },
    ];
    args[34] = { slackEventRoutes: pilot.routes };
    return createApp(...args).request("/api/corsair/slack/webhook", input);
  };
  expect((await deliver(request(undefined, "wrong"))).status).toBe(401);
  expect(
    (await deliver(request(undefined, secret, timestamp - 301))).status,
  ).toBe(401);
  expect(
    (await deliver(request(JSON.stringify({ ...envelope, team_id: "T999" }))))
      .status,
  ).toBe(403);
  expect(
    await (
      await deliver(
        request(
          JSON.stringify({
            type: "url_verification",
            challenge: "fixture-challenge",
          }),
        ),
      )
    ).json(),
  ).toEqual({ challenge: "fixture-challenge" });
  expect((await deliver(request())).status).toBe(200);
  expect((await deliver(request())).status).toBe(200);
  const receipts = await database
    .select()
    .from(corsairEvents)
    .where(eq(corsairEvents.workspaceId, workspaceId));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.status).toBe("pending");
  expect(
    (
      await deliver(
        request(
          JSON.stringify({
            ...envelope,
            event: { ...envelope.event, text: "changed" },
          }),
        ),
      )
    ).status,
  ).toBe(409);
});

test("isolates read grants and recovers per-trigger fanout, then blocks a queued run after revocation", async () => {
  const teamId = `T${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
  const identity = { ...envelopeIdentity, teamId };
  const workspaceId = randomUUID();
  const otherWorkspace = randomUUID();
  const personIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const botId = randomUUID();
  const goalIds = personIds.map(() => randomUUID());
  fixtureGoalIds.push(...goalIds);
  const triggerIds = personIds.map(() => randomUUID());
  const connectionIds = personIds.slice(0, 3).map(() => randomUUID());
  await database
    .insert(users)
    .values(personIds.map((id) => ({ id, email: `${id}@example.test` })));
  await database.insert(agents).values({
    id: botId,
    name: "Slack source",
    type: "built_in",
    configuration: {},
  });
  await database.insert(responsibilities).values(
    personIds.map((ownerUserId, i) => ({
      id: goalIds[i],
      ownerUserId,
      agentId: botId,
      channelId: "fixture-channel",
      threadId: "fixture-thread",
      title: "Observe",
      instruction: "Observe Slack",
      successCriteria: "Report",
    })),
  );
  await database.insert(responsibilityTriggers).values(
    personIds.map<typeof responsibilityTriggers.$inferInsert>(
      (ownerUserId, i) => ({
        id: triggerIds[i],
        ownerUserId,
        responsibilityId: goalIds[i],
        kind: "slack",
        config: {
          kind: "slack",
          teamId: identity.teamId,
          channels: ["C123"],
          mode: "message",
          phrases: [],
          reactions: [],
        },
        createdAt: new Date((timestamp - 1) * 1000),
      }),
    ),
  );
  await database.insert(slackSharedInstallations).values(
    [workspaceId, otherWorkspace].map((id) => ({
      ...identity,
      workspaceId: id,
      channelIds: ["C123"],
    })),
  );
  await database.insert(slackPilotConnections).values(
    connectionIds.map((id, i) => ({
      workspaceId,
      id,
      registration: "personal-fixture",
      personId: personIds[i],
      subjectScope: identity.teamId,
      userId: `U12${i}`,
      label: "Slack reader",
      credential: "fixture",
      revision: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    })),
  );

  let unavailable = true;
  const pilot = createSlackEventPilot({
    database,
    workspaceId,
    identity,
    secret,
    retryMs: 0,
    checkMember: async ({ slackUserId }) => {
      if (slackUserId === "U122") return "denied";
      if (slackUserId === "U121" && unavailable)
        throw new Error("Slack timeout");
      return "allowed";
    },
  });
  const other = createSlackEventPilot({
    database,
    workspaceId: otherWorkspace,
    identity,
    secret,
    checkMember: async () => "allowed",
  });
  async function outcomes(scope: string) {
    const rows = await database
      .select({
        triggerId: corsairEventDispatches.triggerId,
        outcome: corsairEventDispatches.outcome,
        runId: corsairEventDispatches.runId,
      })
      .from(corsairEventDispatches)
      .innerJoin(
        corsairEvents,
        eq(corsairEvents.id, corsairEventDispatches.receiptId),
      )
      .where(eq(corsairEvents.workspaceId, scope));
    return new Map(rows.map((row) => [row.triggerId, row]));
  }
  const delivery = (eventId = envelope.event_id) =>
    request(
      JSON.stringify({
        ...envelope,
        event_id: eventId,
        team_id: teamId,
        authorizations: [
          { team_id: teamId, user_id: identity.botUserId, is_bot: true },
        ],
      }),
    );
  expect((await pilot.routes.request("/webhook", delivery())).status).toBe(200);
  expect((await other.routes.request("/webhook", delivery())).status).toBe(200);
  await pilot.sweep();
  await other.sweep();
  const first = await outcomes(workspaceId);
  expect(triggerIds.map((id) => first.get(id)?.outcome)).toEqual([
    "queued",
    "retry",
    "denied",
    "denied",
  ]);
  expect(
    [...(await outcomes(otherWorkspace)).values()].map((row) => row.outcome),
  ).toEqual(Array(4).fill("denied"));
  unavailable = false;
  // Force the dispatch transaction to fail after it inserts the event, Run, and work item.
  // The UUID is generated by this test, and PostgreSQL DDL cannot bind this literal.
  const constraint = sql.identifier(`issue24_queue_failure_${triggerIds[1]}`);
  await database.execute(sql`alter table corsair_event_dispatches add constraint
    ${constraint} check (trigger_id <> ${sql.raw(`'${triggerIds[1]}'`)} or outcome <> 'queued') not valid`);
  try {
    await expect(pilot.sweep()).rejects.toThrow();
    expect((await outcomes(workspaceId)).get(triggerIds[1])?.outcome).toBe(
      "retry",
    );
    const rolledBack = await database
      .select()
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.responsibilityId, goalIds[1]));
    expect(rolledBack).toHaveLength(0);
  } finally {
    await database.execute(
      sql`alter table corsair_event_dispatches drop constraint ${constraint}`,
    );
  }
  await Promise.all([pilot.sweep(), pilot.sweep()]);
  expect((await pilot.routes.request("/webhook", delivery())).status).toBe(200);
  await pilot.sweep();
  const final = await outcomes(workspaceId);
  expect(triggerIds.map((id) => final.get(id)?.outcome)).toEqual([
    "queued",
    "queued",
    "denied",
    "denied",
  ]);
  expect(final.get(triggerIds[0])?.runId).toBe(first.get(triggerIds[0])?.runId);
  const runId = final.get(triggerIds[1])?.runId;
  if (!runId) throw new Error("Expected the recovered run");
  await database
    .delete(slackPilotConnections)
    .where(eq(slackPilotConnections.id, connectionIds[1]));
  const store = createResponsibilityStore(database, {
    resolveTarget: async () => ({ threadId: "fixture-thread" }),
    slackEventAccess: pilot,
  });
  expect(await store.beginRun(runId)).toBeNull();
  const [run] = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.id, runId));
  expect(run?.status).toBe("skipped");
  expect(run?.error).toBe("Slack event read authorization ended.");
  const runs = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.responsibilityId, goalIds[0]));
  expect(runs).toHaveLength(1);
  expect(
    (await pilot.routes.request("/webhook", delivery("Ev124"))).status,
  ).toBe(200);
  await pilot.sweep();
  const ownerRuns = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.responsibilityId, goalIds[1]));
  expect(ownerRuns).toHaveLength(1);
});

test("the Slack reader distinguishes a timeout from a completed membership denial", async () => {
  let mode = "timeout";
  const check = createSlackEventReader(
    { ...envelopeIdentity, token: "xoxb-fixture" },
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        expect(request.headers.get("authorization")).toBe(
          "Bearer xoxb-fixture",
        );
        switch (url.pathname) {
          case "/api/auth.test":
            expect(request.method).toBe("POST");
            return Response.json({
              ok: true,
              team_id: "T123",
              user_id: "U123",
              bot_id: "B123",
            });
          case "/api/conversations.info":
            return Response.json({
              ok: true,
              channel: {
                id: "C123",
                context_team_id: "T123",
                is_archived: false,
                is_ext_shared: false,
                is_member: true,
              },
            });
          case "/api/conversations.members":
            if (mode === "timeout")
              throw new DOMException("Fixture timeout", "TimeoutError");
            if (mode === "not_in_channel")
              return Response.json({ ok: false, error: mode });
            if (mode === "member" && !url.searchParams.has("cursor"))
              return Response.json({
                ok: true,
                members: [],
                response_metadata: { next_cursor: "next" },
              });
            return Response.json({
              ok: true,
              members: mode === "member" ? ["U456"] : [],
            });
          default:
            throw new Error("Unexpected Slack request");
        }
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const source = { channelId: "C123", slackUserId: "U456" };
  expect(await check(source)).toBe("retry");
  mode = "not_in_channel";
  expect(await check(source)).toBe("denied");
  mode = "nonmember";
  expect(await check(source)).toBe("denied");
  mode = "member";
  expect(await check(source)).toBe("allowed");
});
