// server/src/billing/company-finance-visibility.ts
// MT073（Issue #116）：账务可见性——公司财务读取授权面 + 团队用量汇总视图。
//
// 职责：把「查看公司账务与团队用量」做成**明确管理动作授权**（设计 spec §7：
// 余额共用不把账单变成全员可读；C3：旧按 created_by 限制的订单读取不被直接
// 放宽为全公司成员读取），并在授权门之后给出公司账簿的公司/团队两级投影：
//
//   - 授权事实（billing_company_finance_grants，MT073 任务迁移）：一主体在
//     一家公司至多一行授权；撤销=删行（无可达中间态）；重复授权显式拒绝
//     （FINANCE_GRANT_EXISTS，MT010 SHARE_ALREADY_ACTIVE 同款「显式授权是
//     显式事实」纪律）；grantee/granted_by 两侧复合外键→enterprise_memberships
//     证明都是本公司成员（跨公司授权行结构上不可能，非成员行 DB 层拒绝）。
//   - 判定门（assertCompanyFinanceReader）：活跃成员资格（**活查** status，
//     A5 邻接：停用立即失效）∧ 授权行存在。二者缺一 → 同一哨兵
//     COMPANY_FINANCE_REQUIRED——不区分「无资格/非成员/公司不存在」，错误
//     不泄露存在性（spec A2 不可见语义；与 MT010 的单一 deny 形状同纪律）。
//     tenant_admin 角色不自动获得财务读取（「明确管理动作授权」——角色与
//     授权是两个事实；无授权行的 tenant_admin 与普通成员同形拒绝）。
//   - 账簿（companyBooks）：判定门**先于一切账务事实读取**（拒绝路径零事实
//     读，计数与余额无从泄露）。门后投影：客户映射（MT069 只读）→ 公司账户
//     （MT069 只读）→ 可花余额（credits-writer.availableBalance 权威口径）→
//     用量两级汇总。订单与账单读取**不在本面**：支付订单继续按创建人 scope
//     过滤（payments/store ownerScopeCondition，本票零修改——AC1/AC4 的正反
//     两面都是该既有语义的回归钉死）；财务授权不产订单 scope，也不消费它。
//   - 用量口径（AC3）：byTeam/byUser = MT070 usageSummary 的归属×预扣投影
//     （只读消费，零复制）；companyTotal = **账户侧独立口径**（credit_
//     reservations WHERE external_customer_id = 公司映射客户）——两个口径
//     一致即「归属覆盖」不变量的真实检验（公司账户每笔持有都有归属行，
//     MT070 合同），而非同源重复计算。个人直连消费（个人账户预扣，无公司
//     归属行）在两个口径都不出现：归属侧按 tenant 过滤、账户侧按公司客户
//     过滤。
//
// 错误纪律：计费 seam 哨兵码（`CODE: message`），与 credits-writer /
// payer-accounts / company-reservation 一致；账簿投影只含公司账务事实
// （映射客户、账户状态、余额、用量），不含账户内部键。

import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCompanyFinanceGrants } from "../db/schema/company-finance";
import { creditReservations } from "../db/schema/credit-reservations";
import { usageOutbox } from "../db/schema/usage-outbox";
import { enterpriseMemberships } from "../db/schema/enterprise-tenancy";
import { usageOutbox } from "../db/schema/usage-outbox";
import {
  type CompanyUsageSummary,
  createCompanyReservationService,
} from "./company-reservation";
import type { CreditWriter } from "./credits-writer";
import {
  createPayerAccountService,
  type PayerAccountService,
} from "./payer-accounts";
import type { PaymentStore } from "./payments/types";
import {
  anomalyProgressOf,
  type PaymentEventReader,
  paymentRecordOf,
} from "./statements";
import type { BillingInvoice } from "./types";

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司用量证据行（usage_outbox 的只读投影；×100 缩放整数与 token 数原样）。 */
export interface CompanyUsageLine {
  readonly eventId: string;
  readonly source: "llm" | "code_run";
  readonly model: string;
  /** 公司工作台调用的团队维度；null = 无团队维度的公司行（与表同形）。 */
  readonly workspaceId: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservationId: string | null;
  readonly occurredAt: Date;
}

/** 一条公司财务读取授权（按存储行回答）。 */
export interface CompanyFinanceGrant {
  readonly tenantId: string;
  readonly principalId: string;
  /** 授权管理动作的发出主体（trail；与被授权人同为该公司成员）。 */
  readonly grantedBy: string;
  readonly createdAt: Date;
}

