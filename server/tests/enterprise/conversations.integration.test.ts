import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { cullStagedAttachments } from "../../scripts/cull-staged-attachments";
import { createGroupStore } from "../../src/channels/group";
import { createChannelStore } from "../../src/channels/routes";
import { createThreadIdentity } from "../../src/channels/thread-identity";
import { createThreadReader } from "../../src/channels/thread-status";
import { createDatabase, type Database } from "../../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  enterpriseConversations,
  enterpriseRuns,
  intelligenceChannelMappings,
  users,
} from "../../src/db/schema";
import { enterpriseMessages } from "../../src/db/schema/enterprise-conversations";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../src/db/schema/enterprise-tenancy";
import {
  mastraMessageIntentAttachments,
  mastraMessageIntents,
} from "../../src/db/schema/mastra-message-intents";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createMastraMessageIntentReconciler } from "../../src/enterprise/conversations/mastra-intent-reconciler";
import { createConversationService } from "../../src/enterprise/conversations/service";
import { createConversationStore } from "../../src/enterprise/conversations/store";
import type {
  DataDatabase,
  DirectoryDatabase,
  OperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  provisionDeployment,
  suspendMembership,
} from "../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { tenantStorageKey } from "../../src/mastra/contracts";
import { createMastraConversationRepository } from "../../src/mastra/conversations";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const prefix = `m02r1br1-${randomUUID()}`;
const channelId = `${prefix}-channel`;
const raceChannelId = `${prefix}-race-channel`;
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
const actorId = `${prefix}-actor`;
const principalId = `${prefix}-principal`;
const foreignActorId = `${prefix}-foreign-actor`;
const foreignPrincipalId = `${prefix}-foreign-principal`;
const raceActorId = `${prefix}-race-actor`;
const racePrincipalId = `${prefix}-race-principal`;
const reconcileActorId = `${prefix}-reconcile-actor`;
const reconcilePrincipalId = `${prefix}-reconcile-principal`;
const attachmentId = randomUUID();
const rollbackAttachmentId = randomUUID();
const directAttachmentId = randomUUID();
const raceAttachmentId = randomUUID();
const schemaInvariantRunId = randomUUID();

let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
let scope: PlatformScope;
let foreignScope: PlatformScope;
let raceScope: PlatformScope;
let reconcileScope: PlatformScope;
let conversations: ReturnType<typeof createConversationService>;

function setupDb() {
  setupDatabase ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 4 });
  return setupDatabase;
}

function openRuntimeDatabase(role: "directory"): Promise<DirectoryDatabase>;
function openRuntimeDatabase(role: "data"): Promise<DataDatabase>;
function openRuntimeDatabase(role: "operator"): Promise<OperatorDatabase>;
async function openRuntimeDatabase(role: "directory" | "data" | "operator") {
  const database = createDatabase(enterpriseRuntimeDatabaseUrlFrom(role), {
    max: 2,
  });
  try {
    if (role === "directory") return await verifyDirectoryDatabase(database);
    if (role === "data") return await verifyDataDatabase(database);
    return await verifyOperatorDatabase(database);
  } catch (error) {
    await database.$client.close();
    throw error;
  }
}

beforeAll(async () => {
  const setup = setupDb();
  directoryDatabase = await openRuntimeDatabase("directory");
  dataDatabase = await openRuntimeDatabase("data");
  operatorDatabase = await openRuntimeDatabase("operator");
  await setup.insert(users).values([
    {
      id: actorId,
      email: `${actorId}@example.invalid`,
      name: "Synthetic conversation actor",
    },
    {
      id: foreignActorId,
      email: `${foreignActorId}@example.invalid`,
      name: "Synthetic foreign actor",
    },
    {
      id: raceActorId,
      email: `${raceActorId}@example.invalid`,
      name: "Synthetic race actor",
    },
    {
      id: reconcileActorId,
      email: `${reconcileActorId}@example.invalid`,
      name: "Synthetic reconcile actor",
    },
  ]);
  await setup.insert(enterprisePrincipals).values([
    { id: principalId, userId: actorId },
    { id: foreignPrincipalId, userId: foreignActorId },
    { id: racePrincipalId, userId: raceActorId },
    { id: reconcilePrincipalId, userId: reconcileActorId },
  ]);
  await provisionDeployment(operatorDatabase, {
    operationId: `${prefix}-provision`,
    operator: principalId,
    tenant: { id: tenantId, name: "Synthetic conversation tenant" },
    workspace: { id: workspaceId, name: "Synthetic conversation workspace" },
    members: [
      { principalId, userId: actorId, role: "tenant_admin" },
      {
        principalId: foreignPrincipalId,
        userId: foreignActorId,
        role: "member",
      },
      { principalId: racePrincipalId, userId: raceActorId, role: "member" },
      {
        principalId: reconcilePrincipalId,
        userId: reconcileActorId,
        role: "member",
      },
    ],
    resources: [
      {
        id: channelId,
        kind: "channel",
        displayName: "Synthetic conversation channel",
        readers: [principalId],
      },
      {
        id: raceChannelId,
        kind: "channel",
        displayName: "Synthetic race channel",
        readers: [principalId],
      },
    ],
  });
  await setup.insert(channels).values([
    {
      id: channelId,
      name: "Synthetic channel",
      description: "Conversation integration fixture",
    },
    {
      id: raceChannelId,
      name: "Synthetic race channel",
      description: "Conversation advisory-lock integration fixture",
    },
  ]);
  await setup.insert(channelMemberships).values([
    { channelId, userId: actorId },
    { channelId, userId: reconcileActorId },
    { channelId: raceChannelId, userId: actorId },
  ]);
  await setup.insert(intelligenceChannelMappings).values([
    { userId: actorId, channelId, threadId: `${prefix}-legacy-thread` },
    {
      userId: actorId,
      channelId: raceChannelId,
      threadId: `${prefix}-race-legacy-thread`,
    },
  ]);
  await setup.insert(attachments).values([
    {
      id: attachmentId,
      channelId,
      uploadedBy: actorId,
      name: "fixture.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      bytes: Buffer.from("hello"),
    },
    {
      id: rollbackAttachmentId,
      channelId,
      uploadedBy: actorId,
      name: "rollback.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      bytes: Buffer.from("world"),
    },
    {
      id: directAttachmentId,
      channelId,
      uploadedBy: actorId,
      name: "direct.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      bytes: Buffer.from("direct"),
    },
    {
      id: raceAttachmentId,
      channelId: raceChannelId,
      uploadedBy: actorId,
      name: "race.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      bytes: Buffer.from("race"),
    },
  ]);

  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(directoryDatabase, {
    authenticate: async (request) => {
      const actor = authenticated.get(request);
      return actor ? { actorId: actor, entrypoint: "web" } : null;
    },
    selectTenant: () => tenantId,
    selectWorkspace: () => workspaceId,
  });
  const requestFor = (actor: string) => {
    const request = new Request(
      "https://enterprise.example.invalid/conversations",
    );
    authenticated.set(request, actor);
    return request;
  };
  scope = await resolver.resolve(requestFor(actorId));
  foreignScope = await resolver.resolve(requestFor(foreignActorId));
  raceScope = await resolver.resolve(requestFor(raceActorId));
  reconcileScope = await resolver.resolve(requestFor(reconcileActorId));
  conversations = createConversationService({ data: dataDatabase });
});

async function createPlatformConversation() {
  const threadId = randomUUID();
  const [seeded] = await createConversationStore(dataDatabase!).transaction(
    scope,
    (tx) =>
      tx
        .insert(enterpriseConversations)
        .values({
          tenantId,
          workspaceId,
          principalId,
          threadId,
          storageBackend: "platform",
          backendVersion: 1,
          lastSeq: 0,
        })
        .returning(),
  );
  if (!seeded) throw new Error("PLATFORM_FIXTURE_SEED_FAILED");
  const conversation = await conversations.getOrCreate(scope, { threadId });
  expect(conversation.storage_backend).toBe("platform");
  return conversation;
}

test("new conversation fails closed without Mastra storage", async () => {
  const service = createConversationService({ data: dataDatabase! });
  const before = await setupDb()
    .select({ threadId: enterpriseConversations.threadId })
    .from(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantId),
        eq(enterpriseConversations.principalId, principalId),
      ),
    );

  await expect(service.getOrCreate(scope, {})).rejects.toThrow(
    "MASTRA_STORAGE_UNAVAILABLE",
  );

  const rows = await setupDb()
    .select({ threadId: enterpriseConversations.threadId })
    .from(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantId),
        eq(enterpriseConversations.principalId, principalId),
      ),
    );
  expect(rows).toEqual(before);
});

test("trusted reconciler validates bounded batch limits before database access", async () => {
  const reconciler = createMastraMessageIntentReconciler({
    data: dataDatabase!,
    mastraStorage: {} as never,
  });
  for (const limit of [0, -1, 1.5, 101, Number.NaN]) {
    await expect(
      reconciler.reconcilePendingForTenant(tenantId, limit),
    ).rejects.toThrow("INVALID_RECONCILIATION_LIMIT");
  }
  await expect(
    reconciler.reconcilePendingForTenant(tenantId, 1),
  ).resolves.toEqual({
    scanned: 0,
    finalized: 0,
    pending: 0,
    absent: 0,
    mismatch: 0,
  });
});

test("reconciler advances past multiple unresolved batches and finalizes a later exact intent", async () => {
  const fairnessThreadId = `${prefix}-fairness-${randomUUID()}`;
  const clientMessageKeys = Array.from(
    { length: 5 },
    (_, index) => `${prefix}-fairness-${index}`,
  );
  const messageIds = clientMessageKeys.map(() => randomUUID());
  const start = Date.now() - 60_000;
  await setupDb().insert(enterpriseConversations).values({
    tenantId,
    workspaceId,
    principalId: reconcilePrincipalId,
    threadId: fairnessThreadId,
    storageBackend: "mastra",
    backendVersion: 1,
  });
  await setupDb()
    .insert(mastraMessageIntents)
    .values(
      clientMessageKeys.map((clientMessageKey, index) => ({
        tenantId,
        threadId: fairnessThreadId,
        clientMessageKey,
        messageId: messageIds[index]!,
        digest: `digest-${index}`,
        reservedSeq: index + 1,
        actorId: reconcileActorId,
        principalId: reconcilePrincipalId,
        backendVersion: 1,
        attachmentIds: [],
        state: "pending" as const,
        createdAt: new Date(start + index),
        updatedAt: new Date(start + index),
      })),
    );
  const inspected: string[] = [];
  let storageGetStoreCalls = 0;
  let saveMessageCalls = 0;
  const reconciler = createMastraMessageIntentReconciler({
    data: dataDatabase!,
    mastraStorage: {
      async getStore() {
        storageGetStoreCalls += 1;
        return {
          async getStore() {
            return {
              async saveMessages() {
                saveMessageCalls += 1;
              },
            };
          },
        };
      },
      async withConversationLock(_scope, _binding, operation) {
        return operation();
      },
      async inspectIntentMessage(_binding, expected) {
        inspected.push(expected.messageId);
        return expected.messageId === messageIds[4]
          ? "exact"
          : inspected.length % 2 === 0
            ? "mismatch"
            : "absent";
      },
    } as never,
  });

  try {
    const outcomes = [];
    for (let scan = 0; scan < 3; scan += 1) {
      outcomes.push(await reconciler.reconcilePendingForTenant(tenantId, 2));
    }

    expect(inspected).toContain(messageIds[4]);
    expect(storageGetStoreCalls).toBe(0);
    expect(saveMessageCalls).toBe(0);
    expect(outcomes.reduce((sum, outcome) => sum + outcome.finalized, 0)).toBe(
      1,
    );
    const rows = await setupDb()
      .select({
        clientMessageKey: mastraMessageIntents.clientMessageKey,
        state: mastraMessageIntents.state,
      })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, fairnessThreadId));
    expect(rows.filter(({ state }) => state === "pending")).toHaveLength(4);
    expect(
      rows.find(
        ({ clientMessageKey }) => clientMessageKey === clientMessageKeys[4],
      )?.state,
    ).toBe("finalized");
  } finally {
    await setupDb()
      .delete(mastraMessageIntentAttachments)
      .where(eq(mastraMessageIntentAttachments.threadId, fairnessThreadId));
    await setupDb()
      .delete(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, fairnessThreadId));
    await setupDb()
      .delete(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, tenantId),
          eq(enterpriseConversations.threadId, fairnessThreadId),
        ),
      );
    const remaining = await setupDb()
      .select({ threadId: enterpriseConversations.threadId })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, fairnessThreadId));
    expect(remaining).toEqual([]);
  }
});

