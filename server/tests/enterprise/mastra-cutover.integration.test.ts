import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createWakeUpStore } from "../../src/agents/wake-up";
import type { Database } from "../../src/db/client";
import { users } from "../../src/db/schema/core";
import { enterpriseConversations } from "../../src/db/schema/enterprise-conversations";
import {
  enterpriseRunAttempts,
  enterpriseRuns,
} from "../../src/db/schema/enterprise-runs";
import {
  enterprisePrincipals,
  enterpriseWorkspaceMemberships,
} from "../../src/db/schema/enterprise-tenancy";
import { mastraMessageIntents } from "../../src/db/schema/mastra-message-intents";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { hasActiveAttemptLease } from "../../src/enterprise/runs/store";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  createMastraContinuationStore,
  mastraEngineFingerprint,
} from "../../src/mastra/continuation-store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import {
  type CutoverFenceRecord,
  conversationServiceWriter,
  createAdminTxRunner,
  createCutoverSwitchPorts,
  createPostgresLegacyOwnershipPorts,
  createPostgresTargetReader,
  runCutover,
  runCutoverRollback,
} from "../../src/mastra/cutover";
import type {
  ClaimedContinuation,
  ContinuationPayload,
  ExecutionBinding,
  ResumeDecision,
} from "../../src/mastra/execution-contracts";
import {
  type CutoverRunStore,
  type IntelligenceThreadSummary,
  LEGACY_IMPORT_KEY_PREFIX,
  type LegacyImportSource,
  runApply,
  runVerify,
  stagingStatusOf,
} from "../../src/mastra/legacy-import";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import { argsDigestFor } from "../../src/mastra/tools";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME14 (#486) integration: the single-writer switch, the in-flight
 * disposition ledger and the no-data-loss rollback against REAL PostgreSQL.
 * TWO INSTANCES (two independent service/storage/connection stacks over the
 * same database, standing in for two replicas) run a mixed in-flight
 * fixture: a live run, a compatible pause carrying a mastra continuation,
 * an incompatible pause with none, and a pre-switch-prepared old writer.
 *
 * The mandated rehearsals: the gates refuse an undispositioned/undrained
 * scope before ANY write; an interrupted switch resumes without re-bumping;
 * after the switch the old writer's append fails with its intent left
 * pending and nothing overwritten while a new writer lands; a pause
 * converts across instances; rollback with new messages keeps every one of
 * them and records the preservation receipt; anything unprovable parks the
 * scope in maintenance with the reason.
 */

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me14-tenant-${suffix}`;
const workspaceA = `me14-ws-${suffix}`;
const ownerActor = `me14-actor-${suffix}`;
const ownerPrincipal = `me14-principal-${suffix}`;
const fixtureId = `me14-fixture-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let directory: DirectoryDatabase;
let dataA: DataDatabase;
let dataB: DataDatabase;
let operator: OperatorDatabase;
let scopeA: PlatformScope;
let serviceA: ReturnType<typeof createConversationService>;
let serviceB: ReturnType<typeof createConversationService>;
let ports: ReturnType<typeof createPostgresLegacyOwnershipPorts>;
let targetReader: ReturnType<typeof createPostgresTargetReader>;
let continuationStoreA: ReturnType<typeof createMastraContinuationStore>;
let continuationStoreB: ReturnType<typeof createMastraContinuationStore>;
let memoryMessagesTable: string;

const threads = {
  main1: `me14-thread-1-${suffix}`,
  main2: `me14-thread-2-${suffix}`,
  pause: `me14-thread-pause-${suffix}`,
  iso: `me14-thread-iso-${suffix}`,
  pending: `me14-thread-pending-${suffix}`,
  active: `me14-thread-active-${suffix}`,
};

const run1 = `me14-run-1-${suffix}`;
const runF1 = `me14-run-f1-${suffix}`;
const run2 = `me14-run-2-${suffix}`;
const run3 = `me14-run-3-${suffix}`;

const inFlightRuns = {
  active: "11111111-1111-4111-8111-000000000001",
  pause: "11111111-1111-4111-8111-000000000002",
  iso: "11111111-1111-4111-8111-000000000003",
  oldLease: "11111111-1111-4111-8111-000000000004",
};

function stateStore(): CutoverRunStore & { snapshot: () => unknown } {
  const holder: { state: unknown } = { state: null };
  return {
    async load() {
      return holder.state;
    },
    async save(next: unknown) {
      holder.state = JSON.parse(JSON.stringify(next));
    },
    snapshot: () => holder.state,
  };
}

const store1 = stateStore();
const storeF1 = stateStore();
const store2 = stateStore();
const store3 = stateStore();

function makeSwitchPorts(database: Database) {
  const inner = createCutoverSwitchPorts(createAdminTxRunner(database));
  const bumps: { threadId: string }[] = [];
  return {
    async conversationBackend(tenantId: string, threadId: string) {
      return inner.conversationBackend(tenantId, threadId);
    },
    async bumpBackendVersion(
      tenantId: string,
      threadId: string,
      expectedVersion: number,
    ) {
      bumps.push({ threadId });
      return inner.bumpBackendVersion(tenantId, threadId, expectedVersion);
    },
    async inFlightRunsInScope(tenantId: string, workspaceId: string) {
      return inner.inFlightRunsInScope(tenantId, workspaceId);
    },
    async foreignIntents(tenantId: string, threadId: string) {
      return inner.foreignIntents(tenantId, threadId);
    },
    bumps,
  };
}

let switchPorts: ReturnType<typeof makeSwitchPorts>;

// ---------------------------------------------------------------------------
// The Intelligence-shaped source fixture (the ME13 read shape)
// ---------------------------------------------------------------------------

class SourceFixture implements LegacyImportSource {
  readonly messages = new Map<
    string,
    { id: string; role: string; content?: unknown }[]
  >();

  async listThreads() {
    return {
      threads: [...this.messages.keys()].map(
        (id): IntelligenceThreadSummary => ({
          id,
          createdAt: "2026-01-01T00:00:00Z",
        }),
      ),
      nextCursor: null,
    };
  }

  async getThreadMessages(params: { threadId: string }) {
    return { messages: this.messages.get(params.threadId) ?? [] };
  }
}

function sourceFor(threadIds: readonly string[]): SourceFixture {
  const source = new SourceFixture();
  for (const threadId of threadIds) {
    // Content keyed on the THREAD, not the scan position: the same thread
    // re-imported by a later run must plan the SAME digest or verify would
    // (correctly) call it a mismatch.
    source.messages.set(threadId, [
      {
        id: `src-${threadId}-1`,
        role: "user",
        content: `imported ${threadId}`,
      },
    ]);
  }
  return source;
}

const scan = {
  mode: "scan",
  userId: ownerActor,
  agentId: "me14-agent",
} as const;

// The ONE source per run, shared by its apply AND verify passes (verify
// re-plans the same source; a changed source is a different migration).
const source1 = sourceFor([
  threads.main1,
  threads.main2,
  threads.pause,
  threads.iso,
]);
const sourceF1 = sourceFor([threads.pending]);
const source2 = sourceFor([threads.main2]);
const source3 = sourceFor([threads.iso]);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function backendOf(threadId: string) {
  const [row] = await admin
    .select({
      backend: enterpriseConversations.storageBackend,
      version: enterpriseConversations.backendVersion,
    })
    .from(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantA),
        eq(enterpriseConversations.threadId, threadId),
      ),
    )
    .limit(1);
  return row;
}

