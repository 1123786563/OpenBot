import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
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
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createConversationService } from "../../src/enterprise/conversations/service";
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
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const prefix = `conversation-t03-${randomUUID()}`;
const channelId = `${prefix}-channel`;
const raceChannelId = `${prefix}-race-channel`;
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
const actorId = `${prefix}-actor`;
const principalId = `${prefix}-principal`;
const foreignActorId = `${prefix}-foreign-actor`;
const foreignPrincipalId = `${prefix}-foreign-principal`;
const attachmentId = randomUUID();
const rollbackAttachmentId = randomUUID();
const directAttachmentId = randomUUID();
const raceAttachmentId = randomUUID();

let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
let scope: PlatformScope;
let foreignScope: PlatformScope;
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
  ]);
  await setup.insert(enterprisePrincipals).values([
    { id: principalId, userId: actorId },
    { id: foreignPrincipalId, userId: foreignActorId },
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
  conversations = createConversationService({ data: dataDatabase });
});

async function createPlatformConversation() {
  const conversation = await conversations.getOrCreate(scope, {});
  expect(conversation.storage_backend).toBe("platform");
  return conversation;
}

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
