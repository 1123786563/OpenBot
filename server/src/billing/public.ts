// server/src/billing/public.ts
// MOD10（Issue #630，根 #620）：M07 账务查询、支付收款、权益交付与付款人解析的公开出口门面。
//
// 四族能力，全部是**薄委托**——内件（statements / credits 读面 / payments 读面 /
// entitlement 判定 / payer 族裁决）零改动，账单窗口与分页、余额/流水/授予的
// 读语义、订单所有者过滤、权益缓存与幂等、付款人固定映射逐字节不动：
//
//   accountQuery.planUsage/invoices/invoice
//       → billing/statements.ts BillingStatements 三读（套餐用量 + 账单列表/详情；
//         窗口是调用方的，页大小是部署的，全部内件原样）。
//   accountQuery.catalog/personalBalance/grants/consumption
//       → billing/credits.ts Credits 的**读面四能力**（只 Pick 读面：summary/
//         写面/预扣/结算一律不经此门；catalog 是部署配置的只读映射）。
//   accountQuery.realtimeSessionsForPayer / asyncJobsForPayer
//       → billing/realtime-usage.ts 与 billing/async-jobs-view.ts 的**个人读**
//         （审阅面 asyncJobsForReview 不暴露：管理面不迁移不暴露）。
//   orders.catalog/readOrder/readCurrentOrder
//       → billing/payments/service.ts PaymentService 的**读面三能力**（订单事实；
//         createPurchase/cancelPurchase/handleCallback 写与处置面不暴露）。
//   entitlementDelivery.entitlements
//       → billing/types.ts BillingService.entitlements（权益现有判定与缓存语义
//         全部留在内件；本门只是转交调用）。
//   resolvePayer.personal
//       → billing/payer-personal.ts resolvePayerForPersonalUser（纯函数裁决：
//         只读认证主体自身 id，伪造的账户字段不是入参；服务器订单 Payer 固定
//         映射的既有保证由此转交）。
//
// 边界（Issue #630 验收 + Brief §1/§2 硬约束）：
//   - **写面零暴露**：credits/credits-writer 的写面（MOD09 已立消费通道，本票
//     不 re-export）、购买/取消、奖励领取、管理面、对账、处置与渠道回调都不在
//     本门面成员里；门面对象恰四族、成员即上方清单。
//   - **零新策略、零缓存、零新授权路径**：每个能力逐项委托注入的内件实例，
//     本文件不含任何判定、过滤、重试或账户选择逻辑。`resolvePayer.personal`
//     委托的是组内纯函数——它没有依赖，所以该族在任何装配下都可用。
//   - **依赖按能力分组且可缺省**：装配层只为它实际服务的能力提供依赖；调用
//     未装配组的能力是装配错误，抛 TypeError（与内件对畸形调用的 TypeError
//     纪律同形），不是新的业务拒绝。MOD09 先例。
//   - **类型经组内签名提取**（MOD05-08 先例）：全部成员类型取自组内既有接口
//     的签名（索引访问），本文件不新拟第二套形状。

import type { AsyncJobsViewReader } from "./async-jobs-view";
import type { Credits } from "./credits";
import type { PayerRef } from "./payer";
import {
  type PersonalUserIdentity,
  resolvePayerForPersonalUser,
} from "./payer-personal";
import type { PaymentService } from "./payments/service";
import type { RealtimeUsageReader } from "./realtime-usage";
import type { BillingStatements } from "./statements";
import type { BillingService } from "./types";

// ---------------------------------------------------------------------------
// 四族能力面（成员类型 = 组内签名的索引访问，逐项同一）
// ---------------------------------------------------------------------------

/**
 * 账务查询族：部署自己的钱的两类答案（套餐用量/账单）与本地积分账本的四个
 * 个人读，外加实时会话与异步任务的个人读。
 *
 * 全部是读：每一个成员在内件里都是 SELECT 或纯函数（payer 解析不打开映射行），
 * 账户永远由调用方按会话解析后传入——门面不接受、不推导账户。
 */
