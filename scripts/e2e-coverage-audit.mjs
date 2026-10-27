#!/usr/bin/env node
// The completion audit for "every test runs under tester-army e2e", stated as accounting.
//
// "All migrated" is only checkable if each suite file lands in exactly one of three buckets, and any
// file in none of them is a gap:
//
//   native   collected and executed by e2e on Node (imports the e2e-backed compat layer)
//   driven   scheduled and reported by e2e, executed by `bun test` (the Bun-runtime tier, ADR 0008)
//   excluded named in a manifest with a reason: an artifact that cannot run here, or a suite this
//            repository's own fixture broke — `bun run test:ci` prints the count so it cannot grow
//            silently
//
// A file on the bun:test layer — `bun:test` or `support/bun-test-compat` — that is not driven, a file
// that imports neither layer, or a driven file that still imports the e2e layer, is a gap: the first
// aborts collection, the second never runs, the third hits Node-only code under Bun. Exits non-zero so
// CI can gate on it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { LIVE_SUITES, manifestGaps, SUITE_DIRS } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");

/*
 * The BA foreign channel (T01.10 / #522): the suites that live in the submodules (apps/openmuse on
 * Bun, bifrost governance on Go) are scheduled and reported by root e2e through
 * tests/better-auth-foreign.test.ts, executing only what tests/config/better-auth-foreign-suites.json
 * whitelists. The structural half of that contract — entries reference declared types, argv is a
 * template over {{target}}/{{reportPath}} only, no field can carry a command — is enforced by the
 * driver itself and its contract tests (tests/better-auth-foreign-driver.test.ts), which run fixture
 * registries through the same gate. What the audit pins here is the boundary: the two committed
 * runner types may not drift (widening the channel is a reviewed change to this file), every task
 * entry must name an existing type and a safe relative target, and the executor the registry names
 * must exist — so the audit can always say who actually executes these corpora.
 */
