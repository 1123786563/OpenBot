#!/usr/bin/env node
// One-off converter: bun:test suites -> the tester-army e2e runner.
// It swaps the runner import for tests/support/e2e-compat (which re-exports e2e and re-adds
// Bun's spies, test.each and the value matchers e2e leaves out) and reports what it could not
// settle mechanically, so those files get a human pass instead of a silent guess.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shim = join(root, "tests/support/e2e-compat.ts");
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  "coverage",
]);
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const dry = process.argv.includes("--dry-run");
if (!dirs.length) {
  console.error(
    "usage: node scripts/migrate-tests-to-e2e.mjs [--dry-run] <dir> [...more]",
  );
  process.exit(2);
}

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (TEST_FILE.test(entry)) out.push(full);
    // Support, helper and fixture modules ride along: a `.fixture.tsx` that imports `bun:test`
    // breaks every suite that imports it, and that is not visible as a test file.
    else if (
      /\.(ts|tsx)$/.test(entry) &&
      readFileSync(full, "utf8").includes("bun:test")
    )
      out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => collect(resolve(root, d), []));
const changed = [];
const skipped = [];
const notes = [];

const SUPPORTED = new Set([
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "expect",
  "it",
  "jest",
  "mock",
  "spyOn",
  "test",
  "Mock",
  "setSystemTime",
  "useFakeTimers",
]);

/** Node has no `import.meta.dir`; give every converted file the same two locals Bun provided. */
function importMetaShim(usesDir, source) {
  const lines = [];
  // Only what the file does not already import: a second `import { dirname }` is a redeclaration.
  if (
    !/\bdirname\b.*from "node:path"|from "node:path".*\bdirname\b/.test(source)
  )
    lines.push('import { dirname } from "node:path";');
  if (
    !/fileURLToPath.*from "node:url"|from "node:url".*fileURLToPath/.test(
      source,
    )
  )
    lines.push('import { fileURLToPath } from "node:url";');
  lines.push("const herePath = fileURLToPath(import.meta.url);");
  if (usesDir) lines.push("const hereDir = dirname(herePath);");
  return `${lines.join("\n")}\n`;
}

