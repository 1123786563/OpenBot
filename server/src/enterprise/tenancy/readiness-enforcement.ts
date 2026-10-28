// server/src/enterprise/tenancy/readiness-enforcement.ts
// MT129（Issue #172）：多租户启动就绪强制与缺口阻断。
//
// 票面语义：多租户模式启动时强制校验入口覆盖、例外登记、隔离清单、
// 单用户绕过与数据库角色安全；任何缺口都阻止启动并输出机器可读报告。
//
// 结构（在已交付五门之上加编排、隔离门与报告，不重写任何一门）：
//
//   1. 五道既有门原样跑（runMultitenancyStartupChecks）：入口覆盖（MT001/
//      MT013）、全局例外登记闭合（MT030/MT127）、机器回调与个人直连例外
//      登记（MT128）、单用户绕过（MT013）、数据库角色安全（MT013）。
//   2. 第六道门——隔离清单（MT120）：evaluateMultitenancyQuarantineReadiness
//      （扫描 → open 集非空即缺口）。输入是显式的：MT112 锚点默认团队由
//      部署命名（OPENBOT_MULTITENANCY_QUARANTINE_DEFAULT_WORKSPACE），
//      缺输入即 fail-closed——验证不了「隔离清单已清空」就不能声称通过。
//      扫描异常（表缺失、锚点不唯一）折叠为带理由的检查失败，不裸穿进程。
//   3. 机器可读缺口报告（AC2）：buildReadinessGapReport 把拒绝记录摊平成
//      {schemaVersion:1, gaps:[{check, code?, detail}]}——一行 JSON，CI 可
//      parse 可阻断（verdict 非 0 退出即 CI 闸；报告给出为什么）。
//   4. verdict（AC1/AC2）：恰好一条结构化执行记录进日志；拒绝时写缺口报告
//      （可注入 write，默认 stderr 一行 JSON）并以非 0 退出——拒绝不是
//      警告继续。log/write/exit 全部可注入供单测断言。
//
// AC3（单租户回归）：开关关闭时 runReadinessEnforcement 直接返回
// {mode:"off", accepted:true}，不触碰任何输入面——单租户按既有方式启动
// （既有装配只有 config.multitenancy.enabled 才进本编排，这里再钉一层）。
//
// AC4（放宽纪律）：唯一的放宽面是 coverage 豁免清单（既有
// OPENBOT_MULTITENANCY_WAIVERS——每条必须命名真实入口且带非空理由，typo
// 与空理由都是配置错误）。隔离清单没有配置放宽路径：清空它的唯一方式是
// 处置条目（MT120 的 assign/destroy，带审计），不是绕过校验。

import { writeSync } from "node:fs";

import { getLogger } from "../../../../shared/logger";
import type { Database } from "../../db/client";
import { evaluateMultitenancyQuarantineReadiness } from "./quarantine-list";
import {
  type MultitenancyStartupInputs,
  type MultitenancyStartupRecord,
  runMultitenancyStartupChecks,
} from "./startup-checks";

/** 隔离门的显式输入（缺一即 fail-closed，理由点名缺的输入）。 */
export interface QuarantineGateInput {
  readonly database: Database;
  /** MT112 锚点默认团队（部署命名，不内部猜测——root-backfill 同款纪律）。 */
  readonly defaultWorkspaceId: string;
}

export type QuarantineGateCheck =
  | {
      readonly ok: true;
      /** open 条目的确定性 id（`<category>:<recordId>`）；通过时为空。 */
      readonly openItems: readonly string[];
      readonly scannedAt: string;
    }
  | { readonly ok: false; readonly reason: string };

export interface ReadinessEnforcementInputs extends MultitenancyStartupInputs {
  /** 多租户开关（关闭 = 单租户既有启动，本编排零行为）。 */
  readonly multitenancy: boolean;
  readonly quarantine?: QuarantineGateInput;
}

export interface ReadinessEnforcementDeps {
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly createDatabase?: (url: string) => Database;
  readonly closeDatabase?: (database: Database) => Promise<void>;
  /**
   * 隔离门评估缝（默认 = MT120 真实扫描；测试注入假记录）。扫描自身的
   * 数据库行为由 MT120 套件覆盖，本编排只消费其记录契约。
   */
  readonly evaluateQuarantineReadiness?: (
    database: Database,
    input: { readonly defaultWorkspaceId: string },
  ) => Promise<import("./quarantine-list").QuarantineReadinessRecord>;
}

