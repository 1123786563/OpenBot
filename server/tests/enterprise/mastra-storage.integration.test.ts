import { afterAll, beforeAll, expect, test } from "../../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "@mastra/pg";
import { eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../src/db/client";
import {
  enterprisePrincipals,
  enterpriseTenants,
  users,
} from "../../src/db/schema";
import {
  enterpriseConversations,
  enterpriseMessages,
} from "../../src/db/schema/enterprise-conversations";
import {
  mastraMessageIntentAttachments,
  mastraMessageIntents,
} from "../../src/db/schema/mastra-message-intents";
import { createConversationService } from "../../src/enterprise/conversations/service";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import type {
  MastraConversationBinding,
  TenantProvisionInput,
  TenantProvisionReceipt,
} from "../../src/mastra/contracts";
import {
  tenantStorageKey,
  tenantStorageRoleNames,
  tenantStorageSchemaName,
} from "../../src/mastra/contracts";
import { createMastraConversationRepository } from "../../src/mastra/conversations";
import { PostgresTenantStorageRegistry } from "../../src/mastra/postgres-registry";
import {
  PostgresTenantProvisioner,
  RegistryTenantStorageLookup,
  type TenantCredentialStore,
  type TenantStorageRegistry,
} from "../../src/mastra/provisioning";
import { createTenantMastraStorage } from "../../src/mastra/tenant-storage";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const runId = randomUUID().replaceAll("-", "");
// R1B creates only task-scoped fixture tenants; production role/schema names are then derived
// from these unguessable tenant ids by tenantStorageRoleNames.
const tenantA = `m02r1b-${runId}-a`;
const tenantB = `m02r1b-${runId}-b`;
const schemaA = tenantStorageSchemaName(tenantStorageKey(tenantA), 1);
const schemaB = tenantStorageSchemaName(tenantStorageKey(tenantB), 1);
const threadId = `m02-thread-${runId}`;
const resourceId = `private:${randomUUID()}`;
const foreignActorId = `foreign-actor-${runId}`;
const foreignPrincipalId = `foreign-principal-${runId}`;
let database: Database | undefined;
let admin: PostgresStore | undefined;
let directory: DirectoryDatabase | undefined;
let data: DataDatabase | undefined;
let operator: OperatorDatabase | undefined;
let trustedScope: Awaited<
  ReturnType<ReturnType<typeof createScopeResolver>["resolve"]>
>;
let foreignScope: Awaited<
  ReturnType<ReturnType<typeof createScopeResolver>["resolve"]>
>;
let connectionString: string;
const credentials = new Map<string, string>();
const claims = new Map<string, { token: string; input: string }>();
const records = new Map<
  string,
  { receipt: TenantProvisionReceipt; runtimeRole: string }
>();
const credentialStore: TenantCredentialStore = {
  async put(ref, secret) {
    credentials.set(ref, secret);
  },
  async get(ref) {
    return credentials.get(ref);
  },
  async delete(ref) {
    credentials.delete(ref);
  },
};
const registryState = {
  async claim(input: TenantProvisionInput) {
    if (records.has(input.tenantId) || claims.has(input.tenantId)) return;
    const token = randomUUID();
    claims.set(input.tenantId, { token, input: JSON.stringify(input) });
    return token;
  },
  async put(
    receipt: TenantProvisionReceipt,
    runtimeRole: string,
    token?: string,
  ) {
    if (token && claims.get(receipt.tenantId)?.token !== token)
      throw new Error("TENANT_STORAGE_CLAIM_LOST");
    records.set(receipt.tenantId, { receipt, runtimeRole });
    claims.delete(receipt.tenantId);
  },
  async get(tenant: string) {
    return records.get(tenant);
  },
  async delete(tenant: string) {
    records.delete(tenant);
  },
  async releaseClaim(tenant: string, token: string) {
    if (claims.get(tenant)?.token === token) claims.delete(tenant);
  },
};
const registry: TenantStorageRegistry = registryState;

function db() {
  database ??= createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 3 });
  return database;
}
function q(value: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value))
    throw new Error("invalid test identifier");
  return `"${value}"`;
}
function binding(tenantId: string): MastraConversationBinding {
  return {
    tenantId,
    conversationId: randomUUID(),
    threadId,
    resourceId,
    storageKey: tenantStorageKey(tenantId),
    backend: "intelligence",
  };
}

