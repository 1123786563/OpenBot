import { loadArtifact } from "../../server/src/plugin-packages/artifact";
import {
  PackageIdSchema,
  type PackageReleaseState,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  assertNoDigestConflict,
  assertReleaseIdentity,
  findReleaseEntry,
  IndexOperationError,
  readMarketplaceIndex,
  serializeMarketplaceIndex,
  sha256Hex,
  withIndexLock,
  writeMarketplaceIndexAtomic,
} from "./index-file";

/**
 * PKG08 (#467): the deployment release-registration command.
 *
 *   bun scripts/plugin-packages/publish.ts \
 *     --index plugins/marketplace.json --artifact-root plugins/.artifacts \
 *     --package openbot/demo-skill --version 1.0.0 \
 *     --digest <sha256> --category productivity [--listed true|false] \
 *     [--state published|withdrawn]
 *
 * Deployment-management channel ONLY: this command reads package files and
 * writes the marketplace index — it never executes package content, never
 * dials the network, never reads company configuration, never authorizes on
 * any company's behalf and is reachable through no company HTTP surface. A
 * company administrator cannot run it; there is nothing for them to reach.
 *
 * Invariants (Spec §6/§10):
 *   - the registered digest must verify against the artifact store AND the
 *     artifact's manifest must claim this exact packageKey/version — the
 *     index never points at bytes it cannot stand for;
 *   - an existing release with a different digest is refused (same-version
 *     different-content never overwrites; a changed release is a new version);
 *   - re-registering the same digest is a metadata update (category, listed,
 *     state) with the same receipt shape;
 *   - the write is one locked, atomic index replacement, and the receipt is
 *     one machine-readable JSON object.
 */

export interface PublishReleaseInput {
  readonly indexPath: string;
  readonly artifactRoot: string;
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly category: string;
  /**
   * Default true on a first registration; an update inherits the recorded
   * value when omitted (the §10 withdraw gate).
   */
  readonly listed?: boolean;
  /**
   * Default "published" on a first registration; an update inherits the
   * recorded state when omitted — reviving a withdrawal is explicit.
   */
  readonly state?: PackageReleaseState;
}

export interface PublishReceipt {
  readonly ok: true;
  readonly action: "registered" | "updated";
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly category: string;
  readonly listed: boolean;
  readonly state: PackageReleaseState;
  readonly index: string;
  readonly indexDigest: string;
  readonly artifactsGc: "none";
}