async function insertConversationRow(threadId: string) {
  await admin.insert(enterpriseConversations).values({
    id: randomUUID(),
    tenantId: tenantA,
    workspaceId: workspaceA,
    principalId: ownerPrincipal,
    threadId,
    storageBackend: "mastra",
  });
}

function mastraMessageId(tenantId: string, threadId: string, key: string) {
  return createHash("sha256")
    .update(`${tenantId}\0${threadId}\0${key}`)
    .digest("hex");
}

function digestOf(content: string) {
  return createHash("sha256")
    .update(JSON.stringify({ content, attachments: [] }))
    .digest("hex");
}

/** A pre-switch-prepared foreign intent: an old writer's pending write. */
async function insertPendingForeignIntent(input: {
  threadId: string;
  clientMessageKey: string;
  content: string;
  backendVersion: number;
  reservedSeq?: number;
}) {
  await admin.insert(mastraMessageIntents).values({
    tenantId: tenantA,
    threadId: input.threadId,
    clientMessageKey: input.clientMessageKey,
    messageId: mastraMessageId(tenantA, input.threadId, input.clientMessageKey),
    digest: digestOf(input.content),
    reservedSeq: input.reservedSeq ?? 99,
    actorId: scopeA.actorId,
    principalId: scopeA.principalId,
    backendVersion: input.backendVersion,
    attachmentIds: [],
    state: "pending",
  });
}

