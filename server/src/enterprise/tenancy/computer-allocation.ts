// server/src/enterprise/tenancy/computer-allocation.ts
// MT046（Issue #89）：电脑与浏览器实例分配、远程屏幕与人工接管授权。
//
// 票面语义（Issue #89 正文）：
//   AC1 只有归属范围内的授权主体可以查看屏幕或接管；跨范围请求被拒绝。
//   AC2 实例回收后状态被清理，不会带着上一个范围的登录态或工作目录被复用。
//   AC3 服务 token 只授予其登记的能力；用它请求任意公司数据被拒绝。
//   AC4 撤权后正在进行的屏幕会话与接管立即终止。
//
// 结构（纯新增服务面 + 0178 一张 lease 表；归属判定与命名隔离复用 #90/#86
// 已交付的 seam，不另造第二套）：
//
//   1. 屏幕与接管的授权（AC1）：每个入口先过 #90 的归属判定 seam
//      （ExecutionAuthorizationSeam，createExecutionArtifactsService 满足该
//      结构——受信 PlatformScope → data 通道事务内两级成员重验 →
//      enterprise_bot_ownership 权威行三比）。deny = MT011 canonical
//      RESOURCE_NOT_FOUND：跨公司/跨团队/撤权/不存在对外逐字节不可区分，
//      且执行面端口一个都不被调用（不可见 = 零副作用）。allow 才调用注入
//      的 gateway 窄端口（screenshot / takeControl / releaseControl /
//      cancelControl）——动作行由端口侧（gateway 的 writeControlEvent）
//      既有纪律承载，本服务只补 scope 维度的判定审计。
//   2. 分配与回收（AC2）：一个实例对一个 scope 的绑定是进程内注册表
//      （与 gateway 的 fleet/capacity 同位——它们也是进程内事实）。分配 =
//      判定 + 在 #90 的执行状态目录（<root>/tenants/<t>/workspaces/<w>/bots/
//      <bot>，shared/execution-scope.ts 的同一命名）下建立该 scope 的工作
//      目录 + 注册 generation。回收 = 判定 + 停止实例 + 清 profile（登录态
//      的载体）+ 删除该 scope 状态目录（工作目录）+ 注销绑定。跨范围的
//      回收请求在判定处拒绝——他人范围的状态一个字节都不动。回收后的
//      下一次分配从空目录与已清 profile 起步：上一个范围的登录态与工作
//      目录结构性不可复用（目录按归属命名，一个 scope 永远命名不出另一
//      个 scope 的树——#90 的纯函数保证）。
//   3. 能力 lease（AC3，0178 表 + 本文件的服务半边）：服务 token 的授予面
//      是登记出来的：issue 在 data 通道事务内重验成员资格与 #90 实例归属
//      权威行后写一行 (tenant, workspace, principal, bot, purposes,
//      expires_at)。validate 每次现读活行：行状态 active + 未过期 + 绑定
//      三元组与请求上下文逐字比对（RLS 策略钉的就是这三比——谓词是第二
//      道独立防线）+ claimed purpose ∈ 登记集合 + 持有人两级成员资格现读。
//      登记集合是闭集（screen.view / control.take / instance.operate）——
//      「读任意公司数据」不是可登记的能力，结构上无法被授予；用 lease
//      请求闭集外的任何 purpose 响亮拒绝（EXECUTION_LEASE_PURPOSE_
//      UNKNOWN——闭集形状检查是输入校验，不是存在性信号）。validate 不
//      签发 PlatformScope、不返回任何企业数据——只回答「这枚 token 能否
//      做这件登记过的事」。撤销走 operator 通道原子臂（只认 active，
//      幂等），与 MT029 的 revoke 同款。
//   4. 撤权终止（AC4）：屏幕会话与接管在注册表里是活跃事实
//      （scope + 端口）。terminateForMemberRevocation 以撤权事实为输入：
//      对匹配的每个会话调用端口（closeScreen / cancelControl）终结并落
//      审计。新请求在判定段被成员重验拒绝（fail-closed）；本入口负责已经
//      在途的那些立即终止。装配侧在成员撤权流程（MT007 挂起/移除）后调
//      用——本票不接生产装配（与 #87/#90 同例）。
//
// 边界（诚实披露）：
//   - 本票不改 computer/routes.ts、stream-auth.ts、gateway.ts 的既有签名
//     与个人路径：路由装配（把本服务装到 /computer 与 stream upgrade 前）
//     是接线票范围；测试以真实通道 + 记录端口组装。
//   - 注册表是进程内的：与 gateway fleet/capacity 的进程内事实同位；物理
//     清理发生在回收时点，重启后没有可复用的登录态残留。
//   - lease 表的 operator UPDATE 授权只有 (status, revoked_at) 两列（0178
//     列级 GRANT）：绑定事实 create-once，与 job_ownership 同纪律。

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseExecutionCapabilityLeases } from "../../db/schema/enterprise-execution-lease";
import type { PlatformScope } from "../contracts";
import {
  assertDataDatabase,
  assertOperatorDatabase,
  type DataDatabase,
  type OperatorDatabase,
} from "./connections";
import { executionArtifactDir } from "./execution-artifacts";
import {
  notFoundVerdict,
  type ResourceNotFoundVerdict,
} from "./not-found-semantics";
import { workspaceMembershipLockKey } from "./scope-gate";
import { assertTrustedScope } from "./store";

