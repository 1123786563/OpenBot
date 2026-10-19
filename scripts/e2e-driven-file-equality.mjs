#!/usr/bin/env node
// Does the driven tier judge each file the way the pre-migration process shape did?
//
// The pre-migration entry handed `bun test` a single process for the whole corpus
// (`bun test ./app ./agent-bot … ./worker` — fourteen path filters, no isolation). The driven tier
// slices each directory into GROUP_SIZE-file groups (tests/bun-suites.test.ts). Fewer files per
// process is strictly less shared state, so the shapes can disagree on a file, and the disagreement
// worth chasing is the asymmetric one: a file the big shared process fails while the driven tier
// reports it inside a passing group.
//
// Every shape here is executed by `bun test` itself, on the same tree, with the same suite text and
// the same database — this is not a runner-vs-runner comparison. It also deliberately does not read
// the e2e report: the driver's assertion message lists only its first four failing files, and
// scraping that text produced 69 "the driver never named it" mismatches that were this measurement's
// own blind spot rather than hidden failures. Per-file counts come from junit in every shape, and the
// slice boundaries come from the same grouping the routing tools use.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { groupsOf, readManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = resolve(
  root,
  arg("out", "docs/verification/e2e-driven-file-equality.json"),
);
const timeoutMs = Number(arg("timeout", 900_000));
const shapes = (arg("shapes", "group,directory,corpus") || "")
  .split(",")
  .filter(Boolean);

/*
 * A driven file can sit two segments deep (`shared/x.test.ts`), where "the directory" is the top
 * segment. Taking two segments anyway yields a key that is a file path, whose prefix match finds no
 * files — and `bun test` handed an empty list runs the whole repository.
 */
const keyOf = (file) => {
  const segments = file.split("/");
  return segments.length > 2 ? segments.slice(0, 2).join("/") : segments[0];
};

/** One `bun test` process over `files`, reduced to per-file case and failure counts. */
function runShape(files) {
  const work = mkdtempSync(join(tmpdir(), "e2e-driven-eq-"));
  const junit = join(work, "junit.xml");
  const child = spawnSync(
    "bun",
    [
      "test",
      ...files.map((f) => `./${f}`),
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ],
    { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 28 },
  );
  const perFile = new Map();
  if (existsSync(junit)) {
    const xml = readFileSync(junit, "utf8");
    for (const block of xml.matchAll(
      /<testcase\b[\s\S]*?(?:\/>|<\/testcase>)/g,
    )) {
      const tag = /<testcase\b[^>]*>/.exec(block[0])?.[0];
      const attribute = tag ? /file="([^"]+)"/.exec(tag)?.[1] : undefined;
      if (!attribute) continue;
      const rel = attribute.replace(`${root}/`, "");
      const entry = perFile.get(rel) ?? { tests: 0, failures: 0 };
      entry.tests++;
      // A self-closed case passed; a body carries `<failure>` or `<skipped/>`, and counting a
      // skipped case as red would invent disagreements.
      if (/<failure\b/.test(block[0])) entry.failures++;
      perFile.set(rel, entry);
    }
  }
  rmSync(work, { recursive: true, force: true });
  return { perFile, exit: child.status ?? `signal ${child.signalCode}` };
}

const manifest = readManifest();
const driven = [...manifest.files];
const batchesFor = (shape) => {
  if (shape === "group") return groupsOf(manifest.files);
  if (shape === "corpus")
    return [{ name: "all-driven", files: [...driven].sort() }];
  return [...new Set(driven.map(keyOf))].sort().map((directory) => ({
    name: directory,
    files: driven.filter((f) => keyOf(f) === directory).sort(),
  }));
};

const counts = {};
const runs = {};
for (const shape of shapes) {
  counts[shape] = new Map();
  runs[shape] = [];
  for (const batch of batchesFor(shape)) {
    if (!batch.files.length) continue;
    const { perFile, exit } = runShape(batch.files);
    for (const [file, entry] of perFile) counts[shape].set(file, entry);
    runs[shape].push({
      batch: batch.name,
      files: batch.files.length,
      judged: perFile.size,
      exit,
      note: perFile.size
        ? ""
        : "no junit parsed — this batch is unmeasured, not green",
    });
    console.log(
      `${shape} ${batch.name}: files ${batch.files.length} · judged ${perFile.size} · exit ${exit}`,
    );
  }
}

const verdict = (shape, file) => {
  const entry = counts[shape]?.get(file);
  if (!entry) return "unmeasured";
  return entry.failures > 0
    ? `red (${entry.failures}/${entry.tests})`
    : `green (${entry.tests})`;
};

const every = new Set(
  shapes.flatMap((shape) => [...(counts[shape]?.keys() ?? [])]),
);
const disagreements = [];
for (const file of [...every].sort()) {
  const readings = shapes.map((shape) => verdict(shape, file));
  if (new Set(readings).size > 1)
    disagreements.push({
      file,
      readings: Object.fromEntries(shapes.map((s, i) => [s, readings[i]])),
    });
}

writeFileSync(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      shapes,
      manifestFiles: driven.length,
      judged: Object.fromEntries(
        shapes.map((shape) => [shape, counts[shape].size]),
      ),
      runs,
      disagreements,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `\njudged per shape: ${shapes.map((s) => `${s} ${counts[s].size}`).join(" · ")} · manifest ${driven.length}`,
);
console.log(
  `files whose verdict depends on the process shape: ${disagreements.length}`,
);
for (const d of disagreements.slice(0, 40))
  console.log(
    `  ${d.file}\n     ${shapes.map((s) => `${s}=${d.readings[s]}`).join(" · ")}`,
  );
const unjudged = driven.filter((f) =>
  shapes.every((shape) => !counts[shape].has(f)),
);
if (unjudged.length)
  console.log(
    `\n${unjudged.length} driven file(s) produced no junit in any shape (unmeasured, not green): ${unjudged.slice(0, 8).join(", ")}`,
  );
console.log(`\nwrote ${out.replace(`${root}/`, "")}`);
