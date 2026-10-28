// server/src/enterprise/runs/continuations.ts
// MOD13（Issue #633，根 #620）：M05 RunLifecycle 的「WaitRef / claim / 等待状态」
// 能力组——#633 后半票面的形状：Run 侧的等待/恢复记录写取，作为装配与受控
// 内部消费的出口。
//
// 落点裁决（MOD13-report 置顶登记）：MOD07 把 runs/public.ts 的 import 冻结为
// 恰一条（./service）并禁一切 mastra 路径（run-lifecycle-public.test.ts D5 源
// 级钉），M05 模块目录同时把「领取/续约/claim」归为内部 worker/engine 面——
// 本组因此落在本模块的内部合同出口位（目录 §1「integration.ts 或内部 adapter
// 合同；assembly 与指定 Adapter 消费」；integration.ts 本身同样被 MOD07 钉
// 冻结，故为独立文件）。runs/public.ts 的五能力与全部冻结钉零触碰；本组面向
// 装配（assembly/runtime.ts 的审批-恢复接线），不向浏览器开放。
//
// 薄委托（MOD07/MOD09–13 先例）：零新策略、零缓存、零重试、零过滤。六个成员
// 恰是 continuation-store/install 的六个既有面，逐项恒等转发；本文件新增的
// 只有一份合同：
//
//   等待状态读（waitingContinuations/continuationFor）＝store 的 list/get：
//     list 的 principal 收窄（「自己的待办，不是团队看板」）在内件，原样继承。
//   claim 写（claimContinuation）＝store 的单一 CAS claim（验收②）：revision
//     比对 + HMAC 不可伪造 claim token + 过期接管窗口——并发恢复者在这里输给
//     具名冲突，而不是赢来第二次执行。决定形状/参数摘要/终态的守卫也都在
//     内件（decision-shape、argsMismatch、alreadyFinished）。
//   恢复衔接（resumeContinuation）＝install.resume → resumeMastraContinuation
//     的六门编排（身份→租约→代次→指纹→授权→参数摘要→receipt 证据→claim）：
//     idempotent decisionId（already_applied）、executed receipt 复用
//     （reused_receipt）、unknown receipt 待处置（pending_unknown，验收④）——
//     全部现状机制，本组零改写。
//   receipt 证据写读（recordOperationStarted/receiptEvidence）＝unknown 标记
//     的写与读（验收④）：started 在外部副作用可能发生之前记录 outcome-unknown
//     （F1 claim 栅栏：已有 receipt 的后来者得 started:false，不驱动）；没有
//     executed 证据的超时永远读作 unknown，待处置，从不重放。
//
// 边界（硬约束）：
//   - 领取/续约/释放/finish/releaseClaim/saveSuspension 等引擎面留 M05 内件
//     （六门与 drive 的内部协作、execution 路径的停车写入都不是本组消费面）。
//   - 类型经 Pick<内件,…>/Parameters<…> 提取，不另拟第二套形状。

import type {
  MastraContinuationInstall,
  MastraContinuationResumeResult,
} from "../../mastra/approvals";
import type {
  MastraContinuationRecord,
  MastraContinuationStore,
  MastraOperationIdentity,
  MastraOperationStartedResult,
  MastraReceipt,
} from "../../mastra/continuation-store";
import type {
  ClaimedContinuation,
  ResumeDecision,
  ResumeRef,
} from "../../mastra/execution-contracts";

/** 门面触达的 continuation store 面：五个既有成员（读二、claim 一、证据二）。 */
export type ContinuationStoreFace = Pick<
  MastraContinuationStore,
  | "getContinuation"
  | "listContinuations"
  | "claimContinuation"
  | "findReceipt"
  | "recordOperationStarted"
>;

/** 门面触达的恢复入口：install.resume（六门编排的现有入口）。 */
export type ContinuationResumeFace = MastraContinuationInstall["resume"];

/** 等待状态列表的过滤参数（status/limit），形状直取内件签名。 */
type WaitingFilter = Parameters<ContinuationStoreFace["listContinuations"]>[1];

/** 恢复入口的输入（scope + WaitRef + 已认证决定）。 */
type ResumeInput = Parameters<ContinuationResumeFace>[0];