// ---------------------------------------------------------------------------
// #90 归属判定 seam（createExecutionArtifactsService 满足该结构）
// ---------------------------------------------------------------------------

/** #90 判定面的结构投影：deny = canonical not-found。 */
export interface ExecutionAuthorizationSeam {
  authorizeExecution(
    scope: PlatformScope,
    botId: string,
  ): Promise<{ readonly outcome: "allow" } | ResourceNotFoundVerdict>;
}

// ---------------------------------------------------------------------------
// 执行面端口：gateway 的窄结构投影（测试给记录器，装配给真 gateway）
// ---------------------------------------------------------------------------

export interface ComputerAllocationPorts {
  /** 远程屏幕的一帧（gateway.screenshot 的投影）。 */
  screenshot(botId: string): Promise<{ readonly base64: string }>;
  /** 人工接管（gateway.takeControl）：requestId + 会话主体。 */
  takeControl(
    botId: string,
    actor: { id: string },
    requestId: string,
  ): Promise<unknown>;
  /** 释放接管（gateway.releaseControl）。 */
  releaseControl(
    botId: string,
    actor: { id: string },
    requestId: string,
  ): Promise<unknown>;
  /** 取消接管请求（gateway.cancelControl）。 */
  cancelControl(
    botId: string,
    actor: { id: string },
    requestId: string,
  ): Promise<unknown>;
  /** 结束一个屏幕流（stream 代理的关闭面）。 */
  closeScreen(botId: string): Promise<void>;
  /** 停止实例（gateway.stopComputer）：登录态留在 profile。 */
  stop(botId: string): Promise<{ readonly wasRunning: boolean }>;
  /** 清 profile（gateway.resetComputer）：登录态与保存状态一并消失。 */
  resetProfile(botId: string): Promise<{ readonly cleared: boolean }>;
  /** 工作目录操作（#90 命名隔离的物理半边）。 */
  state: {
    ensure(dir: string): Promise<void>;
    remove(dir: string): Promise<void>;
    list(dir: string): Promise<readonly string[]>;
    write(dir: string, name: string, bytes: Uint8Array): Promise<void>;
  };
}

export interface ComputerAllocationAuditEvent {
  readonly action:
    | "computer.screen_view"
    | "computer.screen_session"
    | "computer.control_take"
    | "computer.control_release"
    | "computer.control_cancel"
    | "computer.allocate"
    | "computer.recycle"
    | "computer.terminate_revoked";
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string | null;
  readonly principalId: string;
  readonly outcome: "allowed" | "denied";
  readonly reason?: string;
}

