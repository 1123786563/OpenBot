// server/tests/multitenancy/migration-tool.test.ts
// MT003（Issue #46）：按任务生成迁移的安全迁移工具（dry-run/apply + manifest）。
//
// 这些测试是 Issue #46 验收标准的事实源：
//   (1) 只接受枚举的 task ID 与 generate/migrate 两个命令，未知值一律拒绝；
//   (2) 只读显式测试库配置（仅 TEST_DATABASE_URL），缺失/生产/非法 URL
//       带理由拒绝，绝不回退 DATABASE_URL 或 .env，且拒绝必须发生在任何
//       连接/文件副作用之前；
//   (3) 每个任务固定确定性文件名、编号严格递增，检测重复编号与断号；
//   (4) 默认 dry-run（展示语句与影响摘要），apply 必须携带与计划完全一致
//       的显式 manifest；真实 apply 只允许打到本任务专属测试库。

import { describe, expect, test } from "../../../tests/support/bun-test-compat";
import {
  ALLOWED_TASK_IDS,
  buildPlan,
  manifestFor,
  runMigrateTest,
  TASKS,
  validateJournalAgainstPlan,
  validateJournalNumbers,
  validatePlanNumbering,
} from "../../scripts/multitenancy/migrate-test";

// 静态用例的合法环境 fixture（伪连接，永不真实连接）：故意保留 DATABASE_URL
// 诱饵，工具只认 TEST_DATABASE_URL，任何回退都会被这些测试抓住。
const ASSIGNED_TEST_DATABASE_URL =
  "postgres://postgres@127.0.0.1:55433/openbot_enterprise_mt003_test";
const VALID_ENV: Record<string, string | undefined> = {
  TEST_DATABASE_URL: ASSIGNED_TEST_DATABASE_URL,
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

interface SideEffectLog {
  connectCalls: number;
  writes: Array<{ path: string; content: string }>;
  reads: string[];
  outLines: string[];
}

/**
 * 拒绝路径的证据采集器：connect 一旦被调用就抛错（拒绝必须发生在连接之前），
 * 文件读/写全部记录，out 行收集后断言。
 */
function refusalProbe(environment: Record<string, string | undefined>) {
  const effects: SideEffectLog = {
    connectCalls: 0,
    writes: [],
    reads: [],
    outLines: [],
  };
  const deps = {
    environment,
    connect: () => {
      effects.connectCalls += 1;
      throw new Error("connect must not be called on a refused run");
    },
    fs: {
      mkdir: async () => {},
      readdir: async (path: string) => {
        effects.reads.push(`readdir:${path}`);
        return [];
      },
      readFile: async (path: string) => {
        effects.reads.push(`readFile:${path}`);
        throw new Error(
          `readFile must not be called on a refused run: ${path}`,
        );
      },
      writeFile: async (path: string, content: string) => {
        effects.writes.push({ path, content });
      },
    },
    out: (line: string) => effects.outLines.push(line),
  };
  return { deps, effects };
}

function expectNoSideEffects(effects: SideEffectLog) {
  expect(effects.connectCalls).toBe(0);
  expect(effects.writes).toEqual([]);
  // F4：拒绝路径同样必须零文件读；否则「与预期 stage 恰好一致的读文件」
  // 会成为盲区。
  expect(effects.reads).toEqual([]);
}

describe("refusal probe helper contract", () => {
  test("expectNoSideEffects also fails when a refused path performed file reads", () => {
    // F4：拒绝路径必须零读。若 helper 只断言 connect/writes，「与预期 stage
    // 恰好一致的读文件」就是盲区；这里直接验证 helper 对 reads 报错。
    const effects: SideEffectLog = {
      connectCalls: 0,
      writes: [],
      reads: ["readFile:/tmp/tampered.json"],
      outLines: [],
    };
    expect(() => expectNoSideEffects(effects)).toThrow();
  });
});

describe("issue #46 criterion 1: only enumerated tasks and commands", () => {
  test("rejects an unknown command with the offending name and no side effects", async () => {
    const { deps, effects } = refusalProbe(VALID_ENV);
    const outcome = await runMigrateTest(["deploy", "MT000"], deps);
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("deploy");
      expect(outcome.reason).toContain("generate");
      expect(outcome.reason).toContain("migrate");
    }
    expectNoSideEffects(effects);
  });

  test("rejects a missing command and a missing task id", async () => {
    const missingCommand = await runMigrateTest([], {
      ...refusalProbe(VALID_ENV).deps,
    });
    expect(missingCommand).toMatchObject({ kind: "refused", stage: "args" });

    const missingTask = await runMigrateTest(["generate"], {
      ...refusalProbe(VALID_ENV).deps,
    });
    expect(missingTask).toMatchObject({ kind: "refused", stage: "args" });
    if (missingTask.kind === "refused") {
      expect(missingTask.reason).toContain("task id");
    }
  });

  test("rejects an unknown task id and is case-sensitive about known ones", async () => {
    const { deps, effects } = refusalProbe(VALID_ENV);
    const outcome = await runMigrateTest(["migrate", "MT999"], deps);
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("MT999");
      expect(outcome.reason).toContain("MT000");
    }
    expectNoSideEffects(effects);

    const lowercase = await runMigrateTest(["migrate", "mt000"], {
      ...refusalProbe(VALID_ENV).deps,
    });
    expect(lowercase).toMatchObject({ kind: "refused", stage: "args" });
  });

  test("rejects unknown flags and extra positionals", async () => {
    const unknownFlag = await runMigrateTest(
      ["migrate", "MT000", "--force"],
      refusalProbe(VALID_ENV).deps,
    );
    expect(unknownFlag).toMatchObject({ kind: "refused", stage: "args" });

    const extraPositional = await runMigrateTest(
      ["migrate", "MT000", "MT001"],
      refusalProbe(VALID_ENV).deps,
    );
    expect(extraPositional).toMatchObject({ kind: "refused", stage: "args" });
  });

  test("apply without a manifest is an argument refusal before any side effect", async () => {
    const { deps, effects } = refusalProbe(VALID_ENV);
    const outcome = await runMigrateTest(["migrate", "MT000", "--apply"], deps);
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("--manifest");
    }
    expectNoSideEffects(effects);
  });

  test("generate rejects migrate-only flags", async () => {
    const outcome = await runMigrateTest(
      ["generate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
      refusalProbe(VALID_ENV).deps,
    );
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
  });

  test("migrate rejects generate-only flags", async () => {
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--out", "/tmp/dir"],
      refusalProbe(VALID_ENV).deps,
    );
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
  });

  test("migrate --manifest without --apply refuses instead of silently ignoring the manifest", async () => {
    // F3：manifest 只在 apply 时才有意义；不带 --apply 时必须显式拒绝，
    // 绝不能静默忽略后照常 dry-run。
    const { deps, effects } = refusalProbe(VALID_ENV);
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--manifest", "/tmp/m.json"],
      deps,
    );
    expect(outcome).toMatchObject({ kind: "refused", stage: "args" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("--manifest");
      expect(outcome.reason).toContain("--apply");
    }
    expectNoSideEffects(effects);
  });
});

