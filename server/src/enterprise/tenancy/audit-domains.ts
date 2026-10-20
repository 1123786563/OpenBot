// server/src/enterprise/tenancy/audit-domains.ts
// MT078（Issue #121）：业务审计与身份审计分域，计费管理需明确授权。
//
// 审计分域（business | identity | platform）的保存与查询在这一个判定面收口：
//
//   - 保存（recordTenantAuditEvent）：经受限 operator 通道按 enterprise_
//     audit_events 的 RLS 写策略落行（tenant pin ∧ operation pin，与
//     enterprise_security_events 同款写入纪律）；payload 过 redactAuditPayload
//     （server/src/audit.ts 同一规则源），明文秘密不落域。
//   - 查询（queryTenantAuditEvents / exportTenantAuditEvents）：先判域授权，
//     后经 operator 通道按租户 pin 读——跨租户读取被 RLS 结构性排除（不是
//     服务层自觉）。域授权是封闭矩阵：
//       · 公司主体（principalId）→ 只有 business 域，且须是该公司活跃成员
//         并持有 auditor 或 tenant_admin 角色（interfaces.md：audit-read 是
//         管理动作；普通成员不可读）。
//       · 平台主体（subject）→ 只有 identity / platform 域（MT075：全局身份
//         审计属平台面；平台身份读公司业务审计不是默认权，是跨面授权，
//         本票不发放）。
//     任何其余组合 → 同一哨兵 AUDIT_SCOPE_FORBIDDEN：不区分「域不对 / 非
//     成员 / 公司不存在 / 角色不够」，错误与行数都不泄露存在性（A2）。
//   - 导出（exportTenantAuditEvents）：与查询同一判定门、同一脱敏、同一
//     通道；行数封顶并如实披露 truncated，不静默截断。
//
// 计费管理（AC3）：发放、调整、退款是明确的授权事实
// （billing_company_manage_grants，MT073 公司财务读取授权同款纪律：PK +
// 双侧复合 FK、撤销=删行、重复授权显式拒绝、tenant_admin 不自动获得），
// performBillingManagementAction 判定门之后才动账（既有 CreditWriter 唯一
// 存入面）并留 business 域审计事件；账面写入与审计写入任一失败都原样上抛，
// 绝不折叠成成功。
//
// 观测侧（MT110）的授权不在本面：这里只做审计域的保存与查询授权。

import { and, desc, eq, sql } from "drizzle-orm";
import { redactAuditPayload } from "../../audit";
import type { CreditWriter } from "../../billing/credits-writer";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "../../billing/payer-accounts";
import type { Database } from "../../db/client";
import {
  BILLING_MANAGE_ACTIONS,
  type BillingManageAction,
  billingManageActionBit,
  enterpriseAuditEvents,
  enterpriseMemberships,
  billingCompanyManageGrants as manageGrants,
} from "../../db/schema";
import type { OperatorDatabase } from "./connections";

/** 审计域的封闭集合（与表 CHECK 同源）。 */
export const AUDIT_DOMAINS = ["business", "identity", "platform"] as const;
export type AuditDomain = (typeof AUDIT_DOMAINS)[number];

/** 可持有审计查询授权的两类主体。 */
export type AuditQueryActor =
  | { readonly kind: "company"; readonly principalId: string }
  | { readonly kind: "platform"; readonly subject: string };

/** 查询授权失败的唯一哨兵：不区分原因，不泄露存在性。 */
export const AUDIT_SCOPE_FORBIDDEN = "AUDIT_SCOPE_FORBIDDEN";

/** 计费管理授权缺失的统一哨兵（无授权、非成员、公司不存在同形）。 */
export const BILLING_MANAGE_REQUIRED = "BILLING_MANAGE_REQUIRED";

export type TenantAuditEventInput = {
  readonly tenantId: string;
  readonly domain: AuditDomain;
  readonly eventType: string;
  readonly actorId: string;
  readonly targetId?: string;
  readonly payload: Record<string, unknown>;
};

export type TenantAuditEventRow = {
  readonly id: string;
  readonly domain: AuditDomain;
  readonly eventType: string;
  readonly actorId: string;
  readonly targetId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
};

const requireNonEmpty = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`AUDIT_EVENT_INVALID: ${what} must be a non-empty string`);
  }
  return value;
};