beforeAll(async () => {
  connectionString = enterpriseTestDatabaseUrlFrom();
  database = createDatabase(connectionString, { max: 3 });
  admin = new PostgresStore({
    id: `m02-control-${runId}`,
    connectionString,
    schemaName: "public",
    disableInit: true,
    max: 2,
  });
  const provisioner = new PostgresTenantProvisioner({
    controlPlane: admin.pool,
    controlPlaneConnectionString: connectionString,
    credentials: credentialStore,
    registry,
  });
  await provisioner.provision({
    tenantId: tenantA,
    storageKey: tenantStorageKey(tenantA),
    roleVersion: 1,
  });
  await provisioner.provision({
    tenantId: tenantB,
    storageKey: tenantStorageKey(tenantB),
    roleVersion: 1,
  });
  const actorId = `actor-${runId}`;
  const principalId = `principal-${runId}`;
  const workspaceId = `workspace-${runId}`;
  await db()
    .insert(users)
    .values([
      {
        id: actorId,
        email: `${actorId}@example.invalid`,
        name: "Synthetic Mastra actor",
      },
      {
        id: foreignActorId,
        email: `${foreignActorId}@example.invalid`,
        name: "Synthetic foreign Mastra actor",
      },
    ]);
  await db()
    .insert(enterprisePrincipals)
    .values([
      { id: principalId, userId: actorId },
      { id: foreignPrincipalId, userId: foreignActorId },
    ]);
  const operatorDb = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    { max: 2 },
  );
  operator = await verifyOperatorDatabase(operatorDb);
  const dataDb = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
    max: 2,
  });
  data = await verifyDataDatabase(dataDb);
  await provisionDeployment(operator, {
    operationId: `mastra-${runId}`,
    operator: principalId,
    tenant: { id: tenantA, name: "Synthetic Mastra tenant" },
    workspace: { id: workspaceId, name: "Synthetic Mastra workspace" },
    members: [
      { principalId, userId: actorId, role: "tenant_admin" },
      {
        principalId: foreignPrincipalId,
        userId: foreignActorId,
        role: "member",
      },
    ],
    resources: [],
  });
  const directoryDb = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    { max: 2 },
  );
  directory = await verifyDirectoryDatabase(directoryDb);
  const authenticated = new WeakMap<Request, string>();
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const actor = authenticated.get(request);
      return actor ? { actorId: actor, entrypoint: "web" } : null;
    },
    selectTenant: () => tenantA,
    selectWorkspace: () => workspaceId,
  });
  const request = new Request("https://enterprise.example.invalid/mastra");
  authenticated.set(request, actorId);
  trustedScope = await resolver.resolve(request);
  const foreignRequest = new Request(
    "https://enterprise.example.invalid/mastra-foreign",
  );
  authenticated.set(foreignRequest, foreignActorId);
  foreignScope = await resolver.resolve(foreignRequest);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    for (const tenantId of [tenantA, tenantB]) {
      const entry = records.get(tenantId);
      const storageKey = tenantStorageKey(tenantId);
      const schemaName =
        entry?.receipt.schemaName ?? tenantStorageSchemaName(storageKey, 1);
      const roles = tenantStorageRoleNames(storageKey, 1);
      const runtimeRole = entry?.runtimeRole ?? roles.runtime;
      const ownerRole = roles.owner;
      if (database) {
        for (const [label, statement] of [
          ["schema", `DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`],
          ["runtime role", `DROP ROLE IF EXISTS ${q(runtimeRole)}`],
          ["owner role", `DROP ROLE IF EXISTS ${q(ownerRole)}`],
        ] as const) {
          try {
            await database.execute(sql.raw(statement));
          } catch (error) {
            errors.push(
              new Error(
                `fixture cleanup ${label} ${tenantId} ${schemaName} ${runtimeRole} ${ownerRole}`,
                { cause: error },
              ),
            );
          }
        }
        try {
          const remaining = await admin!.pool.query<{
            schema_exists: boolean;
            runtime_role_exists: boolean;
            owner_role_exists: boolean;
          }>(
            `SELECT
              EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS runtime_role_exists,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $3) AS owner_role_exists`,
            [schemaName, runtimeRole, ownerRole],
          );
          if (
            remaining.rows[0]?.schema_exists ||
            remaining.rows[0]?.runtime_role_exists ||
            remaining.rows[0]?.owner_role_exists
          ) {
            errors.push(new Error(`fixture cleanup verification ${tenantId}`));
          }
        } catch (error) {
          errors.push(
            new Error(`fixture cleanup verification ${tenantId}`, {
              cause: error,
            }),
          );
        }
      }
      const entryRefs = [...credentials.keys()];
      for (const ref of entryRefs) {
        try {
          await credentialStore.delete(ref);
        } catch (error) {
          errors.push(
            new Error(`fixture cleanup credential ${ref}`, { cause: error }),
          );
        }
      }
      records.delete(tenantId);
      claims.delete(tenantId);
    }
    for (const tenantId of [tenantA, tenantB]) {
      if (await registryState.get(tenantId))
        errors.push(
          new Error(`fixture registry cleanup verification ${tenantId}`),
        );
    }
    if (credentials.size > 0 || claims.size > 0)
      errors.push(
        new Error("fixture credential or claim cleanup verification"),
      );
    if (database) {
      await database
        .delete(enterpriseTenants)
        .where(eq(enterpriseTenants.id, tenantA));
      await database.delete(users).where(eq(users.id, `actor-${runId}`));
      await database.delete(users).where(eq(users.id, foreignActorId));
      await database.$client.close();
    }
  } catch (error) {
    errors.push(error);
  }
  for (const ref of credentials.keys()) credentials.delete(ref);
  await admin?.close().catch((error) => errors.push(error));
  await directory?.$client.close().catch((error) => errors.push(error));
  await data?.$client.close().catch((error) => errors.push(error));
  await operator?.$client.close().catch((error) => errors.push(error));
  if (errors.length)
    throw new AggregateError(
      errors,
      "Mastra provisioned fixture cleanup failed",
    );
});

test("legacy Mastra repository exposes only resolve and authorized history", () => {
  const repository = createMastraConversationRepository({
    conversations: {} as never,
    storage: {} as never,
  });

  expect(typeof repository.resolve).toBe("function");
  expect(typeof repository.history).toBe("function");
  expect("append" in repository).toBe(false);
});

