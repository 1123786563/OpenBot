// server/src/billing/vendor-billing.ts
// MT074（波次 16 补位）：供应商计费调用面 + 回调归属锁定。
//
// 职责：平台与外部计费供应商（下称「供应商」）之间公司计费交互的唯一 seam：
//
//   - 调用面 provisionCompanyCustomer（我方 → 供应商）：把调用者公司的客户
//     记录同步给供应商。验收（brief AC1）：调用者身份在进入公司范围**之前**
//     确认——活查成员资格门先于一切公司计费事实读取；供应商只能收到其登记
//     公司的必要计费字段——载荷闭形 {externalId, name}，值全部服务端派生
//     （customer key 从 MT069 唯一映射，绝不臆造；name 从公司行）。输入形状
//     没有客户/载荷字段通道，塞入一律 PAYER_ACCOUNT_FIXED（MT070 同款走私
//     守卫）。
//   - 回调锁 applyVendorCallback（供应商 → 我方）：供应商回调只能作用于其
//     登记公司的付款人与账单（brief AC2）——归属只从供应商侧客户键经唯一
//     映射解析（claimed tenant 只比对、永不决定，MT028 纪律）；跨公司声明
//     VENDOR_CALLBACK_CROSS_COMPANY 零作用。回调期间成员资格中断，处理按
//     MT028 的 fail-closed 规则（brief AC3）——处理时活查 acting principal
//     在映射公司的成员资格（STATE_INITIATOR_INELIGIBLE 同款）：中断/删除 →
//     VENDOR_CALLBACK_MEMBER_INELIGIBLE 拒绝且零作用、不烧状态（恢复后同一
//     回调重投递可成功）。
//   - 审计（brief AC4）：billing_vendor_interactions 每次尝试（applied 与
//     refused 一视同仁）恰一行；detail 只含非值事实（字段名/供应商状态码），
//     客户键、公司名等值绝不入 detail（CHECK + 服务层双保险）。
//
// 消费面全部只读：payer-accounts（MT069 唯一写入面的读方法）、
// billing_customer_mappings（按客户键反查——MT069 表只读 select）、
// enterprise_memberships / enterprise_tenants。供应商词汇（wire 字段名）只在
// 注入的 BillingVendorClient 里，服务面 provider-neutral；测试用 fake 客户端
// 观测「供应商是否被调用」，绝不开真实 socket（Spec §外部服务证据纪律）。
//
// 语义边界：billing_vendor_interactions 是尝试留痕（attempt trail），不是
// 收件箱——供应商事件去重/重放防线在既有 webhook inbox（billing/service.ts，
// 零改动）。错误纪律：计费 seam 哨兵码（`CODE: message`），与 payer-accounts /
// credits-writer / company-reservation 一致；模块零 console、零 process.env。

import { randomBytes } from "node:crypto";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  enterpriseMemberships,
  enterpriseTenants,
} from "../db/schema/enterprise-tenancy";
import { billingCustomerMappings } from "../db/schema/payer-accounts";
import { billingVendorInteractions } from "../db/schema/vendor-billing";
import { createPayerAccountService } from "./payer-accounts";

/** 审计行 id：`bvi-` + 16 hex（与 `baa-`/`bca-` 同款随机宽度）。 */
function generateInteractionId(): string {
  return `bvi-${randomBytes(8).toString("hex")}`;
}

/**
 * 供应商客户端的最小说面：调用面唯一需要的供应商动词。供应商词汇
 * （外部 id 字段名、真实路由/头）属于具体客户端实现（lago.ts 域），
 * 本模块只知道「交出这两个字段、拿回一个状态」。
 */
export type BillingVendorClient = {
  postCustomer(input: {
    externalId: string;
    name: string;
  }): Promise<{ status: number }>;
};

/** 一次供应商调用的结局（传输结局是事实不是异常——lago.ts unreachable 同口径）。 */
export type VendorCallResult =
  | {
      readonly outcome: "applied";
      readonly vendorStatus: number;
      readonly customer: {
        readonly externalId: string;
        readonly name: string;
      };
    }
  | {
      readonly outcome: "refused";
      readonly code: "VENDOR_REJECTED";
      readonly vendorStatus: number;
    }
  | {
      readonly outcome: "refused";
      readonly code: "VENDOR_UNREACHABLE";
    };

