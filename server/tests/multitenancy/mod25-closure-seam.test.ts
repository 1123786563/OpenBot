// server/tests/multitenancy/mod25-closure-seam.test.ts
// MOD25（Issue #645，根 #620）：收口钉套件——例外收窄、簿记、结构收敛、AR 工件与
// 移交项的现状钉，native 形（e2e-compat、根入口收集、零数据库、manifest 零触碰）。
//
// 全部用例用 node:fs 读源文本/JSON 做源级钉，不装载被测模块（零运行时耦合）：
//   D1  收窄面钉：改道完成的 source|target 对（不在例外簿者）源文件零内件 import
//       残留 + 出口 import 在位（样本 ≥10，按对排序取全量删除集的前 12 条即够）。
//   D2  例外簿钉：redirectable-set.json 与 module-imports.json 程序化对照——已删对
//       零残留、未删对（skip 集）仍在位；checker 的 category 枚举校验与 --baseline
//       报错分支在位（M-2 源扫钉）。
//   D3  结构收敛钉：billing/payments 工厂回退常量各恰 1 处、app.ts 命名类型在位且
//       http.ts 引用同名、runtime.ts visibility 单构造（M-1/M-4/M-5/M-9 源扫钉）。
//   D4  AR 工件钉：acceptance-evidence.md 存在 + 恰 18 行 AR 映射 + 每行含载体路径与
//       定性词（厚/薄）。
//   D5  移交钉：M-3/M-6/M-7/M-8 四 ID 在 AR 工件具名出现。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";