/**
 * 落一条分域审计事件。写入经受限 operator 事务：调用方上下文 pin
 * app.tenant_id，本函数 pin app.operation_id（= 事件 id），RLS 写策略双
 * pin 校验。payload 先过 redactAuditPayload。失败原样上抛：审计缺失绝不
 * 被折叠成成功。
 */
export async function recordTenantAuditEvent(
  operator: OperatorDatabase,
  event: TenantAuditEventInput,
): Promise<{ eventId: string }> {
  const tenantId = requireNonEmpty(event?.tenantId, "tenantId");
  const eventType = requireNonEmpty(event?.eventType, "eventType");
  const actorId = requireNonEmpty(event?.actorId, "actorId");
  if (!AUDIT_DOMAINS.includes(event?.domain)) {
    throw new Error(
      "AUDIT_EVENT_INVALID: domain must be business|identity|platform",
    );
  }
  const eventId = crypto.randomUUID();
  const payload = redactAuditPayload(event.payload ?? {}) as Record<
    string,
    unknown
  >;
  await operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await tx.execute(
      sql`select set_config('app.operation_id', ${eventId}, true)`,
    );
    await tx.insert(enterpriseAuditEvents).values({
      tenantId,
      id: eventId,
      domain: event.domain,
      eventType,
      actorId,
      targetId: event.targetId ?? null,
      payload,
    });
  });
  return { eventId };
}

/** 域授权矩阵的判定（纯函数：测试与查询/导出共用同一实现）。 */
export function auditDomainAllowed(
  actor: AuditQueryActor,
  domain: AuditDomain,
): boolean {
  if (!actor) return false;
  if (actor.kind === "company") return domain === "business";
  if (actor.kind === "platform") {
    return domain === "identity" || domain === "platform";
  }
  return false;
}

async function assertQueryScope(
  operator: OperatorDatabase,
  actor: AuditQueryActor,
  input: { tenantId: string; domain: AuditDomain },
): Promise<void> {
  if (
    !auditDomainAllowed(actor, input?.domain) ||
    !String(input?.tenantId ?? "").trim()
  ) {
    throw new Error(AUDIT_SCOPE_FORBIDDEN);
  }
  if (actor.kind === "company") {
    // 公司主体读 business 域：活跃成员 ∧ auditor/tenant_admin 角色。
    // 与查询同一 operator 事务内活查（tenant pin 下读 memberships），
    // 停用立即失效。
    const rows = await operator.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${input.tenantId}, true)`,
      );
      return tx
        .select({
          role: enterpriseMemberships.role,
          status: enterpriseMemberships.status,
        })
        .from(enterpriseMemberships)
        .where(
          and(
            eq(enterpriseMemberships.tenantId, input.tenantId),
            eq(enterpriseMemberships.principalId, actor.principalId),
          ),
        )
        .limit(1);
    });
    const membership = rows[0];
    if (
      !membership?.status ||
      membership.status !== "active" ||
      (membership.role !== "auditor" && membership.role !== "tenant_admin")
    ) {
      throw new Error(AUDIT_SCOPE_FORBIDDEN);
    }
  }
}

export type TenantAuditQuery = {
  readonly tenantId: string;
  readonly domain: AuditDomain;
  readonly limit?: number;
  readonly eventType?: string;
};

/**
 * 查询一个授权域内的审计事件。判定门（assertQueryScope）先于一切行读取；
 * 行读取在 operator 事务的租户 pin 下由 RLS 收口——跨租户查询结构性为空，
 * 不是服务层过滤。拒绝与空结果不同形：拒绝是哨兵错误，空是空数组。
 */
export async function queryTenantAuditEvents(
  operator: OperatorDatabase,
  actor: AuditQueryActor,
  query: TenantAuditQuery,
): Promise<readonly TenantAuditEventRow[]> {
  await assertQueryScope(operator, actor, query);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  return operator.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${query.tenantId}, true)`,
    );
    const conditions = [
      eq(enterpriseAuditEvents.tenantId, query.tenantId),
      eq(enterpriseAuditEvents.domain, query.domain),
      query.eventType
        ? eq(enterpriseAuditEvents.eventType, query.eventType)
        : undefined,
    ].filter((condition) => condition !== undefined);
    const rows = await tx
      .select()
      .from(enterpriseAuditEvents)
      .where(and(...conditions))
      .orderBy(
        desc(enterpriseAuditEvents.createdAt),
        desc(enterpriseAuditEvents.id),
      )
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain as AuditDomain,
      eventType: row.eventType,
      actorId: row.actorId,
      targetId: row.targetId,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.createdAt,
    }));
  });
}

