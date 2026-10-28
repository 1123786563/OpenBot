// server/src/plugins/public.ts
// MOD12（Issue #632，根 #620）：M08 组的连接工具与秘密使用公开出口——ToolAccess 门面。
//
// 模块目录对 M08 的要求：连接表达（可见 / 已连接 / 已授权可执行）、动作准备
// （资格与环境连接资格分开）、受管执行与秘密读取绑定用途+来源，全部经这一个
// 出口对外；供应商 broker、秘密材质与环境传输留在组内 Seam。本文件就是那句话
// 的形状：调用方交出（人, Bot, 服务器/工具）与受管输入，拿到既有判定的折叠；
// broker 客户端、transport、Adapter 与密文信封全部留在组内件里，一件不动。
//
// 薄委托（MOD09/MOD10/MOD11 先例）：零新策略、零缓存、零重试、零过滤。三态的
// 每个布尔是 store 的一个既有读；受管执行是 store.callTool 的恒等委托——
// grant→policy→audit→撤销阻断唯一门不变；秘密读取是 decryptCredentialForUse 的
// 恒等委托。本文件新增的只有两份合同：
//
//   三态分别表达（验收①）：visible / connected / authorizedExecutable 是三个独立
//     的问题、三份独立的判定，不是一个阶梯——grant 而无连接、连接而无 grant 都
//     是可表达且各自成立的答案，测试逐键钉。
//   秘密读取绑定用途+来源（验收②）：读秘密必须声明把它用在什么动作上（purpose）
//     与哪个调用面在读（origin），两者非空；秘密明文只回到调用者手里，不进
//     DTO、不进模型上下文、不进日志与审计行——源级钉。
//
// 出口边界（硬约束）：不 import broker/Adapter/transport/vendor（供应商差异留在
// Adapter，验收④零新增 provider/动作——测试源级钉）；类型经组内签名提取
// （Pick<PluginStore,…> 与 Parameters<…>），不另拟第二套形状。

// MOD13（#633，追加）：门面承载「审批决定与副作用 receipt」能力组——`approvals`
// 槽。注入的组由 `approvals/public.ts` 构造（M08 组内新出口，类型从
// ApprovalService/ApprovalStore 提取），本文件不 import approvals/*：MOD12 冻结
// 钉（tool-access-public.test.ts D5）把本文件的 import 冻结为恰四条组内文件，
// 泛型槽在零新增 import 的前提下让 ToolAccess 消费该组（toolAccess.approvals
// 即注入对象本身），决定/receipt 的四个判定全部留在组内件里，这里没有第二份。

import {
  type CredentialSecretReader,
  decryptCredentialForUse,
} from "../credentials";
import type { PluginStore } from "./store";

/**
 * 门面触达的 store 面：六个既有判定/执行成员，类型直取自 `PluginStore`。
 *
 * 一个 `Pick` 而不是整面 `PluginStore`，因为这同时是消费者与测试的双边合同：
 * 装配根传完整 store（结构满足），测试用对象字面量即可成双（无需成千行桩），
 * 而门面能碰的 store 成员被这份名单写死——多读一个成员是这份名单的 diff。
 */
export type ToolAccessStore = Pick<
  PluginStore,
  | "listServers"
  | "connectionsFor"
  | "brokeredConnectionsFor"
  | "sharedConnections"
  | "listForAgent"
  | "callTool"
>;

/** 受管执行的输入：就是 store 的输入（含 `credentialActorId` 语义），形状直取。 */
export type ToolAccessCall = Parameters<ToolAccessStore["callTool"]>[0];

/** 受管执行的回答：vendor 的结果或拒绝文案，同 store。 */
export type ToolAccessAnswer = Awaited<ReturnType<ToolAccessStore["callTool"]>>;

/**
 * 连接表达三态（验收①）：三个独立回答，互不推导。
 *
 * WHY SEPARATE FIELDS AND NOT A LADDER. A union `"visible" | "connected" | …"
 * answers only the highest rung reached and hides the two below it, and the two
 * below it are the ones an operator can act on: a grant with no connection is a
 * Bot that was given a tool nobody can authenticate, a connection with no grant
 * is a person wired to a server no Bot may call. Both are real states this
 * deployment reaches (the connect route and the grants route are separate pages)
 * and collapsing them is how the first `botsMayCallBack` bug stayed invisible:
 * the switch said "may call" and every call was refused before the boundary.
 */