test("malformed intent reconciliation orders both worker retries behind conversation lock", async () => {
  const token = randomUUID().replaceAll("-", "").slice(0, 20);
  const threadId = `${prefix}-malformed-race-${token}`;
  const clientMessageKey = `${prefix}-malformed-key-${token}`;
  const exactClientMessageKey = `${prefix}-exact-after-malformed-${token}`;
  const malformedMessageId = randomUUID();
  const exactMessageId = randomUUID();
  const heldAttachmentId = randomUUID();
  const tag = `m2r1_${token}`;
  const logTable = `${tag}_updates`;
  const triggerName = `${tag}_trigger`;
  const functionName = `${tag}_fn`;
  const quoteIdentifier = (value: string) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value))
      throw new Error("invalid test identifier");
    return `"${value}"`;
  };
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const qualifiedLogTable = `public.${quoteIdentifier(logTable)}`;
  const blockerKey = JSON.stringify(["conversation", tenantId, threadId]);
  const initialUpdatedAt = new Date(Date.now() - 60_000);
  const inspected: string[] = [];
  let saveMessageCalls = 0;
  let releaseBlocker!: () => void;
  let blockerLocked!: () => void;
  let reportBlockerPid!: (pid: number) => void;
  const release = new Promise<void>((resolve) => (releaseBlocker = resolve));
  const locked = new Promise<void>((resolve) => (blockerLocked = resolve));
  const blockerPidReady = new Promise<number>((resolve) => {
    reportBlockerPid = resolve;
  });
  let blocker: Promise<unknown> | undefined;
  let workers: Promise<unknown>[] = [];
  let testFailure: unknown;
  const cleanupFailures: unknown[] = [];
  const reconciler = createMastraMessageIntentReconciler({
    data: dataDatabase!,
    mastraStorage: {
      async getStore() {
        return {
          async getStore() {
            return {
              async saveMessages() {
                saveMessageCalls += 1;
              },
            };
          },
        };
      },
      async withConversationLock(_scope, _binding, operation) {
        return operation();
      },
      async inspectIntentMessage(_binding, expected) {
        inspected.push(expected.messageId);
        return expected.messageId === exactMessageId ? "exact" : "absent";
      },
    } as never,
  });

  try {
    await setupDb()
      .insert(attachments)
      .values({
        id: heldAttachmentId,
        channelId,
        uploadedBy: reconcileActorId,
        name: "malformed-intent-held-attachment.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        bytes: Buffer.from("held!"),
      });
    await setupDb().insert(enterpriseConversations).values({
      tenantId,
      workspaceId,
      principalId: reconcilePrincipalId,
      threadId,
      storageBackend: "mastra",
      backendVersion: 1,
    });
    await setupDb()
      .insert(mastraMessageIntents)
      .values([
        {
          tenantId,
          threadId,
          clientMessageKey,
          messageId: malformedMessageId,
          digest: `malformed-${token}`,
          reservedSeq: 1,
          actorId: reconcileActorId,
          principalId: reconcilePrincipalId,
          backendVersion: 1,
          attachmentIds: [heldAttachmentId, "invalid-attachment-id"],
          state: "pending",
          createdAt: initialUpdatedAt,
          updatedAt: initialUpdatedAt,
        },
        {
          tenantId,
          threadId,
          clientMessageKey: exactClientMessageKey,
          messageId: exactMessageId,
          digest: `exact-${token}`,
          reservedSeq: 2,
          actorId: reconcileActorId,
          principalId: reconcilePrincipalId,
          backendVersion: 1,
          attachmentIds: [],
          state: "pending",
          createdAt: new Date(initialUpdatedAt.getTime() + 1),
          updatedAt: new Date(initialUpdatedAt.getTime() + 1),
        },
      ]);
    await setupDb().insert(mastraMessageIntentAttachments).values({
      tenantId,
      threadId,
      clientMessageKey,
      attachmentId: heldAttachmentId,
    });
    await setupDb().execute(
      sql.raw(
        `CREATE TABLE ${qualifiedLogTable} (observation_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, updated_at timestamptz NOT NULL)`,
      ),
    );
    await setupDb().execute(
      sql.raw(`CREATE FUNCTION public.${quoteIdentifier(functionName)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        BEGIN
          IF NEW.tenant_id = ${literal(tenantId)}
            AND NEW.thread_id = ${literal(threadId)}
            AND NEW.client_message_key = ${literal(clientMessageKey)}
            AND NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
            INSERT INTO ${qualifiedLogTable} (updated_at) VALUES (NEW.updated_at);
          END IF;
          RETURN NEW;
        END
      $$`),
    );
    await setupDb().execute(
      sql.raw(
        `CREATE TRIGGER ${quoteIdentifier(triggerName)} BEFORE UPDATE ON public.mastra_message_intents FOR EACH ROW EXECUTE FUNCTION public.${quoteIdentifier(functionName)}()`,
      ),
    );

    blocker = setupDb().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${blockerKey}, 0))`,
      );
      const pidResult = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      reportBlockerPid(Number(firstQueryRow(pidResult)?.pid));
      blockerLocked();
      await release;
    });
    await locked;
    const blockerPid = await blockerPidReady;
    let firstSettled = false;
    let secondSettled = false;
    const firstWorker = reconciler
      .reconcilePendingForTenant(tenantId, 1)
      .then((result) => {
        firstSettled = true;
        return result;
      });
    const secondWorker = reconciler
      .reconcilePendingForTenant(tenantId, 1)
      .then((result) => {
        secondSettled = true;
        return result;
      });
    workers = [firstWorker, secondWorker];
    const bothWaiting = await waitForAdvisoryLockWaiters(blockerPid, 2);
    expect(bothWaiting).toBe(true);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseBlocker();
    await blocker;
    const workerOutcomes = await Promise.all(workers);
    expect(workerOutcomes).toHaveLength(2);
    for (const outcome of workerOutcomes) {
      expect(outcome).toMatchObject({
        scanned: 1,
        finalized: 0,
        pending: 1,
        mismatch: 1,
      });
    }
    const updateResult = await setupDb().execute(
      sql.raw(
        `SELECT observation_seq, updated_at FROM ${qualifiedLogTable} ORDER BY observation_seq`,
      ),
    );
    const updateRows = Array.isArray(updateResult)
      ? updateResult
      : ((
          updateResult as {
            rows?: Array<{
              observation_seq: number | bigint;
              updated_at: Date;
            }>;
          }
        ).rows ?? []);
    expect(updateRows).toHaveLength(2);
    expect(Number(updateRows[1]!.observation_seq)).toBeGreaterThan(
      Number(updateRows[0]!.observation_seq),
    );
    expect(updateRows[0]!.updated_at.getTime()).toBeGreaterThan(
      initialUpdatedAt.getTime(),
    );
    expect(updateRows[1]!.updated_at.getTime()).toBeGreaterThan(
      updateRows[0]!.updated_at.getTime(),
    );
    const hasStrictTimestampProgression = (rows: typeof updateRows): boolean =>
      rows.every(
        (row, index) =>
          index === 0 ||
          row.updated_at.getTime() > rows[index - 1]!.updated_at.getTime(),
      );
    expect(hasStrictTimestampProgression(updateRows)).toBe(true);
    expect(hasStrictTimestampProgression([...updateRows].reverse())).toBe(
      false,
    );
    const [malformed] = await setupDb()
      .select({
        state: mastraMessageIntents.state,
        attachmentIds: mastraMessageIntents.attachmentIds,
      })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
    expect(malformed).toEqual({
      state: "pending",
      attachmentIds: [heldAttachmentId, "invalid-attachment-id"],
    });
    const [heldAttachment] = await setupDb()
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, heldAttachmentId));
    expect(heldAttachment?.attachedAt).toBeNull();
    const pendingReference = await setupDb()
      .select({ attachmentId: mastraMessageIntentAttachments.attachmentId })
      .from(mastraMessageIntentAttachments)
      .where(
        eq(mastraMessageIntentAttachments.clientMessageKey, clientMessageKey),
      );
    expect(pendingReference).toEqual([{ attachmentId: heldAttachmentId }]);
    expect(inspected).toEqual([]);

    const later = await reconciler.reconcilePendingForTenant(tenantId, 1);
    expect(later).toEqual({
      scanned: 1,
      finalized: 1,
      pending: 0,
      absent: 0,
      mismatch: 0,
    });
    expect(inspected).toEqual([exactMessageId]);
    expect(saveMessageCalls).toBe(0);
  } catch (error) {
    testFailure = error;
  } finally {
    releaseBlocker();
    await Promise.allSettled([...(blocker ? [blocker] : []), ...workers]);
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    await clean(() =>
      setupDb().execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON public.mastra_message_intents`,
        ),
      ),
    );
    await clean(() =>
      setupDb().execute(
        sql.raw(
          `DROP FUNCTION IF EXISTS public.${quoteIdentifier(functionName)}()`,
        ),
      ),
    );
    await clean(() =>
      setupDb().execute(sql.raw(`DROP TABLE IF EXISTS ${qualifiedLogTable}`)),
    );
    await clean(() =>
      setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId)),
    );
    await clean(() =>
      setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId)),
    );
    await clean(() =>
      setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        ),
    );
    await clean(() =>
      setupDb().delete(attachments).where(eq(attachments.id, heldAttachmentId)),
    );
    await clean(async () => {
      const remaining = await setupDb().execute(sql`
        SELECT
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = ${triggerName} AND NOT tgisinternal) AS trigger_exists,
          EXISTS (SELECT 1 FROM pg_proc AS procedure JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace WHERE namespace.nspname = 'public' AND procedure.proname = ${functionName}) AS function_exists,
          EXISTS (SELECT 1 FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = ${logTable}) AS table_exists,
          EXISTS (SELECT 1 FROM enterprise_conversations WHERE tenant_id = ${tenantId} AND thread_id = ${threadId}) AS conversation_exists,
          EXISTS (SELECT 1 FROM mastra_message_intents WHERE tenant_id = ${tenantId} AND thread_id = ${threadId}) AS intent_exists,
          EXISTS (SELECT 1 FROM attachments WHERE id = ${heldAttachmentId}) AS attachment_exists
      `);
      expect(firstQueryRow(remaining)).toEqual({
        trigger_exists: false,
        function_exists: false,
        table_exists: false,
        conversation_exists: false,
        intent_exists: false,
        attachment_exists: false,
      });
    });
  }
  if (cleanupFailures.length || testFailure !== undefined)
    throw new AggregateError(
      [...(testFailure === undefined ? [] : [testFailure]), ...cleanupFailures],
      `malformed reconciliation fixture cleanup failed: trigger=${triggerName} function=${functionName} table=${logTable} thread=${threadId} attachment=${heldAttachmentId} key=${clientMessageKey}`,
    );
});