/**
 * 导出授权域内的审计事件：与查询同一判定门、同一脱敏（行已落脱敏载荷，
 * 这里再过一次 redactAuditPayload 兜底）、同一 RLS 通道；行数封顶并披露
 * truncated。不含明文秘密（脱敏在写入与导出两侧都成立）。
 */
export async function exportTenantAuditEvents(
  operator: OperatorDatabase,
  actor: AuditQueryActor,
  query: { tenantId: string; domain: AuditDomain; maxRows?: number },
): Promise<{
  events: readonly TenantAuditEventRow[];
  truncated: boolean;
}> {
  const maxRows = Math.min(Math.max(query.maxRows ?? 5000, 1), 5000);
  const rows = await queryTenantAuditEvents(operator, actor, {
    tenantId: query.tenantId,
    domain: query.domain,
    limit: maxRows + 1,
  });
  const truncated = rows.length > maxRows;
  return {
    events: rows.slice(0, maxRows).map((row) => ({
      ...row,
      payload: redactAuditPayload(row.payload) as Record<string, unknown>,
    })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// 计费管理授权（AC3）
// ---------------------------------------------------------------------------

export type BillingManageGrant = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly grantedBy: string;
  /** 授权动作集（发放=1|调整=2|退款=4 的位集）。 */
  readonly actions: number;
  readonly createdAt: Date;
};

export type BillingManagementOutcome = {
  readonly action: BillingManageAction;
  readonly eventId: string;
  /** CreditWriter 的幂等回放答案（false=同 idempotencyKey 已入账）。 */
  readonly inserted: boolean;
  readonly amountCents: number;
};

export interface BillingManagementService {
  grantBillingManager(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly grantedBy: string;
    readonly actions: readonly BillingManageAction[];
  }): Promise<BillingManageGrant>;
  revokeBillingManager(input: {
    readonly tenantId: string;
    readonly principalId: string;
  }): Promise<{ revoked: boolean }>;
  /** 判定门：活跃成员 ∧ 授权行覆盖该动作；缺任一 → BILLING_MANAGE_REQUIRED。 */
  assertBillingManager(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly action: BillingManageAction;
  }): Promise<BillingManageGrant>;
  /**
   * 执行一次计费管理动作（发放/调整/退款）：判定门 → 存入（CreditWriter
   * 唯一存入面，幂等键随调用）→ business 域审计事件。账面或审计任一失败
   * 原样上抛。
   */
  performBillingManagementAction(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly action: BillingManageAction;
    readonly amountCents: number;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<BillingManagementOutcome>;
}

export function createBillingManagementService({
  database,
  operator,
  writer,
}: {
  /** owner 通道：授权事实与账面（billing 域 D2 模型，与 MT073 同款）。 */
  database: Database;
  /** 受限 operator 通道：审计事件落域。 */
  operator: OperatorDatabase;
  writer: CreditWriter;
}): BillingManagementService {
  const payer: PayerAccountService = createPayerAccountService(database);

  async function activeMembership(
    tenantId: string,
    principalId: string,
  ): Promise<boolean> {
    const [membership] = await database
      .select({ status: enterpriseMemberships.status })
      .from(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, tenantId),
          eq(enterpriseMemberships.principalId, principalId),
        ),
      )
      .limit(1);
    return membership?.status === "active";
  }

  const requireText = (value: unknown, what: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `BILLING_MANAGE_GRANT_INVALID: ${what} must be a non-empty string`,
      );
    }
    return value;
  };

  const grantOfRow = (
    row: typeof manageGrants.$inferSelect,
  ): BillingManageGrant => ({
    tenantId: row.tenantId,
    principalId: row.principalId,
    grantedBy: row.grantedBy,
    actions: row.actions,
    createdAt: row.createdAt,
  });

  return {
    async grantBillingManager(input) {
      requireText(input?.tenantId, "tenantId");
      requireText(input?.principalId, "principalId");
      requireText(input?.grantedBy, "grantedBy");
      const actions = input.actions ?? [];
      if (
        actions.length === 0 ||
        actions.some((action) => !BILLING_MANAGE_ACTIONS.includes(action))
      ) {
        throw new Error(
          "BILLING_MANAGE_GRANT_INVALID: actions must be a non-empty subset of grant|adjust|refund",
        );
      }
      if (!(await activeMembership(input.tenantId, input.principalId))) {
        throw new Error(
          `BILLING_MANAGE_GRANT_INVALID: grantee ${input.principalId} is not an active member of company ${input.tenantId}`,
        );
      }
      if (!(await activeMembership(input.tenantId, input.grantedBy))) {
        throw new Error(
          `BILLING_MANAGE_GRANT_INVALID: grantor ${input.grantedBy} is not an active member of company ${input.tenantId}`,
        );
      }
      const [existing] = await database
        .select()
        .from(manageGrants)
        .where(
          and(
            eq(manageGrants.tenantId, input.tenantId),
            eq(manageGrants.principalId, input.principalId),
          ),
        )
        .limit(1);
      if (existing) {
        throw new Error(
          `BILLING_MANAGE_GRANT_EXISTS: principal ${input.principalId} already holds the billing management grant of company ${input.tenantId}`,
        );
      }
      const bits = actions.reduce(
        (mask, action) => mask | billingManageActionBit(action),
        0,
      );
      const [row] = await database
        .insert(manageGrants)
        .values({
          tenantId: input.tenantId,
          principalId: input.principalId,
          grantedBy: input.grantedBy,
          actions: bits,
        })
        .returning();
      return grantOfRow(row);
    },

    async revokeBillingManager(input) {
      requireText(input?.tenantId, "tenantId");
      requireText(input?.principalId, "principalId");
      const deleted = await database
        .delete(manageGrants)
        .where(
          and(
            eq(manageGrants.tenantId, input.tenantId),
            eq(manageGrants.principalId, input.principalId),
          ),
        )
        .returning();
      return { revoked: deleted.length > 0 };
    },

    async assertBillingManager(input) {
      requireText(input?.tenantId, "tenantId");
      requireText(input?.principalId, "principalId");
      if (!BILLING_MANAGE_ACTIONS.includes(input.action)) {
        throw new Error("BILLING_MANAGE_REQUIRED");
      }
      if (!(await activeMembership(input.tenantId, input.principalId))) {
        throw new Error(BILLING_MANAGE_REQUIRED);
      }
      const [row] = await database
        .select()
        .from(manageGrants)
        .where(
          and(
            eq(manageGrants.tenantId, input.tenantId),
            eq(manageGrants.principalId, input.principalId),
          ),
        )
        .limit(1);
      if (!row || (row.actions & billingManageActionBit(input.action)) === 0) {
        throw new Error(BILLING_MANAGE_REQUIRED);
      }
      return grantOfRow(row);
    },

    async performBillingManagementAction(input) {
      requireText(input?.tenantId, "tenantId");
      requireText(input?.principalId, "principalId");
      requireText(input?.reason, "reason");
      requireText(input?.idempotencyKey, "idempotencyKey");
      if (
        !BILLING_MANAGE_ACTIONS.includes(input?.action) ||
        !Number.isInteger(input?.amountCents) ||
        input.amountCents <= 0
      ) {
        throw new Error(
          "BILLING_MANAGE_INVALID: action must be grant|adjust|refund with a positive whole amount",
        );
      }
      // 判定门先于一切账务事实读取（拒绝路径零账面读取、零审计写入）。
      await this.assertBillingManager({
        tenantId: input.tenantId,
        principalId: input.principalId,
        action: input.action,
      });
      const mapping = await payer.resolveCompanyCustomer(input.tenantId);
      if (!mapping) {
        throw new Error(
          `BILLING_MANAGE_REQUIRED: company ${input.tenantId} has no billing customer mapping`,
        );
      }
      const deposit = await writer.grantCredits({
        externalCustomerId: mapping.externalCustomerId,
        // 存入面是封闭三源（plan|promo|signin）；管理动作走 promo 并在
        // reason 里带动作语义，审计事件才是动作的类型化记录。
        source: "promo",
        totalCents: input.amountCents,
        expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        reason: `${input.action}: ${input.reason}`,
        idempotencyKey: input.idempotencyKey,
      });
      const { eventId } = await recordTenantAuditEvent(operator, {
        tenantId: input.tenantId,
        domain: "business",
        eventType: `billing.manage.${input.action}`,
        actorId: input.principalId,
        targetId: mapping.externalCustomerId,
        payload: {
          amountCents: input.amountCents,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          inserted: deposit.inserted,
          grantId: deposit.grant.id,
        },
      });
      return {
        action: input.action,
        eventId,
        inserted: deposit.inserted,
        amountCents: input.amountCents,
      };
    },
  };
}
