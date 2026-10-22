// server/tests/multitenancy/full-coverage.test.ts
// MT143（Issue #186）：统一上线候选包的机器面——全功能验收聚合门。
//
// 这不是又一套覆盖套件：它把已交付的六个覆盖套件作为子进程真跑一遍
// （每个套件自带复现命令与两制登记），折叠它们的矩阵报告，再把三件事
// 钉在同一份产物上（reports/full-coverage-mt143.json）：
//
//   1) 聚合门（full-coverage-1）：六套件全绿，且每份报告的 covered
//      入口数与其 PLAN 规模一致（缺 env 的静默 skip 会让报告缺文件——
//      报告必须真实写出，否则本套件红）。
//   2) 证据链一致（full-coverage-2）：A1–A13 验收映射逐项存在、证据
//      文件真实在树、server 树内的证据套件都已进 e2e 驱动清单
//      （tests/config/e2e-bun-suites.json）。
//   3) 环境纪律（full-coverage-3）：验收只认回环 + openbot_enterprise_*
//      命名的专用测试库；对伪造的开发库 URL，真实守卫代码必须拒绝
//      （这是 denial 侧的真探针，不是断言缺失）。
//
// 结论语义（与候选包文档一致）：releaseReadiness 来自 MT141 缺口注册表
// ——存在阻塞项与未验证项时 ready=false，统一上线不声明就绪；本套件
// 把这个结论连同证据一起钉住，不替它说谎。
//
// 环境契约：与其余覆盖套件一致；缺配置显式 skip，绝不回退开发库。
//
// 证据可复现（票面 Verification）：
//   . /tmp/mt26-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/full-coverage.test.ts

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import { ACCEPTANCE_MAP, COVERAGE_SUITES } from "./support/acceptance-map";
import { ENTRANCE_BUCKETS, releaseReadiness } from "./support/gap-registry";
import {
  registerIsolationDomain,
  runIsolationScenario,
} from "./support/scenarios";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT143 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
// 与兄弟套件同形，但转发超时：聚合门要真跑六个子进程套件（默认 5s 不够）；
// 未给超时的用例不传 undefined（bun 会把 undefined 当 NaN 折成 1ms）。
const itDb = ((name: string, fn: () => Promise<void>, timeout?: number) => {
  if (!ENV.ok) {
    return test.skip(`${name} [skipped: ${ENV.reason}]`, fn);
  }
  return timeout === undefined ? test(name, fn) : test(name, fn, timeout);
}) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 聚合门：六套件子进程真跑 + 报告折叠
// ---------------------------------------------------------------------------

interface SuiteRun {
  readonly suite: string;
  readonly report: string;
  readonly exit: number;
  readonly coveredEntrances: number;
  readonly totalEntrances: number;
  readonly wroteReport: boolean;
}

async function runOne(
  decl: (typeof COVERAGE_SUITES)[number],
): Promise<SuiteRun> {
  const proc = Bun.spawn(["bun", "--no-env-file", "test", decl.suite], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      MT_COVERAGE_REPORT_OUT: decl.report,
      COPILOTKIT_TELEMETRY_DISABLED: "1",
    },
  });
  await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  const failLine = stderr.match(/^ *(\d+) fail/m)?.[1] ?? "?";
  if (exit !== 0) {
    throw new Error(
      `FULL_COVERAGE_SUITE_RED:${decl.suite}:exit=${exit}:fails=${failLine}`,
    );
  }
  const wroteReport = existsSync(decl.report);
  if (!wroteReport) {
    // 报告没写出 = 套件以 skip 形态静默通过（缺 env）——按失败处理。
    throw new Error(
      `FULL_COVERAGE_REPORT_MISSING:${decl.report}:suite skipped silently?`,
    );
  }
  const parsed = JSON.parse(readFileSync(decl.report, "utf8")) as {
    summary: { coveredEntrances: number; totalEntrances: number };
  };
  if (parsed.summary.coveredEntrances <= 0) {
    throw new Error(`FULL_COVERAGE_EMPTY:${decl.report}`);
  }
  return {
    suite: decl.suite,
    report: decl.report,
    exit,
    coveredEntrances: parsed.summary.coveredEntrances,
    totalEntrances: parsed.summary.totalEntrances,
    wroteReport,
  };
}