const legacyChannelLockKey = (id: string) =>
  JSON.stringify(["legacy", "channel", id]);

function firstQueryRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result))
    return result[0] as Record<string, unknown> | undefined;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows))
      return rows[0] as Record<string, unknown> | undefined;
  }
  return undefined;
}

async function waitForAdvisoryLockWaiter(blockerPid: number): Promise<boolean> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const result = await setupDb().execute(sql`
      select exists (
        select 1
        from pg_locks as locks
        join pg_stat_activity as activity using (pid)
        where locks.locktype = 'advisory'
          and not locks.granted
          and ${blockerPid} = any(pg_blocking_pids(activity.pid))
          and activity.query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    if (firstQueryRow(result)?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForAnyAdvisoryLockWaiter(): Promise<boolean> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const result = await setupDb().execute(sql`
      select exists (
        select 1
        from pg_locks as locks
        join pg_stat_activity as activity using (pid)
        where locks.locktype = 'advisory'
          and not locks.granted
          and cardinality(pg_blocking_pids(activity.pid)) > 0
          and activity.query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    if (firstQueryRow(result)?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function waitForAdvisoryLockWaiters(
  blockerPid: number,
  expectedCount: number,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await setupDb().execute(sql`
      SELECT count(DISTINCT activity.pid)::int AS waiter_count
      FROM pg_locks AS locks
      JOIN pg_stat_activity AS activity USING (pid)
      WHERE locks.locktype = 'advisory'
        AND NOT locks.granted
        AND ${blockerPid} = ANY(pg_blocking_pids(activity.pid))
        AND activity.query LIKE '%pg_advisory_xact_lock%'
    `);
    if (Number(firstQueryRow(result)?.waiter_count ?? 0) >= expectedCount)
      return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test("Run ceilings and reservation totals are enforced by PostgreSQL", async () => {
  const setup = setupDb();
  const conversation = await createPlatformConversation();
  const threadId = conversation.thread_id;
  const baseRun = {
    tenantId,
    workspaceId,
    principalId,
    threadId,
    clientMessageKey: `${prefix}-schema-invariant-run`,
    expertVersionRef: "synthetic-expert-v1",
    modelRouteRef: "synthetic-model-route",
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };

  await expect(
    Promise.resolve().then(() => setup.insert(enterpriseRuns).values(baseRun)),
  ).rejects.toThrow();
  await expect(
    Promise.resolve().then(() =>
      setup
        .insert(enterpriseRuns)
        .values({ ...baseRun, modelRouteMaximumTokens: 0 }),
    ),
  ).rejects.toThrow();

  await setup.insert(enterpriseRuns).values({
    ...baseRun,
    id: schemaInvariantRunId,
    clientMessageKey: `${prefix}-schema-invariant-valid-run`,
    modelRouteMaximumTokens: 1,
  });
  await expect(
    Promise.resolve().then(() =>
      setup.execute(sql`
        INSERT INTO enterprise_model_budget_reservations (
          tenant_id, workspace_id, principal_id, run_id, idempotency_key,
          model_route_ref, token_limit, confirmed_tokens, expires_at
        ) VALUES (
          ${tenantId}, ${workspaceId}, ${principalId}, ${schemaInvariantRunId},
          ${`${prefix}-over-limit-reservation`}, 'synthetic-model-route', 1, 2,
          now() + interval '1 hour'
        )
      `),
    ),
  ).rejects.toThrow();
});

test("Bun and Drizzle persist intent attachment IDs as a JSON array", async () => {
  const conversation = await createPlatformConversation();
  const threadId = conversation.thread_id;
  const clientMessageKey = `${prefix}-json-array-intent`;
  try {
    await setupDb()
      .insert(mastraMessageIntents)
      .values({
        tenantId,
        threadId,
        clientMessageKey,
        messageId: `${prefix}-json-array-message`,
        digest: "json-array-contract",
        reservedSeq: 2_000_000_000,
        actorId,
        principalId,
        backendVersion: 1,
        attachmentIds: [],
      });
    const [stored] = (await setupDb().execute(sql`
      SELECT jsonb_typeof(attachment_ids) AS type
      FROM mastra_message_intents
      WHERE tenant_id = ${tenantId}
        AND thread_id = ${threadId}
        AND client_message_key = ${clientMessageKey}
    `)) as unknown as Array<{ type: string }>;
    expect(stored?.type).toBe("array");
  } finally {
    await setupDb()
      .delete(mastraMessageIntents)
      .where(
        and(
          eq(mastraMessageIntents.tenantId, tenantId),
          eq(mastraMessageIntents.threadId, threadId),
          eq(mastraMessageIntents.clientMessageKey, clientMessageKey),
        ),
      );
  }
});

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    if (setupDatabase) {
      await setupDatabase
        .delete(attachments)
        .where(
          inArray(attachments.id, [
            attachmentId,
            rollbackAttachmentId,
            directAttachmentId,
            raceAttachmentId,
          ]),
        );
      await setupDatabase
        .delete(intelligenceChannelMappings)
        .where(like(intelligenceChannelMappings.userId, `${prefix}%`));
      await setupDatabase
        .delete(channelMemberships)
        .where(like(channelMemberships.channelId, `${prefix}%`));
      await setupDatabase
        .delete(channels)
        .where(like(channels.id, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseResourceGrants)
        .where(like(enterpriseResourceGrants.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseResources)
        .where(like(enterpriseResources.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseWorkspaces)
        .where(like(enterpriseWorkspaces.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseMemberships)
        .where(like(enterpriseMemberships.tenantId, `${prefix}%`));
      await setupDatabase
        .delete(enterprisePrincipals)
        .where(like(enterprisePrincipals.id, `${prefix}%`));
      await setupDatabase
        .delete(enterpriseTenants)
        .where(like(enterpriseTenants.id, `${prefix}%`));
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    }
  } catch (error) {
    failures.push(error);
  }
  for (const database of [
    operatorDatabase,
    dataDatabase,
    directoryDatabase,
    setupDatabase,
  ]) {
    try {
      await database?.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Conversation fixture cleanup failed.");
});

test("conflicting_client_message_keys_do_not_replace_history", async () => {
  const conversation = await createPlatformConversation();
  const original = {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-same-key`,
    content: "original normalized\r\nbody",
    attachments: [attachmentId],
  };
  const first = await conversations.append(scope, original);
  const replay = await conversations.append(scope, {
    ...original,
    content: "original normalized\nbody",
  });
  expect(replay).toEqual(first);

  await expect(
    conversations.append(scope, {
      ...original,
      content: "different normalized body",
    }),
  ).rejects.toMatchObject({ code: "message_conflict" });
  await expect(
    conversations.append(scope, { ...original, attachments: [] }),
  ).rejects.toMatchObject({ code: "message_conflict" });

  const history = await conversations.history(scope, {
    threadId: conversation.thread_id,
    beforeSeq: null,
    limit: 20,
  });
  expect(history.items).toEqual([first]);
});

test("invalid attachment reference leaves message and staged attachment unchanged", async () => {
  const conversation = await createPlatformConversation();
  const missingAttachment = randomUUID();
  await expect(
    conversations.append(scope, {
      threadId: conversation.thread_id,
      clientMessageKey: `${prefix}-rollback-key`,
      content: "message must not persist",
      attachments: [rollbackAttachmentId, missingAttachment],
    }),
  ).rejects.toBeDefined();

  const [storedAttachment] = await setupDb()
    .select({ attachedAt: attachments.attachedAt })
    .from(attachments)
    .where(eq(attachments.id, rollbackAttachmentId));
  expect(storedAttachment?.attachedAt).toBeNull();
  const history = await conversations.history(scope, {
    threadId: conversation.thread_id,
    beforeSeq: null,
    limit: 20,
  });
  expect(history.items).toEqual([]);
});

test("history pagination is stable and rejects invalid cursors and limits", async () => {
  const conversation = await createPlatformConversation();
  const saved = [];
  for (const content of ["page one", "page two", "page three"]) {
    saved.push(
      await conversations.append(scope, {
        threadId: conversation.thread_id,
        clientMessageKey: `${prefix}-${content}`,
        content,
        attachments: [],
      }),
    );
  }
  const newest = await conversations.history(scope, {
    threadId: conversation.thread_id,
    beforeSeq: null,
    limit: 2,
  });
  expect(newest.items).toEqual(saved.slice(1));
  expect(newest.nextBeforeSeq).toBe(saved[1]?.seq);
  const oldest = await conversations.history(scope, {
    threadId: conversation.thread_id,
    beforeSeq: newest.nextBeforeSeq,
    limit: 2,
  });
  expect(oldest.items).toEqual(saved.slice(0, 1));
  expect(oldest.nextBeforeSeq).toBeNull();
  await expect(
    conversations.history(scope, {
      threadId: conversation.thread_id,
      beforeSeq: 0,
      limit: 2,
    }),
  ).rejects.toThrow("INVALID_CURSOR");
  await expect(
    conversations.history(scope, {
      threadId: conversation.thread_id,
      beforeSeq: null,
      limit: 101,
    }),
  ).rejects.toThrow("INVALID_LIMIT");
});

test("conversation history survives a fresh restricted database connection", async () => {
  const conversation = await createPlatformConversation();
  const message = await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-reconnect-key`,
    content: "durable synthetic history",
    attachments: [],
  });
  const freshData = await openRuntimeDatabase("data");
  try {
    const reopened = createConversationService({ data: freshData });
    await expect(
      reopened.history(scope, {
        threadId: conversation.thread_id,
        beforeSeq: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [message] });
    await expect(
      reopened.resolveBackend(scope, conversation.thread_id),
    ).resolves.toBe("platform");
  } finally {
    await freshData.$client.close();
  }
});

test("unmapped direct platform thread can send uploader's channel attachment", async () => {
  const conversation = await createPlatformConversation();
  const message = await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-direct-attachment-key`,
    content: "direct Bot synthetic send",
    attachments: [directAttachmentId],
  });
  expect(message.attachments).toEqual([directAttachmentId]);
  const [storedAttachment] = await setupDb()
    .select({ attachedAt: attachments.attachedAt })
    .from(attachments)
    .where(eq(attachments.id, directAttachmentId));
  expect(storedAttachment?.attachedAt).toBeInstanceOf(Date);
});

test("foreign principal cannot read another principal's platform history", async () => {
  const conversation = await createPlatformConversation();
  const message = await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-private-key`,
    content: "private synthetic message",
    attachments: [],
  });
  await expect(
    conversations.history(foreignScope, {
      threadId: conversation.thread_id,
      beforeSeq: null,
      limit: 20,
    }),
  ).rejects.toBeDefined();
  expect(message.content).toBe("private synthetic message");
});

test("legacy intelligence mapping remains legacy-owned during migration", async () => {
  await expect(
    conversations.resolveBackend(scope, `${prefix}-legacy-thread`),
  ).resolves.toBe("intelligence");
});

test("legacy channel bindings stay channel-specific and disjoint from principal-private bindings", async () => {
  const firstChannelBinding = await conversations.resolveMastraBinding(
    scope,
    `${prefix}-legacy-thread`,
  );
  const repeatedBinding = await conversations.resolveMastraBinding(
    scope,
    `${prefix}-legacy-thread`,
  );
  const secondChannelBinding = await conversations.resolveMastraBinding(
    scope,
    `${prefix}-race-legacy-thread`,
  );
  const mastraService = createConversationService({
    data: dataDatabase!,
    mastraStorage: {
      async getStore() {
        return { getStore: async () => null };
      },
    } as never,
  });
  const privateConversation = await mastraService.getOrCreate(scope, {});
  const privateBinding = await mastraService.resolveMastraBinding(
    scope,
    privateConversation.thread_id,
  );

  expect(firstChannelBinding.resourceId).toBe(`channel:${channelId}`);
  expect(repeatedBinding.resourceId).toBe(firstChannelBinding.resourceId);
  expect(secondChannelBinding.resourceId).toBe(`channel:${raceChannelId}`);
  expect(secondChannelBinding.resourceId).not.toBe(
    firstChannelBinding.resourceId,
  );
  expect(privateBinding.resourceId).toBe(
    `private:${JSON.stringify([tenantId, principalId])}`,
  );
  expect(privateBinding.resourceId).not.toBe(firstChannelBinding.resourceId);
  expect(privateBinding.resourceId).not.toBe(secondChannelBinding.resourceId);

  await setupDb()
    .delete(enterpriseConversations)
    .where(
      and(
        eq(enterpriseConversations.tenantId, tenantId),
        eq(enterpriseConversations.threadId, privateConversation.thread_id),
      ),
    );
});

test("deleted legacy channel remains legacy-owned and denies platform takeover", async () => {
  const threadId = `${prefix}-legacy-thread`;
  const [original] = await setupDb()
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  try {
    await setupDb()
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    await expect(
      conversations.getOrCreate(scope, { threadId }),
    ).rejects.toThrow("CHANNEL_FORBIDDEN");
    await expect(conversations.resolveBackend(scope, threadId)).rejects.toThrow(
      "CHANNEL_FORBIDDEN",
    );
    const platformRows = await setupDb()
      .select({ id: enterpriseConversations.id })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, threadId));
    expect(platformRows).toEqual([]);
  } finally {
    await setupDb()
      .update(channels)
      .set({ deletedAt: original?.deletedAt ?? null })
      .where(eq(channels.id, channelId));
  }
});

test("attachment references are denied after membership revocation and channel deletion", async () => {
  const conversation = await createPlatformConversation();
  const [original] = await setupDb()
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  try {
    await setupDb()
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actorId),
        ),
      );
    await expect(
      conversations.append(scope, {
        threadId: conversation.thread_id,
        clientMessageKey: `${prefix}-revoked-attachment-key`,
        content: "revoked actor cannot attach",
        attachments: [attachmentId],
      }),
    ).rejects.toBeDefined();

    await setupDb()
      .insert(channelMemberships)
      .values({ channelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    await expect(
      conversations.append(scope, {
        threadId: conversation.thread_id,
        clientMessageKey: `${prefix}-deleted-channel-key`,
        content: "deleted channel attachment is denied",
        attachments: [rollbackAttachmentId],
      }),
    ).rejects.toBeDefined();
  } finally {
    await setupDb()
      .update(channels)
      .set({ deletedAt: original?.deletedAt ?? null })
      .where(eq(channels.id, channelId));
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId, userId: actorId })
      .onConflictDoNothing();
  }
});

