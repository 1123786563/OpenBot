#!/usr/bin/env bun
/**
 * MOD01 增量 import 检查器。
 *
 * 扫描 `server/`、`app/`、`worker/`、`toolkit/`、`shared/` 的源文件 import（relative、
 * tsconfig alias、workspace 包引用、`import type` / inline type-only import），按
 * `tests/config/module-imports.json` 的模块根路径 → Module ID 映射判定三类违规：
 *
 *   ① 未知模块映射：import 目标解析到一个源文件，但该文件不属于任何模块根；
 *   ② 跨 Module 深层引用：源/目标分属两个业务 Module，且目标是对方非 public/integration 出口；
 *   ③ 模块级 import 环：把业务 Module 之间的 import 聚合后成环。
 *
 * 退出语义：
 *   - 发现新增违规（不在例外基线内；例外按 source+target+category 三键精确匹配） → 退出码非零；
 *   - 例外基线数量/范围扩大（基线条目不对应任何实际违规，或出现幻影条目） → 退出码非零；
 *   - JSON 不自洽（字段缺失/非法 kind/同路径 Module 冲突） → 退出码非零；嵌套前缀的
 *     moduleRoot 不算冲突，按 longest-prefix 归属规则消解；
 *   - 与基线完全一致 → 退出码 0。
 *
 * CLI 形态：
 *   bun run scripts/check-module-imports.ts [--config <path>] [--baseline] [--json]
 *
 *   --baseline  打印当前树收敛出的基线 JSON（moduleRoots + exceptions），不写盘。
 *   --json      以 JSON 输出检查结果，供机器消费。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ESM 可移植形态（Bun/Node 通用）：模块需能被根 e2e 入口在 Node target 下加载（ADR 0008）。
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type ModuleKind = "business" | "infrastructure" | "assembly";

export interface ModuleRoot {
  /** 模块根路径（相对仓库根，正向斜杠；目录不加尾部斜杠，文件带扩展名）。 */
  path: string;
  /** Module ID（M01–M12 / 扩展 / SHARED / TOOLKIT / TECH / SCHEMA / ASSEMBLY / WORKER）。 */
  module: string;
  kind: ModuleKind;
}

interface Exception {
  source: string;
  target: string;
  /** 归属后续票：按 migration-plan 工作包映射到 MODxx（或 TBD + 说明）。 */
  ticket: string;
  /** 退出条件：该例外可被移除的可观察条件。 */
  exit_condition: string;
  /** 一行理由。 */
  reason: string;
  /** 判定类别：deep-reference | cycle。匹配键之一：category 与实际判定不符的条目按幻影/违规处理。 */
  category?: string;
}

export interface CheckConfig {
  version: number;
  moduleRoots: ModuleRoot[];
  exceptions: Exception[];
}

type ViolationCategory = "deep-reference" | "cycle" | "unknown-mapping";

/** 例外条目 category 的合法枚举（unknown-mapping 只出现在违规侧，从不进例外基线）。 */
const LEGAL_EXCEPTION_CATEGORIES = ["cycle", "deep-reference"] as const;

interface Violation {
  category: ViolationCategory;
  source: string;
  target: string;
  sourceModule: string | null;
  targetModule: string | null;
  detail: string;
}

interface CheckResult {
  ok: boolean;
  scannedFiles: number;
  scannedEdges: number;
  violations: Violation[];
  /** 基线中不对应任何实际违规的幻影条目（= 例外范围扩大）。 */
  phantomExceptions: Exception[];
  /** 模块级环（每条为环上模块 ID 序列，如 ["M04","M05","M04"]）。 */
  cycles: string[][];
  /** 配置自洽性错误。 */
  configErrors: string[];
  /** 解析/跳过计数，供报告核对。 */
  skipped: {
    external: number;
    asset: number;
    unresolved: number;
    outsideRoots: number;
  };
  /** 未解析的 import 说明符（调试/报告用）。 */
  unresolvedSpecs: string[];
  /** 解析到扫描根之外源文件的 import（调试/报告用）。 */
  outsideSpecs: string[];
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

function toRel(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "");
}

