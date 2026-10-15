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

/** Object names are derived from a verified tenant key and role version only. */
export function tenantStorageSchemaName(
  storageKey: string,
  roleVersion: number,
): string {
  const identity = createHash("sha256")
    .update(`${storageKey}:mastra:${roleVersion}`)
    .digest("hex")
    .slice(0, 40);
  return `m_${identity}_mastra`;
}

export function tenantStorageRoleNames(
  storageKey: string,
  roleVersion: number,
): { owner: string; runtime: string } {
  const identity = createHash("sha256")
    .update(`${storageKey}:mastra:${roleVersion}`)
    .digest("hex")
    .slice(0, 40);
  return { owner: `m_${identity}_owner`, runtime: `m_${identity}_runtime` };
}