test("Mastra attachment denial writes no message, intent, or attachment stamp", async () => {
  let threadId: string | undefined;
  let foreignThreadId: string | undefined;
  let storeCalls = 0;
  let writes = 0;
  const memory = {
    async listMessagesById() {
      return { messages: [] };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages() {
      writes += 1;
      return { messages: [] };
    },
  };
  const mastraStorage = {
    async getStore() {
      storeCalls += 1;
      return { getStore: async () => memory };
    },
    async withConversationLock<T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) {
      storeCalls += 1;
      return run();
    },
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  const [originalChannel] = await setupDb()
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, channelId));
  const originalAttachmentStamps = await setupDb()
    .select({ id: attachments.id, attachedAt: attachments.attachedAt })
    .from(attachments)
    .where(inArray(attachments.id, [attachmentId, rollbackAttachmentId]));
  try {
    const conversation = await service.getOrCreate(scope, {});
    threadId = conversation.thread_id;
    const foreignConversation = await service.getOrCreate(foreignScope, {});
    foreignThreadId = foreignConversation.thread_id;
    storeCalls = 0;
    await expect(
      service.append(foreignScope, {
        threadId: foreignThreadId,
        clientMessageKey: `${prefix}-mastra-foreign-channel-attachment`,
        content: "foreign actor attachment must not be saved",
        attachments: [attachmentId],
      }),
    ).rejects.toThrow("ATTACHMENT_FORBIDDEN");
    await setupDb()
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actorId),
        ),
      );
    await expect(
      service.append(scope, {
        threadId,
        clientMessageKey: `${prefix}-mastra-revoked-channel-attachment`,
        content: "revoked channel attachment must not be saved",
        attachments: [attachmentId],
      }),
    ).rejects.toThrow("ATTACHMENT_FORBIDDEN");

    await setupDb()
      .insert(channelMemberships)
      .values({ channelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, channelId));
    await expect(
      service.append(scope, {
        threadId,
        clientMessageKey: `${prefix}-mastra-deleted-channel-attachment`,
        content: "deleted channel attachment must not be saved",
        attachments: [rollbackAttachmentId],
      }),
    ).rejects.toThrow("ATTACHMENT_FORBIDDEN");

    expect(storeCalls).toBe(0);
    expect(writes).toBe(0);
    const intents = await setupDb()
      .select({ clientMessageKey: mastraMessageIntents.clientMessageKey })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, threadId));
    expect(intents).toEqual([]);
    const foreignIntents = await setupDb()
      .select({ clientMessageKey: mastraMessageIntents.clientMessageKey })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, foreignThreadId!));
    expect(foreignIntents).toEqual([]);
    const stamps = await setupDb()
      .select({ id: attachments.id, attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(inArray(attachments.id, [attachmentId, rollbackAttachmentId]));
    const byId = (rows: typeof originalAttachmentStamps) =>
      rows.toSorted((left, right) => left.id.localeCompare(right.id));
    expect(byId(stamps)).toEqual(byId(originalAttachmentStamps));
  } finally {
    await setupDb()
      .update(channels)
      .set({ deletedAt: originalChannel?.deletedAt ?? null })
      .where(eq(channels.id, channelId));
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId, userId: actorId })
      .onConflictDoNothing();
    for (const cleanupThreadId of [threadId, foreignThreadId]) {
      if (!cleanupThreadId) continue;
      await setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, cleanupThreadId));
      await setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, cleanupThreadId));
      await setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, cleanupThreadId),
          ),
        );
    }
  }
});

test("thread status checks platform ownership before falling back to legacy", async () => {
  const legacyCalls: string[] = [];
  const platformKnown = createThreadReader({
    readPlatform: async (threadId, actor) => {
      expect([threadId, actor]).toEqual([`${prefix}-platform-thread`, actorId]);
      return "known";
    },
    readLegacy: async (threadId) => {
      legacyCalls.push(threadId);
      return "unknown";
    },
  });
  await expect(
    platformKnown(`${prefix}-platform-thread`, actorId),
  ).resolves.toBe("known");
  expect(legacyCalls).toEqual([]);

  const legacyUnknown = createThreadReader({
    readPlatform: async () => "absent",
    readLegacy: async (threadId, actor) => {
      expect([threadId, actor]).toEqual([`${prefix}-old-thread`, actorId]);
      return "unknown";
    },
  });
  await expect(legacyUnknown(`${prefix}-old-thread`, actorId)).resolves.toBe(
    "unknown",
  );
});

test("thread status propagates platform and legacy lookup failures", async () => {
  const platformFailure = new Error("platform store unavailable");
  const failedPlatform = createThreadReader({
    readPlatform: async () => {
      throw platformFailure;
    },
    readLegacy: async () => "unknown",
  });
  await expect(failedPlatform(`${prefix}-thread`, actorId)).rejects.toBe(
    platformFailure,
  );

  const legacyFailure = new Error("legacy service unavailable");
  const failedLegacy = createThreadReader({
    readPlatform: async () => "absent",
    readLegacy: async () => {
      throw legacyFailure;
    },
  });
  await expect(failedLegacy(`${prefix}-thread`, actorId)).rejects.toBe(
    legacyFailure,
  );
});

test("legacy read-grant revocation denies enterprise discovery", async () => {
  const threadId = `${prefix}-legacy-thread`;
  let repositoryStorageCalls = 0;
  const repository = createMastraConversationRepository({
    conversations,
    storage: {
      async getStore() {
        repositoryStorageCalls += 1;
        throw new Error("revoked legacy channel reached tenant storage");
      },
    } as never,
  });
  try {
    const resourcesBefore = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, channelId),
          eq(enterpriseResources.workspaceId, workspaceId),
          eq(enterpriseResources.kind, "channel"),
          eq(enterpriseResources.status, "active"),
        ),
      );
    const grantsBefore = await setupDb()
      .select({ principalId: enterpriseResourceGrants.principalId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          eq(enterpriseResourceGrants.resourceId, channelId),
          eq(enterpriseResourceGrants.principalId, principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      );
    expect(resourcesBefore).toEqual([{ id: channelId }]);
    expect(grantsBefore).toEqual([{ principalId }]);
    await expect(repository.resolve(scope, threadId)).resolves.toMatchObject({
      resourceId: `channel:${channelId}`,
    });
    await expect(conversations.resolveBackend(scope, threadId)).resolves.toBe(
      "intelligence",
    );
    await expect(conversations.list(scope)).resolves.toContainEqual(
      expect.objectContaining({ thread_id: threadId }),
    );

    await setupDb()
      .delete(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          eq(enterpriseResourceGrants.resourceId, channelId),
          eq(enterpriseResourceGrants.principalId, principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      );
    const grants = await setupDb()
      .select({ principalId: enterpriseResourceGrants.principalId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          eq(enterpriseResourceGrants.resourceId, channelId),
          eq(enterpriseResourceGrants.principalId, principalId),
        ),
      );
    expect(grants).toEqual([]);
    const memberships = await setupDb()
      .select({ userId: channelMemberships.userId })
      .from(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, actorId),
        ),
      );
    expect(memberships).toEqual([{ userId: actorId }]);
    const mappings = await setupDb()
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.channelId, channelId),
          eq(intelligenceChannelMappings.userId, actorId),
          eq(intelligenceChannelMappings.threadId, threadId),
        ),
      );
    expect(mappings).toEqual([{ threadId }]);
    const resourcesAfterDelete = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, channelId),
        ),
      );
    expect(resourcesAfterDelete).toEqual([{ id: channelId }]);
    await expect(conversations.resolveBackend(scope, threadId)).rejects.toThrow(
      "CHANNEL_FORBIDDEN",
    );
    await expect(
      conversations.getOrCreate(scope, { threadId }),
    ).rejects.toThrow("CHANNEL_FORBIDDEN");
    await expect(repository.resolve(scope, threadId)).rejects.toThrow(
      "CHANNEL_FORBIDDEN",
    );
    await expect(
      repository.history(scope, {
        threadId,
        beforeSeq: null,
        limit: 20,
      }),
    ).rejects.toThrow("CHANNEL_FORBIDDEN");
    expect(repositoryStorageCalls).toBe(0);
    await expect(conversations.list(scope)).resolves.not.toContainEqual(
      expect.objectContaining({ thread_id: threadId }),
    );
  } finally {
    await setupDb()
      .insert(enterpriseResourceGrants)
      .values({
        tenantId,
        resourceId: channelId,
        principalId,
        action: "read",
      })
      .onConflictDoNothing();
  }
});