export interface BillingAccountQuery {
  /** 套餐用量（statements 内件；`externalCustomerId` 缺省即部署自身）。 */
  planUsage: BillingStatements["planUsage"];
  /** 账单列表（窗口与分页语法在内件；scope 是调用方解析的 Payer 读面）。 */
  invoices: BillingStatements["invoices"];
  /** 单张账单（不存在答 null；scope 过滤在内件）。 */
  invoice: BillingStatements["invoice"];
  /** 部署配置的套餐目录（只读映射，升级对话框的展示面）。 */
  readonly catalog: Credits["catalog"];
  /** 个人余额读（账户类型、可用/已耗/过期/持有与授予的生命期）。 */
  personalBalance: Credits["personalBalance"];
  /** 授予列表（个人读面）。 */
  grants: Credits["grants"];
  /** 流水（与账单同款窗口/分页语法；个人读面）。 */
  consumption: Credits["consumption"];
  /** 个人实时会话消费读（15.8）。 */
  realtimeSessionsForPayer: RealtimeUsageReader["realtimeSessionsForPayer"];
  /** 个人异步任务读（17.8 的用户面；管理审阅面不在本族）。 */
  asyncJobsForPayer: AsyncJobsViewReader["asyncJobsForPayer"];
}

/** 订单事实族：支付服务的三项读取（目录/单订单/当前订单）。写与处置面不在本族。 */
export interface BillingOrders {
  /** 目录（价格在启动时快照；`canPurchase` 与 `activePlanCode` 是调用方的判定）。 */
  catalog: PaymentService["catalog"];
  /** 单订单（scope 过滤在内件：他人的、隔离中的订单不出现在答案里）。 */
  readOrder: PaymentService["readOrder"];
  /** 最新仍活着的订单（pending/paid），或 null。 */
  readCurrentOrder: PaymentService["readCurrentOrder"];
}

/** 权益交付族：权益现有判定（缓存与失效语义全部留在内件）。 */
export interface BillingEntitlementDelivery {
  /** 权益读（按客户键缓存 10 分钟，stale-while-revalidate 在内件）。 */
  entitlements: BillingService["entitlements"];
}

/**
 * 付款人解析族：固定 Payer 的组内纯函数裁决。
 *
 * 安全性质是结构性的：只读认证主体自身的 id，企业 id 或客户端账户字段不是
 * 入参——因此伪造不可能改变答案。渠道回调的 Payer 按服务器订单映射（验收②）
 * 由回调服务自身固定，不经过本族，也不经本门面。
 */
export interface BillingResolvePayer {
  /** 认证用户的个人 PayerRef（缺 id 或带首尾空白即 TypeError，内件原样）。 */
  personal(user: PersonalUserIdentity): PayerRef;
}

/** M07 账务查询/支付收款/权益交付/付款人解析公开门面（恰四族）。 */
export interface BillingEntriesPublic {
  readonly accountQuery: BillingAccountQuery;
  readonly orders: BillingOrders;
  readonly entitlementDelivery: BillingEntitlementDelivery;
  readonly resolvePayer: BillingResolvePayer;
}

// ---------------------------------------------------------------------------
// 构造依赖（按能力分组的最小面；装配层注入既有内件实例）
// ---------------------------------------------------------------------------

/**
 * 门面构造依赖：按能力分组的最小面（Pick，不给内件多开一寸）。
 *
 * 分组可缺省——装配只为它实际服务的能力提供依赖；调用未装配组的能力是装配
 * 错误（TypeError）。`resolvePayer` 族没有依赖：它委托的是组内纯函数。
 */
export interface BillingEntriesPublicDeps {
  /** 账单三读的 statements 内件。 */
  readonly statements?: Pick<
    BillingStatements,
    "planUsage" | "invoices" | "invoice"
  >;
  /** 积分账本的**读面四能力**（写面不在 Pick 里）。 */
  readonly credits?: Pick<
    Credits,
    "catalog" | "personalBalance" | "grants" | "consumption"
  >;
  /** 实时会话个人读。 */
  readonly realtimeUsage?: Pick<
    RealtimeUsageReader,
    "realtimeSessionsForPayer"
  >;
  /** 异步任务个人读（审阅面不注入）。 */
  readonly asyncJobsView?: Pick<AsyncJobsViewReader, "asyncJobsForPayer">;
  /** 支付服务读面三能力（写/处置/回调不在 Pick 里）。 */
  readonly payments?: Pick<
    PaymentService,
    "catalog" | "readOrder" | "readCurrentOrder"
  >;
  /** 权益读（BillingService 的 entitlements 一面）。 */
  readonly entitlement?: Pick<BillingService, "entitlements">;
}

