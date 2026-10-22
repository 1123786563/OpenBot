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
import { recordRevocationAuditEvent } from "./revocation";
import type { AuthenticatedRequestIdentity } from "./store";

// ---------------------------------------------------------------------------
// 信任机制：与 createScopeResolver 的 issuedScopes 同构（WeakSet + freeze）
// ---------------------------------------------------------------------------

const issuedAdminContexts = new WeakSet<object>();
/** The member-context twin of the registry above (same trust mechanism, see resolveMemberContext). */
const issuedMemberContexts = new WeakSet<object>();

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

/**
 * The trust check for member contexts: same shape discipline as the admin one, so a company face
 * (audit, finance, capabilities) can only be handed a context the authorizer itself issued — a
 * hand-built lookalike answers UNVERIFIED_ADMIN_CONTEXT's member twin.
 */
export function assertTrustedMemberContext(
  context: CompanyMemberContext,
): void {
  if (
    !context ||
    typeof context !== "object" ||
    !issuedMemberContexts.has(context)
  ) {
    throw new Error("UNVERIFIED_MEMBER_CONTEXT");
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

/**
 * A member's company context: the same facts the admin context is built from, without the
 * tenant_admin gate (MT096 / Issues #138-#139). The audit face (an auditor is a member, not an
 * admin) and the finance face (a finance reader is a member with an explicit grant) resolve their
 * subject here; the capability answer composes this with each surface's own gate. The role rides
 * along so callers can render server-side facts rather than re-deriving them client-side.
 */
export interface CompanyMemberContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly role: "tenant_admin" | "member" | "auditor";
  readonly memberEpoch: number;
}

export function createCompanyAdminAuthorizer(
  directory: DirectoryDatabase,
  options: CompanyAdminAuthorizerOptions,
): CompanyAdminAuthorizer & {
  /** The member resolution every company face shares (no admin gate; see CompanyMemberContext). */
  resolveMemberContext(request: Request): Promise<CompanyMemberContext>;
} {
  assertDirectoryDatabase(directory);
  return {
    authenticate: (request) => options.authenticate(request),
    async resolveMemberContext(request) {
      const { membership } = await resolveCompanyMembership(
        directory,
        options,
        request,
      );
      const context = Object.freeze(membership);
      issuedMemberContexts.add(context);
      return context;
    },
    async resolveAdminContext(request) {
      const { tenantId, membership } = await resolveCompanyMembership(
        directory,
        options,
        request,
      );
      if (membership.role !== "tenant_admin") {
        throw new Error("TENANT_ADMIN_REQUIRED");
      }
      const context = Object.freeze({
        tenantId,
        principalId: membership.principalId,
        actorId: membership.actorId,
        memberEpoch: membership.memberEpoch,
      } satisfies CompanyAdminContext);
      issuedAdminContexts.add(context);
      return context;
    },
  };
}

/**
 * The membership half both resolvers share: authenticate → select tenant (ruling #1: the header
 * only selects; the row decides) → one directory read of the active-membership facts. Split out
 * so the admin gate and the member faces (audit, finance, capabilities) read the SAME facts and
 * can never drift into two notions of "who is this in this company".
 */
async function resolveCompanyMembership(
  directory: DirectoryDatabase,
  options: CompanyAdminAuthorizerOptions,
  request: Request,
): Promise<{ tenantId: string; membership: CompanyMemberContext }> {
  const identity = await options.authenticate(request);
  if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
  const tenantId = options.selectTenant?.(request);
  if (!tenantId?.trim()) throw new Error("TENANT_REQUIRED");
  const membership = await directory.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level read committed`);
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    await tx.execute(
      sql`select set_config('app.user_id', ${identity.actorId}, true)`,
    );
    const [row] = await tx
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
      row?.tenantStatus !== "active" ||
      row.principalStatus !== "active" ||
      row.memberStatus !== "active"
    ) {
      // Same code as the business resolver: no existence leak.
      throw new Error("TENANT_FORBIDDEN");
    }
    return {
      tenantId,
      principalId: row.principalId,
      actorId: identity.actorId,
      role: row.role as CompanyMemberContext["role"],
      memberEpoch: row.memberEpoch,
    } satisfies CompanyMemberContext;
  });
  return { tenantId, membership };
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

/** MT007（Issue #50）：公司成员关系事实（公司级停用/恢复的返回形状）。 */
export type CompanyMembershipFact = {
  readonly principalId: string;
  readonly status: "active" | "suspended";
  readonly epoch: number;
};

export interface AddTeamMembershipResult {
  readonly membership: TeamMembershipFact;
  /** "created" = fresh row; "reactivated" = suspended row restored. */
  readonly outcome: "created" | "reactivated";
  /** MT007：reactivated（恢复动作）写入的审计事件 id；created 为 null。 */
  readonly auditEventId: string | null;
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
  ): Promise<{
    readonly membership: TeamMembershipFact;
    /** MT007：本次停用的审计事件 id（AC4）。 */
    readonly auditEventId: string;
  }>;
  /** MT007（Issue #50）：恢复被停用的团队成员（suspended → active，epoch+1）。 */
  restoreTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<{
    readonly membership: TeamMembershipFact;
    readonly auditEventId: string;
  }>;
  removeTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<{ readonly removed: true; readonly auditEventId: string }>;
  /** MT007（Issue #50）：公司级停用——该公司全部团队权限级联失效（AC2）。 */
  suspendCompanyMember(
    context: CompanyAdminContext,
    input: { readonly principalId: string },
  ): Promise<{
    readonly membership: CompanyMembershipFact;
    readonly auditEventId: string;
  }>;
  /** MT007（Issue #50）：公司级恢复——权限按当前策略重新生效（AC3）。 */
  restoreCompanyMember(
    context: CompanyAdminContext,
    input: { readonly principalId: string },
  ): Promise<{
    readonly membership: CompanyMembershipFact;
    readonly auditEventId: string;
  }>;
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
          // MT007（AC4）：重新激活是一次恢复动作，与显式 restore 同样留痕。
          const auditEventId = await recordRevocationAuditEvent(tx, {
            eventType: "workspace_member.restored",
            tenantId: context.tenantId,
            operatorPrincipalId: context.principalId,
            operatorUserId: context.actorId,
            targetPrincipalId: principalId,
            workspaceId,
            epoch: updated.epoch,
          });
          return {
            membership: {
              workspaceId,
              principalId,
              status: "active" as const,
              epoch: updated.epoch,
            },
            outcome: "reactivated" as const,
            auditEventId,
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
          auditEventId: null,
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
        // MT007（AC4）：每次停用写入审计（操作者/对象/范围/版本/时间）。
        const auditEventId = await recordRevocationAuditEvent(tx, {
          eventType: "workspace_member.suspended",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          workspaceId,
          epoch: updated.epoch,
        });
        return {
          membership: {
            workspaceId,
            principalId,
            status: "suspended" as const,
            epoch: updated.epoch,
          },
          auditEventId,
        };
      });
    },

    async restoreTeamMember(context, input) {
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
            status: "active",
            epoch: sql`${enterpriseWorkspaceMemberships.epoch} + 1`,
          })
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
              eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
              eq(enterpriseWorkspaceMemberships.principalId, principalId),
              eq(enterpriseWorkspaceMemberships.status, "suspended"),
            ),
          )
          .returning({ epoch: enterpriseWorkspaceMemberships.epoch });
        if (!updated) throw new Error("TEAM_MEMBER_NOT_FOUND");
        // MT007（AC3/AC4）：恢复也是一次成员关系版本变更，同样留痕；
        // 权限按当前策略重新生效由事实行驱动，服务面无任何拒绝缓存。
        const auditEventId = await recordRevocationAuditEvent(tx, {
          eventType: "workspace_member.restored",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          workspaceId,
          epoch: updated.epoch,
        });
        return {
          membership: {
            workspaceId,
            principalId,
            status: "active" as const,
            epoch: updated.epoch,
          },
          auditEventId,
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
        // MT007：删除前带回该行最后的 epoch——撤权审计的版本事实。
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
            epoch: enterpriseWorkspaceMemberships.epoch,
          });
        if (removed.length === 0) {
          throw new Error("TEAM_MEMBER_NOT_FOUND");
        }
        // MT007（AC4）：每次撤权（移除）写入审计；版本为被删行最后的 epoch。
        const auditEventId = await recordRevocationAuditEvent(tx, {
          eventType: "workspace_member.removed",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          workspaceId,
          epoch: removed[0].epoch,
        });
        return { removed: true as const, auditEventId };
      });
    },

    async suspendCompanyMember(context, input) {
      assertTrustedAdminContext(context);
      const principalId = input.principalId?.trim();
      if (!principalId) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        // 键序与既有面一致：tenant → membership（admin → 目标）；公司级
        // 写与 MT005 gate 的 membership 共享锁同键串行化（级联立即生效）。
        await takeLocks(tx, [
          JSON.stringify(["enterprise", "tenant", context.tenantId]),
          membershipLockKey(context.tenantId, context.principalId),
          membershipLockKey(context.tenantId, principalId),
        ]);
        await revalidateAdmin(tx, context);
        await pinTarget(tx, principalId);
        const [updated] = await tx
          .update(enterpriseMemberships)
          .set({
            status: "suspended",
            epoch: sql`${enterpriseMemberships.epoch} + 1`,
          })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
              eq(enterpriseMemberships.status, "active"),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (!updated) throw new Error("COMPANY_MEMBER_NOT_FOUND");
        // MT007（AC2/AC4）：公司级停用——一次事实变更级联失效该公司全部
        // 团队权限；其他公司资格不动。审计与停用同一事务原子落库。
        const auditEventId = await recordRevocationAuditEvent(tx, {
          eventType: "company_member.suspended",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch: updated.epoch,
        });
        return {
          membership: {
            principalId,
            status: "suspended" as const,
            epoch: updated.epoch,
          },
          auditEventId,
        };
      });
    },

    async restoreCompanyMember(context, input) {
      assertTrustedAdminContext(context);
      const principalId = input.principalId?.trim();
      if (!principalId) {
        throw new Error("INVALID_REQUEST");
      }
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${context.principalId}, true)`,
        );
        await takeLocks(tx, [
          JSON.stringify(["enterprise", "tenant", context.tenantId]),
          membershipLockKey(context.tenantId, context.principalId),
          membershipLockKey(context.tenantId, principalId),
        ]);
        await revalidateAdmin(tx, context);
        await pinTarget(tx, principalId);
        const [updated] = await tx
          .update(enterpriseMemberships)
          .set({
            status: "active",
            epoch: sql`${enterpriseMemberships.epoch} + 1`,
          })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
              eq(enterpriseMemberships.status, "suspended"),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (!updated) throw new Error("COMPANY_MEMBER_NOT_FOUND");
        // MT007（AC3/AC4）：恢复推进版本（epoch+1）——旧 Scope 的拒绝来自
        // 实时 epoch 事实（策略），非缓存；新签发 Scope 立即恢复全部权限。
        const auditEventId = await recordRevocationAuditEvent(tx, {
          eventType: "company_member.restored",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch: updated.epoch,
        });
        return {
          membership: {
            principalId,
            status: "active" as const,
            epoch: updated.epoch,
          },
          auditEventId,
        };
      });
    },
  };
}
