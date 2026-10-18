/**
 * MT013（Issue #57）：多租户模式显式开关与启动校验。
 *
 * 被测契约（docs/plans/2026-10-15-company-team-multitenancy-execution/briefs/MT013-brief.md）：
 *
 *   1. 显式开关 OPENBOT_MULTITENANCY 默认关闭；关闭时行为与现状逐字一致。
 *   2. 开启时启动校验三项，任何一项失败 → 拒绝启动（exit 非 0，不是警告继续）：
 *      a. 入口覆盖清单完整（消费 MT001 CoverageInventory 契约；允许显式豁免但要留痕）；
 *      b. 无单用户/开发绕过残留（OPENBOT_SINGLE_USER / OPENBOT_DEV_NO_AUTH 面）；
 *      c. 数据库角色安全（ob_ent_directory / ob_ent_data 在生产 URL 下的只读探测）。
 *   3. 开关状态与校验结果在启动日志中可审计（一条结构化记录）。
 *
 * 测试分层：
 *   - 纯单元：三个 evaluator + 编排器 + verdict，全部注入假 inventory / bypass 事实 /
 *     角色探测状态（三拒绝路径 + 通过路径），不触网不触库；
 *   - 真实库：专用 pgvector/pg16（与 MT002/MT005 同一 env 约定）上跑只读探测的
 *     通过与拒绝路径；缺 env 显式 skip（带理由），绝不静默回退。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { CoverageInventory } from "../../scripts/multitenancy/inventory";
import { createDatabase } from "../../src/db/client";
import {
  applyStartupVerdict,
  type CoverageWaiver,
  type DevBypassFacts,
  evaluateDevBypassResidue,
  evaluateInventoryCoverage,
  evaluateRoleSafety,
  type MultitenancyStartupRecord,
  parseWaiverFile,
  probeRoleSafety,
  type RoleSafetyProbe,
  runMultitenancyStartupChecks,
} from "../../src/enterprise/tenancy/startup-checks";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

// ---------------------------------------------------------------------------
// 测试脚手架：按 MT001 契约手造的最小 CoverageInventory
// ---------------------------------------------------------------------------

let sequence = 0;

function entrance(
  overrides: Partial<CoverageInventory["entrances"][number]> = {},
): CoverageInventory["entrances"][number] {
  sequence += 1;
  const id = overrides.id ?? `GET /api/test-${sequence}`;
  return {
    id,
    entrance: id,
    method: "GET",
    path: `/api/test-${sequence}`,
    kind: "route",
    type: "http",
    businessClosure: "agents",
    ownerTicket: "MT000",
    status: "owned",
    registration: "always",
    registeredIn: ["deployment-full"],
    registrations: 1,
    ...overrides,
  };
}

function inventory(
  overrides: Partial<CoverageInventory> = {},
): CoverageInventory {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-16T00:00:00.000Z",
    digest: "a".repeat(64),
    assemblies: [
      {
        name: "deployment-full",
        entrance: "src/index.ts",
        status: "assembled",
        routeEntries: 1,
      },
    ],
    entrances: [entrance()],
    backgroundPrograms: [],
    serviceSurfaces: [],
    dataTables: [],
    externalDependencies: [],
    unmappedConfigKeys: [],
    stages: [],
    summary: {
      totalEntrances: 1,
      routeEntrances: 1,
      catchallEntrances: 0,
      unownedEntrances: 0,
      unclassifiedEntrances: 0,
      serveUpgradeBranches: 2,
      serveUpgradeEntrances: 2,
      dataTables: 0,
      backgroundPrograms: 0,
      serviceSurfaces: 0,
      externalDependencies: 0,
      byClosure: { agents: { total: 1, unowned: 0 } },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 覆盖校验（拒绝路径 a）
// ---------------------------------------------------------------------------

describe("MT013 coverage check（消费 MT001 CoverageInventory 契约）", () => {
  test("完整清单（全部 owned/已分类、装配成功、serve 平衡）→ 通过", () => {
    const outcome = evaluateInventoryCoverage(inventory(), []);
    expect(outcome.ok).toBe(true);
  });

  test("存在 unowned 入口 → 拒绝并列出未覆盖入口", () => {
    const bad = inventory({
      entrances: [entrance({ status: "unowned", ownerTicket: null })],
    });
    bad.summary.unownedEntrances = 1;
    const outcome = evaluateInventoryCoverage(bad, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.uncovered).toHaveLength(1);
      expect(outcome.uncovered[0].reason).toBe("unowned");
      expect(outcome.reason).toContain("uncovered");
    }
  });

  test("存在 unclassified 入口 → 拒绝（未分类阻断统一上线）", () => {
    const bad = inventory({
      entrances: [entrance({ businessClosure: "unclassified" })],
    });
    bad.summary.unclassifiedEntrances = 1;
    const outcome = evaluateInventoryCoverage(bad, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.uncovered[0].reason).toBe("unclassified");
    }
  });

  test("任一装配 failed → 拒绝", () => {
    const bad = inventory({
      assemblies: [
        {
          name: "enterprise",
          entrance: "src/enterprise/conversations",
          status: "failed",
          routeEntries: 0,
        },
      ],
    });
    const outcome = evaluateInventoryCoverage(bad, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("enterprise");
  });

  test("serve() 升级分支多于已登记 stream 入口 → 拒绝", () => {
    const bad = inventory();
    bad.summary.serveUpgradeBranches = 3;
    const outcome = evaluateInventoryCoverage(bad, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("serve()");
  });

  test("schemaVersion 非 1 → 拒绝（契约漂移不许静默消费）", () => {
    const bad = inventory({ schemaVersion: 2 as never });
    const outcome = evaluateInventoryCoverage(bad, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("schemaVersion");
  });

  test("显式豁免（带理由）→ 对应入口不再阻断，且豁免留痕", () => {
    const withGap = inventory({
      entrances: [
        entrance({
          id: "GET /api/legacy",
          status: "unowned",
          ownerTicket: null,
        }),
      ],
    });
    withGap.summary.unownedEntrances = 1;
    const waivers: readonly CoverageWaiver[] = [
      {
        entrance: "GET /api/legacy",
        reason: "legacy read-only surface",
        ticket: "MT099",
      },
    ];
    const outcome = evaluateInventoryCoverage(withGap, waivers);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.waivedEntrances).toEqual(["GET /api/legacy"]);
    }
  });

  test("豁免了不存在的入口 → 拒绝（typo 防护，不许静默吞掉）", () => {
    const waivers: readonly CoverageWaiver[] = [
      { entrance: "GET /api/typo", reason: "does not exist" },
    ];
    const outcome = evaluateInventoryCoverage(inventory(), waivers);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("GET /api/typo");
  });

  test("豁免缺理由 → 拒绝（留痕要求）", () => {
    const withGap = inventory({
      entrances: [
        entrance({
          id: "GET /api/legacy",
          status: "unowned",
          ownerTicket: null,
        }),
      ],
    });
    const waivers: readonly CoverageWaiver[] = [
      { entrance: "GET /api/legacy", reason: "" },
    ];
    const outcome = evaluateInventoryCoverage(withGap, waivers);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("reason");
  });

  test("豁免只豁免列出的入口，其余 unowned 仍阻断", () => {
    const withGaps = inventory({
      entrances: [
        entrance({
          id: "GET /api/waived",
          status: "unowned",
          ownerTicket: null,
        }),
        entrance({
          id: "GET /api/blocked",
          status: "unowned",
          ownerTicket: null,
        }),
      ],
    });
    withGaps.summary.unownedEntrances = 2;
    const outcome = evaluateInventoryCoverage(withGaps, [
      { entrance: "GET /api/waived", reason: "accepted" },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.uncovered.map((entry) => entry.id)).toEqual([
        "GET /api/blocked",
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 豁免清单文件解析（F3：输入硬化）——损坏/形状不对的文件响亮拒绝，
// 拒绝消息里永远不出现 "undefined"。
// ---------------------------------------------------------------------------

describe("MT013 parseWaiverFile（豁免文件输入硬化）", () => {
  test("非 JSON 内容 → TypeError 带 invalid JSON 理由", () => {
    expect(() => parseWaiverFile("not json at all")).toThrow(TypeError);
    expect(() => parseWaiverFile("not json at all")).toThrow(
      /coverage waiver file is not valid JSON/,
    );
  });

  test("顶层不是对象 / waivers 不是数组 → TypeError 带形状说明", () => {
    expect(() => parseWaiverFile("[]")).toThrow(TypeError);
    expect(() => parseWaiverFile('{"schemaVersion":1,"waivers":{}}')).toThrow(
      /coverage waiver file must be/,
    );
  });

  test("schemaVersion 非 1 → TypeError（与 inventory 侧严格拒绝对称）", () => {
    expect(() => parseWaiverFile('{"schemaVersion":2,"waivers":[]}')).toThrow(
      /schemaVersion 2, expected 1/,
    );
    expect(() =>
      parseWaiverFile('{"waivers":[{"entrance":"GET /a","reason":"r"}]}'),
    ).toThrow(/schemaVersion/);
  });

  test("数组元素非对象 → TypeError 带元素索引与类型，消息不含 undefined", () => {
    let message = "";
    try {
      parseWaiverFile('{"schemaVersion":1,"waivers":["GET /x"]}');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("waivers[0]");
    expect(message).toContain("string");
    expect(message).not.toContain("undefined");

    try {
      parseWaiverFile('{"schemaVersion":1,"waivers":[{}, null, []]}');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("waivers[1]");
    expect(message).toContain("null");
    expect(message).not.toContain("undefined");
  });

  test("合法文件 → 返回豁免数组（guard：硬化不误伤正路）", () => {
    const waivers = parseWaiverFile(
      '{"schemaVersion":1,"waivers":[{"entrance":"GET /a","reason":"legacy","ticket":"MT099"}]}',
    );
    expect(waivers).toHaveLength(1);
    expect(waivers[0]?.entrance).toBe("GET /a");
  });
});

// ---------------------------------------------------------------------------
// 单用户/开发绕过残留（拒绝路径 b）
// ---------------------------------------------------------------------------

describe("MT013 dev-bypass residue check", () => {
  test("singleUser=true（OPENBOT_SINGLE_USER=true 的结果）→ 拒绝", () => {
    const facts: DevBypassFacts = {
      singleUser: true,
      singleUserEnvRaw: "true",
    };
    const outcome = evaluateDevBypassResidue(facts);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.findings.length).toBeGreaterThan(0);
      expect(JSON.stringify(outcome.findings)).toContain("OPENBOT_SINGLE_USER");
    }
  });

  test("遗留名 OPENBOT_DEV_NO_AUTH=true 同样是残留", () => {
    const facts: DevBypassFacts = {
      singleUser: true,
      devNoAuthEnvRaw: "true",
    };
    const outcome = evaluateDevBypassResidue(facts);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(JSON.stringify(outcome.findings)).toContain("OPENBOT_DEV_NO_AUTH");
    }
  });

  test("变量被设成垃圾值（被 singleUserEnabled 静默忽略的那种）→ 仍判残留", () => {
    const outcome = evaluateDevBypassResidue({
      singleUser: false,
      singleUserEnvRaw: "maybe",
    });
    expect(outcome.ok).toBe(false);
  });

  test("显式关闭（false/0）或未设置 → 通过", () => {
    for (const singleUserEnvRaw of [undefined, "false", "0", ""]) {
      const outcome = evaluateDevBypassResidue({
        singleUser: false,
        singleUserEnvRaw,
        devNoAuthEnvRaw: undefined,
      });
      expect(outcome.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 数据库角色安全（拒绝路径 c）——纯 evaluator 用注入探测结果
// ---------------------------------------------------------------------------

describe("MT013 role-safety evaluation（注入探测结果）", () => {
  const safeProbe = (expectedRole: string): RoleSafetyProbe => ({
    expectedRole,
    connected: true,
    roleExists: true,
    capabilityAttributesSafe: true,
    loginAttributesSafe: true,
    loginHasCapability: true,
    loginHasNoOtherMemberships: true,
  });

  test("directory 与 data 两个连接都安全 → 通过", () => {
    const outcome = evaluateRoleSafety([
      safeProbe("ob_ent_directory"),
      safeProbe("ob_ent_data"),
    ]);
    expect(outcome.ok).toBe(true);
  });

  test("capability 角色缺失 → 拒绝", () => {
    const outcome = evaluateRoleSafety([
      { ...safeProbe("ob_ent_directory"), roleExists: false },
      safeProbe("ob_ent_data"),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("ob_ent_directory");
  });

  test("capability 角色带特权属性（SUPER/BYPASSRLS/CREATEDB…）→ 拒绝", () => {
    for (const attribute of [
      "capabilityAttributesSafe",
      "loginAttributesSafe",
    ] as const) {
      const outcome = evaluateRoleSafety([
        safeProbe("ob_ent_directory"),
        { ...safeProbe("ob_ent_data"), [attribute]: false },
      ]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("ob_ent_data");
    }
  });

  test("login 未获 capability 成员资格 → 拒绝", () => {
    const outcome = evaluateRoleSafety([
      { ...safeProbe("ob_ent_directory"), loginHasCapability: false },
      safeProbe("ob_ent_data"),
    ]);
    expect(outcome.ok).toBe(false);
  });

  test("login 有第二个角色成员资格（可提权）→ 拒绝", () => {
    const outcome = evaluateRoleSafety([
      { ...safeProbe("ob_ent_directory"), loginHasNoOtherMemberships: false },
      safeProbe("ob_ent_data"),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("ob_ent_directory");
  });

  test("连接失败 → 拒绝且带失败原因", () => {
    const outcome = evaluateRoleSafety([
      {
        expectedRole: "ob_ent_directory",
        connected: false,
        failure: "ECONNREFUSED",
      },
      safeProbe("ob_ent_data"),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("ECONNREFUSED");
    }
  });
});

// ---------------------------------------------------------------------------
// 编排器：注入假 IO（文件与数据库工厂），三拒绝路径 + 通过路径
// ---------------------------------------------------------------------------

function fakeDatabase(rows: Record<string, unknown>[]): Database {
  return {
    execute: async () => rows,
    $client: { close: async () => {} },
  } as unknown as Database;
}

function safeCapabilityRow(role: string): Record<string, unknown> {
  return {
    role_exists: true,
    capability_attributes_safe: true,
    login_attributes_safe: true,
    login_has_capability: true,
    login_has_no_other_memberships: true,
    expected_role: role,
  };
}

describe("MT013 startup validation orchestrator（注入假 inventory/角色状态）", () => {
  const inventoryJson = JSON.stringify(inventory());
  const okDeps = () => ({
    readTextFile: async (path: string) =>
      path.endsWith("inventory.json")
        ? inventoryJson
        : JSON.stringify({ schemaVersion: 1, waivers: [] }),
    createDatabase: (url: string) =>
      fakeDatabase([
        safeCapabilityRow(
          url.includes("directory") ? "ob_ent_directory" : "ob_ent_data",
        ),
      ]),
    environment: {},
  });
  const inputs = {
    inventoryPath: "/cfg/inventory.json",
    directoryUrl: "postgres://ent_dir@127.0.0.1:5432/ent",
    dataUrl: "postgres://ent_data@127.0.0.1:5432/ent",
    tenantRuntimeUrl: "postgres://tenant@127.0.0.1:5432/ent",
    singleUser: false,
  };

  test("三项全部通过 → accepted 记录，一条结构化形状", async () => {
    const record = await runMultitenancyStartupChecks(inputs, okDeps());
    expect(record.type).toBe("multitenancy-startup-validation");
    expect(record.mode).toBe("on");
    expect(record.accepted).toBe(true);
    expect(record.checks.coverage.ok).toBe(true);
    expect(record.checks.devBypass.ok).toBe(true);
    expect(record.checks.databaseRoles.ok).toBe(true);
    expect(record.timestamp).toBeTruthy();
  });

  test("拒绝路径 a：inventory 文件缺失 → 拒绝且 coverage 带理由，其余检查照常完成", async () => {
    const deps = okDeps();
    deps.readTextFile = async (path: string) => {
      if (path.endsWith("inventory.json"))
        throw new Error("ENOENT: no such file");
      return JSON.stringify({ schemaVersion: 1, waivers: [] });
    };
    const record = await runMultitenancyStartupChecks(inputs, deps);
    expect(record.accepted).toBe(false);
    expect(record.checks.coverage.ok).toBe(false);
    if (!record.checks.coverage.ok) {
      expect(record.checks.coverage.reason).toContain("inventory");
      // 拒绝记录同样要留豁免痕：审计的是“当时生效的豁免 + 剩余缺口”两部分。
      expect(record.checks.coverage.waivedEntrances).toEqual([]);
    }
    // 其余两项不受影响地完成评估（拒绝要指名全部缺口，而非第一个就停）。
    expect(record.checks.devBypass.ok).toBe(true);
    expect(record.checks.databaseRoles.ok).toBe(true);
  });

  test("拒绝路径 b：singleUser 残留 → 拒绝", async () => {
    const record = await runMultitenancyStartupChecks(
      { ...inputs, singleUser: true, singleUserEnvRaw: "true" },
      okDeps(),
    );
    expect(record.accepted).toBe(false);
    expect(record.checks.devBypass.ok).toBe(false);
  });

  test("拒绝路径 c：数据库 URL 缺失 → 拒绝且指名缺的变量", async () => {
    const record = await runMultitenancyStartupChecks(
      { ...inputs, dataUrl: undefined },
      okDeps(),
    );
    expect(record.accepted).toBe(false);
    expect(record.checks.databaseRoles.ok).toBe(false);
    if (!record.checks.databaseRoles.ok) {
      expect(record.checks.databaseRoles.reason).toContain(
        "ENTERPRISE_DATA_DATABASE_URL",
      );
    }
  });

  test("拒绝路径 c：探测返回不安全角色 → 拒绝", async () => {
    const deps = okDeps();
    deps.createDatabase = () =>
      fakeDatabase([
        {
          role_exists: true,
          capability_attributes_safe: true,
          login_attributes_safe: false,
          login_has_capability: true,
          login_has_no_other_memberships: false,
          expected_role: "ob_ent_data",
        },
      ]);
    const record = await runMultitenancyStartupChecks(inputs, deps);
    expect(record.accepted).toBe(false);
    expect(record.checks.databaseRoles.ok).toBe(false);
  });

  test("inventory JSON 损坏 → 拒绝（不许静默当作通过）", async () => {
    const deps = okDeps();
    deps.readTextFile = async (path: string) =>
      path.endsWith("inventory.json") ? "{not json" : "{}";
    const record = await runMultitenancyStartupChecks(inputs, deps);
    expect(record.accepted).toBe(false);
    expect(record.checks.coverage.ok).toBe(false);
  });

  // F1：waivers 的文件层失败必须被 containment 捕获降级为结构化拒绝，
  // 绝不穿透模块边界炸进程（复审 cw/mw 变体置实证：裸栈 + 零审计记录）。
  test("拒绝路径 a：waivers 文件损坏 → 不 reject，coverage ok:false 带理由，三校验照常评估", async () => {
    const deps = okDeps();
    deps.readTextFile = async (path: string) =>
      path.endsWith("inventory.json") ? inventoryJson : "not json at all";
    const record = await runMultitenancyStartupChecks(
      { ...inputs, waiversPath: "/cfg/waivers.json" },
      deps,
    );
    // 恰好一条结构化记录（verdict 侧消费的就是它），而不是进程栈。
    expect(record.type).toBe("multitenancy-startup-validation");
    expect(record.accepted).toBe(false);
    expect(record.checks.coverage.ok).toBe(false);
    if (!record.checks.coverage.ok) {
      expect(record.checks.coverage.reason).toContain("waiver");
      expect(record.checks.coverage.reason).toContain("not valid JSON");
      expect(record.checks.coverage.waivedEntrances).toEqual([]);
    }
    // 其余两项不受影响地完成评估（拒绝要列全缺口，而非第一个就停）。
    expect(record.checks.devBypass.ok).toBe(true);
    expect(record.checks.databaseRoles.ok).toBe(true);
    // verdict 消费该记录：恰好一条日志 + exit(1)，不向上炸进程。
    const logged: unknown[] = [];
    let exitCode: number | undefined;
    applyStartupVerdict(record, {
      log: { info: (r: unknown) => logged.push(r) },
      exit: (code: number) => {
        exitCode = code;
      },
    });
    expect(logged).toHaveLength(1);
    expect(exitCode).toBe(1);
  });

  test("拒绝路径 a：waivers 文件缺失（ENOENT）→ 不 reject，coverage ok:false 带理由", async () => {
    const deps = okDeps();
    deps.readTextFile = async (path: string) => {
      if (path.endsWith("waivers.json"))
        throw new Error("ENOENT: no such file or directory");
      return inventoryJson;
    };
    const record = await runMultitenancyStartupChecks(
      { ...inputs, waiversPath: "/cfg/waivers.json" },
      deps,
    );
    expect(record.accepted).toBe(false);
    expect(record.checks.coverage.ok).toBe(false);
    if (!record.checks.coverage.ok) {
      expect(record.checks.coverage.reason).toContain("waiver");
      expect(record.checks.coverage.reason).toContain("ENOENT");
    }
    expect(record.checks.devBypass.ok).toBe(true);
    expect(record.checks.databaseRoles.ok).toBe(true);
  });

  // F1 同族：createDatabase 同步抛出（畸形 URL 等）同样不许穿透模块边界。
  test("拒绝路径 c：createDatabase 同步抛出 → 不 reject，databaseRoles ok:false 带角色与原因", async () => {
    const deps = okDeps();
    deps.createDatabase = (url: string) => {
      if (url === inputs.directoryUrl)
        throw new Error("malformed connection string");
      return fakeDatabase([safeCapabilityRow("ob_ent_data")]);
    };
    const record = await runMultitenancyStartupChecks(inputs, deps);
    expect(record.accepted).toBe(false);
    expect(record.checks.coverage.ok).toBe(true);
    expect(record.checks.devBypass.ok).toBe(true);
    expect(record.checks.databaseRoles.ok).toBe(false);
    if (!record.checks.databaseRoles.ok) {
      expect(record.checks.databaseRoles.reason).toContain("ob_ent_directory");
      expect(record.checks.databaseRoles.reason).toContain(
        "malformed connection string",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// verdict：可审计结构化日志 + 拒绝时非 0 退出
// ---------------------------------------------------------------------------

describe("MT013 startup verdict（审计日志与拒绝启动）", () => {
  let logged: unknown[] = [];
  let exitCode: number | undefined;

  beforeEach(() => {
    logged = [];
    exitCode = undefined;
  });

  const hooks = () => ({
    log: {
      info: (record: unknown, message: string) => {
        logged.push({ record, message });
      },
    },
    exit: (code: number) => {
      exitCode = code;
    },
  });

  test("accepted → 恰好一条结构化记录，不退出", () => {
    const record = {
      type: "multitenancy-startup-validation",
      mode: "on",
      accepted: true,
      timestamp: "2026-10-16T00:00:00.000Z",
      checks: {},
    } as unknown as MultitenancyStartupRecord;
    const h = hooks();
    applyStartupVerdict(record, h);
    expect(logged).toHaveLength(1);
    expect(exitCode).toBeUndefined();
    const entry = logged[0] as { record: MultitenancyStartupRecord };
    expect(entry.record.accepted).toBe(true);
  });

  test("refused → 同一条记录留痕后 exit(1)", () => {
    const record = {
      type: "multitenancy-startup-validation",
      mode: "on",
      accepted: false,
      timestamp: "2026-10-16T00:00:00.000Z",
      checks: {},
    } as unknown as MultitenancyStartupRecord;
    const h = hooks();
    applyStartupVerdict(record, h);
    expect(logged).toHaveLength(1);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 真实库探测：专用 pgvector/pg16（env 同 MT002/MT005），缺 env 显式 skip
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT013 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data"] as const) {
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
const describeDb = ENV.ok ? describe : describe.skip;

describeDb("MT013 role-safety probe（真实专用库）", () => {
  test("目录角色连接：ob_ent_directory 形态符合预期（NOLOGIN 能力 + 单一成员资格）", async () => {
    const database = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("directory", process.env),
      { max: 1 },
    );
    try {
      const probe = await probeRoleSafety(database, "ob_ent_directory");
      expect(probe.connected).toBe(true);
      expect(probe.roleExists).toBe(true);
      expect(probe.capabilityAttributesSafe).toBe(true);
      expect(probe.loginAttributesSafe).toBe(true);
      expect(probe.loginHasCapability).toBe(true);
      expect(probe.loginHasNoOtherMemberships).toBe(true);
      expect(evaluateRoleSafety([probe]).ok).toBe(true);
    } finally {
      await database.$client.close();
    }
  });

  test("数据角色连接：ob_ent_data 形态符合预期", async () => {
    const database = createDatabase(
      enterpriseRuntimeDatabaseUrlFrom("data", process.env),
      { max: 1 },
    );
    try {
      const probe = await probeRoleSafety(database, "ob_ent_data");
      expect(evaluateRoleSafety([probe]).ok).toBe(true);
    } finally {
      await database.$client.close();
    }
  });

  test("超级用户 setup 连接冒充运行时 URL → 角色安全校验拒绝（拒绝路径 c 的真实库版）", async () => {
    const database = createDatabase(
      enterpriseTestDatabaseUrlFrom(process.env),
      { max: 1 },
    );
    try {
      const probe = await probeRoleSafety(database, "ob_ent_data");
      // setup 连接是超级用户：login 特权面必然不安全，这正是要在生产拦下的形态。
      expect(evaluateRoleSafety([probe]).ok).toBe(false);
    } finally {
      await database.$client.close();
    }
  });

  test("编排器（真实库 + 真 inventory 工件）→ 通过路径端到端", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mt013-inv-"));
    try {
      const inventoryPath = join(dir, "inventory.json");
      await writeFile(inventoryPath, JSON.stringify(inventory()));
      const record = await runMultitenancyStartupChecks({
        inventoryPath,
        directoryUrl: enterpriseRuntimeDatabaseUrlFrom(
          "directory",
          process.env,
        ),
        dataUrl: enterpriseRuntimeDatabaseUrlFrom("data", process.env),
        tenantRuntimeUrl: enterpriseTestDatabaseUrlFrom(process.env),
        singleUser: false,
      });
      expect(record.accepted).toBe(true);
      expect(record.checks.databaseRoles.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("编排器（真实库 + 带 unowned 入口的 inventory）→ 拒绝记录端到端", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mt013-inv-"));
    try {
      const inventoryPath = join(dir, "inventory.json");
      const withGap = inventory({
        entrances: [
          entrance({
            id: "GET /api/gap",
            status: "unowned",
            ownerTicket: null,
          }),
        ],
      });
      withGap.summary.unownedEntrances = 1;
      await writeFile(inventoryPath, JSON.stringify(withGap));
      const record = await runMultitenancyStartupChecks({
        inventoryPath,
        directoryUrl: enterpriseRuntimeDatabaseUrlFrom(
          "directory",
          process.env,
        ),
        dataUrl: enterpriseRuntimeDatabaseUrlFrom("data", process.env),
        tenantRuntimeUrl: enterpriseTestDatabaseUrlFrom(process.env),
        singleUser: false,
      });
      expect(record.accepted).toBe(false);
      expect(record.checks.coverage.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
