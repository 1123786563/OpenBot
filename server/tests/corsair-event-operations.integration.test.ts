import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { responsibilityTriggers } from "../src/db/schema";
import { createCorsairEventOperations } from "../src/plugins/corsair/event-operations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const legacyTrigger = randomUUID();
afterAll(async () => {
  try {
    await database
      .delete(responsibilityTriggers)
      .where(eq(responsibilityTriggers.id, legacyTrigger));
  } finally {
    await database.$client.close();
  }
});

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
  const nativeTrigger = randomUUID();
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
    triggerPairs: [{ legacy: legacyTrigger, corsair: nativeTrigger }],
    providerHistoryRef: "record-27",
  };
  expect(await operations.handoff(key, "operator", proof)).toBeNull();
  const old = await operations.receiveLegacy({
    ...key,
    eventKey,
    eventType: "issues.opened",
    occurredAt,
    triggerIds: [legacyTrigger],
  });
  expect(old.owner).toBe("legacy");
  const {
    users,
    agents,
    responsibilities,
    responsibilityRuns,
    githubPilotConnections,
    githubPilotRepositories,
    githubPilotEventTriggers,
  } = await import("../src/db/schema");
  const { createResponsibilityStore } = await import(
    "../src/responsibilities/store"
  );
  const person = randomUUID();
  const agent = randomUUID();
  const goal = randomUUID();
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  await database.insert(agents).values({
    id: agent,
    name: "Test bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(responsibilities).values({
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
      filter: { eventTypes: ["issues.opened", "issues.edited"] },
    },
    createdAt: new Date(occurredAt.getTime() - 1000),
  });
  const { encryptSecret } = await import("../src/credentials");
  const { createGithubEventTriggers } = await import(
    "../src/plugins/corsair/event-triggers"
  );
  const { createGithubEventDispatch } = await import(
    "../src/plugins/corsair/event-dispatch"
  );
  const scope = { workspaceId: workspace, registration };
  const encryptionKey = Buffer.alloc(32, 27).toString("base64");
  const connectionId = randomUUID();
  const revision = randomUUID();
  await database.insert(githubPilotConnections).values({
    ...scope,
    id: connectionId,
    revision,
    personId: person,
    githubUserId: "1",
    login: "owner",
    credential: await encryptSecret(encryptionKey, "fixture-token"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const resource = { installationId: "654", repositoryId: "321" };
  await database.insert(githubPilotRepositories).values({
    ...scope,
    ...resource,
    nodeId: "fixture-node",
    name: "owner/repo",
  });
  await database.insert(githubPilotEventTriggers).values({
    ...scope,
    ...resource,
    id: nativeTrigger,
    goalId: goal,
    connectionId,
    connectionRevision: revision,
    repositoryNodeId: "fixture-node",
    eventTypes: ["issues.opened"],
    createdAt: new Date(occurredAt.getTime() - 1000),
  });
  let providerAvailable = false;
  const triggers = createGithubEventTriggers({
    ...scope,
    database,
    encryptionKey,
    checkRepository: async () => (providerAvailable ? "allowed" : "retry"),
  });
  const dispatcher = createGithubEventDispatch({
    ...scope,
    database,
    operations,
    triggers,
    isolatedSources: new Set(),
    retryMs: 0,
  });
  const ingress = createGithubEventIngress({
    database,
    workspaceId: workspace,
    registration,
    secret: "local-fixture",
    operations,
    planAccepted: dispatcher.planAccepted,
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
  const initial = await deliver(body);
  expect(initial.status).toBe(202);
  const [shadow] = await operations
    .report(key)
    .then((rows) => rows.filter((row) => row.entry === "corsair"));
  expect(shadow?.outcomes).toEqual([
    expect.objectContaining({ triggerId: nativeTrigger, outcome: "review" }),
  ]);
  expect(await operations.handoff(key, "operator", proof)).toBeNull();
  const { createTriggerIngressRoutes } = await import(
    "../src/responsibilities/trigger-routes"
  );
  const store = createResponsibilityStore(database, {
    resolveTarget: async () => ({ threadId: "fixture" }),
  });
  let legacyNow = Date.now();
  const legacyRoute = createTriggerIngressRoutes({
    now: () => legacyNow,
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
          filter: { eventTypes: ["issues.opened", "issues.edited"] },
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
  await database
    .update(responsibilityTriggers)
    .set({
      config: {
        kind: "github",
        repository: "owner/repo",
        filter: {
          eventTypes: ["issues.opened", "issues.edited"],
          field: { path: "issue.title", equals: "fixture" },
        },
      },
    })
    .where(eq(responsibilityTriggers.id, legacyTrigger));
  expect(await operations.handoff(key, "operator", proof)).toBeNull();
  await database
    .update(responsibilityTriggers)
    .set({
      config: {
        kind: "github",
        repository: "owner/repo",
        filter: {
          eventTypes: ["issues.opened", "issues.edited"],
        },
      },
    })
    .where(eq(responsibilityTriggers.id, legacyTrigger));
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
    receiptId: shadow?.id,
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
        installationId: "654",
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
  const postCutoff = await deliver(postCutoffEvent);
  expect(postCutoff.status).toBe(202);
  const { receiptId } = await postCutoff.json();
  await dispatcher.sweep();
  expect(await operations.report(key)).toContainEqual(
    expect.objectContaining({
      eventKey: postKey,
      entry: "corsair",
      pilotDispatch: true,
      outcomes: [
        expect.objectContaining({ triggerId: nativeTrigger, outcome: "retry" }),
      ],
    }),
  );
  const recovery = {
    receiptId,
    triggerId: nativeTrigger,
    historyRef: "provider-delivery-history",
  };
  expect(await operations.replay(key, "operator", recovery)).toBe(true);
  providerAvailable = true;
  await dispatcher.sweep();
  await dispatcher.sweep();
  expect(await operations.replay(key, "operator", recovery)).toBe(false);
  expect(await (await deliver(postCutoffEvent)).json()).toMatchObject({
    duplicate: true,
    receiptId,
  });
  const suspendedEvent = postCutoffEvent.replace(
    '"id":2,"number":2',
    '"id":3,"number":3',
  );
  const suspendedResponse = await deliver(suspendedEvent);
  expect(suspendedResponse.status).toBe(202);
  const skippedReceipt = (await suspendedResponse.json()).receiptId;
  expect(
    await operations.replay(key, "operator", {
      ...recovery,
      receiptId: skippedReceipt,
      decision: "account-inactive",
    }),
  ).toBe(true);
  expect(
    await operations.replay(key, "operator", {
      ...recovery,
      receiptId: skippedReceipt,
    }),
  ).toBe(false);
  await dispatcher.sweep();

  legacyNow = cutoff.getTime() + 1000;
  for (const [action, id, timestamp, installation] of [
    ["opened", 5, { created_at: cutoff.toISOString() }, { id: 655 }],
    ["edited", 6, { created_at: cutoff.toISOString() }, { id: 654 }],
    ["opened", 7, { created_at: cutoff.toISOString() }, undefined],
  ] as const) {
    const raw = JSON.stringify({
      action,
      repository: { id: 321, full_name: "owner/repo" },
      installation,
      issue: { id, number: id, ...timestamp },
    });
    expect(await (await sendLegacy(raw)).json()).toMatchObject({
      queued: true,
      duplicate: false,
    });
    expect((await deliver(raw)).status).toBe(202);
    await dispatcher.sweep();
    expect(await (await sendLegacy(raw)).json()).toMatchObject({
      queued: true,
      duplicate: true,
    });
  }

  const missingTimestamp = JSON.stringify({
    action: "opened",
    repository: { id: 321, full_name: "owner/repo" },
    installation: { id: 654 },
    issue: { id: 8, number: 8 },
  });
  expect(await (await sendLegacy(missingTimestamp)).json()).toMatchObject({
    queued: false,
    reason: "Historical Trigger eligibility requires review.",
  });

  legacyNow += 6 * 60_000;
  const unverifiedLegacyEvent = body.replace(
    '"id":1,"number":1',
    '"id":4,"number":4',
  );
  expect(await (await sendLegacy(unverifiedLegacyEvent)).json()).toMatchObject({
    queued: false,
    reason: "Historical Trigger eligibility requires review.",
  });
  expect(
    await database
      .select()
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.responsibilityId, goal)),
  ).toHaveLength(5);
});

test("captures only selected signed deliveries and expires private evidence after seven days", async () => {
  const { createHmac, randomBytes } = await import("node:crypto");
  const { eq, sql } = await import("drizzle-orm");
  const { corsairEvents } = await import("../src/db/schema/corsair-storage");
  const { createGithubEventIngress } = await import(
    "../src/plugins/corsair/event-ingress"
  );
  const workspaceId = randomUUID();
  const registration = randomUUID();
  const captureId = randomUUID();
  const operations = createCorsairEventOperations(database, workspaceId, {
    githubRegistration: registration,
    rawEvidence: {
      encryptionKey: randomBytes(32).toString("base64"),
      deliveries: new Set([`github:${captureId}`]),
    },
  });
  const secret = "issue-27-evidence-fixture";
  const ingress = createGithubEventIngress({
    database,
    workspaceId,
    registration,
    secret,
    operations,
  });
  const body = (number: number) =>
    JSON.stringify({
      action: "opened",
      installation: { id: 654 },
      repository: { id: 321, full_name: "owner/repo" },
      issue: {
        id: number,
        number,
        created_at: new Date().toISOString(),
        body: "private content",
      },
    });
  const send = (id: string, raw: string, signingKey = secret) =>
    ingress.request("/webhook", {
      method: "POST",
      body: raw,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": id,
        "x-hub-signature-256": `sha256=${createHmac("sha256", signingKey).update(raw).digest("hex")}`,
      },
    });
  const selected = body(1);
  expect((await send(captureId, selected, "invalid")).status).toBe(401);
  const result = await send(captureId, selected);
  expect(result.status).toBe(202);
  const { receiptId } = await result.json();
  let allowed = true;
  expect(await operations.readEvidence(receiptId, async () => allowed)).toEqual(
    Buffer.from(selected),
  );
  allowed = false;
  expect(
    await operations.readEvidence(receiptId, async () => allowed),
  ).toBeNull();

  const later = await send(randomUUID(), body(2));
  expect(later.status).toBe(202);
  expect(
    await operations.readEvidence(
      (await later.json()).receiptId,
      async () => true,
    ),
  ).toBeNull();
  const rows = await database
    .select()
    .from(corsairEvents)
    .where(eq(corsairEvents.workspaceId, workspaceId));
  expect(JSON.stringify(rows)).not.toContain("private content");
  const evidence = rows.find(
    (row) => row.eventType === "openbot.events.raw-evidence",
  );
  if (!evidence) throw new Error("Missing encrypted evidence");
  await database
    .update(corsairEvents)
    .set({ createdAt: sql`clock_timestamp() - interval '168 hours'` })
    .where(eq(corsairEvents.id, evidence.id));
  expect(await operations.readEvidence(receiptId, async () => true)).toBeNull();
  await operations.expireEvidence();
  expect(
    await database
      .select()
      .from(corsairEvents)
      .where(eq(corsairEvents.id, evidence.id)),
  ).toEqual([]);
  expect(
    await operations.report({ provider: "github", source: "321" }),
  ).toHaveLength(2);
});