describe("issue #46 criterion 2: explicit test database configuration only", () => {
  test("missing TEST_DATABASE_URL refuses even when DATABASE_URL is present", async () => {
    const { deps, effects } = refusalProbe({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("TEST_DATABASE_URL");
      expect(outcome.reason).toContain("DATABASE_URL");
    }
    expectNoSideEffects(effects);
  });

  test("blank TEST_DATABASE_URL refuses", async () => {
    const { deps, effects } = refusalProbe({
      TEST_DATABASE_URL: "   ",
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    expectNoSideEffects(effects);
  });

  test("a non-loopback host is a production target and refuses", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL:
        "postgres://postgres@db.internal.example.com:5432/openbot_enterprise_prod",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("loopback");
      expect(outcome.reason).toContain("db.internal.example.com");
    }
    expectNoSideEffects(effects);
  });

  test("the live application database name refuses", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/openbot",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toMatch(
        /openbot_enterprise|live openbot database/,
      );
    }
    expectNoSideEffects(effects);
  });

  test("generic database names like postgres refuse", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/postgres",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("openbot_enterprise");
    }
    expectNoSideEffects(effects);
  });

  test("non-postgres protocols refuse", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL: "mysql://root@127.0.0.1:3306/openbot_enterprise_test",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    expectNoSideEffects(effects);
  });

  test("an unparseable URL refuses with a reason", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL: "not a url at all",
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("TEST_DATABASE_URL");
    }
    expectNoSideEffects(effects);
  });

  test("a URL fragment refuses", async () => {
    const { deps, effects } = refusalProbe({
      ...VALID_ENV,
      TEST_DATABASE_URL: `${ASSIGNED_TEST_DATABASE_URL}#fragment`,
    });
    const outcome = await runMigrateTest(["migrate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("fragment");
    }
    expectNoSideEffects(effects);
  });

  test("generate validates the same database configuration before anything else", async () => {
    const { deps, effects } = refusalProbe({
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    });
    const outcome = await runMigrateTest(["generate", "MT000"], deps);
    expect(outcome).toMatchObject({
      kind: "refused",
      stage: "database-config",
    });
    expectNoSideEffects(effects);
  });
});

