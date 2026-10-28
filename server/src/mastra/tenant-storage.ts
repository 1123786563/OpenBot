import { PostgresStore } from "@mastra/pg";
import type { PlatformScope } from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";
import type {
  MastraConversationBinding,
  TenantStorageLocation,
  TenantStorageLookup,
  TenantStorageProvisioner,
} from "./contracts";
import { tenantStorageKey } from "./contracts";

export interface MastraIntentMessageIdentity {
  readonly messageId: string;
  readonly digest: string;
  readonly seq: number;
  readonly clientMessageKey: string;
  readonly attachmentIds: readonly string[];
}

export interface TenantMastraStorage {
  getStore(
    scope: PlatformScope,
    binding: MastraConversationBinding,
  ): Promise<PostgresStore>;
  withConversationLock<T>(
    scope: PlatformScope,
    binding: MastraConversationBinding,
    operation: () => Promise<T>,
  ): Promise<T>;
  inspectIntentMessage(
    binding: MastraConversationBinding,
    expected: MastraIntentMessageIdentity,
  ): Promise<"absent" | "exact" | "mismatch">;
  closeTenant(tenantId: string): Promise<void>;
  close(): Promise<void>;
}

const CONVERSATION_STATEMENT_TIMEOUT_MS = 4_000;

function boundedConversationConnectionString(connectionString: string): string {
  const address = new URL(connectionString);
  const prior = address.searchParams.get("options")?.trim() ?? "";
  if (/\bstatement_timeout\b/.test(prior))
    throw new Error("TENANT_STORAGE_STATEMENT_TIMEOUT_CONFLICT");
  address.searchParams.set(
    "options",
    [prior, "-c", `statement_timeout=${CONVERSATION_STATEMENT_TIMEOUT_MS}`]
      .filter(Boolean)
      .join(" "),
  );
  return address.toString();
}

function validateLocation(
  location: TenantStorageLocation,
  tenantId: string,
): void {
  if (
    location.tenantId !== tenantId ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(location.schemaName) ||
    location.schemaName === "public" ||
    location.schemaName.startsWith("pg_") ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(location.storageKey) ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(location.runtimeRole) ||
    !Number.isSafeInteger(location.roleVersion) ||
    location.roleVersion < 1 ||
    !/^tenant-credential:[0-9a-f-]{36}$/.test(location.credentialRef) ||
    !/^postgres(?:ql)?:\/\//.test(location.connectionString)
  ) {
    throw new Error("INVALID_TENANT_STORAGE_REGISTRY_ENTRY");
  }
}

async function assertRestrictedRuntimeRole(
  store: PostgresStore,
  location: TenantStorageLocation,
): Promise<void> {
  const result = await store.pool.query<{
    session_user: string;
    current_user: string;
    runtime_is_privileged: boolean;
    login_is_privileged: boolean;
    can_use_schema: boolean;
    can_create_schema_objects: boolean;
    is_schema_owner: boolean;
    owns_schema_tables: boolean;
  }>(
    `SELECT session_user, current_user,
      runtime.rolsuper OR runtime.rolbypassrls OR runtime.rolcreatedb OR runtime.rolcreaterole AS runtime_is_privileged,
      login.rolsuper OR login.rolbypassrls OR login.rolcreatedb OR login.rolcreaterole AS login_is_privileged,
      has_schema_privilege(current_user, $1, 'USAGE') AS can_use_schema,
      has_schema_privilege(current_user, $1, 'CREATE') AS can_create_schema_objects,
      namespace.nspowner = runtime.oid AS is_schema_owner,
      EXISTS (
        SELECT 1 FROM pg_class relation
        WHERE relation.relnamespace = namespace.oid
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND relation.relowner = runtime.oid
      ) AS owns_schema_tables
    FROM pg_roles runtime
    JOIN pg_roles login ON login.rolname = session_user
    JOIN pg_namespace namespace ON namespace.nspname = $1
    WHERE runtime.rolname = current_user`,
    [location.schemaName],
  );
  const role = result.rows[0];
  if (
    !role ||
    role.session_user !== location.runtimeRole ||
    role.current_user !== location.runtimeRole ||
    role.runtime_is_privileged ||
    role.login_is_privileged ||
    !role.can_use_schema ||
    role.can_create_schema_objects ||
    role.is_schema_owner ||
    role.owns_schema_tables
  ) {
    throw new Error("MASTRA_RUNTIME_ROLE_NOT_RESTRICTED");
  }
}

/**
 * Runtime storage lookup is tenant scoped and backed only by the trusted control-plane registry.
 * Mastra is configured with disableInit: provisioning credentials never enter this runtime path.
 */