test("public Mastra append survives closing and recreating the restricted tenant pool", async () => {
  const makeStorage = () =>
    createTenantMastraStorage(
      new RegistryTenantStorageLookup({
        registry,
        credentials: credentialStore,
        runtimeConnectionString: connectionString,
      }),
    );
  const firstStorage = makeStorage();
  let reopenedStorage: ReturnType<typeof createTenantMastraStorage> | undefined;
  let thread: string | undefined;
  let foreignThread: string | undefined;
  try {
    const firstService = createConversationService({
      data: data!,
      mastraStorage: firstStorage,
    });
    const conversation = await firstService.getOrCreate(trustedScope, {});
    thread = conversation.thread_id;
    expect(conversation.storage_backend).toBe("mastra");
    const message = await firstService.append(trustedScope, {
      threadId: thread,
      clientMessageKey: `public-reopen-${runId}`,
      content: "accepted through the public service",
      attachments: [],
      resourceId: `private:${runId}-forged`,
    });
    expect(message).toMatchObject({
      threadId: thread,
      seq: 1,
      role: "user",
      content: "accepted through the public service",
    });
    const binding = await firstService.resolveMastraBinding(
      trustedScope,
      thread,
    );
    expect(binding.resourceId).toBe(
      `private:${JSON.stringify([tenantA, trustedScope.principalId])}`,
    );
    const firstStore = await firstStorage.getStore(trustedScope, binding);
    const firstMemory = await firstStore.getStore("memory");
    const persisted = await firstMemory?.listMessages({
      threadId: thread,
      resourceId: binding.resourceId,
      perPage: false,
    });
    expect(persisted?.messages).toHaveLength(1);
    expect(persisted?.messages[0]?.content.metadata?.openbotSeq).toBe(1);

    let deniedStorageCalls = 0;
    const deniedStorage = {
      async getStore() {
        deniedStorageCalls += 1;
        throw new Error("foreign principal reached tenant storage");
      },
      async withConversationLock() {
        deniedStorageCalls += 1;
        throw new Error("foreign principal reached tenant storage lock");
      },
    } as never;
    const foreignService = createConversationService({
      data: data!,
      mastraStorage: deniedStorage,
    });
    await expect(
      foreignService.resolveMastraBinding(foreignScope, thread),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await expect(
      foreignService.append(foreignScope, {
        threadId: thread,
        clientMessageKey: `foreign-owner-write-${runId}`,
        content: "foreign principal must not write",
        attachments: [],
      }),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await expect(
      foreignService.history(foreignScope, {
        threadId: thread,
        beforeSeq: null,
        limit: 20,
      }),
    ).rejects.toThrow("CONVERSATION_NOT_FOUND");
    expect(deniedStorageCalls).toBe(0);
    const foreignStorage = {
      async getStore() {
        return { getStore: async () => null };
      },
      async withConversationLock<T>(
        _scope: unknown,
        _binding: unknown,
        run: () => Promise<T>,
      ) {
        return run();
      },
    } as never;
    const foreignStorageService = createConversationService({
      data: data!,
      mastraStorage: foreignStorage,
    });
    const foreignConversation = await foreignStorageService.getOrCreate(
      foreignScope,
      {},
    );
    foreignThread = foreignConversation.thread_id;
    const foreignBinding = await foreignStorageService.resolveMastraBinding(
      foreignScope,
      foreignThread,
    );
    expect(foreignBinding.resourceId).toBe(
      `private:${JSON.stringify([tenantA, foreignScope.principalId])}`,
    );
    expect(foreignBinding.resourceId).not.toBe(binding.resourceId);

    const platformMessages = await db()
      .select({ threadId: enterpriseConversations.threadId })
      .from(enterpriseConversations)
      .where(eq(enterpriseConversations.threadId, thread));
    expect(platformMessages).toHaveLength(1);
    const platformRows = await db()
      .select({ id: enterpriseMessages.id })
      .from(enterpriseMessages)
      .where(eq(enterpriseMessages.threadId, thread));
    expect(platformRows).toEqual([]);

    await firstStorage.close();
    reopenedStorage = makeStorage();
    const reopenedService = createConversationService({
      data: data!,
      mastraStorage: reopenedStorage,
    });
    await expect(
      reopenedService.history(trustedScope, {
        threadId: thread,
        beforeSeq: null,
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [message], nextBeforeSeq: null });
    const reopenedBinding = await reopenedService.resolveMastraBinding(
      trustedScope,
      thread,
    );
    const reopenedStore = await reopenedStorage.getStore(
      trustedScope,
      reopenedBinding,
    );
    const reopenedMemory = await reopenedStore.getStore("memory");
    const reopenedMessages = await reopenedMemory?.listMessages({
      threadId: thread,
      resourceId: reopenedBinding.resourceId,
      perPage: false,
    });
    expect(reopenedMessages?.messages).toHaveLength(1);
    expect(reopenedMessages?.messages[0]?.id).toBe(message.messageId);
  } finally {
    await firstStorage.close();
    await reopenedStorage?.close();
    for (const threadId of [thread, foreignThread]) {
      if (!threadId) continue;
      await db()
        .delete(mastraMessageIntentAttachments)
        .where(eq(mastraMessageIntentAttachments.threadId, threadId));
      await db()
        .delete(mastraMessageIntents)
        .where(eq(mastraMessageIntents.threadId, threadId));
      await db()
        .delete(enterpriseConversations)
        .where(eq(enterpriseConversations.threadId, threadId));
      const remaining = await db()
        .select({ threadId: enterpriseConversations.threadId })
        .from(enterpriseConversations)
        .where(eq(enterpriseConversations.threadId, threadId));
      expect(remaining).toEqual([]);
    }
  }
});

test("production provisioner issues opaque receipts and two restricted, isolated runtime logins", async () => {
  const entryA = records.get(tenantA)!;
  const entryB = records.get(tenantB)!;
  expect(entryB.receipt.tenantId).toBe(tenantB);
  expect(entryB.receipt.schemaName).not.toBe(entryA.receipt.schemaName);
  expect(entryA.receipt.credentialRef).toMatch(/^tenant-credential:/);
  expect(JSON.stringify(entryA.receipt)).not.toMatch(
    /postgres:|password|local_test_only/,
  );
  expect(entryA.receipt).not.toHaveProperty("runtimeRole");
  expect(entryA.receipt).not.toHaveProperty("connectionString");
  const locationA = await new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  }).resolveTenantStorage(tenantA);
  const locationB = await new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  }).resolveTenantStorage(tenantB);
  const storeA = new PostgresStore({
    id: `verify-a-${runId}`,
    connectionString: locationA.connectionString,
    schemaName: schemaA,
    disableInit: true,
  });
  const storeB = new PostgresStore({
    id: `verify-b-${runId}`,
    connectionString: locationB.connectionString,
    schemaName: schemaB,
    disableInit: true,
  });
  try {
    const memoryA = await storeA.getStore("memory");
    const memoryB = await storeB.getStore("memory");
    if (!memoryA || !memoryB) throw new Error("Mastra memory domain missing");
    const now = new Date();
    await memoryA.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "Tenant A",
        createdAt: now,
        updatedAt: now,
      },
    });
    await memoryA.saveMessages({
      messages: [
        {
          id: `message-${runId}`,
          threadId,
          resourceId,
          role: "user",
          createdAt: now,
          content: { format: 2, parts: [{ type: "text", text: "private" }] },
        },
      ],
    });
    expect(
      (await memoryA.listMessages({ threadId, resourceId, perPage: false }))
        .messages,
    ).toHaveLength(1);
    expect(
      (await memoryB.listMessages({ threadId, resourceId, perPage: false }))
        .messages,
    ).toHaveLength(0);
    expect(
      (await storeA.pool.query("select session_user, current_user")).rows[0],
    ).toEqual({
      session_user: locationA.runtimeRole,
      current_user: locationA.runtimeRole,
    });
    expect(
      (await storeB.pool.query("select session_user, current_user")).rows[0],
    ).toEqual({
      session_user: locationB.runtimeRole,
      current_user: locationB.runtimeRole,
    });
    const rows = (await db().execute(
      sql`SELECT has_schema_privilege(${locationA.runtimeRole}, ${schemaA}, 'USAGE') AS own_a, has_schema_privilege(${locationA.runtimeRole}, ${schemaB}, 'USAGE') AS other_a, has_schema_privilege(${locationA.runtimeRole}, ${schemaA}, 'CREATE') AS ddl_a, has_schema_privilege(${locationB.runtimeRole}, ${schemaB}, 'USAGE') AS own_b, has_schema_privilege(${locationB.runtimeRole}, ${schemaA}, 'USAGE') AS other_b`,
    )) as unknown as Array<Record<string, boolean>>;
    expect(rows[0]).toEqual({
      own_a: true,
      other_a: false,
      ddl_a: false,
      own_b: true,
      other_b: false,
    });
    const registryAccess = await admin!.pool.query(
      "SELECT has_table_privilege($1, 'public.mastra_tenant_storage_registry', 'SELECT') AS can_read_registry",
      [locationA.runtimeRole],
    );
    expect(registryAccess.rows[0]).toEqual({ can_read_registry: false });
    await expect(
      storeA.pool.query(`CREATE TABLE ${q(schemaA)}.forbidden (value int)`),
    ).rejects.toThrow();
    await expect(
      storeA.pool.query(`SELECT * FROM ${q(schemaB)}.mastra_threads`),
    ).rejects.toThrow();
  } finally {
    await Promise.all([storeA.close(), storeB.close()]);
  }
});

