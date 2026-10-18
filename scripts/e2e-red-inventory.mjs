#!/usr/bin/env node
// Emit the red inventory a reviewer needs: which suite is failing, on which runtime, and who is
// responsible for it. Everything here is derived from evidence files a run already produced, so the
// document cannot drift from the measurement the way a hand-written list does.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const reportPath = resolve(root, arg("report", ".e2e/final2/report.json"));
const verdictPath = resolve(
  root,
  arg("verdicts", "docs/verification/e2e-vs-bun-final.json"),
);
const outPath = resolve(
  root,
  arg("out", "docs/verification/e2e-red-inventory.md"),
);
const onlyGroups = (arg("groups", "") || "").split(",").filter(Boolean);
const withOwners = process.argv.includes("--owners");
const DRIVER = "tests/bun-suites.test.ts";

// A red suite has one owner per line of blame, and a reviewer asking "who fixes this" should get the
// answer from git rather than from a guess.
const owner = (file) => {
  if (!withOwners) return "";
  const result = spawnSync(
    "git",
    ["log", "-1", "--format=%an|%ad", "--date=short", "--", file],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return (
    (result.stdout ?? "").trim().replace("|", " (") +
    (result.stdout?.trim() ? ")" : "")
  );
};

const run = JSON.parse(readFileSync(reportPath, "utf8")).run;
const verdicts = existsSync(verdictPath)
  ? JSON.parse(readFileSync(verdictPath, "utf8"))
  : { rows: [] };
const byFile = new Map();
for (const result of run.results ?? []) {
  if (result.status === "passed" || result.status === "skipped") continue;
  const entry = byFile.get(result.file) ?? { count: 0, first: "" };
  entry.count++;
  const message = String(result.attempts?.at(-1)?.error?.message ?? "").replace(
    /\s+/g,
    " ",
  );
  if (!entry.first && message) entry.first = message.slice(0, 140);
  byFile.set(result.file, entry);
}
const verdictOf = new Map(
  (verdicts.rows ?? []).map((r) => [r.file, r.verdict]),
);
const noVerdictNote =
  "未单独判定（本次判定集合来自上一次报告的红文件；新红文件要重跑 scripts/e2e-vs-bun.mjs）";

// A driven group is one e2e assertion over a `bun test` run, so its file-level detail has to come
// from bun itself. Only asked-for groups are re-run: a whole tier costs minutes per group.
function attributeGroup(name) {
  const manifest = JSON.parse(
    readFileSync(join(root, "docs/verification/e2e-bun-suites.json"), "utf8"),
  );
  const group = (manifest.groups ?? []).find((g) => g.name === name);
  if (!group) return { name, error: "no such group in the manifest" };
  const result = spawnSync(
    "bun",
    ["test", ...group.files.map((f) => `./${f}`)],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1e8,
      timeout: 900_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  let current = null;
  const files = new Map();
  for (const line of output.split("\n")) {
    const header = line.match(/^(\S+\.tsx?):\s*$/);
    if (header) {
      current = header[1];
      continue;
    }
    if (/^\(fail\)/.test(line) && current)
      files.set(current, (files.get(current) ?? 0) + 1);
  }
  // bun prints each failure twice (inline and in the trailing list), so halve the tally.
  return {
    name,
    exit: result.status,
    files: [...files].map(([file, count]) => ({
      file,
      fails: Math.round(count / 2),
    })),
  };
}

const lines = [];
lines.push("# 红点清单 · 由测量直接生成，不要手改");
if (withOwners) {
  lines.push(
    "",
    "> 派单口径：这个仓库的提交者 git identity 是同一个（`wuyj`），blame 只说明「谁最近改过它」，",
    "> 不代表责任波次；按套件区域派单更准 —— `server/tests/enterprise/*` 与 `server/tests/multitenancy/*`",
    "> （多租户执行波次）、`server/src/kb/*` 与 `server/src/knowledge/*`（知识服务）、",
    "> `app/tests/ai-observability-*`（observability/T02）、`agent-sandbox/tests/*`（workshop 沙箱）。",
  );
}
lines.push(
  "",
  `生成：\`node scripts/e2e-red-inventory.mjs\` · 报告 \`${reportPath.replace(`${root}/`, "")}\`（run ${run.id}，结束于 ${run.finishedAt}）· 判定 \`${verdictPath.replace(`${root}/`, "")}\``,
  "",
  "运行器：`e2e`（Node）为原生层，`bun test` 由 `tests/bun-suites.test.ts` 分组代为调度与报告（ADR 0008 的两层制）。",
  "",
  `汇总：${run.summary.executed} executed · ${run.summary.passed} passed · ${run.summary.failed} failed · ${run.summary.skipped} skipped；收集文件 ${byFile.size} 个红；run 级错误 ${(run.errors ?? []).length} 个。`,
  "",
  "## 原生层（e2e / Node）",
  "",
  `| 文件 | e2e 失败数 | 归因 | 第一条消息 |${withOwners ? " 最后改它的人（派单用） |" : ""}`,
  ` | --- | --- | --- | --- |${withOwners ? " --- |" : ""}`,
);
for (const [file, entry] of [...byFile]
  .filter(([f]) => f !== DRIVER)
  .sort((a, b) => b[1].count - a[1].count)) {
  lines.push(
    `| \`${file}\` | ${entry.count} | ${verdictOf.get(file) ?? noVerdictNote} | ${entry.first || "—"} |${withOwners ? ` ${owner(file)} |` : ""}`,
  );
}
lines.push(
  "",
  "归因口径（`scripts/e2e-vs-bun.mjs`）：同一份生产代码 + 迁移前套件文本用 `bun test` 再跑一遍。",
  "",
  "- `already-red-at-baseline`：迁移前整树上也是红的 → 与迁移无关。",
  "- `red-on-old-runner-with-current-code`：换回旧运行器同样红 → 迁移没有改变结论。",
  "- `runner-difference`：只有旧运行器绿 → 才是迁移的责任，必须修兼容层或按两层制分流。",
  "",
  "## 驱动层（e2e 调度、Bun 执行）",
  "",
  "| 组 | 结果 | 运行器给出的原因 |",
  " | --- | --- | --- |",
);
for (const result of (run.results ?? []).filter((x) => x.file === DRIVER)) {
  const message = String(result.attempts?.at(-1)?.error?.message ?? "").replace(
    /\s+/g,
    " ",
  );
  lines.push(
    `| ${result.titlePath?.at(-1) ?? "?"} | ${result.status} | ${result.status === "passed" ? "—" : message.slice(0, 160)} |`,
  );
}
if (onlyGroups.length) {
  lines.push("", "## 驱动层红组的文件级归属（重跑 bun 得到）", "");
  for (const name of onlyGroups) {
    const detail = attributeGroup(name);
    lines.push(`### ${name}`);
    if (detail.error) {
      lines.push(`- ${detail.error}`);
      continue;
    }
    lines.push(`- \`bun test\` 退出码 ${detail.exit}`);
    for (const f of detail.files) lines.push(`- ${f.fails} × \`${f.file}\``);
    if (!detail.files.length) lines.push("- 无 (fail) 行");
    lines.push("");
  }
}
writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(
  `${outPath.replace(`${root}/`, "")} written · ${byFile.size - 1} native red files · ${(run.results ?? []).filter((x) => x.file === DRIVER).length} driven groups`,
);
