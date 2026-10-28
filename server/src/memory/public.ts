// server/src/memory/public.ts
// MOD15（Issue #635，根 #620）：M10 PersonalMemory 的业务门面（出口段）。
//
// 十个能力 + 一个组内降级注入，全部是**薄委托**——内件（memory/store.ts、
// memory/ingestion.ts）零改动，审核语义、召回授权、来源撤销的判定逐字节不动：
//
//   recall(owner,botId,search?,company?)   → ingestion.recall（暂停→公司三态→来源
//                                           资格→形成资格→store.retrieve 的整链；
//                                           「未审核不可召回」在内件 eligibleRows
//                                           钉住：reviewState ∈ {confirmed,edited}
//                                           才可能进任何 Bot 的上下文——验收①）。
//   contextFor(owner,botId,company?)       → ingestion.contextFor（同一过滤的注入
//                                           语境形式：quoteMemoryContext 渲染）。
//   remember(owner,input,company?)         → store.create（人明确要求才记）。
//   saveObserved(owner,input,company?)     → store.formMemory（Bot 观察到的事实，
//                                           入候选池待人审——与 recall 的资格差
//                                           即审核语义本身）。
//   forget(owner,id,company?)              → store.remove（本人要求才遗忘）。
//   reviewCandidates(owner,company?)       → store.list（本人的审阅读：候选与已审
//                                           同读，无 reviewState 过滤——审核状态
//                                           语义由这个对照面与 recall 面的差定义）。
//   reviewEdit(owner,id,input,company?)    → store.update（确认/编辑；敏感编辑回
//                                           候选池再确认一次——内件现状）。
//   sources(owner,company?)                → store.sources。
//   bindSource(owner,input,company?)       → store.createSource（公司 pin 在绑定时
//                                           盖一次章，此后每次同步只读它——来源
//                                           范围不随请求扩大，验收②前半）。
//   blockSource(owner,id,enabled,company?) → store.setSourceEnabled（验收②「先阻断」：
//                                           enabled=false 立即失格，下一次召回不再
//                                           读该来源的任何行，先于任何清理动作）。
//   revokeSource(owner,id,company?)        → store.removeSource（验收②「后清理」：
//                                           事务内 lockDefaults→级联删来源行→
//                                           recordOptOut，OpenBot 不再自行加回）。
//   degradedRecall                          → 组内注入的 Hindsight 降级召回门面实例
//                                           （验收③：故障降级仍同一过滤——同一份
//                                           授权/暂停/资格存储，经
//                                           hindsight/degraded-recall 现状语义；
//                                           门面持有的是 B 装配臂构造的那一个实例，
//                                           不存在第二条降级路径）。
//
// 边界（Issue #635 验收 5 + 模块目录 M10 + Interface 合同 PersonalMemory 行）：
//   - **Hindsight 索引/同步实现零暴露**：门面不含 sync-queue、索引写入、drain、
//     revocation ledger 的任何入口——索引与同步装配归 memory/integration.ts 具名臂
//     （B 臂），业务消费者只见本门面。
//   - **零新策略、零缓存**：门面不含任何判定逻辑；每条能力都是对内件既有方法的
//     一次透传，参数与错误原样传递。
//   - **类型纪律（MOD05–14 先例）**：形状经 M10 组内签名以 Parameters<>/ReturnType<>
//     或 Pick<> 收窄；import 面全部 memory/ 与 hindsight/（同属 M10），零新跨模块边。
//   - **迁移 re-export**：M03/AUTOMATION 消费者（agents/agent-resolver.ts 的
//     LoadPersonalMemory、agents/lifecycle-reset.ts 与 proactive/store.ts 的
//     defaults 三函数、proactive/engine.ts 的 MemoryStore 类型）自本文件 import，
//     使 M03↔M10 / AUTOMATION↔M10 的环边落在公开出口上（checker 例外 83/111/
//     600/605 的出口段兑现；第二段=待 M10→M03/AUTOMATION 反向边消失后移除）。
//   - **负向（验收⑤）**：不 re-export openmuse-personal 的任何面，openmuse_memories
//     整表不并入个人记忆（openmuse 是兄弟模块，见 openmuse-personal/memories.ts）。

import type { DegradedRecallFacade } from "../hindsight/degraded-recall";
import type { MemoryIngestion } from "./ingestion";
import type { MemoryStore } from "./store";

