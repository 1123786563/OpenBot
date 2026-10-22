import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  buildArtifact,
  storeArtifact,
  type VerifiedArtifact,
} from "../../server/src/plugin-packages/artifact";
import { MarketplaceV1Schema } from "../../shared/enterprise/plugin-package-contracts";

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
 */

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
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

  const marketplace = MarketplaceV1Schema.parse(
    JSON.parse(await readFile(catalogPath, "utf8")),
  );
  const packageRootBase = join(resolve(dirname(catalogPath)), "packages");
  let failed = false;
  for (const entry of marketplace.packages) {
    const source = join(packageRootBase, ...entry.packageKey.split("/"));
    let artifact: VerifiedArtifact;
    try {
      artifact = await buildArtifact(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${entry.packageKey}@${entry.version}: ${message}`);
      process.exitCode = 1;
      failed = true;
      continue;
    }
    if (artifact.digest !== entry.artifactDigest) {
      console.error(
        `${entry.packageKey}@${entry.version}: declared digest ${entry.artifactDigest} does not match computed ${artifact.digest}`,
      );
      process.exitCode = 1;
      failed = true;
      continue;
    }
    await storeArtifact(artifact, resolve(outputRoot));
    console.log(`${entry.packageKey}@${entry.version} ${artifact.digest}`);
  }
  if (failed) process.exitCode = 1;
}

await main();