const BA_FOREIGN_WHITELIST = "tests/config/better-auth-foreign-suites.json";
const BA_FOREIGN_EXECUTOR = "tests/better-auth-foreign.test.ts";
const BA_FOREIGN_TYPES = {
  "openmuse-bun": { runner: "bun", cwd: "apps/openmuse", report: "bun-junit" },
  "bifrost-go-governance": { runner: "go", cwd: "bifrost", report: "go-json" },
};
const BA_FOREIGN_TASK_ID = /^T\d+\.\d+$/;
const BA_FOREIGN_SHELLISH = /[;&|`$<>()\\\n\r]/;

function baForeignAudit() {
  const gaps = [];
  const path = join(root, BA_FOREIGN_WHITELIST);
  if (!existsSync(path))
    return {
      gaps: [
        `${BA_FOREIGN_WHITELIST} is missing: BA_FOREIGN_SUITE schedules only whitelisted targets, and a channel cannot be audited by silence`,
      ],
      tasks: 0,
      targets: 0,
      types: [],
    };
  let registry;
  try {
    registry = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      gaps: [`${BA_FOREIGN_WHITELIST} does not parse: ${error.message}`],
      tasks: 0,
      targets: 0,
      types: [],
    };
  }
  if (!existsSync(join(root, BA_FOREIGN_EXECUTOR)))
    gaps.push(
      `${BA_FOREIGN_EXECUTOR} is missing: the whitelist names it as the scheduler and reporter of the foreign corpora`,
    );
  if (registry.version !== 1)
    gaps.push(
      `${BA_FOREIGN_WHITELIST}: version must be 1 (found ${JSON.stringify(registry.version)})`,
    );
  if (registry.executedBy !== BA_FOREIGN_EXECUTOR)
    gaps.push(
      `${BA_FOREIGN_WHITELIST}: executedBy must name ${BA_FOREIGN_EXECUTOR} (found ${JSON.stringify(registry.executedBy)})`,
    );
  const types = registry.runnerTypes ?? {};
  const pinnedIds = Object.keys(BA_FOREIGN_TYPES).sort();
  const ids = Object.keys(types).sort();
  if (ids.join(",") !== pinnedIds.join(","))
    gaps.push(
      `${BA_FOREIGN_WHITELIST}: runner types must be exactly ${pinnedIds.join(", ")} (found ${ids.join(", ") || "none"}) — widening the channel is a reviewed change to the audit, not an edit to the whitelist`,
    );
  for (const [id, pin] of Object.entries(BA_FOREIGN_TYPES)) {
    const type = types[id];
    if (!type) continue;
    for (const key of ["runner", "cwd", "report"])
      if (type[key] !== pin[key])
        gaps.push(
          `${BA_FOREIGN_WHITELIST}: runner type ${id}.${key} must be ${pin[key]} (found ${JSON.stringify(type[key])})`,
        );
    if (
      !Array.isArray(type.argv) ||
      type.argv[0] !== "test" ||
      type.argv.some(
        (argument) =>
          typeof argument !== "string" || BA_FOREIGN_SHELLISH.test(argument),
      )
    )
      gaps.push(
        `${BA_FOREIGN_WHITELIST}: runner type ${id} argv must be plain bun/go \`test\` arguments`,
      );
  }
  const tasks = Array.isArray(registry.tasks) ? registry.tasks : [];
  if (!Array.isArray(registry.tasks))
    gaps.push(`${BA_FOREIGN_WHITELIST}: tasks must be an array`);
  let targets = 0;
  for (const entry of tasks) {
    const task = String(entry?.task ?? "");
    if (!BA_FOREIGN_TASK_ID.test(task))
      gaps.push(
        `${BA_FOREIGN_WHITELIST}: task "${task}" is not a TaskId of the form Txx.nn`,
      );
    for (const key of Object.keys(entry ?? {}))
      if (key !== "task" && key !== "targets")
        gaps.push(
          `${BA_FOREIGN_WHITELIST}: task ${task} carries "${key}": an entry may name only its targets — the whitelist is not a command list`,
        );
    const entryTargets = Array.isArray(entry?.targets) ? entry.targets : [];
    if (!entryTargets.length)
      gaps.push(`${BA_FOREIGN_WHITELIST}: task ${task} registers no target`);
    targets += entryTargets.length;
    for (const target of entryTargets) {
      for (const key of Object.keys(target ?? {}))
        if (key !== "type" && key !== "target")
          gaps.push(
            `${BA_FOREIGN_WHITELIST}: task ${task} target carries "${key}": only a declared runner type and a target path`,
          );
      if (!Object.hasOwn(types, String(target?.type)))
        gaps.push(
          `${BA_FOREIGN_WHITELIST}: task ${task} target uses undeclared runner type "${target?.type}"`,
        );
      const targetPath = String(target?.target ?? "");
      if (
        !targetPath ||
        targetPath.startsWith("/") ||
        targetPath.startsWith("-") ||
        targetPath.split("/").includes("..") ||
        BA_FOREIGN_SHELLISH.test(targetPath)
      )
        gaps.push(
          `${BA_FOREIGN_WHITELIST}: task ${task} target "${targetPath}" is not a safe relative path`,
        );
    }
  }
  return { gaps, tasks: tasks.length, targets, types: ids };
}

/*
 * The manifest contract gate runs before anything else, and `--manifest=<path>` checks one manifest
 * in isolation (no corpus walk). The isolation mode is how the contract test exercises the refusal:
 * this tree's corpus walk can have tier gaps of its own, and a full-audit failure must never be
 * readable as "the manifest contract refused". In the default mode the gate still runs first — a
 * files-only, duplicated or out-of-group manifest invalidates every classification below it, so
 * accounting on top of it would be theatre.
 */
const manifestArg = process.argv.find((arg) => arg.startsWith("--manifest="));
const manifestPath = manifestArg
  ? resolve(root, manifestArg.slice("--manifest=".length))
  : join(root, "tests/config/e2e-bun-suites.json");
const manifestOnly = Boolean(manifestArg);
const parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const contractGaps = manifestGaps(parsedManifest);
if (contractGaps.length) {
  console.log(
    `MANIFEST CONTRACT (${contractGaps.length}) — ${manifestPath.replace(`${root}/`, "")} does not satisfy files = flatten(groups):`,
  );
  for (const gap of contractGaps.slice(0, 40)) console.log(`  ${gap}`);
  process.exit(1);
}
if (manifestOnly) {
  console.log(
    `${manifestPath.replace(`${root}/`, "")}: files = flatten(groups), no duplicates, better-auth files in their TaskId batches — no contract gaps.`,
  );
  process.exit(0);
}