test("production tenant storage inspects exact, absent, and mismatched intent identities without writes", async () => {
  const inspectionThreadId = `m02-inspect-${runId}`;
  const inspectionMessageId = `message-inspect-${runId}`;
  const inspectionResourceId = `private:${JSON.stringify([tenantA, trustedScope.principalId])}`;
  const digest = `digest-${runId}`;
  const clientMessageKey = `client-key-${runId}`;
  const attachmentIds = [`attachment-${runId}`];
  const inspectionBinding: MastraConversationBinding = {
    tenantId: tenantA,
    conversationId: randomUUID(),
    threadId: inspectionThreadId,
    resourceId: inspectionResourceId,
    storageKey: tenantStorageKey(tenantA),
    backend: "mastra",
  };
  const storage = createTenantMastraStorage(
    new RegistryTenantStorageLookup({
      registry,
      credentials: credentialStore,
      runtimeConnectionString: connectionString,
    }),
  );
  try {
    const store = await storage.getStore(trustedScope, inspectionBinding);
    const memory = await store.getStore("memory");
    if (!memory) throw new Error("Mastra memory domain missing");
    const [role] = (await store.pool.query("select session_user, current_user"))
      .rows;
    expect(role).toEqual({
      session_user: records.get(tenantA)!.runtimeRole,
      current_user: records.get(tenantA)!.runtimeRole,
    });
    const before = await memory.listMessages({
      threadId: inspectionThreadId,
      resourceId: inspectionResourceId,
      perPage: false,
    });
    expect(before.messages).toHaveLength(0);
    await memory.saveThread({
      thread: {
        id: inspectionThreadId,
        resourceId: inspectionResourceId,
        title: "Inspection characterization",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await memory.saveMessages({
      messages: [
        {
          id: inspectionMessageId,
          threadId: inspectionThreadId,
          resourceId: inspectionResourceId,
          role: "user",
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [{ type: "text", text: "synthetic inspection message" }],
            metadata: {
              openbotDigest: digest,
              openbotSeq: 1,
              openbotClientMessageKey: clientMessageKey,
              openbotAttachments: attachmentIds,
            },
          },
        },
      ],
    });
    const expected = {
      messageId: inspectionMessageId,
      digest,
      seq: 1,
      clientMessageKey,
      attachmentIds,
    };
    expect(
      await storage.inspectIntentMessage(inspectionBinding, expected),
    ).toBe("exact");
    expect(
      await storage.inspectIntentMessage(inspectionBinding, {
        ...expected,
        messageId: `absent-${runId}`,
      }),
    ).toBe("absent");
    for (const mismatched of [
      {
        ...expected,
        resourceId: `private:${JSON.stringify([tenantA, `wrong-${runId}`])}`,
      },
      { ...expected, digest: `${digest}-wrong` },
      { ...expected, seq: 2 },
      { ...expected, clientMessageKey: `${clientMessageKey}-wrong` },
      { ...expected, attachmentIds: [`wrong-${runId}`] },
    ]) {
      const { resourceId: wrongResource, ...identity } = mismatched;
      expect(
        await storage.inspectIntentMessage(
          wrongResource
            ? { ...inspectionBinding, resourceId: wrongResource }
            : inspectionBinding,
          identity,
        ),
      ).toBe("mismatch");
    }
    const after = await memory.listMessages({
      threadId: inspectionThreadId,
      resourceId: inspectionResourceId,
      perPage: false,
    });
    expect(after.messages).toHaveLength(1);
  } finally {
    await storage.close();
  }
});

test("tenant storage coalesces simultaneous first access and closes idempotently", async () => {
  const lookup = new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  });
  const storage = createTenantMastraStorage(lookup);
  const bind = binding(tenantA);
  const [first, second, third] = await Promise.all([
    storage.getStore(trustedScope, bind),
    storage.getStore(trustedScope, bind),
    storage.getStore(trustedScope, bind),
  ]);
  expect(first).toBe(second);
  expect(second).toBe(third);
  await Promise.all([
    storage.closeTenant(tenantA),
    storage.closeTenant(tenantA),
  ]);
  await storage.close();
  await storage.close();
});

