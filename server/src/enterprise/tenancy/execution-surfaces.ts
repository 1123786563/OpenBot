// server/src/enterprise/tenancy/execution-surfaces.ts
// MT043（Issue #86）：执行面适配器——把 #90 的 ExecutionTarget 翻译成既有
// 取消/重置入口，供 cancelExecution/resetExecutionWorkspace 逐面传播。
//
// #86 的接线半边：归属判定与传播编排在 #90（execution-artifacts.ts），
// 本文件只做翻译，不做授权——每个适配器拿到的 target 已带完整归属三元组
// （tenant/workspace/bot ± run），把它原样交给既有入口并带上
// shared/execution-scope.ts 的两个归属头（x-openbot-tenant-id /
// x-openbot-workspace-id，经 SandboxClientOptions.executionScope 透传）。
//
// 三个面：
//   1. computer（浏览器/计算机实例）：gateway.stopComputer /
//      resetComputer(botId, actor)——审计先行是 gateway 既有纪律，适配器
//      只补结果翻译（wasRunning → cancelled/not-running；cleared → cleared）。
//   2. sandbox（代码沙箱）：取消 = abort 该 Bot 的活跃会话（会话解析是接线
//      方的运行时事实，注入 sessions.activeSession(botId)）；重置 =
//      resetWorkspace()。SandboxClient 按 target 的归属构造
//      （executionScope = target 的 tenant/workspace），token 与 bot 头由
//      client 自带——没有归属头的请求在代理侧本来就会被拒（MT050）。
//   3. native-runtime（Go cancel，#92/MT049 交付）：dial Go 侧 cancel 边界，
//      三个头（service credential / capability / VerifiedRun 信封）全部由
//      接线方从运行协议的真实受信事实铸出（信封唯一签发入口在
//      agent-adapters.ts 的 issueRuntimeInvocation）；本面在 dial 前复核
//      信封归属与 target 三元组逐字一致，不一致拒绝拨号（MT049 AC1）。
//
// MT049 纪律：三面的错误与日志文案经 describeAdapterAttribution /
// describeExecutionScope 只带归属标识，永不带 token、capability 或信封
// 原文（AC4）；三面共消费同一 ExecutionTarget 三元组与
// shared/execution-scope.ts 头契约，没有第二套归属通道（A8）。

import { consumeRuntimeInvocationHeader } from "./agent-adapters";
import type {
  ExecutionSurface,
  ExecutionSurfaceOutcome,
  ExecutionTarget,
} from "./execution-artifacts";

/** computer 面（浏览器/计算机实例）的既有入口：gateway 的窄结构投影。 */
export interface ComputerSurfacePorts {
  /** 停止该 Bot 的计算机实例（server/src/computer/gateway.ts stopComputer）。 */
  stopComputer(
    botId: string,
    actor: { id: string; userId?: string },
  ): Promise<{ wasRunning: boolean }>;
  /** 清空该 Bot 的计算机实例状态（gateway resetComputer；无则不注册 reset）。 */
  resetComputer?(
    botId: string,
    actor: { id: string; userId?: string },
  ): Promise<{ cleared: boolean }>;
  /**
   * 动作主体：治理取消/重置的执行主体（ActionActor 结构）。装配方给会话
   * 用户（scope.actorId 是 users 表真行）；审计行由 gateway 落，记录的是
   * 「谁在问」，不是「谁被授权」——授权在 #90 的判定里已经完成。
   */
  readonly actor: { id: string; userId?: string };
}

/** computer 面适配器：target.botId + 注入的 actor → 既有 gateway 入口。 */
export function computerExecutionSurface(
  ports: ComputerSurfacePorts,
): ExecutionSurface {
  return {
    surface: "computer",
    async cancel(target: ExecutionTarget) {
      const result = await ports.stopComputer(target.botId, ports.actor);
      return {
        outcome: (result.wasRunning ? "cancelled" : "not-running") as
          | "cancelled"
          | "not-running",
      };
    },
    ...(ports.resetComputer
      ? {
          async reset(target: ExecutionTarget) {
            const result = await ports.resetComputer?.(
              target.botId,
              ports.actor,
            );
            return {
              outcome: (result?.cleared ? "cleared" : "absent") as
                | "cleared"
                | "absent",
            };
          },
        }
      : {}),
  };
}

/** sandbox 面的既有入口：SandboxClient 的窄结构投影。 */
export interface SandboxSurfacePorts {
  /** 按 target 归属构造该 Bot 的沙箱客户端（server/src/codesandbox/client.ts）。 */
  createClient(input: {
    readonly botId: string;
    readonly executionScope: {
      readonly tenantId: string;
      readonly workspaceId: string;
    };
  }): {
    abortSession(sessionId: string): Promise<void>;
    resetWorkspace(): Promise<void>;
  };
  /** 该 Bot 当前活跃的沙箱会话（接线方的运行时事实）；null = 无在途会话。 */
  readonly sessions: {
    activeSession(botId: string): Promise<string | null>;
  };
}

const unavailable = (
  detail: string,
): { outcome: ExecutionSurfaceOutcome; detail: string } => ({
  outcome: "unavailable",
  detail,
});