/*
 * The BA foreign channel's gate runs before the corpus walk, for the same reason the manifest gate
 * does: a drifted whitelist invalidates the foreign-channel accounting below it, and a check placed
 * after the tier walk would be masked by this tree's pre-existing tier gaps and never execute.
 */
const baForeign = baForeignAudit();
if (baForeign.gaps.length) {
  console.log(
    `\nBA FOREIGN WHITELIST (${baForeign.gaps.length}) — the foreign channel's fixed types and executor must stay pinned and named:`,
  );
  for (const gap of baForeign.gaps) console.log(`  ${gap}`);
  process.exit(1);
}

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const dirs = SUITE_DIRS;
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.test\.(tsx?|mts)$|\.spec\.(tsx?|mts)$|\.e2e\.tsx?$/.test(entry))
      files.push(full);
  }
}
for (const dir of dirs) {
  // deliverables/ is a gitignored build product: its absence means "no suites there", not a broken
  // walk — worktree checkouts never have it, and an ENOENT crash would gate every audit on a build.
  if (!existsSync(join(root, dir))) {
    console.error(
      `(audit) suite directory ${dir} is absent; nothing to account there`,
    );
    continue;
  }
  walk(join(root, dir));
}

const driven = new Set(parsedManifest.files ?? []);
const artifacts = new Set(parsedManifest.artifacts ?? []);
const live = new Set(LIVE_SUITES);
const broken = new Set(
  (
    JSON.parse(
      readFileSync(join(root, "tests/config/e2e-known-broken.json"), "utf8"),
    ).entries ?? []
  ).map((entry) => entry.file),
);

/*
 * The engine-tier suites (T04.12 / plan F4): the browser corpus is not one collector. The default
 * config collects tests/e2e/*.e2e.ts against the legacy stack, and every other engine family (BA
 * Web now; BA Mobile later) gets its own config, its own target, and a preflight that must run
 * before any engine is created. `--engine-list` audits the committed manifest against the corpus
 * and the real configs; `--engine-manifest=<path>` checks one manifest in isolation (no corpus
 * walk), which is how the isolation counterexample exercises the refusal without mutating the
 * committed config — the same shape as the `--manifest=` mode above. Both modes exit before the
 * tier walk: an engine-manifest failure must not be readable as this tree's pre-existing tier gaps.
 */
const ENGINE_MANIFEST = "tests/config/e2e-engine-suites.json";
const ENGINE_SUITE_KEYS = [
  "config",
  "files",
  "name",
  "preflight",
  "script",
  "target",
  "tests",
];

/*
 * The two glob shapes these configs use: `dir/*.ext` (one directory level) and a trailing `/**`.
 * e2e's own globs support `*`, `?`, and a whole `**` segment — no middle `**`, so the matcher
 * below is exact for every pattern a suite may register, and loudly fails on anything else.
 */
function globMatches(pattern, path) {
  if (pattern.endsWith("/**"))
    return path.startsWith(`${pattern.slice(0, -3)}/`);
  if (pattern.split("/").includes("**"))
    throw new Error(
      `engine-suite glob uses ** in a position this audit cannot check: ${pattern}`,
    );
  const expression = pattern
    .split("/")
    .map((segment) =>
      segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join("/");
  return new RegExp(`^${expression}$`).test(path);
}

function collects(globs, file) {
  const positives = globs.filter((glob) => !glob.startsWith("!"));
  const negatives = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));
  return (
    positives.some((glob) => globMatches(glob, file)) &&
    !negatives.some((glob) => globMatches(glob, file))
  );
}