export type { MemoryCompany } from "./company";
export { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
export type { MemoryIngestion } from "./ingestion";
export type { MemoryStore } from "./store";
export type { LoadPersonalMemory } from "./tools";

/** The store seams this exit delegates to — the whole review/recall/source face. */
type PersonalMemoryStoreSeams = Pick<
  MemoryStore,
  | "retrieve"
  | "list"
  | "create"
  | "formMemory"
  | "update"
  | "remove"
  | "sources"
  | "createSource"
  | "setSourceEnabled"
  | "removeSource"
>;

/** The ingestion seams this exit delegates to — the authorized recall chain. */
type PersonalMemoryIngestionSeams = Pick<
  MemoryIngestion,
  "recall" | "contextFor"
>;

export function createPersonalMemoryPublic(options: {
  store: PersonalMemoryStoreSeams;
  ingestion: PersonalMemoryIngestionSeams;
  /**
   * 验收③：Hindsight 故障降级召回的**同一个**门面实例——由 B 装配臂
   * （memory/integration.ts createHindsightRecallArm）构造并注入，个人记忆语境
   * 组合的也是它。缺省（未装配 Hindsight 链的部署）读取 degradedRecall 抛装配
   * 错误（TypeError），与既有门面「未装配组的能力是装配错误」纪律同形——
   * 降级路径要么是那一条，要么不存在，没有第二条。
   */
  degradedRecall?: DegradedRecallFacade;
}) {
  const { store, ingestion } = options;
  return {
    /** 验收①：经授权链的召回（未审核在内件被过滤；每次调用重读权威行，无缓存）。 */
    recall: (
      ...args: Parameters<PersonalMemoryIngestionSeams["recall"]>
    ): ReturnType<PersonalMemoryIngestionSeams["recall"]> =>
      ingestion.recall(...args),
    /** 同一过滤的注入语境形式（渲染为一段上下文文本）。 */
    contextFor: (
      ...args: Parameters<PersonalMemoryIngestionSeams["contextFor"]>
    ): ReturnType<PersonalMemoryIngestionSeams["contextFor"]> =>
      ingestion.contextFor(...args),
    /** 人明确要求才记的新事实。 */
    remember: (
      ...args: Parameters<PersonalMemoryStoreSeams["create"]>
    ): ReturnType<PersonalMemoryStoreSeams["create"]> => store.create(...args),
    /** Bot 观察到的事实——入候选池待人审。 */
    saveObserved: (
      ...args: Parameters<PersonalMemoryStoreSeams["formMemory"]>
    ): ReturnType<PersonalMemoryStoreSeams["formMemory"]> =>
      store.formMemory(...args),
    /** 遗忘一条记忆（本人要求）。 */
    forget: (
      ...args: Parameters<PersonalMemoryStoreSeams["remove"]>
    ): ReturnType<PersonalMemoryStoreSeams["remove"]> => store.remove(...args),
    /** 本人的审阅读：候选与已审同读（对照 recall 面即审核语义）。 */
    reviewCandidates: (
      ...args: Parameters<PersonalMemoryStoreSeams["list"]>
    ): ReturnType<PersonalMemoryStoreSeams["list"]> => store.list(...args),
    /** 审阅决定：确认/编辑；敏感编辑回候选池再确认一次（内件现状）。 */
    reviewEdit: (
      ...args: Parameters<PersonalMemoryStoreSeams["update"]>
    ): ReturnType<PersonalMemoryStoreSeams["update"]> => store.update(...args),
    /** 这个人的记忆来源列表。 */
    sources: (
      ...args: Parameters<PersonalMemoryStoreSeams["sources"]>
    ): ReturnType<PersonalMemoryStoreSeams["sources"]> =>
      store.sources(...args),
    /** 绑定一个来源（公司 pin 绑定时盖章一次；验收②来源范围不扩大）。 */
    bindSource: (
      ...args: Parameters<PersonalMemoryStoreSeams["createSource"]>
    ): ReturnType<PersonalMemoryStoreSeams["createSource"]> =>
      store.createSource(...args),
    /** 验收②「先阻断」：enabled=false 立即失格，先于任何清理。 */
    blockSource: (
      ...args: Parameters<PersonalMemoryStoreSeams["setSourceEnabled"]>
    ): ReturnType<PersonalMemoryStoreSeams["setSourceEnabled"]> =>
      store.setSourceEnabled(...args),
    /** 验收②「后清理」：事务内级联删除 + 记下「不再自行加回」。 */
    revokeSource: (
      ...args: Parameters<PersonalMemoryStoreSeams["removeSource"]>
    ): ReturnType<PersonalMemoryStoreSeams["removeSource"]> =>
      store.removeSource(...args),
    /** 验收③：那一条降级召回门面（同一实例注入，或装配错误）。 */
    degradedRecall(): DegradedRecallFacade {
      if (!options.degradedRecall)
        throw new TypeError(
          "PersonalMemory degraded recall is not assembled in this deployment.",
        );
      return options.degradedRecall;
    },
  };
}

export type PersonalMemoryPublic = ReturnType<
  typeof createPersonalMemoryPublic
>;
