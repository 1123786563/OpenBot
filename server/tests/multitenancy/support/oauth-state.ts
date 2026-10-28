/**
 * MT028 (Issue #71) oauth-state fixture support.
 *
 * Builds on the MT008 resource-policy fixture (two companies, three teams,
 * real provisioning, real restricted roles, trusted-scope issuance). This
 * wrapper adds exactly what MT028's tests need and nothing else:
 *
 *   - the REAL MT028 OAuth state service riding the verified restricted
 *     operator channel (no test double issues or consumes a state);
 *   - a dedicated setup (superuser) connection used ONLY for arrangement
 *     stand-ins, catalog assertions and row read-backs: the state table is
 *     readable through the state arm alone (no company enumeration — the
 *     MT026 intent fence), so assertions that must see rows go through the
 *     superuser and are disclosed here and in the report. No business
 *     decision ever runs through it;
 *   - a security-event reader through the RESTRICTED operator role under the
 *     table's real RLS (tenant + operation pin) — event assertions observe
 *     exactly what an operator could see;
 *   - a canary leak-scan helper for the zero-token-plaintext acceptance.
 *
 * Nothing here mocks the state path: states are initiated, consumed, rejected
 * and failed against real rows under the restricted `ob_ent_operator` role
 * with real RLS and real security events.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { verifyOperatorDatabase } from "../../../src/enterprise/tenancy/connections";
import type { OAuthStateService } from "../../../src/enterprise/tenancy/oauth-state";
import { createOAuthStateService } from "../../../src/enterprise/tenancy/oauth-state";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

export type OAuthCompanyKey = "company-a" | "company-b";

export interface OAuthStateRowFact {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly purpose: string;
  readonly target: string;
  readonly status: string;
  readonly failedReason: string | null;
}

export interface OAuthStateFixture {
  readonly base: ResourcePolicyFixture;
  /** The real MT028 service over the verified restricted operator channel. */
  readonly service: OAuthStateService;
  /**
   * An identical service on a SECOND operator connection: the concurrent
   * double-consume test needs two pools, or the pool serializes the pair and
   * the overlap the atomic arm exists for never happens.
   */
  readonly serviceB: OAuthStateService;
  /** Issues a real trusted scope for one identity in one (company, team). */
  scopeOf(
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): Promise<Parameters<OAuthStateService["initiate"]>[0]>;
  /** Tenant id behind one fixture company key. */
  tenantOf(companyKey: OAuthCompanyKey): string;
  /** Team fact (tenant + workspace + principal) behind one identity/team. */
  teamOf(
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): { tenantId: string; workspaceId: string; principalId: string };
  /** Full row read-back via the disclosed superuser (state arm hides rows from even the operator). */
  stateRow(state: string): Promise<OAuthStateRowFact | null>;
  /** Row count via the disclosed superuser (verification aid, never the business path). */
  stateRowCount(): Promise<number>;
  /**
   * Security events read through the RESTRICTED operator role under the
   * table's real RLS (tenant + operation pin) — the only channel the events
   * are observable through in production.
   */
  securityEvents(input: {
    readonly tenantId: string;
    readonly eventId: string;
  }): Promise<
    readonly {
      eventType: string;
      actorId: string;
      details: Record<string, unknown>;
    }[]
  >;
  /** Arrangement stand-in (superuser, disclosed): flips one company membership status. */
  setCompanyMembershipStatus(
    identity: FixtureIdentity,
    companyKey: OAuthCompanyKey,
    status: "active" | "suspended",
  ): Promise<void>;
  /** Arrangement stand-in (superuser, disclosed): flips one team membership status. */
  setTeamMembershipStatus(
    identity: FixtureIdentity,
    teamKey: TeamKey,
    status: "active" | "suspended",
  ): Promise<void>;
  /** Catalog facts via the dedicated superuser connection (read-only assertions). */
  catalog: {
    rlsFlags(
      table: string,
    ): Promise<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    hasPrivilege(
      table: string,
      role: "ob_ent_directory" | "ob_ent_data" | "ob_ent_operator",
      privilege: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
    ): Promise<boolean>;
  };
  dispose(): Promise<void>;
}

/**
 * Creates the MT028 fixture. URLs are resolved up front and refused (never a
 * development-database fallback) exactly like the MT027 fixture does.
 */
