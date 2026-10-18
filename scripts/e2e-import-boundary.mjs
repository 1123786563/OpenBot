#!/usr/bin/env node
// Which suites can the Node runner load at all, decided from the import graph rather than one
// ten-minute runner pass per file.
//
// A suite fails to collect when something it reaches needs Bun: the SQL client, Bun's `serve`,
// `bun:*` modules, or the Bun-only bits of the browser engine. Those are module properties, so the
// answer is reachability, and it can be computed in seconds for the whole repository. The runner
// stays the judge — scripts/e2e-partition-fix-loop.mjs verifies against it — but this turns that
// loop from discovery into confirmation.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".audit-out"]);
const DIRS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "shared", "supervisor", "worker", "deliverables", "desktop", "agent-bot", "agent-sandbox",
      "agent-langgraph", "agent-mastra", "agent-computer", "app", "server", "tests", "scripts",
    ];

/* Modules whose mere evaluation needs the Bun runtime. Matched on the source, not the file name:
 * `server/src/db/client.ts` is the one that imports `{ SQL } from "bun"`, and everything that
 * reaches it inherits the requirement. */
/*
 * Only a module-level `import` of the bun package, a `bun:` module or a Bun-only driver is certain:
 * the loader evaluates it before any test body runs, so Node cannot reach the file at all. A use of
 * `Bun.serve` or `Bun.hash` inside a function is not — those are served by tests/support/bun-compat
 * or they fail in the runner, which stays the judge. Keeping this list narrow is what makes the
 * bulk partition defensible rather than a way to park inconvenient suites.
 */
const BUN_ONLY = [
  /^import\s[^\n]*?from\s+["']bun["']/m,
  // A suite that asks for `bun:test` by name has already decided its runner: only Bun collects it.
  /^import\s[^\n]*?from\s+["']bun:test["']/m,
  /^import\s[^\n]*?from\s+["']bun:[a-z/]+["']/m,
  /^export\s[^\n]*?from\s+["']bun[:"']/m,
  /^import\s[^\n]*?from\s+["']drizzle-orm\/bun-[a-z]+["']/m,
  /^require\(["']bun[:,][^)]*\)/m,
];
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;

const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
}
for (const dir of DIRS) {
  const abs = resolve(root, dir);
  if (existsSync(abs)) walk(abs);
}

const sources = new Map();
const bunOnly = new Set();
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  sources.set(file, source);
  if (BUN_ONLY.some((pattern) => pattern.test(source))) bunOnly.add(file);
}

/** Resolve one specifier to a repository file, the way the loader would for relative and `@/` imports. */
function resolveSpecifier(from, specifier) {
  const base = specifier.startsWith(".")
    ? join(dirname(from), specifier)
    : specifier.startsWith("@/")
      ? join(root, "app", "src", specifier.slice(2))
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (candidate.endsWith("/")) continue;
    const hit = sources.has(candidate) ? candidate : existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
    if (hit) return hit;
  }
  return null;
}

const edges = new Map();
function outgoing(file) {
  if (edges.has(file)) return edges.get(file);
  const source = sources.get(file) ?? (existsSync(file) ? readFileSync(file, "utf8") : "");
  const found = [];
  for (const match of source.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
    const statement = source.slice(Math.max(0, match.index - 40), match.index);
    // `import type` is erased, so it creates no runtime edge: treating it as one would park every
    // suite that merely mentions a Bun-boundary type.
    if (/\btype\s+[A-Za-z_{]/.test(statement) || /\bexport\s+type\b/.test(statement)) continue;
    const target = resolveSpecifier(file, match[1]);
    if (target) found.push(target);
  }
  edges.set(file, found);
  return found;
}

const verdict = new Map();
function reachable(file, seen) {
  if (verdict.has(file)) return verdict.get(file);
  if (seen.has(file)) return false;
  seen.add(file);
  let hit = bunOnly.has(file) ? file : null;
  if (!hit) {
    for (const next of outgoing(file)) {
      const inner = reachable(next, seen);
      if (inner) {
        hit = inner;
        break;
      }
    }
  }
  verdict.set(file, hit);
  seen.delete(file);
  return hit;
}

const suites = files.filter((file) => TEST_FILE.test(file));
const blocked = [];
for (const file of suites) {
  const cause = reachable(file, new Set());
  if (cause) blocked.push({ file: file.replace(`${root}/`, ""), cause: cause.replace(`${root}/`, "") });
}

const byCause = new Map();
for (const entry of blocked) byCause.set(entry.cause, (byCause.get(entry.cause) ?? 0) + 1);

writeFileSync(
  join(root, "archive/verification/e2e-import-boundary.json"),
  JSON.stringify({ suites: suites.length, blocked }, null, 1),
);
console.log(`${suites.length} suite files · ${blocked.length} reach a Bun-only module`);
console.log(`\nthe modules that decide it:`);
for (const [cause, count] of [...byCause].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(count).padStart(4)}  ${cause}`);
}
console.log(`\nledger: archive/verification/e2e-import-boundary.json`);

/*
 * `--apply` folds this verdict into the driven partition: a suite that reaches a module-level bun
 * import cannot be collected under Node, so it belongs to the groups e2e schedules onto `bun test`.
 * The deciding module is recorded per file, so every entry stays auditable and can be pulled back
 * into native collection once the reason is gone.
 */
if (process.argv.includes("--apply")) {
  const { spawnSync } = await import("node:child_process");
  const manifestPath = join(root, "docs/verification/e2e-bun-suites.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = new Set(manifest.files ?? []);
  const causes = { ...(manifest.causes ?? {}) };
  let added = 0;
  for (const entry of blocked) {
    causes[entry.file] = entry.cause;
    if (!files.has(entry.file)) {
      files.add(entry.file);
      added++;
    }
  }
  const groupSize = 24;
  const byDirectory = new Map();
  for (const file of [...files].sort()) {
    const directory = file.split("/").slice(0, 2).join("/");
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(file);
  }
  const groups = [];
  for (const [directory, list] of byDirectory) {
    for (let index = 0; index < list.length; index += groupSize) {
      groups.push({
        name: `${directory}${list.length > groupSize ? ` part ${index / groupSize + 1}` : ""}`,
        files: list.slice(index, index + groupSize),
      });
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, generatedBy: "scripts/e2e-import-boundary.mjs --apply", groups, files: [...files].sort(), causes }, null, 1)}\n`,
  );
  spawnSync("node", ["scripts/e2e-apply-partition.mjs"], { cwd: root, encoding: "utf8", stdio: "inherit" });
  console.log(`applied: ${added} newly driven, ${files.size} driven in total, ${groups.length} groups`);
}
