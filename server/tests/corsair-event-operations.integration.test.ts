import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { createCorsairEventOperations } from "../src/plugins/corsair/event-operations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.close());

test("journals a legacy receipt before dispatch and alerts once for a missing Trigger result", async () => {
  const operations = createCorsairEventOperations(database, randomUUID());
  const key = {
    provider: "slack",
    source: "T123/C123",
    eventKey: "Ev123",
  } as const;
  const receivedAt = new Date("2026-01-01T10:00:00Z");
  const receipt = await operations.receiveLegacy({
    ...key,
    eventType: "message",
    triggerIds: ["trigger-1", "trigger-2"],
    receivedAt,
  });
  await operations.finishLegacy(receipt.id, "trigger-1", {
    status: "ignored",
    reason: "filter",
  });
  expect(await operations.alert(new Date("2026-01-01T10:15:00Z"))).toEqual([]);
  expect(await operations.alert(new Date("2026-01-01T10:15:01Z"))).toEqual([
    expect.objectContaining({
      ...key,
      triggerId: "trigger-2",
      outcome: "pending",
    }),
  ]);
  expect(await operations.alert(new Date("2026-01-01T10:16:00Z"))).toEqual([]);
  const events = await operations.report(key);
  expect(events).toEqual([
    expect.objectContaining({
      ...key,
      outcomes: [
        expect.objectContaining({
          triggerId: "trigger-1",
          outcome: "ineligible",
          reason: "filter",
        }),
        expect.objectContaining({ triggerId: "trigger-2", outcome: "pending" }),
      ],
    }),
  ]);
});