export interface ConnectionExpression {
  /** 部署里看得见这台服务器——`listServers()` 的既有判定。 */
  visible: boolean;
  /**
   * 这个人有到这台服务器的连接——`connectionsFor` ∪ `brokeredConnectionsFor`
   * （行存在即连接，与 `/connections` 路由同折）∪ `sharedConnections`（读该行
   * 自带的 `connected` 判定）。三张表一次问全，因为「我连了吗」不问连接存在
   * 哪张表——那是「怎么连上的」，不是「连没连」。
   */
  connected: boolean;
  /**
   * 这个 Bot 被授予了这台服务器的工具——`listForAgent(botId)` 的 grant 面。
   * 授权可执行是 grant 事实，不是「这次调用必然成功」：凭证撤销、策略拒绝、
   * 供应商失败仍会在受管执行门上各自回答（`callTool` 唯一门）。
   */
  authorizedExecutable: boolean;
}

/**
 * 动作准备（验收③）：工具使用资格与环境连接资格分开回答。
 *
 * 两个子对象各自来自各自的 store 读，形状上就不可互换：grant 是 Bot 的事实，
 * 连接是人的事实，混在一个布尔里正是「资格够了却打不出去」与「连上了却不许
 * 调」无法分别表达的地方。prepareAction 只读不执行——撤销对后续敏感动作的
 * 阻断发生在受管执行门（`callTool`），不在这里预判。
 */
export interface PreparedAction {
  toolEligibility: {
    granted: boolean;
    /** 被授予时是模型看到的名字（`toolName`），未授予为 null。 */
    toolName: string | null;
  };
  environmentConnection: {
    /** 同 {@link ConnectionExpression.connected} 的判定，按 toolRef 的 server 侧折叠。 */
    connected: boolean;
  };
}

/**
 * ToolAccess 公开门面。见文件头。
 *
 * MOD13（#633）：泛型 `TApprovals` 是审批决定与 receipt 能力组的类型
 * （`approvals/public.ts` 的 ApprovalsAccess）。缺省 `undefined`＝未注入
 * （构造方没给就没有这个能力，门面不造一个假的）；注入后
 * `toolAccess.approvals` 与注入对象是同一引用——委托等价由「恒等持有」
 * 直接成立，无转发层可绕。
 */
export interface ToolAccess<TApprovals = undefined> {
  /** 三态连接表达（验收①）：三个独立判定，见 {@link ConnectionExpression}。 */
  connectionStateOf(input: {
    actorId: string;
    botId: string;
    serverId: string;
  }): Promise<ConnectionExpression>;
  /** 动作准备（验收③）：资格与环境连接资格分开，见 {@link PreparedAction}。 */
  prepareAction(input: {
    toolRef: string;
    botId: string;
    actorId: string;
  }): Promise<PreparedAction>;
  /**
   * 受管执行（验收⑤）：`store.callTool` 的恒等委托——grant、policy、审计行与
   * 撤销阻断全部发生在 store 内，这一层没有第二份实现可绕。
   */
  callTool(input: ToolAccessCall): Promise<ToolAccessAnswer>;
  /**
   * 审批决定与 receipt 能力组（MOD13/#633，验收①③）：`approvals/public.ts`
   * 构造的 ApprovalsAccess——decide（重复批准不产生第二个决定）、receiptOf
   * （重启重读原 receipt）、saveReceipt（单写者持久化，布尔门控不重发）、
   * complete（终态）。恒等持有：本门面对它零包装、零转发，注入什么就是什么。
   */
  readonly approvals?: TApprovals;
}

/**
 * 一次秘密使用的绑定：读什么、用在什么动作上、谁在读。
 *
 * `purpose` 与 `origin` 非空必填——这是验收②的合同本体。空串不是「未声明」的
 * 默认值而是拒绝：一次说不出用途的读取没有资格拿到明文。绑定不被记录、不被
 * 日志、不进审计——它的作用是让每一次读取在调用点上自我声明，让「这行明文
 * 是为什么解开的」成为读代码就能回答的问题。
 */