test("legacy resource absence denies enterprise discovery", async () => {
  const threadId = `${prefix}-legacy-thread`;
  try {
    const resourcesBefore = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, channelId),
          eq(enterpriseResources.workspaceId, workspaceId),
          eq(enterpriseResources.kind, "channel"),
          eq(enterpriseResources.status, "active"),
        ),
      );
    const grantsBefore = await setupDb()
      .select({ principalId: enterpriseResourceGrants.principalId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          eq(enterpriseResourceGrants.resourceId, channelId),
          eq(enterpriseResourceGrants.principalId, principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      );
    expect(resourcesBefore).toEqual([{ id: channelId }]);
    expect(grantsBefore).toEqual([{ principalId }]);
    await expect(conversations.resolveBackend(scope, threadId)).resolves.toBe(
      "intelligence",
    );
    await expect(conversations.list(scope)).resolves.toContainEqual(
      expect.objectContaining({ thread_id: threadId }),
    );

    await setupDb()
      .delete(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, channelId),
        ),
      );
    const resourcesAfterDelete = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.id, channelId),
        ),
      );
    const grantsAfterDelete = await setupDb()
      .select({ principalId: enterpriseResourceGrants.principalId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          eq(enterpriseResourceGrants.resourceId, channelId),
          eq(enterpriseResourceGrants.principalId, principalId),
        ),
      );
    expect(resourcesAfterDelete).toEqual([]);
    expect(grantsAfterDelete).toEqual([]);
    expect(
      await setupDb()
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actorId),
          ),
        ),
    ).toEqual([{ userId: actorId }]);
    expect(
      await setupDb()
        .select({ threadId: intelligenceChannelMappings.threadId })
        .from(intelligenceChannelMappings)
        .where(
          and(
            eq(intelligenceChannelMappings.channelId, channelId),
            eq(intelligenceChannelMappings.userId, actorId),
            eq(intelligenceChannelMappings.threadId, threadId),
          ),
        ),
    ).toEqual([{ threadId }]);
    await expect(conversations.resolveBackend(scope, threadId)).rejects.toThrow(
      "CHANNEL_FORBIDDEN",
    );
    await expect(conversations.list(scope)).resolves.not.toContainEqual(
      expect.objectContaining({ thread_id: threadId }),
    );
  } finally {
    await setupDb()
      .insert(enterpriseResources)
      .values({
        tenantId,
        id: channelId,
        workspaceId,
        kind: "channel",
        status: "active",
        displayName: "Synthetic conversation channel",
      })
      .onConflictDoNothing();
    await setupDb()
      .insert(enterpriseResourceGrants)
      .values({
        tenantId,
        resourceId: channelId,
        principalId,
        action: "read",
      })
      .onConflictDoNothing();
  }
});

test("legacy discovery limits after excluding unauthorized newer mappings", async () => {
  const olderThreadId = `${prefix}-legacy-thread`;
  const deniedRows = Array.from({ length: 101 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      channelId: `${prefix}-q01-denied-channel-${suffix}`,
      threadId: `${prefix}-q01-denied-thread-${suffix}`,
      updatedAt: new Date(Date.now() + (index + 1) * 1_000),
    };
  });
  const deniedChannelIds = deniedRows.map((row) => row.channelId);
  const originalMapping = await setupDb()
    .select({ updatedAt: intelligenceChannelMappings.updatedAt })
    .from(intelligenceChannelMappings)
    .where(
      and(
        eq(intelligenceChannelMappings.userId, actorId),
        eq(intelligenceChannelMappings.channelId, channelId),
        eq(intelligenceChannelMappings.threadId, olderThreadId),
      ),
    )
    .then((rows) => rows[0]);
  expect(originalMapping).toBeDefined();

  try {
    await setupDb()
      .update(intelligenceChannelMappings)
      .set({ updatedAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(
        and(
          eq(intelligenceChannelMappings.userId, actorId),
          eq(intelligenceChannelMappings.channelId, channelId),
          eq(intelligenceChannelMappings.threadId, olderThreadId),
        ),
      );
    await setupDb()
      .insert(channels)
      .values(
        deniedRows.map(({ channelId: deniedChannelId }) => ({
          id: deniedChannelId,
          name: "Synthetic unauthorized newer channel",
          description: "Q01 list ordering fixture",
        })),
      );
    await setupDb()
      .insert(channelMemberships)
      .values(
        deniedChannelIds.map((deniedChannelId) => ({
          channelId: deniedChannelId,
          userId: actorId,
        })),
      );
    await setupDb()
      .insert(intelligenceChannelMappings)
      .values(
        deniedRows.map(
          ({ channelId: deniedChannelId, threadId, updatedAt }) => ({
            userId: actorId,
            channelId: deniedChannelId,
            threadId,
            updatedAt,
          }),
        ),
      );

    const olderResource = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .innerJoin(
        enterpriseResourceGrants,
        and(
          eq(enterpriseResourceGrants.tenantId, enterpriseResources.tenantId),
          eq(enterpriseResourceGrants.resourceId, enterpriseResources.id),
          eq(enterpriseResourceGrants.principalId, principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      )
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          eq(enterpriseResources.workspaceId, workspaceId),
          eq(enterpriseResources.id, channelId),
          eq(enterpriseResources.kind, "channel"),
          eq(enterpriseResources.status, "active"),
        ),
      );
    const newerMappings = await setupDb()
      .select({
        threadId: intelligenceChannelMappings.threadId,
        updatedAt: intelligenceChannelMappings.updatedAt,
      })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channelMemberships,
        and(
          eq(
            channelMemberships.channelId,
            intelligenceChannelMappings.channelId,
          ),
          eq(channelMemberships.userId, actorId),
        ),
      )
      .where(
        and(
          eq(intelligenceChannelMappings.userId, actorId),
          inArray(intelligenceChannelMappings.channelId, deniedChannelIds),
        ),
      );
    const deniedResources = await setupDb()
      .select({ id: enterpriseResources.id })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, tenantId),
          inArray(enterpriseResources.id, deniedChannelIds),
        ),
      );
    const deniedGrants = await setupDb()
      .select({ resourceId: enterpriseResourceGrants.resourceId })
      .from(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, tenantId),
          inArray(enterpriseResourceGrants.resourceId, deniedChannelIds),
        ),
      );
    expect(olderResource).toEqual([{ id: channelId }]);
    expect(newerMappings).toHaveLength(101);
    expect(
      newerMappings.every(
        (row) =>
          row.updatedAt.getTime() >
          new Date("2000-01-01T00:00:00.000Z").getTime(),
      ),
    ).toBe(true);
    expect(deniedResources).toEqual([]);
    expect(deniedGrants).toEqual([]);
    await expect(
      conversations.resolveBackend(scope, olderThreadId),
    ).resolves.toBe("intelligence");
    const listed = await conversations.list(scope);
    expect(listed).toContainEqual(
      expect.objectContaining({ thread_id: olderThreadId }),
    );
    expect(
      deniedRows.every(
        ({ threadId }) =>
          !listed.some((conversation) => conversation.thread_id === threadId),
      ),
    ).toBe(true);
  } finally {
    await setupDb()
      .delete(intelligenceChannelMappings)
      .where(
        inArray(
          intelligenceChannelMappings.threadId,
          deniedRows.map((row) => row.threadId),
        ),
      );
    await setupDb()
      .delete(channelMemberships)
      .where(inArray(channelMemberships.channelId, deniedChannelIds));
    await setupDb()
      .delete(channels)
      .where(inArray(channels.id, deniedChannelIds));
    if (originalMapping) {
      await setupDb()
        .update(intelligenceChannelMappings)
        .set({ updatedAt: originalMapping.updatedAt })
        .where(
          and(
            eq(intelligenceChannelMappings.userId, actorId),
            eq(intelligenceChannelMappings.channelId, channelId),
            eq(intelligenceChannelMappings.threadId, olderThreadId),
          ),
        );
    }
  }
});

test("empty messages are invalid while attachment-only messages are accepted", async () => {
  const conversation = await createPlatformConversation();
  await expect(
    conversations.append(scope, {
      threadId: conversation.thread_id,
      clientMessageKey: `${prefix}-empty-message-key`,
      content: " \r\n ",
      attachments: [],
    }),
  ).rejects.toThrow("INVALID_MESSAGE");

  const attachmentOnly = await conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-attachment-only-key`,
    content: "",
    attachments: [attachmentId],
  });
  expect(attachmentOnly.content).toBe("");
  expect(attachmentOnly.attachments).toEqual([attachmentId]);
});

test("reader-first legacy removal waits for the shared channel lock", async () => {
  let releaseReader!: () => void;
  let readerLocked!: () => void;
  let reportReaderPid!: (pid: number) => void;
  const locked = new Promise<void>((resolve) => {
    readerLocked = resolve;
  });
  const readerPidReady = new Promise<number>((resolve) => {
    reportReaderPid = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  const reader = setupDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${legacyChannelLockKey(raceChannelId)}, 0))`,
    );
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    const readerPid = Number(firstQueryRow(result)?.pid);
    reportReaderPid(readerPid);
    readerLocked();
    await release;
  });
  await locked;
  const readerPid = await readerPidReady;

  const removeMember = createGroupStore(setupDb(), () => "unused").removeMember(
    raceChannelId,
    actorId,
  );
  const waiter = waitForAdvisoryLockWaiter(readerPid);
  let observedWaiter = false;
  try {
    observedWaiter = await waiter;
    releaseReader();
    await Promise.allSettled([reader, removeMember, waiter]);
    expect(observedWaiter).toBe(true);
    await expect(
      conversations.resolveBackend(scope, `${prefix}-race-legacy-thread`),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
  } finally {
    releaseReader();
    await Promise.allSettled([reader, removeMember, waiter]);
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId: raceChannelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .insert(intelligenceChannelMappings)
      .values({
        userId: actorId,
        channelId: raceChannelId,
        threadId: `${prefix}-race-legacy-thread`,
      })
      .onConflictDoNothing();
  }
});

test("writer-first legacy removal makes a queued reader observe revocation", async () => {
  const key = legacyChannelLockKey(raceChannelId);
  let releaseWriter!: () => void;
  let writerReady!: () => void;
  let reportWriterPid!: (pid: number) => void;
  const ready = new Promise<void>((resolve) => {
    writerReady = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const writerPidReady = new Promise<number>((resolve) => {
    reportWriterPid = resolve;
  });
  const writer = setupDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    const writerPid = Number(firstQueryRow(result)?.pid);
    reportWriterPid(writerPid);
    await tx
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, raceChannelId),
          eq(channelMemberships.userId, actorId),
        ),
      );
    await tx
      .delete(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.channelId, raceChannelId),
          eq(intelligenceChannelMappings.userId, actorId),
        ),
      );
    writerReady();
    await release;
  });
  await ready;
  const writerPid = await writerPidReady;
  // This is an actual PostgreSQL exclusive transaction lock; the reader's bounded waiter
  // check establishes ordering before the writer commits.
  const lookup = conversations.resolveBackend(
    scope,
    `${prefix}-race-legacy-thread`,
  );
  const waiter = waitForAdvisoryLockWaiter(writerPid);
  let observedWaiter = false;
  try {
    observedWaiter = await waiter;
    releaseWriter();
    await Promise.allSettled([writer, lookup, waiter]);
    expect(observedWaiter).toBe(true);
    await expect(lookup).rejects.toThrow("CONVERSATION_NOT_FOUND");
  } finally {
    releaseWriter();
    await Promise.allSettled([writer, lookup, waiter]);
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId: raceChannelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .insert(intelligenceChannelMappings)
      .values({
        userId: actorId,
        channelId: raceChannelId,
        threadId: `${prefix}-race-legacy-thread`,
      })
      .onConflictDoNothing();
  }
});

