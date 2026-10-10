import { randomBytes, randomUUID } from "node:crypto";
import { PostgresStore } from "@mastra/pg";
import type {
  TenantProvisionInput,
  TenantProvisionReceipt,
  TenantStorageLocation,
  TenantStorageLookup,
  TenantStorageProvisioner,
} from "./contracts";
import {
  tenantStorageKey,
  tenantStorageRoleNames,
  tenantStorageSchemaName,
} from "./contracts";

export interface ProvisioningQuery {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TenantCredentialStore {
  put(reference: string, secret: string): Promise<void>;
  get(reference: string): Promise<string | undefined>;
  delete(reference: string): Promise<void>;
}

export interface TenantStorageRegistry {
  /** A durable unique-row claim. A provisioning row is never stolen by a timeout. */
  claim(input: TenantProvisionInput): Promise<string | undefined>;
  put(
    receipt: TenantProvisionReceipt,
    runtimeRole: string,
    claimToken: string,
  ): Promise<void>;
  get(
    tenantId: string,
  ): Promise<
    { receipt: TenantProvisionReceipt; runtimeRole: string } | undefined
  >;
  delete(tenantId: string, credentialRef: string): Promise<void>;
  releaseClaim(tenantId: string, claimToken: string): Promise<void>;
}

export interface TenantProvisioningDependencies {
  /** Privileged control-plane identity. Used only by this offline provisioner. */
  controlPlane: ProvisioningQuery;
  controlPlaneConnectionString: string;
  credentials: TenantCredentialStore;
  registry: TenantStorageRegistry;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value))
    throw new Error("INVALID_PROVISIONING_IDENTIFIER");
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateInput(input: TenantProvisionInput): void {
  if (
    !input.tenantId ||
    input.tenantId.trim() !== input.tenantId ||
    input.tenantId.length > 128 ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.tenantId) ||
    !/^[a-f0-9]{64}$/.test(input.storageKey) ||
    input.storageKey !== tenantStorageKey(input.tenantId) ||
    !Number.isSafeInteger(input.roleVersion) ||
    input.roleVersion < 1
  ) {
    throw new Error("INVALID_TENANT_PROVISION_INPUT");
  }
}

function ownedSchemaDrop(
  schema: string,
  owner: string,
  marker: string,
): string {
  return `DO $mastra_cleanup$
DECLARE found_owner text; found_marker text;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(nspowner), pg_catalog.obj_description(oid, 'pg_namespace')
    INTO found_owner, found_marker FROM pg_catalog.pg_namespace WHERE nspname = ${literal(schema)};
  IF NOT FOUND THEN RETURN; END IF;
  IF found_owner IS DISTINCT FROM ${literal(owner)} OR found_marker IS DISTINCT FROM ${literal(marker)} THEN
    RAISE EXCEPTION 'TENANT_PROVISIONING_STRANDED_ARTIFACT schema %', ${literal(schema)};
  END IF;
  EXECUTE ${literal(`DROP SCHEMA ${identifier(schema)} CASCADE`)};
END;
$mastra_cleanup$`;
}

function ownedRoleDrop(role: string, marker: string): string {
  return `DO $mastra_cleanup$
DECLARE found_marker text;
BEGIN
  SELECT pg_catalog.shobj_description(
    (SELECT oid FROM pg_catalog.pg_authid WHERE rolname = ${literal(role)}),
    'pg_authid'
  ) INTO found_marker
  FROM pg_catalog.pg_roles WHERE rolname = ${literal(role)};
  IF NOT FOUND THEN RETURN; END IF;
  IF found_marker IS DISTINCT FROM ${literal(marker)} THEN
    RAISE EXCEPTION 'TENANT_PROVISIONING_STRANDED_ARTIFACT role %', ${literal(role)};
  END IF;
  EXECUTE ${literal(`DROP ROLE ${identifier(role)}`)};
END;
$mastra_cleanup$`;
}

/** Control-plane implementation. The privileged connection is never returned to runtime callers. */
export class PostgresTenantProvisioner implements TenantStorageProvisioner {
  constructor(private readonly dependencies: TenantProvisioningDependencies) {}