function engineSuitesGaps(manifest, root) {
  const gaps = [];
  if (manifest.version !== 1)
    gaps.push(
      `${ENGINE_MANIFEST}: version must be 1 (found ${JSON.stringify(manifest.version)})`,
    );
  const suites = Array.isArray(manifest.suites) ? manifest.suites : null;
  if (!suites?.length) {
    gaps.push(
      `${ENGINE_MANIFEST}: no suites — the engine tier is claimed by no collector`,
    );
    return { gaps, suites: [] };
  }
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const seenNames = new Set();
  const seenConfigs = new Set();
  const claims = new Map();
  for (const suite of suites) {
    const name = String(suite?.name ?? "");
    if (!name) gaps.push("a suite has no name");
    if (seenNames.has(name)) gaps.push(`suite name "${name}" is used twice`);
    seenNames.add(name);
    const keys = Object.keys(suite ?? {}).sort();
    if (keys.join(",") !== ENGINE_SUITE_KEYS.join(","))
      gaps.push(
        `suite "${name}" carries ${JSON.stringify(keys)}: an entry is exactly ${ENGINE_SUITE_KEYS.join(", ")}`,
      );
    const config = String(suite?.config ?? "");
    if (seenConfigs.has(config))
      gaps.push(
        `config ${config} is shared by two suites — one config is one collector`,
      );
    seenConfigs.add(config);
    if (!existsSync(join(root, config)))
      gaps.push(`suite "${name}": config ${config} does not exist`);
    const script = packageJson.scripts?.[suite?.script];
    // `e2e run` with no --config resolves the nearest e2e.config.ts — that IS the default suite's
    // collector, exactly what engineEntry() below already credits.
    const scriptSelectsThisConfig =
      typeof script === "string" &&
      /\be2e run\b/.test(script) &&
      (script.includes(`--config ${config}`) ||
        (!script.includes("--config") && config === "e2e.config.ts"));
    if (!scriptSelectsThisConfig)
      gaps.push(
        `suite "${name}": package.json script "${suite?.script}" must run this suite's collector (found ${JSON.stringify(script)})`,
      );
    const globs = suite?.tests;
    if (
      !Array.isArray(globs) ||
      !globs.length ||
      !globs.every(
        (glob) => typeof glob === "string" && glob && !glob.startsWith("/"),
      ) ||
      !globs.some((glob) => !glob.startsWith("!"))
    )
      gaps.push(
        `suite "${name}": tests must be a non-empty glob list with at least one positive glob`,
      );
    if (typeof suite?.target !== "string" || !suite.target.trim())
      gaps.push(`suite "${name}": target must say what the collector drives`);
    if (suite?.preflight !== null) {
      if (
        typeof suite.preflight !== "string" ||
        !suite.preflight.startsWith("tests/support/") ||
        !existsSync(join(root, suite.preflight))
      ) {
        gaps.push(
          `suite "${name}": preflight must be a tests/support/ file that exists, or null for the pre-contract legacy collector`,
        );
      } else {
        const configSource = readFileSync(join(root, config), "utf8");
        if (!configSource.includes(suite.preflight))
          gaps.push(
            `suite "${name}": ${config} does not load its preflight (${suite.preflight}) — the preflight must run at config load, before any engine`,
          );
        for (const file of Array.isArray(suite.files) ? suite.files : []) {
          // The guard is imported by module path (../../../support/<name>), so the check matches
          // the preflight's basename without extension, not the manifest's repo-relative string.
          const guardModule = suite.preflight
            .replace(/\.ts$/, "")
            .split("/")
            .pop();
          const source = readFileSync(join(root, file), "utf8");
          if (!source.includes(guardModule))
            gaps.push(
              `${file} does not import the ${name} suite guard (${suite.preflight}): collected by any other config, it would run silently`,
            );
        }
      }
    }
    for (const file of Array.isArray(suite?.files) ? suite.files : []) {
      if (
        typeof file !== "string" ||
        file.startsWith("/") ||
        file.split("/").includes("..")
      ) {
        gaps.push(`suite "${name}": "${file}" is not a safe relative path`);
        continue;
      }
      if (!existsSync(join(root, file))) {
        gaps.push(`suite "${name}": ${file} does not exist on disk`);
        continue;
      }
      if (claims.has(file))
        gaps.push(
          `${file} is claimed by both "${claims.get(file)}" and "${name}"`,
        );
      else claims.set(file, name);
      try {
        if (Array.isArray(globs) && !collects(globs, file))
          gaps.push(
            `suite "${name}": its collector does not collect ${file} — files and collector disagree`,
          );
      } catch (error) {
        gaps.push(`suite "${name}": ${error.message}`);
      }
    }
  }
  for (const [file, owner] of claims) {
    for (const other of suites) {
      if (other?.name === owner) continue;
      try {
        if (Array.isArray(other?.tests) && collects(other.tests, file))
          gaps.push(
            `${file} is also collected by "${other.name}" — the engine collectors must be mutually exclusive`,
          );
      } catch (error) {
        gaps.push(`suite "${other?.name}": ${error.message}`);
      }
    }
  }
  return { gaps, suites, claims };
}