export type MultitenancyReadinessEnforcementRecord =
  | {
      readonly type: "multitenancy-readiness-enforcement";
      readonly mode: "off";
      readonly accepted: true;
      readonly timestamp: string;
      readonly checks: null;
    }
  | {
      readonly type: "multitenancy-readiness-enforcement";
      readonly mode: "on";
      readonly accepted: boolean;
      readonly timestamp: string;
      readonly checks: {
        readonly startup: MultitenancyStartupRecord;
        readonly quarantine: QuarantineGateCheck;
      };
    };

/**
 * 就绪强制编排：五道既有门 + 隔离门，全部评估完才返回（缺口一次列全，
 * 不发现第一个就停）。隔离扫描用完的连接由调用方管理；扫描内部的异常
 * 折叠为该门的失败理由（表缺失/锚点异常都是缺口，不是进程崩溃）。
 */
export async function runReadinessEnforcement(
  inputs: ReadinessEnforcementInputs,
  deps: ReadinessEnforcementDeps = {},
): Promise<MultitenancyReadinessEnforcementRecord> {
  if (!inputs.multitenancy) {
    return {
      type: "multitenancy-readiness-enforcement",
      mode: "off",
      accepted: true,
      timestamp: new Date().toISOString(),
      checks: null,
    };
  }
  const startup = await runMultitenancyStartupChecks(inputs, deps);
  const quarantine = await evaluateQuarantineGate(
    inputs.quarantine,
    deps.evaluateQuarantineReadiness ?? evaluateMultitenancyQuarantineReadiness,
  );
  return {
    type: "multitenancy-readiness-enforcement",
    mode: "on",
    accepted: startup.accepted && quarantine.ok,
    timestamp: new Date().toISOString(),
    checks: { startup, quarantine },
  };
}

/** 隔离门（AC1 的隔离清单半边）：显式输入 → 扫描 → open 集。 */
async function evaluateQuarantineGate(
  input: QuarantineGateInput | undefined,
  evaluate: (
    database: Database,
    input: { readonly defaultWorkspaceId: string },
  ) => Promise<import("./quarantine-list").QuarantineReadinessRecord>,
): Promise<QuarantineGateCheck> {
  if (!input?.database) {
    return {
      ok: false,
      reason:
        "the quarantine gate cannot run: no database provided — multitenancy mode must name the quarantine scan database and the MT112 anchor default workspace (OPENBOT_MULTITENANCY_QUARANTINE_DEFAULT_WORKSPACE); an unverified quarantine list is a gap, not a pass",
    };
  }
  if (
    typeof input.defaultWorkspaceId !== "string" ||
    !input.defaultWorkspaceId.trim()
  ) {
    return {
      ok: false,
      reason:
        "the quarantine gate cannot run: the MT112 anchor default workspace is not named (OPENBOT_MULTITENANCY_QUARANTINE_DEFAULT_WORKSPACE) — the scan input is explicit by design, never guessed",
    };
  }
  try {
    const record = await evaluate(input.database, {
      defaultWorkspaceId: input.defaultWorkspaceId,
    });
    if (!record.accepted) {
      const ids = record.checks.openItems
        .map((item) => item.id)
        .sort()
        .join(", ");
      return {
        ok: false,
        reason: `the quarantine list is not empty: ${record.checks.openItems.length} open item(s) [${ids}] — dispositions (assign/destroy, audited) are the only way to clear them, there is no config waiver for this gate`,
      };
    }
    return {
      ok: true,
      openItems: [],
      scannedAt: record.checks.scannedAt,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `the quarantine gate could not be evaluated (${error instanceof Error ? error.message : String(error)}) — an unevaluable quarantine list is a gap, not a pass`,
    };
  }
}

// ---------------------------------------------------------------------------
// 机器可读缺口报告（AC2：CI 可 parse、可阻断）
// ---------------------------------------------------------------------------

/** 一条摊平的缺口：哪道门、什么码（有结构化码时）、说明。 */
export interface ReadinessGap {
  readonly check: string;
  readonly code?: string;
  readonly detail: string;
}

export interface ReadinessGapReport {
  readonly schemaVersion: 1;
  readonly type: "multitenancy-readiness-gap-report";
  readonly accepted: boolean;
  readonly generatedAt: string;
  readonly gaps: readonly ReadinessGap[];
}

