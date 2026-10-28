// server/src/enterprise/tenancy/people-lifecycle.ts
// MT076（Issue #119）：公司范围的人员管理动作——提升、降级、离职。
//
// 三个动作都只收受信 CompanyAdminContext（MT006 签发半边的消费方；API 没
// 有租户参数，公司归属只来自上下文本身），并在同一 operator 事务内重验
// tenant_admin 身份 + 公司 epoch + principal 状态后经受限角色 + 真实 RLS
// 写入。作用域纪律（票面验收 1/2）：全部写都以 app.tenant_id = 上下文公司
// pin 死——跨公司对象在该事务里**结构性不可见**（RLS using/withCheck 双臂
// 钉 tenant_id + operator_principal_id），其他公司的成员行、团队行、资源授
// 权行与全局身份（users/sessions/principal）不可能被触及。
//
//   1. promoteCompanyMember：member/auditor → tenant_admin（公司角色唯一
//      向上迁移；不新增角色词汇，CHECK 兜底）。已管理员/非在职成员一律
//      COMPANY_MEMBER_NOT_FOUND——与 MT007 管理面先例一致：目标不存在、
//      已停用、角色不满足三种情况对调用者不可区分（无存在性泄漏）。
//   2. demoteCompanyMember：tenant_admin → member|auditor（显式目标角色）。
//      每次 promote/demote 推进成员关系版本（epoch+1，授权变更版本）——被
//      降级管理员的未决上下文在下次管理重验时因 epoch 漂移被拒
//      （SCOPE_REVOKED），与 MT007 的实时 epoch 事实纪律同源，无缓存。
//   3. offboardCompanyMember：与 MT026 SCIM 目录停用**同一套状态语义**
//      （票面验收 4）：成员行 suspended + epoch+1 + 该公司资源授权行逐行
//      删除（撤权=删行范式，MT007/MT026）+ 审计事件。团队资格不删行——
//      公司停用经 MT005 事实行走级联失效，与 SCIM 通道完全一致；结构性
//      不触碰：其他公司的成员行/授权行、全局身份（users 行、principal 行、
//      会话）。目录不能解除管理员离职（绑定行 last_deprovision 事实未变、
//      epoch 已漂移，MT026 的 reprovision 裁决自动拒绝）——一个公司内不存
//      在两套并行的停用语义。
//
// 审计（票面验收 3）：本模块封闭事件集合（撤权审计类型在 revocation.ts，
// 目录反应审计在 scim-directory.ts，跨面审计在 admin-separation.ts——同一
// 张 enterprise_security_events、同一条受限 operator 角色 RLS INSERT 策略，
// 各自封闭集合，不改既有模块）。每次执行的动作写一条：操作者（principal
// 与登录用户双记）、对象、范围、版本、动作细节（角色迁移/删除授权数）。

import { and, eq, sql } from "drizzle-orm";
import {
  type DirectoryTransitionReport,
  MEMBERSHIP_LIFECYCLE_PAUSED,
  type MembershipAdminTranslationPort,
  translateMembershipLifecycle,
} from "../../auth/directory/membership";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseSecurityEvents,
} from "../../db/schema/enterprise-tenancy";
import { assertOperatorDatabase, type OperatorDatabase } from "./connections";
import {
  assertTrustedAdminContext,
  type CompanyAdminContext,
} from "./workspace-admin";

// ---------------------------------------------------------------------------
// 审计：本模块封闭事件集合
// ---------------------------------------------------------------------------

export const PEOPLE_LIFECYCLE_AUDIT_EVENT_TYPES: readonly string[] = [
  "company_member.promoted",
  "company_member.demoted",
  "company_member.offboarded",
] as const;

type PeopleLifecycleAuditEventType =
  (typeof PEOPLE_LIFECYCLE_AUDIT_EVENT_TYPES)[number];

const AUDIT_EVENT_TYPE_IDS: ReadonlySet<string> = new Set(
  PEOPLE_LIFECYCLE_AUDIT_EVENT_TYPES,
);

type OperatorTransaction = Parameters<
  Parameters<OperatorDatabase["transaction"]>[0]
>[0];

/**
 * Writes one people-lifecycle audit event inside the caller's transaction.
 * The caller has pinned app.tenant_id (the administered company); this pins
 * app.operation_id (the event id IS the operation id), so the INSERT is
 * RLS-checked against the administered company — the same channel every
 * other security-event writer uses.
 */
