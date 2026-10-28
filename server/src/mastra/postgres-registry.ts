import { randomUUID } from "node:crypto";
import {
  type TenantProvisionInput,
  type TenantProvisionReceipt,
  tenantStorageKey,
  tenantStorageRoleNames,
  tenantStorageSchemaName,
} from "./contracts";
import type { ProvisioningQuery, TenantStorageRegistry } from "./provisioning";

type RegistryRow = Record<string, unknown>;

function inputSchema(input: TenantProvisionInput): string {
  if (
    !input.tenantId ||
    input.tenantId.trim() !== input.tenantId ||
    input.tenantId.length > 128 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.tenantId) ||
    input.storageKey !== tenantStorageKey(input.tenantId) ||
    !Number.isSafeInteger(input.roleVersion) ||
    input.roleVersion < 1
  ) {
    throw new Error("INVALID_TENANT_PROVISION_INPUT");
  }
  return tenantStorageSchemaName(input.storageKey, input.roleVersion);
}

function stringColumn(row: RegistryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error("TENANT_STORAGE_REGISTRY_CORRUPT");
  return value;
}

function numberColumn(row: RegistryRow, key: string): number {
  const value = row[key];
  // A column that is not already a number is corrupt, not coercible: `Number(true)`,
  // `Number([5])` and `Number("5")` all pass the safe-integer check and would launder
  // a wrong-typed row into a roleVersion.
  if (typeof value !== "number")
    throw new Error("TENANT_STORAGE_REGISTRY_CORRUPT");
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("TENANT_STORAGE_REGISTRY_CORRUPT");
  return value;
}

/** A PostgreSQL unique-row/CAS adapter; every method is safe across processes. */
export class PostgresTenantStorageRegistry implements TenantStorageRegistry {
  constructor(private readonly controlPlane: ProvisioningQuery) {}

  async claim(input: TenantProvisionInput): Promise<string | undefined> {
    const schemaName = inputSchema(input);
    const token = randomUUID();
    const result = await this.controlPlane.query(
      `INSERT INTO mastra_tenant_storage_registry
        (tenant_id, storage_key, schema_name, role_version, status, claim_token)
       VALUES ($1, $2, $3, $4, 'provisioning', $5)
       ON CONFLICT DO NOTHING
       RETURNING claim_token`,
      [input.tenantId, input.storageKey, schemaName, input.roleVersion, token],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1 || result.rows[0]?.claim_token !== token)
      throw new Error("TENANT_STORAGE_REGISTRY_CLAIM_CORRUPT");
    return token;
  }

  async put(
    receipt: TenantProvisionReceipt,
    runtimeRole: string,
    claimToken: string,
  ): Promise<void> {
    const schemaName = inputSchema(receipt);
    const expectedRuntimeRole = tenantStorageRoleNames(
      receipt.storageKey,
      receipt.roleVersion,
    ).runtime;
    if (
      receipt.schemaName !== schemaName ||
      runtimeRole !== expectedRuntimeRole ||
      !/^tenant-credential:[0-9a-f-]{36}$/.test(receipt.credentialRef)
    )
      throw new Error("TENANT_STORAGE_REGISTRY_MISMATCH");
    const result = await this.controlPlane.query(
      `UPDATE mastra_tenant_storage_registry
       SET status = 'ready', claim_token = NULL, credential_ref = $4,
           runtime_role = $5, ready_at = now()
       WHERE tenant_id = $1 AND storage_key = $2 AND schema_name = $3
         AND status = 'provisioning' AND claim_token = $6
       RETURNING tenant_id`,
      [
        receipt.tenantId,
        receipt.storageKey,
        schemaName,
        receipt.credentialRef,
        runtimeRole,
        claimToken,
      ],
    );
    if (result.rows.length !== 1) throw new Error("TENANT_STORAGE_CLAIM_LOST");
  }

  async get(
    tenantId: string,
  ): Promise<
    { receipt: TenantProvisionReceipt; runtimeRole: string } | undefined
  > {
    const result = await this.controlPlane.query(
      `SELECT tenant_id, storage_key, schema_name, role_version, credential_ref, runtime_role
       FROM mastra_tenant_storage_registry
       WHERE tenant_id = $1 AND status = 'ready'`,
      [tenantId],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row)
      throw new Error("TENANT_STORAGE_REGISTRY_CORRUPT");
    return {
      receipt: {
        tenantId: stringColumn(row, "tenant_id"),
        storageKey: stringColumn(row, "storage_key"),
        schemaName: stringColumn(row, "schema_name"),
        roleVersion: numberColumn(row, "role_version"),
        credentialRef: stringColumn(row, "credential_ref"),
      },
      runtimeRole: stringColumn(row, "runtime_role"),
    };
  }

  async delete(tenantId: string, credentialRef: string): Promise<void> {
    await this.controlPlane.query(
      `DELETE FROM mastra_tenant_storage_registry
       WHERE tenant_id = $1 AND status = 'ready' AND credential_ref = $2`,
      [tenantId, credentialRef],
    );
  }

  async releaseClaim(tenantId: string, claimToken: string): Promise<void> {
    await this.controlPlane.query(
      `DELETE FROM mastra_tenant_storage_registry
       WHERE tenant_id = $1 AND status = 'provisioning' AND claim_token = $2`,
      [tenantId, claimToken],
    );
  }
}