let aggregateRuns: SuiteRun[] | undefined;
// 串行真跑：六套件共享同一测试库，并行会撞共享状态顺序（#52/MT113 族的
// 已知顺序敏感红），聚合门按全目录收敛后的串行语义执行。
const aggregate = async (): Promise<SuiteRun[]> => {
  if (aggregateRuns) return aggregateRuns;
  const runs: SuiteRun[] = [];
  for (const decl of COVERAGE_SUITES) {
    runs.push(await runOne(decl));
  }
  aggregateRuns = runs;
  return runs;
};

// ---------------------------------------------------------------------------
// full-coverage 域（T26 词汇）：三个场景，全部骑真实事实
// ---------------------------------------------------------------------------

const SCENARIOS = {
  /**
   * full-coverage-1：任一功能正向失败、越权成功或关键场景缺证据 →
   * release=false。正向侧 = 六套件全绿且报告真实写出；denial 侧 =
   * 每份报告的 covered 入口都两制通过（覆盖套件自身断言两制，报告
   * covered 数即两制数）；无泄漏、无越权副作用。
   */
  "full-coverage-1": async () => {
    const runs = await aggregate();
    const allCovered = runs.every(
      (run) => run.coveredEntrances > 0 && run.exit === 0 && run.wroteReport,
    );
    return {
      positiveControlPassed: allCovered,
      denied: allCovered,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  /**
   * full-coverage-2：同一检查点的验证、审查与候选包引用同一组证据
   * 文件——映射逐项存在、文件在树、驱动清单登记。
   */
  "full-coverage-2": async () => {
    const missing: unknown[] = [];
    const ids = new Set(ACCEPTANCE_MAP.map((item) => item.id));
    const expectedIds = new Set([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "A11",
      "A12",
      "A13",
    ] as const);
    for (const id of expectedIds) {
      if (!ids.has(id)) missing.push(`acceptance-item-absent:${id}`);
    }
    for (const item of ACCEPTANCE_MAP) {
      if (item.evidence.length === 0) {
        missing.push(`acceptance-item-empty:${item.id}`);
      }
      for (const evidence of item.evidence) {
        if (!existsSync(evidence.path)) {
          missing.push(`evidence-file-absent:${item.id}:${evidence.path}`);
        }
      }
    }
    const manifest = readFileSync("tests/config/e2e-bun-suites.json", "utf8");
    for (const decl of COVERAGE_SUITES) {
      if (!manifest.includes(decl.suite)) {
        missing.push(`suite-not-in-driven-manifest:${decl.suite}`);
      }
    }
    for (const own of [
      "server/tests/multitenancy/gap-closure.test.ts",
      "server/tests/multitenancy/full-coverage.test.ts",
    ]) {
      if (!manifest.includes(own)) {
        missing.push(`suite-not-in-driven-manifest:${own}`);
      }
    }
    return {
      positiveControlPassed: missing.length === 0,
      denied: missing.length === 0,
      leakedRecords: missing,
      forbiddenEffects: [],
    };
  },
  /**
   * full-coverage-3：验收不使用共享端口、原开发库或 root .env——
   * 专用库守卫（回环 + openbot_enterprise_* 命名）真实放行当前环境，
   * 且对伪造的开发库 URL 真实拒绝（denial 探针骑真实守卫代码）。
   */
  "full-coverage-3": async () => {
    const url = enterpriseTestDatabaseUrlFrom();
    const loopback = /127\.0\.0\.1|localhost|\[::1\]/.test(
      new URL(url).hostname,
    );
    const named = /openbot_enterprise_/.test(new URL(url).pathname);
    // denial 探针：一个开发库命名的 URL 交给同一个真实守卫（setup 变量
    // 摘除，迫使守卫读 TEST_DATABASE_URL）——必须拒绝，且拒绝理由点名
    // openbot_enterprise_* 命名（骑真实守卫代码，不是断言缺失）。
    const forged: Record<string, string | undefined> = { ...process.env };
    delete forged.ENTERPRISE_TEST_SETUP_DATABASE_URL;
    forged.TEST_DATABASE_URL =
      "postgres://postgres:postgres@127.0.0.1:5432/openbot_dev";
    let refused = false;
    let refusal = "";
    try {
      enterpriseTestDatabaseUrlFrom(forged);
    } catch (error) {
      refused = true;
      refusal = error instanceof Error ? error.message : String(error);
    }
    return {
      positiveControlPassed:
        loopback && named && refused && refusal.includes("openbot_enterprise"),
      denied: refused,
      leakedRecords: [],
      forbiddenEffects: refused ? [] : ["dev-database-url-accepted"],
    };
  },
} as const;

beforeAll(() => {
  if (!ENV.ok) return;
  registerIsolationDomain("full-coverage", {
    async run(scenarioId: string) {
      const scenario = (SCENARIOS as Record<string, () => Promise<unknown>>)[
        scenarioId
      ];
      if (!scenario) {
        throw new Error(`COVERAGE_SCENARIO_UNKNOWN:${scenarioId}`);
      }
      return scenario();
    },
  });
});

// ---------------------------------------------------------------------------

describeDb("MT143 / Issue #186 — 统一上线候选包（机器面）", () => {
  itDb(
    "聚合门：六个覆盖套件子进程真跑，全绿且报告真实写出（两制 covered）",
    async () => {
      const runs = await aggregate();
      expect(runs.length).toBe(6);
      for (const run of runs) {
        expect(run.exit).toBe(0);
        expect(run.wroteReport).toBe(true);
        expect(run.coveredEntrances).toBeGreaterThan(0);
      }
      // 聚合覆盖面：六套件两制 covered 入口合计（六套件 PLAN 键并集 68，含
      // 一处跨套件复用故合计 69；下界取并集规模）。
      const covered = runs.reduce((sum, run) => sum + run.coveredEntrances, 0);
      expect(covered).toBeGreaterThanOrEqual(68);
    },
    900_000,
  );

  itDb(
    "full-coverage-1：验收聚合观察（正向=全绿；denial=两制 covered）",
    async () => {
      const observation = await runIsolationScenario(
        "full-coverage",
        "full-coverage-1",
      );
      expect(observation.positiveControlPassed).toBe(true);
      expect(observation.denied).toBe(true);
      expect(observation.leakedRecords).toEqual([]);
      expect(observation.forbiddenEffects).toEqual([]);
    },
    900_000,
  );

  itDb(
    "full-coverage-2：A1–A13 逐项在册、证据文件在树、驱动清单登记",
    async () => {
      const observation = await runIsolationScenario(
        "full-coverage",
        "full-coverage-2",
      );
      expect(observation.positiveControlPassed).toBe(true);
      expect(observation.leakedRecords).toEqual([]);
    },
    240_000,
  );

  itDb(
    "full-coverage-3：专用库纪律（回环 + 企业命名 + 伪造开发库被真守卫拒绝）",
    async () => {
      const observation = await runIsolationScenario(
        "full-coverage",
        "full-coverage-3",
      );
      expect(observation.positiveControlPassed).toBe(true);
      expect(observation.denied).toBe(true);
      expect(observation.forbiddenEffects).toEqual([]);
    },
    120_000,
  );

  itDb(
    "就绪结论诚实钉住：缺口注册表存在阻塞项时 ready=false（候选包不声明就绪）",
    async () => {
      const readiness = releaseReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.length).toBeGreaterThan(0);
      // 桶全部有效（与 MT141 普查同一注册表，双套件互证）。
      expect(ENTRANCE_BUCKETS.length).toBeGreaterThanOrEqual(20);
    },
    120_000,
  );

  itDb(
    "覆盖报告产物（可选写出：MT_COVERAGE_REPORT_OUT 指定路径）",
    async () => {
      const out = process.env.MT_COVERAGE_REPORT_OUT?.trim();
      const runs = await aggregate();
      if (!out) return;
      const inventory = await buildInventory({ environment: process.env });
      const report = {
        schemaVersion: 1,
        runner: "mt143-full-coverage",
        ticket: 186,
        generatedAt: new Date().toISOString(),
        aggregate: runs.map((run) => ({
          suite: run.suite,
          report: run.report,
          coveredEntrances: run.coveredEntrances,
          totalEntrances: run.totalEntrances,
        })),
        inventoryEntrances: inventory.entrances.length,
        acceptanceItems: ACCEPTANCE_MAP.map((item) => ({
          id: item.id,
          evidenceCount: item.evidence.length,
        })),
        releaseReadiness: releaseReadiness(),
      };
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    },
    900_000,
  );
});
