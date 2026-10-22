import { createHash, randomUUID } from "node:crypto";
import type { Message, RunAgentInput } from "@ag-ui/client";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { authorizeAttachmentForSendInTransaction } from "../../src/channels/attachments";
import type { Database } from "../../src/db/client";
import {
  attachments as attachmentsTable,
  channelMemberships,
  channels,
  users,
} from "../../src/db/schema/core";
import { enterpriseConversations } from "../../src/db/schema/enterprise-conversations";
import {
  enterprisePrincipals,
  enterpriseWorkspaceMemberships,
} from "../../src/db/schema/enterprise-tenancy";
import { mastraMessageIntents } from "../../src/db/schema/mastra-message-intents";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { createMastraConversationRuntime } from "../../src/mastra/conversation-runtime";
import {
  conversationServiceWriter,
  createAdminTxRunner,
  createPostgresLegacyOwnershipPorts,
  createPostgresTargetReader,
} from "../../src/mastra/cutover";
import {
  type CutoverManifest,
  type CutoverRunStore,
  type LegacyImportSource,
  legacyImportClientMessageKey,
  runApply,
  runDryRun,
  runVerify,
  stagingStatusOf,
} from "../../src/mastra/legacy-import";
import {
  createTenantMastraStorage,
  type TenantMastraStorage,
} from "../../src/mastra/tenant-storage";
import { createMe03Fixture, type Me03Fixture } from "../support/me03-fixture";

/*
 * ME13 (#485) integration: the legacy import against REAL PostgreSQL — one
 * disposable database holding the enterprise control plane AND per-tenant
 * mastra storage, dropped in teardown. The source side is a deterministic
 * Intelligence-shaped fixture that records every call; the real remote API
 * behavior (real pagination quirks, real upstream failures) stays
 * UNVERIFIED in the ticket report — this suite proves the import, resume,
 * idempotency, quarantine and verify mechanics against the real database,
 * through the SAME ConversationService single-writer seams the live runner
 * uses.
 */

const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const tenantA = `me13-tenant-a-${suffix}`;
const workspaceA = `me13-workspace-a-${suffix}`;
const tenantB = `me13-tenant-b-${suffix}`;
const workspaceB = `me13-workspace-b-${suffix}`;
const ownerActor = `me13-actor-${suffix}`;
const ownerPrincipal = `me13-principal-${suffix}`;
const otherActor = `me13-actor-b-${suffix}`;
const otherPrincipal = `me13-principal-b-${suffix}`;
const fixtureId = `me13-fixture-${suffix}`;

let fixture: Me03Fixture;
let admin: Database;
let directory: DirectoryDatabase;
let data: DataDatabase;
let operator: OperatorDatabase;
let storage: TenantMastraStorage;
let scopeA: PlatformScope;
let service: ReturnType<typeof createConversationService>;
let ports: ReturnType<typeof createPostgresLegacyOwnershipPorts>;
let writer: ReturnType<typeof conversationServiceWriter>;
let runtime: ReturnType<typeof createMastraConversationRuntime>;
let targetReader: ReturnType<typeof createPostgresTargetReader>;
let threadId: string;
let memoryMessagesTable: string;
let source: SourceFixture;

const request = {
  runId: `me13-run-${suffix}`,
  scan: { mode: "scan", userId: ownerActor, agentId: "me13-agent" },
} as const;

/**
 * The persisted run state for the MAIN run — one instance reused across the
 * import, the verify pass and the drift-blocked re-verify, the same way the
 * file run store persists across CLI invocations.
 */
const stateStore: CutoverRunStore = {
  state: null as unknown,
  async load() {
    return this.state;
  },
  async save(next: unknown) {
    this.state = JSON.parse(JSON.stringify(next));
  },
};

// ---------------------------------------------------------------------------
// The Intelligence-shaped source fixture: records every call, serves whole
// per-thread histories (the documented read shape).
// ---------------------------------------------------------------------------

