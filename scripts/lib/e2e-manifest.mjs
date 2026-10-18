import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Shared shape and grouping for docs/verification/e2e-bun-suites.json. */

const root = resolve(import.meta.dirname, "../..");
export const MANIFEST = join(root, "docs/verification/e2e-bun-suites.json");
export const GROUP_SIZE = 24;

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
  for (const file of [...files].sort()) {
    const directory = file.split("/").slice(0, 2).join("/");
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(file);
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
  };
  writeFileSync(MANIFEST, `${JSON.stringify(payload, null, 1)}\n`);
  return payload.groups.length;
}