test("channel soft delete takes the production exclusive legacy channel lock", async () => {
  const [original] = await setupDb()
    .select({ deletedAt: channels.deletedAt })
    .from(channels)
    .where(eq(channels.id, raceChannelId));
  let releaseReader!: () => void;
  let readerLocked!: () => void;
  let reportReaderPid!: (pid: number) => void;
  const locked = new Promise<void>((resolve) => {
    readerLocked = resolve;
  });
  const readerPidReady = new Promise<number>((resolve) => {
    reportReaderPid = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  const reader = setupDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${legacyChannelLockKey(raceChannelId)}, 0))`,
    );
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    reportReaderPid(Number(firstQueryRow(result)?.pid));
    readerLocked();
    await release;
  });
  await locked;
  const readerPid = await readerPidReady;
  const softDelete = createChannelStore(
    setupDb(),
    {} as never,
    createThreadIdentity("conversation-test"),
  ).softDelete({ id: actorId, role: "user" }, raceChannelId);
  const waiter = waitForAdvisoryLockWaiter(readerPid);
  let observedWaiter = false;
  try {
    observedWaiter = await waiter;
    releaseReader();
    await Promise.allSettled([reader, softDelete, waiter]);
    expect(observedWaiter).toBe(true);
    await expect(
      conversations.resolveBackend(scope, `${prefix}-race-legacy-thread`),
    ).rejects.toThrow("CHANNEL_FORBIDDEN");
  } finally {
    releaseReader();
    await Promise.allSettled([reader, softDelete, waiter]);
    await setupDb()
      .update(channels)
      .set({ deletedAt: original?.deletedAt ?? null })
      .where(eq(channels.id, raceChannelId));
  }
});

test("attachment send waits for removal and does not stamp after revocation", async () => {
  const conversation = await createPlatformConversation();
  let releaseWriter!: () => void;
  let writerReady!: () => void;
  let reportWriterPid!: (pid: number) => void;
  const ready = new Promise<void>((resolve) => {
    writerReady = resolve;
  });
  const writerPidReady = new Promise<number>((resolve) => {
    reportWriterPid = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const writer = setupDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${legacyChannelLockKey(raceChannelId)}, 0))`,
    );
    const result = await tx.execute(sql`select pg_backend_pid() as pid`);
    reportWriterPid(Number(firstQueryRow(result)?.pid));
    await tx
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, raceChannelId),
          eq(channelMemberships.userId, actorId),
        ),
      );
    await tx
      .delete(intelligenceChannelMappings)
      .where(
        and(
          eq(intelligenceChannelMappings.channelId, raceChannelId),
          eq(intelligenceChannelMappings.userId, actorId),
        ),
      );
    writerReady();
    await release;
  });
  await ready;
  const writerPid = await writerPidReady;
  const append = conversations.append(scope, {
    threadId: conversation.thread_id,
    clientMessageKey: `${prefix}-revoked-attachment-race-key`,
    content: "must not stamp after channel removal",
    attachments: [raceAttachmentId],
  });
  const waiter = waitForAdvisoryLockWaiter(writerPid);
  let observedWaiter = false;
  try {
    observedWaiter = await waiter;
    releaseWriter();
    await Promise.allSettled([writer, append, waiter]);
    expect(observedWaiter).toBe(true);
    await expect(append).rejects.toThrow("ATTACHMENT_FORBIDDEN");
    const [row] = await setupDb()
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, raceAttachmentId));
    expect(row?.attachedAt).toBeNull();
  } finally {
    releaseWriter();
    await Promise.allSettled([writer, append, waiter]);
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId: raceChannelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .insert(intelligenceChannelMappings)
      .values({
        userId: actorId,
        channelId: raceChannelId,
        threadId: `${prefix}-race-legacy-thread`,
      })
      .onConflictDoNothing();
  }
});

test("leaving a group cannot turn its former thread into a platform transcript", async () => {
  const threadId = `${prefix}-legacy-thread`;
  try {
    await createGroupStore(setupDb(), () => "unused").removeMember(
      channelId,
      actorId,
    );

    await expect(
      conversations.getOrCreate(scope, { threadId }),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await expect(
      conversations.append(scope, {
        threadId,
        clientMessageKey: `${prefix}-former-legacy-key`,
        content: "must not create a second transcript",
        attachments: [],
      }),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
    const platformRows = await setupDb()
      .select({ threadId: enterpriseConversations.threadId })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, threadId));
    const messageRows = await setupDb()
      .select({ threadId: enterpriseMessages.threadId })
      .from(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId));
    expect(platformRows).toEqual([]);
    expect(messageRows).toEqual([]);
  } finally {
    await setupDb()
      .delete(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId));
    await setupDb()
      .delete(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, tenantId),
          eq(enterpriseConversations.threadId, threadId),
        ),
      );
    await setupDb()
      .insert(channelMemberships)
      .values({ channelId, userId: actorId })
      .onConflictDoNothing();
    await setupDb()
      .insert(intelligenceChannelMappings)
      .values({ userId: actorId, channelId, threadId })
      .onConflictDoNothing();
  }
});

test("a Mastra-backed public conversation writes and reads only through Mastra", async () => {
  let threadId: string | undefined;
  type FakeMessage = {
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  };
  const persisted: FakeMessage[] = [];
  const memory = {
    async listMessages() {
      return { messages: [...persisted], total: persisted.length };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async saveMessages({ messages }: { messages: FakeMessage[] }) {
      persisted.push(...messages);
      return { messages };
    },
  };
  const store = { getStore: async () => memory };
  const mastraStorage = {
    getStore: async () => store,
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  try {
    const conversation = await service.getOrCreate(scope, {});
    threadId = conversation.thread_id;
    const createdThreadId = conversation.thread_id;
    expect(conversation.storage_backend).toBe("mastra");

    const appended = await service.append(scope, {
      threadId: createdThreadId,
      clientMessageKey: `${prefix}-mastra-public-key`,
      content: "stored once in Mastra",
      attachments: [],
    });
    expect(appended.seq).toBe(1);
    expect(persisted).toHaveLength(1);

    const history = await service.history(scope, {
      threadId: createdThreadId,
      beforeSeq: null,
      limit: 20,
    });
    expect(history.items.map(({ content }) => content)).toEqual([
      "stored once in Mastra",
    ]);
    expect(persisted).toHaveLength(1);
    const platformRows = await setupDb()
      .select({ threadId: enterpriseMessages.threadId })
      .from(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, createdThreadId));
    expect(platformRows).toEqual([]);
  } finally {
    await setupDb()
      .delete(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId ?? ""));
    await setupDb()
      .delete(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, tenantId),
          eq(enterpriseConversations.threadId, threadId ?? ""),
        ),
      );
  }
});

test("a persisted Mastra backend and incremented version direct the next append to tenant storage", async () => {
  const conversation = await createPlatformConversation();
  const threadId = conversation.thread_id;
  const bindings: Array<{ backend: string; resourceId: string }> = [];
  const persisted: Array<{
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  }> = [];
  const memory = {
    async listMessages() {
      return { messages: [...persisted], total: persisted.length };
    },
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages({ messages }: { messages: typeof persisted }) {
      persisted.push(...messages);
      return { messages };
    },
  };
  const mastraStorage = {
    async getStore(
      _scope: unknown,
      binding: { backend: string; resourceId: string },
    ) {
      bindings.push(binding);
      return { getStore: async () => memory };
    },
    async withConversationLock<T>(
      _scope: unknown,
      binding: { backend: string; resourceId: string },
      run: () => Promise<T>,
    ) {
      bindings.push(binding);
      return run();
    },
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });

  try {
    await setupDb()
      .update(enterpriseConversations)
      .set({ storageBackend: "mastra", backendVersion: 2 })
      .where(
        and(
          eq(enterpriseConversations.tenantId, tenantId),
          eq(enterpriseConversations.threadId, threadId),
        ),
      );
    const changed = await setupDb()
      .select({
        storageBackend: enterpriseConversations.storageBackend,
        backendVersion: enterpriseConversations.backendVersion,
      })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, threadId));
    expect(changed).toEqual([{ storageBackend: "mastra", backendVersion: 2 }]);

    const message = await service.append(scope, {
      threadId,
      clientMessageKey: `${prefix}-persisted-backend-dispatch`,
      content: "dispatch follows persisted backend",
      attachments: [],
    });
    expect(message).toMatchObject({
      threadId,
      seq: 1,
      content: "dispatch follows persisted backend",
    });
    expect(persisted).toHaveLength(1);
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every(({ backend }) => backend === "mastra")).toBe(true);
    expect(
      bindings.every(
        ({ resourceId }) =>
          resourceId === `private:${JSON.stringify([tenantId, principalId])}`,
      ),
    ).toBe(true);
    const platformRows = await setupDb()
      .select({ id: enterpriseMessages.id })
      .from(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId));
    expect(platformRows).toEqual([]);
    const intents = await setupDb()
      .select({
        state: mastraMessageIntents.state,
        backendVersion: mastraMessageIntents.backendVersion,
      })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, threadId));
    expect(intents).toEqual([{ state: "finalized", backendVersion: 2 }]);
  } finally {
    await setupDb()
      .delete(mastraMessageIntentAttachments)
      .where(eq(mastraMessageIntentAttachments.threadId, threadId));
    await setupDb()
      .delete(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, threadId));
    await setupDb()
      .delete(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId));
    await setupDb()
      .delete(enterpriseConversations)
      .where(
        and(
          eq(enterpriseConversations.tenantId, tenantId),
          eq(enterpriseConversations.threadId, threadId),
        ),
      );
    const remaining = await setupDb()
      .select({ threadId: enterpriseConversations.threadId })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, threadId));
    expect(remaining).toEqual([]);
  }
});