describe("issue #46 criterion 3: deterministic names and increasing numbers", () => {
  test("the allowlist is exactly the registry and the shipped self-check task", () => {
    // MT004 裁决（coordinator，MT004 执行期窄例外）：注册表随 MT004 追加条目
    // 是工具自身声明的契约演进（“后续 Ticket 在注册表中追加自己的任务条目”），
    // 本穷举断言随之最小更新；除此之外本文件保持 MT003 原样只读。
    // MT112 裁决（coordinator ruling #5，same narrow exception as ruling #3）：
    // 仅本断言追加 "MT112"，文件其余内容保持只读。
    // MT008（同 ruling #5 先例，MT008 brief 预授权）：仅本断言追加 "MT008"
    // （enterprise_resources.visibility 列迁移注册），文件其余内容只读；
    // diff 与哈希存档于 checkpoints/MT008/。
    // MT010（同 ruling #5 先例，MT010 brief 预授权）：仅本断言追加 "MT010"
    // （个人资源显式分享表 enterprise_resource_shares 迁移注册），文件其余
    // 只读；diff 与哈希存档于 checkpoints/MT010/。
    // MT009（同 ruling #5 先例，第 4 次，MT009 brief 预授权）：仅本断言追加
    // "MT009"（资源依赖表迁移注册），文件其余内容只读；diff 与哈希存档于
    // checkpoints/MT009/。
    // MT012（同 ruling #5 先例，MT012 brief 预授权）：仅本断言追加 "MT012"
    // （核心租户域表 RLS 再断言 + 上下文清理函数迁移注册），文件其余只读；
    // diff 与哈希存档于 checkpoints/MT012/。
    // 裁决 #5 先例（MT112 第 4 次沿用，MT014 brief 预授权）：本断言穷举
    // 任务注册表，每个新任务注册后此处置必须显式扩展；文件其余内容只读。
    // MT077（同 ruling #5 先例，MT077 brief 预授权第 6 次）：仅本断言追加
    // "MT077"（网络/能力/路由策略与模板安装三表迁移注册），文件其余只读；
    // diff 与哈希存档于 checkpoints/MT077/。
    // MT026（同 ruling #5 先例，MT026 brief 预授权）：仅本断言追加 "MT026"
    // （每公司 SSO/SCIM 隔离三表迁移注册），文件其余内容只读；diff 与哈希
    // 存档于 checkpoints/MT026/。
    // MT076（同 ruling #5 先例，MT076 brief 预授权）：仅本断言追加 "MT076"
    // （人员管理动作 role 列级 UPDATE 授权迁移注册），文件其余内容只读；
    // diff 与哈希存档于 checkpoints/MT076/。
    // MT069（同 ruling #5 先例，MT069 brief 预授权）：仅本断言追加 "MT069"
    // （公司↔计费 Customer 映射与公司/个人账户类型三表迁移注册），文件
    // 其余内容只读；diff 与哈希存档于 checkpoints/MT069/。
    // MT016（同 ruling #5 先例，MT016 brief 预授权编辑点 #2；第 2 任接管
    // 补齐第 1 任中断的本行）：仅本断言追加 "MT016"（Bot 归属两表迁移
    // 注册），文件其余内容只读；diff 与哈希存档于 checkpoints/MT016/。
    // MT041（同 ruling #5 先例，MT041 brief 预授权）：仅本断言追加 "MT041"
    // （任务/运行/触发归属与配置版本快照、租约模型三表迁移注册），文件
    // 其余内容只读；diff 与哈希存档于 checkpoints/MT041/。
    // MT027（同 ruling #5 先例，第 12 次沿用，MT027 brief 预授权）：仅本
    // 断言追加 "MT027"（凭据归属三表迁移注册），文件其余内容只读；diff
    // 与哈希存档于 checkpoints/MT027/。
    // MT028（同 ruling #5 先例，第 13 次沿用，MT028 brief 预授权）：仅本
    // 断言追加 "MT028"（OAuth 持久 state 表迁移注册，第十五任务），文件
    // 其余内容只读；diff 与哈希存档于 checkpoints/MT028/。
    // MT070（同 ruling #5 先例，第 13 次沿用，MT070 brief 预授权）：仅本
    // 断言追加 "MT070"（公司调用归属表迁移注册，迁移链第十五任务），文件
    // 其余内容只读；diff 与哈希存档于 checkpoints/MT070/。
    // MT031（同 ruling #5 先例，第 14 次沿用，MT031 brief 预授权）：仅本
    // 断言追加 "MT031"（插件目录与安装归属三表迁移注册，迁移链第十七
    // 任务），文件其余内容只读；diff 与哈希存档于 checkpoints/MT031/。
    // MT042（同 ruling #5 先例，MT042 brief 预授权）：仅本断言追加 "MT042"
    // （平台扫描作用域重建——job_ownership 扫描臂读策略迁移注册），文件
    // 其余内容只读；diff 与哈希存档于 checkpoints/MT042/。
    // MT059（同 ruling #5 先例，第 18 次沿用，MT059 brief 预授权）：仅本
    // 断言追加 "MT059"（用户私有 OpenMuse Bot 两表迁移注册，迁移链第十八
    // 任务），文件其余内容只读；diff 与哈希存档于 checkpoints/MT059/。
    // MT029（同 ruling #5 先例，第 19 次沿用，MT029 brief 预授权）：仅本
    // 断言追加 "MT029"（凭据取用 lease 两表迁移注册，迁移链第二十任务），
    // 文件其余内容只读；diff 与哈希存档于 checkpoints/MT029/。
    // MT073（同 ruling #5 先例，第 20 次沿用，MT073 brief 预授权）：仅本
    // 断言追加 "MT073"（公司财务读取授权表迁移注册，迁移链第二十任务），
    // 文件其余内容只读；diff 与哈希存档于 checkpoints/MT073/。
    // MT060（同 ruling #5 先例，第 19 次沿用，MT060 brief 预授权窄缝）：仅
    // 本断言追加 "MT060"（OpenMuse 任务/计划/监控归属协会表 + 回填迁移注
    // 册，迁移链第十九任务），文件其余内容只读；diff 与哈希存档于
    // checkpoints/MT060/。
    // 波次 15 集成（brief 预授权）：三票任务块并入迁移链 MT029→MT073→MT060，
    // 穷举断言三 ID 并入排序位（MT028<MT029<MT031、MT059<MT060<MT069、
    // MT070<MT073<MT076），其余内容只读。
    // 修复波次 fix-mt（#46 MT003 测试适配）：实现注册表已含波次 16 的
    // MT034/MT067/MT074 而本断言清单未同步，按注册表排序位补齐这三项
    // （MT031<MT034<MT041、MT060<MT067<MT069、MT073<MT074<MT076），
    // 文件其余内容只读。
    expect(ALLOWED_TASK_IDS).toEqual([
      "MT000",
      "MT004",
      "MT008",
      "MT009",
      "MT010",
      "MT012",
      "MT014",
      "MT016",
      "MT026",
      "MT027",
      "MT028",
      "MT029",
      "MT031",
      "MT034",
      "MT041",
      "MT042",
      "MT059",
      "MT060",
      "MT067",
      "MT069",
      "MT070",
      "MT073",
      "MT074",
      "MT076",
      "MT077",
      "MT112",
    ]);
    expect(new Set(ALLOWED_TASK_IDS)).toEqual(new Set(TASKS.keys()));
    const selfCheck = TASKS.get("MT000");
    expect(selfCheck?.description).toContain("非业务迁移");
  });

  test("plan names are fixed, numbered from 0001, and deterministic", () => {
    const first = buildPlan("MT000");
    const second = buildPlan("MT000");
    expect(first.steps.map((step) => step.name)).toEqual([
      "0001_mt000_selfcheck_table.sql",
      "0002_mt000_selfcheck_assert.sql",
      "0003_mt000_selfcheck_drop.sql",
    ]);
    expect(first.steps.map((step) => step.number)).toEqual([1, 2, 3]);
    expect(first).toEqual(second);
    expect(first.planDigest).toBe(second.planDigest);
    for (const step of first.steps) {
      expect(step.statements.length).toBeGreaterThan(0);
    }
  });

  test("buildPlan refuses unknown task ids", () => {
    expect(() => buildPlan("MT999")).toThrow(/MT999/);
  });

  test("plan numbering rejects duplicates, gaps, and duplicate names", () => {
    expect(
      validatePlanNumbering([
        { number: 1, name: "a" },
        { number: 1, name: "b" },
      ]),
    ).toMatchObject({
      ok: false,
    });
    expect(
      validatePlanNumbering([
        { number: 1, name: "a" },
        { number: 3, name: "c" },
      ]),
    ).toMatchObject({ ok: false });
    expect(validatePlanNumbering([{ number: 2, name: "a" }])).toMatchObject({
      ok: false,
    });
    expect(
      validatePlanNumbering([
        { number: 1, name: "a" },
        { number: 2, name: "a" },
      ]),
    ).toMatchObject({ ok: false });
    expect(validatePlanNumbering([])).toMatchObject({ ok: false });
    expect(
      validatePlanNumbering([
        { number: 1, name: "a" },
        { number: 2, name: "b" },
      ]),
    ).toMatchObject({ ok: true });
  });

  test("journal numbers must be a contiguous prefix of the plan", () => {
    // 健康状态：空、部分、全部。
    expect(validateJournalNumbers([], 3)).toEqual({
      ok: true,
      appliedCount: 0,
    });
    expect(validateJournalNumbers([1], 3)).toEqual({
      ok: true,
      appliedCount: 1,
    });
    expect(validateJournalNumbers([1, 2, 3], 3)).toEqual({
      ok: true,
      appliedCount: 3,
    });
    // 重复编号。
    expect(validateJournalNumbers([1, 1], 3).ok).toBe(false);
    // 断号：不从 1 开始或中间缺失。
    expect(validateJournalNumbers([2], 3).ok).toBe(false);
    expect(validateJournalNumbers([1, 3], 3).ok).toBe(false);
    // journal 超出计划长度：计划/journal 漂移。
    expect(validateJournalNumbers([1, 2, 3, 4], 3).ok).toBe(false);
    // 输入乱序时仍按排序后的语义校验。
    expect(validateJournalNumbers([2, 1], 3)).toEqual({
      ok: true,
      appliedCount: 2,
    });
  });

  test("the manifest mirrors the plan with per-step digests", () => {
    const plan = buildPlan("MT000");
    const manifest = manifestFor(plan);
    expect(manifest.taskId).toBe("MT000");
    expect(manifest.planDigest).toBe(plan.planDigest);
    expect(manifest.steps).toHaveLength(3);
    expect(manifest.steps[0]).toEqual({
      number: 1,
      name: "0001_mt000_selfcheck_table.sql",
      statementDigest: plan.steps[0].statementDigest,
      statementCount: 2,
    });
    // 计划未变则 manifest 不变；语句变了 digest 必须变。
    expect(manifestFor(buildPlan("MT000"))).toEqual(manifest);
  });
});

