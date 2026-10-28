import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
   * MT031 in the same database. Keeping all thirteen in one process is what makes the chain's
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
    /*
     * PKG10 (#469) and the #459 T13-fix-2 suite: the unknown-effect and
     * crash-recovery faces read and settle the same dispatched rows the chain
     * above leaves behind (lease evidence, orphan settlement), so they run in
     * this sequential process rather than a racing sibling.
     */
    "server/tests/multitenancy/package-unknown.test.ts",
    "server/tests/multitenancy/package-crash-recovery.test.ts",
    /*
     * PKG06 (#465): the upgrade/rollback suite seeds the same installed chain
     * (applyPackageTasks) and its plan-preview reads it, same dedicated
     * database, same one-sequential-process rule.
     */
    "server/tests/multitenancy/package-upgrade.test.ts",
    /*
     * PKG09 (#468): the entrypoint suite seeds the same chain (applyPackageTasks)
     * against the same dedicated database, so it runs in this one sequential
     * process after the dispatch/upgrade suites rather than as a racing sibling.
     */
    "server/tests/multitenancy/package-entrypoints.test.ts",
    /*
     * PKG07 (#466) and PKG08 (#467): the lifecycle and withdraw suites install
     * the chain and then assert on its rows (tombstones, dispatch blocking);
     * the withdraw fixture also reads the same catalogue index.
     */
    "server/tests/multitenancy/package-lifecycle.test.ts",
    "server/tests/multitenancy/package-withdraw.test.ts",
    "server/tests/package-install.integration.test.ts",
  ],
  /*
   * T13-fix-1 (#459 A05): the withdraw-vs-dispatch contention suite installs
   * the same chain through ./support/package-install and shares the family's
   * enterprise test database, but measured on the integration HEAD it cannot
   * share the chain's process: with it appended to the chain above,
   * package-entrypoints' resumed-dispatch case and its own four contention
   * cases refuse dispatches and go red in the 14-file process while the
   * 13-file chain stays green on the same fresh database (both directions
   * re-measured). Like package-migration below, it seeds its own facts and
   * gets its own group — still named after the multitenancy island so
   * MT_TEST_DATABASE_URL routing applies — instead of racing the chain.
   */
  "server/tests/multitenancy/package-withdraw-contention": [
    "server/tests/multitenancy/package-withdraw-contention.test.ts",
  ],
  /*
   * PKG11 (#470): the legacy-migration drill drives the dry-run→apply CLI
   * against the enterprise test database (same environment as the chain
   * above, reached through server/src/db/client), but it does not join the
   * chain — it seeds its own pre-migration state. Its own group, still named
   * after the island so the `MT_TEST_DATABASE_URL` routing applies.
   */
  "server/tests/multitenancy/package-migration": [
    "server/tests/multitenancy/package-migration.test.ts",
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
  /*
   * PKG05 (#464): the store-side `pkg:` branch of callTool. It reads the
   * shared dev test database through server/src/db/client (like the
   * entrypoints store suite below) and needs no enterprise roles, so it gets
   * its own group.
   */
  "server/tests/package-dispatch-call": [
    "server/tests/package-dispatch-call.test.ts",
  ],
  /*
   * PKG08 (#467): the native face of deployment-side publish/withdraw —
   * CLI-level Bun.spawn cases against the on-disk index, its lock and its
   * artifacts, with no database — so it neither shares the multitenancy
   * environment nor the chain's database at all.
   */
  "server/tests/package-index-ops": ["server/tests/package-index-ops.test.ts"],
  /*
   * PKG09 (#468): the store/executor face of the entry support matrix. It reads
   * the shared dev test database for the audit/plugin tables (like PKG05's call
   * suite) and needs no enterprise roles, so it gets its own group.
   */
  "server/tests/package-entrypoints": [
    "server/tests/package-entrypoints.test.ts",
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
 * The better-auth island. Its suites need the five BA_TEST_* role URLs of their own, so — like the
 * multitenancy islands — they must not be re-sliced into their directory's shared-process batches.
 * Each task registers its own files through writeManifest with `payload.task`, and the batch is
 * named after the TaskId: `server/tests/better-auth:Txx.nn`. The `nn` is the task's batch counter,
 * so the name is stable no matter how many other tasks registered before or after, and one Issue
 * holds at most GROUP_SIZE files — more than that is a split-Issue signal, not a bigger batch.
 */
export const BA_ISLAND_DIR = "server/tests/better-auth";
export const BA_GROUP_NAME =
  /^server\/tests\/better-auth:(T\d+\.\d+)\.(\d{2,})$/;
const TASK_ID = /^T\d+\.\d+$/;

export function baBatchName(task, batch) {
  return `${BA_ISLAND_DIR}:${task}.${String(batch).padStart(2, "0")}`;
}

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

/** The grouping key a file lands under when the grouping is derived from scratch. */
function groupingKey(file) {
  const segments = file.split("/");
  const directory = segments.slice(0, 2).join("/");
  if (file.startsWith(`${BA_ISLAND_DIR}/`)) return BA_ISLAND_DIR;
  // A directory island keeps its full path as the key, because what separates it from the other
  // suites in the directory is the environment the group runs with, not the file name.
  const dirIsland = DIRECTORY_ISLANDS.find((dir) => file.startsWith(`${dir}/`));
  if (dirIsland) return dirIsland;
  const island = ISLANDS.find((prefix) => segments.at(-1).startsWith(prefix));
  return island ? `${directory}/${island.replace(/-$/, "")}` : directory;
}

/*
 * The from-scratch partition: what the directory/island rules say the corpus looks like with no
 * history. writeManifest no longer derives the groups this way — a full re-derivation renames and
 * re-slices groups that earlier tasks registered incrementally, which is exactly the drift the
 * preservation contract forbids. This stays exported for the process-shape measurements
 * (`scripts/e2e-driven-file-equality.mjs`) and for "what would a clean regroup look like" compares.
 */
export function groupsOf(files) {
  const byKey = new Map();
  for (const file of [...files].sort()) {
    const key = groupingKey(file);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(file);
  }
  const groups = [];
  for (const [key, list] of byKey) {
    for (let index = 0; index < list.length; index += GROUP_SIZE) {
      groups.push({
        name: `${key}${list.length > GROUP_SIZE ? ` part ${index / GROUP_SIZE + 1}` : ""}`,
        files: list.slice(index, index + GROUP_SIZE),
      });
    }
  }
  return groups;
}

/*
 * The manifest contract, as checkable accounting (T01.01 / #513):
 *
 *   - `files` is exactly flatten(`groups`): every driven file is scheduled by one group, every group
 *     member is a driven file. A file in `files` but in no group is a files-only registration — the
 *     driver would never run it. A group member missing from `files` schedules work the manifest
 *     does not own.
 *   - no file appears twice, in `files` or across groups: bun would run it twice and the accounting
 *     would count it once.
 *   - every group holds at most GROUP_SIZE files: that is the process-isolation unit the driver was
 *     measured at (ADR 0008 补充二), not a soft target.
 *   - better-auth files live in `server/tests/better-auth:Txx.nn` task batches and nowhere else, and
 *     those batches hold only better-auth files: a BA file drifting into a shared slice would run
 *     without its five dedicated role URLs.
 *   - group names are unique: the driver's E2E_BUN_ONLY filter matches by substring, and two groups
 *     with one name make "run exactly that group" ambiguous.
 *
 * The audit gate (`scripts/e2e-coverage-audit.mjs`) and writeManifest's own pre-write check both run
 * this, so the writer and the auditor cannot drift apart.
 */
export function manifestGaps(manifest) {
  const gaps = [];
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const groups = Array.isArray(manifest?.groups) ? manifest.groups : [];
  const listed = new Set();
  for (const file of files) {
    if (listed.has(file))
      gaps.push(`${file} is listed in files more than once`);
    listed.add(file);
  }
  if (files.length && !groups.length)
    gaps.push(
      `files-only registration: ${files.length} driven file(s) and no groups — write files and groups together through writeManifest, or the driver has nothing to schedule`,
    );
  const owner = new Map();
  const seenGroupNames = new Set();
  for (const group of groups) {
    const name = String(group?.name ?? "");
    const members = Array.isArray(group?.files) ? group.files : [];
    if (!name) gaps.push("a group has no name");
    if (seenGroupNames.has(name))
      gaps.push(`group name "${name}" is used by more than one group`);
    seenGroupNames.add(name);
    if (!members.length) gaps.push(`group "${name}" is empty`);
    if (members.length > GROUP_SIZE)
      gaps.push(
        `group "${name}" holds ${members.length} files (max ${GROUP_SIZE})`,
      );
    const isBaBatch = name.startsWith(`${BA_ISLAND_DIR}:`);
    if (isBaBatch && !BA_GROUP_NAME.test(name))
      gaps.push(
        `better-auth group "${name}" is not a TaskId batch (${BA_ISLAND_DIR}:Txx.nn)`,
      );
    for (const file of members) {
      const inBaDir = file.startsWith(`${BA_ISLAND_DIR}/`);
      if (isBaBatch && !inBaDir)
        gaps.push(
          `group "${name}" contains ${file}, which is not under ${BA_ISLAND_DIR}/`,
        );
      if (!isBaBatch && inBaDir)
        gaps.push(
          `better-auth file ${file} sits in "${name}" instead of a ${BA_ISLAND_DIR}:Txx.nn batch`,
        );
      if (owner.has(file))
        gaps.push(
          `${file} is a member of both "${owner.get(file)}" and "${name}"`,
        );
      else owner.set(file, name);
      if (!listed.has(file))
        gaps.push(`group "${name}" lists ${file}, which is not in files`);
    }
  }
  for (const file of files)
    if (!owner.has(file)) gaps.push(`${file} is in files but in no group`);
  return gaps;
}

/** The groups an existing manifest on `target` established, for preservation. */
function readGroups(target) {
  if (!existsSync(target)) return [];
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  return Array.isArray(parsed.groups) ? parsed.groups : [];
}

/*
 * Groups for files no preserved group covers. Better-auth files need their owning TaskId and become
 * that task's next `server/tests/better-auth:Txx.nn` batch; everything else is grouped by the
 * from-scratch rules, with a deterministic ` increment N` suffix when the natural name is already
 * taken — a preserved group owns its name, so an increment never borrows it.
 */
function freshGroups(fresh, task, taken, preserved) {
  const groups = [];
  const baFiles = fresh.filter((file) => file.startsWith(`${BA_ISLAND_DIR}/`));
  const rest = fresh.filter((file) => !file.startsWith(`${BA_ISLAND_DIR}/`));
  if (baFiles.length) {
    if (!task)
      throw new Error(
        `${baFiles.length} better-auth file(s) arrived with no owning TaskId (${baFiles.slice(0, 3).join(", ")}): register them through the task's own writeManifest call with payload.task set, so the batch gets a stable ${BA_ISLAND_DIR}:Txx.nn name`,
      );
    if (!TASK_ID.test(String(task)))
      throw new Error(
        `payload.task "${task}" is not a TaskId of the form Txx.nn`,
      );
    const held = preserved
      .filter((group) => BA_GROUP_NAME.exec(group.name)?.[1] === String(task))
      .reduce((total, group) => total + group.files.length, 0);
    if (held + baFiles.length > GROUP_SIZE)
      throw new Error(
        `task ${task} would hold ${held + baFiles.length} better-auth files (max ${GROUP_SIZE} per Issue): split the Issue before registering more`,
      );
    const batch = preserved.filter(
      (group) => BA_GROUP_NAME.exec(group.name)?.[1] === String(task),
    ).length;
    const name = baBatchName(task, batch + 1);
    taken.add(name);
    groups.push({ name, files: [...baFiles].sort() });
  }
  const byKey = new Map();
  for (const file of [...rest].sort()) {
    const key = groupingKey(file);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(file);
  }
  for (const [key, members] of byKey) {
    for (let index = 0; index < members.length; index += GROUP_SIZE) {
      const natural = `${key}${members.length > GROUP_SIZE ? ` part ${index / GROUP_SIZE + 1}` : ""}`;
      let name = natural;
      let bump = 1;
      while (taken.has(name)) name = `${natural} increment ${bump++}`;
      taken.add(name);
      groups.push({ name, files: members.slice(index, index + GROUP_SIZE) });
    }
  }
  return groups;
}

/*
 * Causes travel in a committed snapshot, so they must not carry the machine.
 * Collection errors quote absolute paths — this checkout's root, a sibling
 * worktree's root, the host home — and the c5197e54a regeneration persisted 20
 * of them verbatim, freezing one workstation's layout into
 * tests/config/e2e-bun-suites.json. The contract for a persisted cause: zero
 * `/Users/` occurrences. A path through any `workspaces/OpenBot/` checkout
 * folds to its repo-relative tail (the worktree name survives as the only hint
 * of where the error was measured); any other host-absolute path loses its
 * owner segment. The second replacement is the belt that keeps the contract,
 * not a claim about the shape of errors.
 */
export function sanitizeCauseText(text) {
  return String(text)
    .replace(/\/Users\/[^/\s"'`]+\/(?:[^/\s"'`]+\/)*workspaces\/OpenBot\//g, "")
    .replace(/\/Users\/[^/\s"'`]+/g, "<user>");
}

/*
 * THE one writer — and an incremental one. Groups the manifest on disk already establishes are kept
 * verbatim (name and members, in order): a registration may only append, never re-partition, so a
 * task's batch keeps its name and its membership for as long as its files exist. Only files no
 * existing group covers are grouped, by the new-group rules above. Before anything is written, the
 * resulting payload must satisfy manifestGaps() — files = flatten(groups), no duplicates, no
 * oversized group — so a writer that would break the accounting refuses instead of writing it.
 *
 * Every generator records the same payload shape here: the grouping (`groups`), the driven files, the
 * non-executable artifacts, the per-file `causes` evidence, and the `directoryIslands` the driver
 * (`tests/bun-suites.test.ts`) reads to hand the multitenancy groups their dedicated
 * `MT_TEST_DATABASE_URL`. Before this convergence the manifest had two mutually exclusive output
 * shapes — any writer could silently strip `directoryIslands` (51 multitenancy suites aborting on
 * the shared URL) or wipe another writer's `causes`. `audit` is a passthrough for generators that
 * derive the file list from an audit snapshot; writers that don't have one simply omit it
 * (JSON.stringify drops `undefined`). `target` exists for the contract tests: production callers
 * write the committed config, tests write a scratch file.
 * Causes are sanitized of host paths on the way in — see sanitizeCauseText.
 */
export function writeManifest(
  { files, artifacts, causes, audit, task },
  generatedBy,
  target = MANIFEST,
) {
  const list = [...files].sort();
  const present = new Set(list);
  const previous = readGroups(target);
  const claimed = new Set();
  const preserved = [];
  for (const group of previous) {
    const members = (group?.files ?? []).filter(
      (file) => present.has(file) && !claimed.has(file),
    );
    if (!members.length) continue;
    for (const file of members) claimed.add(file);
    preserved.push({ name: group.name, files: members });
  }
  const taken = new Set(preserved.map((group) => group.name));
  const fresh = list.filter((file) => !claimed.has(file));
  const groups = [...preserved, ...freshGroups(fresh, task, taken, preserved)];
  const gaps = manifestGaps({ files: list, groups });
  if (gaps.length)
    throw new Error(
      `refusing to write ${target}: the payload breaks the manifest contract\n  ${gaps.join("\n  ")}`,
    );
  const payload = {
    generatedBy,
    audit,
    groups,
    directoryIslands: [...DIRECTORY_ISLANDS],
    files: list,
    artifacts: [...artifacts].sort(),
    causes: Object.fromEntries(
      Object.entries(causes ?? {}).map(([file, cause]) => [
        file,
        sanitizeCauseText(cause),
      ]),
    ),
  };
  // Two-space indent with every array expanded: this writer owns the manifest's bytes, so a
  // regeneration of the same payload is byte-identical instead of trading a reorder diff
  // (OCR round2 M1) for a whole-file reindent diff. `biome format` would restyle short arrays
  // onto one line, so the committed file is deliberately not formatter-styled — the pre-T01.01
  // manifest was 1-space indent and never formatter-styled either.
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
  return payload.groups.length;
}

const MT_ROLE_URLS = {
  ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: "MT_TEST_DIRECTORY_DATABASE_URL",
  ENTERPRISE_TEST_DATA_DATABASE_URL: "MT_TEST_DATA_DATABASE_URL",
  ENTERPRISE_TEST_OPERATOR_DATABASE_URL: "MT_TEST_OPERATOR_DATABASE_URL",
};

/*
 * The better-auth island's five role URLs (acceptance V-B): all required, all mapped into the names
 * the BA fixture actually reads. `BA_TEST_AUTH_WRITER_DATABASE_URL` keeps its own name; the other
 * four are re-injected under their fixture names, with the setup/data URL doubling as the generic
 * `TEST_DATABASE_URL`/`DATABASE_URL` the data layer falls back to. Parent `ENTERPRISE_TEST_*` URLs
 * are stripped, never passed through: every role URL a better-auth subprocess sees was injected
 * from this table, so a job-level leftover cannot stand in for a BA role.
 */
const BA_ROLE_URLS = [
  [
    "BA_TEST_DATABASE_URL",
    ["TEST_DATABASE_URL", "DATABASE_URL", "ENTERPRISE_TEST_SETUP_DATABASE_URL"],
  ],
  [
    "BA_TEST_DIRECTORY_DATABASE_URL",
    ["ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"],
  ],
  ["BA_TEST_DATA_DATABASE_URL", ["ENTERPRISE_TEST_DATA_DATABASE_URL"]],
  ["BA_TEST_OPERATOR_DATABASE_URL", ["ENTERPRISE_TEST_OPERATOR_DATABASE_URL"]],
  ["BA_TEST_AUTH_WRITER_DATABASE_URL", ["BA_TEST_AUTH_WRITER_DATABASE_URL"]],
];

/*
 * Per-group environment routing for the driver (tests/bun-suites.test.ts). The multitenancy islands
 * take `MT_TEST_DATABASE_URL` when the environment offers one, and each capability role comes from
 * its `MT_TEST_*` counterpart — the island is self-contained and the job-level `ENTERPRISE_TEST_*`
 * URLs stay owned by the enterprise suites; with the override unset, routing is a passthrough and
 * the driver behaves exactly as it did before. The better-auth island is the other direction: it
 * runs only on its five BA_TEST_* role URLs (all five required, each missing one named) and never
 * inherits the shared, MT, or job-level URLs — the shared `openbot_test` database has no BA schema,
 * so a missing role URL is a blocked group (thrown, therefore a red result), never a quiet
 * downgrade. Presence-only by design: this routing hands URLs through and reads none of them.
 */
export function bunSuiteEnv(
  groupName,
  { env = process.env, directoryIslands = [] } = {},
) {
  if (groupName.startsWith(`${BA_ISLAND_DIR}:`)) {
    const missing = BA_ROLE_URLS.map(([name]) => name).filter(
      (name) => !env[name],
    );
    if (missing.length)
      throw new Error(
        `${groupName} is blocked: ${missing.length} of the 5 required BA_TEST_* URL(s) not set: ${missing.join(", ")}. A better-auth island group runs only on its five BA_TEST_* role URLs and does not inherit TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; set all five to run it.`,
      );
    const scoped = { ...env };
    delete scoped.TEST_DATABASE_URL;
    delete scoped.DATABASE_URL;
    for (const key of Object.keys(scoped)) {
      if (key.startsWith("MT_TEST_") || key.startsWith("ENTERPRISE_TEST_"))
        delete scoped[key];
    }
    for (const [source, targets] of BA_ROLE_URLS) {
      for (const target of targets) scoped[target] = env[source];
    }
    return scoped;
  }
  const override = env.MT_TEST_DATABASE_URL;
  if (!override) return env;
  if (!directoryIslands.some((dir) => groupName.startsWith(dir))) return env;
  const scoped = {
    ...env,
    TEST_DATABASE_URL: override,
    DATABASE_URL: override,
  };
  for (const [target, source] of Object.entries(MT_ROLE_URLS)) {
    const url = env[source];
    if (url) scoped[target] = url;
  }
  return scoped;
}