async function recordPeopleLifecycleAuditEvent(
  tx: OperatorTransaction,
  input: {
    readonly eventType: PeopleLifecycleAuditEventType;
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
    throw new Error("PEOPLE_LIFECYCLE_AUDIT_EVENT_INVALID");
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
// 服务
// ---------------------------------------------------------------------------

/** The closed company-role vocabulary (schema CHECK backs the same set). */
export type CompanyRole = "tenant_admin" | "member" | "auditor";

export interface CompanyRoleChangeReport {
  readonly outcome: "role_changed";
  readonly tenantId: string;
  readonly principalId: string;
  /** The role after the change, at the epoch after the change. */
  readonly membership: Readonly<{ role: CompanyRole; epoch: number }>;
  readonly previousRole: CompanyRole;
  /** MT076：本次角色变更的审计事件 id（动作留痕）。 */
  readonly auditEventId: string;
}

export interface CompanyOffboardReport {
  readonly outcome: "offboarded";
  readonly tenantId: string;
  readonly principalId: string;
  readonly membership: Readonly<{ status: "suspended"; epoch: number }>;
  readonly grantsDeleted: number;
  /** MT076：本次离职的审计事件 id（动作留痕）。 */
  readonly auditEventId: string;
}

/**
 * The ba-branch shapes (T04.03 ticket step 5): the legacy report fields are
 * the committed projection facts and the command's own audit id; the
 * directory provenance extension names the command that produced them.
 */
export type CompanyTranslatedRoleChangeReport = CompanyRoleChangeReport &
  DirectoryTransitionReport;
export type CompanyTranslatedOffboardReport = CompanyOffboardReport &
  DirectoryTransitionReport;

export interface CompanyPeopleLifecycleService {
  /** member/auditor → tenant_admin，only ever inside the context's company. */
  promoteCompanyMember(
    context: CompanyAdminContext,
    input: { readonly principalId: string },
  ): Promise<CompanyRoleChangeReport>;
  /** tenant_admin → `to`（member|auditor），only ever inside the context's company. */
  demoteCompanyMember(
    context: CompanyAdminContext,
    input: { readonly principalId: string; readonly to: "member" | "auditor" },
  ): Promise<CompanyRoleChangeReport>;
  /**
   * The company-scoped offboard: suspends THIS company's membership and
   * deletes THIS company's resource grants — the exact state semantics of the
   * MT026 SCIM deprovision, triggered from the company management plane.
   */
  offboardCompanyMember(
    context: CompanyAdminContext,
    input: { readonly principalId: string },
  ): Promise<CompanyOffboardReport>;
  /**
   * The company roster the people page renders (MT095 / Issue #138 AC2): every membership row of
   * the context's own company — the admin context already pins the tenant, so other companies'
   * rows are structurally out of the answer (operator RLS tenant pin), not filtered out by the
   * service's own where-clause discipline. Membership facts only: the roster carries no identity
   * data beyond the principal and user ids the company admin already legitimately holds.
   */
  companyMembers(
    context: CompanyAdminContext,
  ): Promise<readonly CompanyMemberRow[]>;
}

/** One roster row: the membership facts of one principal in the administered company. */
export interface CompanyMemberRow {
  readonly principalId: string;
  readonly userId: string;
  readonly role: CompanyRole;
  readonly status: "active" | "suspended";
  readonly epoch: number;
  readonly joinedAt: Date;
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

/**
 * Runs one people-lifecycle operation: trust → exclusive locks (canonical
 * order: tenant → membership(admin) → membership(target)) → in-transaction
 * tenant_admin + epoch + principal revalidation → action. The
 * operator-transaction settings are transaction-local; nothing session-level
 * survives commit or rollback.
 */
export function createCompanyPeopleLifecycleService(
  operator: OperatorDatabase,
  membership?: MembershipAdminTranslationPort,
): CompanyPeopleLifecycleService {
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

  /** Switches the operator pin from the acting admin to the target member. */
  const pinTarget = async (
    tx: OperatorTransaction,
    principalId: string,
  ): Promise<void> => {
    await tx.execute(
      sql`select set_config('app.operator_principal_id', ${principalId}, true)`,
    );
  };

  const isRole = (value: unknown): value is CompanyRole =>
    value === "tenant_admin" || value === "member" || value === "auditor";

  const principalIdOf = (value: unknown): string => {
    const principalId = typeof value === "string" ? value.trim() : "";
    if (!principalId) throw new Error("INVALID_REQUEST");
    return principalId;
  };

  /**
   * The T04.03 authority branch (ticket step 5): legacy keeps this service's
   * original path below untouched; paused answers the one 503
   * (MEMBERSHIP_LIFECYCLE_PAUSED); ba translates the write into ONE directory
   * command (role.set/suspend) and shapes the legacy report from the
   * committed projection facts, extended with the directory provenance.
   * Returns null for the legacy branch; the caller's `stateGate` replaces
   * the shared default (only an active member moves), so it must include
   * the active check when the entrance's legacy rule also demands one.
   */
  const translatedOrNull = async <T>(
    context: CompanyAdminContext,
    principalId: string,
    operation: "member.role.set" | "member.suspend",
    payloadOf: (userId: string) => Readonly<Record<string, unknown>>,
    stateGate:
      | ((member: {
          readonly role: string;
          readonly status: string;
        }) => boolean)
      | undefined,
    map: (facts: Awaited<ReturnType<typeof translateMembershipLifecycle>>) => T,
  ): Promise<T | null> => {
    if (!membership) return null;
    const mode = await membership.modeOf();
    if (mode === "legacy") return null;
    if (mode === "paused") throw new Error(MEMBERSHIP_LIFECYCLE_PAUSED);
    return map(
      await translateMembershipLifecycle(membership, {
        actorUserId: context.actorId,
        tenantId: context.tenantId,
        principalId,
        operation,
        payloadOf,
        stateGate,
      }),
    );
  };

  /**
   * Shared skeleton: trust → settings → locks → admin revalidation → target
   * pin → live membership row. Missing row or a non-active row is refused
   * with the invisible NOT_FOUND (the acting admin cannot distinguish a
   * foreign-company member from a fabricated id — AC3 semantics).
   */
  const withTargetMember = async <T>(
    context: CompanyAdminContext,
    principalId: string,
    run: (
      tx: OperatorTransaction,
      membership: { role: CompanyRole; status: string; epoch: number },
    ) => Promise<T>,
  ): Promise<T> => {
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
      const [membership] = await tx
        .select({
          role: enterpriseMemberships.role,
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
      if (membership?.status !== "active") {
        throw new Error("COMPANY_MEMBER_NOT_FOUND");
      }
      const { role, status, epoch } = membership;
      if (!isRole(role)) {
        throw new Error("COMPANY_MEMBER_NOT_FOUND");
      }
      return run(tx, { role, status, epoch });
    });
  };

  return {
    async promoteCompanyMember(context, input) {
      assertTrustedAdminContext(context);
      const principalId = principalIdOf(input?.principalId);
      const translated = await translatedOrNull(
        context,
        principalId,
        "member.role.set",
        (userId) => ({ userId, role: "admin" }),
        // The legacy closed promotion rule: an already-managed member is the
        // invisible not-found, exactly as the original path refuses it.
        (member) =>
          member.status === "active" && member.role !== "tenant_admin",
        ({ before, after, commandId, replayed, auditEventId }) => ({
          outcome: "role_changed" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { role: after.role as CompanyRole, epoch: after.epoch },
          previousRole: before.role as CompanyRole,
          auditEventId,
          via: "directory" as const,
          operation: "member.role.set" as const,
          commandId,
          replayed,
        }),
      );
      if (translated) return translated;
      return withTargetMember(context, principalId, async (tx, membership) => {
        // Closed promotion rule: only member/auditor rise, and only while
        // active (withTargetMember already refused non-active rows).
        if (membership.role === "tenant_admin") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }
        const epoch = membership.epoch + 1;
        const updated = await tx
          .update(enterpriseMemberships)
          .set({ role: "tenant_admin", epoch })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
              eq(enterpriseMemberships.epoch, membership.epoch),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (updated.length !== 1 || updated[0]?.epoch !== epoch) {
          throw new Error("COMPANY_ROLE_CHANGE_CONFLICT");
        }
        const auditEventId = await recordPeopleLifecycleAuditEvent(tx, {
          eventType: "company_member.promoted",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch,
          details: {
            role_from: membership.role,
            role_to: "tenant_admin",
          },
        });
        return {
          outcome: "role_changed" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { role: "tenant_admin" as const, epoch },
          previousRole: membership.role,
          auditEventId,
        };
      });
    },

    async demoteCompanyMember(context, input) {
      assertTrustedAdminContext(context);
      const principalId = principalIdOf(input?.principalId);
      const to = input?.to;
      if (to !== "member" && to !== "auditor") {
        throw new Error("INVALID_REQUEST");
      }
      const translated = await translatedOrNull(
        context,
        principalId,
        "member.role.set",
        (userId) => ({ userId, role: to }),
        // The legacy closed demotion rule: only a managed member descends.
        (member) =>
          member.status === "active" && member.role === "tenant_admin",
        ({ before, after, commandId, replayed, auditEventId }) => ({
          outcome: "role_changed" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { role: after.role as CompanyRole, epoch: after.epoch },
          previousRole: before.role as CompanyRole,
          auditEventId,
          via: "directory" as const,
          operation: "member.role.set" as const,
          commandId,
          replayed,
        }),
      );
      if (translated) return translated;
      return withTargetMember(context, principalId, async (tx, membership) => {
        // Closed demotion rule: only a tenant_admin descends, and the target
        // role is explicit — a demotion never invents an intermediate role.
        if (membership.role !== "tenant_admin") {
          throw new Error("COMPANY_MEMBER_NOT_FOUND");
        }
        const epoch = membership.epoch + 1;
        const updated = await tx
          .update(enterpriseMemberships)
          .set({ role: to, epoch })
          .where(
            and(
              eq(enterpriseMemberships.tenantId, context.tenantId),
              eq(enterpriseMemberships.principalId, principalId),
              eq(enterpriseMemberships.epoch, membership.epoch),
            ),
          )
          .returning({ epoch: enterpriseMemberships.epoch });
        if (updated.length !== 1 || updated[0]?.epoch !== epoch) {
          throw new Error("COMPANY_ROLE_CHANGE_CONFLICT");
        }
        const auditEventId = await recordPeopleLifecycleAuditEvent(tx, {
          eventType: "company_member.demoted",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch,
          details: { role_from: membership.role, role_to: to },
        });
        return {
          outcome: "role_changed" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { role: to, epoch },
          previousRole: membership.role,
          auditEventId,
        };
      });
    },

    async offboardCompanyMember(context, input) {
      assertTrustedAdminContext(context);
      const principalId = principalIdOf(input?.principalId);
      const translated = await translatedOrNull(
        context,
        principalId,
        "member.suspend",
        (userId) => ({ userId, reason: "company_admin_offboard" }),
        undefined,
        ({ after, commandId, replayed, auditEventId }) => ({
          outcome: "offboarded" as const,
          tenantId: context.tenantId,
          principalId,
          membership: {
            status: after.status as "suspended",
            epoch: after.epoch,
          },
          // The directory transition deletes no legacy grant rows: the
          // authorities die by the clock advance the command commits, and
          // the grant store is not the ba branch's authorization source.
          grantsDeleted: 0,
          auditEventId,
          via: "directory" as const,
          operation: "member.suspend" as const,
          commandId,
          replayed,
        }),
      );
      if (translated) return translated;
      return withTargetMember(context, principalId, async (tx, membership) => {
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
          throw new Error("COMPANY_OFFBOARD_CONFLICT");
        }
        // Resource permissions: revocation is row deletion (MT007 paradigm,
        // MT026 shape). The delete policy pins app.resource_id +
        // app.operator_principal_id per row, so the grant set is enumerated
        // first and deleted one by one — this company's rows only (the RLS
        // tenant arm makes cross-company grant rows invisible here).
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
            sql`select set_config('app.resource_id', ${grant.resourceId}, true), set_config('app.operator_principal_id', ${principalId}, true)`,
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
          // The row was just enumerated under the exclusive lock; a delete
          // that removed anything but exactly that row is a policy fault,
          // never a silent partial revocation.
          if (deleted.length !== 1) {
            throw new Error("COMPANY_OFFBOARD_CONFLICT");
          }
        }
        const auditEventId = await recordPeopleLifecycleAuditEvent(tx, {
          eventType: "company_member.offboarded",
          tenantId: context.tenantId,
          operatorPrincipalId: context.principalId,
          operatorUserId: context.actorId,
          targetPrincipalId: principalId,
          epoch,
          details: { grants_deleted: grants.length },
        });
        return {
          outcome: "offboarded" as const,
          tenantId: context.tenantId,
          principalId,
          membership: { status: "suspended" as const, epoch },
          grantsDeleted: grants.length,
          auditEventId,
        };
      });
    },

    async companyMembers(context) {
      assertTrustedAdminContext(context);
      // The read rides the same operator channel the writes do: transaction
      // with the tenant pin, so RLS answers with this company's rows only —
      // the roster cannot name another company's member even by mistake.
      return operator.transaction(async (tx) => {
        await beginTransaction(tx);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${context.tenantId}, true)`,
        );
        const rows = await tx
          .select({
            principalId: enterpriseMemberships.principalId,
            userId: enterprisePrincipals.userId,
            role: enterpriseMemberships.role,
            status: enterpriseMemberships.status,
            epoch: enterpriseMemberships.epoch,
            joinedAt: enterpriseMemberships.createdAt,
          })
          .from(enterpriseMemberships)
          .innerJoin(
            enterprisePrincipals,
            eq(enterprisePrincipals.id, enterpriseMemberships.principalId),
          )
          .where(eq(enterpriseMemberships.tenantId, context.tenantId))
          .orderBy(enterpriseMemberships.createdAt);
        return rows.map((row) => ({
          principalId: row.principalId,
          userId: row.userId,
          role: row.role as CompanyRole,
          status: row.status as "active" | "suspended",
          epoch: row.epoch,
          joinedAt: row.joinedAt,
        }));
      });
    },
  };
}