export interface ComputerAllocationAuditSink {
  record(event: ComputerAllocationAuditEvent): Promise<void> | void;
}

export interface ComputerScreenSessionHandle {
  readonly sessionId: string;
  readonly botId: string;
}

// ---------------------------------------------------------------------------
// 注册表（进程内，与 gateway fleet 同位）
// ---------------------------------------------------------------------------

interface ActiveSession {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  readonly principalId: string;
  readonly openedAt: number;
  /** 接管才有：被接管的 control request。 */
  readonly requestId?: string;
}

interface AllocationRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly botId: string;
  /** 每次分配递增：回收后的下一次分配拿到更大的号（测试证据面）。 */
  generation: number;
  stateDir: string | null;
  active: boolean;
}

const allocationKey = (tenantId: string, workspaceId: string, botId: string) =>
  `${tenantId}:${workspaceId}:${botId}`;

/** The map key a session lives under: takeovers key by request, screens by id. */
const sessionKey = (session: {
  sessionId: string;
  requestId?: string;
  tenantId: string;
  workspaceId: string;
  botId: string;
}) =>
  session.requestId !== undefined
    ? `${allocationKey(session.tenantId, session.workspaceId, session.botId)}:${session.requestId}`
    : session.sessionId;

// ---------------------------------------------------------------------------
// 分配/回收/屏幕/接管服务
// ---------------------------------------------------------------------------