test("trusted reconciler finalizes an accepted write after revocation without writing Mastra", async () => {
  const attachmentId = randomUUID();
  const blockerToken = randomUUID().replaceAll("-", "");
  const triggerName = `m02r1br1_${blockerToken}_fail_finalize`;
  const functionName = `${triggerName}_fn`;
  let threadId: string | undefined;
  const persisted: Array<{
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  }> = [];
  const observations: Array<{ binding: unknown; expected: unknown }> = [];
  let saveCount = 0;
  let threadSaveCount = 0;
  const memory = {
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {
      threadSaveCount += 1;
    },
    async saveMessages({
      messages,
    }: {
      messages: (typeof persisted)[number][];
    }) {
      saveCount += 1;
      persisted.push(...messages);
      return { messages };
    },
  };
  const mastraStorage = {
    getStore: async () => ({ getStore: async () => memory }),
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
    async inspectIntentMessage(
      binding: {
        threadId: string;
        resourceId: string;
      },
      expected: {
        messageId: string;
        digest: string;
        seq: number;
        clientMessageKey: string;
        attachmentIds: string[];
      },
    ) {
      observations.push({ binding, expected });
      const found = persisted.find(({ id }) => id === expected.messageId);
      if (!found) return "absent" as const;
      const metadata = found.content.metadata;
      return found.threadId === binding.threadId &&
        found.resourceId === binding.resourceId &&
        metadata.openbotDigest === expected.digest &&
        metadata.openbotSeq === expected.seq &&
        metadata.openbotClientMessageKey === expected.clientMessageKey &&
        JSON.stringify(metadata.openbotAttachments) ===
          JSON.stringify(expected.attachmentIds)
        ? ("exact" as const)
        : ("mismatch" as const);
    },
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  const clientMessageKey = `${prefix}-accepted-write-reconcile`;
  const content = "accepted before the membership was revoked";
  let testFailure: unknown;
  const cleanupFailures: unknown[] = [];

  async function removeBlocker() {
    await setupDb().execute(
      sql.raw(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON public.mastra_message_intents`,
      ),
    );
    await setupDb().execute(
      sql.raw(`DROP FUNCTION IF EXISTS public."${functionName}"()`),
    );
    const result = await setupDb().execute(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = ${triggerName} AND NOT tgisinternal
        ) AS trigger_exists,
        EXISTS (
          SELECT 1 FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public' AND procedure.proname = ${functionName}
        ) AS function_exists
    `);
    expect(firstQueryRow(result)).toMatchObject({
      trigger_exists: false,
      function_exists: false,
    });
  }

  try {
    await setupDb()
      .insert(attachments)
      .values({
        id: attachmentId,
        channelId,
        uploadedBy: reconcileActorId,
        name: "r1-reconcile.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        bytes: Buffer.from("exact"),
      });
    const conversation = await service.getOrCreate(reconcileScope, {});
    threadId = conversation.thread_id;
    await setupDb().execute(
      sql.raw(`
        CREATE FUNCTION public."${functionName}"()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.thread_id = '${threadId}' AND NEW.state = 'finalized' THEN
            RAISE EXCEPTION 'synthetic task finalization fault';
          END IF;
          RETURN NEW;
        END
        $$
      `),
    );
    await setupDb().execute(
      sql.raw(`
        CREATE TRIGGER "${triggerName}"
        BEFORE UPDATE ON public.mastra_message_intents
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
      `),
    );

    const input = {
      threadId,
      clientMessageKey,
      content,
      attachments: [attachmentId],
    };
    await expect(service.append(reconcileScope, input)).rejects.toMatchObject({
      code: "message_pending",
      status: 503,
    });
    expect(saveCount).toBe(1);
    const [pending] = await setupDb()
      .select()
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
    expect(pending?.state).toBe("pending");
    const [unstamped] = await setupDb()
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(unstamped?.attachedAt).toBeNull();
    const writesBeforeReconcile = { saveCount, threadSaveCount };

    await removeBlocker();
    const revoked = await suspendMembership(operatorDatabase!, {
      operationId: `${prefix}-reconcile-revoke`,
      operator: principalId,
      tenantId,
      principalId: reconcilePrincipalId,
    });
    expect(revoked.changed).toBe(true);
    await expect(
      service.history(reconcileScope, {
        threadId,
        beforeSeq: null,
        limit: 20,
      }),
    ).rejects.toThrow("SCOPE_REVOKED");
    await expect(service.append(reconcileScope, input)).rejects.toThrow(
      "SCOPE_REVOKED",
    );

    const reconciler = createMastraMessageIntentReconciler({
      data: dataDatabase!,
      mastraStorage,
    });
    const outcome = await reconciler.reconcilePendingForTenant(tenantId, 10);
    expect(outcome).toEqual({
      scanned: 1,
      finalized: 1,
      pending: 0,
      absent: 0,
      mismatch: 0,
    });
    expect(saveCount).toBe(1);
    expect({ saveCount, threadSaveCount }).toEqual(writesBeforeReconcile);
    const [finalized] = await setupDb()
      .select()
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
    expect(finalized?.state).toBe("finalized");
    expect(finalized?.attachmentIds).toEqual([attachmentId]);
    const [stamped] = await setupDb()
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(stamped?.attachedAt).toBeInstanceOf(Date);
    const pendingRefs = await setupDb()
      .select()
      .from(mastraMessageIntentAttachments)
      .where(
        eq(mastraMessageIntentAttachments.clientMessageKey, clientMessageKey),
      );
    expect(pendingRefs).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.binding).toMatchObject({
      tenantId,
      threadId,
      resourceId: `private:${JSON.stringify([tenantId, reconcilePrincipalId])}`,
      storageKey: tenantStorageKey(tenantId),
      backend: "mastra",
    });
    expect(observations[0]?.expected).toMatchObject({
      messageId: pending?.messageId,
      digest: pending?.digest,
      seq: pending?.reservedSeq,
      clientMessageKey,
      attachmentIds: [attachmentId],
    });
    expect(Object.keys(outcome)).not.toContain("content");
  } catch (error) {
    testFailure = error;
  } finally {
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    await clean(removeBlocker);
    if (threadId) {
      await clean(() =>
        setupDb()
          .delete(mastraMessageIntentAttachments)
          .where(eq(mastraMessageIntentAttachments.threadId, threadId!)),
      );
      await clean(() =>
        setupDb()
          .delete(mastraMessageIntents)
          .where(eq(mastraMessageIntents.threadId, threadId!)),
      );
      await clean(() =>
        setupDb()
          .delete(enterpriseMessages)
          .where(eq(enterpriseMessages.threadId, threadId!)),
      );
      await clean(() =>
        setupDb()
          .delete(enterpriseConversations)
          .where(
            and(
              eq(enterpriseConversations.tenantId, tenantId),
              eq(enterpriseConversations.threadId, threadId!),
            ),
          ),
      );
    }
    await clean(() =>
      setupDb().delete(attachments).where(eq(attachments.id, attachmentId)),
    );
  }
  if (cleanupFailures.length || testFailure !== undefined)
    throw new AggregateError(
      [...(testFailure === undefined ? [] : [testFailure]), ...cleanupFailures],
      `R1B-R1 reconciliation fixture cleanup failed: trigger=${triggerName} function=${functionName} thread=${threadId ?? "<not-created>"} attachment=${attachmentId}`,
    );
});

test("trusted reconciler leaves absent and mismatched Mastra writes pending", async () => {
  for (const inspection of ["absent", "mismatch"] as const) {
    const attachmentId = randomUUID();
    const clientMessageKey = `${prefix}-reconcile-${inspection}`;
    let threadId: string | undefined;
    let saveCount = 0;
    let testFailure: unknown;
    const cleanupFailures: unknown[] = [];
    const persisted: Array<{
      id: string;
      threadId: string;
      resourceId: string;
      role: "user";
      type: "text";
      createdAt: Date;
      content: {
        format: 2;
        parts: Array<{ type: "text"; text: string }>;
        metadata: Record<string, unknown>;
      };
    }> = [];
    const memory = {
      async listMessagesById({ messageIds }: { messageIds: string[] }) {
        return {
          messages: persisted.filter(({ id }) => messageIds.includes(id)),
        };
      },
      async getThreadById() {
        return null;
      },
      async saveThread() {},
      async saveMessages({
        messages,
      }: {
        messages: (typeof persisted)[number][];
      }) {
        saveCount += 1;
        if (inspection === "absent")
          throw new Error("synthetic unconfirmed Mastra write");
        const [message] = messages;
        if (!message) throw new Error("synthetic message missing");
        const mismatched = {
          ...message,
          content: {
            ...message.content,
            metadata: {
              ...message.content.metadata,
              openbotDigest: "wrong-digest",
            },
          },
        };
        persisted.push(mismatched);
        return { messages: [mismatched] };
      },
    };
    const mastraStorage = {
      getStore: async () => ({ getStore: async () => memory }),
      withConversationLock: async <T>(
        _scope: unknown,
        _binding: unknown,
        run: () => Promise<T>,
      ) => run(),
      async inspectIntentMessage(
        binding: { threadId: string; resourceId: string },
        expected: {
          messageId: string;
          digest: string;
          seq: number;
          clientMessageKey: string;
          attachmentIds: string[];
        },
      ) {
        const found = persisted.find(({ id }) => id === expected.messageId);
        if (!found) return "absent" as const;
        const metadata = found.content.metadata;
        return found.threadId === binding.threadId &&
          found.resourceId === binding.resourceId &&
          metadata.openbotDigest === expected.digest &&
          metadata.openbotSeq === expected.seq &&
          metadata.openbotClientMessageKey === expected.clientMessageKey &&
          JSON.stringify(metadata.openbotAttachments) ===
            JSON.stringify(expected.attachmentIds)
          ? ("exact" as const)
          : ("mismatch" as const);
      },
    } as never;
    try {
      await setupDb()
        .insert(attachments)
        .values({
          id: attachmentId,
          channelId,
          uploadedBy: actorId,
          name: `${inspection}-reconcile.txt`,
          mimeType: "text/plain",
          sizeBytes: 5,
          bytes: Buffer.from("hold!"),
        });
      const service = createConversationService({
        data: dataDatabase!,
        mastraStorage,
      });
      const conversation = await service.getOrCreate(scope, {});
      threadId = conversation.thread_id;
      await expect(
        service.append(scope, {
          threadId,
          clientMessageKey,
          content: `recover ${inspection}`,
          attachments: [attachmentId],
        }),
      ).rejects.toMatchObject({ code: "message_pending", status: 503 });
      expect(saveCount).toBe(1);
      const [beforeIntent] = await setupDb()
        .select({ updatedAt: mastraMessageIntents.updatedAt })
        .from(mastraMessageIntents)
        .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
      expect(beforeIntent?.updatedAt).toBeInstanceOf(Date);

      const reconciler = createMastraMessageIntentReconciler({
        data: dataDatabase!,
        mastraStorage,
      });
      const outcome = await reconciler.reconcilePendingForTenant(tenantId, 10);
      expect(outcome).toMatchObject({
        scanned: 1,
        finalized: 0,
        pending: 1,
        absent: inspection === "absent" ? 1 : 0,
        mismatch: inspection === "mismatch" ? 1 : 0,
      });
      expect(saveCount).toBe(1);
      const [intent] = await setupDb()
        .select({
          state: mastraMessageIntents.state,
          updatedAt: mastraMessageIntents.updatedAt,
        })
        .from(mastraMessageIntents)
        .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
      expect(intent?.state).toBe("pending");
      expect(intent?.updatedAt.getTime()).toBeGreaterThan(
        beforeIntent!.updatedAt.getTime(),
      );
      const [attachment] = await setupDb()
        .select({ attachedAt: attachments.attachedAt })
        .from(attachments)
        .where(eq(attachments.id, attachmentId));
      expect(attachment?.attachedAt).toBeNull();
      const references = await setupDb()
        .select({ attachmentId: mastraMessageIntentAttachments.attachmentId })
        .from(mastraMessageIntentAttachments)
        .where(
          eq(mastraMessageIntentAttachments.clientMessageKey, clientMessageKey),
        );
      expect(references).toEqual([{ attachmentId }]);
    } catch (error) {
      testFailure = error;
    } finally {
      const clean = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          cleanupFailures.push(error);
        }
      };
      if (threadId) {
        await clean(() =>
          setupDb()
            .delete(mastraMessageIntentAttachments)
            .where(eq(mastraMessageIntentAttachments.threadId, threadId!)),
        );
        await clean(() =>
          setupDb()
            .delete(mastraMessageIntents)
            .where(eq(mastraMessageIntents.threadId, threadId!)),
        );
        await clean(() =>
          setupDb()
            .delete(enterpriseMessages)
            .where(eq(enterpriseMessages.threadId, threadId!)),
        );
        await clean(() =>
          setupDb()
            .delete(enterpriseConversations)
            .where(
              and(
                eq(enterpriseConversations.tenantId, tenantId),
                eq(enterpriseConversations.threadId, threadId!),
              ),
            ),
        );
      }
      await clean(() =>
        setupDb().delete(attachments).where(eq(attachments.id, attachmentId)),
      );
    }
    if (cleanupFailures.length || testFailure !== undefined)
      throw new AggregateError(
        [
          ...(testFailure === undefined ? [] : [testFailure]),
          ...cleanupFailures,
        ],
        `R1B-R1 exactness fixture cleanup failed: thread=${threadId ?? "<not-created>"} attachment=${attachmentId} clientMessageKey=${clientMessageKey}`,
      );
  }
});