const engineManifestArg = process.argv.find((argument) =>
  argument.startsWith("--engine-manifest="),
);
if (engineManifestArg || process.argv.includes("--engine-list")) {
  const manifestFile = engineManifestArg
    ? resolve(root, engineManifestArg.slice("--engine-manifest=".length))
    : join(root, ENGINE_MANIFEST);
  let engineManifest;
  try {
    engineManifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch (error) {
    console.log(
      `${manifestFile.replace(`${root}/`, "")} does not parse: ${error.message}`,
    );
    process.exit(1);
  }
  const { gaps, suites, claims } = engineSuitesGaps(engineManifest, root);
  if (process.argv.includes("--engine-list")) {
    // The corpus half of the accounting, using the same classification the tier walk below uses:
    // a file is engine tier when its extension says so or its source imports an engine package,
    // and the named exclusions (artifacts, broken, live) stay out of every bucket.
    const engineTier = [];
    for (const file of files) {
      const rel = file.replace(`${root}/`, "");
      if (artifacts.has(rel) || broken.has(rel) || live.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (/\.e2e\.tsx?$/.test(rel) || /from "@e2e-dev\//.test(source))
        engineTier.push(rel);
    }
    for (const rel of engineTier)
      if (!claims.has(rel))
        gaps.push(
          `${rel} is an engine-tier file no suite claims — register it in ${ENGINE_MANIFEST} with its own task`,
        );
    for (const file of claims.keys())
      if (!engineTier.includes(file))
        gaps.push(
          `${file} is claimed by an engine suite but is not an engine-tier file`,
        );
  }
  console.log(
    `ENGINE SUITES (${suites.length}) — ${suites
      .map((suite) => `${suite.name}: ${suite.files?.length ?? 0} file(s)`)
      .join(" · ")}`,
  );
  if (gaps.length) {
    console.log(
      `\nENGINE-SUITE GAPS (${gaps.length}) — the browser collectors and their manifest disagree:`,
    );
    for (const gap of gaps.slice(0, 40)) console.log(`  ${gap}`);
    process.exit(1);
  }
  console.log(
    "no gaps: every engine file is claimed by exactly one suite, each collector matches its manifest group, and the preflight/guard wiring is in place.",
  );
  process.exit(0);
}

const buckets = { native: [], driven: [], engine: [], excluded: [], gap: [] };
for (const file of files) {
  const rel = file.replace(`${root}/`, "");
  const source = readFileSync(file, "utf8");
  const importsBunTest = /^import[\s\S]{0,400}?from ["']bun:test["'];/m.test(
    source,
  );
  const bunLayer = /support\/bun-test-compat["']/.test(source);
  const e2eLayer = /support\/e2e-compat["']/.test(source);
  const engine = /\.e2e\.tsx?$/.test(rel) || /from "@e2e-dev\//.test(source);
  if (artifacts.has(rel) || broken.has(rel) || live.has(rel))
    buckets.excluded.push(rel);
  else if (engine) buckets.engine.push(rel);
  else if (driven.has(rel)) {
    if (!importsBunTest && !bunLayer)
      buckets.gap.push(`${rel} (driven but not on the bun:test layer)`);
    else buckets.driven.push(rel);
  } else if (importsBunTest || bunLayer)
    buckets.gap.push(
      `${rel} (imports the bun:test layer, not driven → Node collection aborts the whole run)`,
    );
  else if (e2eLayer) buckets.native.push(rel);
  else if (/^\s*(test|describe)\s*\(/m.test(source))
    buckets.gap.push(`${rel} (registers tests, imports no runner)`);
  else buckets.gap.push(`${rel} (no runner import and no registrations)`);
}

/*
 * The entry points are part of the claim. A session that reverts `bun run test` back to a `bun test`
 * list silently un-migrates the whole corpus while every suite file above still looks correct, so the
 * scripts and the CI workflows are read as they are rather than trusted from memory. (This happened
 * once already: an integration merge restored the old `test` script and it had to be re-pointed.)
 *
 * Every package.json in the tree counts as an entry point, and every script name — not just one
 * called `test`. Two nested packages kept their own `bun test` (`agent-sandbox`'s `test`, `server`'s
 * `kb:test`) while the root-only scan reported the corpus fully migrated, which is the difference
 * between "the scripts I thought about" and "the scripts that exist".
 */
function entryPointGaps() {
  const gaps = [];
  const seen = [];
  const notCode = new Set([...SKIP, "archive", ".mimosa", "deliverables"]);
  const walkPackages = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (notCode.has(entry.name) || entry.name.startsWith(".")) continue;
        walkPackages(join(dir, entry.name));
      } else if (entry.name === "package.json") {
        seen.push(join(dir, entry.name));
      }
    }
  };
  walkPackages(root);
  for (const file of seen) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      gaps.push(`${relative(root, file)}: unreadable package.json`);
      continue;
    }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (/\bbun\s+(test|x\s+test)\b/.test(String(command)))
        gaps.push(`${relative(root, file)} "${name}": ${command}`);
    }
  }
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split(
      "\n",
    )) {
      if (/\bbun\s+(test|x\s+test)\b/.test(line) && !/^\s*[#-]*\s*#/.test(line))
        gaps.push(`${file}: ${line.trim().slice(0, 130)}`);
    }
  }
  return gaps;
}