const repoDir = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${repoDir}${rel}`, "utf8");

const cfg = JSON.parse(read("tests/config/module-imports.json")) as {
  moduleRoots: { path: string; module: string }[];
  exceptions: { source: string; target: string; category?: string }[];
};
const redirectablePath =
  "docs/plans/2026-10-23-issue620-modular/MOD25-redirectable-set.json";
const hasSet = existsSync(`${repoDir}${redirectablePath}`);
const redirectable: { source: string; target: string }[] = hasSet
  ? JSON.parse(read(redirectablePath)).redirectable
  : [];

// 与 checker 同形的最长前缀归属。
const rootsSorted = [...cfg.moduleRoots].sort(
  (a, b) => b.path.length - a.path.length,
);
const attribute = (rel: string) =>
  rootsSorted.find((r) => rel === r.path || rel.startsWith(`${r.path}/`)) ??
  null;
const livePairs = new Set(
  cfg.exceptions.map((e) => `${e.source}\u0000${e.target}`),
);

/** 源文件目录 + 相对说明符 → 仓库相对路径（无扩展名比较用）。 */
function foldSpec(fromRel: string, spec: string): string {
  const base = fromRel.split("/").slice(0, -1);
  const acc: string[] = [];
  for (const p of [...base, ...spec.split("/")]) {
    if (p === "" || p === ".") continue;
    if (p === "..") acc.pop();
    else acc.push(p);
  }
  return acc.join("/");
}
/** 源文件里折叠后等于 noExt 的 import/export 行。 */
function importLinesTo(code: string, fromRel: string, noExt: string): string[] {
  return code.split("\n").filter((line) => {
    if (!/(?:^|\s)(?:import|export)\b/.test(line)) return false;
    const spec = line.match(/from\s*['"](\.[^'"]+)['"]/)?.[1];
    return spec !== undefined && foldSpec(fromRel, spec) === noExt;
  });
}

describe("MOD25 D1：收窄面——已改道对零内件 import 残留 + 出口 import 在位", () => {
  test("附件在位且 148 条可改道集完整", () => {
    expect(hasSet).toBe(true);
    expect(redirectable.length).toBe(148);
  });

  test("已删对（≥10 样本）：源文件不再 import 内件目标，且 import 了同模块出口", () => {
    const redirected = redirectable
      .filter((e) => !livePairs.has(`${e.source}\u0000${e.target}`))
      .sort((a, b) =>
        `${a.source}${a.target}`.localeCompare(`${b.source}${b.target}`),
      );
    expect(redirected.length >= 10).toBe(true);
    for (const e of redirected.slice(0, 12)) {
      const code = read(e.source);
      // 折叠每条相对 import 说明符到仓库相对路径，任何解析=内件目标者须零残留。
      const offenders = importLinesTo(
        code,
        e.source,
        e.target.replace(/\.tsx?$/, ""),
      );
      expect(offenders).toEqual([]);
      // 出口 import 在位：源文件含折叠后解析到该模块 public.ts 的 from 子句。
      const targetModule = attribute(e.target);
      expect(targetModule).not.toBeNull();
      expect(
        importLinesTo(code, e.source, `${targetModule!.path}/public`).length >=
          1,
      ).toBe(true);
    }
  });

  test("kind 保留：出口 import 行若为 import 形态，type-only 语义仍以 import type 承载", () => {
    // 对 12 样本：折叠到出口的 import 行，凡带 `import type` 头者计数；至少 1 条，
    // 证明批量改道保留 kind 的路径真实存在（type-only 批次）。
    const redirected = redirectable
      .filter((e) => !livePairs.has(`${e.source}\u0000${e.target}`))
      .slice(0, 12);
    let typeChecked = 0;
    for (const e of redirected) {
      const code = read(e.source);
      const gateLines = importLinesTo(
        code,
        e.source,
        `${attribute(e.target)!.path}/public`,
      );
      if (gateLines.some((l) => /^\s*import type\b/.test(l))) typeChecked += 1;
    }
    expect(typeChecked >= 1).toBe(true);
  });
});

describe("MOD25 D2：例外簿与 checker 校验面", () => {
  test("已删对零残留：例外簿中不存在任何「source|target 属改道集且该对已被执行」的条目", () => {
    const redirected = redirectable.filter(
      (e) => !livePairs.has(`${e.source}\u0000${e.target}`),
    );
    // 一致性自证：删除数 = 148 − 在簿数（skip 集仍在簿=未动，合法）。
    const stillLive = redirectable.length - redirected.length;
    expect(redirected.length).toBe(106);
    expect(stillLive).toBe(42);
  });

  test("例外簿 category 全部落在合法枚举 {cycle, deep-reference}", () => {
    const legal = new Set(["cycle", "deep-reference"]);
    const bad = cfg.exceptions.filter(
      (e) => e.category !== undefined && !legal.has(e.category),
    );
    expect(bad).toEqual([]);
  });

  test("M-2 源扫钉：checker 含 category 枚举校验与 --baseline configErrors 拒收敛", () => {
    const checker = read("scripts/check-module-imports.ts");
    expect(
      checker.includes(
        'const LEGAL_EXCEPTION_CATEGORIES = ["cycle", "deep-reference"]',
      ),
    ).toBe(true);
    expect(
      checker.includes("exception category 非法") &&
        checker.includes("LEGAL_EXCEPTION_CATEGORIES.includes"),
    ).toBe(true);
    expect(checker.includes("--baseline 拒绝在非法配置上收敛基线")).toBe(true);
  });

  test("簿记读数钉：例外 703、环目标面≤45 由 checker 实跑保证，此处钉簿数与零幻影结构", () => {
    // 703 = 715（#620 收口）− 15（#732 旧记忆路径删除后的幻影）+ 12（环解开改类 deep-reference）
    // + 2（memory-service 新边）+ 1（#732 恢复研究默认的 M03→AUTOMATION 公开出口环边）；
    // 真 0 违规/0 幻影由 scripts/check-module-imports.ts 与 tests/module-imports.test.ts 保证。
    expect(cfg.exceptions.length).toBe(703);
    // source|target 去重后无重复条目（簿记自洽）。
    const keys = cfg.exceptions.map((e) => `${e.source}\u0000${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("MOD25 D3：OCR r2 结构收敛（M-1/M-4/M-5/M-9）", () => {
  test("M-4：billing/routes.ts 回退常量定义恰 1 处且五站点引用收敛名", () => {
    const code = read("server/src/billing/routes.ts");
    const defs = code
      .split("\n")
      .filter((l) => /^\s*const resolvePersonalPayer =/.test(l));
    expect(defs.length).toBe(1);
    expect(
      code.match(/resolvePersonalPayer\(context\.var\.actor\)/g)?.length,
    ).toBe(5);
    // 工厂外仅存 billingReadScopeOf 的自有参数臂（计划 M-4=「6+1 处重复收敛」，
    // 文件级回退表达式两处：收敛定义 1 + 自有参数臂 1，无第三处）。
    expect(
      code
        .split("\n")
        .filter((l) => l.includes("?? resolvePayerForPersonalUser")).length,
    ).toBe(2);
  });

  test("M-5：payments/routes.ts 回退常量定义恰 1 处且站点收敛", () => {
    const code = read("server/src/billing/payments/routes.ts");
    expect(
      code.split("\n").filter((l) => /^\s*const resolvePersonalPayer =/.test(l))
        .length,
    ).toBe(1);
    expect(
      code.match(/resolvePersonalPayer\(context\.var\.actor\)/g)?.length,
    ).toBe(1);
    expect(
      code
        .split("\n")
        .filter((l) => l.includes("?? resolvePayerForPersonalUser")).length,
    ).toBe(1);
  });

  test("M-1：app.ts 命名类型在位，http.ts 同名字段引用同一声明且零内联孪生体", () => {
    const app = read("server/src/app.ts");
    const http = read("server/src/assembly/http.ts");
    expect(app.includes("export interface CoworkerSeams {")).toBe(true);
    expect(app.includes("export interface OpenMuseSeams {")).toBe(true);
    expect(app.includes("coworker?: CoworkerSeams,")).toBe(true);
    expect(app.includes("openMuseSeams?: OpenMuseSeams,")).toBe(true);
    expect(http.includes("coworker?: CoworkerSeams;")).toBe(true);
    expect(http.includes("openMuseSeams?: OpenMuseSeams;")).toBe(true);
    expect(
      http.includes("CoworkerSeams,") && http.includes("OpenMuseSeams,"),
    ).toBe(true);
    // 孪生体内联形态清零：http.ts 不再有 coworker?: { 展开
    expect(http.includes("coworker?: {")).toBe(false);
    expect(http.includes("openMuseSeams?: {")).toBe(false);
  });

  test("M-9：runtime.ts company-finance visibility 恰 1 处构造、2 处共享引用", () => {
    const code = read("server/src/assembly/runtime.ts");
    expect(
      code
        .split("\n")
        .filter((l) => l.includes("createCompanyFinanceVisibilityService({"))
        .length,
    ).toBe(1);
    expect(code.match(/finance: companyFinanceVisibility,/g)?.length).toBe(2);
  });
});

describe("MOD25 D4/D5：AR 工件与移交钉", () => {
  const evPath = "docs/plans/modular-architecture/acceptance-evidence.md";

  test("acceptance-evidence.md 存在且恰 18 行 AR 映射", () => {
    expect(existsSync(`${repoDir}${evPath}`)).toBe(true);
    const rows = read(evPath)
      .split("\n")
      .filter((l) => /^\| AR\d\d /.test(l));
    expect(rows.length).toBe(18);
  });

  test("每行含证据载体路径与覆盖定性词（厚/薄）", () => {
    const rows = read(evPath)
      .split("\n")
      .filter((l) => /^\| AR\d\d /.test(l));
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      expect(cells[1].startsWith("AR")).toBe(true);
      expect(cells[3].includes(".test.") || cells[3].includes("scripts/")).toBe(
        true,
      );
      expect(/厚|薄/.test(cells[4])).toBe(true);
    }
  });

  test("AR05/AR10 按事实标薄（不伪装）", () => {
    const doc = read(evPath);
    const ar05 = doc.split("\n").find((l) => l.startsWith("| AR05 ")) ?? "";
    const ar10 = doc.split("\n").find((l) => l.startsWith("| AR10 ")) ?? "";
    expect(ar05.includes("薄")).toBe(true);
    expect(ar10.includes("薄")).toBe(true);
  });

  test("D5 移交钉：M-3/M-6/M-7/M-8 在工件具名出现且带原指派", () => {
    const doc = read(evPath);
    for (const [id, assignee] of [
      ["M-3", "日志纪律"],
      ["M-6", "lifecycle"],
      ["M-7", "接线装配"],
      ["M-8", "mastra"],
    ]) {
      expect(doc.includes(id)).toBe(true);
      expect(doc.includes(assignee)).toBe(true);
    }
  });
});
