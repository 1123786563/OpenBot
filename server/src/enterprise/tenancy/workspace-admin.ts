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

import type {
  ScopeListing,
  ScopeListingCompany,
  SelectionInput,
  ValidatedSelection,
} from "@openbot/shared/auth-directory";
import { and, eq, sql } from "drizzle-orm";
import type { CompanyAssurance } from "../../auth/company-assurance";
import type { DirectoryAuthority } from "../../auth/directory/authority";
import {
  type DirectoryTransitionReport,
  MEMBERSHIP_LIFECYCLE_PAUSED,
  type MembershipAdminTranslationPort,
  translateMembershipLifecycle,
} from "../../auth/directory/membership";
import type { Database } from "../../db/client";
import {
  authMembers,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
} from "../../db/schema/auth-directory";
import { billingCompanyFinanceGrants } from "../../db/schema/company-finance";
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

/**
 * The provenance extension a translated (ba-branch) team-member report
 * carries (T04.08 / #552, P09): the legacy fields stay the post-command facts,
 * and these four name the directory transition that produced them — the same
 * discipline T04.03's DirectoryTransitionReport set for company-member
 * commands, narrowed to the two team operations this entrance translates
 * (DirectoryTransitionReport's operation union is the company-member
 * vocabulary and lives in a file this ticket does not own).
 */
export interface TeamDirectoryTransition {
  readonly via: "directory";
  readonly operation: "team.member.add" | "team.member.remove";
  readonly commandId: string;
  readonly replayed: boolean;
}

