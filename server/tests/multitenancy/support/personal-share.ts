/**
 * MT010 (Issue #53) personal-share fixture support.
 *
 * Builds on the MT008 resource-policy fixture (which itself wraps the MT002
 * isolation fixture: two companies, three teams, real provisioning, real
 * restricted roles). This wrapper adds exactly the arrangements MT010's tests
 * need and nothing else:
 *
 *   - personal resources (kind `session` | `file` | `connection`) provisioned
 *     through the REAL offline factory (`provisionDeployment`) with the owner
 *     as the sole reader, then explicitly marked `visibility = 'private'`
 *     through the restricted operator UPDATE policy — the same write path the
 *     MT008 migration granted;
 *   - the MT010 share admin (owner-only share/revoke, restricted operator
 *     channel) and share-aware decision (restricted data channel) services;
 *   - read-back helpers for ownership facts (grants principals, resource row)
 *     and share rows through the restricted operator role, so tests can prove
 *     that sharing left ownership untouched;
 *   - a dedicated superuser connection for catalog-only assertions (RLS flags,
 *     grant matrix) — never used for business reads or writes.
 *
 * Nothing here mocks the authorization path: shares, grants, visibility and
 * decisions all execute against real rows under the restricted `ob_ent_*`
 * PostgreSQL roles.
 */

import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  createPersonalShareAdminService,
  createPersonalShareDecisionService,
  type PersonalShareAdminService,
  type PersonalShareDecisionService,
} from "../../../src/enterprise/tenancy/personal-share-rules";
import { provisionDeployment } from "../../../src/enterprise/tenancy/provision";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import type { FixtureIdentity } from "./fixture";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
  type TeamKey,
} from "./resource-policy";

/** The canonical personal resource kinds (Issue #53: 会话 / 文件 / 连接凭据). */
export type PersonalResourceKind = "session" | "file" | "connection";

export const PERSONAL_RESOURCE_KINDS: readonly PersonalResourceKind[] = [
  "session",
  "file",
  "connection",
];

export interface PersonalResourceFact {
  readonly resourceId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly kind: PersonalResourceKind;
}

export interface ResourceOwnershipSnapshot {
  readonly visibility: string | null;
  readonly status: string;
  readonly revision: number;
  readonly aclEpoch: number;
  readonly grantPrincipals: readonly string[];
}

export interface PersonalShareFixture {
  readonly base: ResourcePolicyFixture;
  /** Owner-only share/revoke, riding the restricted operator channel. */
  readonly shares: PersonalShareAdminService;
  /** Share-aware read decision, riding the restricted data channel. */
  readonly decisions: PersonalShareDecisionService;
  /**
   * Provisions one personal resource through the real factory: owner as sole
   * member/reader in their own team, then visibility explicitly 'private'.
   */
  provisionPersonalResource(input: {
    readonly kind: PersonalResourceKind;
    readonly owner: FixtureIdentity;
    readonly team: TeamKey;
  }): Promise<PersonalResourceFact>;
  /** Ownership facts for one resource, read through the restricted operator. */
  ownershipSnapshot(input: {
    readonly tenantId: string;
    readonly resourceId: string;
  }): Promise<ResourceOwnershipSnapshot>;
  /** One share row (or null), read through the restricted operator. */
  shareRow(input: {
    readonly tenantId: string;
    readonly resourceId: string;
    readonly audiencePrincipalId: string;
  }): Promise<Record<string, unknown> | null>;
  /** `current_user` behind one restricted role channel. */
  currentUserOf(role: "data" | "operator"): Promise<string>;
  /**
   * Offline arrangement stand-in (superuser, disclosed): flips one company
   * membership to the requested status, bumping epoch like the MT005 support.
   * Arrangement only — the DECISION side never uses it: every decide() runs
   * through the restricted data role under real RLS.
   */
  setCompanyMembershipStatus(
    identity: FixtureIdentity,
    tenantId: string,
    status: "active" | "suspended",
  ): Promise<void>;
  /** Catalog-level RLS flags for the share table (superuser, catalog only). */
  shareTableRlsFlags(): Promise<{
    readonly rowSecurity: boolean;
    readonly forceRowSecurity: boolean;
  }>;
  /** Role/table privilege matrix for the share table (superuser, catalog only). */
  shareTableGrants(): Promise<ReadonlyMap<string, readonly string[]>>;
  dispose(): Promise<void>;
}

