/**
 * Explicit provisioning and versioned revocation, per plan 02 §5 T1-C.
 *
 * Every function here is the offline tenant operator's ONLY door to membership, workspace,
 * resource and ACL writes: a strict schema, a deterministic payload digest, one READ COMMITTED
 * transaction with the plan's fixed advisory-lock order, a re-validated prior audit event, the
 * write itself, and the audit append — committed together or not at all. There is no arbitrary
 * SQL, no table chosen by input, and no path that bumps an epoch or acl_epoch without a real
 * change landing in the same transaction.
 *
 * Idempotency is keyed by the operation id: the audit event's id IS the operation id. A replay of
 * the exact same normalized payload returns the recorded result and writes nothing — it does not
 * re-grant a membership that was suspended since, and it does not bump any epoch. The same
 * operation id with any different payload is a conflict, even when it points at different rows.
 */
import { z } from "zod";
import type { TenantRole } from "../../../../shared/enterprise/contracts";
import type { Database } from "../../db/client";
import { EnterpriseError } from "../errors";
import {
  beginOperation,
  firstRow,
  lockExclusive,
  lockKey,
  lockShared,
  setTenantAndPrincipalContext,
  setTenantContext,
  type TxClient,
} from "./transaction";

/*
 * Digest serialization, frozen in this file per the plan. The version constant changes only with a
 * migration of every stored event; the stable stringify sorts keys at every level so two payloads
 * with the same fields always hash the same regardless of how the caller constructed them.
 */
export const PAYLOAD_SERIALIZATION = "enterprise-provision-payload-v1";

