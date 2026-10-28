// server/src/enterprise/conversations/integration.ts
// MOD06（Issue #626，根 #620）：M04 的具名兼容装配臂（C05 出口段）。
//
// 只做一件事：把「引擎存储 → 会话服务」的装配从装配层内联直传
// （assembly/runtime.ts 原 `createConversationService({ data, mastraStorage })`）
// 收拢为 M04 组内的**具名臂**。此前 TenantMastraStorage 在装配点被直接塞进服务
// 工厂，引擎存储的接入位置无从点名；此后这一接入有唯一具名入口，且：
//
//   - service.ts 零改动：臂内逐字节调用同一工厂（同参、同缺省语义——
//     mastraStorage 缺席时与现状同为 legacy/平台路径）。
//   - 单写合同不动：会话写入仍全部经 ConversationService（用户消息 append、
//     引擎输出 appendEngineMessage——后者是引擎消息唯一写入口，公共门面
//     public.ts 同面暴露；两条入口共用内件的同一 intent 生命周期）。
//   - 引擎存储类型不外溢：TenantMastraStorage 形状经 service 工厂签名以
//     Parameters<> 提取（MOD05 先例），本文件不 import mastra/*——不新增
//     M04→M05 跨模块边（检查器 654 零 delta 的前提）。引擎存储的直接消费者
//     保持为 mastra/conversations.ts 与 conversations/service.ts 自身
//     （含 mastra-intent-reconciler 的恢复对账），其它模块经本臂/门面触达。
//
// 边界（Issue #626 验收 5）：Mastra 存储只在内部 Adapter 暴露——本臂是装配层
// 接入引擎存储的具名兼容通道；「兼容臂具名且单写」由
// tests/multitenancy/conversation-public.test.ts 源级/结构断言钉死。

import { createConversationService } from "./service";

/** service 工厂入参形状（M04 组内提取：data + 可选引擎存储）。 */
type ServiceAssemblyInput = Parameters<typeof createConversationService>[0];

/**
 * 引擎存储形状（TenantMastraStorage）——从 service 工厂签名提取，不 import
 * mastra/tenant-storage（M04→M05 零新边；MOD05 Parameters<> 先例）。
 */
export type ConversationEngineStorage = NonNullable<
  ServiceAssemblyInput["mastraStorage"]
>;

/** 装配所需的数据通道形状（DataDatabase，M02 contracts 同源形状）。 */
export type ConversationDataChannel = ServiceAssemblyInput["data"];

/** 臂的产物类型：与原内联装配逐字节同一（ConversationService 全量 +
 *  list/appendEngineMessage）。 */
export type ConversationServiceAssembly = ReturnType<
  typeof createConversationService
>;

/** 具名兼容臂入参：与原 runtime.ts 内联直传同形。 */
export interface MastraStorageArmInput {
  readonly data: ConversationDataChannel;
  readonly mastraStorage?: ConversationEngineStorage;
}

/**
 * 具名兼容臂：包装 TenantMastraStorage → ConversationService 装配。逐字节
 * 转发内件工厂（零逻辑、零判定、零缺省改写）；装配层经本臂接入引擎存储，
 * 不再内联直传。
 */
export function createMastraStorageArm(
  input: MastraStorageArmInput,
): ConversationServiceAssembly {
  return createConversationService({
    data: input.data,
    mastraStorage: input.mastraStorage,
  });
}
