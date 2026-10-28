#!/usr/bin/env node
// Record one suite as Bun-driven, using the runner's own words as the evidence.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readManifest, writeManifest } from "./lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const [file, ...reason] = process.argv.slice(2);
if (!file) {
  console.error(
    "usage: node scripts/e2e-add-driven.mjs <suite-file> [reason…]",
  );
  process.exit(2);
}
const manifest = readManifest();
const existed = manifest.files.has(file);
manifest.files.add(file);
manifest.causes[file] =
  `runner named it: ${reason.join(" ") || "cannot load under Node"}`;
const groups = writeManifest(manifest, "scripts/e2e-add-driven.mjs");
spawnSync("node", ["scripts/e2e-apply-partition.mjs"], {
  cwd: root,
  encoding: "utf8",
});
console.log(
  `${existed ? "already" : "added"} ${file} · ${manifest.files.size} driven · ${groups} groups`,
);
