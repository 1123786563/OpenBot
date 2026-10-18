/**
 * MT011 (Issue #54) not-found semantics fixture support.
 *
 * Builds on the MT008 resource-policy fixture (two companies, three teams,
 * grant-backed resources, visibility marking, real scope resolver) and adds
 * exactly the arrangements the centralized not-found semantics need:
 *
 *   - provisioning additional resources with explicit reader grants through
 *     the real restricted operator channel (`provisionDeployment`), one
 *     call per resource so `created_at` orders provisions deterministically
 *     (keyset cursors rely on that order);
 *   - soft-deleting a resource through the restricted operator channel's
 *     real UPDATE policy (same as the MT009 support's disclosed helper);
 *   - flipping tenant policy_revision on the dedicated setup (superuser)
 *     connection — a disclosed offline arrangement stand-in (MT009 precedent:
 *     tenants ship no restricted-role UPDATE policy); never used on any
 *     decision path;
 *   - a statement-counting DataDatabase proxy that is ITSELF verified by the
 *     real `verifyDataDatabase` before use, so frozen modules accept it like
 *     any other verified data channel. It counts SQL statements (tx.execute
 *     calls + select-chain starts) — the structural latency proxy for
 *     "denials must not produce a distinguishable signal": missing and
 *     forbidden must cost identical work.
 *
 * Nothing here mocks the authorization path: grants, visibility, RLS,
 * advisory locks and the policy registry all execute for real.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  verifyDataDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  type ProvisioningReceipt,
  provisionDeployment,
} from "../../../src/enterprise/tenancy/provision";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

export interface NotFoundSemanticsFixture {
  readonly base: ResourcePolicyFixture;
  /** Verified data channel whose SQL statements are counted. */
  readonly countedData: DataDatabase;
  /** Number of SQL statements observed on `countedData` since last reset. */
  statementCount(): number;
  resetStatementCount(): void;
  /** Provisions one extra resource with explicit readers; `created_at` order = call order. */
  provisionResource(input: {
    team: TeamKey;
    resourceId: string;
    kind: string;
    displayName: string;
    readerPrincipalIds: readonly string[];
  }): Promise<ProvisioningReceipt>;
  /** Marks visibility through the real operator UPDATE policy (MT008 helper). */
  markVisibility(input: {
    tenantId: string;
    resourceId: string;
    visibility: "private" | "workspace" | null;
  }): Promise<void>;
  /** Soft-deletes one resource through the restricted operator UPDATE policy. */
  softDeleteResource(input: {
    tenantId: string;
    resourceId: string;
  }): Promise<void>;
  /** Disclosed superuser stand-in: flips the tenant's policy_revision. */
  setTenantPolicyRevision(tenantId: string, revision: string): Promise<void>;
  /** Issues a real trusted scope through the MT008 resolver seam. */
  scopeFor(
    identity: Parameters<ResourcePolicyFixture["scopeFor"]>[0],
    selectors: { tenantId: string; workspaceId: string },
  ): Promise<PlatformScope>;
  dispose(): Promise<void>;
}

/**
 * Wraps a raw database so that SQL statement executions are counted, then the
 * wrapper ITSELF is verified by `verify` — the WeakSet brands the wrapper, so
 * frozen modules' `assertDataDatabase` accepts it exactly like a plain
 * verified channel. Only `execute` and `select`-chain starts are counted:
 * both map 1:1 to SQL statements; everything else is forwarded untouched.
 */
async function openCountingData(): Promise<{
  data: DataDatabase;
  statementCount(): number;
  resetStatementCount(): void;
}> {
  let count = 0;
  const raw = createDatabase(enterpriseRuntimeDatabaseUrlFrom("data"), {
    max: 1,
  });
  const countingTxOf = (tx: unknown): unknown =>
    new Proxy(tx as object, {
      get(txTarget, prop) {
        if (prop === "execute" || prop === "select") {
          return (...args: unknown[]) => {
            count += 1;
            const value = Reflect.get(txTarget, prop) as (
              ...a: unknown[]
            ) => unknown;
            return value.apply(txTarget, args);
          };
        }
        // Identity forwarding (see the Database-level note below).
        return Reflect.get(txTarget, prop);
      },
    });
  const counting = new Proxy(raw, {
    get(target, prop) {
      if (prop === "transaction") {
        // Method call on the target preserves drizzle's `this.session`.
        return (operation: (tx: never) => Promise<unknown>): Promise<unknown> =>
          target.transaction((tx: unknown) =>
            operation(countingTxOf(tx) as never),
          );
      }
      // Identity forwarding — never rebind: bound wrappers lose own
      // properties (e.g. $client.close) and drizzle internals read `this`.
      return Reflect.get(target, prop);
    },
  });
  const data = await verifyDataDatabase(counting as Database);
  return {
    data,
    statementCount: () => count,
    resetStatementCount: () => {
      count = 0;
    },
  };
}

