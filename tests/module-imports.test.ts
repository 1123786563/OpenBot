import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "./support/e2e-compat";
import {
  runCheck,
  type CheckConfig,
  type ModuleRoot,
} from "../scripts/check-module-imports";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const realConfig = (): CheckConfig =>
  JSON.parse(
    readFileSync(join(REPO_ROOT, "tests/config/module-imports.json"), "utf8"),
  ) as CheckConfig;

/**
 * 建一个临时 fixture 树（不落业务目录），返回 cwd 与清理函数。
 * `files` 为 `仓库相对路径 -> 文件内容`。
 */
function makeFixture(
  files: Record<string, string>,
  _roots: ModuleRoot[],
  _scanRoots: string[],
): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "mod01-imports-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

describe("MOD01 import 检查器 — 正例", () => {
  test("全树扫描与基线一致（例外数不增，退出码语义 0）", () => {
    const config = realConfig();
    const result = runCheck(config, { cwd: REPO_ROOT });
    expect(result.configErrors).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.phantomExceptions).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.scannedFiles).toBeGreaterThan(1000);
  });

  test("真实入口文件（server/src/index.ts，assembly）的跨模块 import 不产生违规", () => {
    const config = realConfig();
    const result = runCheck(config, { cwd: REPO_ROOT });
    const fromEntry = result.violations.filter(
      (v) => v.source === "server/src/index.ts",
    );
    expect(fromEntry).toEqual([]);
  });

  test("同模块 import 通过", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/a.ts": `import { b } from "./b";\nexport const a = b;\n`,
        "modA/b.ts": `export const b = 1;\n`,
      },
      roots,
      ["modA"],
    );
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA"] });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("业务模块 import 基础设施（shared）通过", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "shared", module: "SHARED", kind: "infrastructure" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/a.ts": `import { x } from "../shared/x";\nexport const a = x;\n`,
        "shared/x.ts": `export const x = 1;\n`,
      },
      roots,
      ["modA", "shared"],
    );
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA", "shared"] });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("MOD01 import 检查器 — 反例", () => {
  test("新增跨模块深层引用触发违规（category: deep-reference）", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "modB", module: "MB", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/a.ts": `import { c } from "../modB/c";\nexport const a = c;\n`,
        "modB/c.ts": `export const c = 1;\n`,
      },
      roots,
      ["modA", "modB"],
    );
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA", "modB"] });
      expect(result.ok).toBe(false);
      expect(
        result.violations.some(
          (v) => v.category === "deep-reference" && v.target === "modB/c.ts",
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("新增模块级循环触发违规（category: cycle）", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "modB", module: "MB", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/a.ts": `import { c } from "../modB/c";\nexport const a = c;\n`,
        "modB/c.ts": `import { a } from "../modA/a";\nexport const c = a;\n`,
      },
      roots,
      ["modA", "modB"],
    );
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA", "modB"] });
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.category === "cycle")).toBe(true);
      expect(result.cycles.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("未知模块映射触发违规（category: unknown-mapping）", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/a.ts": `import { x } from "../unmapped/x";\nexport const a = x;\n`,
        "unmapped/x.ts": `export const x = 1;\n`,
      },
      roots,
      ["modA", "unmapped"],
    );
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA", "unmapped"] });
      expect(result.ok).toBe(false);
      expect(
        result.violations.some(
          (v) =>
            v.category === "unknown-mapping" && v.target === "unmapped/x.ts",
        ),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("幻影例外（基线范围扩大）触发违规", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      { "modA/a.ts": `export const a = 1;\n` },
      roots,
      ["modA"],
    );
    try {
      // 基线里放一条当前树并不存在的例外（源/目标均无对应边）→ 幻影例外。
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [
          {
            source: "modA/a.ts",
            target: "modA/missing.ts",
            reason: "不存在的例外",
            ticket: "MOD99",
            exit_condition: "x",
          },
        ],
      };
      const result = runCheck(config, { cwd, scanRoots: ["modA"] });
      expect(result.ok).toBe(false);
      expect(result.phantomExceptions.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

describe("MOD01 public 出口环", () => {
  for (const scenario of [
    { name: "双向 public 引用拒绝", reverse: "public", cycle: true },
    { name: "public 与深层引用混合环拒绝", reverse: "internal", cycle: true },
    { name: "单向 public 引用通过", reverse: null, cycle: false },
  ]) {
    test(scenario.name, () => {
      const roots: ModuleRoot[] = [
        { path: "modA", module: "MA", kind: "business" },
        { path: "modB", module: "MB", kind: "business" },
      ];
      const { cwd, cleanup } = makeFixture(
        {
          "modA/public.ts": `export const a = 1;`,
          "modA/internal.ts": `export const a = 1;`,
          "modA/use.ts": `import { b } from "../modB/public";`,
          "modB/public.ts": `export const b = 1;`,
          "modB/use.ts": scenario.reverse
            ? `import { a } from "../modA/${scenario.reverse}";`
            : `export const b = 1;`,
        },
        roots,
        ["modA", "modB"],
      );
      try {
        const result = runCheck(
          { version: 1, moduleRoots: roots, exceptions: [] },
          { cwd, scanRoots: ["modA", "modB"] },
        );
        expect(result.ok).toBe(!scenario.cycle);
        expect(result.violations.map((v) => v.category)).toEqual(
          scenario.cycle ? ["cycle", "cycle"] : [],
        );
        expect(result.cycles.length > 0).toBe(scenario.cycle);
        expect(result.phantomExceptions).toEqual([]);
      } finally {
        cleanup();
      }
    });
  }

  test("深层引用例外在新增反向 public 边时变为幻影，移除后恢复消费", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "modB", module: "MB", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/public.ts": `export const a = 1;`,
        "modA/use.ts": `import { b } from "../modB/internal";`,
        "modB/internal.ts": `export const b = 1;`,
        "modB/use.ts": `import { a } from "../modA/public";`,
      },
      roots,
      ["modA", "modB"],
    );
    const exception = {
      source: "modA/use.ts",
      target: "modB/internal.ts",
      category: "deep-reference",
      reason: "存量引用",
      ticket: "MOD99",
      exit_condition: "迁移出口",
    };
    try {
      const config: CheckConfig = {
        version: 1,
        moduleRoots: roots,
        exceptions: [exception],
      };
      const options = { cwd, scanRoots: ["modA", "modB"] };
      const cyclic = runCheck(config, options);
      expect(cyclic.ok).toBe(false);
      expect(cyclic.violations.map((v) => v.category)).toEqual([
        "cycle",
        "cycle",
      ]);
      expect(cyclic.cycles.length).toBeGreaterThan(0);
      expect(cyclic.phantomExceptions).toEqual([exception]);

      writeFileSync(join(cwd, "modB/use.ts"), `export const b = 1;`);
      const oneWay = runCheck(config, options);
      expect(oneWay.ok).toBe(true);
      expect(oneWay.violations).toEqual([]);
      expect(oneWay.cycles).toEqual([]);
      expect(oneWay.phantomExceptions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("integration 出口双向引用形成环", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "modB", module: "MB", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/integration.ts": `export const a = 1;`,
        "modA/use.ts": `import { b } from "../modB/integration";`,
        "modB/integration.ts": `export const b = 1;`,
        "modB/use.ts": `import { a } from "../modA/integration";`,
      },
      roots,
      ["modA", "modB"],
    );
    try {
      const result = runCheck(
        { version: 1, moduleRoots: roots, exceptions: [] },
        { cwd, scanRoots: ["modA", "modB"] },
      );
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.category)).toEqual([
        "cycle",
        "cycle",
      ]);
      expect(result.cycles.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("三个模块通过 public 出口形成环", () => {
    const roots: ModuleRoot[] = [
      { path: "modA", module: "MA", kind: "business" },
      { path: "modB", module: "MB", kind: "business" },
      { path: "modC", module: "MC", kind: "business" },
    ];
    const { cwd, cleanup } = makeFixture(
      {
        "modA/public.ts": `export const a = 1;`,
        "modA/use.ts": `import { b } from "../modB/public";`,
        "modB/public.ts": `export const b = 1;`,
        "modB/use.ts": `import { c } from "../modC/public";`,
        "modC/public.ts": `export const c = 1;`,
        "modC/use.ts": `import { a } from "../modA/public";`,
      },
      roots,
      ["modA", "modB", "modC"],
    );
    try {
      const result = runCheck(
        { version: 1, moduleRoots: roots, exceptions: [] },
        { cwd, scanRoots: ["modA", "modB", "modC"] },
      );
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.category)).toEqual([
        "cycle",
        "cycle",
        "cycle",
      ]);
      expect(result.cycles.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
