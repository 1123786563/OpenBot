// server/tests/multitenancy/gap-closure.test.ts
// MT141（Issue #184）：缺口关闭与阻塞项清单——清单的可执行形态。
//
// 三件事，全部可独立复核：
//   1) 人口普查闭合：从真实 inventory 减去覆盖套件真实 PLAN 的入口，剩余
//      每一个入口都必须落入 gap-registry 的某个桶（桶带处置结论），任何
//      未分类入口或空桶都让本套件红——清单不可能悄悄缺项，也不可能虚挂。
//   2) 已修复缺口的回归钉真实重跑：G-FIX-1（MT139 修复的 anomalies 缺省
//      崩溃）由 web-billing 套件的 MT141 pin 钉住，本套件以子进程真跑该
//      套件并折叠结果（同 bun-suites.test.ts 驱动层先例），不是读旧报告。
//   3) 未验证项与环境阻塞项：真探针（simctl/emulator/adb）重放，MT111
//      集成证据的 enabled-unverified / not-implemented 闭集复核。
//
// 环境契约：与其他覆盖套件一致——只认显式 TEST_DATABASE_URL 加三个受限
// 角色 URL，缺配置整套显式 skip（理由写在用例名里），绝不回退开发库。
//
// 证据可复现（票面 Verification）：
//   . /tmp/mt26-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/gap-closure.test.ts

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { buildInventory } from "../../scripts/multitenancy/inventory";
import { INTEGRATION_EVIDENCE } from "../../src/enterprise/tenancy/integration-evidence";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import { COVERAGE_SUITES as COVERAGE_MAP } from "./support/acceptance-map";
import {
  DISCLOSED_LIMITS,
  ENTRANCE_BUCKETS,
  type EntranceBucket,
  FIXED_GAPS,
  releaseReadiness,
  UNVERIFIED_ITEMS,
} from "./support/gap-registry";

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
      reason: `MT141 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name: string, fn: () => Promise<void>, timeout?: number) => {
  if (!ENV.ok) {
    return test.skip(`${name} [skipped: ${ENV.reason}]`, fn);
  }
  return timeout === undefined ? test(name, fn) : test(name, fn, timeout);
}) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** The real inventory the census derives from. */
const inventory = await buildInventory({ environment: process.env });

/**
 * The coverage suites whose PLANs form the mapped set — the ONE list lives in
 * the acceptance map (MT143 consumes the same list for the aggregate gate, so
 * the census and the gate cannot drift apart). The census reads the suites'
 * sources for entrance-id-shaped PLAN keys — the same ids requireEntrance
 * validates — so a suite that stops planning an entrance moves it back into
 * the census here, loudly.
 */
const COVERAGE_SUITES = COVERAGE_MAP.map((entry) => entry.suite);

// PLAN 键形态：`"METHOD /path": {`——要求尾随冒号，把套件注释里引用的
// 入口（如漂移守卫的 gapIds.has(...) 例）与真实计划键区分开。
const ENTRANCE_ID_PATTERN =
  /"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^"]+)":/g;

function mappedEntrances(): Set<string> {
  const mapped = new Set<string>();
  for (const suite of COVERAGE_SUITES) {
    const text = readFileSync(suite, "utf8");
    for (const match of text.matchAll(ENTRANCE_ID_PATTERN)) {
      mapped.add(`${match[1]} ${match[2]}`);
    }
  }
  return mapped;
}

/**
 * One bucket claims an entrance when a prefix matches the path (after the
 * method) exactly or as a segment prefix, or — for the WS mounts — the full id.
 */
function bucketOf(id: string): EntranceBucket | undefined {
  const space = id.indexOf(" ");
  const method = space > 0 ? id.slice(0, space) : "";
  const path = space > 0 ? id.slice(space + 1) : id;
  return ENTRANCE_BUCKETS.find((bucket) => {
    if (
      bucket.exactPrefixes?.some((prefix) => path === prefix || id === prefix)
    ) {
      return true;
    }
    return bucket.prefixes.some((prefix) => {
      if (prefix.startsWith("WS ") || prefix.startsWith("ALL ")) {
        return id === prefix || id.startsWith(prefix);
      }
      return (
        path === prefix ||
        path.startsWith(`${prefix}/`) ||
        (method === "ALL" && path === `${prefix}/*`)
      );
    });
  });
}

// ---------------------------------------------------------------------------
// 真探针（未验证项的重放）
// ---------------------------------------------------------------------------

function probe<I extends readonly string[]>(
  command: string,
  args: I,
): { found: boolean } {
  const proc = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { found: proc.exitCode === 0 };
}

// ---------------------------------------------------------------------------

let census: string[] = [];
let bucketCounts = new Map<string, number>();
let unmatched: string[] = [];

beforeAll(() => {
  if (!ENV.ok) return;
  const mapped = mappedEntrances();
  census = inventory.entrances
    .map((entry) => entry.id)
    .filter((id) => !mapped.has(id));
  bucketCounts = new Map<string, number>();
  unmatched = [];
  for (const id of census) {
    const bucket = bucketOf(id);
    if (!bucket) {
      unmatched.push(id);
      continue;
    }
    bucketCounts.set(bucket.id, (bucketCounts.get(bucket.id) ?? 0) + 1);
  }
});

afterAll(async () => {
  // 报告产物（可选写出：MT_COVERAGE_REPORT_OUT 指定路径）。
  const out = process.env.MT_COVERAGE_REPORT_OUT?.trim();
  if (!out || !ENV.ok) return;
  const report = {
    schemaVersion: 1,
    runner: "mt141-gap-census",
    ticket: 184,
    generatedAt: new Date().toISOString(),
    mappedEntrances: inventory.entrances.length - census.length,
    censusSize: census.length,
    unmatched,
    bucketCounts: Object.fromEntries(bucketCounts),
    buckets: ENTRANCE_BUCKETS,
    fixedGaps: FIXED_GAPS,
    unverifiedItems: UNVERIFIED_ITEMS,
    disclosedLimits: DISCLOSED_LIMITS,
    releaseReadiness: releaseReadiness(),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
});

// ---------------------------------------------------------------------------

describe("MT141 / Issue #184 — 缺口清单（注册表完整性）", () => {
  test("入口桶：id 唯一、处置合法、来源与理由非空", () => {
    const ids = new Set<string>();
    for (const bucket of ENTRANCE_BUCKETS) {
      expect(ids.has(bucket.id)).toBe(false);
      ids.add(bucket.id);
      expect(bucket.prefixes.length).toBeGreaterThan(0);
      expect(bucket.source.trim().length).toBeGreaterThan(0);
      expect(bucket.reason.trim().length).toBeGreaterThan(0);
      expect([
        "blocked-open",
        "environment-blocked",
        "global-exception",
      ]).toContain(bucket.disposition);
    }
    const limitIds = new Set<string>();
    for (const limit of DISCLOSED_LIMITS) {
      expect(limitIds.has(limit.id)).toBe(false);
      limitIds.add(limit.id);
      expect(limit.reason.trim().length).toBeGreaterThan(0);
    }
    for (const item of UNVERIFIED_ITEMS) {
      expect(item.probe.trim().length).toBeGreaterThan(0);
    }
  });

  test("已修复缺口：回归钉文件真实存在，重验命令记录在案", () => {
    expect(FIXED_GAPS.length).toBeGreaterThan(0);
    for (const gap of FIXED_GAPS) {
      expect(existsSync(gap.regressionPin.split(" (")[0])).toBe(true);
      expect(gap.rerun).toContain("bun --no-env-file test");
      expect(gap.fix.trim().length).toBeGreaterThan(0);
    }
  });

  test("领域证据引用：注册表 basisRefs 指向真实存在的仓内文件", () => {
    for (const bucket of ENTRANCE_BUCKETS) {
      for (const ref of bucket.domainEvidence ?? []) {
        expect(existsSync(ref)).toBe(true);
      }
    }
    for (const limit of DISCLOSED_LIMITS) {
      for (const ref of limit.domainEvidence ?? []) {
        expect(existsSync(ref)).toBe(true);
      }
    }
  });
});

describeDb("MT141 / Issue #184 — 人口普查闭合（清单无缺项、无空桶）", () => {
  itDb(
    "每一个未被覆盖套件 PLAN 认领的入口都落入一个桶（未分类即红）",
    async () => {
      expect(unmatched).toEqual([]);
      // 抽查：普查里确有入口、已知未映射例仍在、已映射例确不在（防普查假空/假满）。
      expect(census.length).toBeGreaterThan(400);
      expect(census).toContain("GET /api/agents");
      expect(census).toContain("GET /health");
      // 该入口只在套件注释里被引用为「预期缺口」，不是任何 PLAN 键 → 在普查里。
      expect(census).toContain("POST /api/enterprise/conversations");
      // 真 PLAN 键（governance 套件）→ 不在普查里。
      expect(census).not.toContain("GET /api/admin/audit-events");
    },
    240_000,
  );

  itDb("没有空桶（每个桶至少认领一个入口——虚挂的桶即红）", async () => {
    const dead = ENTRANCE_BUCKETS.filter(
      (bucket) => (bucketCounts.get(bucket.id) ?? 0) === 0,
    ).map((bucket) => bucket.id);
    expect(dead).toEqual([]);
  });

  itDb(
    "普查规模与桶计数自洽（每个入口恰好计入一个桶）",
    async () => {
      const total = [...bucketCounts.values()].reduce((sum, n) => sum + n, 0);
      expect(total).toBe(census.length);
      expect(total + (inventory.entrances.length - census.length)).toBe(
        inventory.entrances.length,
      );
    },
    120_000,
  );
});

describeDb("MT141 / Issue #184 — 已修复缺口真实重跑 + 未验证项重放", () => {
  itDb(
    "G-FIX-1 回归钉：web-billing 套件子进程真跑（含 MT141 pin），7/7 绿",
    async () => {
      const proc = Bun.spawn(
        [
          "bun",
          "--no-env-file",
          "test",
          "app/tests/multitenancy/web-billing.test.tsx",
        ],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            COPILOTKIT_TELEMETRY_DISABLED: "1",
          },
        },
      );
      const stderr = await new Response(proc.stderr).text();
      await new Response(proc.stdout).text();
      const exit = await proc.exited;
      expect(exit).toBe(0);
      expect(stderr).toContain("7 pass");
      expect(stderr).toContain(" 0 fail");
    },
    300_000,
  );

  itDb(
    "未验证项探针重放：simctl 可用性、emulator/adb 缺席（记录，不计为通过）",
    async () => {
      const simctl = probe("xcrun", ["simctl", "list", "devices", "available"]);
      const emulator = probe("which", ["emulator"]);
      const adb = probe("which", ["adb"]);
      // 探针结果只影响记录，不影响通过：未验证项永不被计为通过。
      // 本环境事实：iOS 模拟器运行时存在；Android 工具链缺席。
      expect(simctl.found).toBe(true);
      expect(emulator.found).toBe(false);
      expect(adb.found).toBe(false);
      // 注册表里的两条未验证项与探针命令一一对应。
      expect(UNVERIFIED_ITEMS.map((item) => item.id).sort()).toEqual([
        "G-UNV-1",
        "G-UNV-2",
      ]);
    },
  );

  itDb(
    "MT111 集成证据：enabled-unverified / not-implemented 是显式阻断项，basisRefs 全为真实文件",
    async () => {
      const blocking = INTEGRATION_EVIDENCE.filter(
        (entry) =>
          entry.classification === "enabled-unverified" ||
          entry.classification === "not-implemented",
      );
      expect(blocking.length).toBeGreaterThan(0);
      for (const entry of blocking) {
        expect(entry.basisRefs.length).toBeGreaterThan(0);
        for (const ref of entry.basisRefs) {
          expect(existsSync(ref)).toBe(true);
        }
      }
      // 这些 id 属于缺口清单的未验证面：就绪结论必须为否。
      const readiness = releaseReadiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
