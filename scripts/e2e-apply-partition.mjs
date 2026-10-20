#!/usr/bin/env node
// Point each suite at the compat layer its runner will actually load.
//
// Native e2e files need the e2e-backed layer; the files listed in the Bun manifest are executed by
// `bun test`, where that layer would import Node's `module.registerHooks` and fail. Both directions
// are rewritten so re-running the partition is idempotent after the audit changes a file's bucket.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "tests/config/e2e-bun-suites.json"), "utf8"),
);
const bunFiles = new Set(manifest.files ?? []);
const TEST_FILE = /(\.test|\.spec)\.(ts|tsx|mts)$/;
const E2E = "support/e2e-compat";
const BUN = "support/bun-test-compat";

/*
 * Exactly the files `bunfig.toml` hands Bun as `[test] preload`, read from the TOML rather than
 * guessed from a path pattern. e2e never collects them, so they belong to the bun:test side. An
 * earlier version matched the substring `preload`, which also swept up `bunfig-preload.test.ts` — a
 * normal suite *about* those files — onto the Bun layer without recording it in the manifest, and the
 * runner then failed to collect it with `Received protocol 'bun:'`.
 */
const BUN_ONLY = new Set(
  ["bunfig.toml", "server/bunfig.toml"]
    .filter((file) => existsSync(join(root, file)))
    .flatMap((file) => {
      const toml = readFileSync(join(root, file), "utf8");
      const block = toml.slice(toml.indexOf("[test]"));
      const entry = block.match(/preload\s*=\s*\[([^\]]*)\]/);
      return [...(entry?.[1]?.match(/["']([^"']+)["']/g) ?? [])].map((raw) =>
        raw.replace(/["']/g, "").replace(/^\.\//, ""),
      );
    }),
);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist")
      continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEST_FILE.test(entry) || /\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const dirs = [
  "shared",
  "supervisor",
  "worker",
  "deliverables",
  "desktop",
  "agent-bot",
  "agent-sandbox",
  "agent-langgraph",
  "agent-mastra",
  "agent-computer",
  "app",
  "server",
  "tests",
  "scripts",
];
let movedToBun = 0;
let movedToE2e = 0;
for (const dir of dirs) {
  for (const file of walk(resolve(root, dir), [])) {
    const rel = file.replace(`${root}/`, "");
    /*
     * Only suites and the declared preloads have a tier of their own. A `*.fixture.tsx` or
     * `helpers/*.ts` is loaded by whoever imports it, so its correct compat layer is its consumers'
     * tier — and a helper shared by a native suite and a driven one needs the runtime-resolved seam
     * (see server/tests/helpers/refusals.ts), not a rewrite by membership in a manifest that never
     * lists it. Rewriting those was what pushed `app/tests/home-fallback-routing.fixture.tsx` back to
     * the e2e layer and re-killed three driven suites with Node's `registerHooks`.
     */
    if (!TEST_FILE.test(rel) && !BUN_ONLY.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    const want = bunFiles.has(rel) || BUN_ONLY.has(rel) ? BUN : E2E;
    const from = want === BUN ? E2E : BUN;
    // The specifier is relative, so only its tail is stable: `../../tests/support/e2e-compat"`.
    const tails = [`/${from}"`, `/${from}'`, `"${from}"`, `"${from}'`];
    if (!tails.some((tail) => source.includes(tail))) continue;
    let next = source;
    for (const tail of tails) {
      next = next.split(tail).join(`/${want}${tail.at(-1)}`);
    }
    if (next === source) continue;
    writeFileSync(file, next);
    if (want === BUN) movedToBun++;
    else movedToE2e++;
  }
}
console.log(
  `${movedToBun} suite file(s) now import the bun:test layer, ${movedToE2e} the e2e layer`,
);