async function insertRun(input: {
  id: string;
  threadId: string;
  status: "queued" | "running" | "waiting_approval" | "suspended" | "succeeded";
  leaseExpiresAt: Date;
  clientMessageKey: string;
}): Promise<string | null> {
  await admin.execute(sql`
    insert into enterprise_runs
      (id, tenant_id, workspace_id, principal_id, thread_id, client_message_key,
       expert_version_ref, model_route_ref, model_route_maximum_tokens,
       status, lease_expires_at, attempt_generation)
    values (
      ${input.id}::uuid, ${tenantA}, ${workspaceA}, ${ownerPrincipal}, ${input.threadId},
      ${input.clientMessageKey}, 'me14/expert@1', 'me14/route@1', 1000,
      ${input.status}, ${input.leaseExpiresAt.toISOString()}::timestamptz, 1
    )
    on conflict do nothing
  `);
  if (input.status === "succeeded") return null;
  const [attempt] = await admin
    .insert(enterpriseRunAttempts)
    .values({
      tenantId: tenantA,
      runId: input.id,
      generation: 1,
      status: "active",
      fencingToken: 1,
      leaseExpiresAt: input.leaseExpiresAt,
    })
    .returning({ id: enterpriseRunAttempts.id });
  return attempt?.id ?? null;
}