test("Mastra attachment intent stays pending until confirmed and same-key retry finalizes once", async () => {
  const attachmentId = randomUUID();
  let threadId: string | undefined;
  let failNextWrite = true;
  let writeCount = 0;
  type FakeMessage = {
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  };
  const persisted: FakeMessage[] = [];
  const memory = {
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages({ messages }: { messages: FakeMessage[] }) {
      const [row] = await setupDb()
        .select({ attachedAt: attachments.attachedAt })
        .from(attachments)
        .where(eq(attachments.id, attachmentId));
      expect(row?.attachedAt).toBeNull();
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("synthetic Mastra write failure");
      }
      writeCount += 1;
      persisted.push(...messages);
      return { messages };
    },
  };
  const mastraStorage = {
    getStore: async () => ({ getStore: async () => memory }),
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  const clientMessageKey = `${prefix}-mastra-attachment-saga`;
  try {
    await setupDb()
      .insert(attachments)
      .values({
        id: attachmentId,
        channelId,
        uploadedBy: actorId,
        name: "mastra-saga.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        bytes: Buffer.from("saga!"),
      });
    const conversation = await service.getOrCreate(scope, {});
    threadId = conversation.thread_id;
    const message = {
      threadId,
      clientMessageKey,
      content: "attach after Mastra confirms",
      attachments: [attachmentId],
    };

    await expect(service.append(scope, message)).rejects.toMatchObject({
      code: "message_pending",
      status: 503,
    });
    const [pendingIntent] = await setupDb()
      .select({ state: mastraMessageIntents.state })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
    expect(pendingIntent?.state).toBe("pending");
    const pendingReferences = await setupDb()
      .select({ attachmentId: mastraMessageIntentAttachments.attachmentId })
      .from(mastraMessageIntentAttachments)
      .where(
        eq(mastraMessageIntentAttachments.clientMessageKey, clientMessageKey),
      );
    expect(pendingReferences).toHaveLength(1);
    await expect(
      Promise.resolve().then(() =>
        setupDb().delete(attachments).where(eq(attachments.id, attachmentId)),
      ),
    ).rejects.toThrow();
    const [heldAttachment] = await setupDb()
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(heldAttachment?.id).toBe(attachmentId);
    await setupDb()
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(attachments.id, attachmentId));
    const rolledBackSweep = new Error("rollback isolated culler assertion");
    let sweptWhilePending: number | undefined;
    try {
      await setupDb().transaction(async (tx) => {
        await tx
          .delete(attachments)
          .where(sql`${attachments.id} <> ${attachmentId}`);
        sweptWhilePending = await cullStagedAttachments(
          tx as unknown as Database,
          {
            olderThanHours: 1,
          },
        );
        throw rolledBackSweep;
      });
    } catch (error) {
      if (error !== rolledBackSweep) throw error;
    }
    expect(sweptWhilePending).toBe(0);
    const [survivedSweep] = await setupDb()
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(survivedSweep?.id).toBe(attachmentId);

    const accepted = await service.append(scope, message);
    expect(accepted.seq).toBe(1);
    expect(writeCount).toBe(1);
    const [sentAttachment] = await setupDb()
      .select({ attachedAt: attachments.attachedAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(sentAttachment?.attachedAt).toBeInstanceOf(Date);
    const [finalizedIntent] = await setupDb()
      .select({ state: mastraMessageIntents.state })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.clientMessageKey, clientMessageKey));
    expect(finalizedIntent?.state).toBe("finalized");
    const finalizedReferences = await setupDb()
      .select({ attachmentId: mastraMessageIntentAttachments.attachmentId })
      .from(mastraMessageIntentAttachments)
      .where(
        eq(mastraMessageIntentAttachments.clientMessageKey, clientMessageKey),
      );
    expect(finalizedReferences).toEqual([]);

    const replay = await service.append(scope, message);
    expect(replay.seq).toBe(accepted.seq);
    expect(writeCount).toBe(1);
    await expect(
      service.append(scope, { ...message, content: "conflicting digest" }),
    ).rejects.toMatchObject({ code: "message_conflict", status: 409 });
    expect(writeCount).toBe(1);
  } finally {
    if (threadId) {
      await setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId));
      await setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId));
      await setupDb()
        .delete(enterpriseMessages)
        .where(eq(enterpriseMessages.threadId, threadId));
      await setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        );
    }
    await setupDb().delete(attachments).where(eq(attachments.id, attachmentId));
  }
});

test("membership revocation waits for an authorized Mastra write to settle", async () => {
  let threadId: string | undefined;
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const started = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  type FakeMessage = {
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  };
  const persisted: FakeMessage[] = [];
  const memory = {
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages({ messages }: { messages: FakeMessage[] }) {
      writeStarted();
      await release;
      persisted.push(...messages);
      return { messages };
    },
  };
  const mastraStorage = {
    getStore: async () => ({ getStore: async () => memory }),
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  let revokeSettled = false;
  try {
    const conversation = await service.getOrCreate(raceScope, {});
    threadId = conversation.thread_id;
    const append = service.append(raceScope, {
      threadId,
      clientMessageKey: `${prefix}-mastra-revocation-race`,
      content: "write holds membership fence",
      attachments: [],
    });
    await started;
    const revoke = suspendMembership(operatorDatabase!, {
      operationId: `${prefix}-mastra-revoke-race`,
      operator: principalId,
      tenantId,
      principalId: racePrincipalId,
    }).then((result) => {
      revokeSettled = true;
      return result;
    });
    const observedWaiter = await waitForAnyAdvisoryLockWaiter();
    expect(observedWaiter).toBe(true);
    expect(revokeSettled).toBe(false);
    releaseWrite();
    const accepted = await append;
    const revoked = await revoke;
    expect(accepted.seq).toBe(1);
    expect(revoked.changed).toBe(true);
    expect(persisted).toHaveLength(1);
  } finally {
    releaseWrite();
    if (threadId) {
      await setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId));
      await setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId));
      await setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        );
    }
  }
});

test("revocation before Mastra append authorization creates no message", async () => {
  let threadId: string | undefined;
  let writes = 0;
  const memory = {
    async listMessagesById() {
      return { messages: [] };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages() {
      writes += 1;
      return { messages: [] };
    },
  };
  const mastraStorage = {
    getStore: async () => ({ getStore: async () => memory }),
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  try {
    const conversation = await service.getOrCreate(foreignScope, {});
    threadId = conversation.thread_id;
    await suspendMembership(operatorDatabase!, {
      operationId: `${prefix}-mastra-revoke-before-auth`,
      operator: principalId,
      tenantId,
      principalId: foreignPrincipalId,
    });
    await expect(
      service.append(foreignScope, {
        threadId,
        clientMessageKey: `${prefix}-mastra-revoked-before-auth`,
        content: "must never reach Mastra",
        attachments: [],
      }),
    ).rejects.toThrow("SCOPE_REVOKED");
    expect(writes).toBe(0);
    const intents = await setupDb()
      .select({ threadId: mastraMessageIntents.threadId })
      .from(mastraMessageIntents)
      .where(eq(mastraMessageIntents.threadId, threadId));
    expect(intents).toEqual([]);
  } finally {
    if (threadId) {
      await setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId));
      await setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId));
      await setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        );
    }
  }
});

test("concurrent Mastra appends reserve unique sequences and page without full history", async () => {
  let threadId: string | undefined;
  let unboundedHistoryReads = 0;
  const loadedIds: string[][] = [];
  type FakeMessage = {
    id: string;
    threadId: string;
    resourceId: string;
    role: "user";
    type: "text";
    createdAt: Date;
    content: {
      format: 2;
      parts: Array<{ type: "text"; text: string }>;
      metadata: Record<string, unknown>;
    };
  };
  const persisted: FakeMessage[] = [];
  const memory = {
    async listMessages() {
      unboundedHistoryReads += 1;
      return { messages: [...persisted], total: persisted.length };
    },
    async listMessagesById({ messageIds }: { messageIds: string[] }) {
      loadedIds.push([...messageIds]);
      return {
        messages: persisted.filter(({ id }) => messageIds.includes(id)),
      };
    },
    async getThreadById() {
      return null;
    },
    async saveThread() {},
    async saveMessages({ messages }: { messages: FakeMessage[] }) {
      const equalTimestamp = new Date("2026-01-01T00:00:00.000Z");
      const stored = messages.map((message) => ({
        ...message,
        createdAt: equalTimestamp,
      }));
      persisted.push(...stored);
      return { messages: stored };
    },
  };
  const mastraStorage = {
    getStore: async () => ({ getStore: async () => memory }),
    withConversationLock: async <T>(
      _scope: unknown,
      _binding: unknown,
      run: () => Promise<T>,
    ) => run(),
  } as never;
  const service = createConversationService({
    data: dataDatabase!,
    mastraStorage,
  });
  try {
    const conversation = await service.getOrCreate(scope, {});
    threadId = conversation.thread_id;
    const writes = await Promise.all(
      ["one", "two", "three"].map((content) =>
        service.append(scope, {
          threadId,
          clientMessageKey: `${prefix}-sequence-${content}`,
          content,
          attachments: [],
        }),
      ),
    );
    expect(writes.map(({ seq }) => seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3,
    ]);
    const firstPage = await service.history(scope, {
      threadId,
      beforeSeq: null,
      limit: 2,
    });
    expect(firstPage.items.map(({ seq }) => seq)).toEqual([2, 3]);
    expect(firstPage.nextBeforeSeq).toBe(2);
    const secondPage = await service.history(scope, {
      threadId,
      beforeSeq: firstPage.nextBeforeSeq,
      limit: 2,
    });
    expect(secondPage.items.map(({ seq }) => seq)).toEqual([1]);
    expect(secondPage.nextBeforeSeq).toBeNull();
    expect(
      new Set([...firstPage.items, ...secondPage.items].map(({ seq }) => seq))
        .size,
    ).toBe(3);
    expect(unboundedHistoryReads).toBe(0);
    expect(loadedIds.slice(-2).map((ids) => ids.length)).toEqual([2, 1]);
    const platformRows = await setupDb()
      .select({ threadId: enterpriseMessages.threadId })
      .from(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, threadId));
    expect(platformRows).toEqual([]);
  } finally {
    if (threadId) {
      await setupDb()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId));
      await setupDb()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId));
      await setupDb()
        .delete(enterpriseMessages)
        .where(eq(enterpriseMessages.threadId, threadId));
      await setupDb()
        .delete(enterpriseConversations)
        .where(
          and(
            eq(enterpriseConversations.tenantId, tenantId),
            eq(enterpriseConversations.threadId, threadId),
          ),
        );
    }
  }
});
