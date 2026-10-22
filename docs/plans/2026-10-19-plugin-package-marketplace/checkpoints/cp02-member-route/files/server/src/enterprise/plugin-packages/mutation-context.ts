import { and, eq, sql } from "drizzle-orm";
import { enterprisePackagePlans as planRows } from "../../db/schema/enterprise-plugin-packages";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import type { PlatformScope } from "../contracts";
import {
  assertOperatorDatabase,
  type OperatorDatabase,
} from "../tenancy/connections";
import { workspaceMembershipLockKey } from "../tenancy/scope-gate";
import { assertTrustedScope } from "../tenancy/store";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "../tenancy/workspace-admin";
import {
  markPackageWriteTx,
  type PackageMutationStore,
  type PackagePlanRecord,
  type PackageWriteTx,
  packageError,
} from "./contracts";

/**
 * PKG02 mutation seam. This is the only place a `PackageWriteTx` is issued.
 *
 * Each transaction:
 *   1. proves the trusted admin context and the trusted scope describe the
 *      same company, principal and actor;
 *   2. opens one operator transaction (read committed, 2 s lock / 5 s statement
 *      timeout, transaction-local `app.*` settings);
 *   3. takes exclusive advisory locks in the canonical order
 *      tenant → principal → membership → workspace-membership;
 *   4. revalidates `tenant_admin`, company status, principal status, member
 *      epoch, actor binding and team membership against live rows;
 *   5. hands the caller the branded write handle.
 *
 * A member revoked after the plan was issued fails step 4 even though the
 * caller still holds a stale scope/admin context — the check is inside the
 * same transaction that performs the write.
 */

type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

async function beginTransaction(tx: OperatorTransaction): Promise<void> {
  await tx.execute(sql`set transaction isolation level read committed`);
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

export function createPackageMutationStore(
  operator: OperatorDatabase,
): PackageMutationStore {
  assertOperatorDatabase(operator);

  const takeExclusiveLocks = async (
    tx: OperatorTransaction,
    keys: readonly string[],
  ): Promise<void> => {
    for (const key of keys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
  };

  /**
   * In-transaction revalidation. Reads the acting membership through the
   * operator policy that pins `app.operator_principal_id` (no cross-principal
   * enumeration) plus the team membership row.
   */
  const revalidate = async (
    tx: OperatorTransaction,
    scope: PlatformScope,
    admin: CompanyAdminContext,
  ): Promise<void> => {
    await tx.execute(
      sql`select set_config('app.operator_principal_id', ${admin.principalId}, true)`,
    );
    const [membership] = await tx
      .select({
        role: enterpriseMemberships.role,
        memberStatus: enterpriseMemberships.status,
        memberEpoch: enterpriseMemberships.epoch,
        principalStatus: enterprisePrincipals.status,
        tenantStatus: enterpriseTenants.status,
      })
      .from(enterpriseMemberships)
      .innerJoin(
        enterprisePrincipals,
        and(
          eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          sql`${enterprisePrincipals.id} = nullif(current_setting('app.operator_principal_id', true), '')`,
        ),
      )
      .innerJoin(
        enterpriseTenants,
        eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
      )
      .where(
        and(
          eq(enterpriseMemberships.tenantId, scope.tenantId),
          eq(enterpriseMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    if (
      membership?.role !== "tenant_admin" ||
      membership.memberStatus !== "active" ||
      membership.principalStatus !== "active" ||
      membership.tenantStatus !== "active" ||
      membership.memberEpoch !== scope.memberEpoch ||
      membership.memberEpoch !== admin.memberEpoch
    ) {
      throw packageError("TENANT_FORBIDDEN");
    }
    const [teamMembership] = await tx
      .select({ status: enterpriseWorkspaceMemberships.status })
      .from(enterpriseWorkspaceMemberships)
      .where(
        and(
          eq(enterpriseWorkspaceMemberships.tenantId, scope.tenantId),
          eq(enterpriseWorkspaceMemberships.workspaceId, scope.workspaceId),
          eq(enterpriseWorkspaceMemberships.principalId, scope.principalId),
        ),
      )
      .limit(1);
    if (teamMembership?.status !== "active") {
      throw packageError("TENANT_FORBIDDEN");
    }
  };

  return {
    async transaction(scope, admin, fn) {
      assertTrustedScope(scope);
      assertTrustedAdminContext(admin);
      if (
        admin.tenantId !== scope.tenantId ||
        admin.principalId !== scope.principalId ||
        admin.actorId !== scope.actorId
      ) {
        throw packageError("TENANT_FORBIDDEN");
      }
      if (admin.memberEpoch !== scope.memberEpoch) {
        throw packageError("TENANT_FORBIDDEN");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.operator_principal_id', ${admin.principalId}, true)`,
        );
        await takeExclusiveLocks(tx, [
          JSON.stringify(["enterprise", "tenant", scope.tenantId]),
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]);
        await revalidate(tx, scope, admin);
        const writeTx: PackageWriteTx = Object.freeze({ db: tx });
        markPackageWriteTx(writeTx);
        return fn(writeTx);
      });
    },

    async readPlan(scope, planId) {
      assertTrustedScope(scope);
      if (typeof planId !== "string" || !planId.trim()) return null;
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true)`,
        );
        const [row] = await tx
          .select({
            id: planRows.id,
            tenantId: planRows.tenantId,
            workspaceId: planRows.workspaceId,
            actorId: planRows.actorId,
            principalId: planRows.principalId,
            operation: planRows.operation,
            packageKey: planRows.packageKey,
            version: planRows.version,
            artifactDigest: planRows.artifactDigest,
            expectedRevision: planRows.expectedRevision,
            canonicalInput: planRows.canonicalInput,
            inputDigest: planRows.inputDigest,
            expiresAt: planRows.expiresAt,
            consumedAt: planRows.consumedAt,
            result: planRows.result,
          })
          .from(planRows)
          .where(
            and(
              eq(planRows.tenantId, scope.tenantId),
              eq(planRows.workspaceId, scope.workspaceId),
              eq(planRows.actorId, scope.actorId),
              eq(planRows.id, planId),
            ),
          )
          .limit(1);
        if (!row) return null;
        const parsed: PackagePlanRecord = {
          planId: row.id,
          tenantId: row.tenantId,
          workspaceId: row.workspaceId,
          actorId: row.actorId,
          principalId: row.principalId,
          operation: row.operation as PackagePlanRecord["operation"],
          packageKey: row.packageKey,
          version: row.version,
          artifactDigest: row.artifactDigest,
          expectedRevision: row.expectedRevision,
          canonicalInput: row.canonicalInput as Record<string, unknown>,
          inputDigest: row.inputDigest,
          expiresAt: row.expiresAt,
          consumedAt: row.consumedAt,
          result: row.result,
        };
        return parsed;
      });
    },
  };
}