class SourceFixture implements LegacyImportSource {
  readonly calls: { method: string; threadId?: string }[] = [];
  readonly pageIds: string[] = [];
  readonly messages = new Map<
    string,
    {
      id: string;
      role: string;
      content?: unknown;
      activityType?: string;
      toolCalls?: { id: string; name: string; args: string }[];
      toolCallId?: string;
    }[]
  >();

  async listThreads(params: {
    userId: string;
    agentId: string;
    cursor?: string | null;
  }) {
    this.calls.push({ method: "listThreads" });
    if (params.cursor) return { threads: [], nextCursor: null };
    return {
      threads: this.pageIds.map((id) => ({
        id,
        createdAt: "2026-01-01T00:00:00Z",
      })),
      nextCursor: null,
    };
  }

  async getThreadMessages(params: { threadId: string; userId: string }) {
    this.calls.push({ method: "getThreadMessages", threadId: params.threadId });
    return { messages: this.messages.get(params.threadId) ?? [] };
  }

  stateHash(): string {
    return createHash("sha256")
      .update(JSON.stringify([this.pageIds, ...this.messages.entries()]))
      .digest("hex");
  }

  /** Every call the import made must be one of the two reads (AC6). */
  readOnly(): boolean {
    return this.calls.every(
      (call) =>
        call.method === "listThreads" || call.method === "getThreadMessages",
    );
  }
}

function threadMessage(
  id: string,
  over: Partial<{
    role: string;
    content: unknown;
    activityType?: string;
    toolCalls?: { id: string; name: string; args: string }[];
    toolCallId?: string;
  }>,
): { id: string; role: string; content?: unknown } {
  return { id, role: "user", content: `message ${id}`, ...over };
}

// ---------------------------------------------------------------------------
// DB probes
// ---------------------------------------------------------------------------

async function countRows(
  table: "enterprise_conversations" | "mastra_message_intents" | "attachments",
): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT count(*)::int AS count FROM ${sql.raw(table)}`,
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

async function countMemoryMessages(): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT count(*)::int AS count FROM ${sql.raw(memoryMessagesTable)}`,
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

