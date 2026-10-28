/**
 * MT008 (Issue #51) resource-policy fixture support.
 *
 * Builds on the MT002 isolation fixture (two companies, three teams, four
 * resources with real grant rows) and the MT005 resolver seam. This wrapper
 * adds exactly the arrangements MT008's tests need and nothing else:
 *
 *   - trusted PlatformScope issuance through the REAL `createScopeResolver`
 *     (ruling #1 headers select, server rows authorize);
 *   - visibility marking through the restricted operator role honoring the
 *     table's real UPDATE policy (`app.tenant_id` + `app.resource_id`),
 *     which is exactly the write path the MT008 migration granted;
 *   - one offline arrangement stand-in, disclosed here and in the report:
 *     suspending a team membership for the suspended-member case runs over
 *     the dedicated setup (superuser) connection because the operator role
 *     has no UPDATE policy for other principals on
 *     `enterprise_workspace_memberships` until a team-administration write
 *     path lands — the same honest stand-in MT005 used (reports/MT005.md D4).
 *     The DECISION side never uses it: every decide() runs through the
 *     restricted data role under real RLS.
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

/** Stable `ids` keys of the fixture's teams (same shape as MT005's support). */
export type TeamKey = "team-a1" | "team-a2" | "team-b1";

export interface ResourcePolicyFixture {
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
  /** Marks one resource's visibility through the real operator UPDATE policy. */
  markVisibility(input: {
    tenantId: string;
    resourceId: string;
    visibility: "private" | "workspace" | null;
  }): Promise<void>;
  /** Reads one resource's current visibility through the restricted data role. */
  visibilityOf(tenantId: string, resourceId: string): Promise<string | null>;
  /**
   * Offline arrangement stand-in (superuser, disclosed): flips one team
   * membership to the requested status, bumping epoch like the MT005 support.
   */
  setTeamMembershipStatus(
    identity: FixtureIdentity,
    teamKey: TeamKey,
    status: "active" | "suspended",
  ): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Creates the MT008 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT002 fixture does.
 */
export async function createResourcePolicyFixture(): Promise<ResourcePolicyFixture> {
  const isolation = await createIsolationFixture("resource-policy");

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

  let disposed = false;
  const fixture: ResourcePolicyFixture = {
    isolation,
    directory,
    data,
    operator,
    resolver,

    async scopeFor(identity, selectors) {
      const request = new Request("https://mt008-resource-policy.invalid/", {
        headers: {
          "x-openbot-tenant": selectors.tenantId,
          "x-openbot-workspace": selectors.workspaceId,
        },
      });
      sessions.set(request, identity);
      return resolver.resolve(request);
    },

    teamOf,

    async markVisibility({ tenantId, resourceId, visibility }) {
      // The operator role's UPDATE policy on enterprise_resources requires
      // app.tenant_id AND app.resource_id to match the row — honoring it is
      // the point: MT008's visibility writes must be policy-legal, not
      // superuser bypasses.
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

    async visibilityOf(tenantId, resourceId) {
      const rows = await data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx
          .select({ visibility: enterpriseResources.visibility })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, tenantId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
      });
      return rows[0]?.visibility ?? null;
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
        // Mirror markVisibility: 0 affected rows means the fixture row is not
        // there, so dependent cases must not pass on data that never changed.
        const rows = Array.isArray(updated)
          ? updated
          : ((updated as { rows?: unknown[] })?.rows ?? []);
        if (rows.length !== 1) {
          throw new Error(
            `MEMBERSHIP_STATUS_FAILED:${team.tenantId}:${team.workspaceId}:${team.principalId}:${rows.length}`,
          );
        }
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await setup.$client.close().catch(() => {});
      await operator.$client.close().catch(() => {});
      await data.$client.close().catch(() => {});
      await directory.$client.close().catch(() => {});
      await isolation.dispose();
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
