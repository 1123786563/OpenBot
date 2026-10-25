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

// ---------------------------------------------------------------------------
// T03.03（#540，P06）：平台入口的公司开通编排
// ---------------------------------------------------------------------------

import type {
  Directory,
  DirectoryResult,
} from "../../auth/directory/contracts";
import {
  activateProvisionedCompany,
  CompanyLifecycleRefusal,
  normalizeCompanySlug,
  preAllocateProvisionTenantId,
  preAllocateProvisionWorkspaceId,
} from "../../auth/directory/lifecycle";
import {
  isPrincipalRegistryRefusal,
  PRINCIPAL_REGISTRY_UNKNOWN_USER,
  type PrincipalRegistryRefusal,
} from "../../auth/directory/principal-registry";
import {
  PayerAccountConflictError,
  type PayerAccount,
} from "../../billing/payer";
import { bindProvisionedCompanyPayer } from "../../billing/payer-binding";
import type { Database } from "../../db/client";

/** The platform entry's shape: 接{name,slug,ownerUserId,defaultTeamName}+幂等头. */
export const PlatformCompanyProvisionInputSchema = z
  .object({
    actorUserId: Id,
    name: z.string().trim().min(1).max(256),
    slug: z.string().trim().min(1).max(256),
    ownerUserId: Id,
    defaultTeamName: z.string().trim().min(1).max(200),
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          value
            .split("")
            .every((character) => character >= " " && character !== "\u007f"),
        "idempotencyKey must be printable text; the receipt domain is what makes a replay safe",
      ),
  })
  .strict();
export type PlatformCompanyProvisionInput = z.infer<
  typeof PlatformCompanyProvisionInputSchema
>;

/** What one platform provision answers — never a payer key, never half benefits. */
export interface PlatformCompanyProvisionOutcome {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  /** `active` only when the external billing initialization is confirmed ready. */
  readonly status: "provisioning" | "active";
  /** The default team's stable workspace id, when a default team was provisioned. */
  readonly defaultWorkspaceId: string | null;
  readonly replayed: boolean;
  readonly commandId: string;
}

/**
 * The external billing boundary: the idempotent Customer/payer initialization
 * for one company, outside the directory command's transaction (plan Task 6
 * Steps 2–3 — a fault here is injected, classified and retried; real
 * provider acceptance is P24's). Must be idempotent by construction:
 * retries converge on the one mapping row.
 */
export interface CompanyBillingInitializationPort {
  initialize(tenantId: string): Promise<PayerAccount>;
}

export interface PlatformCompanyProvisionServiceDeps {
  /** The single-writer connection the directory command transaction runs on. */
  readonly database: Database;
  readonly directory: Directory;
  readonly billing: CompanyBillingInitializationPort;
}

export interface PlatformCompanyProvisionService {
  provision(
    input: PlatformCompanyProvisionInput,
  ): Promise<PlatformCompanyProvisionOutcome>;
}

export const PLATFORM_ADMIN_REQUIRED = "PLATFORM_ADMIN_REQUIRED";
export const COMPANY_PROVISION_OWNER_UNKNOWN =
  "COMPANY_PROVISION_OWNER_UNKNOWN";
export const COMPANY_PROVISION_SLUG_TAKEN = "COMPANY_PROVISION_SLUG_TAKEN";
export const COMPANY_PROVISION_PAYER_CONFLICT =
  "COMPANY_PROVISION_PAYER_CONFLICT";

/**
 * Drizzle wraps statement errors, so the unique violation rides the cause
 * chain, and postgres.js carries the constraint name inside the message
 * rather than as a SQLSTATE-paired field. The slug index's name is unique
 * enough to be the matcher: every other failure is a real fault, rethrown
 * untouched.
 */
function isSlugUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (
      String((current as Error).message).includes("auth_organization_slug_uq")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The closed-vocabulary input read the admin pre-check and the handler re-run share. */
async function readHoldsAdminRole(
  database: Database,
  userId: string,
): Promise<boolean> {
  const rows = await database.execute(
    sql`SELECT 1 AS ok FROM user_roles WHERE user_id = ${userId} AND role = 'admin' LIMIT 1`,
  );
  const list = Array.isArray(rows)
    ? (rows as Record<string, unknown>[])
    : ((rows as { rows?: Record<string, unknown>[] }).rows ?? []);
  return list.length > 0;
}

/**
 * The platform provisioning orchestrator: verify the actor, run the private
 * `company.provision` directory command (the atomic local half), then drive
 * the external billing initialization to ready and only then activate. A
 * billing failure is an outcome, never a rollback and never a half benefit:
 * the company stays `provisioning` with its outbox intent pending, and the
 * same idempotency key retries into the SAME company. The tenant id is the
 * server's deterministic pre-allocation from that key (interfaces §2), so
 * replays converge before any receipt is read.
 */
export function createPlatformCompanyProvisionService(
  deps: PlatformCompanyProvisionServiceDeps,
): PlatformCompanyProvisionService {
  if (!deps?.database) {
    throw new Error(
      "PLATFORM_PROVISION_DEPS_REQUIRED: createPlatformCompanyProvisionService needs the single-writer database the directory command runs on",
    );
  }
  if (typeof deps?.directory?.execute !== "function") {
    throw new Error(
      "PLATFORM_PROVISION_DEPS_REQUIRED: createPlatformCompanyProvisionService needs the Directory executor; without the command envelope there is no provision, and a permissive substitute is the bypass interfaces §3.3 forbids",
    );
  }
  if (typeof deps?.billing?.initialize !== "function") {
    throw new Error(
      "PLATFORM_PROVISION_DEPS_REQUIRED: createPlatformCompanyProvisionService needs the billing initialization port — a company cannot activate without it, and an optional port is the half-benefit hole",
    );
  }

  return {
    async provision(rawInput) {
      const input = PlatformCompanyProvisionInputSchema.parse(rawInput);
      // The actor gate before the command: the same CURRENT global admin role
      // the handler re-verifies inside the locked transaction. Fail fast,
      // before any receipt or advisory lock, with the named 403.
      if (!(await readHoldsAdminRole(deps.database, input.actorUserId))) {
        throw new CompanyLifecycleRefusal(
          PLATFORM_ADMIN_REQUIRED,
          `actor ${input.actorUserId} holds no current global admin role; platform provisioning is a platform action and company roles never substitute for it`,
          403,
        );
      }
      const slug = normalizeCompanySlug(input.slug);
      if (slug === "") {
        throw new CompanyLifecycleRefusal(
          "COMPANY_SLUG_INVALID",
          "the requested slug normalizes to nothing; interfaces §2's tenant-digest fallback is the M2 backfill's derivation, and a provision request names its slug explicitly",
          400,
        );
      }
      const tenantId = preAllocateProvisionTenantId(input.idempotencyKey);
      const workspaceId = preAllocateProvisionWorkspaceId(tenantId);
      const actor = Object.freeze({
        userId: input.actorUserId,
        principalId: null,
        sessionId: null,
        kind: "platform" as const,
        bindingId: null,
        provisioning: null,
      });
      let result: DirectoryResult;
      try {
        result = await deps.directory.execute(actor, {
          operation: "company.provision",
          tenantId,
          idempotencyKey: input.idempotencyKey,
          payload: {
            name: input.name,
            slug: input.slug,
            ownerUserId: input.ownerUserId,
            defaultTeamName: input.defaultTeamName,
          },
        });
      } catch (error) {
        if (
          isPrincipalRegistryRefusal(error) &&
          (error as PrincipalRegistryRefusal).code ===
            PRINCIPAL_REGISTRY_UNKNOWN_USER
        ) {
          // The SPECIFIED owner is verified and unknown: the command's atomic
          // rollback already removed every local row (the test pins the zero).
          throw new CompanyLifecycleRefusal(
            COMPANY_PROVISION_OWNER_UNKNOWN,
            `owner ${input.ownerUserId} does not exist; the command verifies the owner it was given and never falls back to another user`,
            404,
          );
        }
        if (isSlugUniqueViolation(error)) {
          // interfaces §2: the unique-slug conflict blocks and reports — no
          // silent re-slug, no mapping lost, and the transaction is gone.
          throw new CompanyLifecycleRefusal(
            COMPANY_PROVISION_SLUG_TAKEN,
            `slug "${slug}" already names another company; the conflict is reported, never re-derived`,
            409,
          );
        }
        throw error;
      }
      // The fixed payer and its external initialization: outside the command
      // transaction, idempotent, and a fault is classified, never swallowed.
      const binding = bindProvisionedCompanyPayer({ tenantId });
      let account: PayerAccount;
      try {
        account = await deps.billing.initialize(tenantId);
      } catch (error) {
        if (error instanceof PayerAccountConflictError) {
          // A mapping conflict is a DETERMINED refusal (plan Task 6 Step 5):
          // the company stays provisioning and no benefit opens.
          throw new CompanyLifecycleRefusal(
            COMPANY_PROVISION_PAYER_CONFLICT,
            "the company's payer key is already held by a different subject's mapping; the conflict is named and the company stays provisioning",
            409,
          );
        }
        // A transient boundary fault: the local company is durable and the
        // intent is pending — an outcome, not a failure of the provision.
        return {
          tenantId,
          name: input.name,
          slug,
          status: "provisioning",
          defaultWorkspaceId: workspaceId,
          replayed: result.replayed,
          commandId: result.commandId,
        };
      }
      // Only a mapping this binding can name activates the company; a
      // mismatch is activateProvisionedCompany's named refusal.
      await activateProvisionedCompany(deps.database, {
        tenantId,
        binding,
        payerAccount: account,
        actorUserId: input.actorUserId,
        commandId: result.commandId,
      });
      return {
        tenantId,
        name: input.name,
        slug,
        status: "active",
        defaultWorkspaceId: workspaceId,
        replayed: result.replayed,
        commandId: result.commandId,
      };
    },
  };
}