/**
 * 受信业务上下文（M02 的 scope 形状）。MOD07 同律：不直接 import contracts
 * （那条边在 checker 基线里逐文件登记为 cycle 例外，本票承诺 config 零
 * delta），经组内 continuation-store 签名提取——提取物与 contracts 定义
 * 结构同一，零新跨模块边。
 */
type ContinuationScope = Parameters<
  ContinuationStoreFace["getContinuation"]
>[0];

/** M05 Run 侧等待/恢复能力组。见文件头；装配构造后注入消费者。 */
export interface RunContinuations {
  /**
   * 读一条 continuation 的当前记录（WaitRef 读）：恒等委托
   * `store.getContinuation`。他域 scope 读作不存在——内件的字段级身份
   * 比对，原样继承。
   */
  continuationFor(
    scope: ContinuationScope,
    continuationId: string,
  ): Promise<MastraContinuationRecord | null>;
  /**
   * 读等待状态列表（验收②/③ 的读面）：恒等委托 `store.listContinuations`。
   * principal 收窄在内件——一个人的待办，不是团队看板。
   */
  waitingContinuations(
    scope: ContinuationScope,
    filter?: WaitingFilter,
  ): Promise<MastraContinuationRecord[]>;
  /**
   * 取恢复 claim（验收② CAS 单驱动者）：恒等委托 `store.claimContinuation`。
   * revision 比对、HMAC 不可伪造 token、过期接管窗口、决定形状/参数摘要/
   * 终态守卫全部在内件；并发恢复者输在这里的具名冲突上。
   */
  claimContinuation(
    scope: ContinuationScope,
    ref: ResumeRef,
    decision: ResumeDecision,
  ): Promise<ClaimedContinuation>;
  /**
   * 恢复衔接（验收②④）：恒等委托 `install.resume`——六门编排（身份→租约→
   * 代次→指纹→授权→参数摘要）+ receipt 证据先行 + 单一 CAS claim + drive。
   * already_applied / reused_receipt / pending_unknown 的收敛全部是现状
   * 机制；本成员不重试、不补发、不改写任何一门。
   */
  resumeContinuation(
    input: ResumeInput,
  ): Promise<MastraContinuationResumeResult>;
  /**
   * 读一个操作的 receipt 证据（验收④读面）：恒等委托 `store.findReceipt`。
   * executed＝已证明的外部效果；unknown＝已发出但结果未知——超时不证明
   * 未发生，读作 unknown 待处置，从不重放。
   */
  receiptEvidence(
    scope: ContinuationScope,
    operationId: string,
  ): Promise<MastraReceipt | null>;
  /**
   * 写一个操作的 unknown 标记（验收④写面）：恒等委托
   * `store.recordOperationStarted`——在外部副作用可能到达之前记录
   * outcome-unknown；已有 receipt 的后来者得 `started: false`（F1 claim
   * 栅栏），不得驱动。
   */
  recordOperationStarted(
    scope: ContinuationScope,
    operation: MastraOperationIdentity,
  ): Promise<MastraOperationStartedResult>;
}

/**
 * 构造 Run 侧等待/恢复能力组。纯对象创建、零缓存：每个成员都是当次内件
 * 调用；注入的两个面（store 五成员 + install 恢复入口）是本组碰到的全部
 * 内件——多碰一个成员是这份名单的 diff。
 */
export function createRunContinuations(deps: {
  store: ContinuationStoreFace;
  resume: ContinuationResumeFace;
}): RunContinuations {
  const { store, resume } = deps;
  return {
    continuationFor: (scope, continuationId) =>
      store.getContinuation(scope, continuationId),
    waitingContinuations: (scope, filter) =>
      store.listContinuations(scope, filter),
    claimContinuation: (scope, ref, decision) =>
      store.claimContinuation(scope, ref, decision),
    resumeContinuation: (input) => resume(input),
    receiptEvidence: (scope, operationId) =>
      store.findReceipt(scope, operationId),
    recordOperationStarted: (scope, operation) =>
      store.recordOperationStarted(scope, operation),
  };
}
