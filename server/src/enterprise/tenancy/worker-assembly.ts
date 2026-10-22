// server/src/enterprise/tenancy/worker-assembly.ts
// MT130（Issue #173）：Worker 与后台装配去默认公司。
//
// 票面语义：Worker 与后台程序装配不含启动期默认公司；每项执行按持久记录
// 重建业务作用域，机器身份不获得普通用户权限。
//
// 结构（消费已交付裁决，只加装配层，不改任何门）：
//
//   1. Worker 启动就绪（AC1 前半）：evaluateWorkerAssemblyReadiness 消费
//      MT123 的 resolveStartupDefaults 输出——多租户模式下装配默认状态里
//      存在任何默认公司/团队载体（defaultCompanyTenantId 非 null、
//      devBypassMounted、单租户形线程种子）即拒绝；Worker 执行身份必须是
//      签发过的机器身份（createMachineScanIdentity——dev-local-user 与一切
//      用户形 id 在签发入口被拒）。这是纵深防御：净化域正常时恒过，净化域
//      回退时 Worker 面第一个响亮失败，而不是默默带着默认公司跑任务。
//   2. 执行通道（AC2）：createWorkerExecutionLane 只包一个
//      createScanExecutor（MT042）——「复用扫描侧规则」是结构性的：到期
//      发现不读载荷、逐项从 job_ownership 权威行重建受信 Scope（消息字段
//      只是路由提示）、MT041 租约纪律、执行在 MT005 gate 事务内（两级成员
//      重验）。Lane 不自建第二条重建路径。
//   3. 缺失归属 → 隔离（AC1 后半）：扫描侧对记录缺失/条目畸形的结局是
//      released-for-retry；Lane 把这两类改判 **isolated**——永不以默认身份
//      执行（执行回调零调用），并把隔离事实交给 onIsolated 缝（审计/清单
//      接线是调用方的事；默认缝 = 结构化日志一行，绝不静默吞掉）。
//   4. 机器身份（AC3）：机器身份与用户 Scope 类型隔离（MT042 签发 WeakSet
//      + MT005 assertTrustedScope 双向拒绝）。Lane 入口只认签发过的
//      MachineScanIdentity；手造同形对象、JSON 往返、用户 Scope 一律
//      MACHINE_IDENTITY_INVALID。机器身份进不了 Scope 注册表，也就读不了
//      任何公司业务数据——业务读取只存在于 gate 事务内、按重建出的受信
//      Scope 走。
//   5. 后台程序配置解析（AC4）：resolveBackgroundRuntimeConfig——每条后台
//      记录按自己的归属（tenantId/workspaceId）经 MT122 内部半边
//      （fromInternalIdentity，entrypoint="schedule"）建立上下文后解析
//      MT014 运行配置；记录缺归属即拒绝（无全局回退——不存在「进程当前
//      公司」可读）。解析输入闭集 = {工厂, 记录}，结构上无全局可变状态。
//
// 边界（票面 Scope boundary）：不含启动就绪判定实现（MT129 交付）；
// T 系列 Worker（Opik 导出/保留、计费清扫）的逐个接线是各自归属票，本
// 模块是它们去默认公司的装配缝。

import { getLogger } from "../../../../shared/logger";
import {
  assertTrustedMachineIdentity,
  createMachineScanIdentity,
  type MachineScanIdentity,
  SCAN_ITEM_MALFORMED,
  SCAN_RECORD_MISSING,
  type ScanExecutor,
  type ScannedItem,
  type ScanOptions,
} from "../runs/scan-executor";
import type {
  DeploymentEntryContextFactory,
  DeploymentInternalEntryIdentity,
} from "./entry-context";
import type { ResolvedRuntimeConfig } from "./runtime-config";
import type { StartupDefaults } from "./startup-defaults";

// ---------------------------------------------------------------------------
// AC1 前半：Worker 启动就绪（无默认公司/团队；机器执行身份）
// ---------------------------------------------------------------------------

/** Worker 装配事实（index.ts/测试提供；defaults 来自 resolveStartupDefaults）。 */
export interface WorkerAssemblyFacts {
  readonly multitenancy: boolean;
  /** MT123 净化域的解析输出（两种模式都深冻结）。 */
  readonly defaults: StartupDefaults;
  /** Worker 执行身份的机器 id（必须经 createMachineScanIdentity 签发）。 */
  readonly machineIdentity: MachineScanIdentity;
}

