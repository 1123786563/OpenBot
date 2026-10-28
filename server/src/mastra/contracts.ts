import { createHash } from "node:crypto";
import type { StorageBackend } from "../enterprise/contracts";

export interface MastraConversationBinding {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly resourceId: string;
  readonly storageKey: string;
  readonly backend: StorageBackend;
}

export interface TenantProvisionInput {
  readonly tenantId: string;
  readonly storageKey: string;
  readonly roleVersion: number;
}

/** Safe to persist or return: credentialRef never contains the secret value. */
export interface TenantProvisionReceipt extends TenantProvisionInput {
  readonly schemaName: string;
  readonly credentialRef: string;
}

export interface TenantStorageLocation extends TenantProvisionReceipt {
  readonly runtimeRole: string;
  /**
   * NOT covered by the receipt's "safe to persist or return" guarantee: this string carries the
   * runtime role's PASSWORD. Never log it, never store it, never return it to a client — resolve
   * it per connection and keep it in memory only.
   */
  readonly connectionString: string;
}

export interface TenantStorageLookup {
  resolveTenantStorage(tenantId: string): Promise<TenantStorageLocation>;
}

export interface TenantStorageProvisioner {
  provision(input: TenantProvisionInput): Promise<TenantProvisionReceipt>;
}

export function tenantStorageKey(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex");
}

/**
 * The identity every derived object name shares. ONE derivation, named once: the schema name and
 * the owner/runtime role names must hash to the same identity for grants to match their schema,
 * so a drift here is not a style problem — it is tenant isolation pointing at the wrong role.
 */
function tenantStorageIdentity(
  storageKey: string,
  roleVersion: number,
): string {
  return createHash("sha256")
    .update(`${storageKey}:mastra:${roleVersion}`)
    .digest("hex")
    .slice(0, 40);
}

/** Object names are derived from a verified tenant key and role version only. */
export function tenantStorageSchemaName(
  storageKey: string,
  roleVersion: number,
): string {
  return `m_${tenantStorageIdentity(storageKey, roleVersion)}_mastra`;
}

export function tenantStorageRoleNames(
  storageKey: string,
  roleVersion: number,
): { owner: string; runtime: string } {
  const identity = tenantStorageIdentity(storageKey, roleVersion);
  return { owner: `m_${identity}_owner`, runtime: `m_${identity}_runtime` };
}
