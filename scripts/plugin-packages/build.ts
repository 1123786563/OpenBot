import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ArtifactError,
  buildArtifact,
  loadArtifact,
  PACKAGE_MANIFEST_FILE,
  storeArtifact,
  type VerifiedArtifact,
} from "../../server/src/plugin-packages/artifact";
import { parsePackageManifest } from "../../server/src/plugin-packages/manifest";
import {
  MarketplaceV1Schema,
  type PackageManifestV1,
} from "../../shared/enterprise/plugin-package-contracts";

/**
 * Build trusted plugin-package artifacts from the marketplace index.
 *
 *   bun scripts/plugin-packages/build.ts --catalog plugins/marketplace.json --out <artifactRoot>
 *   bun scripts/plugin-packages/build.ts --print-digest plugins/packages/openbot/demo-skill
 *
 * The script only reads package files and writes content-addressed artifacts;
 * it never executes package content and never dials the network. A declared
 * digest that does not match the bytes on disk fails the build, which is how a
 * same-version/new-content package is refused before it is registered.
 *
 * One source directory per packageKey holds exactly ONE version — the one its
 * `openbot.plugin.json` declares. The index may still list superseded
 * releases, so each entry is classified before anything is built:
 *
 *   - the entry whose version AND identity match the source manifest is built
 *     from the source tree (digest must match — unchanged failure semantics);
 *   - other entries for the same packageKey are historical: they are never
 *     rebuilt from the current source. An artifact already in the store is
 *     re-verified against its digest and reported `verified-historical`; a
 *   - missing historical artifact is a loud warning, not a build failure —
 *     historical immutable artifacts are not reproducible from the current
 *     source by definition. A historical artifact that EXISTS but fails
 *     verification is a build failure: a listed digest must not point at
 *     corrupt bytes.
 */

/** Where a build line goes; tests collect instead of printing. */
export type BuildEmit = (line: string, level: "info" | "warn" | "error") => void;

function defaultEmit(line: string, level: "info" | "warn" | "error"): void {
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

/**
 * Build every catalog entry into the artifact store. Returns whether the
 * build failed (the caller turns that into the process exit code).
 */
export async function buildMarketplaceArtifacts(
  catalogPath: string,
  outputRoot: string,
  emit: BuildEmit = defaultEmit,
): Promise<boolean> {
  const marketplace = MarketplaceV1Schema.parse(
    JSON.parse(await readFile(catalogPath, "utf8")),
  );
  const packageRootBase = join(resolve(dirname(catalogPath)), "packages");
  const resolvedOutput = resolve(outputRoot);
  let failed = false;

  // The source identity is read once per packageKey: it is the only version
  // the source tree can stand for, so it decides which entries are "current".
  const sourceManifests = new Map<string, PackageManifestV1 | null>();
  const sourceManifestOf = async (
    packageKey: string,
  ): Promise<PackageManifestV1 | null> => {
    const cached = sourceManifests.get(packageKey);
    if (cached !== undefined) return cached;
    let manifest: PackageManifestV1 | null = null;
    try {
      manifest = parsePackageManifest(
        JSON.parse(
          await readFile(
            join(
              packageRootBase,
              ...packageKey.split("/"),
              PACKAGE_MANIFEST_FILE,
            ),
            "utf8",
          ),
        ),
      );
    } catch {
      manifest = null;
    }
    sourceManifests.set(packageKey, manifest);
    return manifest;
  };

  for (const entry of marketplace.packages) {
    const source = join(packageRootBase, ...entry.packageKey.split("/"));
    const manifest = await sourceManifestOf(entry.packageKey);
    const identityMatches =
      manifest !== null &&
      `${manifest.publisher}/${manifest.name}` === entry.packageKey;
    const versionMatches = manifest !== null && manifest.version === entry.version;

    if (manifest === null || (identityMatches && versionMatches)) {
      // Either the source is unreadable (keep the existing build-failure
      // semantics — every entry of this packageKey reports its own error) or
      // this entry IS the version the source carries: build it, and the
      // declared digest must match the computed one.
      let artifact: VerifiedArtifact;
      try {
        artifact = await buildArtifact(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit(`${entry.packageKey}@${entry.version}: ${message}`, "error");
        failed = true;
        continue;
      }
      if (artifact.digest !== entry.artifactDigest) {
        emit(
          `${entry.packageKey}@${entry.version}: declared digest ${entry.artifactDigest} does not match computed ${artifact.digest}`,
          "error",
        );
        failed = true;
        continue;
      }
      // R6-3 (OCR round 6): storing is per-entry fallible too — one failed
      // store is recorded and the remaining entries still build, instead of
      // an unhandled rejection ending the loop with a distorted exit code.
      try {
        await storeArtifact(artifact, resolvedOutput);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit(
          `${entry.packageKey}@${entry.version}: storing the verified artifact failed: ${message}`,
          "error",
        );
        failed = true;
        continue;
      }
      emit(`${entry.packageKey}@${entry.version} ${artifact.digest}`, "info");
      continue;
    }

    if (versionMatches) {
      // Same version, different identity: the index points this packageKey at
      // bytes whose manifest claims to be another package.
      emit(
        `${entry.packageKey}@${entry.version}: source manifest identity ${manifest.publisher}/${manifest.name} does not match the index entry ${entry.packageKey}`,
        "error",
      );
      failed = true;
      continue;
    }

    // R6-6 (OCR round 6): the historical branch means "the source moved on to
    // a later version of the SAME package". A source directory whose manifest
    // claims another packageKey is not history — that tree cannot stand for
    // this entry at all, so it hard-fails instead of silently passing as a
    // historical entry (or a warning when the store copy is absent).
    if (!identityMatches) {
      emit(
        `${entry.packageKey}@${entry.version}: source manifest identity ${manifest.publisher}/${manifest.name} does not match the index entry ${entry.packageKey}`,
        "error",
      );
      failed = true;
      continue;
    }

    // Historical entry for a packageKey whose source has moved on: never
    // rebuilt from the current source, only verified against the store.
    try {
      await loadArtifact(resolvedOutput, entry.artifactDigest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ArtifactError && error.code === "ARTIFACT_MISSING") {
        emit(
          `${entry.packageKey}@${entry.version}: historical artifact ${entry.artifactDigest} is absent from the artifact store and the current source tree only builds ${manifest.version}; restore the stored release from its provenance (warning only, not a build failure)`,
          "warn",
        );
        continue;
      }
      emit(
        `${entry.packageKey}@${entry.version}: stored historical artifact ${entry.artifactDigest} failed verification: ${message}`,
        "error",
      );
      failed = true;
      continue;
    }
    emit(
      `${entry.packageKey}@${entry.version} verified-historical ${entry.artifactDigest}`,
      "info",
    );
  }
  return failed;
}

async function main(): Promise<void> {
  const printDigest = argument("--print-digest");
  if (printDigest) {
    const artifact = await buildArtifact(resolve(printDigest));
    console.log(artifact.digest);
    return;
  }

  const catalogPath = argument("--catalog");
  const outputRoot = argument("--out");
  if (!catalogPath || !outputRoot) {
    console.error(
      "usage: bun scripts/plugin-packages/build.ts --catalog <marketplace.json> --out <artifactRoot>",
    );
    process.exitCode = 2;
    return;
  }

  const failed = await buildMarketplaceArtifacts(
    catalogPath,
    resolve(outputRoot),
  );
  if (failed) process.exitCode = 1;
}

// `import.meta.main` keeps the CLI behavior (running this file directly) while
// letting tests import buildMarketplaceArtifacts without triggering a build.
if (import.meta.main) {
  await main();
}