export interface WorkspaceAdminService {
  createTeam(
    context: CompanyAdminContext,
    input: { readonly name: string; readonly workspaceId?: string },
  ): Promise<CreatedTeam>;
  addTeamMember(
    context: CompanyAdminContext,
    input: { readonly workspaceId: string; readonly principalId: string },
  ): Promise<AddTeamMembershipResult & Partial<TeamDirectoryTransition>>;
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
  ): Promise<
    {
      readonly removed: true;
      readonly auditEventId: string;
    } & Partial<TeamDirectoryTransition>
  >;
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
  membership?: MembershipAdminTranslationPort,
): WorkspaceAdminService {
  assertOperatorDatabase(operator);
  type Tx = Parameters<Parameters<OperatorDatabase["transaction"]>[0]>[0];

  /**
   * The T04.03 authority branch for the company-member pair (ticket step 5):
   * legacy keeps the original operator path below; paused answers the one
   * 503; ba translates the write into ONE directory command (suspend or
   * restore) and shapes the legacy report from the committed projection
   * facts, extended with the directory provenance. Null means legacy.
   */
  const translatedCompanyMemberOrNull = async (
    context: CompanyAdminContext,
    principalId: string,
    operation: "member.suspend" | "member.restore",
    stateGate: (member: {
      readonly role: string;
      readonly status: string;
    }) => boolean,
  ): Promise<
    | ({
        readonly membership: CompanyMembershipFact;
        readonly auditEventId: string;
      } & DirectoryTransitionReport)
    | null
  > => {
    if (!membership) return null;
    const mode = await membership.modeOf();
    if (mode === "legacy") return null;
    if (mode === "paused") throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);
    const facts = await translateMembershipLifecycle(membership, {
      actorUserId: context.actorId,
      tenantId: context.tenantId,
      principalId,
      operation,
      payloadOf: (userId) => ({
        userId,
        reason:
          operation === "member.suspend"
            ? "company_admin_suspend"
            : "company_admin_restore",
      }),
      stateGate,
    });
    return {
      membership: {
        principalId,
        status: facts.after.status as "suspended" | "active",
        epoch: facts.after.epoch,
      },
      auditEventId: facts.auditEventId,
      via: "directory",
      operation,
      commandId: facts.commandId,
      replayed: facts.replayed,
    };
  };

  /**
   * The T04.08 (#552, P09) authority branch for the team-member pair: legacy
   * keeps the original operator path below; paused answers the one 503; ba
   * translates the write into ONE directory command (team.member.add /
   * team.member.remove) and shapes the legacy report from the committed
   * facts, extended with the directory provenance. The path/body parameter
   * stays the OpenBot business principalId — the translation port's
   * memberOf resolves it through the principal binding to the BA userId the
   * command payload names (the client never hands a BA member.id/userId);
   * the command's own locked discrimination re-verifies the caller's
   * company-role inside the tenant lock, so this entrance never asserts
   * authority itself. Null means legacy.
   */
  const translatedTeamMemberOrNull = async (
    context: CompanyAdminContext,
    workspaceId: string,
    principalId: string,
    operation: "team.member.add" | "team.member.remove",
  ): Promise<
    | ((AddTeamMembershipResult | { removed: true; auditEventId: string }) &
        TeamDirectoryTransition)
    | null
  > => {
    if (!membership) return null;
    const mode = await membership.modeOf();
    if (mode === "legacy") return null;
    if (mode === "paused") throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);
    const target = await membership.memberOf({
      tenantId: context.tenantId,
      principalId,
    });
    // Invisible not-found, mirroring the legacy entrances: add names the
    // company-member gate (TEAM_MEMBER_NOT_COMPANY_MEMBER), remove the missing
    // seat (TEAM_MEMBER_NOT_FOUND); another company's principal answers
    // exactly like a fabricated id.
    if (!target) {
      throw new Error(
        operation === "team.member.add"
          ? "TEAM_MEMBER_NOT_COMPANY_MEMBER"
          : "TEAM_MEMBER_NOT_FOUND",
      );
    }
    if (operation === "team.member.add" && target.status !== "active") {
      // The legacy add gate: only an active company member takes a seat. The
      // directory handler re-verifies the same fact inside the lock.
      throw new Error("TEAM_MEMBER_NOT_COMPANY_MEMBER");
    }
    const result = await membership.execute(
      membership.actorOf(context.actorId),
      {
        operation,
        tenantId: context.tenantId,
        idempotencyKey: crypto.randomUUID(),
        payload: { workspaceId, userId: target.userId },
      },
    );
    const auditEventId = await membership.auditEventIdOf({
      tenantId: context.tenantId,
      commandId: result.commandId,
    });
    if (!auditEventId) {
      // The finalizer writes the audit fact in the command's own transaction:
      // a missing row is an invariant break, never a silently skipped trail.
      throw new Error(
        "MEMBERSHIP_TRANSLATION_AUDIT_MISSING: the translated team-member command has no directory.command.finalized audit row; the audit write must never fold into success",
      );
    }
    const provenance: TeamDirectoryTransition = {
      via: "directory",
      operation,
      commandId: result.commandId,
      replayed: result.replayed,
    };
    if (operation === "team.member.remove") {
      return { removed: true as const, auditEventId, ...provenance };
    }
    const teamKey = result.versions.find(
      (version) =>
        version.key.kind === "team" &&
        version.key.scopeId === workspaceId &&
        version.key.principalId === principalId,
    );
    if (!teamKey) {
      throw new Error(
        "TEAM_MEMBER_TRANSLATION_VERSION_MISSING: the committed team.member.add produced no team change key for the target; the receipt's versions are the report's only honest epoch source",
      );
    }
    return {
      membership: {
        workspaceId,
        principalId,
        status: "active" as const,
        epoch: teamKey.value.epoch,
      },
      // The BA team pair is existence-only: a fresh seat is always "created";
      // the legacy "reactivated" shape belongs to the legacy projection row.
      outcome: "created" as const,
      auditEventId,
      ...provenance,
    };
  };

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
      const translated = await translatedTeamMemberOrNull(
        context,
        workspaceId,
        principalId,
        "team.member.add",
      );
      if (translated) {
        return translated as AddTeamMembershipResult &
          Partial<TeamDirectoryTransition>;
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
      const translated = await translatedTeamMemberOrNull(
        context,
        workspaceId,
        principalId,
        "team.member.remove",
      );
      if (translated) {
        return translated as {
          removed: true;
          auditEventId: string;
        } & Partial<TeamDirectoryTransition>;
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
      const translated = await translatedCompanyMemberOrNull(
        context,
        principalId,
        "member.suspend",
        // The legacy rule: only an active company membership suspends.
        (member) => member.status === "active",
      );
      if (translated) return translated;
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
      const translated = await translatedCompanyMemberOrNull(
        context,
        principalId,
        "member.restore",
        // The legacy rule: only a suspended company membership restores.
        (member) => member.status === "suspended",
      );
      if (translated) return translated;
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

// ---------------------------------------------------------------------------
// 3. BA 范围列出与选择校验（T03.02 / #539，interfaces §4）
// ---------------------------------------------------------------------------

/*
 * The read half of interfaces §4 this Issue owns: `listEligibleScopes` (the
 * §4 ScopeListing) and `validate-selection` (SelectionInput →
 * ValidatedSelection), served on the same workspace-scope entrance the legacy
 * lister answers. The contract shape lives in `shared/auth-directory.ts`; this
 * section is the behaviour.
 *
 * Authority first, read inside the service's own short transaction (the same
 * discipline the T03.01 gate and the T02.11 read gate hold): under legacy
 * (M0/M1) and paused (M2/M3) the ba-v1 DTO is NOT advertised — `list` answers
 * null so the route keeps serving the legacy DTO byte-for-byte, and
 * `validate` refuses with the authority's own 503 family. Only under ba
 * (M4..M7) does the §4 answer exist, assembled from the facts every other ba
 * face reads: the live identity (an unsafe or missing identityGeneration is
 * "cannot compare", never a default), the BA member row, the business
 * projection, the company lifecycle and the durable two-layer clocks — a
 * company or team whose clock is missing or tombstoned is hidden, exactly the
 * way the read gate closes it.
 *
 * Selection semantics (§4): the explicit SelectionInput decides — it outranks
 * every active-session preference, and a selector header that disagrees with
 * it is the 400 SCOPE_SELECTOR_CONFLICT. A hidden object answers 404 with one
 * code for "not a member", "suspended" and "does not exist" alike, so nothing
 * about other companies leaks; the one deliberate exception is the mixed
 * company/team pair both drawn from the caller's own current listing — that
 * client-side assembly error answers 400, not 404. Company management never
 * requires team membership: `company:manage` rides the company role alone.
 *
 * Capabilities are the closed first-phase vocabulary of
 * `shared/auth-directory.ts`, derived only from directory facts (the BA role
 * row plus the projection's auditor fact). `finance:read` is deliberately
 * never derived here: the grant table is structurally isolated from the
 * directory roles (company-finance.ts pins zero privileges and the suite
 * proves it), so a listing that claimed it would be inventing authorization —
 * the finance face checks its own grant at use time.
 */

/** The refusal this surface answers with. Codes are closed; statuses are the §4 projection. */
export class BaSelectionRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    readonly status: 400 | 401 | 403 | 404 | 503,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BaSelectionRefusal";
  }
}

