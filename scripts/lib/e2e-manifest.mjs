import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Shared shape and grouping for tests/config/e2e-bun-suites.json. */

const root = resolve(import.meta.dirname, "../..");
export const MANIFEST = join(root, "tests/config/e2e-bun-suites.json");
export const GROUP_SIZE = 24;

/*
 * The corpus scope, stated once. `e2e.unit.config.ts` collects exactly these top-level directories and
 * `scripts/e2e-coverage-audit.mjs` reconciles against the same list; when they were two hand-written
 * copies, adding a directory to one side silently changed what "every test is on e2e" means — the
 * runner would collect files the audit never looked at, or the audit would claim coverage the runner
 * doesn't have. Anything outside this list (the `bifrost` submodule, `archive/**` evidence snapshots,
 * Go tests) is excluded by name in docs/plans, not by silence.
 */
export const SUITE_DIRS = [
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

/*
 * `bun test` runs every selected file in one process, so a suite that leaves global state behind
 * (a fetch stub, a happy-dom registration) can turn a sibling that passes alone into a failure.
 * That is not a verdict the pre-migration invocation would have given:
 * `app/tests/bot-needs-you.test.tsx` is green at the baseline commit run directory-wide, green run
 * alone today, and red inside a 24-file alphabetical slice that happens to put the newer
 * `ai-observability-*` suites in front of it. Suites known to hold process-wide state get their own
 * group instead of sharing one, so a group's red means "this file is red", not "these files are red
 * together".
 */
export const ISLANDS = [
  "ai-observability-",
  // Measured, not guessed: both files are green run alone (16/16 and 9/9) and green in the
  // one-process-for-the-whole-corpus shape, but red inside their 24-file slice — the neighbour that
  // leaks process-wide state in that slice is what fails them. Their own group removes a failure the
  // migration would otherwise be inventing.
  "billing-credits-writer",
  "gateway-probe",
];

/*
 * Files that must share one named group regardless of their directory. The name of an entry is the
 * e2e test title and the E2E_BUN_ONLY filter is a substring match on it, so a member that belongs to
 * the `server/tests/multitenancy` environment (the MT task chain's dedicated database) while living
 * in `server/tests/` still needs a name that carries that island. Before this constant was restored,
 * `groupsOf` threw `ReferenceError: EXPLICIT_GROUPS is not defined` and no writer could regenerate
 * the manifest at all (the committed snapshot had drifted by hand instead).
 */
export const EXPLICIT_GROUPS = {
  /*
   * PKG02's end-to-end suite lives in server/tests/ but applies the same MT task chain
   * (MT004→…→PKG04 through ./multitenancy/support/package-install) against the dedicated
   * enterprise test database, and plugin-install's fixture builds on MT004/MT008 and applies
   * MT031 in the same database. Keeping all six in one process is what makes the chain's
   * reconcile→apply sequential instead of two e2e workers racing one schema, and the name
   * carries the island so `MT_TEST_DATABASE_URL` routing in tests/bun-suites.test.ts applies.
   */
  "server/tests/multitenancy/package chain": [
    /*
     * plugin-install first: its AC1 asserts the catalog contains exactly its
     * three seeded entries, and its dispose truncates the three plugin tables
     * — running it after package-storage/package-install.integration (both
     * leave `pkg02-*` catalog rows behind, measured) invents a red that no
     * single-suite run gives.
     */
    "server/tests/multitenancy/plugin-install.test.ts",
    "server/tests/multitenancy/package-storage.test.ts",
    "server/tests/multitenancy/package-runtime.test.ts",
    "server/tests/multitenancy/package-grants.test.ts",
    "server/tests/multitenancy/package-expert.test.ts",
    /*
     * PKG05 (#464): the dispatch suite seeds the same package chain (it calls
     * `applyPackageTasks` itself) and its concurrency case opens a second data
     * connection, so it belongs in this one sequential process rather than a
     * racing sibling group.
     */
    "server/tests/multitenancy/package-dispatch.test.ts",
    "server/tests/package-install.integration.test.ts",
  ],
  /*
   * MT032's suite was written against the e2e (Node) layer while its fixture chain reaches
   * Bun's SQL client through server/src/db/client; both runners rejected it (T00 B-3). It now
   * imports bun-test-compat like its multitenancy siblings and gets its own group so the
   * corrected tier can be driven and counted on its own.
   */
  "server/tests/multitenancy/tool-invocation": [
    "server/tests/multitenancy/tool-invocation.test.ts",
  ],
};

/*
 * Whole directories that need their own group because their *environment* differs from the rest of
 * the directory: the `multitenancy` suites build their own schema in-process through
 * `server/scripts/multitenancy/migrate-test.ts`, which refuses any `TEST_DATABASE_URL` whose database
 * is not named `openbot_enterprise_*` on a loopback host. Under the shared `openbot_test` URL every
 * one of them aborts at collection with `relation … does not exist`, which is why 51 files showed up
 * as "no junit" rather than red. Their own group is what lets the driver hand them a different
 * `TEST_DATABASE_URL` (from `MT_TEST_DATABASE_URL`) without moving 400 other suites off the URL they
 * expect.
 */
export const DIRECTORY_ISLANDS = [
  "server/tests/multitenancy",
  "app/tests/multitenancy",
];

/*
 * Suites that only mean something against a running deployment, so `e2e.unit.config.ts` keeps them out
 * of the default corpus and `bun run test:api` runs them on demand. The list lives here because the
 * audit has to know they are *named exclusions with their own entry point*: while it read only the
 * manifest, `tests/e2e/api.e2e.test.ts` was counted as native coverage the corpus never executes, and
 * "every suite is scheduled by e2e" was quietly one file less true than the printout.
 */
export const LIVE_SUITES = ["tests/e2e/api.e2e.test.ts"];

export function readManifest() {
  const parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return {
    files: new Set(parsed.files ?? []),
    artifacts: new Set(parsed.artifacts ?? []),
    causes: { ...(parsed.causes ?? {}) },
    // Passthrough: writers feed this object straight into writeManifest(),
    // whose `audit` key is optional (JSON.stringify drops undefined). Without
    // it, any reader-then-writer round trip silently stripped the audit
    // pointer another writer recorded — the exact cross-writer field loss
    // this convergence exists to prevent.
    audit: parsed.audit,
    raw: parsed,
  };
}

export function groupsOf(files) {
  const byDirectory = new Map();
  const present = new Set(files);
  const explicit = new Set(Object.values(EXPLICIT_GROUPS).flat());
  for (const file of [...files].sort()) {
    if (explicit.has(file)) continue;
    const segments = file.split("/");
    const directory = segments.slice(0, 2).join("/");
    const island = ISLANDS.find((prefix) => segments.at(-1).startsWith(prefix));
    // A directory island keeps its full path as the key, because what separates it from the other
    // suites in the directory is the environment the group runs with, not the file name.
    const dirIsland = DIRECTORY_ISLANDS.find((dir) =>
      file.startsWith(`${dir}/`),
    );
    const key = dirIsland
      ? dirIsland
      : island
        ? `${directory}/${island.replace(/-$/, "")}`
        : directory;
    if (!byDirectory.has(key)) byDirectory.set(key, []);
    byDirectory.get(key).push(file);
  }
  const groups = [];
  for (const [directory, list] of byDirectory) {
    for (let index = 0; index < list.length; index += GROUP_SIZE) {
      groups.push({
        name: `${directory}${list.length > GROUP_SIZE ? ` part ${index / GROUP_SIZE + 1}` : ""}`,
        files: list.slice(index, index + GROUP_SIZE),
      });
    }
  }
  for (const [name, files] of Object.entries(EXPLICIT_GROUPS)) {
    const members = files.filter((file) => present.has(file));
    if (members.length > 0) groups.push({ name, files: members });
  }
  return groups;
}

/*
 * THE one writer. Every generator records the same payload shape here: the
 * grouping (`groups`), the driven files, the non-executable artifacts, the
 * per-file `causes` evidence, and the `directoryIslands` the driver
 * (`tests/bun-suites.test.ts`) reads to hand the multitenancy groups their
 * dedicated `MT_TEST_DATABASE_URL`. Before this convergence the manifest had
 * two mutually exclusive output shapes — any writer could silently strip
 * `directoryIslands` (51 multitenancy suites aborting on the shared URL) or
 * wipe another writer's `causes`. `audit` is a passthrough for generators
 * that derive the file list from an audit snapshot; writers that don't have
 * one simply omit it (JSON.stringify drops `undefined`).
 */
export function writeManifest(
  { files, artifacts, causes, audit },
  generatedBy,
) {
  const list = [...files].sort();
  /*
   * `directoryIslands` is part of the contract, not a comment: tests/bun-suites.test.ts reads it to
   * decide which groups get `MT_TEST_DATABASE_URL`. The key was added to the manifest by hand after
   * this writer existed, so a re-run of `writeManifest` would have silently dropped it and sent the
   * multitenancy groups back to the shared URL, where every one of them aborts at collection.
   */
  const payload = {
    generatedBy,
    audit,
    groups: groupsOf(list),
    files: list,
    artifacts: [...artifacts].sort(),
    causes,
    directoryIslands: [...DIRECTORY_ISLANDS],
  };
  // Two-space indent, matching `biome format` for JSON: a regeneration then
  // leaves the committed file byte-identical instead of trading a reorder diff
  // (OCR round2 M1) for a whole-file reindent diff.
  writeFileSync(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`);
  return payload.groups.length;
}
