// server/src/enterprise/tenancy/workspace-admin.ts
// MT006（Issue #49）：工作范围列出与公司级团队管理。
//
// 两个服务面，判定事实与 MT005 完全同源（enterprise_memberships +
// enterprise_workspace_memberships 的有效行）：
//
//   1. createWorkspaceScopeLister —— 登录用户列出其有资格的公司与团队。
//      目录事务按 self-read RLS（app.user_id）读取公司成员行与团队成员行，
//      团队名按公司经 data 角色租户上下文补齐。没有任何默认团队逻辑：
//      无资格 → companies: []（明确空状态）；公司无团队 → teams: []。
//
//   2. createCompanyAdminAuthorizer + createWorkspaceAdminService —— 公司
//      管理员管理本公司团队与成员名单的**等价集中入口**（MT005 scope gate
//      的管理面孪生）：签发信任的 CompanyAdminContext（WeakSet + freeze，
//      与 createScopeResolver 同一信任机制），每个管理操作在同一 operator
//      事务内重验 tenant_admin 身份 + 公司 epoch + principal 状态后，经
//      受限 operator 角色 + RLS 写入。裁决 #1：x-openbot-tenant 只做选择。
//
// 事务形状与 conversations/store.ts、scope-gate.ts 完全一致：
// read committed + lock/statement timeout + set_config(…, true)（事务本地，
// 提交即清除，RLS 纵深防御）+ advisory 锁（键序 tenant → membership →
// workspace-membership；gate 持共享锁，管理写持排他锁，同键串行化）。
// 写中途需要切换 app.operator_principal_id（重验期 pin 操作者，写入期 pin
// 目标成员——MT004 的 update 策略按该上下文收紧行范围）。

import { and, eq, sql } from "drizzle-orm";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../../db/schema/enterprise-tenancy";
import {
  assertDataDatabase,
  assertDirectoryDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type DirectoryDatabase,
  type OperatorDatabase,
} from "./connections";
import type { AuthenticatedRequestIdentity } from "./store";

// ---------------------------------------------------------------------------
// 信任机制：与 createScopeResolver 的 issuedScopes 同构（WeakSet + freeze）
// ---------------------------------------------------------------------------

const issuedAdminContexts = new WeakSet<object>();

export interface CompanyAdminContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly memberEpoch: number;
}

export function assertTrustedAdminContext(context: CompanyAdminContext): void {
  if (
    !context ||
    typeof context !== "object" ||
    !issuedAdminContexts.has(context)
  ) {
    throw new Error("UNVERIFIED_ADMIN_CONTEXT");
  }
}

// ---------------------------------------------------------------------------
// 1. 工作范围列出（登录用户的全部有资格公司 + 团队）
// ---------------------------------------------------------------------------

export interface WorkspaceScopeTeam {
  readonly workspaceId: string;
  readonly name: string;
}

export interface WorkspaceScopeCompany {
  readonly tenantId: string;
  readonly name: string;
  /** The actor's own company role for this company. */
  readonly role: string;
  readonly memberEpoch: number;
  readonly teams: readonly WorkspaceScopeTeam[];
}

export interface WorkspaceScopeListing {
  readonly companies: readonly WorkspaceScopeCompany[];
}

export interface WorkspaceScopeLister {
  list(identity: AuthenticatedRequestIdentity): Promise<WorkspaceScopeListing>;
}