/** 回调锁 applied 时披露的付款人事实（本 seam 唯一的账户披露形状）。 */
export interface LockedVendorPayer {
  readonly tenantId: string;
  readonly externalCustomerId: string;
  readonly account: {
    readonly id: string;
    readonly accountType: "company";
    readonly status: "active";
  };
}

/** 一条交互审计（按存储行回答）。 */
export interface VendorInteractionRecord {
  readonly id: string;
  readonly direction: "call" | "callback";
  readonly tenantId: string | null;
  readonly principalId: string | null;
  readonly externalCustomerId: string | null;
  readonly operation: string;
  readonly outcome: "applied" | "refused";
  readonly denialCode: string | null;
  readonly detail: unknown;
  readonly createdAt: Date;
}

function invalid(what: string): Error {
  return new Error(`VENDOR_INPUT_INVALID: ${what}`);
}

function requireNonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${what} must be a non-empty string`);
  }
  return value;
}

/** 回调操作标签：非空且 ≤128（供应商 webhook 类型词，开放集但限长）。 */
function requireOperation(value: unknown): string {
  const operation = requireNonEmpty(value, "operation");
  if (operation.length > 128) {
    throw invalid("operation must be at most 128 characters");
  }
  return operation;
}

export interface VendorBillingService {
  /**
   * 调用面：把调用者公司的客户记录同步给供应商。成功时供应商恰被调用一次，
   * 收到且只收到 {externalId: 映射键, name: 公司名}；每次尝试（applied 与
   * refused）各留一行审计。身份/映射/账户拒绝零供应商调用。
   */
  provisionCompanyCustomer(input: {
    readonly tenantId: string;
    readonly principalId: string;
  }): Promise<VendorCallResult>;

  /**
   * 回调锁：把供应商回调锁定到其登记公司的付款人。applied 时返回锁定的
   * 付款人事实（seam 唯一披露）；一切拒绝在读取任何账户事实之前发生，
   * 零作用、可重投递。
   */
  applyVendorCallback(input: {
    readonly externalCustomerId: string;
    readonly operation: string;
    /** 服务端事实：代表哪位成员承接这次回调（供应商载荷结构上无此字段）。 */
    readonly actingPrincipalId: string;
    /** 可选上下文声明：只与映射公司比对，永不决定归属。 */
    readonly claimedTenantId?: string;
  }): Promise<LockedVendorPayer>;

  /** 审计读：按公司/客户键/方向过滤，新在前。 */
  listInteractions(scope?: {
    readonly tenantId?: string;
    readonly externalCustomerId?: string;
    readonly direction?: "call" | "callback";
  }): Promise<VendorInteractionRecord[]>;
}

export function createVendorBillingService({
  database,
  vendor,
}: {
  database: Database;
  vendor: BillingVendorClient;
}): VendorBillingService {
  const payer = createPayerAccountService(database);

  /**
   * 审计写入：每次尝试恰一行。detail 由调用点给出——只含非值事实
   * （{fields, vendorStatus}），绝不携带客户键/公司名等值。
   */
  async function audit(entry: {
    direction: "call" | "callback";
    tenantId: string | null;
    principalId: string | null;
    externalCustomerId: string | null;
    operation: string;
    outcome: "applied" | "refused";
    denialCode: string | null;
    detail?: unknown;
  }): Promise<void> {
    await database.insert(billingVendorInteractions).values({
      id: generateInteractionId(),
      direction: entry.direction,
      tenantId: entry.tenantId,
      principalId: entry.principalId,
      externalCustomerId: entry.externalCustomerId,
      operation: entry.operation,
      outcome: entry.outcome,
      denialCode: entry.denialCode,
      detail: entry.detail ?? null,
    });
  }

  /** 活查成员资格（fail-closed 身份事实：不缓存、不宽限）。 */
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

  /** 映射客户键下的付款人必须是该公司的活跃公司账户（隔离行不是付款人）。 */
  async function activeCompanyAccount(
    tenantId: string,
    externalCustomerId: string,
  ): Promise<{ id: string } | null> {
    const account = await payer.getAccountByCustomer(externalCustomerId);
    if (
      account?.status !== "active" ||
      account.accountType !== "company" ||
      account.tenantId !== tenantId
    ) {
      return null;
    }
    return { id: account.id };
  }

  return {
    async provisionCompanyCustomer(rawInput) {
      // 走私守卫：付款账户与载荷字段都不是输入（MT070 PAYER_ACCOUNT_FIXED
      // 同款；载荷值只能从服务端事实派生）。
      const smuggled = Object.keys(rawInput ?? {}).find((key) =>
        [
          "externalCustomerId",
          "customer",
          "payer",
          "name",
          "companyName",
        ].includes(key),
      );
      if (smuggled !== undefined) {
        throw new Error(
          `PAYER_ACCOUNT_FIXED: the paying account and the disclosed fields are fixed server-side (${smuggled} is not an input)`,
        );
      }
      const tenantId = requireNonEmpty(rawInput?.tenantId, "tenantId");
      const principalId = requireNonEmpty(rawInput?.principalId, "principalId");
      const operation = "customer.provision";

      // 身份门（brief AC1）：先于一切公司计费事实读取。失败也留审计——
      // 客户键还不可知（映射未读），external_customer_id 为 null。
      if (!(await activeMembership(tenantId, principalId))) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: null,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLER_REQUIRED",
        });
        throw new Error(
          `VENDOR_CALLER_REQUIRED: principal ${principalId} is not an active member of company ${tenantId}`,
        );
      }

      // 映射：公司 ↔ Customer 唯一映射（MT069 交付）是供应商侧身份的唯一
      // 事实源；无映射绝不臆造客户。
      const mapping = await payer.resolveCompanyCustomer(tenantId);
      if (!mapping) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: null,
          operation,
          outcome: "refused",
          denialCode: "CUSTOMER_MAPPING_REQUIRED",
        });
        throw new Error(
          `CUSTOMER_MAPPING_REQUIRED: company ${tenantId} has no billing customer mapping`,
        );
      }

      // 付款人：映射客户键下必须有本公司的活跃公司账户（隔离行不是付款人）。
      const account = await activeCompanyAccount(
        tenantId,
        mapping.externalCustomerId,
      );
      if (!account) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: mapping.externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "COMPANY_ACCOUNT_REQUIRED",
        });
        throw new Error(
          `COMPANY_ACCOUNT_REQUIRED: company ${tenantId} has no active company credit account on customer ${mapping.externalCustomerId}`,
        );
      }

      // 载荷：恰二字段，值全部服务端派生（映射键 + 公司行名）。
      const [company] = await database
        .select({ name: enterpriseTenants.name })
        .from(enterpriseTenants)
        .where(eq(enterpriseTenants.id, tenantId))
        .limit(1);
      const customer = {
        externalId: mapping.externalCustomerId,
        name: company?.name ?? "",
      };

      // 供应商调用：传输结局是事实——applied/refused 都留审计；只有身份/
      // 映射/账户拒绝走哨兵异常。
      let vendorStatus: number;
      try {
        vendorStatus = (await vendor.postCustomer(customer)).status;
      } catch {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: mapping.externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_UNREACHABLE",
          detail: { fields: ["externalId", "name"] },
        });
        return { outcome: "refused", code: "VENDOR_UNREACHABLE" };
      }
      if (vendorStatus < 200 || vendorStatus >= 300) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: mapping.externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_REJECTED",
          detail: { fields: ["externalId", "name"], vendorStatus },
        });
        return {
          outcome: "refused",
          code: "VENDOR_REJECTED",
          vendorStatus,
        };
      }
      await audit({
        direction: "call",
        tenantId,
        principalId,
        externalCustomerId: mapping.externalCustomerId,
        operation,
        outcome: "applied",
        denialCode: null,
        detail: { fields: ["externalId", "name"], vendorStatus },
      });
      return { outcome: "applied", vendorStatus, customer };
    },

    async applyVendorCallback(rawInput) {
      const externalCustomerId = requireNonEmpty(
        rawInput?.externalCustomerId,
        "externalCustomerId",
      );
      const operation = requireOperation(rawInput?.operation);
      const actingPrincipalId = requireNonEmpty(
        rawInput?.actingPrincipalId,
        "actingPrincipalId",
      );
      const claimedTenantId =
        rawInput?.claimedTenantId === undefined
          ? undefined
          : requireNonEmpty(rawInput.claimedTenantId, "claimedTenantId");

      // 归属解析：只从供应商侧客户键经唯一映射（唯一事实源）；未映射键
      // （含个人客户键）对公司回调零作用，且不臆造公司归属（审计行
      // tenant_id 为 null）。
      const [mapping] = await database
        .select({ tenantId: billingCustomerMappings.tenantId })
        .from(billingCustomerMappings)
        .where(
          eq(billingCustomerMappings.externalCustomerId, externalCustomerId),
        )
        .limit(1);
      const tenantId = mapping?.tenantId ?? null;
      if (!tenantId) {
        await audit({
          direction: "callback",
          tenantId: null,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLBACK_UNMAPPED",
        });
        throw new Error(
          `VENDOR_CALLBACK_UNMAPPED: customer ${externalCustomerId} is not the registered billing customer of any company`,
        );
      }

      // 跨公司比对：claimed 只与映射公司比对，永不决定归属；claimed 值
      // 不进审计（MT028 deny 面纪律——拒绝面不回显不可信输入）。
      if (claimedTenantId !== undefined && claimedTenantId !== tenantId) {
        await audit({
          direction: "callback",
          tenantId,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLBACK_CROSS_COMPANY",
        });
        throw new Error(
          `VENDOR_CALLBACK_CROSS_COMPANY: customer ${externalCustomerId} is the registered billing customer of another company`,
        );
      }

      // 存活门（brief AC3，MT028 fail-closed）：回调处理时活查 acting
      // principal 在映射公司的成员资格；中断/删除 → 拒绝、零作用、不烧
      // 状态（恢复后同一回调重投递可成功）。
      if (!(await activeMembership(tenantId, actingPrincipalId))) {
        await audit({
          direction: "callback",
          tenantId,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLBACK_MEMBER_INELIGIBLE",
        });
        throw new Error(
          `VENDOR_CALLBACK_MEMBER_INELIGIBLE: principal ${actingPrincipalId} is not an active member of company ${tenantId}`,
        );
      }

      // 付款人：映射客户键下必须有该公司的活跃公司账户——回调只作用于
      // 登记公司的付款人。
      const account = await activeCompanyAccount(tenantId, externalCustomerId);
      if (!account) {
        await audit({
          direction: "callback",
          tenantId,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "COMPANY_ACCOUNT_REQUIRED",
        });
        throw new Error(
          `COMPANY_ACCOUNT_REQUIRED: company ${tenantId} has no active company credit account on customer ${externalCustomerId}`,
        );
      }

      await audit({
        direction: "callback",
        tenantId,
        principalId: actingPrincipalId,
        externalCustomerId,
        operation,
        outcome: "applied",
        denialCode: null,
      });
      return {
        tenantId,
        externalCustomerId,
        account: { id: account.id, accountType: "company", status: "active" },
      };
    },

    async listInteractions(scope) {
      const filters: SQL[] = [];
      if (scope?.tenantId !== undefined) {
        requireNonEmpty(scope.tenantId, "tenantId");
        filters.push(eq(billingVendorInteractions.tenantId, scope.tenantId));
      }
      if (scope?.externalCustomerId !== undefined) {
        requireNonEmpty(scope.externalCustomerId, "externalCustomerId");
        filters.push(
          eq(
            billingVendorInteractions.externalCustomerId,
            scope.externalCustomerId,
          ),
        );
      }
      if (scope?.direction !== undefined) {
        if (scope.direction !== "call" && scope.direction !== "callback") {
          throw invalid("direction must be 'call' or 'callback'");
        }
        filters.push(eq(billingVendorInteractions.direction, scope.direction));
      }
      const rows = await database
        .select()
        .from(billingVendorInteractions)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(billingVendorInteractions.createdAt));
      return rows.map((row) => ({
        id: row.id,
        direction: row.direction as VendorInteractionRecord["direction"],
        tenantId: row.tenantId,
        principalId: row.principalId,
        externalCustomerId: row.externalCustomerId,
        operation: row.operation,
        outcome: row.outcome as VendorInteractionRecord["outcome"],
        denialCode: row.denialCode,
        detail: row.detail,
        createdAt: row.createdAt,
      }));
    },
  };
}