/*
 * Tier agreement. A suite that imports `support/bun-test-compat` is written for the Bun runtime, and
 * e2e.unit.config.ts excludes files from native collection *by manifest membership* — so such a file
 * missing from the manifest is collected on Node and aborts the whole run with
 * `Only URLs with a scheme in: file, data, and node … 'bun:'`. That is how a billing commit on main
 * broke CI's tests job while this audit still printed `no gaps`: it accepted any `support/*-compat`
 * import as native and never compared the imported layer against the manifest. The check lives in the
 * classification loop above, so a mis-tiered file is a gap rather than a native count.
 */
/*
 * Foreign runners. The claim "every test runs under tester-army e2e" is only honest if the corpora
 * e2e cannot execute are *named* — and naming them once is not enough, because the boundary moves:
 * a new `python -m pytest agent-new/tests` job or a deleted Go job both leave the registry, and the
 * audit, lying quietly. So every workflow line that invokes a non-e2e runner — including one that
 * selects the BA foreign driver through BA_FOREIGN_SUITE — must match an entry, and every entry must
 * still match something in the tree.
 */
const FOREIGN_TRIGGER =
  /(python -m pytest .*|cargo test .*|\bgo test .*|BA_FOREIGN_SUITE=\S+ .*)$/;
function foreignGaps() {
  const gaps = [];
  const registryPath = join(root, "tests/config/e2e-foreign-suites.json");
  if (!existsSync(registryPath))
    return [
      "tests/config/e2e-foreign-suites.json is missing: a corpus e2e cannot execute must be migrated or named there, not left out of the walk.",
    ];
  const entries = JSON.parse(readFileSync(registryPath, "utf8")).entries ?? [];
  const seen = new Set();
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split(
      "\n",
    )) {
      const trimmed = line
        .trim()
        .replace(/^-\s*/, "")
        .replace(/^run:\s*/, "");
      if (!trimmed || trimmed.startsWith("#")) continue;
      const hit = trimmed.match(FOREIGN_TRIGGER);
      if (!hit) continue;
      const command = hit[1].trim();
      const named = entries.some((entry) =>
        new RegExp(entry.pattern).test(command),
      );
      if (!named)
        gaps.push(
          `${file}: \`${command}\` runs a non-e2e test corpus that no entry in tests/config/e2e-foreign-suites.json names`,
        );
      entries.forEach((entry, index) => {
        if (new RegExp(entry.pattern).test(command)) seen.add(index);
      });
    }
  }
  entries.forEach((entry, index) => {
    // `invoked: false` is the shape of a named hole: the corpus exists and nothing runs it. Requiring
    // it to be invoked would turn the finding back into a green check, which is the opposite of why
    // the Go row is here.
    if (!seen.has(index) && entry.invoked !== false)
      gaps.push(
        `${entry.runner}: named in the registry but invoked by no workflow any more — the boundary moved, so either the corpus came back to e2e or the job was dropped; say which and delete the entry`,
      );
  });
  return gaps;
}