export function isBaSelectionRefusal(
  error: unknown,
): error is BaSelectionRefusal {
  return error instanceof BaSelectionRefusal;
}

/** The stable refusal codes of the BA selection surface (§4 projection). */
export const BA_SELECTION_INPUT_INVALID = "BA_SELECTION_INPUT_INVALID";
export const SCOPE_SELECTOR_CONFLICT = "SCOPE_SELECTOR_CONFLICT";
export const BA_SELECTION_NOT_FOUND = "BA_SELECTION_NOT_FOUND";
export const BA_SELECTION_IDENTITY_SUSPENDED =
  "BA_SELECTION_IDENTITY_SUSPENDED";
export const BA_SELECTION_AUTHORITY_CLOSED = "BA_SELECTION_AUTHORITY_CLOSED";

/** The required dependencies of the BA selection service (T03.02, T03.01 discipline). */
export interface BaScopeSelectionOptions {
  /** Reads the durable eligibility clocks via `auth_read_eligibility_clocks`. */
  readonly data: Database;
  /** Read inside the service's own transaction; never a cached branch. */
  readonly authority: Pick<DirectoryAuthority, "read">;
  /** Asked inside the ba branch's validation transaction only; discovery never asks. */
  readonly assurance: CompanyAssurance;
}

export interface BaScopeSelectionService {
  /**
   * The §4 listing under ba authority, or null when the ba-v1 DTO is not
   * advertised (legacy/paused) — the caller then keeps the legacy DTO.
   * Authority read failures propagate (503), never a silent legacy fallback.
   */
  list(identity: AuthenticatedRequestIdentity): Promise<ScopeListing | null>;
  /**
   * Validates one explicit selection and returns the §4 ValidatedSelection.
   * `selectors` carries the request's selector headers (intent only): one
   * that disagrees with the input is the 400 SCOPE_SELECTOR_CONFLICT.
   */
  validate(
    identity: AuthenticatedRequestIdentity,
    input: SelectionInput,
    selectors?: Readonly<{
      tenantId?: string | null;
      workspaceId?: string | null;
    }>,
  ): Promise<ValidatedSelection>;
}

