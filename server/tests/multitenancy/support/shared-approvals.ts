/**
 * MT034 (Issue #77) shared-approvals fixture support.
 *
 * Wraps the MT031 plugin-install fixture (which itself wraps the MT008
 * resource-policy base: two companies, three teams, real provisioning, real
 * restricted roles) and adds exactly the arrangements MT034's tests need:
 *
 *   - real Bot ownership rows through the REAL `createBotOwnershipService`
 *     (MT016 production service over the same verified channels) — an
 *     approval locks to a Bot object, so the Bot must exist for real;
 *   - a real team credential (MT027 admin over the same channels) plus the
 *     REAL MT029 credential-lease service, so the "approved actions are
 *     re-validated per MT029" acceptance consumes the actual lease seam and
 *     never a stand-in;
 *   - the MT034 shared-approval services: request/withdraw/authorizeUse ride
 *     the restricted data channel, approve/decline rides the restricted
 *     operator channel with the workspace-admin CompanyAdminContext
 *     precedent (trusted-context WeakSet, in-transaction admin revalidation);
 *   - request/approval row read-back through the restricted operator role
 *     (real RLS: tenant-pinned SELECT — the only admin-facing read surface).
 *
 * Nothing here mocks the authorization path: requests, approvals and use
 * decisions all execute against real rows under the restricted `ob_ent_*`
 * PostgreSQL roles with real RLS.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type BotOwnershipService,
  createBotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  type CredentialLeaseService,
  createCredentialLeaseService,
} from "../../../src/enterprise/tenancy/credential-lease";
import {
  type CredentialOwnershipAdminService,
  createCredentialOwnershipAdminService,
} from "../../../src/enterprise/tenancy/credential-ownership";
import {
  createSharedApprovalAdminService,
  createSharedApprovalService,
  type SharedApprovalAdminService,
  type SharedApprovalService,
} from "../../../src/enterprise/tenancy/shared-approvals";
import {
  type CompanyAdminContext,
  createCompanyAdminAuthorizer,
} from "../../../src/enterprise/tenancy/workspace-admin";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import { MemoryVault } from "./credentials-ownership";
import type { FixtureIdentity } from "./fixture";
import {
  createPluginInstallFixture,
  type PluginInstallFixture,
} from "./plugin-install";

export type SharedTeamKey = "team-a1" | "team-a2" | "team-b1";

/** One request row as read back through the restricted operator channel. */
export interface SharedRequestRowFact {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installId: string;
  readonly requestedBy: string;
  readonly proposedParamsDigest: string;
  readonly reason: string;
  readonly status: string;
  readonly decidedBy: string | null;
}

/** One approval row as read back through the restricted operator channel. */
export interface SharedApprovalRowFact {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly installId: string;
  readonly requestId: string;
  readonly audience: string;
  readonly outsideInput: boolean;
  readonly paramsDigest: string;
  readonly approvedBy: string;
}

export interface SharedForeignKeyFact {
  readonly refTable: string;
  readonly onDelete: string;
}