/** 把相对目录 + 相对说明符折叠成仓库相对路径（无尾斜杠）。 */
function joinRel(dirRel: string, spec: string): string {
  const base = dirRel === "." ? [] : dirRel.split("/");
  const parts = spec.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

// ---------------------------------------------------------------------------
// 源码扫描
// ---------------------------------------------------------------------------

const EXCLUDE_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".output",
  "coverage",
  "__tests__",
  ".archive",
]);

const EXCLUDE_FILE_RE =
  /(^|\/)(routeTree\.gen\.(ts|tsx)|vite-env\.d\.ts)$|\.(test|spec)\.(ts|tsx)$|\.d\.ts$/;

/**
 * 不扫描的目录前缀（仓库相对）。`server/assets` 是内嵌的 Next.js/shadcn 模板
 * （Craft 预览生成脚手架），不是 OpenBot 自身模块代码，其 `@/` 别名指向模板自身而非
 * 本仓库，扫描只会产生噪声。`server/tests` 是测试代码，仅作为测试 Seam 的 import 目标
 * 被归属（见 config 中 `server/tests` → TECH），不作为源文件扫描。
 */
const SCAN_EXCLUDE_PREFIXES = ["server/assets", "server/tests"];

function listSourceFiles(cwd: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const rootAbs = resolve(cwd, root);
    if (!existsSync(rootAbs)) continue;
    walk(rootAbs, cwd, out);
  }
  return out
    .filter((rel) => !SCAN_EXCLUDE_PREFIXES.some((p) => rel.startsWith(p)))
    .sort();
}

function walk(absDir: string, cwd: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = resolve(absDir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (EXCLUDE_DIR_SEGMENTS.has(name)) continue;
      if (name === "tests" || name === "test") continue;
      walk(abs, cwd, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      const rel = toRel(abs.slice(cwd.length + 1));
      if (EXCLUDE_FILE_RE.test(rel)) continue;
      out.push(rel);
    }
  }
}

// ---------------------------------------------------------------------------
// gitignore 感知（扫描面与干净树两态一致）
// ---------------------------------------------------------------------------

/**
 * 查询候选源文件中哪些被 .gitignore 覆盖。构建期生成物（如 pretest 物化的
 * `app/src/lib/generated/application-config.ts`）存在与否不应改变检查结果：干净树上
 * 它不存在，跑过测试的树上它出现。以 `git check-ignore` 自身的判定为准，批查一次。
 * 非 git 仓库（测试 fixture 的临时目录）或 git 不可用时返回空集，等价于无忽略。
 */