/** 公司账簿的用量两级汇总口径（×100 缩放整数）。 */
export interface CompanyUsageTotals {
  /** 活动预扣上限之和（reserved.maximum）。 */
  readonly heldUnits: number;
  /** 已结算入账之和（settled.charged）。 */
  readonly chargedUnits: number;
}

/** 公司账簿投影（判定门后的唯一账务读取形状）。 */
export interface CompanyBooks {
  readonly tenantId: string;
  /** 本次读取的授权事实（谁授的、何时授的——trail 随读随显）。 */
  readonly authorization: {
    readonly principalId: string;
    readonly grantedBy: string;
    readonly grantedAt: Date;
  };
  /** 公司 ↔ 计费 Customer 唯一映射；无映射为 null（诚实空账簿）。 */
  readonly customer: {
    readonly externalCustomerId: string;
    readonly boundAt: Date;
  } | null;
  /** 公司积分账户（只投影账务事实）；无映射或无账户为 null。 */
  readonly account: {
    readonly externalCustomerId: string;
    readonly status: "active" | "quarantined";
    /** 隔离态必留的原因（能力不可用原因的账户级答案）；active 行为 null。 */
    readonly quarantineReason: string | null;
  } | null;
  /** 公司账户当前可花余额（credits-writer 权威口径；无账户为 0）。 */
  readonly balanceUnits: number;
  /**
   * 公司支付记录（BP07/#375）：公司 PayerRef 名下最近订单的统一投影（金额/币种/渠道/
   * 收款时间/付款账户标识/交付进度/异常进度）——与个人支付记录同一 `BillingInvoice`
   * 形状（statements.paymentRecordOf），只读消费既有订单行，零新账务。判定门后读取；
   * 无映射为诚实空列表。
   */
  readonly payments: readonly BillingInvoice[];
  readonly usage: {
    /** 公司总额：账户侧独立口径（按公司映射客户的预扣投影）。 */
    readonly companyTotal: CompanyUsageTotals;
    /** 归属侧投影（MT070 usageSummary，只读）：团队行。 */
    readonly byTeam: CompanyUsageSummary["byTeam"];
    /** 归属侧投影（MT070 usageSummary，只读）：使用人行。 */
    readonly byUser: CompanyUsageSummary["byUser"];
  };
}

export type CompanyFinanceGrantInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly grantedBy: string;
};

export interface CompanyFinanceVisibilityService {
  /**
   * 授予「查看公司账务与团队用量」授权。grantee 与 grantedBy 都必须是该公司的
   * 活跃成员；已有活跃授权 → FINANCE_GRANT_EXISTS（显式拒绝，不静默刷新）。
   */
  grantCompanyFinanceReader(
    input: CompanyFinanceGrantInput,
  ): Promise<CompanyFinanceGrant>;

  /** 撤销授权（删行）。幂等：无授权行返回 { revoked: false }。 */
  revokeCompanyFinanceReader(input: {
    tenantId: string;
    principalId: string;
  }): Promise<{ revoked: boolean }>;

  /** 一家公司的全部财务读取授权（trail 面）。 */
  financeReadersOf(tenantId: string): Promise<readonly CompanyFinanceGrant[]>;

  /**
   * 判定门：活跃成员资格 ∧ 授权行存在。二者缺一（含公司不存在、非成员、
   * 停用成员、无授权的管理员）→ 同一哨兵 COMPANY_FINANCE_REQUIRED。
   */
  assertCompanyFinanceReader(input: {
    tenantId: string;
    principalId: string;
  }): Promise<CompanyFinanceGrant>;

  /** 公司账簿 + 团队用量两级汇总（判定门后；拒绝路径零账务事实读取）。 */
  companyBooks(input: {
    tenantId: string;
    principalId: string;
  }): Promise<CompanyBooks>;
  /**
   * 公司用量证据行（MT097 / Issue #140 AC3）：判定门后从**已交付的 usage_outbox**
   * （billing 侧 Bifrost 09 链路）只读投影最近用量行——按公司映射客户过滤，个人
   * Bifrost 直连消费（个人客户的行）**结构性不在答案里**，不是服务层自觉过滤。
   * 只读消费，零复制、零新账务；行可经 reservationId 关联结算明细（0189 维度拆分、
   * 0197 异步结算行）——本投影不 join，明细归各自交付面。
   */
  recentUsageLines(input: {
    tenantId: string;
    principalId: string;
    limit?: number;
  }): Promise<readonly CompanyUsageLine[]>;
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `FINANCE_GRANT_INVALID: ${what} must be a non-empty string`,
    );
  }
  return value;
}

function grantOfRow(
  row: typeof billingCompanyFinanceGrants.$inferSelect,
): CompanyFinanceGrant {
  return {
    tenantId: row.tenantId,
    principalId: row.principalId,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
  };
}