export async function createPersonalShareFixture(): Promise<PersonalShareFixture> {
  const base = await createResourcePolicyFixture();
  const setup: Database = createDatabase(enterpriseTestDatabaseUrlFrom(), {
    max: 1,
  });

  let provisionedCount = 0;

  const fixture: PersonalShareFixture = {
    base,
    shares: createPersonalShareAdminService(base.operator),
    decisions: createPersonalShareDecisionService(base.data),

    async provisionPersonalResource({ kind, owner, team }) {
      const where = base.teamOf(owner, team);
      const identity = base.isolation.identities[owner];
      if (!identity?.userId) {
        throw new Error(`PERSONAL_OWNER_MUST_BE_HUMAN:${owner}`);
      }
      const company = identity.companies.find(
        (entry) => entry.tenantId === where.tenantId,
      );
      if (!company) {
        throw new Error(`PERSONAL_OWNER_COMPANY_MISSING:${owner}`);
      }
      // provisionDeployment 幂等校验 tenant/workspace 名称：读既有事实，
      // 绝不在夹具里复制一份会漂移的名字。
      const facts = await base.isolation.queryRestricted(
        "operator",
        { tenantId: where.tenantId },
        "select t.name as tenant_name, w.id as workspace_id, w.name as workspace_name from enterprise_tenants t join enterprise_workspaces w on w.tenant_id = t.id and w.id = $2 where t.id = $1",
        [where.tenantId, where.workspaceId],
      );
      const fact = facts[0];
      if (!fact) {
        throw new Error(`PERSONAL_TEAM_FACT_MISSING:${owner}:${team}`);
      }
      provisionedCount += 1;
      const resourceId = `${base.isolation.idPrefix}-personal-${kind}-${provisionedCount}`;
      await provisionDeployment(base.operator, {
        operationId: `${resourceId}-provision`,
        operator: where.principalId,
        tenant: { id: where.tenantId, name: String(fact.tenant_name) },
        workspace: {
          id: where.workspaceId,
          name: String(fact.workspace_name),
        },
        members: [
          {
            principalId: where.principalId,
            userId: identity.userId,
            role: company.role === "tenant_admin" ? "tenant_admin" : "member",
          },
        ],
        resources: [
          {
            id: resourceId,
            kind,
            displayName: `Personal ${kind} ${provisionedCount}`,
            readers: [where.principalId],
          },
        ],
      });
      // Explicit personal choice, through the real operator UPDATE policy.
      await base.markVisibility({
        tenantId: where.tenantId,
        resourceId,
        visibility: "private",
      });
      return {
        resourceId,
        tenantId: where.tenantId,
        workspaceId: where.workspaceId,
        ownerPrincipalId: where.principalId,
        kind,
      };
    },

    async ownershipSnapshot({ tenantId, resourceId }) {
      const rows = await base.isolation.queryRestricted(
        "operator",
        { tenantId },
        "select r.visibility, r.status, r.revision, r.acl_epoch, coalesce(g.principal_id, '') as grant_principal from enterprise_resources r left join enterprise_resource_grants g on g.tenant_id = r.tenant_id and g.resource_id = r.id and g.action = 'read' where r.tenant_id = $1 and r.id = $2 order by g.principal_id",
        [tenantId, resourceId],
      );
      if (rows.length === 0) {
        throw new Error(`OWNERSHIP_SNAPSHOT_MISSING:${tenantId}:${resourceId}`);
      }
      const first = rows[0];
      return {
        visibility: (first.visibility as string | null) ?? null,
        status: String(first.status),
        revision: Number(first.revision),
        aclEpoch: Number(first.acl_epoch),
        grantPrincipals: rows
          .map((row) => String(row.grant_principal ?? ""))
          .filter((principal) => principal.length > 0),
      };
    },

    async shareRow({ tenantId, resourceId, audiencePrincipalId }) {
      const rows = await base.isolation.queryRestricted(
        "operator",
        { tenantId },
        "select principal_id, action, granted_by, expires_at, created_at from enterprise_resource_shares where tenant_id = $1 and resource_id = $2 and principal_id = $3",
        [tenantId, resourceId, audiencePrincipalId],
      );
      return rows[0] ?? null;
    },

    async currentUserOf(role) {
      const rows = await base.isolation.queryRestricted(
        role,
        undefined,
        "select current_user as current_user",
        [],
      );
      const row = rows[0];
      if (!row || typeof row.current_user !== "string") {
        throw new Error(`RESTRICTED_ROLE_IDENTITY_UNREADABLE:${role}`);
      }
      return row.current_user;
    },

    async setCompanyMembershipStatus(identity, tenantId, status) {
      const principalId = base.isolation.identities[identity]?.companies.find(
        (company) => company.tenantId === tenantId,
      )?.principalId;
      if (!principalId) {
        throw new Error(`COMPANY_MEMBERSHIP_FACT_MISSING:${identity}`);
      }
      await setup.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            "enterprise",
            "membership",
            tenantId,
            principalId,
          ])}, 0))`,
        );
        await tx.execute(sql`
          update enterprise_memberships
          set status = ${status},
            epoch = (select coalesce(max(epoch), 0) + 1
                     from enterprise_memberships
                     where tenant_id = ${tenantId}
                       and principal_id = ${principalId})
          where tenant_id = ${tenantId}
            and principal_id = ${principalId}
        `);
      });
    },

    async shareTableRlsFlags() {
      const rows = (await setup.$client.unsafe(
        "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'enterprise_resource_shares'",
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) {
        throw new Error("SHARE_TABLE_MISSING");
      }
      return {
        rowSecurity: row.relrowsecurity === true,
        forceRowSecurity: row.relforcerowsecurity === true,
      };
    },

    async shareTableGrants() {
      const rows = (await setup.$client.unsafe(
        "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'enterprise_resource_shares' and grantee in ('ob_ent_directory', 'ob_ent_data', 'ob_ent_operator') order by grantee, privilege_type",
      )) as Array<Record<string, unknown>>;
      const grants = new Map<string, string[]>();
      for (const row of rows) {
        const grantee = String(row.grantee);
        const privileges = grants.get(grantee) ?? [];
        privileges.push(String(row.privilege_type));
        grants.set(grantee, privileges);
      }
      return new Map(
        [...grants.entries()].map(
          ([grantee, privileges]) => [grantee, privileges] as const,
        ),
      );
    },

    async dispose() {
      await setup.$client.close().catch(() => {});
      await base.dispose();
    },
  };
  return fixture;
}
