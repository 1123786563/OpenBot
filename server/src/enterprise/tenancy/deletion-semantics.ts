// server/src/enterprise/tenancy/deletion-semantics.ts
// MT067（Issue #110）：退出/清理某公司数据 与 独立授权的全局账号删除 是两个
// 不同操作——双轨删除语义域。
//
// 结构性分离（票面验收 2 的"不能被触发"）：
//   - Track A（公司清理）只收受信 CompanyAdminContext（MT006 签发半边的消
//     费方；API 没有租户参数），模块不 import §9 删除标记面（openmuse-
//     account-deletion store/表）——公司管理动作在结构上写不出全局删除标
//     记，也触碰不到 users/principals 全局身份行。
//   - Track B（全局删除）是独立服务，签名只收 {userId, confirmation}——
//     API 形状上不存在 admin 上下文参数；显式确认短语逐字比对，错/缺一律
//     GLOBAL_DELETION_CONFIRMATION_REQUIRED 且零写入。fence 消费真实 §9
//     store（insert-once 标记先行，§9 语义：fence 不依赖 cleanup）。
//
// Track A 事务纪律（与 MT076 逐字同构）：assertTrustedAdminContext → read
// committed + lock/statement timeout → pin app.tenant_id=admin 公司、
// app.operator_principal_id=admin → advisory 排他锁（规范序：tenant →
// membership(admin) → membership(target)）→ 事务内 tenant_admin + epoch +
// principal 重验（漂移 SCOPE_REVOKED）→ pinTarget（app.operator_principal_id
// 与 app.principal_id 都切到目标——后者是 MT060 任务协会 operator 策略的
// pin）→ 目标成员行 active 校验（缺行/非在职/他公司 = COMPANY_MEMBER_NOT_
// FOUND，无存在性泄漏）→ 清理序列（全部 RLS pin 死本公司）→ 审计 → 提交：
//
//   1. 团队成员行 DELETE（本票迁移补的 operator DELETE 策略：pin tenant +
//      operator_principal_id）——清理资格的数据半边（MT076 离职保留团队行
//      靠 MT005 事实行走级联失效；清理是更强的显式动作，行本身摘除）。
//   2. 资源授权行：先枚举后逐行 DELETE（app.resource_id + app.operator_
//      principal_id 逐行 pin；MT007/MT026/MT076 撤权=删行范式；deleted
//      长度 ≠1 = 策略故障响亮拒绝）。
//   3. MT060 任务协会行 DELETE（协会=可见性权威；行没了任务对一切 scope
//      不可见——失效语义，根记录行归 MT068 purge 面）。
//   4. 凭据动作行 DELETE（MT027 授权事实；撤权=删行）。
//   5. 个人连接凭据 status→revoked（MT027 撤销语义：对含属主在内的一切人
//      生效）。
//   6. 公司成员行 UPDATE suspended + epoch+1（MT076/MT026 同款 CAS：成员
//      行保留——epoch/审计面的事实载体，一个公司内不存在第二套停用语义）。
//   7. 审计 company_member.data_cleaned（details 带五类计数 + epoch）。
//
// Track B 序列：输入校验 → §9 fence（真实 store.delete，幂等重放同 marker）
// → directory 通道（pin app.user_id=目标；成员关系 self-read 策略天然跨公
// 司且只及本人）枚举 active 成员行 → 每 company 一次 operator 事务（跨公
// 司按 tenantId 排序取 membership 排他锁，防死锁；pin tenant + operator_
// principal_id=目标）→ 行仍 active 才 UPDATE suspended + epoch+1 → 审计
// global_account.membership_revoked。users/principals 行零触碰——全局身份
// 由 §9 fence 使后续认证请求失效；物理清除是 MT068 的执行面（票面备注）。
//
// 审计（票面验收 4）：本模块封闭事件集合（同一张 enterprise_security_events、
// 同一条受限 operator 角色 RLS INSERT 策略，各轨互斥的事件类型——与 MT076
// 的 promoted/demoted/offboarded、MT026 的 scim_* 集合互不重叠）。