/** 一条就绪缺口：缺口源与可审计说明（MT123 findings 同款）。 */
export interface WorkerAssemblyFinding {
  readonly source: string;
  readonly detail: string;
}

export type WorkerAssemblyReadiness =
  | { readonly ok: true; readonly findings: readonly [] }
  | { readonly ok: false; readonly findings: readonly WorkerAssemblyFinding[] };

/** Worker 装配允许保留的默认状态（对 StartupDefaults 的再断言，深冻结消费）。 */
export interface WorkerAssemblyDefaults {
  readonly mode: StartupDefaults["mode"];
  /** 多租户 Worker 装配恒为 null——不存在隐式当前公司。 */
  readonly defaultCompanyTenantId: string | null;
  /** 多租户下仅显式 DEPLOYMENT_ID（部署命名，非公司身份）。 */
  readonly threadIdentitySeed: string | null;
  /** 多租户恒 false。 */
  readonly devBypassMounted: boolean;
}

/**
 * Worker 启动就绪判定（纯函数）：多租户模式下，装配默认状态不允许携带
 * 任何默认公司/团队载体；执行身份必须是签发过的机器身份（签发入口自己
 * 拒绝用户形 id，这里的 assertTrustedMachineIdentity 钉「签发过」半边）。
 * 单租户模式无就绪诉求（MT123 同款：legacy 启动原样）。
 */
export function evaluateWorkerAssemblyReadiness(
  facts: WorkerAssemblyFacts,
): WorkerAssemblyReadiness {
  if (!facts.multitenancy) return { ok: true, findings: [] };
  const findings: WorkerAssemblyFinding[] = [];
  if (facts.defaults.defaultCompanyTenantId !== null) {
    findings.push({
      source: "defaults.defaultCompanyTenantId",
      detail: `the worker assembly resolved a default company ("${facts.defaults.defaultCompanyTenantId}") — workers in multitenancy mode boot with no default company; business scope is rebuilt per task from its persisted record`,
    });
  }
  if (facts.defaults.devBypassMounted) {
    findings.push({
      source: "defaults.devBypassMounted",
      detail:
        "the worker assembly resolved a mounted single-user/dev bypass — machine identities must never run as the development administrator",
    });
  }
  try {
    assertTrustedMachineIdentity(facts.machineIdentity);
  } catch (error) {
    findings.push({
      source: "machineIdentity",
      detail: `the worker execution identity is not an issued machine identity (${error instanceof Error ? error.message : String(error)}) — only createMachineScanIdentity issues one, and it refuses every user-shaped id`,
    });
  }
  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, findings: [] };
}

/** Worker 装配保留下来的默认状态（消费 MT123 解析输出，零第二事实源）。 */
export function workerAssemblyDefaults(
  defaults: StartupDefaults,
): WorkerAssemblyDefaults {
  return {
    mode: defaults.mode,
    defaultCompanyTenantId: defaults.defaultCompanyTenantId,
    threadIdentitySeed: defaults.threadIdentitySeed,
    devBypassMounted: defaults.devBypassMounted,
  };
}

// ---------------------------------------------------------------------------
// AC1 后半 + AC2：执行通道（复用扫描侧规则；缺失归属 → 隔离）
// ---------------------------------------------------------------------------

/** 缺失归属改判隔离的两类扫描结局码（闭集；其余结局原样透传）。 */
export const ISOLATION_CODES: readonly string[] = Object.freeze([
  SCAN_RECORD_MISSING,
  SCAN_ITEM_MALFORMED,
]);

/** 隔离事实（审计缝的输入：哪项、为什么、何时）。 */
export interface WorkerIsolationFact {
  readonly code: string;
  readonly item?: ScannedItem;
  readonly isolatedAt: string;
}

export type WorkerLaneOutcome =
  | { readonly status: "executed"; readonly item: ScannedItem }
  | {
      /** 缺失归属/畸形条目：从未执行，隔离待处置（不是以默认身份跑）。 */
      readonly status: "isolated";
      readonly code: string;
      readonly item?: ScannedItem;
    }
  | {
      readonly status: "released";
      readonly item: ScannedItem;
      readonly reason: string;
    }
  | {
      readonly status: "refused";
      readonly item?: ScannedItem;
      readonly code: string;
    }
  | { readonly status: "lease-held"; readonly item: ScannedItem };

export interface WorkerExecutionLane {
  runDue(
    machine: MachineScanIdentity,
    options?: ScanOptions,
  ): Promise<WorkerLaneOutcome[]>;
}

