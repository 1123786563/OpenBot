/**
 * MT009 (Issue #52) team-public action-rules fixture support.
 *
 * Builds on the MT002 isolation fixture (two companies, three teams, real
 * grant rows) exactly like the MT008 support does, and adds only what this
 * ticket's tests need:
 *
 *   - bot / knowledge-base resource rows inserted through the restricted
 *     operator role (the table's real INSERT policy: tenant context must
 *     match) — resource creation here is arrangement, and it stays
 *     policy-legal rather than superuser-bypassed;
 *   - visibility marking through the real operator UPDATE policy (the MT008
 *     migration's column-level grant);
 *   - resource-dependency rows inserted through the restricted operator role
 *     under the MT009 migration's INSERT policy — the same write surface a
 *     future dependency-management ticket would use;
 *   - trusted PlatformScope issuance through the REAL `createScopeResolver`;
 *
 * Two offline arrangement stand-ins run over the dedicated setup (superuser)
 * connection and are disclosed here and in the report, the same honest
 * stand-in MT005/MT008 used: flipping a team-membership status (the operator
 * role has no UPDATE policy for other principals' membership rows until a
 * team-administration write path lands) and setting a tenant's
 * policy_revision (the tenants table ships no UPDATE policy for restricted
 * roles at all — version selection is a provisioning-time fact in this
 * tree). The DECISION side never uses the stand-ins: every
 * decideAction()/decide() runs through the restricted data role under real
 * RLS, pinned by a current_user probe in the suite.
 */

import { and, eq, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { enterpriseResources } from "../../../src/db/schema";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../../src/enterprise/tenancy/connections";
import {
  createScopeResolver,
  type ScopeResolver,
} from "../../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import {
  createIsolationFixture,
  type FixtureIdentity,
  type IsolationFixture,
} from "./fixture";

/** Stable `ids` keys of the fixture's teams (same shape as MT008's support). */
export type TeamKey = "team-a1" | "team-a2" | "team-b1";

/** Resource kinds MT009's action rules distinguish. */
export type TeamResourceKind = "bot" | "knowledge_base" | "document";

/** Dependency kinds the MT009 migration's CHECK admits. */
export type DependencyKind = "model" | "credential" | "knowledge";