import { and, eq, sql } from "drizzle-orm";
import {
  type DirectoryTransitionReport,
  isDirectoryMembershipRefusal,
  MEMBERSHIP_LIFECYCLE_PAUSED,
  type MembershipAdminTranslationPort,
  translateMembershipLifecycle,
} from "../../auth/directory/membership";
import type { Database } from "../../db/client";
import {
  enterpriseCredentialActions,
  enterpriseCredentials,
} from "../../db/schema/enterprise-credentials";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseSecurityEvents,
  enterpriseWorkspaceMemberships,
} from "../../db/schema/enterprise-tenancy";
import { openmuseTaskScopes } from "../../db/schema/openmuse-task-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// 审计：本模块封闭事件集合（两轨互斥）
// ---------------------------------------------------------------------------

export const DELETION_SEMANTICS_AUDIT_EVENT_TYPES: readonly string[] = [
  "company_member.data_cleaned",
  "global_account.membership_revoked",
] as const;

type DeletionSemanticsAuditEventType =
  (typeof DELETION_SEMANTICS_AUDIT_EVENT_TYPES)[number];

const AUDIT_EVENT_TYPE_IDS: ReadonlySet<string> = new Set(
  DELETION_SEMANTICS_AUDIT_EVENT_TYPES,
);

type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/**
 * Writes one deletion-semantics audit event inside the caller's transaction.
 * The caller has pinned app.tenant_id; this pins app.operation_id (the event
 * id IS the operation id), so the INSERT is RLS-checked against that company
 * — the same channel every other security-event writer uses.
 */
async function recordDeletionAuditEvent(
  tx: OperatorTransaction,
  input: {
    readonly eventType: DeletionSemanticsAuditEventType;
    readonly tenantId: string;
    readonly operatorPrincipalId: string;
    readonly operatorUserId: string;
    readonly targetPrincipalId: string;
    readonly epoch: number;
    readonly details: Readonly<Record<string, unknown>>;
  },
): Promise<string> {
  if (
    !AUDIT_EVENT_TYPE_IDS.has(input.eventType) ||
    !String(input.tenantId ?? "").trim() ||
    !String(input.operatorPrincipalId ?? "").trim() ||
    !String(input.operatorUserId ?? "").trim() ||
    !String(input.targetPrincipalId ?? "").trim() ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch <= 0 ||
    !input.details ||
    typeof input.details !== "object"
  ) {
    throw new Error("DELETION_SEMANTICS_AUDIT_EVENT_INVALID");
  }
  const eventId = crypto.randomUUID();
  await tx.execute(
    sql`select set_config('app.operation_id', ${eventId}, true)`,
  );
  await tx.insert(enterpriseSecurityEvents).values({
    tenantId: input.tenantId,
    id: eventId,
    operationId: eventId,
    actorId: input.operatorPrincipalId,
    eventType: input.eventType,
    details: {
      operator_principal_id: input.operatorPrincipalId,
      operator_user_id: input.operatorUserId,
      target_principal_id: input.targetPrincipalId,
      workspace_id: null,
      epoch: input.epoch,
      ...input.details,
    },
  });
  return eventId;
}

// ---------------------------------------------------------------------------
// Track A：公司成员数据清理（公司管理动作，只及本公司）
// ---------------------------------------------------------------------------

export interface CompanyCleanupReport {
  readonly outcome: "company_scope_cleaned";
  readonly tenantId: string;
  readonly principalId: string;
  readonly membership: Readonly<{ status: "suspended"; epoch: number }>;
  readonly workspaceMembershipsRemoved: number;
  readonly grantsDeleted: number;
  readonly taskScopesRemoved: number;
  readonly credentialActionsRemoved: number;
  readonly credentialsRevoked: number;
  /** 本票：本次清理的审计事件 id（动作留痕）。 */
  readonly auditEventId: string;
}