test("Mastra backend storage has a server-side query deadline", async () => {
  const lookup = new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  });
  const storage = createTenantMastraStorage(lookup);
  try {
    const store = await storage.getStore(trustedScope, {
      ...binding(tenantA),
      backend: "mastra",
    });
    const setting = await store.pool.query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    expect(setting.rows[0]?.statement_timeout).toBe("4s");
    const client = await store.pool.connect();
    try {
      await client.query(
        "CREATE TEMP TABLE timeout_rollback_probe (value integer) ON COMMIT PRESERVE ROWS",
      );
      await client.query("BEGIN");
      await client.query("INSERT INTO timeout_rollback_probe VALUES (1)");
      await expect(client.query("SELECT pg_sleep(5)")).rejects.toMatchObject({
        code: "57014",
      });
      await client.query("ROLLBACK");
      const probe = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM timeout_rollback_probe",
      );
      expect(probe.rows[0]?.count).toBe("0");
    } finally {
      await client.query("DROP TABLE IF EXISTS timeout_rollback_probe");
      client.release();
    }
  } finally {
    await storage.close();
  }
});

test("two PostgreSQL registry adapters serialize claims and preserve conditional receipts", async () => {
  const tenantId = `m02r1a3-durable-${runId}`;
  const input = {
    tenantId,
    storageKey: tenantStorageKey(tenantId),
    roleVersion: 12,
  };
  const firstPool = new PostgresStore({
    id: `r1a3-registry-a-${runId}`,
    connectionString,
    schemaName: "public",
    disableInit: true,
    max: 1,
  });
  const secondPool = new PostgresStore({
    id: `r1a3-registry-b-${runId}`,
    connectionString,
    schemaName: "public",
    disableInit: true,
    max: 1,
  });
  const first = new PostgresTenantStorageRegistry(firstPool.pool);
  const second = new PostgresTenantStorageRegistry(secondPool.pool);
  let credentialRef: string | undefined;
  let claimTokenForCleanup: string | undefined;
  try {
    const claims = await Promise.all([first.claim(input), second.claim(input)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winnerIndex = claims.findIndex(Boolean);
    const winner = winnerIndex === 0 ? first : second;
    const loser = winnerIndex === 0 ? second : first;
    const claimToken = claims[winnerIndex]!;
    claimTokenForCleanup = claimToken;
    credentialRef = `tenant-credential:${randomUUID()}`;
    const receipt: TenantProvisionReceipt = {
      ...input,
      schemaName: tenantStorageSchemaName(input.storageKey, input.roleVersion),
      credentialRef,
    };
    const roles = tenantStorageRoleNames(input.storageKey, input.roleVersion);
    expect(await first.get(tenantId)).toBeUndefined();
    await expect(
      loser.put(receipt, roles.runtime, randomUUID()),
    ).rejects.toThrow("TENANT_STORAGE_CLAIM_LOST");
    await loser.releaseClaim(tenantId, randomUUID());
    expect(await second.claim(input)).toBeUndefined();
    await winner.put(receipt, roles.runtime, claimToken);
    await loser.releaseClaim(tenantId, claimToken);
    await loser.delete(tenantId, `tenant-credential:${randomUUID()}`);
    await expect(
      loser.put(
        { ...receipt, credentialRef: `tenant-credential:${randomUUID()}` },
        roles.runtime,
        claimToken,
      ),
    ).rejects.toThrow("TENANT_STORAGE_CLAIM_LOST");
    expect((await first.get(tenantId))?.receipt).toEqual(receipt);
    expect(await second.claim(input)).toBeUndefined();
  } finally {
    if (claimTokenForCleanup)
      await first.releaseClaim(tenantId, claimTokenForCleanup);
    if (credentialRef) await first.delete(tenantId, credentialRef);
    else {
      const tokenRows = await firstPool.pool.query(
        "DELETE FROM mastra_tenant_storage_registry WHERE tenant_id = $1",
        [tenantId],
      );
      void tokenRows;
    }
    await Promise.all([firstPool.close(), secondPool.close()]);
  }

  const occupiedTenant = `m02r1a3-occupied-${runId}`;
  const blockedTenant = `m02r1a3-blocked-${runId}`;
  const blockedInput = {
    tenantId: blockedTenant,
    storageKey: tenantStorageKey(blockedTenant),
    roleVersion: 17,
  };
  const occupiedSchema = tenantStorageSchemaName(
    blockedInput.storageKey,
    blockedInput.roleVersion,
  );
  const occupiedClaim = randomUUID();
  try {
    await admin!.pool.query(
      `INSERT INTO mastra_tenant_storage_registry
        (tenant_id, storage_key, schema_name, role_version, status, claim_token)
       VALUES ($1, $2, $3, $4, 'provisioning', $5)`,
      [
        occupiedTenant,
        blockedInput.storageKey,
        occupiedSchema,
        17,
        occupiedClaim,
      ],
    );
    const contender = new PostgresTenantStorageRegistry(admin!.pool);
    expect(await contender.claim(blockedInput)).toBeUndefined();
    const preserved = await admin!.pool.query(
      "SELECT tenant_id, claim_token FROM mastra_tenant_storage_registry WHERE tenant_id = $1",
      [occupiedTenant],
    );
    expect(preserved.rows).toEqual([
      { tenant_id: occupiedTenant, claim_token: occupiedClaim },
    ]);
  } finally {
    await admin!.pool.query(
      "DELETE FROM mastra_tenant_storage_registry WHERE tenant_id = $1",
      [occupiedTenant],
    );
  }
});

test("provisioning compensates when a credential put partially succeeds", async () => {
  const tenantId = `m02r1a2-put-${runId}`;
  const storageKey = tenantStorageKey(tenantId);
  const schemaName = tenantStorageSchemaName(storageKey, 7);
  const input = { tenantId, storageKey, roleVersion: 7 };
  const partialSecrets = new Map<string, string>();
  const partialCredentials: TenantCredentialStore = {
    async put(ref, secret) {
      partialSecrets.set(ref, secret);
      throw new Error("SYNTHETIC_CREDENTIAL_PUT_FAILURE");
    },
    async get(ref) {
      return partialSecrets.get(ref);
    },
    async delete(ref) {
      partialSecrets.delete(ref);
    },
  };
  const provisioner = new PostgresTenantProvisioner({
    controlPlane: admin!.pool,
    controlPlaneConnectionString: connectionString,
    credentials: partialCredentials,
    registry,
  });
  try {
    const thrown = await provisioner.provision(input).then(
      () => undefined,
      (error: unknown) => error,
    );
    await expect(Promise.reject(thrown)).rejects.toThrow(
      "SYNTHETIC_CREDENTIAL_PUT_FAILURE",
    );
    expect(partialSecrets.size).toBe(0);
    const objects = await admin!.pool.query(
      "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = $1)::int AS schemas, (SELECT count(*) FROM pg_roles WHERE rolname = ANY($2::text[]))::int AS roles",
      [schemaName, [...Object.values(tenantStorageRoleNames(storageKey, 7))]],
    );
    expect(objects.rows[0]).toEqual({ schemas: 0, roles: 0 });
  } finally {
    await admin!.pool.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    await admin!.pool.query(
      `DROP ROLE IF EXISTS ${q(tenantStorageRoleNames(storageKey, 7).runtime)}`,
    );
    await admin!.pool.query(
      `DROP ROLE IF EXISTS ${q(tenantStorageRoleNames(storageKey, 7).owner)}`,
    );
    for (const ref of partialSecrets.keys()) partialSecrets.delete(ref);
  }
});

test("provisioning reports failed compensation with the primary registry error", async () => {
  const tenantId = `m02r1a2-comp-${runId}`;
  const storageKey = tenantStorageKey(tenantId);
  const schemaName = tenantStorageSchemaName(storageKey, 8);
  const localSecrets = new Map<string, string>();
  const localCredentials: TenantCredentialStore = {
    async put(ref, secret) {
      localSecrets.set(ref, secret);
    },
    async get(ref) {
      return localSecrets.get(ref);
    },
    async delete(_ref) {
      throw new Error("SYNTHETIC_SECRET_DELETE_FAILURE");
    },
  };
  const failedRegistry: TenantStorageRegistry = {
    ...registryState,
    async put() {
      throw new Error("SYNTHETIC_REGISTRY_PUT_FAILURE");
    },
  };
  const provisioner = new PostgresTenantProvisioner({
    controlPlane: admin!.pool,
    controlPlaneConnectionString: connectionString,
    credentials: localCredentials,
    registry: failedRegistry,
  });
  try {
    const thrown = await provisioner
      .provision({ tenantId, storageKey, roleVersion: 8 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map(String).join(" ")).toContain(
      "SYNTHETIC_REGISTRY_PUT_FAILURE",
    );
    const cleanupFailure = (thrown as AggregateError).errors[1] as Error;
    expect((cleanupFailure.cause as Error).message).toBe(
      "SYNTHETIC_SECRET_DELETE_FAILURE",
    );
    expect((thrown as AggregateError).message).toContain(schemaName);
    expect(localSecrets.size).toBe(1);
  } finally {
    await admin!.pool.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
    await admin!.pool.query(
      `DROP ROLE IF EXISTS ${q(tenantStorageRoleNames(storageKey, 8).runtime)}`,
    );
    await admin!.pool.query(
      `DROP ROLE IF EXISTS ${q(tenantStorageRoleNames(storageKey, 8).owner)}`,
    );
    localSecrets.clear();
  }
});

test("fixture-style cleanup removes the first tenant when setup fails before the second provision", async () => {
  const tenantIds = [
    `m02r1a2-partial-a-${runId}`,
    `m02r1a2-partial-b-${runId}`,
  ];
  const inputs = tenantIds.map((tenantId) => ({
    tenantId,
    storageKey: tenantStorageKey(tenantId),
    roleVersion: 31,
  }));
  const provisioner = new PostgresTenantProvisioner({
    controlPlane: admin!.pool,
    controlPlaneConnectionString: connectionString,
    credentials: credentialStore,
    registry,
  });
  const priorRefs = new Set(credentials.keys());
  try {
    await provisioner.provision(inputs[0]!);
    throw new Error("SYNTHETIC_FAILURE_BETWEEN_PROVISIONS");
  } catch (error) {
    expect((error as Error).message).toBe(
      "SYNTHETIC_FAILURE_BETWEEN_PROVISIONS",
    );
  } finally {
    for (const input of inputs) {
      const schemaName = tenantStorageSchemaName(
        input.storageKey,
        input.roleVersion,
      );
      const roleNames = tenantStorageRoleNames(
        input.storageKey,
        input.roleVersion,
      );
      await admin!.pool.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
      await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roleNames.runtime)}`);
      await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roleNames.owner)}`);
      const record = await registry.get(input.tenantId);
      if (record)
        await registry.delete(input.tenantId, record.receipt.credentialRef);
    }
    for (const ref of [...credentials.keys()])
      if (!priorRefs.has(ref)) await credentialStore.delete(ref);
  }
  const rows = await admin!.pool.query(
    "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = ANY($1::text[]))::int AS schemas, (SELECT count(*) FROM pg_roles WHERE rolname = ANY($2::text[]))::int AS roles",
    [
      inputs.map((input) =>
        tenantStorageSchemaName(input.storageKey, input.roleVersion),
      ),
      inputs.flatMap((input) => {
        return Object.values(
          tenantStorageRoleNames(input.storageKey, input.roleVersion),
        );
      }),
    ],
  );
  expect(rows.rows[0]).toEqual({ schemas: 0, roles: 0 });
  expect(
    [...credentials.keys()].filter((ref) => !priorRefs.has(ref)),
  ).toHaveLength(0);
  for (const tenantId of tenantIds)
    expect(await registry.get(tenantId)).toBeUndefined();
});