export interface SharedApprovalsFixture {
  readonly base: PluginInstallFixture;
  /** request/withdraw/authorizeUse decisions, riding the restricted data channel. */
  readonly approvals: SharedApprovalService;
  /** approve/decline, riding the restricted operator channel (admin context). */
  readonly approvalAdmin: SharedApprovalAdminService;
  /** Real MT016 bot ownership over the same verified channels. */
  readonly bots: BotOwnershipService;
  /** Real MT027 credential ownership admin (register/grant), operator channel. */
  readonly credentialAdmin: CredentialOwnershipAdminService;
  /** Real MT029 lease decisions (issue/validate), restricted data channel. */
  readonly leases: CredentialLeaseService;
  /** Registers one real team credential through the real MT027 admin. */
  provisionTeamCredential(input: {
    readonly teamKey: SharedTeamKey;
    readonly target: string;
    readonly label: string;
    readonly plaintext: string;
  }): Promise<string>;
  /** Grants one real use action through the real MT027 admin. */
  grantUse(input: {
    readonly credentialId: string;
    readonly identity: FixtureIdentity;
    readonly teamKey: SharedTeamKey;
  }): Promise<void>;
  /** Real trusted scope issuance through the real resolver (the production gate). */
  scopeAs(
    identity: FixtureIdentity,
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /**
   * Mints a REAL trusted CompanyAdminContext through the real company-admin
   * authorizer over the directory channel (the same eligibility gate
   * production management requests pass — a test double can never mint one;
   * bots-ownership fixture precedent).
   */
  adminContextFor(tenantId: string): Promise<CompanyAdminContext>;
  /** Request rows for one tenant, read through the restricted operator. */
  requestRows(input: {
    readonly tenantId: string;
  }): Promise<readonly SharedRequestRowFact[]>;
  /** Approval rows for one tenant, read through the restricted operator. */
  approvalRows(input: {
    readonly tenantId: string;
  }): Promise<readonly SharedApprovalRowFact[]>;
  /** Composite FKs of one table: referenced table + ON DELETE action. */
  foreignKeys(table: string): Promise<readonly SharedForeignKeyFact[]>;
  /** Grant matrix probe via the setup channel (read-only assertions). */
  grants(table: string): Promise<readonly string[]>;
  /**
   * Structural probe (superuser, disclosed): attempts a raw request INSERT
   * and returns the first SQLSTATE of the failure chain ("" when it did not
   * throw). Proves cross-company request rows are structurally impossible.
   */
  rawRequestInsert(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly agentId: string;
    readonly installId: string;
    readonly requestedBy: string;
    readonly paramsDigest: string;
  }): Promise<string>;
  dispose(): Promise<void>;
}

/**
 * Creates the MT034 fixture. Environment probing is the base fixture's job
 * (it refuses loudly — never a development-database fallback).
 */
