import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Shared shape and grouping for docs/verification/e2e-bun-suites.json. */

const root = resolve(import.meta.dirname, "../..");
export const MANIFEST = join(root, "docs/verification/e2e-bun-suites.json");
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
 * Suites that do not live in one directory island but need the same dedicated
 * enterprise database environment. PKG02's install suites are split across
 * `server/tests` and `server/tests/multitenancy`; naming the group with the
 * `server/tests/multitenancy` prefix is what makes `bunEnv()` in
 * tests/bun-suites.test.ts (which matches on the group name) hand it the
 * `MT_TEST_*` overrides. The list is explicit so regeneration keeps the group
 * instead of folding the files back into their directory groups.
 */
export const EXPLICIT_GROUPS = Object.freeze({
  "server/tests/multitenancy pkg02": [
    "server/tests/multitenancy/package-storage.test.ts",
    "server/tests/package-install.integration.test.ts",
  ],
  "server/tests/multitenancy pkg03": [
    "server/tests/multitenancy/package-grants.test.ts",
  ],
  "server/tests/multitenancy pkg03b": [
    "server/tests/multitenancy/package-runtime.test.ts",
  ],
  "server/tests/multitenancy pkg04": [
    "server/tests/multitenancy/package-expert.test.ts",
  ],
});

export function readManifest() {
  const parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return {
    files: new Set(parsed.files ?? []),
    artifacts: new Set(parsed.artifacts ?? []),
    causes: { ...(parsed.causes ?? {}) },
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

export function writeManifest({ files, artifacts, causes }, generatedBy) {
  const list = [...files].sort();
  const payload = {
    generatedBy,
    groups: groupsOf(list),
    files: list,
    artifacts: [...artifacts].sort(),
    causes,
    // `bunEnv()` reads this to hand the multitenancy groups MT_TEST_* instead
    // of the shared URL. Written here so regenerating the groups cannot
    // silently drop the island declaration.
    directoryIslands: [...DIRECTORY_ISLANDS],
  };
  // Two-space indent, matching `biome format` for JSON: a regeneration then
  // leaves the committed file byte-identical instead of trading a reorder diff
  // (OCR round2 M1) for a whole-file reindent diff.
  writeFileSync(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`);
  return payload.groups.length;
}
