// server/src/agents/public.ts
// MOD05（Issue #625，根 #620）：M03 BotCatalog 的业务门面。
//
// 五个能力，全部是**薄委托**——内件（agents/profile-store.ts、
// team-bots/team-bots.ts、enterprise/experts/version-catalog.ts）零改动，
// 判定/事务/发布权限合同逐字节不动：
//
//   createBot(actor, input)          → AgentProfileStore.create（profile-store.ts）：
//                                       现有创建路径原样——身份/档案字段与运行
//                                       配置（endpoint/auth/systemPrompt）的现有
//                                       分离不动；创建不自动授予模型或工具资格。
//   softDeleteBot(actor, botId)      → AgentProfileStore.softDelete（同上内件）：
//                                       MOD16（#636）marketplace 卸载改道所驱的
//                                       恒等委托——撤回语义（purged Bot 不留
//                                       可解密档案）留在内件逐字节不动。
//   getVersion(scope, ref)           → ExpertVersionCatalog.resolve
//                                       （experts/version-catalog.ts）：租户固定
//                                       专家版本的现有只读解析（受信 Scope + ref
//                                       校验 + 行完整性 verify，逐字节不动）。
//   publish(actor, botId, input)     → TeamBots.publish（team-bots/team-bots.ts）：
//                                       管理员开关（enterpriseControls capabilityFor
//                                       fail-closed）、发布前置校验（命名/描述/
//                                       audience 语义）、发布事务全部留在内件。
//   withdraw(actor, botId)           → TeamBots.unpublish（成员名以代码事实为准）：
//                                       只删 teamBotPublications 一行的现有撤回；
//                                       档案与专家版本不受影响。
//
// 边界（Issue #625 + 模块目录 M03 + Interface 合同 BotCatalog 行）：
//   - 只 import M03 组内文件（agents/、team-bots/、enterprise/experts/）；
//     PlatformScope 不从 enterprise/contracts（M02）import——改经内件 resolve
//     签名以 Parameters<> 提取，避免新增 M03→M02 跨模块边（检查器零 delta）。
//   - 不 re-export 三内件整对象/类型面：消费面 = 上述四能力 + 其输入/结果形状；
//     构造依赖用 Pick<内件, 能力> 最小面（bot-catalog-public.test.ts D5 结构
//     断言钉死）。
//   - 零新策略、零缓存、零新授权路径：门面不含任何判定逻辑；expertVersions
//     未装配时 getVersion 响亮拒绝（缺省即缺席，绝不宽松回退——与装配层
//     「Null, never a permissive stand-in」同一纪律），其余能力不受影响。
//   - 发布权限合同（管理员开关、发布前置校验、audience 语义）与
//     TeamBots credentialActorFor/listenForConsent 语义均不在门面：前者留在
//     内件 publish/unpublish，后者不经本门面（TeamBots 类型仍经 coworker 传递）。

import type {
  ExpertDefinitionV1,
  ExpertVersionCatalog,
  ExpertVersionRef,
} from "../enterprise/experts/version-catalog";
import type { TeamBots } from "../team-bots/team-bots";
import type { AgentProfileStore } from "./profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

// ---------------------------------------------------------------------------
// 输入/结果形状
// ---------------------------------------------------------------------------

/**
 * createBot 的输入：与 AgentProfileStore.create 的现有入参逐字节同一形状
 * （CreateAgentInput + 仅创建路径存在的 systemPrompt 可选项——`POST /api/agents`
 * 从不发送它，这一现状不动）。
 */
export type CreateBotInput = CreateAgentInput & {
  readonly systemPrompt?: string;
};

/**
 * publish 的输入：与 TeamBots.publish 的现有入参同一形状——audience 语义
 * （"team" | "people"）与 emails/groups 的处理全部留在内件。
 */
export interface PublishBotInput {
  readonly audience: "team" | "people";
  readonly emails: string[];
  readonly groups: string[];
}

/**
 * getVersion 的受信业务上下文：从内件 resolve 签名原样提取（即 M02 的
 * PlatformScope 形状）——不新增跨模块 import 边，也不复刻其定义。
 */
export type BotCatalogScope = Parameters<ExpertVersionCatalog["resolve"]>[0];

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

/** M03 BotCatalog 公开门面（interface-contracts：createBot/getVersion/publish/withdraw）。 */
export interface BotCatalog {
  /** 创建逻辑 Bot：委托 AgentProfileStore.create（现有创建路径，零新策略）。 */
  createBot(actor: AgentActor, input: CreateBotInput): Promise<AgentProfile>;
  /** 删除 Bot：委托 AgentProfileStore.softDelete（MOD16 marketplace 卸载改道）。 */
  softDeleteBot(actor: AgentActor, botId: string): Promise<void>;
  /**
   * 读取固定专家版本：委托 ExpertVersionCatalog.resolve（租户固定快照的
   * 现有只读解析）。装配未提供内件时响亮拒绝——缺席不是空结果。
   */
  getVersion(
    scope: BotCatalogScope,
    ref: ExpertVersionRef,
  ): Promise<ExpertDefinitionV1 | null>;
  /** 发布到团队：委托 TeamBots.publish（管理员开关与前置校验留在内件）。 */
  publish(
    actor: AgentActor,
    botId: string,
    input: PublishBotInput,
  ): Promise<void>;
  /** 撤回发布：委托 TeamBots.unpublish（只删 publication 一行）。 */
  withdraw(actor: AgentActor, botId: string): Promise<void>;
}

/** 门面构造依赖：全部为 M03 既有内件的最小能力面（装配层构造后注入）。 */
export interface BotCatalogDeps {
  /** 档案存储：createAgentProfileStore(...) 的产物，取其 create/softDelete 能力。 */
  readonly profileStore: Pick<AgentProfileStore, "create" | "softDelete">;
  /** 团队发布：createTeamBots(...) 的产物，取其 publish/unpublish 能力。 */
  readonly teamBots: Pick<TeamBots, "publish" | "unpublish">;
  /**
   * 专家固定版本目录：ExpertVersionCatalog 的 resolve 能力。可选——企业
   * Data 能力未接线的部署没有该内件；此时 getVersion 响亮拒绝（缺省即
   * 缺席，绝不宽松回退），其余三能力照常。
   */
  readonly expertVersions?: Pick<ExpertVersionCatalog, "resolve">;
}

/**
 * 构造 M03 门面。零新策略、零缓存、零写入判定：每个能力逐项委托 deps 中
 * 的既有内件实例（创建校验、发布权限合同、版本完整性全部留在内件）。
 */
export function createBotCatalog(deps: BotCatalogDeps): BotCatalog {
  const { profileStore, teamBots } = deps;
  return {
    createBot(actor, input) {
      return profileStore.create(actor, input);
    },
    softDeleteBot(actor, botId) {
      return profileStore.softDelete(actor, botId);
    },
    async getVersion(scope, ref) {
      const catalog = deps.expertVersions;
      if (!catalog) throw new Error("BOT_CATALOG_EXPERT_VERSIONS_UNAVAILABLE");
      return catalog.resolve(scope, ref);
    },
    publish(actor, botId, input) {
      return teamBots.publish(actor, botId, input);
    },
    withdraw(actor, botId) {
      return teamBots.unpublish(actor, botId);
    },
  };
}
