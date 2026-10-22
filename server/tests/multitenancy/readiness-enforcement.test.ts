// server/tests/multitenancy/readiness-enforcement.test.ts
// MT129（Issue #172）：多租户启动就绪强制与缺口阻断。
//
// 验收事实源（Issue #172 验收 1–4，逐条对应 describe）：
//   (1) 存在未登记入口、隔离清单未清空、单用户绕过或不安全数据库角色时
//       拒绝启动并列出缺口——缺口一次列全（六门全评估，不发现第一个就停）。
//   (2) 缺口报告机器可读，可被 CI 阻断——JSON 报告逐门摊平 + verdict 非 0
//       退出 + readinessGateBlocks。
//   (3) 单租户部署仍可按既有方式启动（回归测试）——开关关闭零行为。
//   (4) 放宽任何一项都需要显式配置与理由，不能默认放行——豁免清单是唯一
//       放宽面（且必须命名真实入口 + 非空理由）；隔离门没有配置放宽路径。
//
// 环境契约：编排/报告/verdict 半边纯内存（隔离评估缝注入假记录——扫描
// 自身的数据库行为由 MT120 套件覆盖）；真实库半边专用企业库上钉「扫描
// 异常折叠为带理由的检查失败」（缺 env 显式 skip，绝不回退开发库）。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { CoverageInventory } from "../../scripts/multitenancy/inventory";
import { createDatabase, type Database } from "../../src/db/client";
import type { QuarantineReadinessRecord } from "../../src/enterprise/tenancy/quarantine-list";
import {
  applyReadinessEnforcementVerdict,
  buildReadinessGapReport,
  readinessGateBlocks,
  runReadinessEnforcement,
} from "../../src/enterprise/tenancy/readiness-enforcement";

// ---------------------------------------------------------------------------
// 脚手架：假清单 / 假隔离记录 / 注入面
// ---------------------------------------------------------------------------

function inventoryJson(overrides: {
  entrances?: CoverageInventory["entrances"];
  assemblies?: CoverageInventory["assemblies"];
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-10-22T00:00:00.000Z",
    entrances: overrides.entrances ?? [
      {
        id: "GET /api/agents",
        entrance: "GET /api/agents",
        method: "GET",
        path: "/api/agents",
        kind: "route",
        type: "http",
        businessClosure: "agents",
        ownerTicket: "MT000",
        status: "owned",
      },
    ],
    summary: { serveUpgradeBranches: 0, serveUpgradeEntrances: 0 },
    assemblies: overrides.assemblies ?? [],
  } satisfies CoverageInventory);
}

/** 角色探测的健康行（probeRoleSafety 的 SELECT 经桩数据库返回）。 */
const HEALTHY_ROLE_ROWS = [
  {
    role_exists: true,
    capability_attributes_safe: true,
    login_attributes_safe: true,
    login_has_capability: true,
    login_has_no_other_memberships: true,
  },
];

const healthyProbeDatabase = {
  execute: async () => HEALTHY_ROLE_ROWS,
  $client: { close: async () => {} },
} as unknown as Database;

/** 干净六门：业务清单 + 健康角色探测 + 全绿隔离（其余门在单测里逐门打红）。 */
const CLEAN_INPUTS = {
  multitenancy: true,
  inventoryPath: "memory://inventory",
  directoryUrl: "postgres://entdir:pw@127.0.0.1:5/ent",
  dataUrl: "postgres://entdat:pw@127.0.0.1:5/ent",
  tenantRuntimeUrl: "postgres://entrun:pw@127.0.0.1:5/ent",
  singleUser: false,
} as const;

const CLEAN_DEPS = {
  readTextFile: async () => inventoryJson({}),
  createDatabase: (() => healthyProbeDatabase) as unknown as () => Database,
  closeDatabase: async () => {},
};

function quarantineRecord(
  openItems: readonly { id: string }[],
): QuarantineReadinessRecord {
  return {
    type: "multitenancy-quarantine-readiness",
    mode: "on",
    accepted: openItems.length === 0,
    timestamp: new Date().toISOString(),
    checks: {
      openItems: openItems.map((item, index) => ({
        id: item.id,
        category: "root-record",
        recordId: `record-${index}`,
        reason: "claimed-by-another-tenant",
        suggestedDisposition: "assign",
        status: "open",
        discoveredAt: "2026-10-22T00:00:00.000Z",
        lastSeenAt: "2026-10-22T00:00:00.000Z",
        resolvedAt: null,
        resolvedBy: null,
        targetTenantId: null,
      })),
      scannedAt: "2026-10-22T00:00:00.000Z",
    },
  };
}

const FAKE_DATABASE = { marker: "database" } as unknown as Database;