// ---------------------------------------------------------------------------
// dry-run / manifest 门禁 / apply（伪连接）：Issue #46 验收标准 (4)
// ---------------------------------------------------------------------------

import type { MigrationSql } from "../../scripts/multitenancy/migrate-test";

interface FakeCall {
  kind: "unsafe" | "begin" | "end";
  query: string;
}

function fakeConnection(
  journalRows: Array<{ number: number; statement_digest?: string }> = [],
) {
  const calls: FakeCall[] = [];
  const conn: MigrationSql = {
    async unsafe(query: string) {
      calls.push({ kind: "unsafe", query });
      if (query.includes("FROM mt_task_migration_journal")) {
        return journalRows;
      }
      return [];
    },
    async begin(work) {
      calls.push({ kind: "begin", query: "" });
      return await work(conn);
    },
    async end() {
      calls.push({ kind: "end", query: "" });
    },
  };
  const queries = () => calls.map((call) => call.query).filter(Boolean);
  const begins = () => calls.filter((call) => call.kind === "begin").length;
  return { conn, calls, queries, begins };
}

function applyDeps(
  manifestFile: Record<string, string>,
  journalRows: Array<{ number: number }>,
) {
  const connection = fakeConnection(journalRows);
  let connectCalls = 0;
  const deps = {
    environment: VALID_ENV,
    connect: (url: string) => {
      connectCalls += 1;
      expect(url).toBe(ASSIGNED_TEST_DATABASE_URL);
      return connection.conn;
    },
    fs: {
      mkdir: async () => {},
      readdir: async () => [],
      readFile: async (path: string) => {
        if (path in manifestFile) return manifestFile[path];
        throw new Error(`ENOENT: ${path}`);
      },
      writeFile: async () => {},
    },
    out: () => {},
  };
  return { deps, connection, connectCalls: () => connectCalls };
}