export interface SecretUseBinding {
  credentialId: string;
  /** 用途：这次明文将支撑的动作，如 `"tool-call"`、`"tenant-provisioning"`。 */
  purpose: string;
  /** 来源：读它的调用面（模块/文件名），泄漏回溯时指向唯一入口。 */
  origin: string;
}

/**
 * 读一个凭据的秘密明文，绑定用途与来源（验收②）。
 *
 * 恒等委托 `decryptCredentialForUse`：凭据缺失或已撤销抛 `CredentialUnusableError`
 * （撤销阻断的既有语义，原样透传——调用方按类名分辨「被撤走」与「坏了」），
 * 其余一切故障也是原样上抛。明文以裸字符串回到调用者，不进任何 DTO、模型
 * 上下文、日志或审计行——本函数是它唯一的出口，出口上没有第二双手。
 */
export async function readSecretForUse(
  deps: { encryptionKey: string; reader: CredentialSecretReader },
  binding: SecretUseBinding,
): Promise<string> {
  if (binding.purpose.trim() === "" || binding.origin.trim() === "") {
    throw new Error(
      "A secret was asked for without saying what it is for, so nothing was read. Bind the read to a purpose and an origin.",
    );
  }
  return decryptCredentialForUse(
    deps.encryptionKey,
    deps.reader,
    binding.credentialId,
  );
}

/**
 * 建 ToolAccess 门面。纯对象创建，零缓存：每次判定都是当次 store 读，grant 或
 * 连接的增减下一次调用即可见（`grantedTools` 同一理由的读时求值）。
 */
export function createToolAccess<TApprovals = undefined>(deps: {
  store: ToolAccessStore;
  approvals?: TApprovals;
}): ToolAccess<TApprovals> {
  const { store, approvals } = deps;

  const connectionFold = async (
    actorId: string,
    serverId: string | null,
  ): Promise<boolean> => {
    if (serverId === null) return false;
    const [held, brokered, shared] = await Promise.all([
      store.connectionsFor(actorId),
      store.brokeredConnectionsFor(actorId),
      store.sharedConnections(),
    ]);
    return (
      held.some((row) => row.serverId === serverId) ||
      brokered.some((row) => row.serverId === serverId) ||
      // 共享连接行自带 connected 判定，读它而不是替它判。
      shared.some((row) => row.serverId === serverId && row.connected)
    );
  };

  return {
    connectionStateOf: async ({ actorId, botId, serverId }) => {
      const [servers, held, brokered, shared, granted] = await Promise.all([
        store.listServers(),
        store.connectionsFor(actorId),
        store.brokeredConnectionsFor(actorId),
        store.sharedConnections(),
        store.listForAgent(botId),
      ]);
      return {
        visible: servers.some((server) => server.id === serverId),
        connected:
          held.some((row) => row.serverId === serverId) ||
          brokered.some((row) => row.serverId === serverId) ||
          shared.some((row) => row.serverId === serverId && row.connected),
        authorizedExecutable: granted.tools.some((tool) =>
          tool.ref.startsWith(`${serverId}/`),
        ),
      };
    },

    prepareAction: async ({ toolRef, botId, actorId }) => {
      // server 侧同 store.callTool 的拆法：第一个 "/" 之前是服务器，之后是工具。
      const slash = toolRef.indexOf("/");
      const serverId = slash > 0 ? toolRef.slice(0, slash) : null;
      const [granted, connected] = await Promise.all([
        store.listForAgent(botId),
        connectionFold(actorId, serverId),
      ]);
      const held = granted.tools.find((tool) => tool.ref === toolRef);
      return {
        toolEligibility: {
          granted: held !== undefined,
          toolName: held?.toolName ?? null,
        },
        environmentConnection: { connected },
      };
    },

    callTool: (input) => store.callTool(input),
    approvals,
  };
}

export type { SelectableSkill, Selection } from "./selection";
export {
  latestUserText,
  SELECTION_FLOOR,
  selectTools,
} from "./selection";
/*
 * 工具供给/选择面（issue「工具发现」合同）：组内既有纯函数的原样转发。门面
 * 不包第二层——转发即委托等价可证。REFUSAL_MARKER / vendorAnswer 是拒绝与供
 * 应商回答的措辞助手而非 ToolAccess 能力，继续从各自文件导入，不在此扩面。
 */
export {
  grantedSkills,
  grantedToolGuidance,
  grantedTools,
} from "./tools";