function requireStatements(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["statements"]> {
  if (!deps.statements) {
    throw new TypeError(
      "The billing entries facade was assembled without its statements group; the statement reads have no statements module to delegate to.",
    );
  }
  return deps.statements;
}

function requireCredits(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["credits"]> {
  if (!deps.credits) {
    throw new TypeError(
      "The billing entries facade was assembled without its credits group; the credit-ledger reads have no credits module to delegate to.",
    );
  }
  return deps.credits;
}

function requireRealtimeUsage(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["realtimeUsage"]> {
  if (!deps.realtimeUsage) {
    throw new TypeError(
      "The billing entries facade was assembled without its realtime usage group; the realtime session read has no usage reader to delegate to.",
    );
  }
  return deps.realtimeUsage;
}

function requireAsyncJobsView(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["asyncJobsView"]> {
  if (!deps.asyncJobsView) {
    throw new TypeError(
      "The billing entries facade was assembled without its async jobs view group; the personal async jobs read has no view reader to delegate to.",
    );
  }
  return deps.asyncJobsView;
}

function requirePayments(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["payments"]> {
  if (!deps.payments) {
    throw new TypeError(
      "The billing entries facade was assembled without its payments group; the order reads have no payment service to delegate to.",
    );
  }
  return deps.payments;
}

function requireEntitlement(
  deps: BillingEntriesPublicDeps,
): NonNullable<BillingEntriesPublicDeps["entitlement"]> {
  if (!deps.entitlement) {
    throw new TypeError(
      "The billing entries facade was assembled without its entitlement group; the entitlement delivery read has no billing service to delegate to.",
    );
  }
  return deps.entitlement;
}

/**
 * 构造 M07 公开门面。零新策略、零缓存、零账号推导：每个能力逐项委托 deps 的
 * 既有内件，参数与结果原样转交（本文件里没有一次 `await`、没有一次重试、
 * 没有一处字段重排）。
 */
export function createBillingEntriesPublic(
  deps: BillingEntriesPublicDeps,
): BillingEntriesPublic {
  return {
    accountQuery: {
      planUsage(externalCustomerId) {
        return requireStatements(deps).planUsage(externalCustomerId);
      },
      invoices(window, scope) {
        return requireStatements(deps).invoices(window, scope);
      },
      invoice(id, scope) {
        return requireStatements(deps).invoice(id, scope);
      },
      get catalog() {
        return requireCredits(deps).catalog;
      },
      personalBalance(payer) {
        return requireCredits(deps).personalBalance(payer);
      },
      grants(payer) {
        return requireCredits(deps).grants(payer);
      },
      consumption(window, payer) {
        return requireCredits(deps).consumption(window, payer);
      },
      realtimeSessionsForPayer(payer) {
        return requireRealtimeUsage(deps).realtimeSessionsForPayer(payer);
      },
      asyncJobsForPayer(payer) {
        return requireAsyncJobsView(deps).asyncJobsForPayer(payer);
      },
    },
    orders: {
      catalog(canPurchase, activePlanCode) {
        return requirePayments(deps).catalog(canPurchase, activePlanCode);
      },
      readOrder(id, scope) {
        return requirePayments(deps).readOrder(id, scope);
      },
      readCurrentOrder(scope) {
        return requirePayments(deps).readCurrentOrder(scope);
      },
    },
    entitlementDelivery: {
      entitlements(externalCustomerId) {
        return requireEntitlement(deps).entitlements(externalCustomerId);
      },
    },
    resolvePayer: {
      personal(user) {
        return resolvePayerForPersonalUser(user);
      },
    },
  };
}