/*
 * The engine tier needs its own entry check. `tests/e2e/*.e2e.ts` is collected by e2e's *default*
 * config (measured: `bunx e2e list` with no `--config` selects exactly those 10 files / 28 tests, the
 * same set `--config e2e.config.ts` gives), so counting them as "scheduled by e2e" is only honest if
 * some entry point actually invokes that default. It also must not be read as CI coverage: the only
 * entry is a human-run script, and the job list says no workflow runs it.
 */
function engineEntry() {
  const scripts = Object.entries(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {},
  );
  const entry = scripts.find(
    ([, command]) =>
      /\be2e\s+run\b/.test(String(command)) &&
      !/--config\s+\S*unit\.config/.test(String(command)),
  );
  const inCI = [];
  const workflows = join(root, ".github", "workflows");
  for (const file of readdirSync(workflows)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(workflows, file), "utf8").split(
      "\n",
    )) {
      if (!/\be2e run\b/.test(line) || /unit\.config/.test(line)) continue;
      if (/\.e2e\.(ts|tsx)/.test(line) || /run test:ui/.test(line))
        inCI.push(file);
    }
  }
  return {
    name: entry ? `bun run ${entry[0]}` : null,
    scheduledInCI: [...new Set(inCI)],
  };
}

const engineEntryInfo = engineEntry();
const foreign = foreignGaps();
const entries = entryPointGaps();
if (buckets.engine.length && !engineEntryInfo.name)
  entries.push(
    `engine tier: ${buckets.engine.length} .e2e.ts files are collected only by e2e's default config, and no script invokes \`e2e run\` without --config`,
  );
console.log(
  `${files.length} suite files in the 14 migrated directories · ${buckets.native.length} native e2e · ${buckets.driven.length} driven by e2e (bun runtime) · ${buckets.engine.length} engine (.e2e.ts, web/mobile) · ${buckets.excluded.length} named exclusions`,
);
console.log(
  `BA foreign channel: ${baForeign.targets} target(s) across ${baForeign.tasks} task(s) · runner types ${baForeign.types.join(", ") || "none"} · scheduled and reported by ${BA_FOREIGN_EXECUTOR} (BA_FOREIGN_SUITE=TaskId; a target absent from this checkout blocks, it does not pass)`,
);
if (buckets.gap.length) {
  console.log(
    `\nGAPS (${buckets.gap.length}) — each one means the corpus is not fully accounted:`,
  );
  for (const gap of buckets.gap.slice(0, 40)) console.log(`  ${gap}`);
  process.exit(1);
}
if (foreign.length) {
  console.log(
    `\nFOREIGN RUNNERS (${foreign.length}) — the boundary between e2e and the runners e2e cannot execute must stay named:`,
  );
  for (const gap of foreign) console.log(`  ${gap}`);
  process.exit(1);
}
if (entries.length) {
  console.log(
    `\nENTRY-POINT GAPS (${entries.length}) — every suite may be scheduled by e2e while the command that runs it is not:`,
  );
  for (const gap of entries) console.log(`  ${gap}`);
  process.exit(1);
}
console.log(
  "\nno gaps: every suite file is scheduled by e2e, every test entry point runs e2e, and exclusions are named with a reason.",
);
console.log(
  `engine tier entry: ${engineEntryInfo.name ?? "none"} · scheduled by CI: ${
    engineEntryInfo.scheduledInCI.length
      ? engineEntryInfo.scheduledInCI.join(", ")
      : "no — nothing in .github/workflows runs it, so those tests are collected and reported by e2e but never executed there (audit item 7)"
  }`,
);