async function memoryRowCount(): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT count(*)::int AS count FROM ${sql.raw(memoryMessagesTable)}`,
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

async function foreignIntentCount(threadId: string): Promise<number> {
  const rows = (await admin.execute(sql`
    select count(*)::int as count from mastra_message_intents
    where tenant_id = ${tenantA} and thread_id = ${threadId}
      and client_message_key not like ${`${LEGACY_IMPORT_KEY_PREFIX}%`}
  `)) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

async function tenantSchemaName(): Promise<string> {
  const record = await fixture.registry.get(tenantA);
  if (!record) throw new Error("tenant storage not provisioned");
  return record.receipt.schemaName;
}

// ---------------------------------------------------------------------------
// The compatible pause's durable continuation shapes
// ---------------------------------------------------------------------------

const PAUSE_ARGS = JSON.stringify({ answer: "yes" });
const PAUSE_DIGEST = argsDigestFor(PAUSE_ARGS);

function pauseBinding(): ExecutionBinding {
  return {
    scope: scopeA,
    botId: "bot-pause",
    runId: inFlightRuns.pause,
    attemptId: "attempt-pause",
    generation: 1,
    executionKey: `exec-pause-${suffix}`,
    threadId: threads.pause,
  };
}

function pausePayload(): ContinuationPayload {
  return {
    schemaVersion: 1,
    engine: "mastra",
    packageFingerprint: mastraEngineFingerprint(),
    kind: "approval",
    toolCallId: "call_pause_1",
    toolName: "me14_pause_tool",
    argsDigest: PAUSE_DIGEST,
    snapshotRef: `suspended:snapshot:pause-${suffix}`,
  };
}

function approvedDecision(): ResumeDecision {
  return {
    kind: "approved",
    approvalId: `approval-pause-${suffix}`,
    argsDigest: PAUSE_DIGEST,
  };
}

const switchDispositions = {
  [inFlightRuns.pause]: { disposition: "convert-pause", effect: "receipted" },
  [inFlightRuns.iso]: {
    disposition: "isolate",
    note: "legacy engine parking",
  },
} as const;

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  directory = await fixture.openDirectory();
  dataA = await fixture.openData();
  dataB = await fixture.openData();
  operator = await fixture.openOperator();

  const provisioner = fixture.provisioner();
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });

  await admin.insert(users).values({
    id: ownerActor,
    email: `${ownerActor}@example.invalid`,
    name: "ME14 owner",
  });
  await admin.insert(enterprisePrincipals).values({
    id: ownerPrincipal,
    userId: ownerActor,
  });
  await provisionDeployment(operator, {
    operationId: `me14-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME14 tenant" },
    workspace: { id: workspaceA, name: "ME14 workspace" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  await admin.insert(enterpriseWorkspaceMemberships).values({
    tenantId: tenantA,
    workspaceId: workspaceA,
    principalId: ownerPrincipal,
  });

  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(directory, {
    authenticate: async (req) => {
      const actor = authenticated.get(req);
      return actor ? { actorId: actor, entrypoint: "web" as const } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceA,
  });
  const scopeRequest = new Request("https://me14.invalid/owner");
  authenticated.set(scopeRequest, ownerActor);
  scopeA = await resolver.resolve(scopeRequest);

  serviceA = createConversationService({
    data: dataA,
    mastraStorage: createTenantMastraStorage(fixture.lookup()),
  });
  serviceB = createConversationService({
    data: dataB,
    mastraStorage: createTenantMastraStorage(fixture.lookup()),
  });
  ports = createPostgresLegacyOwnershipPorts({
    admin: createAdminTxRunner(admin),
    directory,
  });
  targetReader = createPostgresTargetReader({
    admin: createAdminTxRunner(admin),
    storage: createTenantMastraStorage(fixture.lookup()),
    bindingFor: (scope, threadId) =>
      serviceA.resolveMastraBinding(scope, threadId),
  });
  // The continuation stores ride the app's own (superuser) database handle,
  // exactly like the production wiring in index.ts — the restricted data
  // capability role holds no grants on the control-plane continuation
  // tables. Two separate pools over the same database stand in for two
  // instances; the store's CAS is what makes them safe together.
  continuationStoreA = createMastraContinuationStore({
    database: fixture.openDatabase(fixture.adminUrl),
    secret: `me14-continuation-secret-${suffix}`,
  });
  continuationStoreB = createMastraContinuationStore({
    database: fixture.openDatabase(fixture.adminUrl),
    secret: `me14-continuation-secret-${suffix}`,
  });
  switchPorts = makeSwitchPorts(admin);

  for (const threadId of [
    threads.main1,
    threads.main2,
    threads.pause,
    threads.iso,
  ]) {
    await insertConversationRow(threadId);
  }
  // The tenant memory messages table, discovered from the catalog (the
  // mastra storage version owns the name; provisioning created the tables).
  const schemaName = await tenantSchemaName();
  const tables = (await admin.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schemaName} AND tablename LIKE '%messages%' ORDER BY tablename LIMIT 1`,
  )) as unknown as { tablename: string }[];
  const found = tables[0]?.tablename;
  if (!found)
    throw new Error(
      "tenant memory messages table not found after provisioning",
    );
  memoryMessagesTable = `"${schemaName}"."${found}"`;
});

afterAll(async () => {
  await fixture.drop();
});

const fullInventory = {
  entries: [
    { id: "chat-entry", disposition: "governed", note: "ME02 selector" },
    { id: "routine-firing", disposition: "governed", note: "ME09" },
    { id: "message-delivery", disposition: "governed", note: "ME10" },
    { id: "wake-up", disposition: "governed", note: "ME10" },
    { id: "approval-continuation", disposition: "governed", note: "ME10" },
    { id: "openmuse-task", disposition: "governed", note: "ME12" },
    { id: "handoff-delivery", disposition: "governed", note: "ME11" },
    {
      id: "legacy-history-reader",
      disposition: "reader-only",
      note: "ME13 import reader",
    },
  ],
};

test("the import earns its verified staging state through the real writer seams", async () => {
  const manifest = await runApply(
    {
      source: source1,
      ports,
      writer: conversationServiceWriter(serviceA),
      runStore: store1,
    },
    {
      runId: run1,
      scan,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  expect(manifest.phase).toBe("staging");
  const verify = await runVerify(
    { source: source1, ports, targetReader, runStore: store1 },
    { runId: run1, scan },
  );
  expect(verify.phase).toBe("verified");
  expect(stagingStatusOf(store1.snapshot())).toBe("verified");
});

test("F1 on the real database: a pending foreign intent blocks staging as target_not_empty", async () => {
  await insertConversationRow(threads.pending);
  await insertPendingForeignIntent({
    threadId: threads.pending,
    clientMessageKey: "live-writer-in-flight",
    content: "a live write the import must not race",
    backendVersion: 1,
  });
  const manifest = await runApply(
    {
      source: sourceF1,
      ports,
      writer: conversationServiceWriter(serviceA),
      runStore: storeF1,
    },
    {
      runId: runF1,
      scan,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  const entry = manifest.threads.find((t) => t.threadId === threads.pending);
  expect(entry?.status).toBe("quarantined");
  expect(entry?.reason).toBe("target_not_empty");
  // The pending intent is untouched — quarantine reads, never writes.
  const [intent] = await admin
    .select({ state: mastraMessageIntents.state })
    .from(mastraMessageIntents)
    .where(
      and(
        eq(mastraMessageIntents.tenantId, tenantA),
        eq(mastraMessageIntents.threadId, threads.pending),
        eq(mastraMessageIntents.clientMessageKey, "live-writer-in-flight"),
      ),
    )
    .limit(1);
  expect(intent?.state).toBe("pending");
});

test("the mixed in-flight fixture: an undrained live run refuses the switch before any write", async () => {
  await insertRun({
    id: inFlightRuns.active,
    threadId: threads.active,
    status: "running",
    leaseExpiresAt: new Date(Date.now() + 600_000),
    clientMessageKey: `me14-active-${suffix}`,
  });
  await insertRun({
    id: inFlightRuns.pause,
    threadId: threads.pause,
    status: "waiting_approval",
    leaseExpiresAt: new Date(Date.now() + 600_000),
    clientMessageKey: `me14-pause-${suffix}`,
  });
  await insertRun({
    id: inFlightRuns.iso,
    threadId: threads.iso,
    status: "suspended",
    leaseExpiresAt: new Date(Date.now() + 600_000),
    clientMessageKey: `me14-iso-${suffix}`,
  });
  // The compatible pause's durable mastra continuation, saved by instance B.
  const ref = await continuationStoreB.saveContinuation(
    pauseBinding(),
    pausePayload(),
  );
  expect(ref.continuationId).toBeTruthy();

  // The OLD WRITER prepares its append BEFORE any switch: a pending intent
  // at the current (pre-switch) writer generation.
  await insertPendingForeignIntent({
    threadId: threads.main1,
    clientMessageKey: `old-writer-${suffix}`,
    content: "the old writer's message",
    backendVersion: 1,
  });

  let refusal: unknown;
  try {
    await runCutover(
      { runStore: store1, switchPorts, engineVersion: mastraEngineFingerprint },
      {
        runId: run1,
        scope: { tenantId: tenantA, workspaceId: workspaceA },
        entryInventory: fullInventory,
        dispositions: switchDispositions,
        pauseAdmission: true,
      },
    );
  } catch (cause) {
    refusal = cause;
  }
  const message = (refusal as Error | undefined)?.message ?? "";
  expect(message).toContain("CUTOVER_GATES_FAILED");
  expect(message).toContain("drained");
  expect(message).toContain(inFlightRuns.active);
  // Not one thread moved.
  expect((await backendOf(threads.main1))?.version).toBe(1);
  expect((store1.snapshot() as { fence?: unknown }).fence).toBeUndefined();
});

test("the interrupted switch: a mid-scope blocker stops it with the completed threads recorded", async () => {
  // The live run drained; a blocker waits on main2.
  await admin
    .update(enterpriseRuns)
    .set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(enterpriseRuns.id, inFlightRuns.active));
  await admin
    .update(enterpriseConversations)
    .set({ storageBackend: "intelligence" })
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantA),
        eq(enterpriseConversations.threadId, threads.main2),
      ),
    );
  await expect(
    runCutover(
      { runStore: store1, switchPorts, engineVersion: mastraEngineFingerprint },
      {
        runId: run1,
        scope: { tenantId: tenantA, workspaceId: workspaceA },
        entryInventory: fullInventory,
        dispositions: switchDispositions,
        pauseAdmission: true,
      },
    ),
  ).rejects.toThrow("CUTOVER_SWITCH_BLOCKED");
  // main1 switched and recorded; the state says verified (incomplete).
  expect((await backendOf(threads.main1))?.version).toBe(2);
  const state = store1.snapshot() as {
    phase: string;
    fence?: CutoverFenceRecord;
  };
  expect(state.phase).toBe("verified");
  expect(state.fence?.threads.map((t) => t.threadId)).toEqual([threads.main1]);
  expect(state.fence?.threads[0]).toMatchObject({
    fromBackend: "mastra",
    fromBackendVersion: 1,
    toBackendVersion: 2,
  });
});

test("the resumed switch completes without re-bumping main1 and records the fence", async () => {
  await admin
    .update(enterpriseConversations)
    .set({ storageBackend: "mastra" })
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantA),
        eq(enterpriseConversations.threadId, threads.main2),
      ),
    );
  const manifest = await runCutover(
    { runStore: store1, switchPorts, engineVersion: mastraEngineFingerprint },
    {
      runId: run1,
      scope: { tenantId: tenantA, workspaceId: workspaceA },
      entryInventory: fullInventory,
      dispositions: switchDispositions,
      pauseAdmission: true,
    },
  );
  expect(manifest.phase).toBe("switched");
  const state = store1.snapshot() as { fence?: CutoverFenceRecord };
  expect(state.fence?.threads.map((t) => t.threadId).sort()).toEqual(
    [threads.main1, threads.main2, threads.pause].sort(),
  );
  // main1 was bumped EXACTLY once across both attempts.
  expect(
    state.fence?.threads.find((t) => t.threadId === threads.main1),
  ).toMatchObject({ fromBackendVersion: 1, toBackendVersion: 2 });
  expect((await backendOf(threads.main1))?.version).toBe(2);
  // The excluded thread never moved.
  expect(state.fence?.excludedThreadIds).toEqual([threads.iso]);
  expect((await backendOf(threads.iso))?.version).toBe(1);
  // The fence names the engine and its pinned-package fingerprint.
  expect(state.fence?.engine).toBe("mastra");
  expect(state.fence?.engineVersion).toBe(mastraEngineFingerprint());
});

test("AC4: the old writer's append fails after the switch — intent pending, nothing overwritten", async () => {
  const memoryBefore = await memoryRowCount();
  let error: unknown;
  try {
    await serviceB.append(scopeA, {
      threadId: threads.main1,
      clientMessageKey: `old-writer-${suffix}`,
      content: "the old writer's message",
      attachments: [],
    });
  } catch (cause) {
    error = cause;
  }
  expect((error as Error | undefined)?.message).toBe(
    "CONVERSATION_BACKEND_CHANGED",
  );
  const [intent] = await admin
    .select({ state: mastraMessageIntents.state })
    .from(mastraMessageIntents)
    .where(
      and(
        eq(mastraMessageIntents.tenantId, tenantA),
        eq(mastraMessageIntents.threadId, threads.main1),
        eq(mastraMessageIntents.clientMessageKey, `old-writer-${suffix}`),
      ),
    )
    .limit(1);
  expect(intent?.state).toBe("pending");
  expect(await memoryRowCount()).toBe(memoryBefore);
});

test("AC4: the finalize fence itself — the strengthened UPDATE refuses a stale-generation intent", async () => {
  const versionNow = (await backendOf(threads.main1))?.version ?? 0;
  await insertPendingForeignIntent({
    threadId: threads.main1,
    clientMessageKey: `finalize-probe-stale-${suffix}`,
    content: "stale generation",
    backendVersion: versionNow - 1,
    reservedSeq: 90,
  });
  const stale = (await admin.execute(sql`
    update mastra_message_intents set state = 'finalized', updated_at = now()
    where tenant_id = ${tenantA} and thread_id = ${threads.main1}
      and client_message_key = ${`finalize-probe-stale-${suffix}`}
      and state = 'pending'
      and backend_version = (select backend_version from enterprise_conversations
        where tenant_id = ${tenantA} and thread_id = ${threads.main1})
    returning client_message_key
  `)) as unknown as unknown[];
  expect(stale).toHaveLength(0);
  await insertPendingForeignIntent({
    threadId: threads.main1,
    clientMessageKey: `finalize-probe-current-${suffix}`,
    content: "current generation",
    backendVersion: versionNow,
    reservedSeq: 91,
  });
  const current = (await admin.execute(sql`
    update mastra_message_intents set state = 'finalized', updated_at = now()
    where tenant_id = ${tenantA} and thread_id = ${threads.main1}
      and client_message_key = ${`finalize-probe-current-${suffix}`}
      and state = 'pending'
      and backend_version = (select backend_version from enterprise_conversations
        where tenant_id = ${tenantA} and thread_id = ${threads.main1})
    returning client_message_key
  `)) as unknown as unknown[];
  expect(current).toHaveLength(1);
  // The probes were fence evidence, not history: remove them so the thread's
  // read path (which trusts finalized intents) sees only real messages.
  await admin.execute(sql`
    delete from mastra_message_intents
    where tenant_id = ${tenantA} and thread_id = ${threads.main1}
      and client_message_key in (${`finalize-probe-stale-${suffix}`}, ${`finalize-probe-current-${suffix}`})
  `);
});

test("AC3: a new writer lands on the switched thread — one writer, the new engine", async () => {
  const dto = await serviceB.append(scopeA, {
    threadId: threads.main1,
    clientMessageKey: `new-writer-${suffix}`,
    content: "the new engine's first message after the switch",
    attachments: [],
  });
  expect(dto.seq).toBeGreaterThan(0);
  const page = await serviceB.history(scopeA, {
    threadId: threads.main1,
    beforeSeq: null,
    limit: 100,
  });
  expect(
    page.items.some((message) => message.content.includes("after the switch")),
  ).toBe(true);
});

test("AC4: an expired lease cannot drive a new operation — the runs lease predicate refuses", async () => {
  const liveAttemptId = "22222222-2222-4222-8222-00000000000a";
  await insertRun({
    id: inFlightRuns.oldLease,
    threadId: threads.active,
    status: "running",
    leaseExpiresAt: new Date(Date.now() - 60_000),
    clientMessageKey: `me14-old-lease-${suffix}`,
  });
  await admin.execute(sql`
    update enterprise_run_attempts set id = ${liveAttemptId}::uuid
    where tenant_id = ${tenantA} and run_id = ${inFlightRuns.oldLease}::uuid
  `);
  // The expired-lease holder: predicate refuses even though the row exists.
  // The runs tables are RLS-scoped to app.tenant_id, so the predicate runs
  // inside a tenant-scoped transaction — how the production runner probes
  // its lease before every new external operation.
  const expired = await dataB.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true)`);
    return hasActiveAttemptLease(tx, scopeA, {
      runId: inFlightRuns.oldLease,
      attemptId: liveAttemptId,
      generation: 1,
    });
  });
  expect(expired).toBe(false);
  // The live-lease holder still passes the SAME predicate.
  const pauseAttempt = (
    await admin
      .select({ id: enterpriseRunAttempts.id })
      .from(enterpriseRunAttempts)
      .where(
        and(
          eq(enterpriseRunAttempts.tenantId, tenantA),
          eq(enterpriseRunAttempts.runId, inFlightRuns.pause),
        ),
      )
      .limit(1)
  )[0];
  expect(pauseAttempt).toBeDefined();
  const live = await dataB.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true)`);
    return hasActiveAttemptLease(tx, scopeA, {
      runId: inFlightRuns.pause,
      attemptId: (pauseAttempt as { id: string }).id,
      generation: 1,
    });
  });
  expect(live).toBe(true);
});

test("AC2: the compatible pause converts across instances after the switch", async () => {
  const records = await continuationStoreB.listContinuations(scopeA, {
    status: "waiting",
  });
  const record = records.find(
    (candidate) => candidate.binding.runId === inFlightRuns.pause,
  );
  expect(record).toBeDefined();
  if (!record) return;
  const claimed: ClaimedContinuation =
    await continuationStoreA.claimContinuation(
      scopeA,
      record.ref,
      approvedDecision(),
    );
  await continuationStoreA.finishContinuation(claimed, "resumed");
  const finished = await continuationStoreB.getContinuation(
    scopeA,
    record.ref.continuationId,
  );
  expect(finished?.status).toBe("finished");
  expect(finished?.outcome).toBe("resumed");
  // The switched thread's fence is untouched by the conversion.
  expect((await backendOf(threads.pause))?.version).toBe(2);
});

test("AC5/AC6: rollback with a live run parks in maintenance, naming the run and keeping the data", async () => {
  const manifest = await runCutoverRollback(
    { runStore: store1, switchPorts },
    { runId: run1 },
    "engine regression after switch",
  );
  expect(manifest.phase).toBe("maintenance");
  const state = store1.snapshot() as { fence?: CutoverFenceRecord };
  expect(state.fence?.maintenance?.reason).toContain(inFlightRuns.iso);
  expect((await backendOf(threads.main1))?.version).toBe(2);
  expect(state.fence?.rollback).toBeUndefined();
});

test("AC5: the safe rollback keeps every new message and records the preservation receipt", async () => {
  // Drain the remaining in-flight rows first (the pause converted; the
  // isolated run and the expired-lease row were drained by the legacy path).
  await admin
    .update(enterpriseRuns)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(enterpriseRuns.id, inFlightRuns.pause));
  await admin
    .update(enterpriseRuns)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(enterpriseRuns.id, inFlightRuns.iso));
  await admin
    .update(enterpriseRuns)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(enterpriseRuns.id, inFlightRuns.oldLease));

  const manifest = await runApply(
    {
      source: source2,
      ports,
      writer: conversationServiceWriter(serviceA),
      runStore: store2,
    },
    {
      runId: run2,
      scan,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  expect(manifest.phase).toBe("staging");
  const verify = await runVerify(
    { source: source2, ports, targetReader, runStore: store2 },
    { runId: run2, scan },
  );
  expect(verify.phase).toBe("verified");
  const switched = await runCutover(
    { runStore: store2, switchPorts, engineVersion: mastraEngineFingerprint },
    {
      runId: run2,
      scope: { tenantId: tenantA, workspaceId: workspaceA },
      entryInventory: fullInventory,
      dispositions: {},
      compatibleRollbackVersion: "app-1.2.0",
      pauseAdmission: true,
    },
  );
  expect(switched.phase).toBe("switched");
  // New data arrives AFTER the switch, BEFORE the rollback.
  await serviceA.append(scopeA, {
    threadId: threads.main2,
    clientMessageKey: `post-switch-${suffix}`,
    content: "written after the switch, before the rollback",
    attachments: [],
  });
  const memoryBefore = await memoryRowCount();
  const intentsBefore = await foreignIntentCount(threads.main2);
  const rolled = await runCutoverRollback(
    { runStore: store2, switchPorts },
    { runId: run2 },
    "engine regression after switch",
  );
  expect(rolled.phase).toBe("rolled_back");
  const state = store2.snapshot() as { fence?: CutoverFenceRecord };
  expect(state.fence?.rollback?.reason).toBe("engine regression after switch");
  // main2 entered run2 already at generation 2 (run1 switched it), so the
  // run2 switch recorded 2→3 and the rollback moved the generation to 4.
  expect(state.fence?.threads[0]).toMatchObject({
    threadId: threads.main2,
    fromBackendVersion: 2,
    toBackendVersion: 3,
  });
  expect(state.fence?.rollback?.toBackendVersion).toBe(4);
  expect(state.fence?.rollback?.preserved.newIntents).toBe(intentsBefore);
  expect(
    state.fence?.rollback?.receiptRefs.some(
      (ref) => ref.clientMessageKey === `post-switch-${suffix}`,
    ),
  ).toBe(true);
  // Nothing was deleted: the memory row and the intent survive, the history
  // still reads the post-switch message, and the writer generation moved once.
  expect(await memoryRowCount()).toBe(memoryBefore);
  expect(await foreignIntentCount(threads.main2)).toBe(intentsBefore);
  expect((await backendOf(threads.main2))?.version).toBe(4);
  const page = await serviceA.history(scopeA, {
    threadId: threads.main2,
    beforeSeq: null,
    limit: 100,
  });
  expect(
    page.items.some((message) =>
      message.content.includes("before the rollback"),
    ),
  ).toBe(true);
});

test("AC6: rollback without a recorded compatible version refuses into maintenance", async () => {
  const manifest = await runApply(
    {
      source: source3,
      ports,
      writer: conversationServiceWriter(serviceA),
      runStore: store3,
    },
    {
      runId: run3,
      scan,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  expect(manifest.phase).toBe("staging");
  const verify = await runVerify(
    { source: source3, ports, targetReader, runStore: store3 },
    { runId: run3, scan },
  );
  expect(verify.phase).toBe("verified");
  const switched = await runCutover(
    { runStore: store3, switchPorts, engineVersion: mastraEngineFingerprint },
    {
      runId: run3,
      scope: { tenantId: tenantA, workspaceId: workspaceA },
      entryInventory: fullInventory,
      dispositions: {},
      pauseAdmission: true,
    },
  );
  expect(switched.phase).toBe("switched");
  const versionAfterSwitch = (await backendOf(threads.iso))?.version;
  const rolled = await runCutoverRollback(
    { runStore: store3, switchPorts },
    { runId: run3 },
    "engine regression after switch",
  );
  expect(rolled.phase).toBe("maintenance");
  const state = store3.snapshot() as { fence?: CutoverFenceRecord };
  expect(state.fence?.maintenance?.reason).toContain("compatible");
  // Maintenance changes nothing.
  expect((await backendOf(threads.iso))?.version).toBe(versionAfterSwitch);
});

test("the fence consumes the staging machine: a switch on a staging state refuses", async () => {
  await expect(
    runCutover(
      {
        runStore: storeF1,
        switchPorts,
        engineVersion: mastraEngineFingerprint,
      },
      {
        runId: runF1,
        scope: { tenantId: tenantA, workspaceId: workspaceA },
        entryInventory: fullInventory,
        dispositions: {},
        pauseAdmission: true,
      },
    ),
  ).rejects.toThrow("CUTOVER_REQUIRES_VERIFIED");
});

test("carried ME12 R4: the wake-up settle merge lands a jsonb OBJECT on the real database", async () => {
  // The pre-fix expression (`::jsonb` on the bound string) double-encoded
  // under Bun SQL: the merge operand arrived as a jsonb scalar string and
  // `payload || scalar` failed with "invalid concatenation of jsonb
  // objects" — every settle failed on the real database while the in-memory
  // fake hid it. `::text::jsonb` (the store.ts precedent) is the fix.
  const key = `me14-wake-${suffix}`;
  await admin.execute(sql`
    insert into work_items (kind, key, payload)
    values ('bot.wakeup', ${key}, ${JSON.stringify({
      ownerUserId: ownerActor,
      agentId: "bot-me14",
      reason: "cutover rehearsal",
      dueAt: "2026-01-01T00:00:00Z",
      scheduledAt: "2026-01-01T00:00:00Z",
    })}::text::jsonb)
  `);
  const store = createWakeUpStore(admin);
  await store.settle(key, { status: "succeeded", at: "2026-01-02T00:00:00Z" });
  const rows = (await admin.execute(sql`
    select payload from work_items where kind = 'bot.wakeup' and key = ${key}
  `)) as unknown as { payload: { outcome?: { status?: string } } }[];
  expect(rows[0]?.payload.outcome?.status).toBe("succeeded");
  await admin.execute(sql`
    delete from work_items where kind = 'bot.wakeup' and key = ${key}
  `);
});