const CORRECT_MANIFEST = JSON.stringify(manifestFor(buildPlan("MT000")));

describe("issue #46 criterion 4: dry-run is the default", () => {
  test("migrate without --apply plans without executing anything", async () => {
    const connection = fakeConnection([]);
    const outLines: string[] = [];
    const outcome = await runMigrateTest(["migrate", "MT000"], {
      environment: VALID_ENV,
      connect: () => connection.conn,
      fs: {
        mkdir: async () => {},
        readdir: async () => [],
        readFile: async () => {
          throw new Error("dry-run must not read the manifest");
        },
        writeFile: async () => {
          throw new Error("dry-run must not write files");
        },
      },
      out: (line) => outLines.push(line),
    });
    expect(outcome.kind).toBe("dry-run");
    if (outcome.kind !== "dry-run") return;
    expect(outcome.appliedCount).toBe(0);
    expect(outcome.pending).toHaveLength(3);
    expect(outcome.databaseName).toBe("openbot_enterprise_mt003_test");
    expect(outcome.endpoint).toBe("127.0.0.1:55433");
    expect(outcome.manifest).toEqual(manifestFor(buildPlan("MT000")));
    // 只读 journal：绝无事务、绝无语句执行。
    expect(connection.begins()).toBe(0);
    expect(connection.queries().join(" ")).not.toContain("CREATE TABLE");
    // 输出包含 dry-run 标记、数据库、逐条语句与影响说明。
    const text = outLines.join("\n");
    expect(text).toContain("dry-run");
    expect(text).toContain("openbot_enterprise_mt003_test");
    expect(text).toContain("CREATE TABLE mt_tool_selfcheck");
    expect(text).toContain("DROP TABLE mt_tool_selfcheck");
    expect(text).toContain("自检临时表");
  });

  test("dry-run reports pending steps against a partial journal", async () => {
    const connection = fakeConnection([
      {
        number: 1,
        statement_digest: buildPlan("MT000").steps[0].statementDigest,
      },
    ]);
    const outcome = await runMigrateTest(["migrate", "MT000"], {
      environment: VALID_ENV,
      connect: () => connection.conn,
      out: () => {},
    });
    expect(outcome.kind).toBe("dry-run");
    if (outcome.kind !== "dry-run") return;
    expect(outcome.appliedCount).toBe(1);
    expect(outcome.pending.map((step) => step.number)).toEqual([2, 3]);
    expect(connection.begins()).toBe(0);
  });

  test("a journal with gaps or duplicates refuses before executing", async () => {
    for (const journalRows of [
      [{ number: 1 }, { number: 3 }],
      [{ number: 1 }, { number: 1 }],
    ]) {
      const connection = fakeConnection(journalRows);
      const outcome = await runMigrateTest(
        ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
        {
          ...applyDeps({ "/tmp/m.json": CORRECT_MANIFEST }, journalRows).deps,
          connect: () => connection.conn,
        },
      );
      expect(outcome).toMatchObject({ kind: "refused", stage: "journal" });
      if (outcome.kind === "refused") {
        expect(outcome.reason).toMatch(/gap|duplicate/);
      }
      expect(connection.begins()).toBe(0);
    }
  });
});

describe("issue #46 criterion 4: apply requires an exact manifest", () => {
  test("a missing manifest file refuses before connecting", async () => {
    const { deps, connectCalls } = applyDeps({}, []);
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--apply", "--manifest", "/tmp/missing.json"],
      deps,
    );
    expect(outcome).toMatchObject({ kind: "refused", stage: "manifest" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("/tmp/missing.json");
    }
    expect(connectCalls()).toBe(0);
  });

  test("a manifest that disagrees with the plan refuses before connecting", async () => {
    const plan = buildPlan("MT000");
    const tampered = manifestFor(plan);
    const cases: Array<[string, Record<string, string>]> = [
      [
        "plan digest",
        {
          "/tmp/m.json": JSON.stringify({
            ...tampered,
            planDigest: "0".repeat(64),
          }),
        },
      ],
      [
        "statement digest",
        {
          "/tmp/m.json": JSON.stringify({
            ...tampered,
            steps: tampered.steps.map((step, index) =>
              index === 0 ? { ...step, statementDigest: "f".repeat(64) } : step,
            ),
          }),
        },
      ],
      [
        "task id",
        { "/tmp/m.json": JSON.stringify({ ...tampered, taskId: "MT999" }) },
      ],
      [
        "dropped step",
        {
          "/tmp/m.json": JSON.stringify({
            ...tampered,
            steps: tampered.steps.slice(1),
          }),
        },
      ],
      [
        "schema version",
        { "/tmp/m.json": JSON.stringify({ ...tampered, schemaVersion: 2 }) },
      ],
      ["not json", { "/tmp/m.json": "this is not json" }],
    ];
    for (const [label, files] of cases) {
      const { deps, connectCalls } = applyDeps(files, []);
      const outcome = await runMigrateTest(
        ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
        deps,
      );
      expect(outcome).toMatchObject({ kind: "refused", stage: "manifest" });
      expect(connectCalls()).toBe(0);
      if (outcome.kind === "refused" && label === "not json") {
        expect(outcome.reason).toContain("manifest");
      }
    }
  });

  test("a valid manifest applies each step in its own transaction and journals it", async () => {
    const { deps, connection } = applyDeps(
      { "/tmp/m.json": CORRECT_MANIFEST },
      [],
    );
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
      deps,
    );
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.appliedSteps.map((step) => step.number)).toEqual([1, 2, 3]);
    // journal 表先建（IF NOT EXISTS），随后每步一个事务：语句 + journal 写入。
    const queries = connection.queries();
    expect(
      queries.some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS mt_task_migration_journal"),
      ),
    ).toBe(true);
    expect(connection.begins()).toBe(3);
    const all = queries.join("\n");
    expect(all).toContain("CREATE TABLE mt_tool_selfcheck");
    expect(all).toContain("DROP TABLE mt_tool_selfcheck");
    expect(all).toContain("0001_mt000_selfcheck_table.sql");
    expect(all).toContain("INSERT INTO mt_task_migration_journal");
    // 连接关闭（无泄漏）。
    expect(connection.calls.some((call) => call.kind === "end")).toBe(true);
  });

  test("an already fully applied task is an explicit no-op, not a re-run", async () => {
    const plan = buildPlan("MT000");
    const { deps, connection } = applyDeps(
      { "/tmp/m.json": CORRECT_MANIFEST },
      plan.steps.map((step, index) => ({
        number: index + 1,
        statement_digest: step.statementDigest,
      })),
    );
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
      deps,
    );
    expect(outcome.kind).toBe("up-to-date");
    if (outcome.kind === "up-to-date") {
      expect(outcome.appliedCount).toBe(3);
    }
    expect(connection.begins()).toBe(0);
    expect(connection.queries().join(" ")).not.toContain("mt_tool_selfcheck");
  });
});