/** `import { serve } from "bun"` and friends: the Node port of that surface sits beside this shim. */
function portBunValueImport(source, file) {
  if (!/from ["']bun["']/.test(source)) return source;
  const target = relative(
    dirname(file),
    join(root, "tests/support/bun-compat.ts"),
  ).replace(/\.ts$/, "");
  const specifier = target.startsWith(".") ? target : `./${target}`;
  return source.replace(/from ["']bun["']/g, `from "${specifier}"`);
}

/**
 * `bunfig.toml` preloaded `app/tests/preload.ts`, which registers a DOM and evaluates Base UI
 * against it once, before any suite imports a component. e2e has no preload, so the same module is
 * imported first by every app suite file; without it Base UI freezes `useLayoutEffect` to a no-op
 * and every portal renders into an empty body.
 */
function withDomPreload(source, file) {
  if (!file.startsWith(join(root, "app")) || !TEST_FILE.test(file))
    return source;
  if (/^import\s+"[^"]*preload";/m.test(source)) return source;
  const target = relative(dirname(file), join(root, "app/tests/preload.ts"))
    .replace(/\.ts$/, "")
    .split(sep)
    .join("/");
  const specifier = target.startsWith(".") ? target : `./${target}`;
  return `import "${specifier}";\n${source}`;
}


/**
 * Bun gives ESM files a `require`; Node does not. Rewrite it to a createRequire handle so the same
 * file loads under either runner.
 */
function rewriteBunRequire(source, file, notes) {
  let next = source;
  if (/(^|[^.\w])require\(/.test(next) && !/createRequire/.test(next)) {
    const injected =
      'import { createRequire } from "node:module";\n\nconst nodeRequire = createRequire(import.meta.url);\n';
    let end = 0;
    for (const match of next.matchAll(/^import[\s\S]*?;\n/gm))
      end = match.index + match[0].length;
    next = `${next.slice(0, end)}${injected}\n${next.slice(end)}`;
    next = next.replace(/(^|[^.\w])require\((["'])/g, "$1nodeRequire($2");
    notes.push([relative(root, file), "rewrote Bun's ESM require() to createRequire"]);
  }
  return next;
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  // A suite file that took the runner's bare `e2e` import gets the same treatment: it needs the
  // compat layer for the matchers e2e leaves out. UI files (.e2e.ts) keep their engine imports.
  const isBareE2e = !/\.e2e\.ts$/.test(file);
  // Column 0 only: a suite's own import is at the top level, while a probe script written inside a
  // template literal is meant for a child Bun and must keep its `bun:test` import.
  const match =
    source.match(
      /^import\s+(?:\{([^}]*)\}|\*\s+as\s+\w+)\s+from\s+["']bun:test["'];?/ms,
    ) ??
    (isBareE2e
      ? source.match(/^import\s+\{([^}]*)\}\s+from\s+["']e2e["'];?/ms)
      : undefined);
  if (!match) {
    if (/^\s*from ["']bun:test["']/m.test(source)) {
      skipped.push([relative(root, file), "unparsed bun:test import shape"]);
      continue;
    }
    // Already on the compat layer: still port `from "bun"` value imports and the DOM preload.
    let ported = withDomPreload(
      rewriteBunRequire(portBunValueImport(source, file), file, notes),
      file,
    );
    if (ported !== source) {
      if (!dry) writeFileSync(file, ported);
      changed.push(relative(root, file));
      continue;
    }
    if (!/\b(test|describe)\s*\(/.test(source))
      skipped.push([relative(root, file), "no bun:test import"]);
    continue;
  }
  const names = (match[1] ?? "*")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const computed = relative(dirname(file), shim).replace(/\.ts$/, "");
  const specifier = computed.startsWith(".") ? computed : `./${computed}`;
  const clean = names
    .filter((n) => !n.startsWith("type "))
    .map((n) => n.split(/\s+as\s+/)[0].trim())
    .filter((n) => !SUPPORTED.has(n));
  if (clean.length)
    notes.push([
      relative(root, file),
      `unknown bun:test names: ${clean.join(", ")}`,
    ]);

  const clause = match[1] === undefined ? "* as bunTest" : names.join(", ");
  const replaced = `import { ${clause} } from "${specifier}";`;
  let next = withDomPreload(source.replace(match[0], replaced), file);

  // Bun's `import.meta.dir` has no Node equivalent spelled that way; both forms are one substitution.
  if (
    /import\.meta\.(dir|path\b)/.test(next) &&
    !/const herePath =/.test(next)
  ) {
    const usesDir = /import\.meta\.dir/.test(next);
    next = next
      .replace(/import\.meta\.dir/g, "hereDir")
      .replace(/import\.meta\.path\b/g, "herePath");
    // Insert after the import block, not before it: a const between imports reads as broken order.
    const block = importMetaShim(usesDir, next);
    const lastImport = next.lastIndexOf("\nimport ");
    const lineEnd = next.indexOf("\n", next.indexOf(";", lastImport + 1) + 1);
    next =
      lastImport === -1
        ? block + next
        : `${next.slice(0, lineEnd + 1)}\n${block}${next.slice(lineEnd + 1)}`;
  }

  next = rewriteBunRequire(next, file, notes);

  next = portBunValueImport(next, file);

  if (/Bun\.[a-zA-Z]/.test(next))
    notes.push([
      relative(root, file),
      "uses Bun runtime API: served by tests/support/bun-compat",
    ]);
  if (/from ["']bun:[^"']+["']/.test(next))
    notes.push([relative(root, file), "imports another bun: module"]);

  if (next !== source) {
    if (!dry) writeFileSync(file, next);
    changed.push(relative(root, file));
  }
}

console.log(
  `${dry ? "would change" : "changed"}: ${changed.length} / ${files.length} files`,
);
console.log(`already migrated or not a runner file: ${skipped.length}`);
if (notes.length) {
  console.log(`\nneeds a hand pass (${notes.length}):`);
  for (const [file, note] of notes) console.log(`  ${file} — ${note}`);
}
