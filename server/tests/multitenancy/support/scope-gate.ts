/**
 * MT005 (Issue #48) scope-gate fixture support.
 *
 * Extends the MT002 isolation fixture with the one fact MT002 deliberately
 * deferred to MT004: real `enterprise_workspace_memberships` rows. The MT002
 * fixture materialized "team membership" through per-team resource grants;
 * MT005's eligibility gate reads the MT004 table, so this fixture provisions
 * those rows through the real restricted operator role and adds the offline
 * admin write path (grant / suspend / remove) used to prove revocation
 * semantics. Suspend/remove run through the dedicated test setup connection
 * because the operator role has no DELETE policy on the table yet and the
 * UPDATE policy is pinned to `app.operator_principal_id`, which no production
 * write path sets for this table until a team-administration task lands —
 * the superuser bypass is the honest stand-in for that offline channel and is
 * disclosed in reports/MT005.md.
 *
 * Serialization discipline: every admin write takes the EXCLUSIVE advisory
 * lock `["enterprise","workspace-membership",tenant,workspace,principal]`
 * before its read-then-increase epoch bump, mirroring the lock the eligibility
 * gate takes SHARED — so gate transactions and admin revocations serialize
 * (acceptance 3's same-transaction guarantee), which the tests pin with an
 * explicit lock_timeout probe.
 */