  async provision(
    input: TenantProvisionInput,
  ): Promise<TenantProvisionReceipt> {
    validateInput(input);
    const schemaName = tenantStorageSchemaName(
      input.storageKey,
      input.roleVersion,
    );
    const receiptInput = { ...input, schemaName };
    const { owner, runtime } = tenantStorageRoleNames(
      input.storageKey,
      input.roleVersion,
    );
    const secret = randomBytes(32).toString("base64url");
    const credentialRef = `tenant-credential:${randomUUID()}`;
    const attemptMarker = `openbot-mastra-provisioner:${randomUUID()}`;
    const claimToken = await this.dependencies.registry.claim(input);
    if (!claimToken) throw new Error("TENANT_STORAGE_PROVISIONING_CLAIMED");
    const ownerId = identifier(owner);
    const runtimeId = identifier(runtime);
    const schemaId = identifier(schemaName);
    let ownerCreated = false;
    let runtimeCreated = false;
    let schemaCreated = false;
    let ownerCreateAttempted = false;
    let runtimeCreateAttempted = false;
    let schemaCreateAttempted = false;
    let credentialAttempted = false;
    let registryAttempted = false;
    let receipt: TenantProvisionReceipt | undefined;
    let initialized: PostgresStore | undefined;
    try {
      if (await this.dependencies.registry.get(input.tenantId))
        throw new Error("TENANT_STORAGE_ALREADY_PROVISIONED");

      ownerCreateAttempted = true;
      await this.dependencies.controlPlane.query(
        `CREATE ROLE ${ownerId} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      ownerCreated = true;
      await this.dependencies.controlPlane.query(
        `COMMENT ON ROLE ${ownerId} IS ${literal(attemptMarker)}`,
      );

      runtimeCreateAttempted = true;
      await this.dependencies.controlPlane.query(
        `CREATE ROLE ${runtimeId} LOGIN PASSWORD ${literal(secret)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      runtimeCreated = true;
      await this.dependencies.controlPlane.query(
        `COMMENT ON ROLE ${runtimeId} IS ${literal(attemptMarker)}`,
      );

      schemaCreateAttempted = true;
      await this.dependencies.controlPlane.query(
        `CREATE SCHEMA ${schemaId} AUTHORIZATION ${ownerId}`,
      );
      schemaCreated = true;
      await this.dependencies.controlPlane.query(
        `COMMENT ON SCHEMA ${schemaId} IS ${literal(attemptMarker)}`,
      );
      await this.dependencies.controlPlane.query(
        `GRANT USAGE ON SCHEMA ${schemaId} TO ${runtimeId}`,
      );
      await this.dependencies.controlPlane.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaId} TO ${runtimeId}`,
      );
      await this.dependencies.controlPlane.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemaId} TO ${runtimeId}`,
      );
      await this.dependencies.controlPlane.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerId} IN SCHEMA ${schemaId} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeId}`,
      );
      await this.dependencies.controlPlane.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerId} IN SCHEMA ${schemaId} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeId}`,
      );

      const ownerUrl = new URL(this.dependencies.controlPlaneConnectionString);
      ownerUrl.searchParams.set("options", `-c role=${owner}`);
      initialized = new PostgresStore({
        id: `tenant-owner-${input.storageKey}`,
        connectionString: ownerUrl.toString(),
        schemaName,
        disableInit: false,
        max: 2,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 3_000,
      });
      await initialized.init();
      await initialized.close();
      initialized = undefined;

      credentialAttempted = true;
      await this.dependencies.credentials.put(credentialRef, secret);
      receipt = { ...receiptInput, credentialRef };
      registryAttempted = true;
      await this.dependencies.registry.put(receipt, runtime, claimToken);
      return receipt;
    } catch (primaryError) {
      const errors: unknown[] = [primaryError];
      const sqlState = (primaryError as { code?: unknown }).code;
      const isKnownCollision = sqlState === "42710" || sqlState === "42P06";
      const reportAmbiguousCreate = async (
        object: "role" | "schema",
        name: string,
        query: string,
      ) => {
        if (isKnownCollision) return;
        try {
          const result = await this.dependencies.controlPlane.query(query, [
            name,
          ]);
          if (result.rows.length > 0)
            errors.push(
              new Error(
                `TENANT_PROVISIONING_STRANDED_ARTIFACT ${object}=${name} attempt=${attemptMarker}; creation outcome was ambiguous and ownership could not be proven`,
              ),
            );
        } catch (inspectionError) {
          errors.push(
            new Error(
              `TENANT_PROVISIONING_OWNERSHIP_UNVERIFIED ${object}=${name} attempt=${attemptMarker}`,
              { cause: inspectionError },
            ),
          );
        }
      };
      if (ownerCreateAttempted && !ownerCreated)
        await reportAmbiguousCreate(
          "role",
          owner,
          "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
        );
      if (runtimeCreateAttempted && !runtimeCreated)
        await reportAmbiguousCreate(
          "role",
          runtime,
          "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
        );
      if (schemaCreateAttempted && !schemaCreated)
        await reportAmbiguousCreate(
          "schema",
          schemaName,
          "SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1",
        );
      const compensate = async (
        label: string,
        operation: () => Promise<unknown>,
      ) => {
        try {
          await operation();
        } catch (cleanupError) {
          errors.push(
            new Error(
              `TENANT_PROVISIONING_CLEANUP_FAILED ${label} tenant=${input.tenantId} schema=${schemaName} owner=${owner} runtime=${runtime} credentialRef=${credentialAttempted ? credentialRef : "none"}`,
              { cause: cleanupError },
            ),
          );
        }
      };
      const storeToClose = initialized;
      if (storeToClose)
        await compensate("owner-store", () => storeToClose.close());
      if (credentialAttempted)
        await compensate("credential", () =>
          this.dependencies.credentials.delete(credentialRef),
        );
      if (registryAttempted || receipt) {
        await compensate("registry-read", async () => {
          const current = await this.dependencies.registry.get(input.tenantId);
          if (current?.receipt.credentialRef === credentialRef)
            await this.dependencies.registry.delete(
              input.tenantId,
              credentialRef,
            );
        });
      }
      if (schemaCreated)
        await compensate("schema", () =>
          this.dependencies.controlPlane.query(
            ownedSchemaDrop(schemaName, owner, attemptMarker),
          ),
        );
      if (runtimeCreated)
        await compensate("runtime-role", () =>
          this.dependencies.controlPlane.query(
            ownedRoleDrop(runtime, attemptMarker),
          ),
        );
      if (ownerCreated)
        await compensate("owner-role", () =>
          this.dependencies.controlPlane.query(
            ownedRoleDrop(owner, attemptMarker),
          ),
        );
      await compensate("claim", () =>
        this.dependencies.registry.releaseClaim(input.tenantId, claimToken),
      );
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          `TENANT_PROVISIONING_FAILED tenant=${input.tenantId} schema=${schemaName} owner=${owner} runtime=${runtime} credentialRef=${credentialRef}`,
        );
      throw primaryError;
    }
  }
}

