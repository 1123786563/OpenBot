// server/src/enterprise/models/public.ts
// MOD09（Issue #629，根 #620）：M06 受管模型调用与双重预算出口门面（出口段）。
//
// 七个能力，全部是**薄委托**——内件（models/budget.ts、models/gateway.ts）
// 与 billing/credit 判定零改动，token 预算的幂等/上限校验、受管调用的能力
// 授权、资金预扣的余额与冲突语义逐字节不动：
//
//   authorizeInvocation(request)   → 注入的 Run capability 协作者 resolve
//                                    （受管调用的授权使用判定：scope/run/
//                                    attempt/generation/路由/上限的绑定检查
//                                    留在 M05 内件，本门面只暴露组合同形的
//                                    委托门）。合同候选名 authorizeInvocation。
//   reserveBudget(scope,input,opt) → models/budget reserveModelBudget（token
//                                    侧预留：run ceiling 幂等键、预算夹逼、
//                                    402 语义全部内件原样）。
//   settleInvocation(scope,id,tok) → models/budget confirm（token 结算确认：
//                                    重放同用量返回、超预留拒绝）。**token
//                                    确认不冒充资金结算**——本门不触碰资金
//                                    侧 ledger（验收⑤）。
//   releaseUnknown(scope,id)       → models/budget release（仅 reserved 可放；
//                                    confirmed 拒绝、ceiling 不可放——未知
//                                    费用永不经此门释放，验收③）。
//   reserveInvocationHold(input)   → 注入资金协作者 reserveCredits（资金侧
//                                    预扣：幂等键重放答原预扣，余额不足
//                                    reserved:false 原样）。
//   releaseInvocationHold(id,why)  → 注入资金协作者 releaseReservation（仅
//                                    reserved 可放；unknown 拒绝——普通释放
//                                    门从不是第二道未知处置门）。
//   markInvocationHoldUnknown(id,why) → 注入资金协作者 markReservationUnknown
//                                    （取消/断流等未知结果的唯一去向，验收③）。
//
// 边界（Issue #629 验收 2/3 + 模块目录 M06/M07 + 检查器 654 零 delta 前提）：
//   - **零 runs/store import（验收②）**：Run 协作者（capability resolve/确认/
//     标记未知）经构造注入的协作者接口进入——依赖倒置，非模块 import；M05
//     capability 面仍是 worker/engine 内部 Interface。类型全部经组内签名提取
//     （MOD05/06/07/08 先例）。
//   - **零 billing import（M06→M07 不是既有边）**：资金协作者类型按 MOD06
//     参数签名先例在注入点就地书写（结构与 billing/credits-writer 的
//     CreditWriter 相应方法逐字段同一，结构类型保证生产实例可注入）。
//   - **价格/上限依据集中（验收③）**：token 上限只出自 budget 内件的既有
//     判定，资金预扣金额只出自调用方装配传入的定价策略（runtime 组合体），
//     原始 Payer 与价格版本由调用点一次固定、各写入方共用——门面不含任何
//     定价、重试或账户切换策略。
//   - **零新策略、零缓存、零新 durable 权威**：门面不含任何判定逻辑，逐项
//     透传；依赖按能力分组且可缺省，调用未装配组的能力是装配错误，抛
//     TypeError（与内件对畸形调用的 TypeError 纪律同形），不是新的业务拒绝。

import type { createModelBudgetService } from "./budget";
import type {
  AuthorizedModelInvocation,
  ResolveAuthorizedInvocation,
} from "./gateway";

// ---------------------------------------------------------------------------
// 输入/结果形状（源头 = M06 组内签名，逐项提取）
// ---------------------------------------------------------------------------

/** 内件 token 预算服务实例（M06 组内；其公开能力即本门面的委托目标）。 */
type InternalModelBudgetService = ReturnType<typeof createModelBudgetService>;

/** 受信业务上下文（budget 内件签名原样）。 */
export type ModelBudgetScope = Parameters<
  InternalModelBudgetService["reserveModelBudget"]
>[0];

/** token 预算输入（budget 内件签名原样：runId/modelRouteRef/maximumTokens）。 */
export type ModelBudgetRequestInput = Parameters<
  InternalModelBudgetService["reserveModelBudget"]
>[1];

/** token 预留选项（budget 内件签名原样：幂等键/过期/run ceiling）。 */
export type ModelBudgetReservationOptions = NonNullable<
  Parameters<InternalModelBudgetService["reserveModelBudget"]>[2]
>;

/** token 预算预留答案（budget 内件签名原样）。 */
export type ModelBudgetReservation = Awaited<
  ReturnType<InternalModelBudgetService["reserveModelBudget"]>
>;

/** 受管调用的授权答案（gateway 组内合同原样：context + confirmUsage +
 *  markUnknown——结算与未知标记仍走这两个具名动作）。 */
export type AuthorizedInvocation = AuthorizedModelInvocation;

/** 受管调用授权协作者的最小面（Run capability resolve 的注入合同；运行实例
 *  由装配层从 M05 内件组合注入，本门面从不 import runs/store）。 */
export type InvocationAuthorizer = ResolveAuthorizedInvocation;

/** 资金预扣答案（资金协作者 reserveCredits 的判别形状，就地结构同一定义：
 *  与 billing/credits-writer CreditWriter.reserveCredits 的返回逐字段同一）。 */
export type InvocationHoldReservation =
  | { reserved: true; reservationId: string }
  | { reserved: false; availableCents: number };