export async function publishMarketplaceRelease(
  input: PublishReleaseInput,
): Promise<PublishReceipt> {
  assertReleaseIdentity(input);
  if (!/^[0-9a-f]{64}$/.test(input.artifactDigest)) {
    throw new IndexOperationError(
      "INPUT_INVALID",
      `digest must be 64 lowercase hex characters: ${input.artifactDigest}`,
    );
  }
  if (!PackageIdSchema.safeParse(input.category).success) {
    throw new IndexOperationError(
      "INPUT_INVALID",
      `category must be a kebab-case id: ${input.category}`,
    );
  }
  /*
   * Artifact verification happens BEFORE the lock: it is pure reading, and
   * its failure (missing or unverified bytes, a manifest claiming another
   * identity or version) must abort the registration before the index is
   * touched at all.
   */
  let artifact: Awaited<ReturnType<typeof loadArtifact>>;
  try {
    artifact = await loadArtifact(input.artifactRoot, input.artifactDigest);
  } catch (error) {
    // A missing/corrupt artifact is a typed receipt, not an internal crash.
    const raw = (error as { code?: unknown }).code;
    const code = typeof raw === "string" ? raw : "ARTIFACT_INVALID";
    throw new IndexOperationError(
      code,
      `artifact ${input.artifactDigest} could not be verified under ${input.artifactRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declared = `${artifact.manifest.publisher}/${artifact.manifest.name}`;
  if (
    declared !== input.packageKey ||
    artifact.manifest.version !== input.version
  ) {
    throw new IndexOperationError(
      "ARTIFACT_IDENTITY_MISMATCH",
      `artifact ${input.artifactDigest} declares ${declared}@${artifact.manifest.version}, not ${input.packageKey}@${input.version}`,
    );
  }

  return withIndexLock(input.indexPath, async () => {
    const index = await readMarketplaceIndex(input.indexPath);
    assertNoDigestConflict(index, {
      packageKey: input.packageKey,
      version: input.version,
      artifactDigest: input.artifactDigest,
    });
    const existing = findReleaseEntry(index, {
      packageKey: input.packageKey,
      version: input.version,
    });
    /*
     * §10 withdraw gate: an omitted --state/--listed on a re-registration
     * keeps the recorded values — an unadorned re-publish must not resurrect
     * a withdrawn or unlisted release. The published/true defaults apply to
     * a first registration only.
     */
    const listed = input.listed ?? existing?.listed ?? true;
    const state = input.state ?? existing?.state ?? "published";
    const packages = existing
      ? index.packages.map((entry) =>
          entry.packageKey === input.packageKey &&
          entry.version === input.version
            ? {
                ...entry,
                category: input.category,
                listed,
                state,
              }
            : entry,
        )
      : [
          ...index.packages,
          {
            packageKey: input.packageKey,
            version: input.version,
            artifactDigest: input.artifactDigest,
            category: input.category,
            listed,
            state,
          },
        ];
    await writeMarketplaceIndexAtomic(input.indexPath, {
      schemaVersion: index.schemaVersion,
      packages,
    });
    return {
      ok: true as const,
      action: existing ? ("updated" as const) : ("registered" as const),
      packageKey: input.packageKey,
      version: input.version,
      artifactDigest: input.artifactDigest,
      category: input.category,
      listed,
      state,
      index: input.indexPath,
      indexDigest: sha256Hex(
        serializeMarketplaceIndex(await readMarketplaceIndex(input.indexPath)),
      ),
      artifactsGc: "none" as const,
    };
  });
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

async function main(): Promise<void> {
  const indexPath = argument("--index");
  const artifactRoot = argument("--artifact-root");
  const packageKey = argument("--package");
  const version = argument("--version");
  const digest = argument("--digest");
  const category = argument("--category");
  const listedText = argument("--listed");
  const stateText = argument("--state");
  const missing = (
    [
      ["--index", indexPath],
      ["--artifact-root", artifactRoot],
      ["--package", packageKey],
      ["--version", version],
      ["--digest", digest],
      ["--category", category],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (
    missing.length > 0 ||
    !indexPath ||
    !artifactRoot ||
    !packageKey ||
    !version ||
    !digest ||
    !category
  ) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "INPUT_INVALID",
        message: `missing required arguments: ${missing.join(", ")}`,
        usage:
          "bun scripts/plugin-packages/publish.ts --index <marketplace.json> --artifact-root <dir> --package <publisher/name> --version <x.y.z> --digest <sha256> --category <id> [--listed true|false] [--state published|withdrawn]",
      }),
    );
    process.exitCode = 2;
    return;
  }
  let listed: boolean | undefined;
  if (
    listedText !== undefined &&
    listedText !== "true" &&
    listedText !== "false"
  ) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "INPUT_INVALID",
        message: "--listed must be true or false",
      }),
    );
    process.exitCode = 2;
    return;
  }
  listed = listedText === undefined ? undefined : listedText === "true";
  let state: PackageReleaseState | undefined;
  if (
    stateText !== undefined &&
    stateText !== "published" &&
    stateText !== "withdrawn"
  ) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "INPUT_INVALID",
        message: "--state must be published or withdrawn",
      }),
    );
    process.exitCode = 2;
    return;
  }
  state = stateText === undefined ? undefined : stateText;
  try {
    const receipt = await publishMarketplaceRelease({
      indexPath,
      artifactRoot,
      packageKey,
      version,
      artifactDigest: digest,
      category,
      ...(listed === undefined ? {} : { listed }),
      ...(state === undefined ? {} : { state }),
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const code = error instanceof IndexOperationError ? error.code : "INTERNAL";
    console.error(
      JSON.stringify({
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}

// `import.meta.main` keeps the CLI behavior while tests import the operation.
if (import.meta.main) {
  await main();
}