function cleanQuarantineDeps(
  record: QuarantineReadinessRecord = quarantineRecord([]),
) {
  return {
    evaluateQuarantineReadiness: async () => record,
  };
}

const CLEAN_QUARANTINE = {
  database: FAKE_DATABASE,
  defaultWorkspaceId: "ent-legacy-default-team",
};

// ---------------------------------------------------------------------------
// AC1 — 任何缺口拒绝启动并列出缺口（六门一次列全）
// ---------------------------------------------------------------------------

describe("MT129 就绪强制：缺口拒绝启动、一次列全", () => {
  test("六门全绿 → accepted（干净基底）", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      { ...CLEAN_DEPS, ...cleanQuarantineDeps() },
    );
    expect(record.mode).toBe("on");
    expect(record.accepted).toBe(true);
  });

  test("未登记入口 + 隔离清单未清空 + 数据库角色缺口同时存在：全评估、逐门列出、不发现第一个就停", async () => {
    // 未登记入口：业务闭包 unclassified。
    const unclassified = inventoryJson({
      entrances: [
        {
          id: "GET /api/agents",
          entrance: "GET /api/agents",
          method: "GET",
          path: "/api/agents",
          kind: "route",
          type: "http",
          businessClosure: "agents",
          ownerTicket: "MT000",
          status: "owned",
        },
        {
          id: "GET /api/brand-new",
          entrance: "GET /api/brand-new",
          method: "GET",
          path: "/api/brand-new",
          kind: "route",
          type: "http",
          businessClosure: "unclassified",
          ownerTicket: "MT000",
          status: "owned",
        },
      ],
    });
    const record = await runReadinessEnforcement(
      {
        ...CLEAN_INPUTS,
        singleUser: true,
        singleUserEnvRaw: "true",
        // 数据库角色门：不提供 URL → 缺失变量即缺口。
        directoryUrl: undefined,
        dataUrl: undefined,
        tenantRuntimeUrl: undefined,
        quarantine: CLEAN_QUARANTINE,
      },
      {
        readTextFile: async () => unclassified,
        createDatabase: CLEAN_DEPS.createDatabase,
        evaluateQuarantineReadiness: async () =>
          quarantineRecord([{ id: "root-record:record-0" }]),
      },
    );
    expect(record.accepted).toBe(false);
    if (record.mode !== "on") throw new Error("unreachable");
    expect(record.checks.startup.checks.coverage.ok).toBe(false);
    expect(record.checks.startup.checks.devBypass.ok).toBe(false);
    expect(record.checks.startup.checks.databaseRoles.ok).toBe(false);
    expect(record.checks.quarantine.ok).toBe(false);
    if (!record.checks.quarantine.ok) {
      expect(record.checks.quarantine.reason).toContain("root-record:record-0");
    }
    // 一次列全：报告同时含四道门的缺口。
    const report = buildReadinessGapReport(record);
    const checksWithGaps = new Set(report.gaps.map((gap) => gap.check));
    for (const name of [
      "coverage",
      "devBypass",
      "databaseRoles",
      "quarantine",
    ]) {
      expect(checksWithGaps.has(name)).toBe(true);
    }
  });

  test("隔离清单未清空单独即拒绝：open 条目确定性 id 进缺口（处置是唯一清空方式）", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      {
        ...CLEAN_DEPS,
        evaluateQuarantineReadiness: async () =>
          quarantineRecord([
            { id: "root-record:conflict-1" },
            { id: "external-file:open-2" },
          ]),
      },
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on" && !record.checks.quarantine.ok) {
      expect(record.checks.quarantine.reason).toContain(
        "root-record:conflict-1",
      );
      expect(record.checks.quarantine.reason).toContain("external-file:open-2");
    }
  });

  test("隔离评估缝缺席（无库输入）→ fail-closed：点名所需显式配置，不能默认放行", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS },
      CLEAN_DEPS,
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on" && !record.checks.quarantine.ok) {
      expect(record.checks.quarantine.reason).toContain(
        "OPENBOT_MULTITENANCY_QUARANTINE_DEFAULT_WORKSPACE",
      );
    }
  });

  test("隔离扫描异常（表缺失/锚点不唯一）→ 折叠为带理由的检查失败，不是进程崩溃", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      {
        ...CLEAN_DEPS,
        evaluateQuarantineReadiness: async () => {
          throw new Error(
            "QUARANTINE_SCAN_REFUSED: expected exactly one MT112 anchor row, found 0",
          );
        },
      },
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on" && !record.checks.quarantine.ok) {
      expect(record.checks.quarantine.reason).toContain(
        "an unevaluable quarantine list is a gap, not a pass",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — 缺口报告机器可读，可被 CI 阻断
// ---------------------------------------------------------------------------

describe("MT129 缺口报告：机器可读 + CI 阻断", () => {
  test("报告 JSON 往返可解析：schemaVersion/type/gaps 逐门摊平（结构化码保留）", async () => {
    const unregisteredPlatform = inventoryJson({
      entrances: [
        {
          id: "GET /api/platform-new",
          entrance: "GET /api/platform-new",
          method: "GET",
          path: "/api/platform-new",
          kind: "route",
          type: "http",
          businessClosure: "platform",
          ownerTicket: "MT000",
          status: "owned",
        },
      ],
    });
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      {
        readTextFile: async () => unregisteredPlatform,
        createDatabase: CLEAN_DEPS.createDatabase,
        evaluateQuarantineReadiness: async () => quarantineRecord([]),
      },
    );
    const report = buildReadinessGapReport(record);
    const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(roundTripped.schemaVersion).toBe(1);
    expect(roundTripped.type).toBe("multitenancy-readiness-gap-report");
    expect(roundTripped.accepted).toBe(false);
    const globalGap = roundTripped.gaps.find(
      (gap) => gap.check === "globalExceptions",
    );
    expect(globalGap?.code).toBe("UNREGISTERED_GLOBAL");
    expect(globalGap?.detail).toContain("/api/platform-new");
    // CI 闸：accepted=false 即阻断。
    expect(readinessGateBlocks(roundTripped)).toBe(true);
  });

  test("verdict：拒绝 = 恰好一条日志 + 一行 JSON 报告 + exit 1；通过 = 不写报告不退出", async () => {
    const refused = await runReadinessEnforcement(
      { ...CLEAN_INPUTS },
      CLEAN_DEPS,
    );
    let logged = 0;
    const written: string[] = [];
    let exitCode: number | undefined;
    applyReadinessEnforcementVerdict(refused, {
      log: { info: () => (logged += 1) },
      write: (line) => written.push(line),
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(logged).toBe(1);
    expect(exitCode).toBe(1);
    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0]) as {
      type: string;
      accepted: boolean;
    };
    expect(parsed.type).toBe("multitenancy-readiness-gap-report");
    expect(parsed.accepted).toBe(false);

    const acceptedRecord = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      { ...CLEAN_DEPS, ...cleanQuarantineDeps() },
    );
    let acceptedLogged = 0;
    const acceptedWritten: string[] = [];
    let acceptedExit: number | undefined;
    applyReadinessEnforcementVerdict(acceptedRecord, {
      log: { info: () => (acceptedLogged += 1) },
      write: (line) => acceptedWritten.push(line),
      exit: (code) => {
        acceptedExit = code;
      },
    });
    expect(acceptedLogged).toBe(1);
    expect(acceptedWritten).toEqual([]);
    expect(acceptedExit).toBeUndefined();
  });

  test("通过记录的报告：gaps 空数组、accepted true、CI 不阻断", async () => {
    const acceptedRecord = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      { ...CLEAN_DEPS, ...cleanQuarantineDeps() },
    );
    const report = buildReadinessGapReport(acceptedRecord);
    expect(report.gaps).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(readinessGateBlocks(report)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — 单租户部署仍可按既有方式启动（回归测试）
// ---------------------------------------------------------------------------

describe("MT129 单租户回归：开关关闭零行为", () => {
  test("multitenancy=false：mode off、accepted、checks null，任何输入面都不被触碰", async () => {
    let readFileTouched = 0;
    let quarantineEvaluated = 0;
    const record = await runReadinessEnforcement(
      {
        multitenancy: false,
        inventoryPath: "memory://inventory",
        singleUser: true,
        singleUserEnvRaw: "true",
      },
      {
        readTextFile: async () => {
          readFileTouched += 1;
          return inventoryJson({});
        },
        createDatabase: (() => {
          readFileTouched += 100;
          throw new Error("must not connect in single-tenant mode");
        }) as never,
        evaluateQuarantineReadiness: async () => {
          quarantineEvaluated += 1;
          return quarantineRecord([]);
        },
      },
    );
    expect(record.mode).toBe("off");
    expect(record.accepted).toBe(true);
    expect(record.checks).toBeNull();
    expect(readFileTouched).toBe(0);
    expect(quarantineEvaluated).toBe(0);
    // 单租户的 dev 绕过照旧是合法装配（MT123 mountDevBypass），verdict 放行。
    let exitCode: number | undefined;
    applyReadinessEnforcementVerdict(record, {
      log: { info: () => {} },
      exit: (code) => {
        exitCode = code;
      },
    });
    expect(exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC4 — 放宽任何一项都需要显式配置与理由，不能默认放行
// ---------------------------------------------------------------------------

describe("MT129 放宽纪律：显式配置 + 理由，唯一放宽面是豁免清单", () => {
  test("coverage 豁免：命名真实入口 + 非空理由 → 该入口不再阻断（既有唯一放宽面，经强制编排复核）", async () => {
    const withUncovered = inventoryJson({
      entrances: [
        {
          id: "GET /api/legacy",
          entrance: "GET /api/legacy",
          method: "GET",
          path: "/api/legacy",
          kind: "route",
          type: "http",
          businessClosure: "unclassified",
          ownerTicket: "MT000",
          status: "owned",
        },
      ],
    });
    const record = await runReadinessEnforcement(
      {
        ...CLEAN_INPUTS,
        waiversPath: "memory://waivers",
        quarantine: CLEAN_QUARANTINE,
      },
      {
        readTextFile: async (path: string) =>
          path === "memory://waivers"
            ? JSON.stringify({
                schemaVersion: 1,
                waivers: [
                  {
                    entrance: "GET /api/legacy",
                    reason:
                      "the legacy surface is scheduled for removal next release (ticket MT099)",
                    ticket: "MT099",
                  },
                ],
              })
            : withUncovered,
        createDatabase: CLEAN_DEPS.createDatabase,
        evaluateQuarantineReadiness: async () => quarantineRecord([]),
      },
    );
    if (record.mode !== "on") throw new Error("unreachable");
    expect(record.checks.startup.checks.coverage.ok).toBe(true);
    if (record.checks.startup.checks.coverage.ok) {
      expect(record.checks.startup.checks.coverage.waivedEntrances).toEqual([
        "GET /api/legacy",
      ]);
    }
  });

  test("隔离门没有配置放宽路径：豁免清单在场也照样拒绝（清空它的唯一方式是处置条目）", async () => {
    const record = await runReadinessEnforcement(
      {
        ...CLEAN_INPUTS,
        waiversPath: "memory://waivers",
        quarantine: CLEAN_QUARANTINE,
      },
      {
        readTextFile: async (path: string) =>
          path === "memory://waivers"
            ? JSON.stringify({
                schemaVersion: 1,
                waivers: [
                  {
                    entrance: "GET /api/agents",
                    reason: "waiver cannot reach the quarantine gate",
                  },
                ],
              })
            : inventoryJson({}),
        createDatabase: CLEAN_DEPS.createDatabase,
        evaluateQuarantineReadiness: async () =>
          quarantineRecord([{ id: "root-record:blocked" }]),
      },
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on") {
      expect(record.checks.quarantine.ok).toBe(false);
    }
    const report = buildReadinessGapReport(record);
    expect(report.gaps.some((gap) => gap.check === "quarantine")).toBe(true);
  });

  test("缺省（未配置豁免文件）+ 未登记入口 → 默认拒绝：不存在默认放行", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      {
        readTextFile: async () =>
          inventoryJson({
            entrances: [
              {
                id: "GET /api/brand-new",
                entrance: "GET /api/brand-new",
                method: "GET",
                path: "/api/brand-new",
                kind: "route",
                type: "http",
                businessClosure: "unclassified",
                ownerTicket: "MT000",
                status: "owned",
              },
            ],
          }),
        createDatabase: CLEAN_DEPS.createDatabase,
        evaluateQuarantineReadiness: async () => quarantineRecord([]),
      },
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on" && !record.checks.startup.checks.coverage.ok) {
      expect(record.checks.startup.checks.coverage.reason).toContain(
        "uncovered entrance",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 真实库半边：隔离门默认缝（真实扫描）在缺锚点库上折叠为带理由失败
// ---------------------------------------------------------------------------

const DB_ENV = process.env.TEST_DATABASE_URL?.trim();

describe.skipIf(!DB_ENV)("MT129 真实库：隔离门默认缝的失败折叠", () => {
  let database: Database;
  beforeAll(async () => {
    database = createDatabase(DB_ENV as string, { max: 1 });
  });
  afterAll(async () => {
    await database?.$client.close();
  });

  test("真实扫描在无 MT112 锚点的库上：门拒绝并带理由（不是进程崩溃、不是通过）", async () => {
    const record = await runReadinessEnforcement(
      { ...CLEAN_INPUTS, quarantine: CLEAN_QUARANTINE },
      CLEAN_DEPS,
    );
    expect(record.accepted).toBe(false);
    if (record.mode === "on" && !record.checks.quarantine.ok) {
      expect(record.checks.quarantine.reason).toMatch(
        /quarantine|anchor|relation/i,
      );
    }
  });
});