/** Drizzle execute results arrive as rows or wrapped rows depending on driver shape. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/** A `Version` a reader may compare: a non-negative safe integer, never a default. */
function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createBaScopeSelectionService(
  database: Database,
  options: BaScopeSelectionOptions,
): BaScopeSelectionService {
  if (!database || typeof database.transaction !== "function") {
    throw new Error(
      "BA_SELECTION_DEPS_REQUIRED: createBaScopeSelectionService needs the directory connection the selection facts are read through",
    );
  }
  if (!options?.data) {
    throw new Error(
      "BA_SELECTION_DEPS_REQUIRED: createBaScopeSelectionService needs the data connection the durable eligibility clocks are read through",
    );
  }
  if (typeof options?.authority?.read !== "function") {
    throw new Error(
      "BA_SELECTION_DEPS_REQUIRED: createBaScopeSelectionService needs the directory authority port — without an in-transaction authority read the service cannot tell a ba answer from a legacy one, and an optional port is the bypass interfaces §3.3 forbids",
    );
  }
  if (typeof options?.assurance?.require !== "function") {
    throw new Error(
      "BA_SELECTION_DEPS_REQUIRED: createBaScopeSelectionService needs the company assurance port — an optional proof dependency is exactly the bypass interfaces §5 forbids",
    );
  }
  const authority = options.authority;
  const assurance = options.assurance;
  const data = options.data;

  /** What a selection id may contain (the tenancy id shape the routes enforce). */
  const SELECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

  function refuse(
    code: string,
    detail: string,
    status: 400 | 401 | 403 | 404 | 503,
  ): BaSelectionRefusal {
    return new BaSelectionRefusal(code, detail, status);
  }

  function requireSelectionId(value: unknown, field: string): string {
    if (typeof value !== "string" || !SELECTION_ID_PATTERN.test(value)) {
      throw refuse(
        BA_SELECTION_INPUT_INVALID,
        `${field} must be a well-formed stable id; a malformed selection is refused rather than matched`,
        400,
      );
    }
    return value;
  }

  /**
   * The server actor the proof question is asked for: the selection is an
   * explicit intent of a verified identity, so the actor carries no session
   * (the closed adapter ignores it; P11 owns the real session binding).
   */
  function selectionActor(
    identity: AuthenticatedRequestIdentity,
  ): Parameters<CompanyAssurance["require"]>[1] {
    return Object.freeze({
      userId: identity.actorId,
      principalId: null,
      sessionId: null,
      kind: "platform" as const,
      bindingId: null,
      provisioning: null,
    });
  }

  /**
   * The live global identity a ba-branch answer needs: an existing principal,
   * active, with a comparable identityGeneration. A missing principal hides
   * every company (404, no existence leak); a suspended one or an unsafe
   * generation is an identity problem (403), exactly the read gate's split.
   */
  async function requireLiveIdentity(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    actorId: string,
  ): Promise<{ id: string; generation: number }> {
    const [principal] = await tx
      .select({
        id: enterprisePrincipals.id,
        status: enterprisePrincipals.status,
        identityGeneration: enterprisePrincipals.identityGeneration,
      })
      .from(enterprisePrincipals)
      .where(eq(enterprisePrincipals.userId, actorId))
      .limit(1);
    if (!principal) {
      throw refuse(
        BA_SELECTION_NOT_FOUND,
        "the actor holds no principal; the directory hides what it cannot serve",
        404,
      );
    }
    if (
      principal.status !== "active" ||
      !isSafeVersion(principal.identityGeneration)
    ) {
      // A NULL generation is "cannot compare" — closed, never guessed.
      throw refuse(
        BA_SELECTION_IDENTITY_SUSPENDED,
        "the identity behind the selection is suspended or carries no comparable generation",
        403,
      );
    }
    return { id: principal.id, generation: principal.identityGeneration };
  }

  /**
   * One company's live membership facts: the tenant lifecycle, the BA
   * organization and member rows, and the business projection — the same
   * facts the ba gate and the read gate prove. Any failure is the one hidden
   * code: nothing about which fact failed leaves the service.
   */
  async function readCompanyFacts(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    actorId: string,
    principalId: string,
    tenantId: string,
  ): Promise<{ baRole: string | null; projectionRole: string | null }> {
    const [company] = await tx
      .select({
        tenantStatus: enterpriseTenants.status,
        membershipStatus: enterpriseMemberships.status,
        projectionRole: enterpriseMemberships.role,
        baRole: authMembers.role,
      })
      .from(authMembers)
      .innerJoin(
        enterpriseTenants,
        eq(enterpriseTenants.id, authMembers.organizationId),
      )
      .innerJoin(
        authOrganizations,
        eq(authOrganizations.id, authMembers.organizationId),
      )
      .innerJoin(
        enterpriseMemberships,
        and(
          eq(enterpriseMemberships.tenantId, authMembers.organizationId),
          eq(enterpriseMemberships.principalId, principalId),
        ),
      )
      .where(
        and(
          eq(authMembers.organizationId, tenantId),
          eq(authMembers.userId, actorId),
        ),
      )
      .limit(1);
    if (
      company?.tenantStatus !== "active" ||
      company.membershipStatus !== "active"
    ) {
      throw refuse(
        BA_SELECTION_NOT_FOUND,
        "the company is not visible to this actor",
        404,
      );
    }
    return {
      baRole: company.baRole,
      projectionRole: company.projectionRole,
    };
  }

  /**
   * One team's live facts under the named company: the stable binding, the BA
   * team-member row and the active business projection. A pair that does not
   * exist here is either a mixed selection (the workspace is one of the
   * actor's teams in ANOTHER company they can see — the 400 a client
   * assembled from two listings) or a hidden object (404); the two are
   * deliberately not interchangeable.
   */
  async function readTeamFacts(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    actorId: string,
    principalId: string,
    tenantId: string,
    workspaceId: string,
  ): Promise<{ teamId: string }> {
    const [team] = await tx
      .select({
        teamId: authTeamBindings.teamId,
        workspaceStatus: enterpriseWorkspaceMemberships.status,
      })
      .from(authTeamBindings)
      .innerJoin(
        authTeamMembers,
        and(
          eq(authTeamMembers.teamId, authTeamBindings.teamId),
          eq(authTeamMembers.userId, actorId),
        ),
      )
      .innerJoin(
        enterpriseWorkspaceMemberships,
        and(
          eq(
            enterpriseWorkspaceMemberships.tenantId,
            authTeamBindings.tenantId,
          ),
          eq(
            enterpriseWorkspaceMemberships.workspaceId,
            authTeamBindings.workspaceId,
          ),
          eq(enterpriseWorkspaceMemberships.principalId, principalId),
        ),
      )
      .where(
        and(
          eq(authTeamBindings.tenantId, tenantId),
          eq(authTeamBindings.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (team?.workspaceStatus === "active") {
      return { teamId: team.teamId };
    }
    // The pair is not live here. Is the workspace one of the actor's teams in
    // another company they can see? Then the pair is a mixed selection.
    const [elsewhere] = await tx
      .select({ tenantId: authTeamBindings.tenantId })
      .from(authTeamBindings)
      .innerJoin(
        authTeamMembers,
        and(
          eq(authTeamMembers.teamId, authTeamBindings.teamId),
          eq(authTeamMembers.userId, actorId),
        ),
      )
      .where(eq(authTeamBindings.workspaceId, workspaceId))
      .limit(1);
    if (elsewhere) {
      try {
        await readCompanyFacts(tx, actorId, principalId, elsewhere.tenantId);
        throw refuse(
          SCOPE_SELECTOR_CONFLICT,
          "the workspace belongs to another company the caller is a member of; a mixed company/team selection is refused",
          400,
        );
      } catch (error) {
        if (
          isBaSelectionRefusal(error) &&
          error.code === SCOPE_SELECTOR_CONFLICT
        ) {
          throw error;
        }
      }
    }
    throw refuse(
      BA_SELECTION_NOT_FOUND,
      "the team is not visible to this actor",
      404,
    );
  }

  /**
   * The durable two-layer clocks for one (tenant, principal), read through
   * the data connection's controlled function — the one privilege a runtime
   * role holds on the clocks.
   */
  async function readClocks(
    tenantId: string,
    principalId: string,
  ): Promise<{
    company?: { epoch: number; generation: number; tombstone: boolean };
    teams: {
      scopeId: string;
      epoch: number;
      generation: number;
      tombstone: boolean;
    }[];
  }> {
    const rows = rowsOf(
      await data.execute(
        sql`select kind, scope_id, epoch::text as epoch, generation::text as generation, tombstone
              from auth_read_eligibility_clocks(${tenantId}, ${principalId})`,
      ),
    );
    const clocks: {
      kind: string;
      scopeId: string;
      epoch: number;
      generation: number;
      tombstone: boolean;
    }[] = [];
    for (const row of rows) {
      const epoch = Number(row.epoch);
      const generation = Number(row.generation);
      if (!isSafeVersion(epoch) || !isSafeVersion(generation)) continue;
      clocks.push({
        kind: String(row.kind),
        scopeId: String(row.scope_id),
        epoch,
        generation,
        tombstone: row.tombstone === true,
      });
    }
    const company = clocks.find(
      (clock) => clock.kind === "company" && clock.scopeId === tenantId,
    );
    return {
      company,
      teams: clocks.filter((clock) => clock.kind === "team"),
    };
  }

  /**
   * The closed first-phase capabilities, derived from facts only (interfaces
   * §4 按实际授权返回). The role carries company:manage and team:members:manage
   * for the company administrator (owner/admin) and audit:metadata:read for an
   * administrator or auditor; `finance:read` never rides a role — it answers
   * the same fact `assertCompanyFinanceReader` gates on: an explicit finance
   * read grant row for this member.
   */
  function capabilitiesFor(
    baRole: string | null,
    projectionRole: string | null,
    financeReader: boolean,
  ): readonly string[] {
    const capabilities: string[] = [];
    if (baRole === "owner" || baRole === "admin") {
      capabilities.push(
        "company:manage",
        "team:members:manage",
        "audit:metadata:read",
      );
    } else if (baRole === "auditor" || projectionRole === "auditor") {
      capabilities.push("audit:metadata:read");
    }
    if (financeReader) {
      capabilities.push("finance:read");
    }
    return Object.freeze(capabilities);
  }

  function directoryRoleFor(
    baRole: string | null,
    projectionRole: string | null,
  ): "owner" | "admin" | "member" | "auditor" {
    if (baRole === "owner") return "owner";
    if (baRole === "admin") return "admin";
    if (baRole === "auditor" || projectionRole === "auditor") return "auditor";
    return "member";
  }

  const service: BaScopeSelectionService = {
    async list(identity) {
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      // Directory transaction: the actor's own membership facts, visible
      // through the self-read RLS policies pinned to app.user_id.
      const facts = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true)`,
        );
        const state = await authority.read(tx);
        if (state.directoryAuthority !== "ba") return null;
        const principal = await requireLiveIdentity(tx, identity.actorId).catch(
          (error: unknown) => {
            // A hidden or unusable identity lists nothing — the explicit
            // empty state, the same answer the legacy lister gives a user
            // with no eligible memberships.
            if (isBaSelectionRefusal(error)) return null;
            throw error;
          },
        );
        if (!principal) return { principalId: null, companies: [], teams: [] };
        const companies = await tx
          .select({
            tenantId: authMembers.organizationId,
            tenantStatus: enterpriseTenants.status,
            orgName: authOrganizations.name,
            membershipStatus: enterpriseMemberships.status,
            projectionRole: enterpriseMemberships.role,
            baRole: authMembers.role,
          })
          .from(authMembers)
          .innerJoin(
            enterpriseTenants,
            eq(enterpriseTenants.id, authMembers.organizationId),
          )
          .innerJoin(
            authOrganizations,
            eq(authOrganizations.id, authMembers.organizationId),
          )
          .innerJoin(
            enterpriseMemberships,
            and(
              eq(enterpriseMemberships.tenantId, authMembers.organizationId),
              eq(enterpriseMemberships.principalId, principal.id),
            ),
          )
          .where(eq(authMembers.userId, identity.actorId));
        const teams = await tx
          .select({
            tenantId: authTeams.organizationId,
            teamId: authTeams.id,
            teamName: authTeams.name,
            workspaceId: authTeamBindings.workspaceId,
            workspaceStatus: enterpriseWorkspaceMemberships.status,
          })
          .from(authTeamMembers)
          .innerJoin(authTeams, eq(authTeams.id, authTeamMembers.teamId))
          .innerJoin(
            authTeamBindings,
            eq(authTeamBindings.teamId, authTeams.id),
          )
          .innerJoin(
            enterpriseWorkspaceMemberships,
            and(
              eq(
                enterpriseWorkspaceMemberships.tenantId,
                authTeamBindings.tenantId,
              ),
              eq(
                enterpriseWorkspaceMemberships.workspaceId,
                authTeamBindings.workspaceId,
              ),
              eq(enterpriseWorkspaceMemberships.principalId, principal.id),
            ),
          )
          .where(eq(authTeamMembers.userId, identity.actorId));
        // The finance capability answers the same fact the books' own gate
        // does: an explicit finance read grant row for this member. The grant
        // never rides a role — an administrator without a row is not one.
        const financeReaders = await tx
          .select({ tenantId: billingCompanyFinanceGrants.tenantId })
          .from(billingCompanyFinanceGrants)
          .where(eq(billingCompanyFinanceGrants.principalId, principal.id));
        return {
          principalId: principal.id,
          companies,
          teams,
          financeTenants: new Set(financeReaders.map((row) => row.tenantId)),
        };
      });
      // A non-ba authority advertises nothing: the caller keeps the legacy DTO.
      if (facts === null) return null;
      if (facts.principalId === null) return Object.freeze({ companies: [] });
      const companies: ScopeListingCompany[] = [];
      const companyList = facts.companies
        .filter(
          (company) =>
            company.tenantStatus === "active" &&
            company.membershipStatus === "active",
        )
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId));
      for (const company of companyList) {
        const clocks = await readClocks(company.tenantId, facts.principalId);
        if (!clocks.company || clocks.company.tombstone) continue;
        const teams = facts.teams
          .filter(
            (team) =>
              team.tenantId === company.tenantId &&
              team.workspaceStatus === "active",
          )
          .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
          .flatMap((team) => {
            const clock = clocks.teams.find(
              (candidate) => candidate.scopeId === team.workspaceId,
            );
            if (!clock || clock.tombstone) return [];
            return [
              Object.freeze({
                workspaceId: team.workspaceId,
                teamId: team.teamId,
                name: team.teamName,
                workspaceMemberEpoch: clock.epoch,
                teamGeneration: clock.generation,
              }),
            ];
          });
        companies.push(
          Object.freeze({
            tenantId: company.tenantId,
            organizationId: company.tenantId,
            name: company.orgName,
            memberEpoch: clocks.company.epoch,
            companyGeneration: clocks.company.generation,
            role: directoryRoleFor(company.baRole, company.projectionRole),
            capabilities: capabilitiesFor(
              company.baRole,
              company.projectionRole,
              facts.financeTenants.has(company.tenantId),
            ),
            teams: Object.freeze(teams),
          }),
        );
      }
      return Object.freeze({ companies: Object.freeze(companies) });
    },

    async validate(identity, input, selectors) {
      if (!identity?.actorId) throw new Error("AUTH_REQUIRED");
      const tenantId = requireSelectionId(input?.tenantId, "tenantId");
      const workspaceId = requireSelectionId(input?.workspaceId, "workspaceId");
      // Selector headers are intent only: one that disagrees with the
      // explicit selection is the closed conflict, never a silent override.
      const headerTenant = selectors?.tenantId?.trim() ?? "";
      const headerWorkspace = selectors?.workspaceId?.trim() ?? "";
      if (headerTenant !== "" && headerTenant !== tenantId) {
        throw refuse(
          SCOPE_SELECTOR_CONFLICT,
          "the explicit selection and the tenant selector header disagree",
          400,
        );
      }
      if (headerWorkspace !== "" && headerWorkspace !== workspaceId) {
        throw refuse(
          SCOPE_SELECTOR_CONFLICT,
          "the explicit selection and the workspace selector header disagree",
          400,
        );
      }
      const facts = await database.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${identity.actorId}, true)`,
        );
        const state = await authority.read(tx);
        if (state.directoryAuthority === "legacy") {
          throw refuse(
            BA_SELECTION_AUTHORITY_CLOSED,
            "the directory authority is legacy: the ba-v1 selection contract is not advertised in this phase",
            503,
          );
        }
        if (state.directoryAuthority === "paused") {
          throw refuse(
            "DIRECTORY_MIGRATION_PAUSED",
            "the directory is paused for the backfill; selection validation resumes when the authority reaches ba",
            503,
          );
        }
        const principal = await requireLiveIdentity(tx, identity.actorId);
        const company = await readCompanyFacts(
          tx,
          identity.actorId,
          principal.id,
          tenantId,
        );
        const team = await readTeamFacts(
          tx,
          identity.actorId,
          principal.id,
          tenantId,
          workspaceId,
        );
        // The additional company proof, in this same transaction.
        await assurance.require(tx, selectionActor(identity), tenantId);
        const [financeGrant] = await tx
          .select({ tenantId: billingCompanyFinanceGrants.tenantId })
          .from(billingCompanyFinanceGrants)
          .where(
            and(
              eq(billingCompanyFinanceGrants.tenantId, tenantId),
              eq(billingCompanyFinanceGrants.principalId, principal.id),
            ),
          )
          .limit(1);
        return {
          principalId: principal.id,
          company,
          team,
          financeReader: financeGrant !== undefined,
        };
      });
      const clocks = await readClocks(tenantId, facts.principalId);
      const companyClock = clocks.company;
      const teamClock = clocks.teams.find(
        (clock) => clock.scopeId === workspaceId,
      );
      if (
        !companyClock ||
        companyClock.tombstone ||
        !teamClock ||
        teamClock.tombstone
      ) {
        throw refuse(
          BA_SELECTION_NOT_FOUND,
          "the durable eligibility versions cannot be compared; the selection is hidden",
          404,
        );
      }
      return Object.freeze({
        tenantId,
        workspaceId,
        organizationId: tenantId,
        teamId: facts.team.teamId,
        memberEpoch: companyClock.epoch,
        workspaceMemberEpoch: teamClock.epoch,
        companyGeneration: companyClock.generation,
        teamGeneration: teamClock.generation,
        capabilities: capabilitiesFor(
          facts.company.baRole,
          facts.company.projectionRole,
          facts.financeReader,
        ),
      });
    },
  };
  return Object.freeze(service);
}