test("an ambiguous CREATE outcome is reported and its unproven role is preserved", async () => {
  const tenantId = `m02r1a3-ambiguous-${runId}`;
  const storageKey = tenantStorageKey(tenantId);
  const roles = tenantStorageRoleNames(storageKey, 54);
  let injected = false;
  const controlPlane = {
    async query(text: string, values?: unknown[]) {
      const result = await admin!.pool.query(text, values);
      if (
        !injected &&
        text.startsWith("CREATE ROLE") &&
        text.includes(roles.owner)
      ) {
        injected = true;
        throw new Error("SYNTHETIC_AMBIGUOUS_CREATE_RESULT");
      }
      return result;
    },
  };
  const provisioner = new PostgresTenantProvisioner({
    controlPlane,
    controlPlaneConnectionString: connectionString,
    credentials: credentialStore,
    registry,
  });
  try {
    const thrown = await provisioner
      .provision({ tenantId, storageKey, roleVersion: 54 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(injected).toBe(true);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map(String).join(" ")).toContain(
      `TENANT_PROVISIONING_STRANDED_ARTIFACT role=${roles.owner}`,
    );
    const found = await admin!.pool.query(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = $1",
      [roles.owner],
    );
    expect(found.rows).toEqual([{ rolname: roles.owner }]);
  } finally {
    await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roles.owner)}`);
    claims.delete(tenantId);
  }
});

test("a failure immediately after each created database object is compensated", async () => {
  for (const [index, operation] of [
    "COMMENT ON ROLE",
    "COMMENT ON ROLE",
    "COMMENT ON SCHEMA",
  ].entries()) {
    const tenantId = `m02r1a2-db${index}-${runId}`;
    const storageKey = tenantStorageKey(tenantId);
    const version = 20 + index;
    const schemaName = tenantStorageSchemaName(storageKey, version);
    const roles = tenantStorageRoleNames(storageKey, version);
    let injected = false;
    const controlPlane = {
      async query(text: string, values?: unknown[]) {
        const result = await admin!.pool.query(text, values);
        if (
          !injected &&
          text.startsWith(operation) &&
          ((index === 0 && text.includes(roles.owner)) ||
            (index === 1 && text.includes(roles.runtime)) ||
            (index === 2 && text.includes(schemaName)))
        ) {
          injected = true;
          throw new Error(
            `SYNTHETIC_AFTER_${operation.replaceAll(" ", "_")}_${index}`,
          );
        }
        return result;
      },
    };
    const provisioner = new PostgresTenantProvisioner({
      controlPlane,
      controlPlaneConnectionString: connectionString,
      credentials: credentialStore,
      registry,
    });
    try {
      await expect(
        provisioner.provision({
          tenantId,
          storageKey,
          roleVersion: version,
        }),
      ).rejects.toThrow(
        `SYNTHETIC_AFTER_${operation.replaceAll(" ", "_")}_${index}`,
      );
      expect(injected).toBe(true);
      const objects = await admin!.pool.query(
        "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = $1)::int AS schemas, (SELECT count(*) FROM pg_roles WHERE rolname = ANY($2::text[]))::int AS roles",
        [schemaName, [roles.owner, roles.runtime]],
      );
      expect(objects.rows[0]).toEqual({ schemas: 0, roles: 0 });
      expect(await registry.get(tenantId)).toBeUndefined();
    } finally {
      await admin!.pool.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
      await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roles.runtime)}`);
      await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roles.owner)}`);
      await registry.delete(tenantId, "cleanup");
    }
  }
});

test("storage rejects a changed trusted location after its pool is cached", async () => {
  const baseLookup = new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  });
  let changed = false;
  const storage = createTenantMastraStorage({
    async resolveTenantStorage(tenant) {
      const location = await baseLookup.resolveTenantStorage(tenant);
      return changed ? { ...location, schemaName: schemaB } : location;
    },
  });
  const bind = binding(tenantA);
  try {
    await storage.getStore(trustedScope, bind);
    changed = true;
    await expect(storage.getStore(trustedScope, bind)).rejects.toThrow(
      "MASTRA_STORAGE_BINDING_STALE",
    );
  } finally {
    await storage.close();
  }
});

test("two concurrent tenant closers share one drain and block lookups until it completes", async () => {
  const storage = createTenantMastraStorage(
    new RegistryTenantStorageLookup({
      registry,
      credentials: credentialStore,
      runtimeConnectionString: connectionString,
    }),
  );
  const store = await storage.getStore(trustedScope, binding(tenantA));
  const originalClose = store.close.bind(store);
  let calls = 0;
  let enterFirst!: () => void;
  let releaseFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  store.close = async () => {
    calls += 1;
    enterFirst();
    await firstGate;
    await originalClose();
  };
  try {
    const closeOne = storage.closeTenant(tenantA);
    await firstEntered;
    const closeTwo = storage.closeTenant(tenantA);
    await expect(
      storage.getStore(trustedScope, binding(tenantA)),
    ).rejects.toThrow("MASTRA_STORAGE_CLOSING");
    expect(calls).toBe(1);
    releaseFirst();
    await closeOne;
    await closeTwo;
  } finally {
    releaseFirst();
    store.close = originalClose;
    await storage.close();
  }
});

test("a failed tenant close keeps later lookups blocked", async () => {
  const storage = createTenantMastraStorage(
    new RegistryTenantStorageLookup({
      registry,
      credentials: credentialStore,
      runtimeConnectionString: connectionString,
    }),
  );
  const store = await storage.getStore(trustedScope, binding(tenantA));
  const originalClose = store.close.bind(store);
  store.close = async () => {
    throw new Error("SYNTHETIC_POOL_CLOSE_FAILURE");
  };
  try {
    const closeError = await storage.closeTenant(tenantA).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(closeError).toBeInstanceOf(AggregateError);
    expect(
      (closeError as AggregateError).errors.map(String).join(" "),
    ).toContain("SYNTHETIC_POOL_CLOSE_FAILURE");
    await expect(
      storage.getStore(trustedScope, binding(tenantA)),
    ).rejects.toThrow("MASTRA_STORAGE_CLOSING");
  } finally {
    store.close = originalClose;
    await originalClose();
    await storage.close();
  }
});

test("a conflicting tenant schema cannot delete the first tenant's data", async () => {
  const tenantId = `m02r1a3-collision-${runId}`;
  const storageKey = tenantStorageKey(tenantId);
  const targetSchema = tenantStorageSchemaName(storageKey, 93);
  const protectedOwner = `m02a_guard_${runId.slice(0, 20)}`;
  const firstTenantTable = `${q(schemaA)}.r1a3_protected`;
  const occupiedTable = `${q(targetSchema)}.r1a3_protected`;
  await admin!.pool.query(
    `CREATE TABLE ${firstTenantTable} (value text NOT NULL)`,
  );
  await admin!.pool.query(
    `INSERT INTO ${firstTenantTable} VALUES ('first-tenant')`,
  );
  await admin!.pool.query(
    `CREATE ROLE ${q(protectedOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await admin!.pool.query(
    `CREATE SCHEMA ${q(targetSchema)} AUTHORIZATION ${q(protectedOwner)}`,
  );
  await admin!.pool.query(
    `CREATE TABLE ${occupiedTable} (value text NOT NULL)`,
  );
  await admin!.pool.query(
    `INSERT INTO ${occupiedTable} VALUES ('occupied-first-owner')`,
  );
  const provisioner = new PostgresTenantProvisioner({
    controlPlane: admin!.pool,
    controlPlaneConnectionString: connectionString,
    credentials: credentialStore,
    registry,
  });
  try {
    await expect(
      provisioner.provision({
        tenantId,
        storageKey,
        roleVersion: 93,
        // Simulate an untyped caller attempting to select another tenant's schema.
        schemaName: schemaA,
      } as TenantProvisionInput),
    ).rejects.toThrow();
    expect(
      (await admin!.pool.query(`SELECT value FROM ${firstTenantTable}`)).rows,
    ).toEqual([{ value: "first-tenant" }]);
    expect(
      (await admin!.pool.query(`SELECT value FROM ${occupiedTable}`)).rows,
    ).toEqual([{ value: "occupied-first-owner" }]);
  } finally {
    const roles = tenantStorageRoleNames(storageKey, 93);
    await admin!.pool.query(`DROP SCHEMA IF EXISTS ${q(targetSchema)} CASCADE`);
    await admin!.pool.query(`DROP ROLE IF EXISTS ${q(protectedOwner)}`);
    await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roles.runtime)}`);
    await admin!.pool.query(`DROP ROLE IF EXISTS ${q(roles.owner)}`);
    await admin!.pool.query(`DROP TABLE IF EXISTS ${firstTenantTable}`);
  }
});

test("storage denies a non-runtime session that can assume the runtime role", async () => {
  const location = await new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  }).resolveTenantStorage(tenantA);
  const distinctLogin = `m02_delegate_${runId.slice(0, 24)}`;
  await admin!.pool.query(
    `CREATE ROLE ${q(distinctLogin)} LOGIN PASSWORD 'synthetic_only' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  await admin!.pool.query(
    `GRANT ${q(location.runtimeRole)} TO ${q(distinctLogin)}`,
  );
  const delegatedUrl = new URL(location.connectionString);
  delegatedUrl.username = distinctLogin;
  delegatedUrl.password = "synthetic_only";
  delegatedUrl.searchParams.set("options", `-c role=${location.runtimeRole}`);
  const delegated = new PostgresStore({
    id: `delegate-${runId}`,
    connectionString: delegatedUrl.toString(),
    schemaName: schemaA,
    disableInit: true,
  });
  try {
    const storage = createTenantMastraStorage({
      async resolveTenantStorage() {
        return { ...location, connectionString: delegatedUrl.toString() };
      },
    });
    await expect(
      storage.getStore(trustedScope, binding(tenantA)),
    ).rejects.toThrow("MASTRA_RUNTIME_ROLE_NOT_RESTRICTED");
    await storage.close();
  } finally {
    await delegated.close();
    await admin!.pool.query(
      `REVOKE ${q(location.runtimeRole)} FROM ${q(distinctLogin)}`,
    );
    await admin!.pool.query(`DROP ROLE IF EXISTS ${q(distinctLogin)}`);
  }
});