/** The ba-branch cleanup report: legacy fields are the real committed facts plus the directory provenance. */
export type CompanyTranslatedCleanupReport = CompanyCleanupReport &
  DirectoryTransitionReport;

export interface CompanyMemberCleanupService {
  /**
   * The company-scoped data cleanup: removes THIS company's scope facts for
   * the member (team rows, grants, task associations, credential actions,
   * personal credentials) and suspends THIS company's membership. The global
   * identity and every other company's facts are structurally untouched.
   */
  cleanupCompanyMemberData(
    context: CompanyAdminContext,
    input: { readonly principalId: string },
  ): Promise<CompanyCleanupReport>;
}

/** The advisory key the MT005 gate takes shared and admin writes take exclusive. */
function membershipLockKey(tenantId: string, principalId: string): string {
  return JSON.stringify(["enterprise", "membership", tenantId, principalId]);
}

async function beginTransaction(tx: OperatorTransaction): Promise<void> {
  await tx.execute(sql`set transaction isolation level read committed`);
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

export function createCompanyMemberCleanupService(
  operator: OperatorDatabase,
  membership?: MembershipAdminTranslationPort,
): CompanyMemberCleanupService {
  assertOperatorDatabase(operator);

  /** Exclusive locks in canonical order: tenant → membership(admin) → membership(target). */
  const takeLocks = async (
    tx: OperatorTransaction,
    keys: readonly string[],
  ): Promise<void> => {
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
    tx: OperatorTransaction,
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

  /**
   * The T04.03 authority branch for Track A (ticket step 5 + the T02.13
   * inventory's disposal of this file): legacy keeps the original operator
   * path below; paused answers the one 503; ba disposes the two named halves
   * through ONE directory command — member.remove owns the team relations
   * and the membership deactivation (the inventory's member.remove /
   * member.suspend pair, with removal subsuming suspension) — while the
   * operator half below still scrubs the planes the directory does not own
   * (grants, task scopes, credential actions, personal credentials) and
   * writes this module's audit row. The legacy workspace-membership
   * projection rows are deliberately NOT deleted on this branch: that
   * table's controlled writer belongs to the team-projection task (P09
   * forward), exactly as the finalizer documents.
   *
   * The actor authorization is the command's own in-lock live-role check
   * (a demoted admin's execute is refused outright), so this branch needs
   * no operator-side revalidation before the scrub.
   */
  const translatedCleanupOrNull = async (
    context: CompanyAdminContext,
    principalId: string,
  ): Promise<CompanyTranslatedCleanupReport | null> => {
    if (!membership) return null;
    const mode = await membership.modeOf();
    if (mode === "legacy") return null;
    if (mode === "paused") throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);
    const facts = await translateMembershipLifecycle(membership, {
      actorUserId: context.actorId,
      tenantId: context.tenantId,
      principalId,
      operation: "member.remove",
      payloadOf: (userId) => ({ userId, reason: "company_member_cleanup" }),
    });
    // The operator half: the planes the directory does not own, scrubbed on
    // the restricted channel with the same RLS pins as the legacy flow.
    const scrubbed = await operator.transaction(async (tx) => {
      await beginTransaction(tx);
      await tx.execute(
        sql`select set_config('app.tenant_id', ${context.tenantId}, true), set_config('app.operator_principal_id', ${principalId}, true), set_config('app.principal_id', ${principalId}, true)`,
      );
      // The legacy lock order, so this half stays serialized with the
      // legacy writers of the same rows.
      await takeLocks(tx, [
        JSON.stringify(["enterprise", "tenant", context.tenantId]),
        membershipLockKey(context.tenantId, context.principalId),
        membershipLockKey(context.tenantId, principalId),
      ]);
      const grants = await tx
        .select({ resourceId: enterpriseResourceGrants.resourceId })
        .from(enterpriseResourceGrants)
        .where(
          and(
            eq(enterpriseResourceGrants.tenantId, context.tenantId),
            eq(enterpriseResourceGrants.principalId, principalId),
          ),
        );
      for (const grant of grants) {
        await tx.execute(
          sql`select set_config('app.resource_id', ${grant.resourceId}, true)`,
        );
        const deleted = await tx
          .delete(enterpriseResourceGrants)
          .where(
            and(
              eq(enterpriseResourceGrants.tenantId, context.tenantId),
              eq(enterpriseResourceGrants.resourceId, grant.resourceId),
              eq(enterpriseResourceGrants.principalId, principalId),
            ),
          )
          .returning({ resourceId: enterpriseResourceGrants.resourceId });
        if (deleted.length !== 1) {
          throw new Error("COMPANY_CLEANUP_CONFLICT");
        }
      }
      const taskScopes = await tx
        .delete(openmuseTaskScopes)
        .where(
          and(
            eq(openmuseTaskScopes.tenantId, context.tenantId),
            eq(openmuseTaskScopes.principalId, principalId),
          ),
        )
        .returning({ taskId: openmuseTaskScopes.taskId });
      const credentialActions = await tx
        .delete(enterpriseCredentialActions)
        .where(
          and(
            eq(enterpriseCredentialActions.tenantId, context.tenantId),
            eq(enterpriseCredentialActions.principalId, principalId),
          ),
        )
        .returning({
          credentialId: enterpriseCredentialActions.credentialId,
        });
      const revokedCredentials = await tx
        .update(enterpriseCredentials)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(enterpriseCredentials.tenantId, context.tenantId),
            eq(enterpriseCredentials.ownerPrincipalId, principalId),
            eq(enterpriseCredentials.status, "active"),
          ),
        )
        .returning({ id: enterpriseCredentials.id });
      const auditEventId = await recordDeletionAuditEvent(tx, {
        eventType: "company_member.data_cleaned",
        tenantId: context.tenantId,
        operatorPrincipalId: context.principalId,
        operatorUserId: context.actorId,
        targetPrincipalId: principalId,
        epoch: facts.after.epoch,
        details: {
          workspace_memberships_removed: 0,
          grants_deleted: grants.length,
          task_scopes_removed: taskScopes.length,
          credential_actions_removed: credentialActions.length,
          credentials_revoked: revokedCredentials.length,
          via: "directory",
          command_id: facts.commandId,
        },
      });
      return {
        grantsDeleted: grants.length,
        taskScopesRemoved: taskScopes.length,
        credentialActionsRemoved: credentialActions.length,
        credentialsRevoked: revokedCredentials.length,
        auditEventId,
      };
    });
    return {
      outcome: "company_scope_cleaned" as const,
      tenantId: context.tenantId,
      principalId,
      membership: {
        status: facts.after.status as "suspended",
        epoch: facts.after.epoch,
      },
      // The directory-disposed half: member.remove cleared the team's own
      // relations and projected the deactivation; this table's writer is
      // P09's, so the legacy count reads zero rather than pretending.
      workspaceMembershipsRemoved: 0,
      ...scrubbed,
      via: "directory" as const,
      operation: "member.remove" as const,
      commandId: facts.commandId,
      replayed: facts.replayed,
    };
  };

  return {
    async cleanupCompanyMemberData(context, input) {
      assertTrustedAdminContext(context);
      const principalId =
        typeof input?.principalId === "string" ? input.principalId.trim() : "";
      if (!principalId) throw new Error("INVALID_REQUEST");
      const translated = await translatedCleanupOrNull(context, principalId);
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
        // Switch the operator pin to the target member. app.principal_id is
        // the MT060 task-scope operator policies' pin; app.operator_principal_id
        // is the membership/workspace-membership/grant policies' pin. Both
        // name the member being cleaned from here on.
        await tx.execute(
          sql`select set_config('app.operator_principal_id', ${principalId}, true), set_config('app.principal_id', ${principalId}, true)`,
        );
        const [membership] = await tx
          .select({
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
            ),
          )
          .limit(1);
        // Missing row, non-active row, or another company's member: one
        // invisible refusal (no existence leak across companies).
        if (membership?.status !== "active") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }

        // 1. Team membership rows: the data half of eligibility cleanup.
        const teamRows = await tx
          .delete(enterpriseWorkspaceMemberships)
          .where(
            and(
              eq(enterpriseWorkspaceMemberships.tenantId, context.tenantId),
              eq(enterpriseWorkspaceMemberships.principalId, principalId),
            ),
          )
          .returning({
            workspaceId: enterpriseWorkspaceMemberships.workspaceId,
          });

        // 2. Resource grants: revocation is row deletion (MT007 paradigm).
        //    The delete policy pins app.resource_id per row, so enumerate
        //    first and delete one by one — this company's rows only.
        const grants = await tx
          .select({ resourceId: enterpriseResourceGrants.resourceId })
          .from(enterpriseResourceGrants)
          .where(
            and(
              eq(enterpriseResourceGrants.tenantId, context.tenantId),
              eq(enterpriseResourceGrants.principalId, principalId),
            ),
          );
        for (const grant of grants) {
          await tx.execute(
            sql`select set_config('app.resource_id', ${grant.resourceId}, true)`,
          );
          const deleted = await tx
            .delete(enterpriseResourceGrants)
            .where(
              and(
                eq(enterpriseResourceGrants.tenantId, context.tenantId),
                eq(enterpriseResourceGrants.resourceId, grant.resourceId),
                eq(enterpriseResourceGrants.principalId, principalId),
              ),
            )
            .returning({ resourceId: enterpriseResourceGrants.resourceId });
          if (deleted.length !== 1) {
            throw new Error("COMPANY_CLEANUP_CONFLICT");
          }
        }

        // 3. Task scope associations (MT060): the visibility authority —
        //    no row, no scope can ever see the task again.
        const taskScopes = await tx
          .delete(openmuseTaskScopes)
          .where(
            and(
              eq(openmuseTaskScopes.tenantId, context.tenantId),
              eq(openmuseTaskScopes.principalId, principalId),
            ),
          )
          .returning({ taskId: openmuseTaskScopes.taskId });

        // 4. Credential action grants to the member: revocation is row
        //    deletion (MT027's own paradigm for this table).
        const credentialActions = await tx
          .delete(enterpriseCredentialActions)
          .where(
            and(
              eq(enterpriseCredentialActions.tenantId, context.tenantId),
              eq(enterpriseCredentialActions.principalId, principalId),
            ),
          )
          .returning({
            credentialId: enterpriseCredentialActions.credentialId,
          });

        // 5. Personal connections owned by the member: revoked (MT027's
        //    revocation semantics — effective for everyone, the owner
        //    included). Team/company credentials are not theirs to revoke.
        const revokedCredentials = await tx
          .update(enterpriseCredentials)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(
            and(
              eq(enterpriseCredentials.tenantId, context.tenantId),
              eq(enterpriseCredentials.ownerPrincipalId, principalId),
              eq(enterpriseCredentials.status, "active"),
            ),
          )
          .returning({ id: enterpriseCredentials.id });

        // 6. The company membership itself: suspended + epoch+1 (MT076 /
        //    MT026's single deactivation semantics — the row stays as the
        //    epoch/audit carrier; a company has no second revoke vocabulary).
        const epoch = membership.epoch + 1;
        const updated = await tx
          .update(enterpriseMemberships)
          .set({ status: "suspended", epoch })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
              eq(enterpriseMemberships.epoch, membership.epoch),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (updated.length !== 1 || updated[0]?.epoch !== epoch) {
          throw new Error("COMPANY_CLEANUP_CONFLICT");
        }

        const auditEventId = await recordDeletionAuditEvent(tx, {
          eventType: "company_member.data_cleaned",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch,
          details: {
            workspace_memberships_removed: teamRows.length,
            grants_deleted: grants.length,
            task_scopes_removed: taskScopes.length,
            credential_actions_removed: credentialActions.length,
            credentials_revoked: revokedCredentials.length,
          },
        });
        return {
          outcome: "company_scope_cleaned" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { status: "suspended" as const, epoch },
          workspaceMembershipsRemoved: teamRows.length,
          grantsDeleted: grants.length,
          taskScopesRemoved: taskScopes.length,
          credentialActionsRemoved: credentialActions.length,
          credentialsRevoked: revokedCredentials.length,
          auditEventId,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Track B：独立授权的全局账号删除
// ---------------------------------------------------------------------------

/**
 * The explicit-confirmation phrase a global account deletion must carry
 * verbatim. Anything else — missing, mutated, case-folded, truncated — is
 * refused before any write happens.
 */
export const GLOBAL_DELETION_CONFIRMATION = "delete-my-account-permanently";

export interface GlobalDeletionReport {
  readonly outcome: "global_deletion_fenced";
  readonly userId: string;
  /** The §9 marker's disabledAt, ISO-encoded (idempotent across repeats). */
  readonly disabledAt: string;
  readonly phase: "fenced";
  /** How many companies still had an active membership (0 on a repeat). */
  readonly companiesRevoked: number;
  /** One audit event per affected company, in tenant order. */
  readonly auditEventIds: readonly string[];
  /**
   * T04.03 ba branch only: the companies whose member.leave the directory
   * refused (a closed company, or the last-owner rule protecting the
   * company from being stranded). The §9 fence has already disabled the
   * identity globally; these companies keep their directory rows until the
   * company's own lifecycle settles them.
   */
  readonly directorySkipped?: readonly string[];
}

export interface GlobalAccountDeletionService {
  /**
   * The independent, explicitly authorized global account deletion: fences
   * the account through the real §9 store, then revokes every company's
   * eligibility. Not reachable from any company-admin path (the signature
   * has no admin context parameter); the global identity rows themselves
   * are gated by the §9 fence, and physical purge belongs to MT068.
   */
  deleteGlobalAccount(input: {
    readonly userId: string;
    readonly confirmation: string;
  }): Promise<GlobalDeletionReport>;
}

export function createGlobalAccountDeletionService(deps: {
  readonly operator: OperatorDatabase;
  /** Verified directory channel: the cross-company self-scoped enumeration. */
  readonly directory: Database;
  /**
   * The REAL §9 fence primitive (production: the account-deletion store's
   * delete). Insert-once marker semantics; a repeat re-fences a lifted
   * marker and answers the same row.
   */
  readonly fence: (userId: string) => Promise<{
    userId: string;
    disabledAt: Date;
    phase: "fenced" | "restored" | "completed";
    restoreUntil: Date | null;
    resources: string[];
  }>;
  /**
   * The T04.03 translation port (ticket step 5 + the T02.13 disposal): on
   * the ba branch the per-company membership revocation becomes the
   * member's own member.leave command; legacy keeps the operator suspension
   * below; paused refuses the whole deletion before the fence moves.
   */
  readonly membership?: MembershipAdminTranslationPort;
}): GlobalAccountDeletionService {
  assertOperatorDatabase(deps.operator);

  return {
    async deleteGlobalAccount(input) {
      // Explicit authorization first: the confirmation must match verbatim
      // and the subject must be named. Any refusal here happens before any
      // write — no marker, no membership change.
      const userId =
        typeof input?.userId === "string" ? input.userId.trim() : "";
      if (!userId) throw new Error("INVALID_REQUEST");
      if (input?.confirmation !== GLOBAL_DELETION_CONFIRMATION) {
        throw new Error("GLOBAL_DELETION_CONFIRMATION_REQUIRED");
      }

      // The authority branch is decided before the fence moves: a paused
      // directory refuses the whole deletion (one 503), so the marker never
      // races a write that must not run.
      const mode = deps.membership ? await deps.membership.modeOf() : null;
      if (mode === "paused") throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);

      // §9 ordering: the marker is the first act of deletion. The fence is
      // insert-once (a repeat answers the same row / re-fences a lift).
      const marker = await deps.fence(userId);

      // Enumerate the account's still-active company memberships through
      // the directory channel: the membership self-read policy pins
      // app.user_id — cross-company by construction and only ever the
      // account's own rows.
      const activeMemberships = await deps.directory.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level read committed`);
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.user_id', ${userId}, true)`,
        );
        return tx
          .select({
            tenantId: enterpriseMemberships.tenantId,
            principalId: enterpriseMemberships.principalId,
            epoch: enterpriseMemberships.epoch,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            and(
              eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
              // principals directory self-read policy pins app.user_id.
              sql`${enterprisePrincipals.userId} = nullif(current_setting('app.user_id', true), '')`,
            ),
          )
          .where(eq(enterpriseMemberships.status, "active"));
      });
      // Deterministic per-company order (also the lock order — no deadlock).
      activeMemberships.sort((a, b) =>
        a.tenantId === b.tenantId
          ? a.principalId.localeCompare(b.principalId)
          : a.tenantId.localeCompare(b.tenantId),
      );

      const auditEventIds: string[] = [];
      const directorySkipped: string[] = [];
      for (const membership of activeMemberships) {
        if (mode === "ba" && deps.membership) {
          // The ba branch: the member's OWN member.leave command (the account
          // owner is the actor — a self-removal, not an admin action). The
          // command's executor carries the lock, the receipt, the clocks and
          // the audit fact. A refusal here (a closed company, or the
          // last-owner rule) is recorded and skipped, exactly as the legacy
          // loop skips a membership row that already moved: the fence above
          // has already disabled the identity globally.
          try {
            const result = await deps.membership.execute(
              deps.membership.actorOf(userId),
              {
                operation: "member.leave",
                tenantId: membership.tenantId,
                idempotencyKey: crypto.randomUUID(),
                payload: {},
              },
            );
            const auditId = await deps.membership.auditEventIdOf({
              tenantId: membership.tenantId,
              commandId: result.commandId,
            });
            if (auditId) auditEventIds.push(auditId);
          } catch (error) {
            if (!isDirectoryMembershipRefusal(error)) throw error;
            directorySkipped.push(membership.tenantId);
          }
          continue;
        }
        const suspended = await deps.operator.transaction(async (tx) => {
          await beginTransaction(tx);
          await tx.execute(
            sql`select set_config('app.tenant_id', ${membership.tenantId}, true), set_config('app.operator_principal_id', ${membership.principalId}, true)`,
          );
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${membershipLockKey(membership.tenantId, membership.principalId)}, 0))`,
          );
          // The membership UPDATE policy pins tenant + operator_principal_id:
          // exactly this account's row in exactly this company is reachable.
          const updated = await tx
            .update(enterpriseMemberships)
            .set({ status: "suspended", epoch: membership.epoch + 1 })
            .where(
              and(
                eq(enterpriseMemberships.tenantId, membership.tenantId),
                eq(enterpriseMemberships.principalId, membership.principalId),
                eq(enterpriseMemberships.status, "active"),
                eq(enterpriseMemberships.epoch, membership.epoch),
              ),
            )
            .returning({ epoch: enterpriseMemberships.epoch });
          if (updated.length !== 1) return null;
          const eventId = await recordDeletionAuditEvent(tx, {
            eventType: "global_account.membership_revoked",
            tenantId: membership.tenantId,
            // The deleting actor is the account owner themselves (this is
            // the owner's own explicitly authorized deletion).
            operatorPrincipalId: membership.principalId,
            operatorUserId: userId,
            targetPrincipalId: membership.principalId,
            epoch: membership.epoch + 1,
            details: {
              via: "global_account_deletion",
              marker_phase: marker.phase,
            },
          });
          return eventId;
        });
        if (suspended) auditEventIds.push(suspended);
      }

      return {
        outcome: "global_deletion_fenced",
        userId,
        disabledAt: marker.disabledAt.toISOString(),
        phase: "fenced",
        companiesRevoked: auditEventIds.length,
        auditEventIds,
        ...(mode === "ba" ? { directorySkipped } : {}),
      };
    },
  };
}
