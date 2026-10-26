// server/src/approvals/public.ts
// MOD13（Issue #633，根 #620）：M08 ToolAccess 的「审批决定与副作用 receipt」能力组
// ——#633 前半票面的形状：工具审批决定的写入与 receipt 的持久化/读回，作为
// ToolAccess（plugins/public.ts）的 approvals 组对外，构造出口在这里。
//
// 模块目录对 M08 的所有权：「拥有……工具与 sign-in 审批决定、动作参数摘要、
// 执行幂等与外部副作用 receipt」——本文件把其中「决定写入 + receipt 读回/
// 单写者持久化/终态完成」这一面折成一份委托合同；接口合同 C06 的对应句是
// 「ToolAccess 保存……审批决定与副作用 receipt」与「重复批准返回同一决定」。
//
// 薄委托（MOD07/MOD09–12 先例）：零新策略、零缓存、零重试、零过滤。四个成员
// 恰是内件的四个既有判定，逐项恒等转发；本文件新增的只有一份合同：
//
//   决定单发（decide）＝service.decide 的现有判定：pending→approved/denied，
//     已决的请求拒绝第二次决定（store 的「already decided」语义原样透传），
//     所以「重复批准返回同一决定」成立的方式是：第一个决定就是唯一的决定，
//     receipt 读回（receiptOf）永远读回它【验收①】。
//   receipt 读回（receiptOf）＝store.get：重启后重读原 receipt 的读面——
//     等价消费、重启不重发的判定全部建立在这份读上【验收③】。
//   receipt 持久化（saveReceipt）＝store.saveResult：单写者语义在内件（首写者
//     胜，isNull(result) 守卫），回 boolean 是「本进程是否是写下的那个」——
//     装配面用它门控「只有写下的进程才继续会话/通知」，重复发送被这扇门挡住
//     【验收③】。
//   终态完成（complete）＝store.finish。
//
// 边界（硬约束）：
//   - 发问/执行编排面（service.gate/resume/abandon）留 M08 内件——它们是
//     引擎侧的等待与执行流，不是人侧决定面；本组只承「决定与 receipt」。
//   - decideQuiet（craft 会合的静默决定）、consume（单次消费的 CAS 摘要门）、
//     inbox/rules/preferences（HTTP 路由的组内消费）不在此扩面：本票的迁移
//     消费者一个都不需要它们。
//   - equivalenceOf 原样 re-export（approvals/service.ts 的既有纯函数）：
//     参数/目标/来源等价摘要是审批等价合同的公开面，第二处定义才需要理由。
//   - 类型纪律：全部经 Pick<内件,…>/Parameters<…>/Awaited<…> 从 ApprovalService/
//     ApprovalStore 提取，不另拟第二套形状；测试用对象字面量即可成双。

import type { ApprovalService } from "./service";
import type { ApprovalStore } from "./types";

/** 门面触达的服务面：决定的单发判定（`service.decide` 的现有语义）。 */
export type ApprovalsServiceFace = Pick<ApprovalService, "decide">;

/** 门面触达的 store 面：receipt 读回、单写者持久化、终态完成三个既有成员。 */
export type ApprovalsStoreFace = Pick<
  ApprovalStore,
  "get" | "saveResult" | "finish"
>;

/** 决定的写入形状：就是 `service.decide` 的输入（人、请求、四值决定）。 */
type DecideInput = Parameters<ApprovalsServiceFace["decide"]>;
/** 决定写入的回答：决定后的请求记录（status/decision/decidedAt 现状）。 */
type DecideAnswer = Awaited<ReturnType<ApprovalsServiceFace["decide"]>>;
/** receipt 读回的输入（owner + 请求 id——他人的 id 读作不存在，内件语义）。 */
type ReceiptOfInput = Parameters<ApprovalsStoreFace["get"]>;
/** receipt 读回的回答：完整请求记录（含 result 与四个时间戳）。 */
type ReceiptOfAnswer = Awaited<ReturnType<ApprovalsStoreFace["get"]>>;
/** receipt 持久化的输入：result 带 content/error——真实结果，不填假成功。 */
type SaveReceiptInput = Parameters<ApprovalsStoreFace["saveResult"]>;
/** 终态完成的输入。 */
type CompleteInput = Parameters<ApprovalsStoreFace["finish"]>;

/** M08 审批决定与 receipt 能力组。见文件头；被 ToolAccess 的 `approvals`
 * 槽承载（plugins/public.ts 的 `createToolAccess({ store, approvals })`），
 * 也可由装配直接构造后单独使用。 */
export interface ApprovalsAccess {
  /**
   * 写下一个人的审批决定（验收①的决定面）：恒等委托 `service.decide`。
   * pending 之外的请求由内件拒绝（“This request was already decided.”）——
   * 重复批准不产生第二个决定，第一个决定经 {@link ApprovalsAccess.receiptOf}
   * 永远读回同一个。
   */
  decide(...input: DecideInput): Promise<DecideAnswer>;
  /**
   * 读回一个审批请求的 receipt（验收③的读面）：恒等委托 `store.get`。
   * 重启后的进程从这里重读原 receipt——result 已在的请求不再重发外部副作用，
   * 这个判断不发生在门面上，门面只保证读到的是同一条持久事实。
   */
  receiptOf(...input: ReceiptOfInput): Promise<ReceiptOfAnswer>;
  /**
   * 持久化一个请求的结果 receipt（验收③的写面）：恒等委托 `store.saveResult`。
   * 单写者语义在内件：首写者胜、后来者得 false；调用方以这个布尔决定「是否
   * 由本进程继续会话/通知」，两处门面不产生第二份实现。
   */
  saveReceipt(...input: SaveReceiptInput): Promise<boolean>;
  /**
   * 把一个请求置为完成（completed）：恒等委托 `store.finish`。与
   * {@link ApprovalsAccess.saveReceipt} 配对使用，顺序与现状一致
   * （先写 result、再 finish）。
   */
  complete(...input: CompleteInput): Promise<void>;
}

/**
 * 构造审批决定与 receipt 能力组。纯对象创建、零缓存：每次判定都是当次内件
 * 调用；两个注入面（服务的决定判定、store 的 receipt 事实）是本组碰到的全部
 * 内件——多碰一个成员是这份名单的 diff。
 */
export function createApprovalsAccess(deps: {
  service: ApprovalsServiceFace;
  store: ApprovalsStoreFace;
}): ApprovalsAccess {
  const { service, store } = deps;
  return {
    decide: (...input) => service.decide(...input),
    receiptOf: (...input) => store.get(...input),
    saveReceipt: (...input) => store.saveResult(...input),
    complete: (...input) => store.finish(...input),
  };
}

/** 审批等价合同（验收①的等价面）：service.ts 的既有纯函数，原样转发——
 * 参数/目标/来源的等价摘要在那里唯一维护，挥发键（snapshotId/ref/toolCallId/
 * signal）的剥离规则不在门面复制。 */
export { equivalenceOf } from "./service";

/** 决定与 receipt 合同沿带的领域形状（源头 ./types，经此出口供跨模块消费）。 */
export type {
  ApprovalAction,
  ApprovalCandidate,
  ApprovalDecision,
  ApprovalRecord,
} from "./types";