test("failed runtime-role verification closes and evicts pools before retry", async () => {
  const valid = new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  });
  let corrupt = true;
  const storage = createTenantMastraStorage({
    async resolveTenantStorage(tenant) {
      const location = await valid.resolveTenantStorage(tenant);
      return corrupt
        ? { ...location, runtimeRole: "m02_wrong_runtime" }
        : location;
    },
  });
  const bind = binding(tenantA);
  await expect(storage.getStore(trustedScope, bind)).rejects.toThrow(
    "MASTRA_RUNTIME_ROLE_NOT_RESTRICTED",
  );
  const failedConnections = (await db().execute(
    sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename = ${records.get(tenantA)!.runtimeRole}`,
  )) as unknown as Array<{ count: number }>;
  expect(failedConnections[0]?.count).toBe(0);
  corrupt = false;
  const recovered = await storage.getStore(trustedScope, bind);
  expect(recovered).toBeDefined();
  await storage.close();
});

test("closeTenant rejects a lookup that resolves after close begins", async () => {
  const resolved = await new RegistryTenantStorageLookup({
    registry,
    credentials: credentialStore,
    runtimeConnectionString: connectionString,
  }).resolveTenantStorage(tenantA);
  let release!: (value: typeof resolved) => void;
  const waiting = new Promise<typeof resolved>((resolve) => {
    release = resolve;
  });
  const storage = createTenantMastraStorage({
    async resolveTenantStorage() {
      return waiting;
    },
  });
  const lookup = storage.getStore(trustedScope, binding(tenantA));
  await Promise.resolve();
  await storage.closeTenant(tenantA);
  release(resolved);
  await expect(lookup).rejects.toThrow("MASTRA_STORAGE_CLOSING");
  await storage.close();
});

test("unverified scopes and mismatched trusted registry entries are rejected", async () => {
  let called = false;
  const storage = createTenantMastraStorage({
    async resolveTenantStorage() {
      called = true;
      throw new Error("must not resolve");
    },
  });
  const invalid = {
    ...trustedScope,
    tenantId: "untrusted",
  };
  await expect(storage.getStore(invalid, binding(tenantA))).rejects.toThrow(
    "UNVERIFIED_SCOPE",
  );
  expect(called).toBe(false);
  await storage.close();
});