export function payloadDigest(
  operation: string,
  payload: Record<string, string>,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(PAYLOAD_SERIALIZATION);
  hasher.update("\n");
  hasher.update(stableStringify({ operation, ...payload }));
  return hasher.digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/*
 * The shape written into every audit event's details, and the ONLY shape a prior event may have
 * for a replay to be recognized. Anything else — missing digest, different serialization version,
 * extra keys — is a corrupt audit record and fails the operation closed.
 */
const StoredDetailsSchema = z
  .object({
    serialization: z.literal(PAYLOAD_SERIALIZATION),
    payload_digest: z.string().min(1),
    result: z.unknown(),
  })
  .strict();

type StoredDetails = z.infer<typeof StoredDetailsSchema>;

export const TENANT_ROLES = ["tenant_admin", "member", "auditor"] as const;
export const RESOURCE_KINDS = ["document"] as const;

const identifier = z.string().trim().min(1);

export const ProvisionInputSchema = z
  .object({
    tenantId: identifier,
    tenantName: identifier,
    principalId: identifier,
    userId: identifier,
    role: z.enum(TENANT_ROLES),
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export const SuspendInputSchema = z
  .object({
    tenantId: identifier,
    principalId: identifier,
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export const CreateWorkspaceInputSchema = z
  .object({
    tenantId: identifier,
    workspaceId: identifier,
    name: identifier,
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export const CreateResourceInputSchema = z
  .object({
    tenantId: identifier,
    workspaceId: identifier,
    resourceId: identifier,
    kind: z.enum(RESOURCE_KINDS),
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export const GrantInputSchema = z
  .object({
    tenantId: identifier,
    resourceId: identifier,
    principalId: identifier,
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export type ProvisionInput = z.infer<typeof ProvisionInputSchema>;
export type SuspendInput = z.infer<typeof SuspendInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type CreateResourceInput = z.infer<typeof CreateResourceInputSchema>;
export type GrantInput = z.infer<typeof GrantInputSchema>;

/** The minimal recorded outcome of an operation, replayed verbatim to a re-submitted caller. */
export type OperationOutcome = Record<string, unknown>;

/*
 * Statement texts. Every value travels as a `$n` parameter; the texts are constants of this file.
 * RLS on the operator login keeps each statement inside the `app.tenant_id` context the runner
 * sets, and the principal lookup inside `app.operator_principal_id`.
 */
const SELECT_STORED_EVENT =
  "select kind, details from enterprise_security_events where tenant_id = $1 and id = $2";
const INSERT_EVENT =
  "insert into enterprise_security_events (tenant_id, id, operation_id, actor, kind, details) values ($1, $2, $3, $4, $5, $6::jsonb)";
const SELECT_PRINCIPAL =
  "select user_id, status from enterprise_principals where id = $1";
const SELECT_TENANT =
  "select name, status from enterprise_tenants where id = $1";
const INSERT_TENANT =
  "insert into enterprise_tenants (id, name) values ($1, $2)";
const SELECT_MEMBERSHIP =
  "select role, status, epoch from enterprise_memberships where tenant_id = $1 and principal_id = $2";
const INSERT_MEMBERSHIP =
  "insert into enterprise_memberships (tenant_id, principal_id, role) values ($1, $2, $3)";
const LOCK_MEMBERSHIP_ROW =
  "select 1 from enterprise_memberships where tenant_id = $1 and principal_id = $2 for update";
const SUSPEND_MEMBERSHIP =
  "update enterprise_memberships set status = 'suspended', epoch = epoch + 1 where tenant_id = $1 and principal_id = $2 and status = 'active' returning epoch";
const SELECT_WORKSPACE =
  "select id, name from enterprise_workspaces where tenant_id = $1 and id = $2";
const INSERT_WORKSPACE =
  "insert into enterprise_workspaces (tenant_id, id, name) values ($1, $2, $3)";
const SELECT_RESOURCE =
  "select workspace_id, kind, status, revision, acl_epoch from enterprise_resources where tenant_id = $1 and id = $2";
const INSERT_RESOURCE =
  "insert into enterprise_resources (tenant_id, id, workspace_id, kind) values ($1, $2, $3, $4)";
const INSERT_GRANT =
  "insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action) values ($1, $2, $3, 'read') on conflict do nothing returning principal_id";
const BUMP_ACL_EPOCH =
  "update enterprise_resources set acl_epoch = acl_epoch + 1 where tenant_id = $1 and id = $2 returning acl_epoch";
const DELETE_GRANT =
  "delete from enterprise_resource_grants where tenant_id = $1 and resource_id = $2 and principal_id = $3 and action = 'read' returning principal_id";

type OperationInput = {
  tenantId: string;
  operator: string;
  operationId: string;
};

type TenantOperation<TInput extends OperationInput> = {
  kind: string;
  digestPayload(input: TInput): Record<string, string>;
  /** The principal the operation must be able to look up, when it needs one. */
  operatorPrincipalId?(input: TInput): string | undefined;
  locks(tx: TxClient, input: TInput): Promise<void>;
  act(tx: TxClient, input: TInput): Promise<OperationOutcome>;
};

async function runTenantOperation<TInput extends OperationInput>(
  database: Database,
  input: TInput,
  operation: TenantOperation<TInput>,
): Promise<OperationOutcome> {
  const digest = payloadDigest(operation.kind, operation.digestPayload(input));
  return beginOperation(database, async (tx) => {
    const principalId = operation.operatorPrincipalId?.(input);
    if (principalId === undefined) {
      await setTenantContext(tx, input.tenantId);
    } else {
      await setTenantAndPrincipalContext(tx, input.tenantId, principalId);
    }
    await operation.locks(tx, input);

    const prior = await readStoredEvent(tx, input.tenantId, input.operationId);
    if (prior !== undefined) {
      if (
        prior.kind !== operation.kind ||
        prior.details.payload_digest !== digest
      ) {
        throw new EnterpriseError("IDEMPOTENCY_CONFLICT", 409);
      }
      /* The exact operation already landed: return what it recorded, write nothing. A membership
       * suspended since, or a grant revoked since, is NOT restored by a replay. */
      return prior.details.result as OperationOutcome;
    }

    const result = await operation.act(tx, input);
    await appendEvent(
      tx,
      input.tenantId,
      input.operationId,
      input.operator,
      operation.kind,
      digest,
      result,
    );
    return result;
  });
}

async function readStoredEvent(
  tx: TxClient,
  tenantId: string,
  operationId: string,
): Promise<{ kind: string; details: StoredDetails } | undefined> {
  const row = await firstRow(tx, SELECT_STORED_EVENT, [tenantId, operationId]);
  if (row === undefined) {
    return undefined;
  }
  /* jsonb comes back as a parsed object; validate it strictly — never trust a stored event body,
   * and never treat an unparseable one as "not a replay". */
  const parsedDetails = StoredDetailsSchema.safeParse(row.details);
  if (!parsedDetails.success || typeof row.kind !== "string") {
    throw new EnterpriseError("SECURITY_EVENT_UNREADABLE", 503);
  }
  return { kind: row.kind, details: parsedDetails.data };
}

async function appendEvent(
  tx: TxClient,
  tenantId: string,
  operationId: string,
  operator: string,
  kind: string,
  digest: string,
  result: OperationOutcome,
): Promise<void> {
  /* The details value is passed as an object, not pre-stringified: Bun's SQL serializes a value
   * once, so a pre-stringified parameter would land as a doubly-encoded jsonb string. */
  await tx.unsafe(INSERT_EVENT, [
    tenantId,
    operationId,
    operationId,
    operator,
    kind,
    {
      serialization: PAYLOAD_SERIALIZATION,
      payload_digest: digest,
      result,
    },
  ]);
}

/** The tenant must exist and be active; provisioning into a suspended tenant is a conflict. */
async function requireActiveTenant(
  tx: TxClient,
  tenantId: string,
): Promise<void> {
  const tenant = await firstRow(tx, SELECT_TENANT, [tenantId]);
  if (tenant === undefined) {
    throw new EnterpriseError("TENANT_NOT_FOUND", 409);
  }
  if (tenant.status !== "active") {
    throw new EnterpriseError("TENANT_NOT_ACTIVE", 409);
  }
}

/**
 * Opens a tenant (creating it on first use) and adds one member. The principal must already exist
 * with the exact user binding and be active — a tenant operator never creates users, repairs
 * bindings or calls the identity operator. An existing tenant must carry the same name; an
 * existing membership must carry the same role and still be active. Nothing is auto-updated or
 * reactivated.
 */
export async function provisionMember(
  database: Database,
  input: ProvisionInput,
): Promise<OperationOutcome> {
  return runTenantOperation(database, ProvisionInputSchema.parse(input), {
    kind: "membership.provisioned",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      tenantName: i.tenantName,
      principalId: i.principalId,
      userId: i.userId,
      role: i.role,
      operator: i.operator,
    }),
    operatorPrincipalId: (i) => i.principalId,
    locks: async (tx, i) => {
      await lockExclusive(tx, lockKey("tenant", i.tenantId));
      await lockShared(tx, lockKey("principal", i.principalId));
      await lockExclusive(tx, lockKey("membership", i.tenantId, i.principalId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
    },
    act: provisionMembership,
  });
}

async function provisionMembership(
  tx: TxClient,
  input: ProvisionInput,
): Promise<OperationOutcome> {
  const principal = await firstRow(tx, SELECT_PRINCIPAL, [input.principalId]);
  if (principal === undefined) {
    throw new EnterpriseError("PRINCIPAL_NOT_FOUND", 409);
  }
  if (principal.user_id !== input.userId) {
    throw new EnterpriseError("PRINCIPAL_BINDING_CONFLICT", 409);
  }
  if (principal.status !== "active") {
    throw new EnterpriseError("PRINCIPAL_SUSPENDED", 409);
  }

  const tenant = await firstRow(tx, SELECT_TENANT, [input.tenantId]);
  let tenantState: "created" | "existing";
  if (tenant === undefined) {
    await tx.unsafe(INSERT_TENANT, [input.tenantId, input.tenantName]);
    tenantState = "created";
  } else {
    if (tenant.name !== input.tenantName) {
      throw new EnterpriseError("TENANT_CONFLICT", 409);
    }
    if (tenant.status !== "active") {
      throw new EnterpriseError("TENANT_NOT_ACTIVE", 409);
    }
    tenantState = "existing";
  }

  const membership = await firstRow(tx, SELECT_MEMBERSHIP, [
    input.tenantId,
    input.principalId,
  ]);
  if (membership !== undefined) {
    if (membership.role !== input.role || membership.status !== "active") {
      throw new EnterpriseError("MEMBERSHIP_CONFLICT", 409);
    }
    return {
      tenant: tenantState,
      membershipStatus: membership.status,
      membershipEpoch: membership.epoch,
    };
  }

  await tx.unsafe(INSERT_MEMBERSHIP, [
    input.tenantId,
    input.principalId,
    input.role,
  ]);
  return {
    tenant: tenantState,
    membershipStatus: "active",
    membershipEpoch: 1,
  };
}

/**
 * Suspends one membership and bumps its epoch, so every scope minted before the suspension stops
 * answering. The epoch moves only when the status actually changes; suspending an already
 * suspended member records the no-change outcome. Reactivation is deliberately not offered.
 */
export async function suspendMember(
  database: Database,
  input: SuspendInput,
): Promise<OperationOutcome> {
  return runTenantOperation(database, SuspendInputSchema.parse(input), {
    kind: "membership.suspended",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      principalId: i.principalId,
      operator: i.operator,
    }),
    locks: async (tx, i) => {
      await lockShared(tx, lockKey("tenant", i.tenantId));
      await lockShared(tx, lockKey("principal", i.principalId));
      await lockExclusive(tx, lockKey("membership", i.tenantId, i.principalId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
    },
    act: suspendMembership,
  });
}

async function suspendMembership(
  tx: TxClient,
  input: SuspendInput,
): Promise<OperationOutcome> {
  const membership = await firstRow(tx, SELECT_MEMBERSHIP, [
    input.tenantId,
    input.principalId,
  ]);
  if (membership === undefined) {
    throw new EnterpriseError("MEMBERSHIP_NOT_FOUND", 409);
  }
  if (membership.status === "suspended") {
    return { changed: false, membershipEpoch: membership.epoch };
  }
  await tx.unsafe(LOCK_MEMBERSHIP_ROW, [input.tenantId, input.principalId]);
  const updated = await tx.unsafe<{ epoch: number }[]>(SUSPEND_MEMBERSHIP, [
    input.tenantId,
    input.principalId,
  ]);
  return { changed: true, membershipEpoch: updated[0].epoch };
}

/** Creates a workspace inside an active tenant; the same id with a different name conflicts. */
export async function createWorkspace(
  database: Database,
  input: CreateWorkspaceInput,
): Promise<OperationOutcome> {
  return runTenantOperation(database, CreateWorkspaceInputSchema.parse(input), {
    kind: "workspace.created",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      workspaceId: i.workspaceId,
      name: i.name,
      operator: i.operator,
    }),
    locks: async (tx, i) => {
      await lockShared(tx, lockKey("tenant", i.tenantId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
    },
    act: insertWorkspace,
  });
}

async function insertWorkspace(
  tx: TxClient,
  input: CreateWorkspaceInput,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, input.tenantId);
  const existing = await firstRow(tx, SELECT_WORKSPACE, [
    input.tenantId,
    input.workspaceId,
  ]);
  if (existing !== undefined) {
    if (existing.name !== input.name) {
      throw new EnterpriseError("WORKSPACE_CONFLICT", 409);
    }
    return { created: false };
  }
  await tx.unsafe(INSERT_WORKSPACE, [
    input.tenantId,
    input.workspaceId,
    input.name,
  ]);
  return { created: true };
}

/**
 * Creates a resource in a same-tenant workspace. The workspace must exist inside the tenant the
 * context names — another tenant's workspace of the same id is invisible and rejected. A new
 * resource starts at revision 1 and acl epoch 1.
 */
export async function createResource(
  database: Database,
  input: CreateResourceInput,
): Promise<OperationOutcome> {
  return runTenantOperation(database, CreateResourceInputSchema.parse(input), {
    kind: "resource.created",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      workspaceId: i.workspaceId,
      resourceId: i.resourceId,
      kind: i.kind,
      operator: i.operator,
    }),
    locks: async (tx, i) => {
      await lockShared(tx, lockKey("tenant", i.tenantId));
      await lockExclusive(tx, lockKey("resource", i.tenantId, i.resourceId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
    },
    act: insertResource,
  });
}

async function insertResource(
  tx: TxClient,
  input: CreateResourceInput,
): Promise<OperationOutcome> {
  await requireActiveTenant(tx, input.tenantId);
  const workspace = await firstRow(tx, SELECT_WORKSPACE, [
    input.tenantId,
    input.workspaceId,
  ]);
  if (workspace === undefined) {
    throw new EnterpriseError("WORKSPACE_NOT_FOUND", 409);
  }
  const existing = await firstRow(tx, SELECT_RESOURCE, [
    input.tenantId,
    input.resourceId,
  ]);
  if (existing !== undefined) {
    if (
      existing.workspace_id !== input.workspaceId ||
      existing.kind !== input.kind
    ) {
      throw new EnterpriseError("RESOURCE_CONFLICT", 409);
    }
    return {
      created: false,
      revision: existing.revision,
      aclEpoch: existing.acl_epoch,
    };
  }
  await tx.unsafe(INSERT_RESOURCE, [
    input.tenantId,
    input.resourceId,
    input.workspaceId,
    input.kind,
  ]);
  return { created: true, revision: 1, aclEpoch: 1 };
}

/** Grants `read` on one resource to one active member; `read` is the only action this grants. */
export async function grantRead(
  database: Database,
  input: GrantInput,
): Promise<OperationOutcome> {
  return runTenantOperation(database, GrantInputSchema.parse(input), {
    kind: "resource.granted",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      resourceId: i.resourceId,
      principalId: i.principalId,
      operator: i.operator,
    }),
    operatorPrincipalId: (i) => i.principalId,
    locks: async (tx, i) => {
      await lockShared(tx, lockKey("tenant", i.tenantId));
      await lockShared(tx, lockKey("principal", i.principalId));
      await lockShared(tx, lockKey("membership", i.tenantId, i.principalId));
      await lockExclusive(tx, lockKey("resource", i.tenantId, i.resourceId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
    },
    act: insertGrant,
  });
}

async function insertGrant(
  tx: TxClient,
  input: GrantInput,
): Promise<OperationOutcome> {
  const principal = await firstRow(tx, SELECT_PRINCIPAL, [input.principalId]);
  if (principal === undefined) {
    throw new EnterpriseError("PRINCIPAL_NOT_FOUND", 409);
  }
  if (principal.status !== "active") {
    throw new EnterpriseError("PRINCIPAL_SUSPENDED", 409);
  }
  const membership = await firstRow(tx, SELECT_MEMBERSHIP, [
    input.tenantId,
    input.principalId,
  ]);
  if (membership === undefined) {
    throw new EnterpriseError("MEMBERSHIP_NOT_FOUND", 409);
  }
  if (membership.status !== "active") {
    throw new EnterpriseError("MEMBER_NOT_ACTIVE", 409);
  }
  const resource = await firstRow(tx, SELECT_RESOURCE, [
    input.tenantId,
    input.resourceId,
  ]);
  if (resource === undefined) {
    throw new EnterpriseError("RESOURCE_NOT_FOUND", 409);
  }
  if (resource.status !== "active") {
    throw new EnterpriseError("RESOURCE_NOT_ACTIVE", 409);
  }

  const inserted = await tx.unsafe(INSERT_GRANT, [
    input.tenantId,
    input.resourceId,
    input.principalId,
  ]);
  if (inserted.length === 0) {
    /* The grant already existed: no change, no acl-epoch bump, still audited. */
    return { granted: false, aclEpoch: resource.acl_epoch };
  }
  const bumped = await tx.unsafe<{ acl_epoch: number }[]>(BUMP_ACL_EPOCH, [
    input.tenantId,
    input.resourceId,
  ]);
  return { granted: true, aclEpoch: bumped[0].acl_epoch };
}

/**
 * Test-injection pause point for the revocation race fixtures (plan 02 §6 T2-B step 6): called
 * after every advisory lock is taken and before the stored event is read, while the transaction —
 * and its resource exclusive lock — is held open. Nothing in production passes hooks; the CLI and
 * every other caller run the plain function, and no HTTP surface reaches this parameter.
 */
export type ProvisionHooks = {
  afterLocks?: () => Promise<void>;
};

/**
 * Revokes `read`. Unlike a grant, revocation tolerates a suspended member — taking access away is
 * never blocked by the state it is cleaning up. Deleting a grant that is already gone is an
 * auditable no-change, not an error.
 */
export async function revokeRead(
  database: Database,
  input: GrantInput,
  hooks: ProvisionHooks = {},
): Promise<OperationOutcome> {
  return runTenantOperation(database, GrantInputSchema.parse(input), {
    kind: "resource.revoked",
    digestPayload: (i) => ({
      tenantId: i.tenantId,
      resourceId: i.resourceId,
      principalId: i.principalId,
      operator: i.operator,
    }),
    locks: async (tx, i) => {
      await lockShared(tx, lockKey("tenant", i.tenantId));
      await lockShared(tx, lockKey("principal", i.principalId));
      await lockShared(tx, lockKey("membership", i.tenantId, i.principalId));
      await lockExclusive(tx, lockKey("resource", i.tenantId, i.resourceId));
      await lockExclusive(tx, lockKey("operation", i.tenantId, i.operationId));
      await hooks.afterLocks?.();
    },
    act: deleteGrant,
  });
}

async function deleteGrant(
  tx: TxClient,
  input: GrantInput,
): Promise<OperationOutcome> {
  const resource = await firstRow(tx, SELECT_RESOURCE, [
    input.tenantId,
    input.resourceId,
  ]);
  if (resource === undefined) {
    return { revoked: false };
  }
  const deleted = await tx.unsafe(DELETE_GRANT, [
    input.tenantId,
    input.resourceId,
    input.principalId,
  ]);
  if (deleted.length === 0) {
    return { revoked: false, aclEpoch: resource.acl_epoch };
  }
  const bumped = await tx.unsafe<{ acl_epoch: number }[]>(BUMP_ACL_EPOCH, [
    input.tenantId,
    input.resourceId,
  ]);
  return { revoked: true, aclEpoch: bumped[0].acl_epoch };
}

export type { TenantRole };
