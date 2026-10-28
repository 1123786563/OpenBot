// server/src/enterprise/conversations/public.ts
// MOD06（Issue #626，根 #620）：M04 Conversation 的业务门面（C05 出口段）。
//
// 五个能力，全部是**薄委托**——内件（conversations/service.ts、store.ts、
// mastra-intent-reconciler.ts）零改动，幂等键/序号保留/intent 对账/事务与锁序
// 语义逐字节不动：
//
//   list(scope)                        → createConversationService().list：
//                                        本 principal 可见的会话清单（服务端
//                                        成员事实过滤，现状路径原样）。
//   getOrCreate(scope, input)          → createConversationService().getOrCreate：
//                                        会话取得/创建的现有幂等路径。
//   history(scope, input)              → createConversationService().history：
//                                        已授权完成历史分页——与模型读取
//                                        （mastra/conversation-runtime.ts 经 M02
//                                        contracts 注入 deps.conversations.history）
//                                        同一读取本体；history 不返回未完成
//                                        intent（interface-contracts C05）。
//   append(scope, input)               → createConversationService().append：
//                                        用户消息提交的单一写入口（clientMessageKey
//                                        幂等：同 key 同输入一份、同键异输入
//                                        message_conflict 409——内件合同原样）。
//   appendEngineMessage(scope, input)  → createConversationService().
//                                        appendEngineMessage：**引擎输出的唯一
//                                        写入口**（server 签发幂等键
//                                        executionKey:engineMessageId，重试解析到
//                                        同一 intent，不新增重复消息；engine append
//                                        不接受伪造作者——EngineMessageAppendInput
//                                        无客户端作者字段）。
//
// 边界（Issue #626 验收 5 + 模块目录 M04 + Interface 合同 C05）：
//   - **引擎存储零暴露**：门面不含 resolveBackend / resolveMastraBinding——
//     Mastra binding/存储编解码是 M04 内部 Adapter（模块目录 M04「Conversation
//     不向普通调用方暴露 resolveMastraBinding」）；这两个方法留在内件服务上，
//     模型读路径（conversation-runtime）经内部合同继续消费，普通调用方经本门面
//     只见业务能力。
//   - 不 re-export ConversationService/store/DTO 整对象：消费面 = 上述五能力 +
//     其输入/结果形状；构造依赖用 Pick<内件服务, 五能力> 最小面
//     （conversation-public.test.ts D5 结构断言钉死）。
//   - 类型纪律（MOD05 先例）：形状源头是 M02 enterprise/contracts（PlatformScope/
//     *Input/*DTO/MessagePage/EngineMessageAppendInput），但为守住检查器 654 零
//     delta（module-imports.json 预期零 delta），本文件不直接 import M02——全部
//     经 M04 组内 service.ts 工厂签名以 Parameters<>/Awaited<>/ReturnType<> 提取
//     （零新跨模块边；提取物与 contracts 定义结构同一）。
//   - 零新策略、零缓存、零新授权路径：门面不含任何判定逻辑，逐项透传。

import type { createConversationService } from "./service";

// ---------------------------------------------------------------------------
// 输入/结果形状（源头 = M02 contracts，经 M04 组内 service 签名提取）
// ---------------------------------------------------------------------------

/** 内件服务实例类型（M04 组内；其公开能力即本门面的委托目标）。 */
type InternalConversationService = ReturnType<typeof createConversationService>;

/** 受信业务上下文（M02 PlatformScope 形状）。 */
export type ConversationScope = Parameters<
  InternalConversationService["history"]
>[0];

/** getOrCreate 的输入（M02 ConversationInput 形状：可选 title 等）。 */
export type CreateConversationInput = Parameters<
  InternalConversationService["getOrCreate"]
>[1];

/** append 的输入（M02 AppendMessageInput 形状：threadId + clientMessageKey +
 *  content + attachments——幂等键语义全部留在内件）。 */
export type AppendUserMessageInput = Parameters<
  InternalConversationService["append"]
>[1];

/** history 的输入（M02 HistoryInput 形状：threadId + beforeSeq + limit）。 */
export type HistoryQueryInput = Parameters<
  InternalConversationService["history"]
>[1];

/** 会话条目（M02 ConversationDTO 形状）。 */
export type ConversationSummary = Awaited<
  ReturnType<InternalConversationService["getOrCreate"]>
>;

/** 消息（M02 MessageDTO 形状：展示投影；完整 parts 留在存储与内部合同）。 */
export type ConversationMessage = Awaited<
  ReturnType<InternalConversationService["append"]>
>;

/** 历史分页（M02 MessagePage 形状：items + nextBeforeSeq）。 */
export type ConversationHistoryPage = Awaited<
  ReturnType<InternalConversationService["history"]>
>;

/** 引擎消息追加输入（M02 EngineMessageAppendInput 形状：server 签发幂等键 +
 *  完整 parts；无客户端作者字段——内部 engine append 不接受伪造作者）。 */
export type EngineMessageAppend = Parameters<
  InternalConversationService["appendEngineMessage"]
>[1];

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M04 Conversation 公开门面（interface-contracts C05：getOrCreate/append/
 *  history——本票面 = 五能力，含 list 与引擎单写入口 appendEngineMessage）。 */
export interface ConversationPublic {
  /** 本 principal 可见的会话清单：委托内件 list（服务端事实过滤）。 */
  list(scope: ConversationScope): Promise<ConversationSummary[]>;
  /** 会话取得/创建：委托内件 getOrCreate（现有幂等路径）。 */
  getOrCreate(
    scope: ConversationScope,
    input: CreateConversationInput,
  ): Promise<ConversationSummary>;
  /**
   * 已授权完成历史分页：委托内件 history——客户端刷新与模型读取同一读取
   * 本体；未完成 intent 不进入可见历史（C05）。
   */
  history(
    scope: ConversationScope,
    input: HistoryQueryInput,
  ): Promise<ConversationHistoryPage>;
  /** 用户消息提交：委托内件 append（clientMessageKey 幂等合同原样）。 */
  append(
    scope: ConversationScope,
    input: AppendUserMessageInput,
  ): Promise<ConversationMessage>;
  /**
   * 引擎输出落账：委托内件 appendEngineMessage——引擎消息的**唯一**写入口
   * （server 签发幂等键；重试解析同一 intent，不新增重复消息）。
   */
  appendEngineMessage(
    scope: ConversationScope,
    input: EngineMessageAppend,
  ): Promise<ConversationMessage>;
}

/** 门面构造依赖：内件服务的五能力最小面（装配层构造后注入）。 */
export interface ConversationPublicDeps {
  readonly service: Pick<
    InternalConversationService,
    "list" | "getOrCreate" | "history" | "append" | "appendEngineMessage"
  >;
}

/**
 * 构造 M04 门面。零新策略、零缓存、零写入判定：每个能力逐项委托 deps.service
 * 的既有内件实例（幂等/序号/对账/事务与锁序合同全部留在内件，逐字节不动）。
 */
export function createConversationPublic(
  deps: ConversationPublicDeps,
): ConversationPublic {
  const { service } = deps;
  return {
    list(scope: ConversationScope) {
      return service.list(scope);
    },
    getOrCreate(scope: ConversationScope, input: CreateConversationInput) {
      return service.getOrCreate(scope, input);
    },
    history(scope: ConversationScope, input: HistoryQueryInput) {
      return service.history(scope, input);
    },
    append(scope: ConversationScope, input: AppendUserMessageInput) {
      return service.append(scope, input);
    },
    appendEngineMessage(scope: ConversationScope, input: EngineMessageAppend) {
      return service.appendEngineMessage(scope, input);
    },
  };
}