/**
 * 摊平拒绝记录为机器可读缺口报告（纯函数；通过时 gaps 为空数组）。
 * 每道失败门逐条展开：coverage 的 uncovered 入口、devBypass 与两族例外
 * 登记的 findings、databaseRoles 的理由、隔离门的 open 集合/理由——
 * 一份报告列全所有缺口（与各门「一次列全」的纪律同源）。
 */
export function buildReadinessGapReport(
  record: MultitenancyReadinessEnforcementRecord,
): ReadinessGapReport {
  const gaps: ReadinessGap[] = [];
  if (record.mode === "off") {
    return {
      schemaVersion: 1,
      type: "multitenancy-readiness-gap-report",
      accepted: true,
      generatedAt: record.timestamp,
      gaps,
    };
  }
  const { startup, quarantine } = record.checks;
  if (!startup.checks.coverage.ok) {
    gaps.push({ check: "coverage", detail: startup.checks.coverage.reason });
    for (const uncovered of startup.checks.coverage.uncovered) {
      gaps.push({
        check: "coverage",
        code:
          uncovered.reason === "unowned"
            ? "UNOWNED_ENTRANCE"
            : "UNCLASSIFIED_ENTRANCE",
        detail: `${uncovered.entrance} is ${uncovered.reason} — every entrance must be owned and classified before multitenancy boots (explicit waivers are the only relaxation and each carries a reason)`,
      });
    }
  }
  if (!startup.checks.devBypass.ok) {
    for (const finding of startup.checks.devBypass.findings) {
      gaps.push({
        check: "devBypass",
        detail: `${finding.source}: ${finding.detail}`,
      });
    }
  }
  if (!startup.checks.databaseRoles.ok) {
    gaps.push({
      check: "databaseRoles",
      detail: startup.checks.databaseRoles.reason,
    });
  }
  if (!startup.checks.globalExceptions.ok) {
    for (const finding of startup.checks.globalExceptions.findings) {
      gaps.push({
        check: "globalExceptions",
        code: finding.code,
        detail: finding.detail,
      });
    }
  }
  if (!startup.checks.machinePersonalExceptions.ok) {
    for (const finding of startup.checks.machinePersonalExceptions.findings) {
      gaps.push({
        check: "machinePersonalExceptions",
        code: finding.code,
        detail: finding.detail,
      });
    }
  }
  if (!quarantine.ok) {
    gaps.push({ check: "quarantine", detail: quarantine.reason });
  }
  return {
    schemaVersion: 1,
    type: "multitenancy-readiness-gap-report",
    accepted: gaps.length === 0,
    generatedAt: record.timestamp,
    gaps,
  };
}

/** CI 闸（纯函数）：报告是否阻断（accepted=false 即阻断）。 */
export function readinessGateBlocks(report: ReadinessGapReport): boolean {
  return !report.accepted;
}

/**
 * verdict：恰好一条结构化执行记录进日志；拒绝时写机器可读缺口报告
 * （write 可注入，默认 stderr 一行 JSON）并以非 0 退出。通过时不写报告
 * （没有缺口要报）。log/write/exit 全部可注入供单测断言（MT013/
 * MT123/MT120 verdict 同款）。
 */
export function applyReadinessEnforcementVerdict(
  record: MultitenancyReadinessEnforcementRecord,
  hooks: {
    readonly log?: Pick<ReturnType<typeof getLogger>, "info">;
    readonly write?: (line: string) => void;
    readonly exit?: (code: number) => void;
  } = {},
): void {
  const log = hooks.log ?? getLogger("server");
  log.info(
    record,
    record.accepted
      ? "multitenancy readiness enforcement passed — booting in multitenancy mode"
      : "multitenancy readiness enforcement failed — refusing to boot (gap report follows on stderr; exit 1)",
  );
  if (!record.accepted) {
    const report = buildReadinessGapReport(record);
    // 默认走同步写：stderr 指向管道时 process.stderr.write 是异步的，
    // 紧随的 process.exit(1) 可能截断缺口报告，破坏 CI 可 parse 契约。
    const write = hooks.write ?? ((line: string) => writeSync(2, line));
    write(`${JSON.stringify(report)}\n`);
    if (hooks.exit) hooks.exit(1);
    else process.exit(1);
  }
}