export function createTenantMastraStorage(
  lookup: TenantStorageLookup,
): TenantMastraStorage {
  const locationFingerprint = (location: TenantStorageLocation) =>
    JSON.stringify([
      location.tenantId,
      location.storageKey,
      location.schemaName,
      location.roleVersion,
      location.runtimeRole,
      location.credentialRef,
    ]);
  const stores = new Map<
    string,
    {
      tenantId: string;
      storageKey: string;
      fingerprint: string;
      store: PostgresStore;
      lockStore: PostgresStore;
    }
  >();
  // The opening promise carries its tenantId: closeTenant then matches by equality
  // instead of a key prefix, which a tenant id containing a colon would corrupt.
  const pending = new Map<
    string,
    { tenantId: string; opening: Promise<PostgresStore> }
  >();
  const pendingFingerprints = new Map<string, string>();
  const closingTenants = new Map<string, Promise<void>>();
  const failedClosures = new Set<string>();
  const tenantEpochs = new Map<string, number>();
  let closed = false;

  async function getStoreForTenant(
    tenantId: string,
    binding: MastraConversationBinding,
  ): Promise<PostgresStore> {
    if (
      closed ||
      binding.tenantId !== tenantId ||
      (binding.backend !== "intelligence" && binding.backend !== "mastra")
    ) {
      throw new Error("MASTRA_STORAGE_FORBIDDEN");
    }
    if (closingTenants.has(tenantId) || failedClosures.has(tenantId))
      throw new Error("MASTRA_STORAGE_CLOSING");
    const tenantEpoch = tenantEpochs.get(tenantId) ?? 0;
    const location = await lookup.resolveTenantStorage(tenantId);
    if (
      closed ||
      closingTenants.has(tenantId) ||
      failedClosures.has(tenantId) ||
      tenantEpoch !== (tenantEpochs.get(tenantId) ?? 0)
    )
      throw new Error("MASTRA_STORAGE_CLOSING");
    validateLocation(location, tenantId);
    const fingerprint = locationFingerprint(location);
    if (location.storageKey !== binding.storageKey)
      throw new Error("MASTRA_STORAGE_BINDING_STALE");
    const key = `${location.tenantId}:${location.storageKey}`;
    const entry = stores.get(key);
    if (entry) {
      if (entry.fingerprint !== fingerprint)
        throw new Error("MASTRA_STORAGE_BINDING_STALE");
      return entry.store;
    }
    let opening = pending.get(key)?.opening;
    if (opening && pendingFingerprints.get(key) !== fingerprint)
      throw new Error("MASTRA_STORAGE_BINDING_STALE");
    if (!opening) {
      pendingFingerprints.set(key, fingerprint);
      opening = (async () => {
        const conversationConnectionString =
          boundedConversationConnectionString(location.connectionString);
        const store = new PostgresStore({
          id: `openbot-${location.storageKey}`,
          connectionString: conversationConnectionString,
          schemaName: location.schemaName,
          disableInit: true,
          max: 4,
          idleTimeoutMillis: 5_000,
          connectionTimeoutMillis: 3_000,
        });
        const lockStore = new PostgresStore({
          id: `openbot-lock-${location.storageKey}`,
          connectionString: conversationConnectionString,
          schemaName: location.schemaName,
          disableInit: true,
          max: 1,
          idleTimeoutMillis: 5_000,
          connectionTimeoutMillis: 3_000,
        });
        try {
          await assertRestrictedRuntimeRole(store, location);
          if (
            closed ||
            closingTenants.has(location.tenantId) ||
            failedClosures.has(location.tenantId)
          )
            throw new Error("MASTRA_STORAGE_CLOSING");
          stores.set(key, {
            tenantId: location.tenantId,
            storageKey: location.storageKey,
            fingerprint,
            store,
            lockStore,
          });
          return store;
        } catch (error) {
          // Cleanup that itself fails must not replace the error that caused it.
          await Promise.allSettled([store.close(), lockStore.close()]);
          throw error;
        }
      })();
      pending.set(key, { tenantId: location.tenantId, opening });
      void opening
        .finally(() => {
          if (pending.get(key)?.opening === opening) {
            pending.delete(key);
            pendingFingerprints.delete(key);
          }
        })
        .catch(() => undefined);
    }
    return opening;
  }

  async function withTenantConversationLock<T>(
    binding: MastraConversationBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    const store = await getStoreForTenant(binding.tenantId, binding);
    const key = `${binding.tenantId}:${binding.storageKey}`;
    const entry = stores.get(key);
    if (!entry || entry.store !== store)
      throw new Error("MASTRA_STORAGE_BINDING_STALE");
    const client = await entry.lockStore.pool.connect();
    // The pool may have been handed to a close while this connect waited: a client acquired
    // from a store no longer registered would BEGIN under a pool the tenant already left.
    if (stores.get(key) !== entry || closingTenants.has(binding.tenantId)) {
      client.release();
      throw new Error("MASTRA_STORAGE_CLOSING");
    }
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      // `statement_timeout` only bounds SQL; `operation()` runs plain JS between statements, and
      // an idle-in-transaction hang would hold the advisory lock (and this single-connection
      // lockStore) for ever. The floor is generous: the critical section is conversation writes.
      await client.query(
        "SET LOCAL idle_in_transaction_session_timeout = '30s'",
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          JSON.stringify([
            "mastra-conversation",
            binding.tenantId,
            binding.threadId,
          ]),
        ],
      );
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async getStore(scope, binding) {
      assertTrustedScope(scope);
      if (binding.tenantId !== scope.tenantId)
        throw new Error("MASTRA_STORAGE_FORBIDDEN");
      return getStoreForTenant(scope.tenantId, binding);
    },
    async withConversationLock(scope, binding, operation) {
      assertTrustedScope(scope);
      if (binding.tenantId !== scope.tenantId)
        throw new Error("MASTRA_STORAGE_FORBIDDEN");
      return withTenantConversationLock(binding, operation);
    },
    async inspectIntentMessage(binding, expected) {
      if (
        binding.backend !== "mastra" ||
        binding.storageKey !== tenantStorageKey(binding.tenantId) ||
        !Number.isSafeInteger(expected.seq) ||
        expected.seq < 1 ||
        !Array.isArray(expected.attachmentIds)
      ) {
        throw new Error("MASTRA_INTENT_INSPECTION_FORBIDDEN");
      }
      let resource: unknown;
      try {
        const encoded = binding.resourceId.slice("private:".length);
        resource = binding.resourceId.startsWith("private:")
          ? JSON.parse(encoded)
          : null;
      } catch {
        resource = null;
      }
      if (
        !Array.isArray(resource) ||
        resource.length !== 2 ||
        resource[0] !== binding.tenantId ||
        typeof resource[1] !== "string" ||
        !binding.threadId ||
        !expected.messageId ||
        !expected.digest ||
        !expected.clientMessageKey
      ) {
        throw new Error("MASTRA_INTENT_INSPECTION_FORBIDDEN");
      }
      const store = await getStoreForTenant(binding.tenantId, binding);
      const memory = await store.getStore("memory");
      if (!memory) throw new Error("MASTRA_MEMORY_STORAGE_UNAVAILABLE");
      return withTenantConversationLock(binding, async () => {
        const found = await memory.listMessagesById({
          messageIds: [expected.messageId],
        });
        const message = found.messages.find(
          ({ id }) => id === expected.messageId,
        );
        if (!message) return "absent";
        const metadata = message.content.metadata ?? {};
        const attachmentIds = metadata.openbotAttachments;
        const attachmentsMatch =
          Array.isArray(attachmentIds) &&
          attachmentIds.length === expected.attachmentIds.length &&
          attachmentIds.every(
            (attachmentId, index) =>
              attachmentId === expected.attachmentIds[index],
          );
        return message.threadId === binding.threadId &&
          message.resourceId === binding.resourceId &&
          metadata.openbotDigest === expected.digest &&
          metadata.openbotSeq === expected.seq &&
          metadata.openbotClientMessageKey === expected.clientMessageKey &&
          attachmentsMatch
          ? "exact"
          : "mismatch";
      });
    },
    async closeTenant(tenantId) {
      const existing = closingTenants.get(tenantId);
      if (existing) return existing;
      // A previous close failing is not a verdict: retried, it either finishes this time or
      // fails again with the same named error. Permanent death here cost a process restart for
      // one transient close timeout.
      failedClosures.delete(tenantId);
      tenantEpochs.set(tenantId, (tenantEpochs.get(tenantId) ?? 0) + 1);
      const closing = (async () => {
        let failed = false;
        try {
          const openings = [...pending.entries()]
            .filter(([, value]) => value.tenantId === tenantId)
            .map(([, value]) => value.opening);
          await Promise.allSettled(openings);
          const entries = [...stores.entries()].filter(
            ([, entry]) => entry.tenantId === tenantId,
          );
          const results = await Promise.allSettled(
            entries.flatMap(([, entry]) => [
              entry.store.close(),
              entry.lockStore.close(),
            ]),
          );
          const failures = results.filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          // The entries stay registered while a close failed: dropping them would leak the
          // pools AND leave nothing for the retry above to close.
          if (failures.length === 0)
            for (const [key] of entries) stores.delete(key);
          if (failures.length) {
            failed = true;
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              `MASTRA_STORAGE_CLOSE_FAILED tenant=${tenantId}`,
            );
          }
        } finally {
          if (failed) failedClosures.add(tenantId);
          closingTenants.delete(tenantId);
        }
      })();
      closingTenants.set(tenantId, closing);
      return closing;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(
        [...pending.values()].map((value) => value.opening),
      );
      // allSettled plus an unconditional clear, the same shape closeTenant keeps: one
      // pool refusing to close must not strand every other entry in the map on a path
      // this flag makes impossible to retry.
      await Promise.allSettled(
        [...stores.values()].flatMap(({ store, lockStore }) => [
          store.close(),
          lockStore.close(),
        ]),
      );
      stores.clear();
    },
  };
}

/** Provisioning is deliberately a separate call surface and dependency from runtime lookup. */
export async function provisionTenantMastraStorage(
  provisioner: TenantStorageProvisioner,
  input: import("./contracts").TenantProvisionInput,
): Promise<import("./contracts").TenantProvisionReceipt> {
  if (
    !input.tenantId ||
    input.tenantId.trim() !== input.tenantId ||
    input.tenantId.length > 128
  )
    throw new Error("INVALID_TENANT_ID");
  return provisioner.provision(input);
}