export interface TeamPublicRulesFixture {
  readonly isolation: IsolationFixture;
  readonly directory: DirectoryDatabase;
  readonly data: DataDatabase;
  readonly operator: OperatorDatabase;
  readonly resolver: ScopeResolver;
  /** Issues a real trusted scope for one identity in one (company, team). */
  scopeFor(
    identity: FixtureIdentity,
    selectors: { tenantId: string; workspaceId: string },
  ): Promise<PlatformScope>;
  /** Resolves the (tenant, workspace, principal) triple behind one team fact. */
  teamOf(
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): { tenantId: string; workspaceId: string; principalId: string };
  /** Inserts one resource row through the real operator INSERT policy. */
  createResource(input: {
    tenantId: string;
    workspaceId: string;
    kind: TeamResourceKind;
    displayName: string;
  }): Promise<string>;
  /** Marks one resource's visibility through the real operator UPDATE policy. */
  markVisibility(input: {
    tenantId: string;
    resourceId: string;
    visibility: "private" | "workspace" | null;
  }): Promise<void>;
  /** Inserts one dependency row through the real operator INSERT policy. */
  addDependency(input: {
    tenantId: string;
    resourceId: string;
    kind: DependencyKind;
    ref: string;
    status?: "active" | "invalid";
  }): Promise<void>;
  /** Inserts one explicit read grant through the real operator INSERT policy. */
  addReadGrant(input: {
    tenantId: string;
    resourceId: string;
    principalId: string;
  }): Promise<void>;
  /** Reads a resource row's status through the restricted data role. */
  resourceStatusOf(
    tenantId: string,
    resourceId: string,
  ): Promise<string | null>;
  /**
   * Offline arrangement stand-in (superuser, disclosed): soft-deletes one
   * resource (status='deleted', the domain's only delete form). The operator
   * role's column-level UPDATE covers visibility (MT008) only — there is no
   * policy-legal restricted-role path to flip status in this tree. The
   * DECISION side never uses it: run/read still flow through the restricted
   * data role under real RLS.
   */
  softDeleteResource(input: {
    tenantId: string;
    resourceId: string;
  }): Promise<void>;
  /**
   * Offline arrangement stand-in (superuser, disclosed): sets one tenant's
   * policy_revision. Tenants ship no restricted-role UPDATE policy — version
   * selection is provisioning-time in this tree.
   */
  setTenantPolicyRevision(
    tenantId: string,
    revision: "tenancy-v1" | "workspace-v1",
  ): Promise<void>;
  /**
   * Offline arrangement stand-in (superuser, disclosed): flips one team
   * membership to the requested status, bumping epoch like the MT005/MT008
   * support.
   */
  setTeamMembershipStatus(
    identity: FixtureIdentity,
    teamKey: TeamKey,
    status: "active" | "suspended",
  ): Promise<void>;
  /** Pins the connection identity the decision side really runs under. */
  dataCurrentUser(): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Creates the MT009 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT002/MT008 supports do.
 */
export async function createTeamPublicRulesFixture(): Promise<TeamPublicRulesFixture> {
  const isolation = await createIsolationFixture("bots");

  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    verifyDirectoryDatabase,
  );
  const data = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("data"),
    verifyDataDatabase,
  );
  const operator = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    verifyOperatorDatabase,
  );
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  const sessions = new WeakMap<Request, FixtureIdentity>();
  const resolver: ScopeResolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const identity = sessions.get(request);
      if (!identity) return null;
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) return null;
      return { actorId: fact.userId, entrypoint: "web" };
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });

  const teamOf = (
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): { tenantId: string; workspaceId: string; principalId: string } => {
    for (const company of isolation.identities[identity].companies) {
      const team = company.teams.find((entry) => entry.teamKey === teamKey);
      if (team) {
        return {
          tenantId: company.tenantId,
          workspaceId: team.workspaceId,
          principalId: company.principalId,
        };
      }
    }
    throw new Error(`TEAM_FACT_MISSING:${identity}:${teamKey}`);
  };

  let resourceCounter = 0;
  let disposed = false;
  const fixture: TeamPublicRulesFixture = {
    isolation,
    directory,
    data,
    operator,
    resolver,

    async scopeFor(identity, selectors) {
      const request = new Request("https://mt009-team-public.invalid/", {
        headers: {
          "x-openbot-tenant": selectors.tenantId,
          "x-openbot-workspace": selectors.workspaceId,
        },
      });
      sessions.set(request, identity);
      return resolver.resolve(request);
    },

    teamOf,

    async createResource({ tenantId, workspaceId, kind, displayName }) {
      // The operator role's INSERT policy on enterprise_resources requires
      // app.tenant_id to match the row — arrangement stays policy-legal.
      const resourceId = `${isolation.idPrefix}-res-${resourceCounter++}`;
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx
          .insert(enterpriseResources)
          .values({ tenantId, workspaceId, id: resourceId, kind, displayName });
      });
      return resourceId;
    },

    async markVisibility({ tenantId, resourceId, visibility }) {
      // Same policy-legal write path the MT008 support uses: the operator
      // UPDATE policy pins app.tenant_id AND app.resource_id to the row.
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.resource_id', ${resourceId}, true)`,
        );
        const rows = await tx
          .update(enterpriseResources)
          .set({ visibility })
          .where(
            and(
              eq(enterpriseResources.tenantId, tenantId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .returning({ id: enterpriseResources.id });
        if (rows.length !== 1) {
          throw new Error(
            `VISIBILITY_MARK_FAILED:${tenantId}:${resourceId}:${rows.length}`,
          );
        }
      });
    },

    async addDependency({ tenantId, resourceId, kind, ref, status }) {
      // The MT009 migration grants operator INSERT on the dependency table
      // (tenant-scoped policy) — the same surface a management write path
      // would use; no superuser bypass here either. Raw SQL because the
      // drizzle schema file is deliberately untouched by this ticket
      // (the table arrives through the MT009 migration task only).
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_resource_dependencies
            (tenant_id, resource_id, dependency_kind, dependency_ref, status)
          values (${tenantId}, ${resourceId}, ${kind}, ${ref}, ${status ?? "active"})
        `);
      });
    },

    async addReadGrant({ tenantId, resourceId, principalId }) {
      // The grants table's INSERT policy is tenant-scoped; the action column
      // is pinned to 'read' by the enterprise_grant_action CHECK — which is
      // exactly the fact acceptance 3 pins at the schema level.
      await operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_resource_grants
            (tenant_id, resource_id, principal_id, action)
          values (${tenantId}, ${resourceId}, ${principalId}, 'read')
        `);
      });
    },

    async resourceStatusOf(tenantId, resourceId) {
      const rows = await data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx
          .select({ status: enterpriseResources.status })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, tenantId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
      });
      return rows[0]?.status ?? null;
    },

    async softDeleteResource({ tenantId, resourceId }) {
      await setup.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.resource_id', ${resourceId}, true)`,
        );
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
      // Disclosed superuser stand-in: enterprise_tenants ships no UPDATE
      // policy for any restricted role; policy_revision is chosen at
      // provisioning time in this tree. Never used on the decision side.
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

    async setTeamMembershipStatus(identity, teamKey, status) {
      const team = teamOf(identity, teamKey);
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "workspace-membership",
            team.tenantId,
            team.workspaceId,
            team.principalId,
          ])}, 0))`,
        );
        const updated = (await tx.execute(sql`
          update enterprise_workspace_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_workspace_memberships
                     where tenant_id = ${team.tenantId}
                       and workspace_id = ${team.workspaceId}
                       and principal_id = ${team.principalId})
          where tenant_id = ${team.tenantId}
            and workspace_id = ${team.workspaceId}
            and principal_id = ${team.principalId}
          returning 1
        `)) as unknown;
        // Mirror softDeleteResource: 0 affected rows means the membership row is
        // gone, and downstream suspension refusals would pass for the wrong reason.
        const updatedRows = Array.isArray(updated)
          ? updated
          : ((updated as { rows?: unknown[] })?.rows ?? []);
        if (updatedRows.length !== 1) {
          throw new Error(
            `MEMBERSHIP_STATUS_FAILED:${team.tenantId}:${team.workspaceId}:${team.principalId}:${updatedRows.length}`,
          );
        }
      });
    },

    async dataCurrentUser() {
      const rows = (await data.execute(
        sql`select current_user as current_user`,
      )) as unknown as Record<string, unknown>[];
      const row = rows[0];
      // This probe pins the data connection's identity: a missing answer is a
      // probe failure, not an empty role to assert against.
      if (!row || typeof row.current_user !== "string") {
        throw new Error(
          `DATA_CURRENT_USER_PROBE_FAILED:${JSON.stringify(rows[0])}`,
        );
      }
      return row.current_user;
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Dependency rows cascade with their resource rows (MT009 FK ON DELETE
      // cascade) — nothing extra to clean beyond the isolation fixture.
      const failures: unknown[] = [];
      await setup.$client.close().catch((error) => failures.push(error));
      await operator.$client.close().catch((error) => failures.push(error));
      await data.$client.close().catch((error) => failures.push(error));
      await directory.$client.close().catch((error) => failures.push(error));
      try {
        await isolation.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "team-public-rules fixture dispose failed");
      }
    },
  };
  return fixture;
}

async function openVerified<T extends Database>(
  url: string,
  verify: (database: Database) => Promise<T>,
): Promise<T> {
  const candidate = createDatabase(url, { max: 1 });
  try {
    return await verify(candidate);
  } catch (error) {
    await candidate.$client.close();
    throw error;
  }
}