export function createComputerAllocationService(deps: {
  /** #90 归属判定 seam（createExecutionArtifactsService 满足该结构）。 */
  readonly authorization: ExecutionAuthorizationSeam;
  /** gateway 窄端口：一切执行面动作经此，本服务不直连计算机。 */
  readonly ports: ComputerAllocationPorts;
  /** 审计 sink：每个治理动作的判定结果落行（不回显值）。 */
  readonly audit: ComputerAllocationAuditSink;
  /** 执行状态目录的根（#90 命名隔离的根；装配方给真实根，测试给临时根）。 */
  readonly stateRoot: string;
}) {
  const { authorization, ports, audit } = deps;
  const sessions = new Map<string, ActiveSession>();
  const allocations = new Map<string, AllocationRecord>();

  /** 判定 + 审计的门：deny = canonical not-found，端口零调用。 */
  async function gate(
    action: ComputerAllocationAuditEvent["action"],
    scope: PlatformScope,
    botId: string,
  ): Promise<{ ok: true } | { ok: false; verdict: ResourceNotFoundVerdict }> {
    assertTrustedScope(scope);
    const verdict = await authorization.authorizeExecution(scope, botId);
    if (verdict.outcome !== "allow") {
      await audit.record({
        action,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "denied",
        reason: "not-found",
      });
      return { ok: false, verdict };
    }
    return { ok: true };
  }

  /** 本 scope 本 Bot 的在途会话（屏幕流与接管共用一个注册表）。 */
  const sessionsFor = (tenantId: string, workspaceId: string, botId: string) =>
    [...sessions.values()].filter(
      (session) =>
        session.tenantId === tenantId &&
        session.workspaceId === workspaceId &&
        session.botId === botId,
    );

  return {
    // -----------------------------------------------------------------------
    // AC1：屏幕与接管
    // -----------------------------------------------------------------------

    /** 查看一帧屏幕：deny = canonical not-found，screenshot 端口不被调用。 */
    async viewScreen(
      scope: PlatformScope,
      botId: string,
    ): Promise<
      | {
          readonly outcome: "allow";
          readonly frame: { readonly base64: string };
        }
      | ResourceNotFoundVerdict
    > {
      const gateResult = await gate("computer.screen_view", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      const frame = await ports.screenshot(botId);
      await audit.record({
        action: "computer.screen_view",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow", frame };
    },

    /**
     * 打开一个持续屏幕会话（stream 代理的授权面）：判定通过后注册，
     * 句柄交代理携带；closeScreenSession 显式关闭或撤权终止时注销。
     */
    async openScreenSession(
      scope: PlatformScope,
      botId: string,
    ): Promise<
      | {
          readonly outcome: "allow";
          readonly session: ComputerScreenSessionHandle;
        }
      | ResourceNotFoundVerdict
    > {
      const gateResult = await gate("computer.screen_session", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        sessionId,
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        openedAt: Date.now(),
      });
      await audit.record({
        action: "computer.screen_session",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow", session: { sessionId, botId } };
    },

    /** 关闭一个屏幕会话（代理断开路径；幂等——未知句柄返回 false）。 */
    async closeScreenSession(sessionId: string): Promise<boolean> {
      const session = sessions.get(sessionId);
      if (!session || session.requestId !== undefined) return false;
      sessions.delete(sessionId);
      await ports.closeScreen(session.botId);
      return true;
    },

    /** 人工接管：deny = canonical not-found，takeControl 端口不被调用。 */
    async takeOverControl(
      scope: PlatformScope,
      botId: string,
      requestId: string,
    ): Promise<{ readonly outcome: "allow" } | ResourceNotFoundVerdict> {
      const gateResult = await gate("computer.control_take", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      await ports.takeControl(botId, { id: scope.actorId }, requestId);
      sessions.set(
        `${allocationKey(scope.tenantId, scope.workspaceId, botId)}:${requestId}`,
        {
          sessionId: randomUUID(),
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          botId,
          principalId: scope.principalId,
          openedAt: Date.now(),
          requestId,
        },
      );
      await audit.record({
        action: "computer.control_take",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow" };
    },

    /** 释放接管：判定 + 端口 + 注销。 */
    async releaseControl(
      scope: PlatformScope,
      botId: string,
      requestId: string,
    ): Promise<{ readonly outcome: "allow" } | ResourceNotFoundVerdict> {
      const gateResult = await gate("computer.control_release", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      await ports.releaseControl(botId, { id: scope.actorId }, requestId);
      sessions.delete(
        `${allocationKey(scope.tenantId, scope.workspaceId, botId)}:${requestId}`,
      );
      await audit.record({
        action: "computer.control_release",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow" };
    },

    /** 取消接管请求：判定 + 端口 + 注销。 */
    async cancelControl(
      scope: PlatformScope,
      botId: string,
      requestId: string,
    ): Promise<{ readonly outcome: "allow" } | ResourceNotFoundVerdict> {
      const gateResult = await gate("computer.control_cancel", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      await ports.cancelControl(botId, { id: scope.actorId }, requestId);
      sessions.delete(
        `${allocationKey(scope.tenantId, scope.workspaceId, botId)}:${requestId}`,
      );
      await audit.record({
        action: "computer.control_cancel",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return { outcome: "allow" };
    },

    // -----------------------------------------------------------------------
    // AC2：分配与回收
    // -----------------------------------------------------------------------

    /**
     * 分配：判定通过后在 #90 命名隔离的执行状态目录下建立本 scope 的工作
     * 目录并注册绑定。回收后的重分配从空目录起步（回收已删目录、清
     * profile），generation 递增留痕。
     */
    async allocateInstance(
      scope: PlatformScope,
      botId: string,
    ): Promise<
      | {
          readonly outcome: "allocated";
          readonly stateDir: string;
          readonly generation: number;
          readonly residualFiles: readonly string[];
        }
      | ResourceNotFoundVerdict
    > {
      const gateResult = await gate("computer.allocate", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      const key = allocationKey(scope.tenantId, scope.workspaceId, botId);
      const existing = allocations.get(key);
      const generation = (existing?.generation ?? 0) + 1;
      const stateDir = executionArtifactDir(deps.stateRoot, scope, botId);
      await ports.state.ensure(stateDir);
      // 回收后的重分配必须看到空目录：上一个范围的工作目录已随回收删除，
      // 这里把「分配时点目录里有什么」如实带回（AC2 的证据面）。
      const residualFiles = await ports.state.list(stateDir);
      allocations.set(key, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        generation,
        stateDir,
        active: true,
      });
      await audit.record({
        action: "computer.allocate",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return {
        outcome: "allocated",
        stateDir,
        generation,
        residualFiles,
      };
    },

    /**
     * 回收：判定 + 停止实例 + 清 profile（登录态）+ 删除本 scope 状态目录
     * （工作目录）+ 终结本 scope 本 Bot 的在途会话与接管。跨范围请求在
     * 判定处拒绝——他人范围的状态一个字节都不动。
     */
    async recycleInstance(
      scope: PlatformScope,
      botId: string,
    ): Promise<
      | {
          readonly outcome: "recycled";
          readonly stopped: boolean;
          readonly profileCleared: boolean;
          readonly stateRemoved: boolean;
          readonly sessionsEnded: number;
        }
      | ResourceNotFoundVerdict
    > {
      const gateResult = await gate("computer.recycle", scope, botId);
      if (!gateResult.ok) return gateResult.verdict;
      const key = allocationKey(scope.tenantId, scope.workspaceId, botId);
      const record = allocations.get(key);
      const stateDir =
        record?.stateDir ?? executionArtifactDir(deps.stateRoot, scope, botId);
      const stopped = await ports.stop(botId);
      const profile = await ports.resetProfile(botId);
      await ports.state.remove(stateDir);
      let sessionsEnded = 0;
      for (const session of sessionsFor(
        scope.tenantId,
        scope.workspaceId,
        botId,
      )) {
        sessions.delete(sessionKey(session));
        if (session.requestId !== undefined) {
          await ports.cancelControl(
            botId,
            { id: session.principalId },
            session.requestId,
          );
        } else {
          await ports.closeScreen(botId);
        }
        sessionsEnded += 1;
      }
      allocations.set(key, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        generation: record?.generation ?? 1,
        stateDir: null,
        active: false,
      });
      await audit.record({
        action: "computer.recycle",
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        botId,
        principalId: scope.principalId,
        outcome: "allowed",
      });
      return {
        outcome: "recycled",
        stopped: stopped.wasRunning,
        profileCleared: profile.cleared,
        stateRemoved: true,
        sessionsEnded,
      };
    },

    /** 分配状态的只读投影（测试与运维面；未分配 = null）。 */
    allocationOf(
      scope: Pick<PlatformScope, "tenantId" | "workspaceId">,
      botId: string,
    ): {
      readonly active: boolean;
      readonly generation: number;
      readonly stateDir: string | null;
    } | null {
      const record = allocations.get(
        allocationKey(scope.tenantId, scope.workspaceId, botId),
      );
      return record
        ? {
            active: record.active,
            generation: record.generation,
            stateDir: record.stateDir,
          }
        : null;
    },

    // -----------------------------------------------------------------------
    // AC4：撤权立即终止
    // -----------------------------------------------------------------------

    /**
     * 撤权终止：对（tenant[, workspace][, principal]）匹配的每个在途屏幕
     * 会话与接管调用端口终结并落审计。实时成员资格是调用方（撤权流程）的
     * 输入事实；本入口不做成员判定——撤权已经发生，这里只负责终结。
     * 返回终结的会话数。
     */
    async terminateForMemberRevocation(input: {
      readonly tenantId: string;
      readonly workspaceId?: string;
      readonly principalId?: string;
      readonly reason?: string;
    }): Promise<{ readonly sessionsEnded: number }> {
      const reason = input.reason?.slice(0, 500) ?? "member revoked";
      let sessionsEnded = 0;
      for (const session of [...sessions.values()]) {
        if (
          session.tenantId !== input.tenantId ||
          (input.workspaceId !== undefined &&
            session.workspaceId !== input.workspaceId) ||
          (input.principalId !== undefined &&
            session.principalId !== input.principalId)
        )
          continue;
        sessions.delete(sessionKey(session));
        if (session.requestId !== undefined) {
          await ports.cancelControl(
            session.botId,
            { id: session.principalId },
            session.requestId,
          );
        } else {
          await ports.closeScreen(session.botId);
        }
        sessionsEnded += 1;
        await audit.record({
          action: "computer.terminate_revoked",
          tenantId: session.tenantId,
          workspaceId: session.workspaceId,
          botId: session.botId,
          principalId: session.principalId,
          outcome: "allowed",
          reason,
        });
      }
      return { sessionsEnded };
    },

    /** 在途会话的只读投影（测试断言面）。 */
    activeSessions(): readonly {
      readonly sessionId: string;
      readonly kind: "screen" | "takeover";
      readonly requestId?: string;
      readonly tenantId: string;
      readonly workspaceId: string;
      readonly botId: string;
      readonly principalId: string;
    }[] {
      return [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        kind: session.requestId !== undefined ? "takeover" : "screen",
        ...(session.requestId !== undefined
          ? { requestId: session.requestId }
          : {}),
        tenantId: session.tenantId,
        workspaceId: session.workspaceId,
        botId: session.botId,
        principalId: session.principalId,
      }));
    },
  };
}

export type ComputerAllocationService = ReturnType<
  typeof createComputerAllocationService
>;

// ---------------------------------------------------------------------------
// AC3：能力 lease 服务（0178 表的读写面）
// ---------------------------------------------------------------------------

const LEASE_READ_TX_SETUP = sql`set transaction isolation level read committed`;
const LEASE_TIMEOUTS = [
  sql`set local lock_timeout = '2s'`,
  sql`set local statement_timeout = '5s'`,
] as const;

/** lease 用途闭集：签发时固定、取用时逐字比对（MT029 同款纪律）。 */
export type ExecutionCapabilityPurpose =
  | "screen.view"
  | "control.take"
  | "instance.operate";

const PURPOSES: readonly ExecutionCapabilityPurpose[] = [
  "screen.view",
  "control.take",
  "instance.operate",
];

const DENY_VERDICT: ResourceNotFoundVerdict = Object.freeze(notFoundVerdict());

const DEFAULT_TTL_SECONDS = 900;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 86_400;
const ID_MAX = 256;

function requireId(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > ID_MAX) {
    throw new Error(code);
  }
  return value;
}

function leaseRowsOf(result: unknown): Record<string, unknown>[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as Record<string, unknown>[];
}

export type ExecutionCapabilityLeaseIssuance =
  | {
      readonly outcome: "allow";
      readonly leaseId: string;
      readonly purposes: readonly ExecutionCapabilityPurpose[];
      readonly tenantId: string;
      readonly workspaceId: string;
      readonly principalId: string;
      readonly botId: string;
      readonly expiresAt: Date;
    }
  | ResourceNotFoundVerdict;

export type ExecutionCapabilityLeaseValidation =
  | {
      readonly outcome: "allow";
      readonly leaseId: string;
      readonly purposes: readonly ExecutionCapabilityPurpose[];
      readonly botId: string;
      readonly expiresAt: Date;
    }
  | ResourceNotFoundVerdict;

/**
 * 签发与取用（data 通道）：每次都读实时行——撤销/过期在下一次校验点
 * 失效；用途逐字比对（闭集外 = 响亮拒绝）。持有人两级成员资格在同一
 * 事务现读（撤权递增 epoch，成员资格行立即失效）。
 */
export function createExecutionCapabilityLeaseService(data: DataDatabase): {
  issue(
    scope: PlatformScope,
    input: {
      readonly botId: string;
      readonly purposes: readonly ExecutionCapabilityPurpose[];
      readonly ttlSeconds?: number;
    },
  ): Promise<ExecutionCapabilityLeaseIssuance>;
  /**
   * 取用校验点：请求上下文（执行面请求头上的归属三元组，机器不可铸造
   * PlatformScope——它只是三段明文）+ lease id + claimed purpose。行的
   * 读取钉在这三比上（RLS 策略与 WHERE 谓词双保险）：拿别家公司的
   * lease 在任何上下文里都读不到行 = canonical deny。
   */
  validate(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly leaseId: string;
    readonly claimedPurpose: string;
  }): Promise<ExecutionCapabilityLeaseValidation>;
} {
  assertDataDatabase(data);

  const membershipFacts = async (
    tx: Parameters<Parameters<DataDatabase["transaction"]>[0]>[0],
    scope: { tenantId: string; workspaceId: string; principalId: string },
  ) => {
    const company = leaseRowsOf(
      await tx.execute(sql`
        select m.status, m.epoch
        from enterprise_memberships m
        where m.tenant_id = ${scope.tenantId} and m.principal_id = ${scope.principalId}
        limit 1
      `),
    );
    const team = leaseRowsOf(
      await tx.execute(sql`
        select w.status
        from enterprise_workspace_memberships w
        where w.tenant_id = ${scope.tenantId} and w.workspace_id = ${scope.workspaceId} and w.principal_id = ${scope.principalId}
        limit 1
      `),
    );
    return {
      companyActive:
        company.length === 1 && String(company[0].status) === "active",
      teamActive: team.length === 1 && String(team[0].status) === "active",
    };
  };

  return {
    async issue(scope, input) {
      assertTrustedScope(scope);
      const botId = requireId(input.botId, "EXECUTION_LEASE_INVALID: botId");
      if (
        !Array.isArray(input.purposes) ||
        input.purposes.length === 0 ||
        input.purposes.some((purpose) => !PURPOSES.includes(purpose))
      ) {
        throw new Error("EXECUTION_LEASE_INVALID: purposes");
      }
      const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
      if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < MIN_TTL_SECONDS ||
        ttlSeconds > MAX_TTL_SECONDS
      ) {
        throw new Error(
          `EXECUTION_LEASE_INVALID: ttlSeconds must be an integer of ${MIN_TTL_SECONDS}..${MAX_TTL_SECONDS}`,
        );
      }
      return data.transaction(async (tx) => {
        await tx.execute(LEASE_READ_TX_SETUP);
        for (const timeout of LEASE_TIMEOUTS) await tx.execute(timeout);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${scope.tenantId}, true), set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.principal_id', ${scope.principalId}, true), set_config('app.user_id', ${scope.actorId}, true)`,
        );
        for (const key of [
          JSON.stringify(["enterprise", "tenant", scope.tenantId]),
          JSON.stringify(["enterprise", "principal", scope.principalId]),
          JSON.stringify([
            "enterprise",
            "membership",
            scope.tenantId,
            scope.principalId,
          ]),
          workspaceMembershipLockKey(
            scope.tenantId,
            scope.workspaceId,
            scope.principalId,
          ),
        ]) {
          await tx.execute(
            sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`,
          );
        }
        const facts = await membershipFacts(tx, scope);
        if (!facts.companyActive || !facts.teamActive) return DENY_VERDICT;
        // 实例归属经 #90 权威行（enterprise_bot_ownership 在本事务 RLS 下
        // 只有本 scope 团队的行可见；跨公司/跨团队 = 行不可见 = deny）。
        const ownership = leaseRowsOf(
          await tx.execute(sql`
            select 1 from enterprise_bot_ownership o
            where o.tenant_id = ${scope.tenantId} and o.agent_id = ${botId}
              and o.workspace_id = ${scope.workspaceId} and o.status = 'active'
            limit 1
          `),
        );
        if (ownership.length !== 1) return DENY_VERDICT;

        const leaseId = randomUUID();
        const inserted = await tx
          .insert(enterpriseExecutionCapabilityLeases)
          .values({
            tenantId: scope.tenantId,
            id: leaseId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            botId,
            purposes: [...input.purposes],
            status: "active",
            expiresAt: sql`now() + make_interval(secs => ${ttlSeconds})`,
          })
          .returning({
            expiresAt: enterpriseExecutionCapabilityLeases.expiresAt,
          });
        const expiresAt = inserted[0]?.expiresAt;
        if (!expiresAt) throw new Error("EXECUTION_LEASE_ISSUE_FAILED");
        return {
          outcome: "allow" as const,
          leaseId,
          purposes: [...input.purposes],
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          botId,
          expiresAt,
        };
      });
    },

    async validate(input) {
      const tenantId = requireId(
        input.tenantId,
        "EXECUTION_LEASE_INVALID: tenantId",
      );
      const workspaceId = requireId(
        input.workspaceId,
        "EXECUTION_LEASE_INVALID: workspaceId",
      );
      const principalId = requireId(
        input.principalId,
        "EXECUTION_LEASE_INVALID: principalId",
      );
      const leaseId = requireId(
        input.leaseId,
        "EXECUTION_LEASE_INVALID: leaseId",
      );
      const claimedPurpose = requireId(
        input.claimedPurpose,
        "EXECUTION_LEASE_INVALID: claimedPurpose",
      );
      // claimed purpose 不在闭集内：这不是可登记的能力——「读任意公司数据」
      // 结构上无法被授予（AC3）。闭集形状错误响亮拒绝，不是存在性信号。
      if (!PURPOSES.includes(claimedPurpose as ExecutionCapabilityPurpose)) {
        throw new Error("EXECUTION_LEASE_PURPOSE_UNKNOWN");
      }
      return data.transaction(async (tx) => {
        await tx.execute(LEASE_READ_TX_SETUP);
        for (const timeout of LEASE_TIMEOUTS) await tx.execute(timeout);
        // 请求上下文先行（机器请求头上的三元组，不可铸造受信 scope）：
        // RLS 策略钉 tenant/workspace/principal 三比，谓词是第二道防线。
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.workspace_id', ${workspaceId}, true), set_config('app.principal_id', ${principalId}, true)`,
        );
        const rows = leaseRowsOf(
          await tx.execute(sql`
            select id, bot_id, purposes, status, expires_at
            from enterprise_execution_capability_leases
            where id = ${leaseId}
              and tenant_id = ${tenantId}
              and workspace_id = ${workspaceId}
              and principal_id = ${principalId}
              and status = 'active'
              and expires_at > now()
            limit 1
          `),
        );
        const row = rows[0];
        if (!row) return DENY_VERDICT;
        const facts = await membershipFacts(tx, {
          tenantId,
          workspaceId,
          principalId,
        });
        const purposes = (row.purposes as string[]) ?? [];
        if (!facts.companyActive || !facts.teamActive) return DENY_VERDICT;
        if (!purposes.includes(claimedPurpose)) return DENY_VERDICT;
        return {
          outcome: "allow" as const,
          leaseId,
          purposes: purposes as ExecutionCapabilityPurpose[],
          botId: String(row.bot_id),
          expiresAt: row.expires_at as Date,
        };
      });
    },
  };
}

/** 撤销（operator 通道）：原子臂只认 active（并发撤销恰一成功），幂等。 */
export function createExecutionCapabilityLeaseAdminService(
  operator: OperatorDatabase,
): {
  revoke(input: {
    readonly tenantId: string;
    readonly leaseId: string;
  }): Promise<{ readonly revoked: boolean }>;
} {
  assertOperatorDatabase(operator);
  return {
    async revoke(input) {
      const tenantId = requireId(
        input.tenantId,
        "EXECUTION_LEASE_INVALID: tenantId",
      );
      const leaseId = requireId(
        input.leaseId,
        "EXECUTION_LEASE_INVALID: leaseId",
      );
      return operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const revoked = await tx
          .update(enterpriseExecutionCapabilityLeases)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(enterpriseExecutionCapabilityLeases.tenantId, tenantId),
              eq(enterpriseExecutionCapabilityLeases.id, leaseId),
              eq(enterpriseExecutionCapabilityLeases.status, "active"),
            ),
          )
          .returning({ id: enterpriseExecutionCapabilityLeases.id });
        return { revoked: revoked.length === 1 };
      });
    },
  };
}
