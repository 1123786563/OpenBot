/**
 * MT029 (Issue #72) credential-lease fixture support.
 *
 * Wraps the MT027 credentials-ownership fixture (which itself wraps the MT008
 * resource-policy base: two companies, three teams, real provisioning, real
 * restricted roles) and adds exactly the arrangements MT029's tests need:
 *
 *   - the MT029 lease decision service (restricted data channel: issue /
 *     validate) and lease admin (restricted operator channel: revoke);
 *   - lease-row and audit read-back through the restricted operator role
 *     (real RLS: tenant-pinned SELECT — the only admin-facing read surface);
 *   - company-membership arrangement stand-ins are inherited from the base
 *     fixture (suspension with/without epoch bump, superuser disclosed).
 *
 * Nothing here mocks the authorization path: leases, audits and decisions all
 * execute against real rows under the restricted `ob_ent_*` PostgreSQL roles
 * with real RLS.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  type CredentialLeaseAdminService,
  type CredentialLeaseService,
  createCredentialLeaseAdminService,
  createCredentialLeaseService,
} from "../../../src/enterprise/tenancy/credential-lease";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  type CredentialsFixture,
  createCredentialsFixture,
} from "./credentials-ownership";
import type { FixtureIdentity } from "./fixture";

/** One lease row as read back through the restricted operator channel. */
export interface LeaseRowFact {
  readonly id: string;
  readonly credentialId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly purpose: string;
  readonly status: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** One audit row as read back through the restricted operator channel. */
export interface LeaseAuditRowFact {
  readonly id: string;
  readonly leaseId: string;
  readonly credentialId: string;
  readonly principalId: string;
  readonly action: string;
  readonly detail: Record<string, unknown>;
}

export interface LeaseForeignKeyFact {
  readonly refTable: string;
  readonly onDelete: string;
}

export interface CredentialLeaseFixture {
  readonly base: CredentialsFixture;
  /** issue/validate decisions, riding the restricted data channel. */
  readonly leases: CredentialLeaseService;
  /** revoke, riding the restricted operator channel. */
  readonly leaseAdmin: CredentialLeaseAdminService;
  /** Lease rows for one tenant, read through the restricted operator. */
  leaseRows(input: {
    readonly tenantId: string;
  }): Promise<readonly LeaseRowFact[]>;
  /** Audit rows for one tenant (optionally one lease), operator channel. */
  auditRows(input: {
    readonly tenantId: string;
    readonly leaseId?: string;
  }): Promise<readonly LeaseAuditRowFact[]>;
  /**
   * Arrangement stand-in that flips ONLY the team-membership status
   * (superuser, disclosed; workspace memberships carry no epoch). Decision
   * paths never run through this; only fixtures do.
   */
  setTeamMembershipStatus(
    identity: FixtureIdentity,
    teamKey: "team-a1" | "team-a2" | "team-b1",
    status: "active" | "suspended",
  ): Promise<void>;
  /** Catalog facts via the dedicated superuser connection (read-only assertions). */
  readonly catalog: {
    /** Composite FKs of one table: referenced table + ON DELETE action. */
    foreignKeys(table: string): Promise<readonly LeaseForeignKeyFact[]>;
  };
  dispose(): Promise<void>;
}

/**
 * Creates the MT029 fixture. Environment probing is the base fixture's job
 * (it refuses loudly — never a development-database fallback).
 */
export async function createCredentialLeaseFixture(): Promise<CredentialLeaseFixture> {
  const base = await createCredentialsFixture();
  const leases = createCredentialLeaseService(base.base.data);
  const leaseAdmin = createCredentialLeaseAdminService(base.base.operator);
  // Dedicated setup (superuser) connection for catalog-only assertions —
  // never used for business reads or writes (MT027 fixture precedent).
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  return {
    base,
    leases,
    leaseAdmin,
    async leaseRows({ tenantId }) {
      const rows = (await base.base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select id, credential_id, principal_id, workspace_id, purpose, status, expires_at, revoked_at
              from enterprise_credential_leases
              where tenant_id = ${tenantId}
              order by created_at, id`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        credentialId: String(row.credential_id),
        principalId: String(row.principal_id),
        workspaceId: String(row.workspace_id),
        purpose: String(row.purpose),
        status: String(row.status),
        expiresAt: row.expires_at as Date,
        revokedAt: (row.revoked_at as Date | null) ?? null,
      }));
    },

    async auditRows({ tenantId, leaseId }) {
      const rows = (await base.base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return leaseId === undefined
          ? tx.execute(
              sql`select id, lease_id, credential_id, principal_id, action, detail
                  from enterprise_credential_lease_audit
                  where tenant_id = ${tenantId}
                  order by occurred_at, id`,
            )
          : tx.execute(
              sql`select id, lease_id, credential_id, principal_id, action, detail
                  from enterprise_credential_lease_audit
                  where tenant_id = ${tenantId} and lease_id = ${leaseId}
                  order by occurred_at, id`,
            );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        leaseId: String(row.lease_id),
        credentialId: String(row.credential_id),
        principalId: String(row.principal_id),
        action: String(row.action),
        detail: row.detail as Record<string, unknown>,
      }));
    },

    async setTeamMembershipStatus(identity, teamKey, status) {
      const team = base.base.teamOf(identity, teamKey);
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
        await tx.execute(sql`
          update enterprise_workspace_memberships
          set status = ${status}
          where tenant_id = ${team.tenantId}
            and workspace_id = ${team.workspaceId}
            and principal_id = ${team.principalId}
        `);
      });
    },

    catalog: {
      async foreignKeys(table) {
        const rows = (await setup.$client.unsafe(
          `select confrelid::regclass::text as ref_table, confdeltype
           from pg_constraint
           where conrelid = $1::regclass and contype = 'f'`,
          [table],
        )) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
          refTable: String(row.ref_table).replace(/^public\./, ""),
          onDelete: String(row.confdeltype),
        }));
      },
    },

    async dispose() {
      await setup.$client.close().catch(() => {});
      await base.dispose();
    },
  };
}

export { scopeOf, thrownMessage } from "./credentials-ownership";