export function createWorkspaceScopeLister(
  directory: DirectoryDatabase,
  data: DataDatabase,
): WorkspaceScopeLister {
  assertDirectoryDatabase(directory);
  assertDataDatabase(data);
  return {
    async list(identity) {
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      // Directory transaction: the actor's own membership facts, visible
      // through the self-read RLS policies pinned to app.user_id.
      const { companies, teamRows } = await directory.transaction(
        async (tx) => {
          await tx.execute(sql`set transaction isolation level read committed`);
          await tx.execute(sql`set local lock_timeout = '2s'`);
          await tx.execute(sql`set local statement_timeout = '5s'`);
          await tx.execute(
            sql`select set_config('app.user_id', ${identity.actorId}, true)`,
          );
          const companyRows = await tx
            .select({
              tenantId: enterpriseMemberships.tenantId,
              tenantName: enterpriseTenants.name,
              tenantStatus: enterpriseTenants.status,
              principalStatus: enterprisePrincipals.status,
              memberStatus: enterpriseMemberships.status,
              role: enterpriseMemberships.role,
              memberEpoch: enterpriseMemberships.epoch,
            })
            .from(enterpriseMemberships)
            .innerJoin(
              enterprisePrincipals,
              eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
            )
            .innerJoin(
              enterpriseTenants,
              eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
            )
            .where(eq(enterprisePrincipals.userId, identity.actorId));
          const teamRows = await tx
            .select({
              tenantId: enterpriseWorkspaceMemberships.tenantId,
              workspaceId: enterpriseWorkspaceMemberships.workspaceId,
            })
            .from(enterpriseWorkspaceMemberships)
            .innerJoin(
              enterprisePrincipals,
              eq(
                enterprisePrincipals.id,
                enterpriseWorkspaceMemberships.principalId,
              ),
            )
            .where(
              and(
                eq(enterprisePrincipals.userId, identity.actorId),
                eq(enterpriseWorkspaceMemberships.status, "active"),
              ),
            );
          return { companies: companyRows, teamRows };
        },
      );
      // Eligibility = every status fact active; a suspended company row hides
      // the whole company (the same fact source the MT005 resolver reads).
      const eligible = companies.filter(
        (company) =>
          company.tenantStatus === "active" &&
          company.principalStatus === "active" &&
          company.memberStatus === "active",
      );
      const teamsByTenant = new Map<string, string[]>();
      for (const team of teamRows) {
        const ids = teamsByTenant.get(team.tenantId) ?? [];
        ids.push(team.workspaceId);
        teamsByTenant.set(team.tenantId, ids);
      }
      // Team display names come from the tenant-scoped data read; only teams
      // the actor is a member of are ever named.
      const resolvedCompanies: WorkspaceScopeCompany[] = [];
      for (const company of eligible) {
        const teamIds = (teamsByTenant.get(company.tenantId) ?? []).sort();
        const teams: WorkspaceScopeTeam[] = [];
        if (teamIds.length > 0) {
          const named = await data.transaction(async (tx) => {
            await tx.execute(
              sql`set transaction isolation level read committed`,
            );
            await tx.execute(sql`set local lock_timeout = '2s'`);
            await tx.execute(sql`set local statement_timeout = '5s'`);
            await tx.execute(
              sql`select set_config('app.tenant_id', ${company.tenantId}, true)`,
            );
            return tx
              .select({
                workspaceId: enterpriseWorkspaces.id,
                name: enterpriseWorkspaces.name,
              })
              .from(enterpriseWorkspaces)
              .where(eq(enterpriseWorkspaces.tenantId, company.tenantId));
          });
          const nameOf = new Map(
            named.map((row) => [row.workspaceId, row.name]),
          );
          for (const workspaceId of teamIds) {
            const name = nameOf.get(workspaceId);
            // A membership row whose workspace vanished cannot happen (FK
            // cascade); an RLS-invisible row is skipped rather than invented.
            if (name !== undefined) {
              teams.push({ workspaceId, name });
            }
          }
        }
        resolvedCompanies.push({
          tenantId: company.tenantId,
          name: company.tenantName,
          role: company.role,
          memberEpoch: company.memberEpoch,
          teams,
        });
      }
      resolvedCompanies.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      // Explicit empty state: no companies means an empty array — never a
      // defaulted or suggested scope.
      return { companies: resolvedCompanies };
    },
  };
}

