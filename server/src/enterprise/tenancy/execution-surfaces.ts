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
// 两个面（票面 AC3 点名「含沙箱/浏览器」）：
//   1. computer（浏览器/计算机实例）：gateway.stopComputer /
//      resetComputer(botId, actor)——审计先行是 gateway 既有纪律，适配器
//      只补结果翻译（wasRunning → cancelled/not-running；cleared → cleared）。
//   2. sandbox（代码沙箱）：取消 = abort 该 Bot 的活跃会话（会话解析是接线
//      方的运行时事实，注入 sessions.activeSession(botId)）；重置 =
//      resetWorkspace()。SandboxClient 按 target 的归属构造
//      （executionScope = target 的 tenant/workspace），token 与 bot 头由
//      client 自带——没有归属头的请求在代理侧本来就会被拒（MT050）。
//
// native-runtime（Go cancel）不在本文件：它的 TS 侧签发入口（携带归属的
// VerifiedRun 信封）由 #92（MT049）交付，届时以同一 ExecutionSurface 形状
// 注册进 createExecutionArtifactsService({ surfaces }) 即可，本票不伪造
// 机器身份绕过归属校验（A8）。

import type {
  ExecutionSurface,
  ExecutionTarget,
  ExecutionSurfaceOutcome,
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
            const result = await ports.resetComputer?.(target.botId, ports.actor);
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

const unavailable = (detail: string): { outcome: ExecutionSurfaceOutcome; detail: string } => ({
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