/** sandbox 面适配器：归属构造客户端 → abort 活跃会话 / reset 工作区。 */
export function sandboxExecutionSurface(
  ports: SandboxSurfacePorts,
): ExecutionSurface {
  return {
    surface: "sandbox",
    async cancel(target: ExecutionTarget) {
      const sessionId = await ports.sessions.activeSession(target.botId);
      if (sessionId === null) {
        return { outcome: "not-running" as const };
      }
      try {
        const client = ports.createClient({
          botId: target.botId,
          // 归属头从这里进：代理侧（MT050）拒绝没有归属的部署 token 请求。
          executionScope: {
            tenantId: target.tenantId,
            workspaceId: target.workspaceId,
          },
        });
        await client.abortSession(sessionId);
        return { outcome: "cancelled" as const };
      } catch (error) {
        // 错误类别不是消息文本：#90 的传播编排把 unavailable 落进审计行，
        // 不回显值。
        return unavailable(error instanceof Error ? error.name : "Error");
      }
    },
    async reset(target: ExecutionTarget) {
      try {
        const client = ports.createClient({
          botId: target.botId,
          executionScope: {
            tenantId: target.tenantId,
            workspaceId: target.workspaceId,
          },
        });
        await client.resetWorkspace();
        return { outcome: "cleared" as const };
      } catch (error) {
        return unavailable(error instanceof Error ? error.name : "Error");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// native-runtime 面（#92/MT049）：Go cancel 边界的翻译适配器
// ---------------------------------------------------------------------------

/**
 * native-runtime（Go runtime）cancel 边界的头契约——与 Go 侧 auth.go 的
 * 常量逐字对应（runtime-go/internal/server/auth.go）。
 */
export const NATIVE_RUNTIME_CANCEL_HEADERS = {
  serviceCredential: "x-openbot-runtime-service-credential",
  capability: "x-openbot-runtime-capability",
  invocation: "x-openbot-runtime-invocation",
} as const;

/** native-runtime 面的既有入口：Go 边界的窄结构投影。 */
export interface NativeRuntimeSurfacePorts {
  /** Go runtime 监听地址（operator 配置；绝不来自请求数据）。 */
  readonly baseUrl: string;
  /** 平台↔runtime 共享秘密：只作头使用，永不进错误文案（MT049 AC4）。 */
  readonly serviceCredential: string;
  /**
   * 每次 cancel 的凭据：VerifiedRun 信封（唯一签发入口
   * issueRuntimeInvocation 的产物）与短期 capability，由接线方从运行协议
   * 的同一组受信事实铸出。本面在 dial 前复核信封归属与 target 一致。
   */
  readonly credentials: (target: ExecutionTarget) => Promise<{
    readonly invocationHeader: string;
    readonly capability: string;
  }>;
  /** 上游 fetch；缺省用运行时的 fetch。 */
  readonly fetch?: typeof fetch;
}

/**
 * native-runtime 面适配器：归属一致的 VerifiedRun 信封 → POST Go cancel。
 *
 * Go 侧的边界语义（cancel.go）：verified 身份 + 全元组执行登记 + fencing
 * 一致才动手；404 = 本进程未持有该执行（重启后/已结束），403 = 身份或
 * fencing 不一致。翻译沿用 #90 的五值结果：200 → cancelled、404 →
 * not-running、其余 → unavailable（只带错误类别与归属标识，不带秘密）。
 */
export function nativeRuntimeExecutionSurface(
  ports: NativeRuntimeSurfacePorts,
): ExecutionSurface {
  const dial = ports.fetch ?? fetch;
  return {
    surface: "native-runtime",
    async cancel(target: ExecutionTarget) {
      const { invocationHeader, capability } = await ports.credentials(target);
      // dial 前复核：信封必须携带且仅携带 target 的归属三元组——一个说
      // 着别的公司的信封是接线错误，拒绝拨号而不是让它去 Go 侧撞 403
      // （MT049 AC1：篡改的归属在消费侧拒绝）。
      const invocation = consumeRuntimeInvocationHeader(invocationHeader);
      if (
        !invocation ||
        invocation.tenant_id !== target.tenantId ||
        invocation.workspace_id !== target.workspaceId ||
        // target 带 runId 时逐字比对（MT049 AC1：信封归属与 target 一致，
        // 拿别的 run 的信封取消本 run 同样是接线错误）。
        (target.runId !== undefined && invocation.run_id !== target.runId)
      ) {
        return unavailable(
          `native-runtime invocation ownership mismatch for tenant ${target.tenantId} workspace ${target.workspaceId} bot ${target.botId}`,
        );
      }
      let response: Response;
      try {
        response = await dial(`${ports.baseUrl.replace(/\/+$/, "")}/cancel`, {
          method: "POST",
          headers: {
            [NATIVE_RUNTIME_CANCEL_HEADERS.serviceCredential]:
              ports.serviceCredential,
            [NATIVE_RUNTIME_CANCEL_HEADERS.capability]: capability,
            [NATIVE_RUNTIME_CANCEL_HEADERS.invocation]: invocationHeader,
          },
        });
      } catch (error) {
        // 拨号失败：错误类别进 unavailable，不回显任何凭据或响应体。
        return unavailable(error instanceof Error ? error.name : "Error");
      }
      if (response.status === 200) return { outcome: "cancelled" as const };
      if (response.status === 404) return { outcome: "not-running" as const };
      // 403（身份/fencing 不一致）与其余失败同为 unavailable：类别已够
      // 审计定位，细节在 Go 侧的边界上已经说过且不含秘密。
      return unavailable(`native-runtime refused (${response.status})`);
    },
  };
}