// ---------------------------------------------------------------------------
// 2a. 公司管理员上下文签发（等价集中入口的签发半边）
// ---------------------------------------------------------------------------

export interface CompanyAdminAuthorizerOptions {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  /** Ruling #1: the tenant header only selects; membership decides. */
  selectTenant?(request: Request): string | null;
}

export interface CompanyAdminAuthorizer {
  authenticate(request: Request): Promise<AuthenticatedRequestIdentity | null>;
  resolveAdminContext(request: Request): Promise<CompanyAdminContext>;
}

export function createCompanyAdminAuthorizer(
  directory: DirectoryDatabase,
  options: CompanyAdminAuthorizerOptions,
): CompanyAdminAuthorizer {
  assertDirectoryDatabase(directory);
  return {
    authenticate: (request) => options.authenticate(request),
    async resolveAdminContext(request) {
      const identity = await options.authenticate(request);
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const tenantId = options.selectTenant?.(request);
      if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
      const context = await directory.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true)`,
        );
        const [membership] = await tx
          .select({
            principalId: enterprisePrincipals.id,
            tenantStatus: enterpriseTenants.status,
            principalStatus: enterprisePrincipals.status,
            memberStatus: enterpriseMemberships.status,
            role: enterpriseMemberships.role,
            memberEpoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, enterpriseMemberships.tenantId),
          )
          .where(
            and(
              eq(enterprisePrincipals.userId, identity.actorId),
              eq(enterpriseMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (
          membership?.tenantStatus !== "active" ||
          membership.principalStatus !== "active" ||
          membership.memberStatus !== "active"
        ) {
          // Same code as the business resolver: no existence leak.
          throw new Error("TENANT_FORBIDDEN");
        }
        if (membership.role !== "tenant_admin") {
          throw new Error("TENANT_ADMIN_REQUIRED");
        }
        return Object.freeze({
          tenantId,
          principalId: membership.principalId,
          actorId: identity.actorId,
          memberEpoch: membership.memberEpoch,
        } satisfies CompanyAdminContext);
      });
      issuedAdminContexts.add(context);
      return context;
    },
  };
}

// ---------------------------------------------------------------------------
// 2b. 团队与成员名单管理（等价集中入口的事务半边）
// ---------------------------------------------------------------------------

export interface CreatedTeam {
  readonly workspaceId: string;
  readonly name: string;
}

export type TeamMembershipFact = {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly status: "active" | "suspended";
  readonly epoch: number;
};

export interface AddTeamMembershipResult {
  readonly membership: TeamMembershipFact;
  /** "created" = fresh row; "reactivated" = suspended row restored. */
  readonly outcome: "created" | "reactivated";
}

export interface WorkspaceAdminService {
  createTeam(
    context: CompanyAdminContext,
    input: { readonly name: string; readonly workspaceId?: string },
  ): Promise<CreatedTeam>;
  addTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<AddTeamMembershipResult>;
  suspendTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<{ readonly membership: TeamMembershipFact }>;
  removeTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<{ readonly removed: true }>;
}

/** The advisory key the MT005 gate takes shared and admin writes take exclusive. */
function membershipLockKey(tenantId: string, principalId: string): string {
  return JSON.stringify(["enterprise", "membership", tenantId, principalId]);
}

function workspaceMembershipLockKey(
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

async function beginTransaction(
  tx: Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0],
): Promise<void> {
  await tx.execute(sql`set transaction isolation level read committed`);
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

/**
 * Runs one management operation: trust → exclusive locks (canonical order) →
 * in-transaction tenant_admin + epoch + principal revalidation → operation.
 * The operator-transaction settings are transaction-local; nothing
 * session-level survives commit or rollback.
 */
/** The management-plane write service over the restricted operator role. */
export function createWorkspaceAdminService(
  operator: OperatorDatabase,
): WorkspaceAdminService {
  assertOperatorDatabase(operator);
  type Tx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  /** Exclusive locks in canonical order: tenant → membership → workspace-membership. */
  const takeLocks = async (tx: Tx, keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
      );
    }
  };

  /**
   * Revalidates the acting admin inside the transaction: active company
   * membership with the tenant_admin role, epoch equal to the issued
   * context, principal still active. Any drift → SCOPE_REVOKED.
   */
  const revalidateAdmin = async (
    tx: Tx,
    context: CompanyAdminContext,
  ): Promise<void> => {
    const [membership] = await tx
      .select({
        memberStatus: enterpriseMemberships.status,
        memberEpoch: enterpriseMemberships.epoch,
        role: enterpriseMemberships.role,
        principalStatus: enterprisePrincipals.status,
      })
      .from(enterpriseMemberships)
      .innerJoin(
        enterprisePrincipals,
        and(
          eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          // principals operator read policy pins app.operator_principal_id.
          sql`${enterprisePrincipals.id} = nullif(current_setting('app.operator_principal_id', true), '')`,
        ),
      )
      .where(
        and(
          eq(enterpriseMemberships.tenantId, context.tenantId),
          eq(enterpriseMemberships.principalId, context.principalId),
        ),
      )
      .limit(1);
    if (
      membership?.memberStatus !== "active" ||
      membership.principalStatus !== "active" ||
      membership.role !== "tenant_admin" ||
      membership.memberEpoch !== context.memberEpoch
    ) {
      throw new Error("SCOPE_REVOKED");
    }
  };

  /** Switches the operator pin from the acting admin to the target member. */
  const pinTarget = async (tx: Tx, principalId: string): Promise<void> => {
    await tx.execute(
      sql`select set_config('app.operator_principal_id', ${principalId}, true)`,
    );
  };

  return {
    async createTeam(context, input) {
      assertTrustedAdminContext(context);
      const name = input.name?.trim();
      if (!name || name.length > 200) {
        throw new Error("INVALID_REQUEST");
      }
      const requestedId = input.workspaceId?.trim();
      if (
        requestedId !== undefined &&
        requestedId !== "" &&
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(requestedId)
      ) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          JSON.stringify(["enterprise", "tenant", context.tenantId]),
        ]);
        await revalidateAdmin(tx, context);
        const workspaceId =
          requestedId !== undefined && requestedId !== ""
            ? requestedId
            : `team-${crypto.randomUUID()}`;
        if (requestedId !== undefined && requestedId !== "") {
          const [existing] = await tx
            .select({ id: enterpriseWorkspaces.id })
            .from(enterpriseWorkspaces)
            .where(
              and(
                eq(enterpriseWorkspaces.tenantId, context.tenantId),
                eq(enterpriseWorkspaces.id, workspaceId),
              ),
            )
            .limit(1);
          if (existing) throw new Error("TEAM_ALREADY_EXISTS");
        }
        await tx.insert(enterpriseWorkspaces).values({
          tenantId: context.tenantId,
          id: workspaceId,
          name,
        });
        return { workspaceId, name };
      });
    },

    async addTeamMember(context, input) {
      assertTrustedAdminContext(context);
      const workspaceId = input.workspaceId?.trim();
      const principalId = input.principalId?.trim();
      if (!workspaceId || !principalId) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          membershipLockKey(context.tenantId, context.principalId),
          membershipLockKey(context.tenantId, principalId),
          workspaceMembershipLockKey(
            context.tenantId,
            workspaceId,
            principalId,
          ),
        ]);
        await revalidateAdmin(tx, context);
        const [workspace] = await tx
          .select({ id: enterpriseWorkspaces.id })
          .from(enterpriseWorkspaces)
          .where(
            and(
              eq(enterpriseWorkspaces.tenantId, context.tenantId),
              eq(enterpriseWorkspaces.id, workspaceId),
            ),
          )
          .limit(1);
        if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
        // The target must be an active company member (the FK guarantees the
        // row exists only when the company membership does; the status is the
        // live fact).
        const [companyMembership] = await tx
          .select({ status: enterpriseMemberships.status })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
            ),
          )
          .limit(1);
        if (companyMembership?.status !== "active") {
          // Non-member and unknown principal are deliberately
          // indistinguishable (no existence leak).
          throw new Error("TEAM_MEMBER_NOT_COMPANY_MEMBER");
        }
        // From here the write acts on the target member: switch the pin the
        // MT004 update policy is pinned to.
        await pinTarget(tx, principalId);
        const [existing] = await tx
          .select({
            status: enterpriseWorkspaceMemberships.status,
            epoch: enterpriseWorkspaceMemberships.epoch,
          })
          .from(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, principalId),
            ),
          )
          .limit(1);
        if (existing?.status === "active") {
          throw new Error("TEAM_MEMBER_ALREADY_EXISTS");
        }
        if (existing) {
          const [updated] = await tx
            .update(enterpriseWorkspaceMemberships)
            .set({
              status: "active",
              epoch: sql`${enterpriseWorkspaceMemberships.epoch} + 1`,
            })
            .where(
              and(
                eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
                eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
                eq(enterpriseWorkspaceMemberships.principalId, principalId),
              ),
            )
            .returning({ epoch: enterpriseWorkspaceMemberships.epoch });
          return {
            membership: {
              workspaceId,
              principalId,
              status: "active" as const,
              epoch: updated.epoch,
            },
            outcome: "reactivated" as const,
          };
        }
        const [inserted] = await tx
          .insert(enterpriseWorkspaceMemberships)
          .values({
            tenantId: context.tenantId,
            workspaceId,
            principalId,
          })
          .returning({ epoch: enterpriseWorkspaceMemberships.epoch });
        return {
          membership: {
            workspaceId,
            principalId,
            status: "active" as const,
            epoch: inserted.epoch,
          },
          outcome: "created" as const,
        };
      });
    },

    async suspendTeamMember(context, input) {
      assertTrustedAdminContext(context);
      const workspaceId = input.workspaceId?.trim();
      const principalId = input.principalId?.trim();
      if (!workspaceId || !principalId) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          membershipLockKey(context.tenantId, context.principalId),
          workspaceMembershipLockKey(
            context.tenantId,
            workspaceId,
            principalId,
          ),
        ]);
        await revalidateAdmin(tx, context);
        await pinTarget(tx, principalId);
        const [updated] = await tx
          .update(enterpriseWorkspaceMemberships)
          .set({
            status: "suspended",
            epoch: sql`${enterpriseWorkspaceMemberships.epoch} + 1`,
          })
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, principalId),
              eq(enterpriseWorkspaceMemberships.status, "active"),
            ),
          )
          .returning({ epoch: enterpriseWorkspaceMemberships.epoch });
        if (!updated) throw new Error("TEAM_MEMBER_NOT_FOUND");
        return {
          membership: {
            workspaceId,
            principalId,
            status: "suspended" as const,
            epoch: updated.epoch,
          },
        };
      });
    },

    async removeTeamMember(context, input) {
      assertTrustedAdminContext(context);
      const workspaceId = input.workspaceId?.trim();
      const principalId = input.principalId?.trim();
      if (!workspaceId || !principalId) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          membershipLockKey(context.tenantId, context.principalId),
          workspaceMembershipLockKey(
            context.tenantId,
            workspaceId,
            principalId,
          ),
        ]);
        await revalidateAdmin(tx, context);
        await pinTarget(tx, principalId);
        const removed = await tx
          .delete(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, principalId),
            ),
          )
          .returning({
            principalId: enterpriseWorkspaceMemberships.principalId,
          });
        if (removed.length === 0) {
          throw new Error("TEAM_MEMBER_NOT_FOUND");
        }
        return { removed: true as const };
      });
    },
  };
}