export function createCompanyFinanceVisibilityService({
  database,
  writer,
  orders,
  events,
}: {
  database: Database;
  writer: CreditWriter;
  /**
   * 公司支付记录的只读来源（BP07/#375）：payments 模块自己的窗口读。缺省为「无支付记录」
   * ——与无映射同一诚实空语义，绝不以替身放行；判定门先于本读，拒绝路径零订单行读取。
   */
  orders?: Pick<PaymentStore, "listOrdersInWindow">;
  /** 订单异常事件的只读来源；缺省为无异常记录（零错误）。
   */
  events?: PaymentEventReader;
}): CompanyFinanceVisibilityService {
  const payer: PayerAccountService = createPayerAccountService(database);
  // MT070 归属×预扣投影的唯一权威实现（只读消费，零复制）。
  const companyCalls = createCompanyReservationService({ database, writer });
  // 公司支付记录的窗口大小：最近一笔起最近 20 笔，与个人账单页同一页大小
  // （statements 的 INVOICE_PAGE_SIZE）——一个读屏的量，不是一次导出。
  const COMPANY_PAYMENT_RECORD_LIMIT = 20;

  /** 成员资格活查：row 存在且 active 才算数（停用立即失效，A5 邻接）。 */
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

  return {
    async grantCompanyFinanceReader(input) {
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.principalId, "principalId");
      requireNonEmpty(input?.grantedBy, "grantedBy");
      // 显式授权只发给活跃成员、只由活跃成员发出（复合 FK 是 DB 兜底：
      // 非成员行结构上不可能；这里把 FK 事实翻译成类型化哨兵，拒绝零写入）。
      if (!(await activeMembership(input.tenantId, input.principalId))) {
        throw new Error(
          `FINANCE_GRANT_INVALID: grantee ${input.principalId} is not an active member of company ${input.tenantId}`,
        );
      }
      if (!(await activeMembership(input.tenantId, input.grantedBy))) {
        throw new Error(
          `FINANCE_GRANT_INVALID: grantor ${input.grantedBy} is not an active member of company ${input.tenantId}`,
        );
      }
      const [existing] = await database
        .select()
        .from(billingCompanyFinanceGrants)
        .where(
          and(
            eq(billingCompanyFinanceGrants.tenantId, input.tenantId),
            eq(billingCompanyFinanceGrants.principalId, input.principalId),
          ),
        )
        .limit(1);
      if (existing) {
        // 授权是显式事实：重复授予响亮拒绝，绝不静默刷新 grantedBy/时间。
        throw new Error(
          `FINANCE_GRANT_EXISTS: principal ${input.principalId} already holds the company finance read grant of company ${input.tenantId}`,
        );
      }
      const [row] = await database
        .insert(billingCompanyFinanceGrants)
        .values({
          tenantId: input.tenantId,
          principalId: input.principalId,
          grantedBy: input.grantedBy,
        })
        .returning();
      return grantOfRow(row);
    },

    async revokeCompanyFinanceReader(input) {
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.principalId, "principalId");
      // 撤销 = 删行：无可达中间态；判定现场核对使撤销立即生效。
      const deleted = await database
        .delete(billingCompanyFinanceGrants)
        .where(
          and(
            eq(billingCompanyFinanceGrants.tenantId, input.tenantId),
            eq(billingCompanyFinanceGrants.principalId, input.principalId),
          ),
        )
        .returning();
      return { revoked: deleted.length > 0 };
    },

    async financeReadersOf(tenantId) {
      requireNonEmpty(tenantId, "tenantId");
      const rows = await database
        .select()
        .from(billingCompanyFinanceGrants)
        .where(eq(billingCompanyFinanceGrants.tenantId, tenantId));
      return rows.map(grantOfRow);
    },

    async assertCompanyFinanceReader(input) {
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.principalId, "principalId");
      const [row] = await database
        .select()
        .from(billingCompanyFinanceGrants)
        .where(
          and(
            eq(billingCompanyFinanceGrants.tenantId, input.tenantId),
            eq(billingCompanyFinanceGrants.principalId, input.principalId),
          ),
        )
        .limit(1);
      const memberActive = await activeMembership(
        input.tenantId,
        input.principalId,
      );
      // 单一拒绝形状：授权行缺失、成员停用、公司不存在彼此不可区分
      // （错误不泄露存在性）；固定句子保证跨形状逐字节相同。
      if (!row || !memberActive) {
        throw new Error(
          "COMPANY_FINANCE_REQUIRED: company billing books are readable only by an explicitly authorized company finance reader",
        );
      }
      return grantOfRow(row);
    },

    async companyBooks(input) {
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.principalId, "principalId");
      // 判定门先行：拒绝路径零账务事实读取（余额/映射/用量无从泄露）。
      const grant = await this.assertCompanyFinanceReader({
        tenantId: input.tenantId,
        principalId: input.principalId,
      });

      const mapping = await payer.resolveCompanyCustomer(input.tenantId);
      const account = mapping
        ? await payer.getAccountByCustomer(mapping.externalCustomerId)
        : null;
      const balanceUnits =
        mapping && account
          ? await writer.availableBalance(mapping.externalCustomerId)
          : 0;

      /*
       * 公司支付记录（BP07/#375）：订单的 owner scope 读，PayerRef 是**本服务自己**从
       * tenantId 派生的公司主体（payer-company.ts 的同款字面），不是调用方传的——判定门
       * 已过，此处才碰订单行。与个人支付记录同一投影（paymentRecordOf），最近 20 笔；
       * 异常进度一次批量读。无 store 或无映射 → 诚实空列表。
       */
      let payments: readonly BillingInvoice[] = [];
      if (orders && mapping) {
        const rows = await orders.listOrdersInWindow({
          from: null,
          to: null,
          limit: COMPANY_PAYMENT_RECORD_LIMIT,
          offset: 0,
          scope: {
            actorPayerRef: { kind: "company", id: input.tenantId },
          },
        });
        const progress = events
          ? await anomalyProgressOf(
              events,
              rows.map((row) => row.id),
            )
          : new Map<string, BillingInvoice["anomalies"]>();
        payments = rows.map((row) =>
          paymentRecordOf(row, progress.get(row.id) ?? []),
        );
      }

      // 公司总额：账户侧独立口径——按公司映射客户投影预扣表，不经归属行。
      const heldUnits = sql<number>`coalesce(sum(case when ${creditReservations.status} = 'reserved' then ${creditReservations.maximum} else 0 end), 0)::int`;
      const chargedUnits = sql<number>`coalesce(sum(case when ${creditReservations.status} = 'settled' then coalesce(${creditReservations.charged}, 0) else 0 end), 0)::int`;
      const [accountSide] = mapping
        ? await database
            .select({ heldUnits, chargedUnits })
            .from(creditReservations)
            .where(
              eq(
                creditReservations.externalCustomerId,
                mapping.externalCustomerId,
              ),
            )
        : [{ heldUnits: 0, chargedUnits: 0 }];

      const summary = await companyCalls.usageSummary(input.tenantId);
      return {
        tenantId: input.tenantId,
        authorization: {
          principalId: grant.principalId,
          grantedBy: grant.grantedBy,
          grantedAt: grant.createdAt,
        },
        customer: mapping
          ? {
              externalCustomerId: mapping.externalCustomerId,
              boundAt: mapping.createdAt,
            }
          : null,
        account: account
          ? {
              externalCustomerId: account.externalCustomerId,
              status: account.status,
              quarantineReason: account.quarantineReason,
            }
          : null,
        balanceUnits,
        payments,
        usage: {
          companyTotal: {
            heldUnits: accountSide.heldUnits,
            chargedUnits: accountSide.chargedUnits,
          },
          byTeam: summary.byTeam,
          byUser: summary.byUser,
        },
      };
    },

    async recentUsageLines(input) {
      requireNonEmpty(input?.tenantId, "tenantId");
      requireNonEmpty(input?.principalId, "principalId");
      // 判定门先行（与 companyBooks 同一门）：拒绝路径零用量行读取。
      await this.assertCompanyFinanceReader({
        tenantId: input.tenantId,
        principalId: input.principalId,
      });
      const mapping = await payer.resolveCompanyCustomer(input.tenantId);
      if (!mapping) {
        // 诚实空：无映射即无公司用量行（个人直连消费不在本面，也无处可泄）。
        return [];
      }
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const rows = await database
        .select({
          eventId: usageOutbox.eventId,
          source: usageOutbox.source,
          model: usageOutbox.model,
          workspaceId: usageOutbox.workspaceId,
          inputTokens: usageOutbox.inputTokens,
          outputTokens: usageOutbox.outputTokens,
          reservationId: usageOutbox.reservationId,
          occurredAt: usageOutbox.occurredAt,
        })
        .from(usageOutbox)
        .where(eq(usageOutbox.externalCustomerId, mapping.externalCustomerId))
        .orderBy(desc(usageOutbox.occurredAt))
        .limit(limit);
      return rows.map((row) => ({
        eventId: row.eventId,
        source: row.source,
        model: row.model,
        workspaceId: row.workspaceId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reservationId: row.reservationId,
        occurredAt: row.occurredAt,
      }));
    },
  };
}