import { like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { enterpriseWorkspaceMemberships } from "../../../src/db/schema";
import {
  type DataDatabase,
  type DirectoryDatabase,
  verifyDataDatabase,
  verifyDirectoryDatabase,
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

/** Stable `ids` keys of the fixture's teams. */
export type TeamKey = "team-a1" | "team-a2" | "team-b1";

/** The one advisory-lock key shared by the gate (shared) and admin writes (exclusive). */
export function workspaceMembershipLockKey(
  tenantId: string,
  workspaceId: string,
  principalId: string,
): string {
  return JSON.stringify([
    "enterprise",
    "workspace-membership",
    tenantId,
    workspaceId,
    principalId,
  ]);
}

export interface ScopeGateFixture {
  readonly isolation: IsolationFixture;
  readonly directory: DirectoryDatabase;
  readonly data: DataDatabase;
  readonly resolver: ScopeResolver;
  /** Builds a Request bound (server-side session seam) to a fixture identity. */
  requestFor(
    identity: FixtureIdentity,
    selectors: {
      tenantId?: string;
      workspaceId?: string;
      extraHeaders?: Record<string, string>;
    },
  ): Request;
  /** Resolves the (tenant, workspace, principal) triple behind one team fact. */
  teamOf(
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): { tenantId: string; workspaceId: string; principalId: string };
  /** Provisions (or re-activates, epoch+1) one team membership row. */
  grantTeamMembership(
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): Promise<{ epoch: number }>;
  /** Suspends one team membership under the exclusive lock (epoch+1). */
  suspendTeamMembership(
    identity: FixtureIdentity,
    teamKey: TeamKey,
    options?: { lockTimeoutMs?: number },
  ): Promise<{ epoch: number }>;
  /** Deletes one team membership row under the exclusive lock. */
  removeTeamMembership(
    identity: FixtureIdentity,
    teamKey: TeamKey,
    options?: { lockTimeoutMs?: number },
  ): Promise<void>;
  /**
   * Bumps one COMPANY membership's epoch while keeping it active — the
   * re-provision/renewal cycle. A scope issued before the bump must be
   * rejected as stale (SCOPE_REVOKED) even though the status never left
   * active. Offline administrative channel, same stand-in as the team
   * admin writes (disclosed in reports/MT005.md).
   */
  bumpCompanyMembershipEpoch(
    identity: FixtureIdentity,
    companyKey: string,
  ): Promise<{ epoch: number }>;
  dispose(): Promise<void>;
}

type Exec = (query: ReturnType<typeof sql>) => Promise<unknown>;

/**
 * Creates the MT005 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT002 fixture does.
 */
export async function createScopeGateFixture(): Promise<ScopeGateFixture> {
  // The MT002 fixture validates every URL (loopback, openbot_enterprise_*,
  // same instance) before opening any connection.
  const isolation = await createIsolationFixture("memberships");

  const directory = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    verifyDirectoryDatabase,
  );
  const data = await openVerified(
    enterpriseRuntimeDatabaseUrlFrom("data"),
    verifyDataDatabase,
  );
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  // Team-membership rows are provisioned by the MT002 fixture itself since
  // MT005 (see support/fixture.ts) — this wrapper adds no rows of its own.

  // ---- A second, direct request seam over the real resolver. ---------------
  const sessions = new WeakMap<Request, FixtureIdentity>();
  const resolver: ScopeResolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const identity = sessions.get(request);
      if (!identity) return null;
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.userId) return null;
      return { actorId: fact.userId, entrypoint: "web" };
    },
    // Ruling #1 (MT005): these headers select, they never authorize.
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

  /** Exclusive advisory lock, then (optionally lock_timeout-bounded) statement. */
  async function adminWrite(
    team: { tenantId: string; workspaceId: string; principalId: string },
    lockTimeoutMs: number | undefined,
    statement: (exec: Exec) => Promise<unknown>,
  ): Promise<unknown> {
    return setup.transaction(async (tx) => {
      if (lockTimeoutMs !== undefined) {
        await tx.execute(
          sql.raw(`set local lock_timeout = '${Math.max(0, lockTimeoutMs)}ms'`),
        );
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${workspaceMembershipLockKey(
          team.tenantId,
          team.workspaceId,
          team.principalId,
        )}, 0))`,
      );
      return statement(async (query) => tx.execute(query));
    });
  }

  const normalizeRows = (result: unknown): Record<string, unknown>[] => {
    const rows = Array.isArray(result)
      ? result
      : result &&
          typeof result === "object" &&
          Array.isArray((result as { rows?: unknown }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
    return rows.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object",
    );
  };

  let disposed = false;
  const fixture: ScopeGateFixture = {
    isolation,
    directory,
    data,
    resolver,

    requestFor(identity, selectors) {
      const headers: Record<string, string> = {
        ...(selectors.extraHeaders ?? {}),
      };
      if (selectors.tenantId !== undefined) {
        headers["x-openbot-tenant"] = selectors.tenantId;
      }
      if (selectors.workspaceId !== undefined) {
        headers["x-openbot-workspace"] = selectors.workspaceId;
      }
      const request = new Request("https://mt005-scope-gate.invalid/", {
        headers,
      });
      sessions.set(request, identity);
      return request;
    },

    teamOf,

    async grantTeamMembership(identity, teamKey) {
      const team = teamOf(identity, teamKey);
      const rows = normalizeRows(
        await adminWrite(team, undefined, (exec) =>
          exec(sql`
            insert into enterprise_workspace_memberships
              (tenant_id, workspace_id, principal_id)
            values (${team.tenantId}, ${team.workspaceId}, ${team.principalId})
            on conflict (tenant_id, workspace_id, principal_id)
            do update set status = 'active',
              epoch = enterprise_workspace_memberships.epoch + 1
            returning epoch
          `),
        ),
      );
      if (!rows[0]) throw new Error(`TEAM_GRANT_FAILED:${identity}:${teamKey}`);
      return { epoch: Number(rows[0].epoch) };
    },

    async suspendTeamMembership(identity, teamKey, options) {
      const team = teamOf(identity, teamKey);
      const rows = normalizeRows(
        await adminWrite(team, options?.lockTimeoutMs, (exec) =>
          exec(sql`
            update enterprise_workspace_memberships
            set status = 'suspended',
              epoch = (select coalesce(max(epoch), 0) + 1
                       from enterprise_workspace_memberships
                       where tenant_id = ${team.tenantId}
                         and workspace_id = ${team.workspaceId}
                         and principal_id = ${team.principalId})
            where tenant_id = ${team.tenantId}
              and workspace_id = ${team.workspaceId}
              and principal_id = ${team.principalId}
            returning epoch
          `),
        ),
      );
      if (!rows[0]) {
        throw new Error(`TEAM_SUSPEND_FAILED:${identity}:${teamKey}`);
      }
      return { epoch: Number(rows[0].epoch) };
    },

    async removeTeamMembership(identity, teamKey, options) {
      const team = teamOf(identity, teamKey);
      await adminWrite(team, options?.lockTimeoutMs, (exec) =>
        exec(sql`
          delete from enterprise_workspace_memberships
          where tenant_id = ${team.tenantId}
            and workspace_id = ${team.workspaceId}
            and principal_id = ${team.principalId}
        `),
      );
    },

    async bumpCompanyMembershipEpoch(identity, companyKey) {
      const fact = isolation.identities[identity];
      if (fact.kind !== "human" || !fact.principalId) {
        throw new Error(`FIXTURE_IDENTITY_NOT_BUMPABLE:${String(identity)}`);
      }
      const tenantId = isolation.ids[companyKey];
      const rows = normalizeRows(
        await setup.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
              "enterprise",
              "membership",
              tenantId,
              fact.principalId,
            ])}, 0))`,
          );
          return tx.execute(sql`
            update enterprise_memberships
            set epoch = epoch + 1
            where tenant_id = ${tenantId}
              and principal_id = ${fact.principalId}
            returning epoch
          `);
        }),
      );
      if (!rows[0]) {
        throw new Error(`COMPANY_BUMP_FAILED:${identity}:${companyKey}`);
      }
      return { epoch: Number(rows[0].epoch) };
    },

    async dispose() {
      if (disposed) return isolation.dispose();
      disposed = true;
      // Own added rows first (children), then the MT002 fixture's teardown.
      // Failure-isolated: one close throwing must not skip the remaining
      // pools or the isolation fixture's own teardown.
      const failures: unknown[] = [];
      await setup
        .delete(enterpriseWorkspaceMemberships)
        .where(
          like(
            enterpriseWorkspaceMemberships.tenantId,
            `${isolation.idPrefix}%`,
          ),
        )
        .catch((error) => failures.push(error));
      await setup.$client.close().catch((error) => failures.push(error));
      await directory.$client.close().catch((error) => failures.push(error));
      await data.$client.close().catch((error) => failures.push(error));
      try {
        await isolation.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "MT013 scope-gate fixture dispose failed");
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