/**
 * Worker 执行通道：唯一的执行引擎是传入的扫描执行器（MT042 全套规则——
 * 重建、租约、gate 事务）。Lane 只做两件事：
 *   a. 入口钉机器身份（AC3：未签发/用户形/往返对象 →
 *      MACHINE_IDENTITY_INVALID，不碰执行器）；
 *   b. 把「缺失归属」的扫描结局改判 isolated 并交给 onIsolated 缝
 *      （默认缝 = 结构化日志一行；绝不静默）。隔离项的执行回调零调用
 *      是扫描执行器自己的结构性质（refused 在执行前返回）。
 */
export function createWorkerExecutionLane({
  scanExecutor,
  onIsolated,
}: {
  readonly scanExecutor: ScanExecutor;
  /** 隔离事实缝（审计/清单接线属调用方；缺省 = 结构化日志）。 */
  readonly onIsolated?: (fact: WorkerIsolationFact) => void;
}): WorkerExecutionLane {
  if (!scanExecutor || typeof scanExecutor.scanAndExecute !== "function") {
    throw new TypeError("WORKER_LANE_EXECUTOR_REQUIRED");
  }
  const recordIsolation =
    onIsolated ??
    ((fact: WorkerIsolationFact) => {
      getLogger("server").info(
        {
          type: "worker-task-isolated",
          code: fact.code,
          item: fact.item
            ? { jobKind: fact.item.jobKind, objectId: fact.item.objectId }
            : null,
          isolatedAt: fact.isolatedAt,
        },
        "a due task is isolated for missing attribution — never executed under a default identity; disposition is an operator decision",
      );
    });
  return {
    async runDue(machine, options) {
      // AC3：入口只认签发过的机器身份（用户 Scope/手造对象在这里死掉，
      // 执行器里的同一断言是第二道）。
      assertTrustedMachineIdentity(machine);
      const outcomes = await scanExecutor.scanAndExecute(machine, options);
      return outcomes.map((outcome) => {
        if (
          outcome.status === "refused" &&
          ISOLATION_CODES.includes(outcome.code)
        ) {
          const fact: WorkerIsolationFact = {
            code: outcome.code,
            item: outcome.item,
            isolatedAt: new Date().toISOString(),
          };
          recordIsolation(fact);
          return { status: "isolated", code: outcome.code, item: outcome.item };
        }
        return outcome;
      });
    },
  };
}

/** 机器身份签发入口的再导出（装配面唯一合法来源；用户形 id 在此被拒）。 */
export { createMachineScanIdentity };

// ---------------------------------------------------------------------------
// AC4：后台程序配置解析（按记录归属，不读全局可变状态）
// ---------------------------------------------------------------------------

/** 后台记录的归属事实（服务器持久化：trigger 行/任务 pin 的归属列）。 */
export interface BackgroundProgramRecord {
  /** 记录绑定的主体（可缺——机器 pin 无用户；缺了仍须有租户/团队）。 */
  readonly actorId?: string;
  readonly tenantId?: string;
  readonly workspaceId?: string;
}

/** 记录缺归属的唯一哨兵：不存在「进程当前公司」可回退。 */
export const BG_CONFIG_RECORD_UNATTRIBUTED = "BG_CONFIG_RECORD_UNATTRIBUTED";

/**
 * 后台配置解析：每条记录按自己的归属经 MT122 内部半边建立上下文
 * （entrypoint="schedule"，成员资格 DB 重验），再解析 MT014 运行配置。
 * 记录缺 tenant/workspace 即拒绝——结构上没有第二个输入面（工厂 + 记录），
 * 「全局可变状态」无从事读。多公司部署下同一份代码按记录各归各位。
 */
export async function resolveBackgroundRuntimeConfig(
  entryFactory: Pick<DeploymentEntryContextFactory, "fromInternalIdentity">,
  record: BackgroundProgramRecord,
): Promise<ResolvedRuntimeConfig> {
  if (
    typeof record.tenantId !== "string" ||
    !record.tenantId.trim() ||
    typeof record.workspaceId !== "string" ||
    !record.workspaceId.trim()
  ) {
    throw new Error(BG_CONFIG_RECORD_UNATTRIBUTED);
  }
  const identity: DeploymentInternalEntryIdentity = {
    actorId: record.actorId ?? "",
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
  };
  const business = await entryFactory.fromInternalIdentity(identity);
  return business.runtimeConfig();
}