/**
 * 资金协作者的最小面（M06→M07 禁边下的参数签名提取，MOD06 先例）：仅暴露
 * 受管调用链实际使用的三道门，方法签名与 CreditWriter 相应方法逐字段同一
 * （生产实例 `createCreditWriter(database)` 的返回结构可注入）。
 */
export interface ModelBudgetCreditCollaborator {
  /** 资金预扣（幂等键重放答原预扣；拒绝写不进任何东西并报告可用余额）。 */
  reserveCredits(input: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }): Promise<InvocationHoldReservation>;
  /** 普通释放（仅 reserved；unknown/terminal 拒绝语义留在内件）。 */
  releaseReservation(reservationId: string, reason: string): Promise<void>;
  /** 未知结果标记（取消/断流/缺用量——容量继续占用，验收③）。 */
  markReservationUnknown(reservationId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M06 受管调用与双重预算公开门面（Issue #629：token 预算链 + 受管调用授权
 *  + 资金预扣门的统一出口；dispatch 仍是 M06 组内 Adapter 内部面）。 */
export interface ModelBudgetPublic {
  /** 受管调用授权：委托注入的 Run capability 协作者（验收②注入面）。 */
  authorizeInvocation(request: Request): Promise<AuthorizedInvocation>;
  /** token 预算预留：委托 budget 内件 reserveModelBudget。 */
  reserveBudget(
    scope: ModelBudgetScope,
    input: ModelBudgetRequestInput,
    options?: ModelBudgetReservationOptions,
  ): Promise<ModelBudgetReservation>;
  /** token 结算确认：委托 budget 内件 confirm（不冒充资金结算，验收⑤）。 */
  settleInvocation(
    scope: ModelBudgetScope,
    reservationId: string,
    usedTokens: number,
  ): Promise<void>;
  /** token 释放（仅 reserved；未知费用永不经此门释放，验收③）。 */
  releaseUnknown(scope: ModelBudgetScope, reservationId: string): Promise<void>;
  /** 资金预扣：委托注入资金协作者 reserveCredits。 */
  reserveInvocationHold(input: {
    externalCustomerId: string;
    idempotencyKey: string;
    maximumCents: number;
    expiresAt: Date;
  }): Promise<InvocationHoldReservation>;
  /** 资金普通释放：委托注入资金协作者 releaseReservation。 */
  releaseInvocationHold(reservationId: string, reason: string): Promise<void>;
  /** 资金未知标记：委托注入资金协作者 markReservationUnknown。 */
  markInvocationHoldUnknown(
    reservationId: string,
    reason: string,
  ): Promise<void>;
}

/** 门面构造依赖：按能力分组的最小面（装配层注入既有内件实例/协作者）。
 *  分组可缺省——装配只为它实际服务的能力提供依赖；调用未装配组的能力是
 *  装配错误。 */
export interface ModelBudgetPublicDeps {
  /** authorizeInvocation 的 Run capability 协作者（构造注入，非 import）。 */
  readonly invocations?: {
    readonly resolveInvocation: InvocationAuthorizer;
  };
  /** token 预算链的 budget 内件实例（reserve/confirm/release 最小面）。 */
  readonly budget?: Pick<
    InternalModelBudgetService,
    "reserveModelBudget" | "confirm" | "release"
  >;
  /** 资金三道门的既有 writer（billing CreditWriter 结构注入）。 */
  readonly credits?: ModelBudgetCreditCollaborator;
}

function requireInvocations(
  deps: ModelBudgetPublicDeps,
): NonNullable<ModelBudgetPublicDeps["invocations"]> {
  if (!deps.invocations) {
    throw new TypeError(
      "The model budget facade was assembled without its invocations group; authorizeInvocation has no Run capability collaborator to delegate to.",
    );
  }
  return deps.invocations;
}

function requireBudget(
  deps: ModelBudgetPublicDeps,
): NonNullable<ModelBudgetPublicDeps["budget"]> {
  if (!deps.budget) {
    throw new TypeError(
      "The model budget facade was assembled without its budget group; the token budget chain has no budget service to delegate to.",
    );
  }
  return deps.budget;
}

function requireCredits(
  deps: ModelBudgetPublicDeps,
): NonNullable<ModelBudgetPublicDeps["credits"]> {
  if (!deps.credits) {
    throw new TypeError(
      "The model budget facade was assembled without its credits group; the invocation hold doors have no credit writer to delegate to.",
    );
  }
  return deps.credits;
}

/**
 * 构造 M06 受管调用与双重预算门面。零新策略、零缓存、零写入判定：每个能力
 * 逐项委托 deps 的既有内件/协作者，token 幂等与 402 语义、授权绑定检查、
 * 资金余额与冲突语义全部留在内件，逐字节不动。
 */
export function createModelBudgetPublic(
  deps: ModelBudgetPublicDeps,
): ModelBudgetPublic {
  return {
    authorizeInvocation(request) {
      return requireInvocations(deps).resolveInvocation(request);
    },
    reserveBudget(scope, input, options) {
      return requireBudget(deps).reserveModelBudget(scope, input, options);
    },
    settleInvocation(scope, reservationId, usedTokens) {
      return requireBudget(deps).confirm(scope, reservationId, usedTokens);
    },
    releaseUnknown(scope, reservationId) {
      return requireBudget(deps).release(scope, reservationId);
    },
    reserveInvocationHold(input) {
      return requireCredits(deps).reserveCredits(input);
    },
    releaseInvocationHold(reservationId, reason) {
      return requireCredits(deps).releaseReservation(reservationId, reason);
    },
    markInvocationHoldUnknown(reservationId, reason) {
      return requireCredits(deps).markReservationUnknown(reservationId, reason);
    },
  };
}