test("blocks handoff without matching receipts and per-Trigger evidence, then pins redeliveries to the original path", async () => {
  const workspace = randomUUID();
  const registration = randomUUID();
  const operations = createCorsairEventOperations(database, workspace, {
    githubRegistration: registration,
  });
  const key = { provider: "github", source: "321" } as const;
  const legacyTrigger = randomUUID();
  const { createGithubEventIngress } = await import(
    "../src/plugins/corsair/event-ingress"
  );
  const { createHmac, createHash } = await import("node:crypto");
  const occurredAt = new Date(Date.now() - 1000);
  const body = JSON.stringify({
    action: "opened",
    repository: { id: 321, full_name: "owner/repo" },
    installation: { id: 654 },
    issue: { id: 1, number: 1, created_at: occurredAt.toISOString() },
  });
  const eventKey = createHash("sha256").update(body).digest("hex");
  const proof = {
    eventKeys: [eventKey],
    triggerPairs: [{ legacy: legacyTrigger, corsair: "new" }],
    providerHistoryRef: "record-27",
  };
  const ingress = createGithubEventIngress({
    database,
    workspaceId: workspace,
    registration,
    secret: "local-fixture",
    operations,
  });
  const deliver = (raw: string) =>
    ingress.request("/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "local-fixture").update(raw).digest("hex")}`,
      },
      body: raw,
    });
  expect(await operations.handoff(key, "operator", proof)).toBeNull();
  const old = await operations.receiveLegacy({
    ...key,
    eventKey,
    eventType: "issues.opened",
    occurredAt,
    triggerIds: [legacyTrigger],
  });
  expect(old.owner).toBe("legacy");
  const initial = await deliver(body);
  expect(initial.status).toBe(202);
  expect(await operations.handoff(key, "operator", proof)).toBeNull();
  const { eq } = await import("drizzle-orm");
  const { corsairEvents, corsairEventDispatches } = await import(
    "../src/db/schema/corsair-storage"
  );
  const [shadow] = await operations
    .report(key)
    .then((rows) => rows.filter((row) => row.entry === "corsair"));
  if (!shadow) throw new Error("Missing native receipt");
  await database
    .update(corsairEvents)
    .set({ disposition: "observed", fanoutAt: new Date() })
    .where(eq(corsairEvents.id, shadow.id));
  await database
    .insert(corsairEventDispatches)
    .values({ receiptId: shadow.id, triggerId: "new", outcome: "review" });
  const { users, agents, responsibilities, responsibilityTriggers } =
    await import("../src/db/schema");
  const { createResponsibilityStore } = await import(
    "../src/responsibilities/store"
  );
  const person = randomUUID();
  const agent = randomUUID();
  const goal = randomUUID();
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  await database
    .insert(agents)
    .values({
      id: agent,
      name: "Test bot",
      type: "built_in",
      configuration: {},
    });
  await database
    .insert(responsibilities)
    .values({
      id: goal,
      ownerUserId: person,
      agentId: agent,
      channelId: "fixture",
      threadId: "fixture",
      title: "Test",
      instruction: "Test",
      successCriteria: "Test",
    });
  await database.insert(responsibilityTriggers).values({
    id: legacyTrigger,
    ownerUserId: person,
    responsibilityId: goal,
    kind: "github",
    config: {
      kind: "github",
      repository: "owner/repo",
      filter: { eventTypes: [] },
    },
    createdAt: new Date(occurredAt.getTime() - 1000),
  });
  const { createTriggerIngressRoutes } = await import(
    "../src/responsibilities/trigger-routes"
  );
  const store = createResponsibilityStore(database, {
    resolveTarget: async () => ({ threadId: "fixture" }),
  });
  const legacyRoute = createTriggerIngressRoutes({
    corsairEvents: operations,
    ingest: store.ingestEvent,
    directory: {
      slackTriggers: async () => [],
      resolve: async () => ({
        id: legacyTrigger,
        ownerUserId: person,
        responsibilityId: goal,
        kind: "github",
        responsibilityStatus: "active",
        secret: "local-fixture",
        enabled: true,
        createdAt: new Date(occurredAt.getTime() - 1000),
        config: {
          kind: "github",
          repository: "owner/repo",
          filter: { eventTypes: [] },
        },
      }),
    },
  });
  const sendLegacy = (raw: string) =>
    legacyRoute.request(`/${legacyTrigger}`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "local-fixture").update(raw).digest("hex")}`,
      },
      body: raw,
    });
  expect(await (await sendLegacy(body)).json()).toMatchObject({
    queued: true,
    duplicate: false,
  });
  const cutoff = await operations.handoff(key, "operator", proof);
  expect(cutoff).toBeInstanceOf(Date);
  if (!cutoff) throw new Error("Missing cutoff");
  expect(
    await operations.receiveLegacy({
      ...key,
      eventKey,
      eventType: "issues.opened",
      occurredAt,
      triggerIds: [legacyTrigger],
    }),
  ).toEqual(old);
  expect(await (await deliver(body)).json()).toEqual({
    receiptId: shadow.id,
    duplicate: true,
  });
  const postCutoffEvent = JSON.stringify({
    action: "opened",
    repository: { id: 321, full_name: "owner/repo" },
    installation: { id: 654 },
    issue: { id: 2, number: 2, created_at: cutoff.toISOString() },
  });
  const postKey = createHash("sha256").update(postCutoffEvent).digest("hex");
  expect(
    (
      await operations.receiveLegacy({
        ...key,
        eventKey: postKey,
        eventType: "issues.opened",
        occurredAt: cutoff,
        triggerIds: [legacyTrigger],
      })
    ).owner,
  ).toBe("corsair");
  expect(await (await sendLegacy(postCutoffEvent)).json()).toMatchObject({
    queued: false,
  });
  expect(await (await sendLegacy(body)).json()).toMatchObject({
    queued: true,
    duplicate: true,
  });
  expect((await deliver(postCutoffEvent)).status).toBe(202);
  expect(await operations.report(key)).toContainEqual(
    expect.objectContaining({
      eventKey: postKey,
      entry: "corsair",
      pilotDispatch: true,
    }),
  );
});
