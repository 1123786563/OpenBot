import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../../src/db/schema";
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
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
const actorId = `${prefix}-actor`;
const principalId = `${prefix}-principal`;
const foreignActorId = `${prefix}-foreign-actor`;
const foreignPrincipalId = `${prefix}-foreign-principal`;
const attachmentId = randomUUID();
const rollbackAttachmentId = randomUUID();
const directAttachmentId = randomUUID();

let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let dataDatabase: DataDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
let scope: PlatformScope;
let foreignScope: PlatformScope;
let conversations: ReturnType<typeof createConversationService>;

function setupDb() {
  setupDatabase ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 2 });
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
    ],
  });
  await setup.insert(channels).values({
    id: channelId,
    name: "Synthetic channel",
    description: "Conversation integration fixture",
  });
  await setup.insert(channelMemberships).values({ channelId, userId: actorId });
  await setup.insert(intelligenceChannelMappings).values({
    userId: actorId,
    channelId,
    threadId: `${prefix}-legacy-thread`,
  });
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
    content: "original normalized body",
    attachments: [attachmentId],
  };
  const first = await conversations.append(scope, original);
  const replay = await conversations.append(scope, { ...original });
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

test("message row and attachment sent stamp roll back together", async () => {
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

test("attachment references are denied after membership revocation and channel deletion", async () => {
  const conversation = await createPlatformConversation();
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

  await setupDb().insert(channelMemberships).values({
    channelId,
    userId: actorId,
  });
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
});