async function finalizedIntentCount(
  tenantId: string,
  thread: string,
): Promise<number> {
  const rows = (await admin.execute(
    sql`SELECT count(*)::int AS count FROM ${mastraMessageIntents} WHERE tenant_id = ${tenantId} AND thread_id = ${thread} AND state = 'finalized'`,
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

async function tenantSchemaName(): Promise<string> {
  const record = await fixture.registry.get(tenantA);
  if (!record) throw new Error("tenant storage not provisioned");
  return record.receipt.schemaName;
}

function threadEntry(
  manifest: CutoverManifest,
): CutoverManifest["threads"][number] {
  const entry = manifest.threads[0];
  if (!entry) throw new Error("no thread entry in manifest");
  return entry;
}

function insertThreadRow(input: {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  threadId: string;
  storageBackend: "platform" | "intelligence" | "mastra";
}) {
  return admin.insert(enterpriseConversations).values({
    id: randomUUID(),
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    threadId: input.threadId,
    storageBackend: input.storageBackend,
  });
}

beforeAll(async () => {
  fixture = await createMe03Fixture();
  admin = fixture.openDatabase(fixture.adminUrl);
  directory = await fixture.openDirectory();
  data = await fixture.openData();
  operator = await fixture.openOperator();

  const provisioner = fixture.provisioner();
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });

  await admin.insert(users).values([
    {
      id: ownerActor,
      email: `${ownerActor}@example.invalid`,
      name: "ME13 owner",
    },
    {
      id: otherActor,
      email: `${otherActor}@example.invalid`,
      name: "ME13 tenant B user",
    },
  ]);
  await admin.insert(enterprisePrincipals).values([
    { id: ownerPrincipal, userId: ownerActor },
    { id: otherPrincipal, userId: otherActor },
  ]);
  await provisionDeployment(operator, {
    operationId: `me13-a-${suffix}`,
    operator: ownerPrincipal,
    tenant: { id: tenantA, name: "ME13 tenant A" },
    workspace: { id: workspaceA, name: "ME13 workspace A" },
    members: [
      { principalId: ownerPrincipal, userId: ownerActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  await provisionDeployment(operator, {
    operationId: `me13-b-${suffix}`,
    operator: otherPrincipal,
    tenant: { id: tenantB, name: "ME13 tenant B" },
    workspace: { id: workspaceB, name: "ME13 workspace B" },
    members: [
      { principalId: otherPrincipal, userId: otherActor, role: "tenant_admin" },
    ],
    resources: [],
  });
  // MT005: workspace eligibility is its own server-side row.
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
  const scopeRequest = new Request("https://me13.invalid/owner");
  authenticated.set(scopeRequest, ownerActor);
  scopeA = await resolver.resolve(scopeRequest);

  storage = createTenantMastraStorage(fixture.lookup());
  service = createConversationService({ data, mastraStorage: storage });
  runtime = createMastraConversationRuntime({
    conversations: service,
    storage,
    authorizeAttachment: async (turn, attachmentId) =>
      data.transaction((tx) =>
        authorizeAttachmentForSendInTransaction(tx, turn, attachmentId),
      ),
  });
  ports = createPostgresLegacyOwnershipPorts({
    admin: createAdminTxRunner(admin),
    directory,
  });
  writer = conversationServiceWriter(service);
  targetReader = createPostgresTargetReader({
    admin: createAdminTxRunner(admin),
    storage,
    bindingFor: (scope, thread) => service.resolveMastraBinding(scope, thread),
  });

  // The staging target conversation: getOrCreate creates it mastra-backed.
  const conversation = await service.getOrCreate(scopeA, {
    title: "ME13 staging",
  });
  expect(conversation.storage_backend).toBe("mastra");
  threadId = conversation.thread_id;

  // The source fixture holds the legacy thread under the SAME thread id.
  source = new SourceFixture();
  source.pageIds.push(threadId);

  // The tenant memory messages table, discovered from the catalog (the
  // mastra storage version owns the name; provisioning created the tables).
  const tables = (await admin.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = ${await tenantSchemaName()} AND tablename LIKE '%messages%' ORDER BY tablename LIMIT 1`,
  )) as unknown as { tablename: string }[];
  const found = tables[0]?.tablename;
  if (!found)
    throw new Error(
      "tenant memory messages table not found after provisioning",
    );
  memoryMessagesTable = `"${await tenantSchemaName()}"."${found}"`;
});

afterAll(async () => {
  const errors: unknown[] = [];
  await storage?.close().catch((error: unknown) => errors.push(error));
  try {
    await fixture?.drop();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "ME13 fixture teardown failed");
  }
});

test("dry_run_writes_nothing", async () => {
  // The legacy history the import will later apply — visible to dry-run
  // planning, written nowhere.
  const attachmentId = await legacyAttachments();
  source.messages.set(threadId, [
    threadMessage("legacy-u1", {
      content: [
        { type: "text", text: "see the file" },
        {
          type: "file",
          mimeType: "text/plain",
          source: { type: "url", value: `/api/attachments/${attachmentId}` },
        },
      ],
    }),
    threadMessage("legacy-a1", {
      role: "assistant",
      content: "looking it up",
      toolCalls: [
        { id: "call-legacy-1", name: "lookup", args: '{"q":"openbot"}' },
      ],
    }),
    threadMessage("legacy-t1", {
      role: "tool",
      toolCallId: "call-legacy-1",
      content: '{"answer":"mastra"}',
    }),
    threadMessage("legacy-u2", { content: "thanks" }),
  ]);

  const conversationsBefore = await countRows("enterprise_conversations");
  const intentsBefore = await countRows("mastra_message_intents");
  const memoryBefore = await countMemoryMessages();
  const sourceBefore = source.stateHash();

  const manifest = await runDryRun({ source, ports }, request);

  // AC1: zero writes on BOTH sides — the source hash never moved and only
  // reads were issued; every target table count is unchanged.
  expect(source.stateHash()).toBe(sourceBefore);
  expect(source.readOnly()).toBe(true);
  expect(await countRows("enterprise_conversations")).toBe(conversationsBefore);
  expect(await countRows("mastra_message_intents")).toBe(intentsBefore);
  expect(await countMemoryMessages()).toBe(memoryBefore);
  expect(manifest.phase).toBe("planned");
  expect(manifest.totals.threads).toBe(1);
  expect(manifest.totals.importableMessages).toBe(4);
  expect(threadEntry(manifest).status).toBe("importable");
  expect(threadEntry(manifest).source.readComplete).toBe(true);
  expect(threadEntry(manifest).plan?.importable).toBe(4);
  // The manifest carries digests, never content.
  expect(JSON.stringify(manifest)).not.toContain("looking it up");
  expect(threadEntry(manifest).source.digest).toMatch(/^[0-9a-f]{64}$/);
});

/** Attachments + channel membership the legacy file references resolve to. */
async function legacyAttachments(): Promise<string> {
  const keepChannel = `me13-channel-${suffix}`;
  await admin
    .insert(channels)
    .values([
      { id: keepChannel, name: "me13 legacy", description: "legacy channel" },
    ]);
  await admin
    .insert(channelMemberships)
    .values([{ channelId: keepChannel, userId: ownerActor }]);
  const attachmentId = randomUUID();
  await admin.insert(attachmentsTable).values({
    id: attachmentId,
    channelId: keepChannel,
    uploadedBy: ownerActor,
    name: "legacy.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    bytes: Buffer.from("keep"),
    attachedAt: new Date(),
  });
  return attachmentId;
}

test("apply_imports_full_history_and_the_client_read_path_reads_it_back", async () => {
  const intentsBefore = await countRows("mastra_message_intents");
  const sourceBefore = source.stateHash();

  const manifest = await runApply(
    { source, ports, writer, runStore: stateStore },
    {
      ...request,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );

  // AC6: the source was touched by reads only and never changed.
  expect(source.stateHash()).toBe(sourceBefore);
  expect(source.readOnly()).toBe(true);
  expect(threadEntry(manifest).status).toBe("imported");
  expect(threadEntry(manifest).apply?.written).toBe(4);
  expect(threadEntry(manifest).apply?.alreadyPresent).toBe(0);
  expect(await countRows("mastra_message_intents")).toBe(intentsBefore + 4);
  // AC5: the run ends in the staging phase — not a cutover.
  expect(stagingStatusOf(await stateStore.load())).toBe("staging");

  // The original client read path (1): ConversationService.history — the
  // paginated, principal-authorized read — returns the imported rows with
  // order, tool pairing and attachment ids intact.
  const page = await service.history(scopeA, {
    threadId,
    beforeSeq: null,
    limit: 100,
  });
  // The DTO projects the stored memory role: a tool result is an assistant
  // memory row whose versioned envelope carries the conversational truth —
  // so the page shows assistant, and the runtime rebuild restores "tool".
  expect(page.items.map((item) => item.role)).toEqual([
    "user",
    "assistant",
    "assistant",
    "user",
  ]);
  expect(page.items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  expect(page.items[0]?.content).toBe("see the file");
  expect([...(page.items[0]?.attachments ?? [])]).toHaveLength(1);

  // The original client read path (2): the runtime rebuilds the full AG-UI
  // history from the same store — the tool pair and the file part survive.
  const submittedKey = legacyImportClientMessageKey("legacy-u2");
  const input: RunAgentInput = {
    threadId,
    messages: [{ id: submittedKey, role: "user", content: "" }] as Message[],
  };
  const loaded = await runtime.loadExecutionInput(scopeA, input);
  expect(
    loaded.messages.map((message) => (message as { role: string }).role),
  ).toEqual(["user", "assistant", "tool", "user"]);
  const assistant = loaded.messages[1] as { toolCalls?: { id: string }[] };
  expect(assistant.toolCalls?.[0]?.id).toBe("call-legacy-1");
  const tool = loaded.messages[2] as { toolCallId?: string; content?: string };
  expect(tool.toolCallId).toBe("call-legacy-1");
  expect(tool.content).toBe('{"answer":"mastra"}');
  const userWithFile = loaded.messages[0] as { content: unknown };
  const fileUrl = [...(page.items[0]?.attachments ?? [])][0];
  expect(JSON.stringify(userWithFile.content)).toContain(
    `/api/attachments/${fileUrl}`,
  );
});

test("rerun_import_is_idempotent", async () => {
  const intentsBefore = await countRows("mastra_message_intents");
  const memoryBefore = await countMemoryMessages();
  const sourceBefore = source.stateHash();

  // A FRESH run (new run id + store) re-imports the SAME data.
  const manifest = await runApply(
    { source, ports, writer, runStore: memoryStore() },
    {
      ...request,
      runId: `me13-rerun-${suffix}`,
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );

  expect(source.stateHash()).toBe(sourceBefore);
  expect(source.readOnly()).toBe(true);
  expect(threadEntry(manifest).status).toBe("imported");
  // Every key resolved to its existing finalized intent: nothing new.
  expect(threadEntry(manifest).apply?.written).toBe(0);
  expect(threadEntry(manifest).apply?.alreadyPresent).toBe(4);
  expect(await countRows("mastra_message_intents")).toBe(intentsBefore);
  expect(await countMemoryMessages()).toBe(memoryBefore);
});

function memoryStore(): CutoverRunStore {
  const slot: { state: unknown } = { state: null };
  return {
    async load() {
      return slot.state;
    },
    async save(next: unknown) {
      slot.state = JSON.parse(JSON.stringify(next));
    },
  };
}

test("interrupted_import_resumes_without_duplicates", async () => {
  // A fresh staging thread for the crash scenario.
  const crashConversation = await service.getOrCreate(scopeA, {
    title: "ME13 crash",
  });
  const crashThreadId = crashConversation.thread_id;
  source.messages.set(crashThreadId, [
    threadMessage("crash-u1", { content: "one" }),
    threadMessage("crash-a1", { role: "assistant", content: "two" }),
    threadMessage("crash-u2", { content: "three" }),
    threadMessage("crash-a2", { role: "assistant", content: "four" }),
  ]);

  const crashRun = { ...request, runId: `me13-crash-${suffix}` };
  let applied = 0;
  const crashWriter = {
    appendImportedUser: async (
      input: Parameters<typeof writer.appendImportedUser>[0],
    ) => {
      applied += 1;
      if (applied > 2) throw new Error("simulated crash mid-thread");
      await writer.appendImportedUser(input);
    },
    appendImportedEngine: async (
      input: Parameters<typeof writer.appendImportedEngine>[0],
    ) => {
      applied += 1;
      if (applied > 2) throw new Error("simulated crash mid-thread");
      await writer.appendImportedEngine(input);
    },
  };
  // ONE store across the crash and the resume: the resume reads the state
  // the crashing run persisted, exactly as the file run store does across
  // CLI invocations.
  const crashStore = memoryStore();
  let crashed: unknown;
  try {
    await runApply(
      { source, ports, writer: crashWriter, runStore: crashStore },
      {
        ...crashRun,
        scan: { mode: "explicit-thread", threadId: crashThreadId },
        authorization: { fixtureId },
        environmentFixtureId: fixtureId,
      },
    );
  } catch (error) {
    crashed = error;
  }
  expect(crashed).toBeInstanceOf(Error);
  // Two messages are durable; the state exists for the resume.
  expect(await finalizedIntentCount(tenantA, crashThreadId)).toBe(2);

  const resumed = await runApply(
    { source, ports, writer, runStore: crashStore },
    {
      ...crashRun,
      scan: { mode: "explicit-thread", threadId: crashThreadId },
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  const crashEntry = resumed.threads.find(
    (entry) => entry.threadId === crashThreadId,
  );
  expect(crashEntry?.status).toBe("imported");
  // The two durable messages resolve as already-present; only the rest
  // actually write: 4 total, no duplicates.
  expect(crashEntry?.apply?.written).toBe(2);
  expect(crashEntry?.apply?.alreadyPresent).toBe(2);
  expect(await finalizedIntentCount(tenantA, crashThreadId)).toBe(4);

  const verified = await runVerify(
    { source, ports, targetReader, runStore: crashStore },
    crashRun,
  );
  expect(verified.verify?.status).toBe("match");
  expect(stagingStatusOf(await crashStore.load())).toBe("verified");
});

test("unknown_owner_and_non_mastra_backends_are_quarantined", async () => {
  // A thread with NO ownership row: no default tenant is guessed.
  const ghostThread = `me13-ghost-${suffix}`;
  const ghost = await runDryRun(
    { source, ports },
    { ...request, scan: { mode: "explicit-thread", threadId: ghostThread } },
  );
  expect(threadEntry(ghost).status).toBe("quarantined");
  expect(threadEntry(ghost).reason).toBe("owner_missing");

  // A thread whose only evidence is a platform-backend conversation: the
  // backend flip is the write fence's decision, not the importer's.
  const platformThread = `me13-platform-${suffix}`;
  await insertThreadRow({
    tenantId: tenantA,
    workspaceId: workspaceA,
    principalId: ownerPrincipal,
    threadId: platformThread,
    storageBackend: "platform",
  });
  const platform = await runDryRun(
    { source, ports },
    { ...request, scan: { mode: "explicit-thread", threadId: platformThread } },
  );
  expect(threadEntry(platform).status).toBe("quarantined");
  expect(threadEntry(platform).reason).toBe("backend_not_staging");
});

test("ambiguous_owner_is_quarantined", async () => {
  // The same threadId, evidenced in TWO tenants: no default is guessed and
  // nothing is written anywhere.
  const ambiguousThread = `me13-ambiguous-${suffix}`;
  await insertThreadRow({
    tenantId: tenantA,
    workspaceId: workspaceA,
    principalId: ownerPrincipal,
    threadId: ambiguousThread,
    storageBackend: "mastra",
  });
  await insertThreadRow({
    tenantId: tenantB,
    workspaceId: workspaceB,
    principalId: otherPrincipal,
    threadId: ambiguousThread,
    storageBackend: "mastra",
  });
  // Tenant B's workspace eligibility row (the FKs require real rows).
  await admin.insert(enterpriseWorkspaceMemberships).values({
    tenantId: tenantB,
    workspaceId: workspaceB,
    principalId: otherPrincipal,
  });

  const intentsBefore = await countRows("mastra_message_intents");
  const manifest = await runApply(
    { source, ports, writer, runStore: memoryStore() },
    {
      ...request,
      runId: `me13-ambiguous-${suffix}`,
      scan: { mode: "explicit-thread", threadId: ambiguousThread },
      authorization: { fixtureId },
      environmentFixtureId: fixtureId,
    },
  );
  expect(manifest.totals.threads).toBe(1);
  expect(threadEntry(manifest).status).toBe("quarantined");
  expect(threadEntry(manifest).reason).toBe("owner_ambiguous");
  expect(await countRows("mastra_message_intents")).toBe(intentsBefore);
});

test("verify_passes_then_blocks_on_target_digest_mismatch", async () => {
  // First verify over the main import: every digest matches.
  const verified = await runVerify(
    { source, ports, targetReader, runStore: stateStore },
    request,
  );
  expect(verified.verify?.status).toBe("match");
  expect(stagingStatusOf(await stateStore.load())).toBe("verified");

  // Post-import drift on the target: rewrite one stored row's display text
  // directly (owner-level tampering on the disposable fixture).
  const drifted = (await admin.execute(
    sql`UPDATE ${sql.raw(memoryMessagesTable)} SET content = jsonb_set(content::jsonb, '{parts,0,text}', '"TAMPERED"')::text WHERE thread_id = ${threadId} AND content::jsonb->'metadata'->>'openbotClientMessageKey' = ${legacyImportClientMessageKey("legacy-u1")} RETURNING id`,
  )) as unknown as { id: string }[];
  expect(drifted).toHaveLength(1);

  // The re-verify recomputes BOTH sides and BLOCKS: the staging state is
  // fence-ineligible from here.
  const blocked = await runVerify(
    { source, ports, targetReader, runStore: stateStore },
    request,
  );
  expect(blocked.verify?.status).toBe("mismatch");
  expect(blocked.verify?.detail).toContain(
    legacyImportClientMessageKey("legacy-u1"),
  );
  expect(stagingStatusOf(await stateStore.load())).toBe("blocked");
});