/** Resolves opaque registry references into a runtime-only credential and connection. */
export class RegistryTenantStorageLookup implements TenantStorageLookup {
  constructor(
    private readonly dependencies: {
      registry: TenantStorageRegistry;
      credentials: TenantCredentialStore;
      runtimeConnectionString: string;
    },
  ) {}

  async resolveTenantStorage(tenantId: string): Promise<TenantStorageLocation> {
    const entry = await this.dependencies.registry.get(tenantId);
    if (!entry || entry.receipt.tenantId !== tenantId)
      throw new Error("TENANT_STORAGE_NOT_PROVISIONED");
    const { receipt, runtimeRole } = entry;
    validateInput(receipt);
    const expectedSchema = tenantStorageSchemaName(
      receipt.storageKey,
      receipt.roleVersion,
    );
    if (
      receipt.schemaName !== expectedSchema ||
      !/^tenant-credential:[0-9a-f-]{36}$/.test(receipt.credentialRef) ||
      runtimeRole !==
        tenantStorageRoleNames(receipt.storageKey, receipt.roleVersion).runtime
    )
      throw new Error("TENANT_STORAGE_REGISTRY_MISMATCH");
    const password = await this.dependencies.credentials.get(
      receipt.credentialRef,
    );
    if (!password) throw new Error("TENANT_STORAGE_CREDENTIAL_MISSING");
    const url = new URL(this.dependencies.runtimeConnectionString);
    url.username = runtimeRole;
    url.password = password;
    url.searchParams.set("options", `-c role=${runtimeRole}`);
    return { ...receipt, runtimeRole, connectionString: url.toString() };
  }
}
