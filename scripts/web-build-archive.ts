#!/usr/bin/env bun
// Archive a built Web directory, and restore one. See docs/astryx-web-rollout.md.
//
//   bun scripts/web-build-archive.ts archive <dist> [--store <dir>] [--keep <n>]
//   bun scripts/web-build-archive.ts restore <archive> --to <dir>
//
// An archive is `<store>/<ms>-<commit>/` holding a copy of the build, next to
// `<store>/<ms>-<commit>.json` describing it.

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type WebBuildManifest = {
  commit: string;
  indexSha256: string;
  /** Path under the build directory, by SHA-256 of its bytes. */
  assets: Record<string, string>;
};

export function sha256Bytes(bytes: ArrayBuffer | string) {
  return createHash("sha256")
    .update(typeof bytes === "string" ? bytes : Buffer.from(bytes))
    .digest("hex");
}

export async function sha256(path: string) {
  return sha256Bytes(await readFile(path));
}

async function filesIn(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await filesIn(join(dir, entry.name), `${path}/`)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

export async function manifestOf(
  dir: string,
  commit: string,
): Promise<WebBuildManifest> {
  const assets: Record<string, string> = {};
  for (const path of await filesIn(dir)) {
    if (path !== "index.html") assets[path] = await sha256(join(dir, path));
  }
  return { commit, indexSha256: await sha256(join(dir, "index.html")), assets };
}

export async function archive(
  dist: string,
  store: string,
  { keep = 3 } = {},
): Promise<string> {
  const source = await realpath(dist);
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  if (!head.success)
    throw new Error("run from the Git checkout the build was cut from");
  const commit = head.stdout.toString().trim();
  const archived = join(store, `${Date.now()}-${commit}`);
  await mkdir(store, { recursive: true });
  await cp(source, archived, { recursive: true });
  await Bun.write(
    `${archived}.json`,
    `${JSON.stringify(await manifestOf(archived, commit), null, 2)}\n`,
  );

  // Only a directory described by one of our manifests is ever removed.
  for (const path of (await readdir(store))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(store, name))
    .sort()
    .slice(0, -keep)) {
    if (
      typeof JSON.parse(await readFile(path, "utf8")).indexSha256 !== "string"
    )
      continue;
    await rm(path.slice(0, -".json".length), { recursive: true, force: true });
    await rm(path);
  }
  return archived;
}

export async function restore(archive: string, target: string) {
  const manifest: WebBuildManifest = JSON.parse(
    await readFile(`${archive}.json`, "utf8"),
  );
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length > 0)
    throw new Error(`${target} is not empty; restore into a new directory`);
  await cp(archive, target, { recursive: true });
  const restored = await manifestOf(target, manifest.commit);
  const differs = ["index.html", ...Object.keys(manifest.assets)].filter(
    (path) =>
      (path === "index.html" ? restored.indexSha256 : restored.assets[path]) !==
      (path === "index.html" ? manifest.indexSha256 : manifest.assets[path]),
  );
  if (differs.length > 0)
    throw new Error(`restored build differs from ${archive}.json: ${differs}`);
}

/**
 * Check the active build in full and retain earlier builds’ hashed Vite assets.
 * Public files outside assets/ use the active build’s bytes at their stable URLs.
 *
 * After a switch the last one is the candidate and the others keep serving
 * chunks to open tabs; after a rollback it is the restored build. Every path is
 * fetched once, so the assets a candidate carries over from the old build are
 * checked against both records.
 */
export async function verifyServedBuilds(
  origin: string,
  ...manifests: string[]
) {
  const builds = await Promise.all(
    manifests.map(async (path) => ({
      path,
      manifest: JSON.parse(await readFile(path, "utf8")) as WebBuildManifest,
    })),
  );
  const expected = builds.flatMap(({ path, manifest }, index) =>
    [
      ...Object.entries(manifest.assets).filter(
        ([asset]) => index === builds.length - 1 || asset.startsWith("assets/"),
      ),
      ...(index === builds.length - 1
        ? [["index.html", manifest.indexSha256] as [string, string]]
        : []),
    ].map(([asset, digest]) => ({ build: path, asset, digest })),
  );
  const checked: { path: string; sha256: string }[] = [];
  const served = new Map<string, string>();
  for (const asset of new Set(expected.map(({ asset }) => asset))) {
    const response = await fetch(
      `${origin}/${asset.split("/").map(encodeURIComponent).join("/")}`,
    );
    const digest = response.ok
      ? sha256Bytes(await response.arrayBuffer())
      : `${response.status}`;
    served.set(asset, digest);
    checked.push({ path: asset, sha256: digest });
  }
  const problems = expected
    .filter(({ asset, digest }) => served.get(asset) !== digest)
    .map(
      ({ build, asset, digest }) =>
        `${build}: /${asset} served ${served.get(asset)}, recorded ${digest}`,
    );
  return { checked, problems };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      store: { type: "string" },
      keep: { type: "string" },
      to: { type: "string" },
    },
  });
  const [command, path] = positionals;
  try {
    if (command === "archive" && path && values.store) {
      console.log(
        await archive(path, values.store, {
          keep: values.keep ? Number(values.keep) : undefined,
        }),
      );
    } else if (command === "restore" && path && values.to) {
      await restore(path, values.to);
    } else {
      throw new Error(
        "Usage: bun scripts/web-build-archive.ts archive <dist> --store <dir> [--keep <n>]\n" +
          "       bun scripts/web-build-archive.ts restore <archive> --to <dir>",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
