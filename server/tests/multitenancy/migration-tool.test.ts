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

import { describe, expect, test } from "bun:test";
import {
  ALLOWED_TASK_IDS,
  buildPlan,
  manifestFor,
  runMigrateTest,
  TASKS,
  validateJournalNumbers,
  validatePlanNumbering,
} from "../../scripts/multitenancy/migrate-test";

// 本任务专属测试库（brief 指定；真实 apply 只允许打到它）。
const ASSIGNED_TEST_DATABASE_URL =
  "postgres://postgres@127.0.0.1:55433/openbot_enterprise_mt003_test";

// 合法环境中故意保留 DATABASE_URL 诱饵：工具只认 TEST_DATABASE_URL，
// 任何回退都必须被这些测试抓住。
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
}

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
    expect(ALLOWED_TASK_IDS).toEqual(["MT000"]);
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

function fakeConnection(journalRows: Array<{ number: number }> = []) {
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
    const connection = fakeConnection([{ number: 1 }]);
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
    const { deps, connection } = applyDeps(
      { "/tmp/m.json": CORRECT_MANIFEST },
      [{ number: 1 }, { number: 2 }, { number: 3 }],
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
// 真实 apply：只允许打到本任务专属测试库（127.0.0.1:55433/
// openbot_enterprise_mt003_test）；其它环境一律显式跳过，不谎称通过。
// ---------------------------------------------------------------------------

import postgres from "postgres";
import { resolveTestDatabaseTarget } from "../../scripts/multitenancy/migrate-test";

const assignedDatabase = resolveTestDatabaseTarget(process.env);
const hasAssignedDatabase =
  assignedDatabase.ok &&
  assignedDatabase.target.endpoint === "127.0.0.1:55433" &&
  assignedDatabase.target.databaseName === "openbot_enterprise_mt003_test";
const dbTest = hasAssignedDatabase ? test : test.skip;
const skipNote = hasAssignedDatabase
  ? ""
  : " [skipped: TEST_DATABASE_URL is not the assigned MT003 test database 127.0.0.1:55433/openbot_enterprise_mt003_test]";

dbTest(
  `applies MT000 end-to-end on the assigned dedicated test database${skipNote}`,
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mt003-real-"));
    try {
      // 真实工作流：generate 物化文件与 manifest → 用它门禁 apply。
      const generated = await runMigrateTest(
        ["generate", "MT000", "--out", dir],
        { environment: process.env, out: () => {} },
      );
      expect(generated.kind).toBe("generated");
      const manifestPath = join(dir, "MT000", "manifest.json");

      const applied = await runMigrateTest(
        ["migrate", "MT000", "--apply", "--manifest", manifestPath],
        { environment: process.env, out: () => {} },
      );
      // 重放安全：全新库是 applied，已应用过则是 up-to-date；两者都算收敛。
      expect(["applied", "up-to-date"]).toContain(applied.kind);
      if (applied.kind === "applied") {
        expect(applied.databaseName).toBe("openbot_enterprise_mt003_test");
        expect(applied.endpoint).toBe("127.0.0.1:55433");
        expect(applied.appliedSteps.map((step) => step.name)).toEqual([
          "0001_mt000_selfcheck_table.sql",
          "0002_mt000_selfcheck_assert.sql",
          "0003_mt000_selfcheck_drop.sql",
        ]);
      }

      // 独立连接验证最终状态：journal 记满 3 步、自检表已删除。
      const client = postgres(ASSIGNED_TEST_DATABASE_URL, { max: 1 });
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
        { environment: process.env, out: () => {} },
      );
      expect(again.kind).toBe("up-to-date");
      if (again.kind === "up-to-date") {
        expect(again.appliedCount).toBe(3);
      }

      const dryRun = await runMigrateTest(["migrate", "MT000"], {
        environment: process.env,
        out: () => {},
      });
      expect(dryRun.kind).toBe("dry-run");
      if (dryRun.kind === "dry-run") {
        expect(dryRun.appliedCount).toBe(3);
        expect(dryRun.pending).toHaveLength(0);
        expect(dryRun.databaseName).toBe("openbot_enterprise_mt003_test");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
