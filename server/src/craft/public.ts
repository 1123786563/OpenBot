// server/src/craft/public.ts
// MOD11（Issue #631，根 #620）：CRAFT 组的沙箱能力公开出口——file / serve / event /
// snapshot 四族句柄，按一个可信（执行范围, 环境代次）对绑定。
//
// 模块目录对 M09 的要求（docs/plans/modular-architecture/module-catalog.md §10）：
// 「对外句柄按可信范围、Bot、目的、所需能力绑定，内部处理地址/token/headers。缓存
// 至少包含合同要求的范围与环境代次，不能以 botId 作为唯一业务缓存键。」本门面就是
// 那句话的形状：调用方交出可信范围与代次，拿到四族句柄；地址、token 与归属头的
// 组装全部留在组内件（sandbox-gateway.ts / opencode/*）里，一件不动。
//
// 落点裁决（Brief §1.A「以四能力句柄的实际宿主为准」）：四族能力的宿主是
// craft/sandbox-gateway.ts（fileApiFor / serveClientFor / eventBusFor /
// snapshotArchiveFor + restoreWorkspace），所以出口在 CRAFT 组的 public.ts。
// 候选 codesandbox/public.ts（M09）被排除：它得反向 import craft 内件，而模块图
// 上 M09 只依赖 M02、CRAFT 使用 M09——方向不可倒。
//
// 薄委托（MOD09/MOD10 先例）：本文件零判定、零重试、零过滤。全部能力是既有
// createSandboxGateway 实例的成员原样转交；本文件新增的只有**绑定合同**——
//
//   同一可信归属（验收①）：一个绑定对应恰好一个 gateway 实例，四族能力同源
//     （同一连接 lambda、同一范围、同一代次），handlesFor 两次同键返回同一实例。
//   范围+代次进缓存寻址键（验收②）：键是 (tenantId/workspaceId, generation)，
//     不是 botId。不同范围或不同代次的绑定各得一个 gateway，各自的
//     opencode-serve client / event bus 缓存（= 登录态与会话状态的宿主）互不可见；
//     同一 gateway 内部按 botId::directory 寻址，于是一个实例的缓存里永远不会
//     出现第二个范围。
//   缺范围不发请求（验收③）：null 范围绑定照常拿到句柄，但每个动词按 #618 的
//     现状机制 fail closed——显示性拒绝、零拨号。绑定不默认任何公司/团队（验收④）。
//
// 代次（environmentGeneration）：缓存寻址事实，不是轮换策略。今天的部署一代
// 到底（boot 配置），所以缺省 "1"；部署将来轮换环境时换值即可，旧代次的缓存
// 自然不再被寻址。本门面不发明失效信号。

import type { ExecutionScope } from "../../../shared/execution-scope";
import {
  createSandboxGateway,
  type SandboxGateway,
  type SandboxGatewayOptions,
} from "./sandbox-gateway";

/** 装配面：组内 gateway 选项里与绑定无关的三件（范围不在此列——它随绑定走）。 */
export type CraftSandboxPublicOptions = Pick<
  SandboxGatewayOptions,
  "config" | "connectionFor" | "fetchImpl"
>;

/**
 * 一次可信环境绑定：范围 + 环境代次。
 *
 * scope 是调用方从部署接线解析出的当前值（boot 文件的同一组事实）；null 保留
 * null——缺范围是“每个动词都拒绝”的绑定，不是被默认值填掉的洞。代次缺省 "1"
 * （不轮换的部署只有一代）。
 */
export interface CraftSandboxEnvironmentBinding {
  readonly scope: ExecutionScope | null;
  readonly environmentGeneration?: string;
}

/**
 * 绑定后的能力句柄：file（fileApiFor / workspaceApiFor）、serve（serveClientFor）、
 * event（eventBusFor）、snapshot（snapshotArchiveFor / restoreWorkspace）四族，连同
 * 它们随行的运行件（healthCheck / assertExecutionScope / close）。类型经组内签名
 * 提取——就是 gateway 的类型，本文件不另拟第二套形状，也没有任何 token/头组装面。
 */
export type CraftSandboxHandles = SandboxGateway;

/** CRAFT 沙箱能力公开门面。 */
export interface CraftSandboxPublic {
  /**
   * One handle family bound to the trusted pair: the SAME gateway instance for
   * the same (scope, generation), a separate one for every other — so the four
   * capabilities of one binding can never disagree about ownership, and two
   * bindings can never share a client cache or a bus (login state included).
   */
  handlesFor(binding: CraftSandboxEnvironmentBinding): CraftSandboxHandles;
  /** Close every bound gateway's cached buses (shutdown hook, one per binding). */
  close(): void;
}

/** 缺省代次：不轮换的部署只有一代。 */
const DEFAULT_ENVIRONMENT_GENERATION = "1";

/**
 * The public export: bind craft's four sandbox capability families to a trusted
 * (scope, generation) pair. Thin — every capability delegates to an unchanged
 * `createSandboxGateway` instance; the binding registry is the only thing here.
 */
export function createCraftSandboxPublic(
  options: CraftSandboxPublicOptions,
): CraftSandboxPublic {
  const bound = new Map<string, SandboxGateway>();
  const keyOf = (binding: CraftSandboxEnvironmentBinding): string => {
    const scope = binding.scope
      ? `${binding.scope.tenantId}/${binding.scope.workspaceId}`
      : "unscoped";
    return `${scope}::${binding.environmentGeneration ?? DEFAULT_ENVIRONMENT_GENERATION}`;
  };

  return {
    handlesFor(binding) {
      const key = keyOf(binding);
      const cached = bound.get(key);
      if (cached) return cached;
      // The binding is the scope's one source: the gateway's per-verb resolver
      // answers this pair forever, so file verbs, health probes, serve clients
      // and buses constructed under this binding can never state another
      // ownership. The deployment's pair is boot-time config (#618), so
      // freezing it per binding is the same value the live lambda would have
      // resolved on every call.
      const gateway = createSandboxGateway({
        config: options.config,
        connectionFor: options.connectionFor,
        executionScopeFor: () => binding.scope,
        fetchImpl: options.fetchImpl,
      });
      bound.set(key, gateway);
      return gateway;
    },

    close() {
      for (const gateway of bound.values()) gateway.close();
      bound.clear();
    },
  };
}
