import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";

const Id = z.string().trim().min(1).max(128);
const role = z.enum(["tenant_admin", "member", "auditor"]);
export const ProvisionDeploymentInputSchema = z
  .object({
    operationId: Id,
    operator: Id,
    tenant: z
      .object({ id: Id, name: z.string().trim().min(1).max(256) })
      .strict(),
    workspace: z
      .object({ id: Id, name: z.string().trim().min(1).max(256) })
      .strict(),
    members: z
      .array(z.object({ principalId: Id, userId: Id, role }).strict())
      .min(1),
    resources: z
      .array(
        z
          .object({
            id: Id,
            kind: z.string().trim().min(1).max(64),
            displayName: z.string().trim().min(1).max(256),
            readers: z.array(Id),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ProvisionDeploymentInput = z.infer<
  typeof ProvisionDeploymentInputSchema
>;

export interface ProvisioningReceipt {
  readonly operationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly memberCount: number;
  readonly resourceCount: number;
}

/**
 * Offline-only initial provisioning. The caller must provide a database connected as the
 * separately managed tenant operator; this API is never wired into request handling. Principals
 * must already be bound to users by the separate identity provisioning path.
 */
export async function provisionDeployment(
  database: OperatorDatabase,
  input: ProvisionDeploymentInput,
): Promise<ProvisioningReceipt> {
  assertOperatorDatabase(database);
  const value = ProvisionDeploymentInputSchema.parse(input);
  const digest = new Bun.CryptoHasher("sha256");
  digest.update(stableJson(value));
  const payloadDigest = digest.digest("hex");
  return database.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${value.tenant.id}, true), set_config('app.operator_principal_id', ${value.operator}, true), set_config('app.operation_id', ${value.operationId}, true)`,
    );
    for (const key of provisioningLockKeys(value)) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
    const [prior] = await tx
      .select({
        eventType: enterpriseSecurityEvents.eventType,
        details: enterpriseSecurityEvents.details,
      })
      .from(enterpriseSecurityEvents)
      .where(
        and(
          eq(enterpriseSecurityEvents.tenantId, value.tenant.id),
          eq(enterpriseSecurityEvents.id, value.operationId),
        ),
      )
      .limit(1);
    if (prior) {
      if (
        prior.eventType !== "deployment.provisioned" ||
        prior.details.payload_sha256 !== payloadDigest
      ) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return {
        operationId: value.operationId,
        tenantId: value.tenant.id,
        workspaceId: value.workspace.id,
        memberCount: value.members.length,
        resourceCount: value.resources.length,
      };
    }
    const [tenant] = await tx
      .insert(enterpriseTenants)
      .values({ id: value.tenant.id, name: value.tenant.name })
      .onConflictDoNothing()
      .returning({ id: enterpriseTenants.id });
    if (!tenant) {
      const [existing] = await tx
        .select({
          name: enterpriseTenants.name,
          status: enterpriseTenants.status,
        })
        .from(enterpriseTenants)
        .where(eq(enterpriseTenants.id, value.tenant.id))
        .limit(1);
      if (
        !existing ||
        existing.name !== value.tenant.name ||
        existing.status !== "active"
      ) {
        throw new Error("TENANT_PROVISIONING_CONFLICT");
      }
    }

    await tx
      .insert(enterpriseWorkspaces)
      .values({
        tenantId: value.tenant.id,
        id: value.workspace.id,
        name: value.workspace.name,
      })
      .onConflictDoNothing();
    const [workspace] = await tx
      .select({ name: enterpriseWorkspaces.name })
      .from(enterpriseWorkspaces)
      .where(
        and(
          eq(enterpriseWorkspaces.tenantId, value.tenant.id),
          eq(enterpriseWorkspaces.id, value.workspace.id),
        ),
      )
      .limit(1);
    if (!workspace || workspace.name !== value.workspace.name) {
      throw new Error("WORKSPACE_PROVISIONING_CONFLICT");
    }

    const principalIds = new Set<string>();
    for (const member of value.members) {
      await tx.execute(
        sql`select set_config('app.user_id', ${member.userId}, true), set_config('app.operator_principal_id', ${member.principalId}, true)`,
      );
      if (principalIds.has(member.principalId)) {
        throw new Error("DUPLICATE_PROVISIONED_PRINCIPAL");
      }
      principalIds.add(member.principalId);
      const [principal] = await tx
        .select({
          userId: enterprisePrincipals.userId,
          status: enterprisePrincipals.status,
        })
        .from(enterprisePrincipals)
        .where(eq(enterprisePrincipals.id, member.principalId))
        .limit(1);
      if (
        !principal ||
        principal.userId !== member.userId ||
        principal.status !== "active"
      ) {
        throw new Error("PRINCIPAL_BINDING_REQUIRED");
      }
      await tx
        .insert(enterpriseMemberships)
        .values({
          tenantId: value.tenant.id,
          principalId: member.principalId,
          role: member.role,
        })
        .onConflictDoNothing();
      const [membership] = await tx
        .select({
          role: enterpriseMemberships.role,
          status: enterpriseMemberships.status,
        })
        .from(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, value.tenant.id),
            eq(enterpriseMemberships.principalId, member.principalId),
          ),
        )
        .limit(1);
      if (
        !membership ||
        membership.role !== member.role ||
        membership.status !== "active"
      ) {
        throw new Error("MEMBERSHIP_PROVISIONING_CONFLICT");
      }
    }

    const resourceIds = new Set<string>();
    for (const resource of value.resources) {
      if (resourceIds.has(resource.id))
        throw new Error("DUPLICATE_PROVISIONED_RESOURCE");
      resourceIds.add(resource.id);
      await tx
        .insert(enterpriseResources)
        .values({
          tenantId: value.tenant.id,
          id: resource.id,
          workspaceId: value.workspace.id,
          kind: resource.kind,
          displayName: resource.displayName,
        })
        .onConflictDoNothing();
      const [existing] = await tx
        .select({
          workspaceId: enterpriseResources.workspaceId,
          kind: enterpriseResources.kind,
          displayName: enterpriseResources.displayName,
          status: enterpriseResources.status,
        })
        .from(enterpriseResources)
        .where(
          and(
            eq(enterpriseResources.tenantId, value.tenant.id),
            eq(enterpriseResources.id, resource.id),
          ),
        )
        .limit(1);
      if (
        !existing ||
        existing.workspaceId !== value.workspace.id ||
        existing.kind !== resource.kind ||
        existing.displayName !== resource.displayName ||
        existing.status !== "active"
      ) {
        throw new Error("RESOURCE_PROVISIONING_CONFLICT");
      }
      for (const principalId of new Set(resource.readers)) {
        if (!principalIds.has(principalId)) {
          throw new Error("RESOURCE_READER_NOT_PROVISIONED");
        }
        await tx
          .insert(enterpriseResourceGrants)
          .values({
            tenantId: value.tenant.id,
            resourceId: resource.id,
            principalId,
            action: "read",
          })
          .onConflictDoNothing();
      }
    }

    const [event] = await tx
      .insert(enterpriseSecurityEvents)
      .values({
        tenantId: value.tenant.id,
        id: value.operationId,
        operationId: value.operationId,
        actorId: value.operator,
        eventType: "deployment.provisioned",
        details: { payload_sha256: payloadDigest },
      })
      .onConflictDoNothing()
      .returning({ id: enterpriseSecurityEvents.id });
    if (!event) throw new Error("IDEMPOTENCY_CONFLICT");
    return {
      operationId: value.operationId,
      tenantId: value.tenant.id,
      workspaceId: value.workspace.id,
      memberCount: value.members.length,
      resourceCount: value.resources.length,
    };
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function provisioningLockKeys(value: ProvisionDeploymentInput): string[] {
  const key = (kind: string, ...ids: string[]) =>
    JSON.stringify(["enterprise", kind, ...ids]);
  const principals = [
    ...new Set(value.members.map((member) => member.principalId)),
  ].sort();
  const resources = [
    ...new Set(value.resources.map((resource) => resource.id)),
  ].sort();
  return [
    key("tenant", value.tenant.id),
    ...principals.map((principalId) => key("principal", principalId)),
    ...principals.map((principalId) =>
      key("membership", value.tenant.id, principalId),
    ),
    ...resources.map((resourceId) =>
      key("resource", value.tenant.id, resourceId),
    ),
    key("operation", value.tenant.id, value.operationId),
  ];
}

export const SuspendMembershipInputSchema = z
  .object({
    operationId: Id,
    operator: Id,
    tenantId: Id,
    principalId: Id,
  })
  .strict();
export type SuspendMembershipInput = z.infer<
  typeof SuspendMembershipInputSchema
>;

/** Offline membership revocation; the incremented epoch invalidates already issued scopes. */
export async function suspendMembership(
  database: OperatorDatabase,
  input: SuspendMembershipInput,
): Promise<{ readonly changed: boolean; readonly epoch: number }> {
  assertOperatorDatabase(database);
  const value = SuspendMembershipInputSchema.parse(input);
  const kind = "membership.suspended";
  const digest = new Bun.CryptoHasher("sha256");
  digest.update(stableJson({ kind, ...value }));
  const payloadDigest = digest.digest("hex");
  return database.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${value.tenantId}, true), set_config('app.operator_principal_id', ${value.principalId}, true), set_config('app.operation_id', ${value.operationId}, true)`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${JSON.stringify(["enterprise", "tenant", value.tenantId])}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${JSON.stringify(["enterprise", "principal", value.principalId])}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["enterprise", "membership", value.tenantId, value.principalId])}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["enterprise", "operation", value.tenantId, value.operationId])}, 0))`,
    );

    const [prior] = await tx
      .select({
        eventType: enterpriseSecurityEvents.eventType,
        details: enterpriseSecurityEvents.details,
      })
      .from(enterpriseSecurityEvents)
      .where(
        and(
          eq(enterpriseSecurityEvents.tenantId, value.tenantId),
          eq(enterpriseSecurityEvents.id, value.operationId),
        ),
      )
      .limit(1);
    if (prior) {
      if (
        prior.eventType !== kind ||
        prior.details.payload_sha256 !== payloadDigest
      ) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      const { changed, epoch } = prior.details;
      if (
        typeof changed !== "boolean" ||
        typeof epoch !== "number" ||
        !Number.isSafeInteger(epoch) ||
        epoch <= 0
      ) {
        throw new Error("IDEMPOTENCY_RESULT_INVALID");
      }
      return { changed, epoch };
    }

    const [membership] = await tx
      .select({
        epoch: enterpriseMemberships.epoch,
        status: enterpriseMemberships.status,
      })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, value.tenantId),
          eq(enterpriseMemberships.principalId, value.principalId),
        ),
      )
      .limit(1);
    if (!membership) throw new Error("MEMBERSHIP_NOT_FOUND");
    let epoch = membership.epoch;
    const changed = membership.status === "active";
    if (changed) {
      const [updated] = await tx
        .update(enterpriseMemberships)
        .set({
          status: "suspended",
          epoch: sql`${enterpriseMemberships.epoch} + 1`,
        })
        .where(
          and(
            eq(enterpriseMemberships.tenantId, value.tenantId),
            eq(enterpriseMemberships.principalId, value.principalId),
            eq(enterpriseMemberships.status, "active"),
          ),
        )
        .returning({ epoch: enterpriseMemberships.epoch });
      if (!updated) throw new Error("MEMBERSHIP_STATE_CHANGED");
      epoch = updated.epoch;
    }
    await tx.insert(enterpriseSecurityEvents).values({
      tenantId: value.tenantId,
      id: value.operationId,
      operationId: value.operationId,
      actorId: value.operator,
      eventType: kind,
      details: {
        payload_sha256: payloadDigest,
        principalId: value.principalId,
        changed,
        epoch,
      },
    });
    return { changed, epoch };
  });
}

export const RevokeResourceReadInputSchema = z
  .object({
    operationId: Id,
    operator: Id,
    tenantId: Id,
    resourceId: Id,
    principalId: Id,
  })
  .strict();
export type RevokeResourceReadInput = z.infer<
  typeof RevokeResourceReadInputSchema
>;

/** Offline ACL revocation, serialized with authorized reads and reflected in acl_epoch. */
export async function revokeResourceRead(
  database: OperatorDatabase,
  input: RevokeResourceReadInput,
): Promise<{ readonly changed: boolean; readonly aclEpoch: number }> {
  assertOperatorDatabase(database);
  const value = RevokeResourceReadInputSchema.parse(input);
  const kind = "resource.read_revoked";
  const payloadDigest = new Bun.CryptoHasher("sha256");
  payloadDigest.update(stableJson({ kind, ...value }));
  const digest = payloadDigest.digest("hex");
  return database.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.tenant_id', ${value.tenantId}, true), set_config('app.operator_principal_id', ${value.principalId}, true), set_config('app.operation_id', ${value.operationId}, true), set_config('app.resource_id', ${value.resourceId}, true)`,
    );
    const lockKey = (kindName: string, ...ids: string[]) =>
      JSON.stringify(["enterprise", kindName, ...ids]);
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey("tenant", value.tenantId)}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey("principal", value.principalId)}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey("membership", value.tenantId, value.principalId)}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey("resource", value.tenantId, value.resourceId)}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey("operation", value.tenantId, value.operationId)}, 0))`,
    );

    const [prior] = await tx
      .select({
        eventType: enterpriseSecurityEvents.eventType,
        details: enterpriseSecurityEvents.details,
      })
      .from(enterpriseSecurityEvents)
      .where(
        and(
          eq(enterpriseSecurityEvents.tenantId, value.tenantId),
          eq(enterpriseSecurityEvents.id, value.operationId),
        ),
      )
      .limit(1);
    if (prior) {
      if (prior.eventType !== kind || prior.details.payload_sha256 !== digest) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      const { changed, acl_epoch: aclEpoch } = prior.details;
      if (
        typeof changed !== "boolean" ||
        typeof aclEpoch !== "number" ||
        !Number.isSafeInteger(aclEpoch) ||
        aclEpoch <= 0
      ) {
        throw new Error("IDEMPOTENCY_RESULT_INVALID");
      }
      return {
        changed,
        aclEpoch,
      };
    }

    const [resource] = await tx
      .select({
        aclEpoch: enterpriseResources.aclEpoch,
        status: enterpriseResources.status,
      })
      .from(enterpriseResources)
      .where(
        and(
          eq(enterpriseResources.tenantId, value.tenantId),
          eq(enterpriseResources.id, value.resourceId),
        ),
      )
      .limit(1);
    if (resource?.status !== "active") throw new Error("RESOURCE_NOT_FOUND");
    const deleted = await tx
      .delete(enterpriseResourceGrants)
      .where(
        and(
          eq(enterpriseResourceGrants.tenantId, value.tenantId),
          eq(enterpriseResourceGrants.resourceId, value.resourceId),
          eq(enterpriseResourceGrants.principalId, value.principalId),
          eq(enterpriseResourceGrants.action, "read"),
        ),
      )
      .returning({ principalId: enterpriseResourceGrants.principalId });
    let aclEpoch = resource.aclEpoch;
    if (deleted.length > 0) {
      const [updated] = await tx
        .update(enterpriseResources)
        .set({ aclEpoch: sql`${enterpriseResources.aclEpoch} + 1` })
        .where(
          and(
            eq(enterpriseResources.tenantId, value.tenantId),
            eq(enterpriseResources.id, value.resourceId),
          ),
        )
        .returning({ aclEpoch: enterpriseResources.aclEpoch });
      if (!updated) throw new Error("RESOURCE_STATE_CHANGED");
      aclEpoch = updated.aclEpoch;
    }
    await tx.insert(enterpriseSecurityEvents).values({
      tenantId: value.tenantId,
      id: value.operationId,
      operationId: value.operationId,
      actorId: value.operator,
      eventType: kind,
      details: {
        payload_sha256: digest,
        principalId: value.principalId,
        acl_epoch: aclEpoch,
        changed: deleted.length > 0,
      },
    });
    return { changed: deleted.length > 0, aclEpoch };
  });
}