export async function createNotFoundSemanticsFixture(): Promise<NotFoundSemanticsFixture> {
  const base = await createResourcePolicyFixture();
  const counted = await openCountingData();
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  let provisionedCount = 0;

  const fixture: NotFoundSemanticsFixture = {
    base,
    countedData: counted.data,
    statementCount: counted.statementCount,
    resetStatementCount: counted.resetStatementCount,

    async provisionResource({
      team,
      resourceId,
      kind,
      displayName,
      readerPrincipalIds,
    }) {
      const where = base.teamOf("a1-member", team);
      // Read existing tenant/workspace names from the database (provision is
      // idempotent on names and refuses drift — never copy names in fixtures).
      const rows = await base.isolation.queryRestricted(
        "operator",
        { tenantId: where.tenantId },
        "select t.name as tenant_name, w.name as workspace_name from enterprise_tenants t join enterprise_workspaces w on w.tenant_id = t.id and w.id = $2 where t.id = $1",
        [where.tenantId, where.workspaceId],
      );
      const fact = rows[0];
      if (!fact) {
        throw new Error(`PROVISION_TEAM_FACT_MISSING:${team}`);
      }
      // provisionDeployment requires every reader principal to appear in the
      // same call's member list: map principals back to their identity facts.
      const principalFacts = new Map<
        string,
        { userId: string; role: "member" | "tenant_admin" }
      >();
      for (const identityFact of Object.values(base.isolation.identities)) {
        for (const company of identityFact.companies) {
          if (company.tenantId !== where.tenantId) continue;
          if (identityFact.userId) {
            principalFacts.set(company.principalId, {
              userId: identityFact.userId,
              role: company.role === "tenant_admin" ? "tenant_admin" : "member",
            });
          }
        }
      }
      const members = [...new Set(readerPrincipalIds)].map((principalId) => {
        const known = principalFacts.get(principalId);
        if (!known) {
          throw new Error(`PROVISION_READER_IDENTITY_MISSING:${principalId}`);
        }
        return {
          principalId,
          userId: known.userId,
          role: known.role,
        };
      });
      provisionedCount += 1;
      const suffix = `-${provisionedCount}`;
      return provisionDeployment(base.operator, {
        operationId: `${resourceId}-provision${suffix}`,
        operator: where.principalId,
        tenant: { id: where.tenantId, name: String(fact.tenant_name) },
        workspace: {
          id: where.workspaceId,
          name: String(fact.workspace_name),
        },
        members,
        resources: [
          {
            id: resourceId,
            kind,
            displayName,
            readers: [...readerPrincipalIds],
          },
        ],
      });
    },

    async markVisibility(input) {
      await base.markVisibility(input);
    },

    async softDeleteResource({ tenantId, resourceId }) {
      // Offline arrangement stand-in (superuser, disclosed; MT009 support
      // precedent): the operator role's column-level UPDATE covers visibility
      // (MT008) only — there is no policy-legal restricted-role path to flip
      // status in this tree. The DECISION side never uses it.
      await setup.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        const updated = await tx.execute(sql`
          update enterprise_resources set status = 'deleted'
          where tenant_id = ${tenantId} and id = ${resourceId}
        `);
        const changed = Number(
          (updated as unknown as { count?: number }).count ?? 0,
        );
        if (changed !== 1) {
          throw new Error(
            `RESOURCE_SOFT_DELETE_FAILED:${tenantId}:${resourceId}:${changed}`,
          );
        }
      });
    },

    async setTenantPolicyRevision(tenantId, revision) {
      // Disclosed superuser stand-in (MT009 support precedent):
      // enterprise_tenants ships no UPDATE policy for restricted roles;
      // policy_revision is a provisioning-time choice in this tree. The
      // decision side never uses this helper.
      await setup.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        const updated = await tx.execute(sql`
          update enterprise_tenants
          set policy_revision = ${revision}
          where id = ${tenantId}
        `);
        const changed = Number(
          (updated as unknown as { count?: number }).count ?? 0,
        );
        if (changed !== 1) {
          throw new Error(
            `TENANT_POLICY_REVISION_FAILED:${tenantId}:${revision}:${changed}`,
          );
        }
      });
    },

    async scopeFor(identity, selectors) {
      return base.scopeFor(identity, selectors);
    },

    async dispose() {
      await setup.$client.close().catch(() => {});
      await counted.data.$client.close().catch(() => {});
      await base.dispose();
    },
  };
  return fixture;
}