// ---------------------------------------------------------------------------
// MT003-fix2 F2：journal 已记录 digest 必须与当前计划逐步骤一致；漂移即拒绝，
// 且绝不自动修复/重放已入账步骤。
// ---------------------------------------------------------------------------

describe("MT003-fix2 F2: journal digests must match the current plan", () => {
  const plan = buildPlan("MT000");
  const entry = (number: number, digest?: string) => ({
    number,
    statementDigest: digest ?? plan.steps[number - 1].statementDigest,
  });

  test("a journal whose recorded digests all match the plan converges", () => {
    expect(
      validateJournalAgainstPlan([entry(1), entry(2), entry(3)], plan),
    ).toEqual({ ok: true, appliedCount: 3 });
    expect(validateJournalAgainstPlan([], plan)).toEqual({
      ok: true,
      appliedCount: 0,
    });
  });

  test("a journaled digest that differs from the plan refuses with a manual-review reason", () => {
    const drifted = validateJournalAgainstPlan(
      [entry(1), entry(2, "f".repeat(64))],
      plan,
    );
    expect(drifted).toMatchObject({ ok: false });
    if (!drifted.ok) {
      expect(drifted.reason).toContain("0002_mt000_selfcheck_assert.sql");
      expect(drifted.reason).toContain("drifted");
      expect(drifted.reason).toContain("manual review");
    }
    // 部分已应用时第一步漂移同样拒绝。
    expect(
      validateJournalAgainstPlan([entry(1, "0".repeat(64))], plan).ok,
    ).toBe(false);
  });

  test("numbering errors still surface before digest comparison", () => {
    expect(validateJournalAgainstPlan([entry(1), entry(3)], plan).ok).toBe(
      false,
    );
    expect(validateJournalAgainstPlan([entry(1), entry(1)], plan).ok).toBe(
      false,
    );
  });

  test("migrate refuses on journal/plan digest drift before applying and never self-repairs", async () => {
    const rows = [
      { number: 1, statement_digest: plan.steps[0].statementDigest },
      { number: 2, statement_digest: "f".repeat(64) },
    ];
    const connection = fakeConnection(rows);
    const { deps } = applyDeps({ "/tmp/m.json": CORRECT_MANIFEST }, rows);
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
      { ...deps, connect: () => connection.conn },
    );
    expect(outcome).toMatchObject({ kind: "refused", stage: "journal" });
    if (outcome.kind === "refused") {
      expect(outcome.reason).toContain("drifted");
      expect(outcome.reason).toContain("manual review");
    }
    // 拒绝即终止：无事务、无步骤语句、无任何 journal 写入/改写（不自动修复）。
    expect(connection.begins()).toBe(0);
    const queries = connection.queries().join("\n");
    expect(queries).not.toContain("mt_tool_selfcheck");
    expect(queries).not.toContain("INSERT INTO mt_task_migration_journal");
    expect(queries).not.toContain("UPDATE mt_task_migration_journal");
    expect(queries).not.toContain("DELETE FROM mt_task_migration_journal");
  });

  test("dry-run also refuses on journal/plan digest drift instead of planning past it", async () => {
    const connection = fakeConnection([
      { number: 1, statement_digest: "0".repeat(64) },
    ]);
    const outcome = await runMigrateTest(["migrate", "MT000"], {
      environment: VALID_ENV,
      connect: () => connection.conn,
      out: () => {},
    });
    expect(outcome).toMatchObject({ kind: "refused", stage: "journal" });
    expect(connection.begins()).toBe(0);
  });

  test("up-to-date is not reported when a journaled digest drifts from the plan", async () => {
    const rows = [
      { number: 1, statement_digest: plan.steps[0].statementDigest },
      { number: 2, statement_digest: plan.steps[1].statementDigest },
      { number: 3, statement_digest: "e".repeat(64) },
    ];
    const connection = fakeConnection(rows);
    const { deps } = applyDeps({ "/tmp/m.json": CORRECT_MANIFEST }, rows);
    const outcome = await runMigrateTest(
      ["migrate", "MT000", "--apply", "--manifest", "/tmp/m.json"],
      { ...deps, connect: () => connection.conn },
    );
    expect(outcome.kind).toBe("refused");
    expect(outcome).toMatchObject({ kind: "refused", stage: "journal" });
    expect(connection.begins()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generate：确定性文件物化与断号/重复/漂移检测（Issue #46 验收标准 3、4）
// ---------------------------------------------------------------------------

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_STEP_CONTENT = (step: { statements: readonly string[] }) =>
  `-- multitenancy migrate-test\n${step.statements.join("\n--> statement-breakpoint\n")}\n`;

async function generateDeps() {
  const outLines: string[] = [];
  return {
    deps: {
      environment: VALID_ENV,
      out: (line: string) => outLines.push(line),
    },
    outLines,
  };
}

describe("issue #46 criterion 3/4: generate materializes deterministic files", () => {
  test("generate --out writes NNNN-named SQL files plus the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt003-generate-"));
    try {
      const { deps } = await generateDeps();
      const outcome = await runMigrateTest(
        ["generate", "MT000", "--out", dir],
        deps,
      );
      expect(outcome.kind).toBe("generated");
      if (outcome.kind !== "generated") return;
      expect(outcome.outDir).toBe(join(dir, "MT000"));
      expect(outcome.written).toEqual([
        join(dir, "MT000", "0001_mt000_selfcheck_table.sql"),
        join(dir, "MT000", "0002_mt000_selfcheck_assert.sql"),
        join(dir, "MT000", "0003_mt000_selfcheck_drop.sql"),
        join(dir, "MT000", "manifest.json"),
      ]);
      const plan = buildPlan("MT000");
      for (const step of plan.steps) {
        const content = await readFile(join(dir, "MT000", step.name), "utf8");
        expect(content).toBe(EXPECTED_STEP_CONTENT(step));
      }
      expect(
        JSON.parse(await readFile(join(dir, "MT000", "manifest.json"), "utf8")),
      ).toEqual(manifestFor(plan));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("regenerating the same plan verifies instead of rewriting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt003-regen-"));
    try {
      const { deps } = await generateDeps();
      await runMigrateTest(["generate", "MT000", "--out", dir], deps);
      const second = await runMigrateTest(
        ["generate", "MT000", "--out", dir],
        (await generateDeps()).deps,
      );
      expect(second.kind).toBe("generated");
      if (second.kind !== "generated") return;
      expect(second.written).toEqual([]);
      expect(second.verified).toEqual([
        "0001_mt000_selfcheck_table.sql",
        "0002_mt000_selfcheck_assert.sql",
        "0003_mt000_selfcheck_drop.sql",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("duplicate numbers, gaps, drift, and beyond-plan files all refuse", async () => {
    const cases: Array<[string, Array<[string, string]>]> = [
      [
        "duplicate numbers",
        [
          ["0001_mt000_aaa.sql", "-- x\n"],
          ["0001_mt000_bbb.sql", "-- y\n"],
        ],
      ],
      [
        "gap",
        [
          [
            "0001_mt000_selfcheck_table.sql",
            EXPECTED_STEP_CONTENT(buildPlan("MT000").steps[0]),
          ],
          [
            "0003_mt000_selfcheck_drop.sql",
            EXPECTED_STEP_CONTENT(buildPlan("MT000").steps[2]),
          ],
        ],
      ],
      ["content drift", [["0001_mt000_selfcheck_table.sql", "-- tampered\n"]]],
      ["name drift", [["0002_mt000_wrong_name.sql", "-- x\n"]]],
      [
        "beyond plan",
        [
          [
            "0001_mt000_selfcheck_table.sql",
            EXPECTED_STEP_CONTENT(buildPlan("MT000").steps[0]),
          ],
          ["0009_mt000_extra.sql", "-- x\n"],
        ],
      ],
    ];
    for (const [label, files] of cases) {
      const dir = await mkdtemp(join(tmpdir(), "mt003-bad-"));
      try {
        const taskDir = join(dir, "MT000");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(taskDir, { recursive: true });
        for (const [name, content] of files) {
          await writeFile(join(taskDir, name), content);
        }
        const outcome = await runMigrateTest(
          ["generate", "MT000", "--out", dir],
          (await generateDeps()).deps,
        );
        expect(outcome).toMatchObject({ kind: "refused", stage: "numbering" });
        if (outcome.kind === "refused") {
          expect(outcome.reason.length).toBeGreaterThan(0);
        }
        // 拒绝时不得写入或改写任何文件。
        expect((await readdir(taskDir)).sort()).toEqual(
          files.map(([name]) => name).sort(),
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      void label;
    }
  });

  test("generate without --out has no file side effects and prints the plan", async () => {
    const { deps, outLines } = await generateDeps();
    const outcome = await runMigrateTest(["generate", "MT000"], {
      ...deps,
      fs: {
        mkdir: async () => {},
        readdir: async () => [],
        readFile: async () => {
          throw new Error("stdout generate must not read files");
        },
        writeFile: async () => {
          throw new Error("stdout generate must not write files");
        },
      },
    });
    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;
    expect(outcome.outDir).toBeNull();
    expect(outcome.written).toEqual([]);
    const text = outLines.join("\n");
    expect(text).toContain("0001_mt000_selfcheck_table.sql");
    expect(text).toContain(JSON.stringify(manifestFor(buildPlan("MT000"))));
  });
});

// ---------------------------------------------------------------------------
// 真实 apply：专属测试库来自显式 env MT003_ASSIGNED_TEST_DATABASE_URL
// （F1：不再硬编码端点/库名，任何回环 openbot_enterprise_* 专属库都可复现）。
// 显式配置时必须通过与主路径完全相同的安全检查（回环、单段库名、
// openbot_enterprise_* 前缀、非生产拒绝，复用 resolveTestDatabaseTarget）；
// 配置了但被拒绝 = 整体失败，绝不静默降级为 skip。未配置时保持显式 skip。
// ---------------------------------------------------------------------------

import postgres from "postgres";
import { resolveTestDatabaseTarget } from "../../scripts/multitenancy/migrate-test";

const MT003_ASSIGNED_TEST_DATABASE_URL_ENV = "MT003_ASSIGNED_TEST_DATABASE_URL";

const assignedRaw = process.env[MT003_ASSIGNED_TEST_DATABASE_URL_ENV]?.trim();
const assignedResolution = assignedRaw
  ? resolveTestDatabaseTarget({
      TEST_DATABASE_URL: assignedRaw,
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    })
  : undefined;
if (assignedResolution && !assignedResolution.ok) {
  throw new Error(
    `${MT003_ASSIGNED_TEST_DATABASE_URL_ENV} must pass the migration tool's full database safety checks; it was refused: ${assignedResolution.reason}`,
  );
}
const assignedTarget = assignedResolution?.ok
  ? assignedResolution.target
  : undefined;
const dbTest = assignedTarget ? test : test.skip;
const skipNote = assignedTarget
  ? ""
  : ` [skipped: ${MT003_ASSIGNED_TEST_DATABASE_URL_ENV} is not set; set it to a dedicated loopback openbot_enterprise_* test database to run the real-apply integration test]`;

dbTest(
  `applies MT000 end-to-end on the assigned dedicated test database${skipNote}`,
  async () => {
    if (!assignedTarget) {
      throw new Error("unreachable: dbTest guard ensures an assigned target");
    }
    // 工具自身只读 TEST_DATABASE_URL；这里把显式 env 的专属库映射过去，
    // 使单一 env 即可驱动整个集成链路。
    const toolEnvironment = {
      ...process.env,
      TEST_DATABASE_URL: assignedTarget.url,
    };
    const dir = await mkdtemp(join(tmpdir(), "mt003-real-"));
    try {
      // 真实工作流：generate 物化文件与 manifest → 用它门禁 apply。
      const generated = await runMigrateTest(
        ["generate", "MT000", "--out", dir],
        { environment: toolEnvironment, out: () => {} },
      );
      expect(generated.kind).toBe("generated");
      const manifestPath = join(dir, "MT000", "manifest.json");

      const applied = await runMigrateTest(
        ["migrate", "MT000", "--apply", "--manifest", manifestPath],
        { environment: toolEnvironment, out: () => {} },
      );
      // 重放安全：全新库是 applied，已应用过则是 up-to-date；两者都算收敛。
      expect(["applied", "up-to-date"]).toContain(applied.kind);
      if (applied.kind === "applied") {
        expect(applied.databaseName).toBe(assignedTarget.databaseName);
        expect(applied.endpoint).toBe(assignedTarget.endpoint);
        expect(applied.appliedSteps.map((step) => step.name)).toEqual([
          "0001_mt000_selfcheck_table.sql",
          "0002_mt000_selfcheck_assert.sql",
          "0003_mt000_selfcheck_drop.sql",
        ]);
      }

      // 独立连接验证最终状态：journal 记满 3 步、digest 与计划一致、自检表已删除。
      const client = postgres(assignedTarget.url, { max: 1 });
      try {
        const journal = await client`
          SELECT number, name, statement_digest
          FROM mt_task_migration_journal
          WHERE task_id = 'MT000'
          ORDER BY number
        `;
        expect(journal.map((row) => Number(row.number))).toEqual([1, 2, 3]);
        expect(journal.map((row) => row.name)).toEqual([
          "0001_mt000_selfcheck_table.sql",
          "0002_mt000_selfcheck_assert.sql",
          "0003_mt000_selfcheck_drop.sql",
        ]);
        const plan = buildPlan("MT000");
        for (let index = 0; index < 3; index += 1) {
          expect(journal[index].statement_digest).toBe(
            plan.steps[index].statementDigest,
          );
        }
        const leftover =
          await client`SELECT to_regclass('mt_tool_selfcheck') AS reg`;
        expect(leftover[0].reg).toBeNull();
      } finally {
        await client.end();
      }

      // 幂等：再次 apply 是显式 no-op，之后 dry-run 无待应用步骤。
      const again = await runMigrateTest(
        ["migrate", "MT000", "--apply", "--manifest", manifestPath],
        { environment: toolEnvironment, out: () => {} },
      );
      expect(again.kind).toBe("up-to-date");
      if (again.kind === "up-to-date") {
        expect(again.appliedCount).toBe(3);
      }

      const dryRun = await runMigrateTest(["migrate", "MT000"], {
        environment: toolEnvironment,
        out: () => {},
      });
      expect(dryRun.kind).toBe("dry-run");
      if (dryRun.kind === "dry-run") {
        expect(dryRun.appliedCount).toBe(3);
        expect(dryRun.pending).toHaveLength(0);
        expect(dryRun.databaseName).toBe(assignedTarget.databaseName);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