function gitIgnoredPaths(cwd: string, candidates: string[]): Set<string> {
  if (candidates.length === 0) return new Set();
  try {
    const res = spawnSync(
      "git",
      ["-c", "core.quotepath=off", "check-ignore", "--stdin"],
      {
        cwd,
        input: candidates.join("\n"),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    // status 0 = 存在被忽略路径；1 = 均不忽略；其余（如非 git 仓库）视为无忽略。
    if (res.error || res.status === null || res.status > 1) return new Set();
    return new Set((res.stdout ?? "").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// import 解析（字符串感知地剥离注释后正则匹配）
// ---------------------------------------------------------------------------

function stripComments(code: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (quote) {
      out.push(ch);
      if (ch === "\\") {
        out.push(next ?? "");
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) {
        out.push(code[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      i += 2;
      out.push(" ");
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function parseImportSpecifiers(code: string): string[] {
  const clean = stripComments(code);
  const specs = new Set<string>();
  // `import ... from "..."`、`import type ... from "..."`、`export ... from "..."`
  const fromRe =
    /(?:^|[;}\n])\s*(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]/gs;
  // 副作用 import "..."（无 from）
  const sideRe = /(?:^|[;}\n])\s*import\s*['"]([^'"]+)['"]/gs;
  // 动态 import("...")
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let m: RegExpExecArray | null = fromRe.exec(clean);
  while (m !== null) {
    specs.add(m[1]);
    m = fromRe.exec(clean);
  }
  m = sideRe.exec(clean);
  while (m !== null) {
    specs.add(m[1]);
    m = sideRe.exec(clean);
  }
  m = dynRe.exec(clean);
  while (m !== null) {
    specs.add(m[1]);
    m = dynRe.exec(clean);
  }
  return [...specs];
}

// ---------------------------------------------------------------------------
// 说明符解析
// ---------------------------------------------------------------------------

type Resolved =
  | { kind: "external" }
  | { kind: "asset" }
  | { kind: "unresolved"; spec: string }
  | { kind: "outside" }
  | { kind: "source"; path: string };

const WORKSPACE_PACKAGES: Record<string, string> = {
  "@openbot/shared": "shared",
  "@openbot/toolkit": "toolkit/src",
};

function resolveSpecifier(
  cwd: string,
  fromRel: string,
  spec: string,
  scanRoots: string[],
  ignoredPaths: Set<string>,
): Resolved {
  // tsconfig alias（仅 app 使用 @/* → app/src/*）
  if (spec.startsWith("@/")) {
    if (fromRel.startsWith("app/")) {
      return resolveFile(
        cwd,
        `app/src/${spec.slice(2)}`,
        scanRoots,
        ignoredPaths,
      );
    }
    return { kind: "unresolved", spec };
  }

  // workspace 包引用
  for (const [pkg, base] of Object.entries(WORKSPACE_PACKAGES)) {
    if (spec === pkg) return { kind: "unresolved", spec };
    if (spec.startsWith(`${pkg}/`)) {
      return resolveFile(
        cwd,
        `${base}/${spec.slice(pkg.length + 1)}`,
        scanRoots,
        ignoredPaths,
      );
    }
  }

  // 相对引用
  if (spec.startsWith(".")) {
    const dirRel = dirname(fromRel);
    const target = joinRel(dirRel, spec);
    return resolveFile(cwd, target, scanRoots, ignoredPaths);
  }

  // 其余视为外部包（node_modules / node: 内置 / 绝对 URL）
  return { kind: "external" };
}

function resolveFile(
  cwd: string,
  baseRel: string,
  scanRoots: string[],
  ignoredPaths: Set<string>,
): Resolved {
  const candidates: string[] = [];
  if (/\.(ts|tsx)$/.test(baseRel)) candidates.push(baseRel);
  else if (/\.(js|mjs)$/.test(baseRel)) {
    candidates.push(baseRel.replace(/\.(js|mjs)$/, ".ts"));
    candidates.push(baseRel.replace(/\.(js|mjs)$/, ".tsx"));
  } else if (
    /\.(json|css|scss|sass|less|html|svg|png|jpg|jpeg|gif|woff2?|ttf)$/.test(
      baseRel,
    )
  ) {
    candidates.push(baseRel);
  } else {
    candidates.push(
      `${baseRel}.ts`,
      `${baseRel}.tsx`,
      `${baseRel}/index.ts`,
      `${baseRel}/index.tsx`,
    );
  }

  for (const cand of candidates) {
    const abs = resolve(cwd, cand);
    if (existsSync(abs)) {
      if (/\.(ts|tsx)$/.test(cand)) {
        const rel = toRel(cand);
        // gitignored 生成物按不存在处理，保证干净树/脏树两态数字一致。
        if (ignoredPaths.has(rel)) continue;
        if (isInsideScanRoots(rel, scanRoots))
          return { kind: "source", path: rel };
        return { kind: "outside" };
      }
      return { kind: "asset" };
    }
  }
  return { kind: "unresolved", spec: baseRel };
}

const SCAN_ROOTS = ["server", "app", "worker", "toolkit", "shared"];

function isInsideScanRoots(rel: string, scanRoots: string[]): boolean {
  return scanRoots.some((r) => rel === r || rel.startsWith(`${r}/`));
}

// ---------------------------------------------------------------------------
// 模块归属
// ---------------------------------------------------------------------------

function attribute(roots: ModuleRoot[], rel: string): ModuleRoot | null {
  let best: ModuleRoot | null = null;
  for (const root of roots) {
    const rp = toRel(root.path);
    if (rel === rp || rel.startsWith(`${rp}/`)) {
      if (!best || rp.length > toRel(best.path).length) best = root;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 配置自洽性
// ---------------------------------------------------------------------------

function validateConfig(config: CheckConfig): string[] {
  const errors: string[] = [];
  if (typeof config.version !== "number")
    errors.push("config.version 缺失或非数字");
  if (!Array.isArray(config.moduleRoots) || config.moduleRoots.length === 0) {
    errors.push("config.moduleRoots 为空");
  } else {
    const seen = new Map<string, string>();
    for (const r of config.moduleRoots) {
      if (!r.path || !r.module) {
        errors.push(`moduleRoot 缺少 path/module: ${JSON.stringify(r)}`);
        continue;
      }
      if (!["business", "infrastructure", "assembly"].includes(r.kind)) {
        errors.push(`moduleRoot ${r.path} 的 kind 非法: ${r.kind}`);
      }
      const prev = seen.get(r.path);
      if (prev && prev !== r.module) {
        errors.push(
          `moduleRoot 路径重复且 Module 冲突: ${r.path} -> ${prev} vs ${r.module}`,
        );
      }
      seen.set(r.path, r.module);
    }
  }
  if (!Array.isArray(config.exceptions)) {
    errors.push("config.exceptions 缺失");
  } else {
    for (const e of config.exceptions) {
      for (const k of [
        "source",
        "target",
        "ticket",
        "exit_condition",
        "reason",
      ] as const) {
        if (typeof e[k] !== "string" || e[k].trim() === "") {
          errors.push(`exception 字段 ${k} 缺失: ${JSON.stringify(e)}`);
        }
      }
      if (e.source === e.target) errors.push(`exception 自引用: ${e.source}`);
      if (
        e.category !== undefined &&
        !LEGAL_EXCEPTION_CATEGORIES.includes(
          e.category as (typeof LEGAL_EXCEPTION_CATEGORIES)[number],
        )
      ) {
        errors.push(
          `exception category 非法: ${e.category}（${e.source} -> ${e.target}）`,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 主检查
// ---------------------------------------------------------------------------

export function runCheck(
  config: CheckConfig,
  options: { cwd: string; scanRoots?: string[]; ignoreExceptions?: boolean },
): CheckResult {
  const cwd = options.cwd;
  const scanRoots = options.scanRoots ?? SCAN_ROOTS;
  const skipped = { external: 0, asset: 0, unresolved: 0, outsideRoots: 0 };
  const unresolvedSpecs: string[] = [];
  const outsideSpecs: string[] = [];
  const configErrors = validateConfig(config);

  const candidates = listSourceFiles(cwd, scanRoots);
  const ignoredPaths = gitIgnoredPaths(cwd, candidates);
  const files = candidates.filter((rel) => !ignoredPaths.has(rel));
  const byModule = new Map<string, ModuleRoot>();
  for (const r of config.moduleRoots) byModule.set(r.module, r);

  const businessEdges = new Map<
    string,
    { source: string; target: string; sm: string; tm: string }
  >();
  const unknownTargets: { source: string; target: string }[] = [];
  const unmappedSources: string[] = [];

  // 模块级边（用于环判定）
  const moduleEdges = new Map<string, { from: string; to: string }>();

  let edgeCount = 0;

  for (const file of files) {
    const abs = resolve(cwd, file);
    const code = readFileSync(abs, "utf8");
    const specs = parseImportSpecifiers(code);
    const srcRoot = attribute(config.moduleRoots, file);
    if (!srcRoot) {
      unmappedSources.push(file);
      continue;
    }

    for (const spec of specs) {
      edgeCount += 1;
      const res = resolveSpecifier(cwd, file, spec, scanRoots, ignoredPaths);
      if (res.kind === "external") {
        skipped.external += 1;
        continue;
      }
      if (res.kind === "asset") {
        skipped.asset += 1;
        continue;
      }
      if (res.kind === "unresolved") {
        skipped.unresolved += 1;
        unresolvedSpecs.push(`${file} -> ${spec}`);
        continue;
      }
      if (res.kind === "outside") {
        skipped.outsideRoots += 1;
        outsideSpecs.push(`${file} -> ${spec}`);
        continue;
      }

      const targetRel = res.path;
      const tgtRoot = attribute(config.moduleRoots, targetRel);
      if (!tgtRoot) {
        unknownTargets.push({ source: file, target: targetRel });
        continue;
      }

      // 只有两个「业务 Module」之间的边才受边界约束。
      if (srcRoot.kind !== "business" || tgtRoot.kind !== "business") continue;
      if (srcRoot.module === tgtRoot.module) continue;

      const key = `${file}\u0000${targetRel}`;
      businessEdges.set(key, {
        source: file,
        target: targetRel,
        sm: srcRoot.module,
        tm: tgtRoot.module,
      });
      const mkey = `${srcRoot.module}\u0000${tgtRoot.module}`;
      moduleEdges.set(mkey, { from: srcRoot.module, to: tgtRoot.module });
    }
  }

  // 环判定：业务 Module 图内，边 u→v 属于环 ⟺ v 可达 u。
  const adj = new Map<string, Set<string>>();
  for (const { from, to } of moduleEdges.values()) {
    let targets = adj.get(from);
    if (!targets) {
      targets = new Set();
      adj.set(from, targets);
    }
    targets.add(to);
  }
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) break;
      if (cur === goal) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
    }
    return false;
  };
  const cyclicModuleEdges = new Set<string>();
  for (const { from, to } of moduleEdges.values()) {
    if (reaches(to, from)) cyclicModuleEdges.add(`${from}\u0000${to}`);
  }

  // 汇总违规
  const violations: Violation[] = [];
  // 例外按 source+target+category 三键精确匹配：category 漂移（如环解开后以
  // deep-reference 语义续存的旧环条目）不再命中，落违规；类别不再对应任何实际边的
  // 条目落幻影。
  const baselineEdges = new Map<string, Exception>();
  for (const e of config.exceptions) {
    baselineEdges.set(
      `${e.source}\u0000${e.target}\u0000${e.category ?? ""}`,
      e,
    );
  }

  for (const e of businessEdges.values()) {
    const mkey = `${e.sm}\u0000${e.tm}`;
    const isCycle = cyclicModuleEdges.has(mkey);
    // 公开出口参与环判定；单向公开引用无需深层引用例外。
    if (!isCycle && isPublicExport(e.target)) continue;
    const category: ViolationCategory = isCycle ? "cycle" : "deep-reference";
    const key = `${e.source}\u0000${e.target}\u0000${category}`;
    const baselined = baselineEdges.has(key);
    if (baselined) baselineEdges.delete(key);
    if (options.ignoreExceptions || !baselined) {
      violations.push({
        category,
        source: e.source,
        target: e.target,
        sourceModule: e.sm,
        targetModule: e.tm,
        detail: isCycle
          ? `模块级环边 ${e.sm} -> ${e.tm}（${e.sm} 与 ${e.tm} 互相可达）`
          : `跨模块深层引用 ${e.sm} -> ${e.tm}`,
      });
    }
  }

  for (const u of unknownTargets) {
    violations.push({
      category: "unknown-mapping",
      source: u.source,
      target: u.target,
      sourceModule: attribute(config.moduleRoots, u.source)?.module ?? null,
      targetModule: null,
      detail: `目标不在模块映射表：${u.target}`,
    });
  }
  for (const u of unmappedSources) {
    violations.push({
      category: "unknown-mapping",
      source: u,
      target: "",
      sourceModule: null,
      targetModule: null,
      detail: `源文件不在模块映射表（映射覆盖不完整）：${u}`,
    });
  }

  // 幻影例外：基线里剩余未消耗的条目 = 范围扩大。ignoreExceptions 模式下不适用。
  const phantomExceptions = options.ignoreExceptions
    ? []
    : [...baselineEdges.values()];

  // 环的聚合描述（供报告/人类阅读）
  const cycles: string[][] = [];
  const visitedModules = new Set<string>();
  for (const mod of byModule.keys()) {
    if (visitedModules.has(mod)) continue;
    const inStack = new Set<string>();
    const path: string[] = [];
    const found: string[][] = [];
    const dfs = (cur: string): void => {
      path.push(cur);
      inStack.add(cur);
      visitedModules.add(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (inStack.has(nxt)) {
          const start = path.indexOf(nxt);
          if (start !== -1) found.push([...path.slice(start), nxt]);
        } else if (!visitedModules.has(nxt)) {
          dfs(nxt);
        }
      }
      path.pop();
      inStack.delete(cur);
    };
    dfs(mod);
    cycles.push(...found);
  }

  const ok =
    configErrors.length === 0 &&
    violations.length === 0 &&
    phantomExceptions.length === 0;

  return {
    ok,
    scannedFiles: files.length,
    scannedEdges: edgeCount,
    violations,
    phantomExceptions,
    cycles,
    configErrors,
    skipped,
    unresolvedSpecs,
    outsideSpecs,
  };
}

function isPublicExport(targetRel: string): boolean {
  const base = targetRel.split("/").pop() ?? "";
  return base === "public.ts" || base === "integration.ts";
}

// ---------------------------------------------------------------------------
// 基线生成
// ---------------------------------------------------------------------------

export function generateBaseline(
  config: CheckConfig,
  options: { cwd: string; scanRoots?: string[] },
): CheckConfig {
  // 忽略现有 exceptions，重新收敛全量基线（否则会对已完整基线返回 0 条）。
  const result = runCheck(config, { ...options, ignoreExceptions: true });
  const exceptions: Exception[] = [];
  for (const v of result.violations) {
    if (v.category === "unknown-mapping") continue;
    exceptions.push({
      source: v.source,
      target: v.target,
      category: v.category,
      ticket: ticketFor(v),
      exit_condition: exitConditionFor(v),
      reason: v.detail,
    });
  }
  exceptions.sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  return {
    version: config.version,
    moduleRoots: config.moduleRoots,
    exceptions,
  };
}

/** Module → (消除出口的 MOD 票, migration-plan 阶段名)。标签用阶段名（S2=身份与 Access、
 *  S5=工具审批与恢复……），不用批次名。 */
const MODULE_TICKET: Record<string, string> = {
  M01: "MOD04 (S2 身份与 Access)",
  M02: "MOD04 (S2 身份与 Access)",
  M03: "MOD05 (S2 身份与 Access)",
  M04: "MOD06 (S2 身份与 Access)",
  M05: "MOD07 (S3 会话与一次文本 Run)",
  M06: "MOD08 (S2 身份与 Access)",
  M07: "MOD09 (S4 受管模型与资金)",
  M08: "MOD12 (S5 工具审批与恢复)",
  M09: "MOD11 (S6 范围绑定环境)",
  M10: "MOD15 (S7 记忆)",
  M11: "MOD17 (S7 观测)",
  M12: "MOD16 (S7 插件包)",
  CRAFT: "MOD22 (S6 范围绑定环境)",
  WORKSHOP: "MOD22 (S6 范围绑定环境)",
  OPENMUSE: "MOD21 (S7 客户端 OpenMuse BFF)",
  AUTOMATION: "MOD14 (S7 定时职责与 Worker)",
  LEARNING: "MOD23 (S7 隔离可选 Learning)",
  VOICE: "MOD24 (S7 语音听写)",
};

function ticketFor(v: Violation): string {
  const targetModule = v.targetModule ?? v.sourceModule ?? "";
  const t = MODULE_TICKET[targetModule];
  if (t) return t;
  return `TBD（${targetModule} 归属后续票，按 migration-plan 工作包映射）`;
}

function exitConditionFor(v: Violation): string {
  if (v.category === "cycle") {
    return `${v.targetModule} 建立 public/integration 出口并让 ${v.sourceModule} 改走公开出口，使 ${v.sourceModule}↔${v.targetModule} 单向化后移除此例外`;
  }
  return `${v.targetModule} 建立 public/integration 出口，${v.source} 改走公开出口后移除`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2);
  const baseline = args.includes("--baseline");
  const asJson = args.includes("--json");
  const configArg = args.find((a, i) => a === "--config" && args[i + 1]);
  const configPath = configArg
    ? args[args.indexOf(configArg) + 1]
    : "tests/config/module-imports.json";

  const configAbs = resolve(ROOT, configPath);
  if (!existsSync(configAbs)) {
    console.error(`配置文件不存在: ${configPath}`);
    return 2;
  }
  let config: CheckConfig;
  try {
    config = JSON.parse(readFileSync(configAbs, "utf8")) as CheckConfig;
  } catch (err) {
    console.error(`配置文件不是合法 JSON: ${configPath}`);
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const options = { cwd: ROOT, scanRoots: SCAN_ROOTS };

  if (baseline) {
    // M-2：非法配置不再静默收敛——configErrors 非空时报错退出。
    const configErrors = validateConfig(config);
    if (configErrors.length) {
      console.error("[配置自洽性错误] --baseline 拒绝在非法配置上收敛基线：");
      for (const e of configErrors) console.error(`  - ${e}`);
      return 1;
    }
    // --baseline 恒以 JSON 输出（本就是机器消费形态），--json 只作用于检查结果。
    console.log(JSON.stringify(generateBaseline(config, options), null, 2));
    return 0;
  }

  const result = runCheck(config, options);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    render(result, config);
  }

  return result.ok ? 0 : 1;
}

function render(result: CheckResult, config: CheckConfig): void {
  console.log(
    `扫描 ${result.scannedFiles} 个源文件，${result.scannedEdges} 条 import（外部 ${result.skipped.external}，资源 ${result.skipped.asset}，未解析 ${result.skipped.unresolved}，根外 ${result.skipped.outsideRoots}）。`,
  );
  console.log(
    `基线例外 ${config.exceptions.length} 条；违规 ${result.violations.length} 条；幻影例外 ${result.phantomExceptions.length} 条；模块环 ${result.cycles.length} 个。`,
  );

  if (result.configErrors.length) {
    console.log("\n[配置自洽性错误]");
    for (const e of result.configErrors) console.log(`  - ${e}`);
  }
  if (result.violations.length) {
    console.log("\n[违规]");
    for (const v of result.violations) {
      console.log(
        `  - [${v.category}] ${v.source} -> ${v.target}  ${v.detail}`,
      );
    }
  }
  if (result.phantomExceptions.length) {
    console.log("\n[幻影例外（范围扩大）]");
    for (const e of result.phantomExceptions) {
      console.log(`  - ${e.source} -> ${e.target}`);
    }
  }
  if (result.cycles.length) {
    console.log("\n[模块环]");
    for (const c of result.cycles) console.log(`  - ${c.join(" -> ")}`);
  }
  console.log(
    `\n结论: ${result.ok ? "与基线一致（退出码 0）" : "存在差异（退出码非零）"}`,
  );
}

if (import.meta.main) {
  process.exitCode = main();
}