export async function createOAuthStateFixture(): Promise<OAuthStateFixture> {
  const base = await createResourcePolicyFixture();
  // Dedicated setup (superuser) connection for arrangement stand-ins, catalog
  // assertions and row read-backs — never used for business reads or writes.
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });
  const service = createOAuthStateService(base.operator);
  const operatorB = await verifyOperatorDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator"), { max: 1 }),
  );
  const serviceB = createOAuthStateService(operatorB);

  const teamOf = (
    identity: FixtureIdentity,
    teamKey: TeamKey,
  ): { tenantId: string; workspaceId: string; principalId: string } =>
    base.teamOf(identity, teamKey);

  /** Principal id behind one fixture identity in one company (membership scan). */
  const principalOf = (
    identity: FixtureIdentity,
    companyKey: OAuthCompanyKey,
  ): string => {
    const tenantId = (base.isolation.ids as Record<string, string>)[companyKey];
    const membership = base.isolation.identities[identity].companies.find(
      (entry) => entry.tenantId === tenantId,
    );
    if (!membership)
      throw new Error(`PRINCIPAL_MISSING:${identity}:${companyKey}`);
    return membership.principalId;
  };

  return {
    base,
    service,
    serviceB,
    async scopeOf(identity, teamKey) {
      const fact = teamOf(identity, teamKey);
      return base.scopeFor(identity, {
        tenantId: fact.tenantId,
        workspaceId: fact.workspaceId,
      });
    },
    tenantOf(companyKey) {
      const ids = base.isolation.ids as Record<string, string>;
      const tenantId = ids[companyKey];
      if (!tenantId) throw new Error(`TENANT_MISSING:${companyKey}`);
      return tenantId;
    },
    teamOf,
    async stateRow(state) {
      const rows = (await setup.$client.unsafe(
        `select id, tenant_id, workspace_id, principal_id, purpose, target, status, failed_reason
         from enterprise_oauth_states where id = $1`,
        [state],
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        workspaceId: String(row.workspace_id),
        principalId: String(row.principal_id),
        purpose: String(row.purpose),
        target: String(row.target),
        status: String(row.status),
        failedReason:
          row.failed_reason == null ? null : String(row.failed_reason),
      };
    },
    async stateRowCount() {
      const rows = (await setup.$client.unsafe(
        "select count(*)::int as n from enterprise_oauth_states",
      )) as Array<Record<string, unknown>>;
      return Number(rows[0]?.n ?? 0);
    },
    async securityEvents({ tenantId, eventId }) {
      const rows = (await base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.operation_id', ${eventId}, true)`,
        );
        return tx.execute(
          sql`select event_type, actor_id, details from enterprise_security_events
              where tenant_id = ${tenantId} and id = ${eventId}`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        eventType: String(row.event_type),
        actorId: String(row.actor_id),
        details: row.details as Record<string, unknown>,
      }));
    },
    async setCompanyMembershipStatus(identity, companyKey, status) {
      const tenantId = (base.isolation.ids as Record<string, string>)[
        companyKey
      ];
      const principalId = principalOf(identity, companyKey);
      await setup.transaction(async (tx) => {
        const updated = (await tx.execute(sql`
          update enterprise_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_memberships
                     where tenant_id = ${tenantId}
                       and principal_id = ${principalId})
          where tenant_id = ${tenantId}
            and principal_id = ${principalId}
          returning 1
        `)) as unknown;
        // 0 affected rows means the membership row is gone; say so instead of
        // letting downstream denial assertions pass for the wrong reason.
        const rows = Array.isArray(updated)
          ? updated
          : ((updated as { rows?: unknown[] })?.rows ?? []);
        if (rows.length !== 1) {
          throw new Error(
            `MEMBERSHIP_STATUS_FAILED:${tenantId}:${principalId}:${rows.length}`,
          );
        }
      });
    },
    async setTeamMembershipStatus(identity, teamKey, status) {
      const fact = teamOf(identity, teamKey);
      await setup.transaction(async (tx) => {
        const updated = (await tx.execute(sql`
          update enterprise_workspace_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_workspace_memberships
                     where tenant_id = ${fact.tenantId}
                       and workspace_id = ${fact.workspaceId}
                       and principal_id = ${fact.principalId})
          where tenant_id = ${fact.tenantId}
            and workspace_id = ${fact.workspaceId}
            and principal_id = ${fact.principalId}
          returning 1
        `)) as unknown;
        // 0 affected rows means the membership row is gone; say so instead of
        // letting downstream denial assertions pass for the wrong reason.
        const rows = Array.isArray(updated)
          ? updated
          : ((updated as { rows?: unknown[] })?.rows ?? []);
        if (rows.length !== 1) {
          throw new Error(
            `MEMBERSHIP_STATUS_FAILED:${fact.tenantId}:${fact.workspaceId}:${fact.principalId}:${rows.length}`,
          );
        }
      });
    },
    catalog: {
      async rlsFlags(table) {
        const rows = (await setup.$client.unsafe(
          `select relrowsecurity, relforcerowsecurity from pg_class
           where relname = $1 and relnamespace = 'public'::regnamespace`,
          [table],
        )) as Array<Record<string, unknown>>;
        const row = rows[0];
        if (!row) throw new Error(`CATALOG_TABLE_MISSING:${table}`);
        return {
          relrowsecurity: Boolean(row.relrowsecurity),
          relforcerowsecurity: Boolean(row.relforcerowsecurity),
        };
      },
      async hasPrivilege(table, role, privilege) {
        // Schema-qualify like rlsFlags above: a bare table name resolves
        // through search_path and can hit a same-named table in another schema.
        const rows = (await setup.$client.unsafe(
          "select has_table_privilege($1, 'public.' || $2, $3) as allowed",
          [role, table, privilege],
        )) as Array<Record<string, unknown>>;
        return Boolean(rows[0]?.allowed);
      },
    },
    async dispose() {
      await setup.$client.close().catch(() => {});
      await operatorB.$client.close().catch(() => {});
      await base.dispose();
    },
  };
}