export async function createSharedApprovalsFixture(): Promise<SharedApprovalsFixture> {
  const base = await createPluginInstallFixture();
  const channels = base.base;
  const leases = createCredentialLeaseService(channels.data);
  const approvals = createSharedApprovalService(channels.data, {
    leaseValidator: leases,
  });
  const approvalAdmin = createSharedApprovalAdminService(channels.operator);
  const bots = createBotOwnershipService({
    data: channels.data,
    operator: channels.operator,
  });
  const vault = new MemoryVault();
  const credentialAdmin = createCredentialOwnershipAdminService(
    channels.operator,
    vault,
  );
  // Dedicated setup (superuser) connection for catalog-only assertions —
  // never used for business reads or writes (MT027/MT031 fixture precedent).
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  return {
    base,
    approvals,
    approvalAdmin,
    bots,
    credentialAdmin,
    leases,
    async provisionTeamCredential({ teamKey, target, label, plaintext }) {
      const memberByTeam: Record<"team-a1" | "team-a2" | "team-b1", string> = {
        "team-a1": "a1-member",
        "team-a2": "a2-member",
        "team-b1": "b1-member",
      };
      const fact = channels.teamOf(
        memberByTeam[teamKey],
        teamKey,
      );
      const { credentialId } = await credentialAdmin.register({
        tenantId: fact.tenantId,
        kind: "connection",
        classification: "team",
        workspaceId: fact.workspaceId,
        target,
        label,
        plaintext,
      });
      return credentialId;
    },
    async grantUse({ credentialId, identity, teamKey }) {
      const fact = channels.teamOf(identity, teamKey);
      await credentialAdmin.grantAction({
        tenantId: fact.tenantId,
        credentialId,
        principalId: fact.principalId,
        action: "use",
        grantedBy: fact.principalId,
      });
    },
    async scopeAs(identity, tenantId, workspaceId) {
      return channels.scopeFor(identity, { tenantId, workspaceId });
    },
    async adminContextFor(tenantId) {
      const sessions = new WeakMap<Request, { userId?: string }>();
      const authorizer = createCompanyAdminAuthorizer(channels.directory, {
        authenticate: async (request) => {
          const session = sessions.get(request);
          if (!session?.userId) return null;
          return { actorId: session.userId, entrypoint: "web" };
        },
        selectTenant: (request) => request.headers.get("x-openbot-tenant"),
      });
      const adminUserId = channels.isolation.ids["user-company-admin"];
      if (adminUserId === undefined) {
        // sessions.set with an undefined user id would authenticate nobody and
        // fail far away from the actual cause.
        throw new Error(
          "MT034 fixture: isolation.ids is missing user-company-admin",
        );
      }
      const request = new Request("https://mt034.invalid/admin-context", {
        headers: { "x-openbot-tenant": tenantId },
      });
      sessions.set(request, {
        userId: adminUserId,
      });
      return authorizer.resolveAdminContext(request);
    },
    async rawRequestInsert(input) {
      try {
        await setup.$client.unsafe(
          `insert into enterprise_shared_use_requests
             (tenant_id, id, workspace_id, agent_id, install_id, requested_by,
              proposed_audience, proposed_outside_input, proposed_members,
              proposed_params_digest, reason, status)
           values ($1, $2, $3, $4, $5, $6, 'team', false, '[]'::jsonb, $7, 'publish', 'pending')`,
          [
            input.tenantId,
            `raw-${randomUUID()}`,
            input.workspaceId,
            input.agentId,
            input.installId,
            input.requestedBy,
            input.paramsDigest,
          ],
        );
        return "";
      } catch (error) {
        for (let e: unknown = error; e instanceof Error; e = e.cause) {
          // Bun's postgres client carries the SQLSTATE on `errno`
          // (PostgresError); drizzle surfaces it as `code` (plugin-install
          // fixture same aid).
          const code = (e as Error & { code?: unknown }).code;
          const errno = (e as Error & { errno?: unknown }).errno;
          // SQLSTATE is five [0-9A-Z] characters (42P01, 55P03, …), not only digits.
          if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
          if (typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno)) {
            return errno;
          }
        }
        return "UNKNOWN";
      }
    },
    async requestRows({ tenantId }) {
      const rows = (await channels.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select id, workspace_id, agent_id, install_id, requested_by, proposed_params_digest, reason, status, decided_by
              from enterprise_shared_use_requests
              where tenant_id = ${tenantId}
              order by created_at, id`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        agentId: String(row.agent_id),
        installId: String(row.install_id),
        requestedBy: String(row.requested_by),
        proposedParamsDigest: String(row.proposed_params_digest),
        reason: String(row.reason),
        status: String(row.status),
        decidedBy: row.decided_by == null ? null : String(row.decided_by),
      }));
    },
    async approvalRows({ tenantId }) {
      const rows = (await channels.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        return tx.execute(
          sql`select id, workspace_id, agent_id, install_id, request_id, audience, outside_input, params_digest, approved_by
              from enterprise_shared_use_approvals
              where tenant_id = ${tenantId}
              order by created_at, id`,
        );
      })) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        agentId: String(row.agent_id),
        installId: String(row.install_id),
        requestId: String(row.request_id),
        audience: String(row.audience),
        outsideInput: Boolean(row.outside_input),
        paramsDigest: String(row.params_digest),
        approvedBy: String(row.approved_by),
      }));
    },
    async foreignKeys(table) {
      const rows = (await setup.execute(
        sql`select c.confrelid::regclass::text as ref_table, c.confdeltype
            from pg_constraint c
            where c.contype = 'f' and c.conrelid = ${table}::regclass
            order by c.confrelid::regclass::text`,
      )) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        refTable: String(row.ref_table).replace(/^public\./, ""),
        onDelete:
          row.confdeltype === "c"
            ? "cascade"
            : row.confdeltype === "a"
              ? "no action"
              : String(row.confdeltype),
      }));
    },
    async grants(table) {
      const rows = (await setup.execute(
        sql`select grantee, privilege_type
            from information_schema.role_table_grants
            where table_name = ${table} and table_schema = current_schema()
              and grantee in ('ob_ent_data','ob_ent_operator','ob_ent_directory')
            order by grantee, privilege_type`,
      )) as unknown as Record<string, unknown>[];
      return rows.map(
        (row) => `${String(row.grantee)}:${String(row.privilege_type)}`,
      );
    },
    async dispose() {
      // base.dispose() owns the real provisioning cleanup — it must run even
      // when the setup connection close throws.
      try {
        await setup.$client.close();
      } finally {
        await base.dispose();
      }
    },
  };
}

/** Deterministic request-id factory so assertion failures name the case. */
export function nextRequestId(): string {
  return `req-${randomUUID()}`;
}
