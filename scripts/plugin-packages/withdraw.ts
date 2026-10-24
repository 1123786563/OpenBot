import {
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
 * PKG08 (#467): the deployment safety-withdrawal command.
 *
 *   bun scripts/plugin-packages/withdraw.ts \
 *     --index plugins/marketplace.json \
 *     --package openbot/demo-skill --version 1.0.0
 *
 * Withdrawal is a METADATA fact about one exact release, written by the
 * deployment channel only:
 *
 *   - `state=withdrawn` blocks every new dispatch of the release in every
 *     scope (old Run pins included — enforced by the dispatch gate, Spec §10)
 *     and refuses new install/upgrade/rollback plans into it;
 *   - the release row, its artifact bytes, installed revisions, Run pins,
 *     unknown dispatches and audit receipts are all retained (V1 has NO
 *     automatic GC — a withdrawal never destroys recovery evidence);
 *   - it never unlists (`listed` stays whatever it was) and never touches
 *     company configuration or authorization: a company administrator has no
 *     path to this command, and nothing here can act for a company.
 *
 * The write is one locked, atomic index replacement; the receipt is one
 * machine-readable JSON object. Withdrawing an already-withdrawn release is
 * the idempotent no-op (`action: "already-withdrawn"`).
 */

export interface WithdrawReleaseInput {
  readonly indexPath: string;
  readonly packageKey: string;
  readonly version: string;
}

export interface WithdrawReceipt {
  readonly ok: true;
  readonly action: "withdrawn" | "already-withdrawn";
  readonly packageKey: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly listed: boolean;
  readonly state: "withdrawn";
  readonly index: string;
  readonly indexDigest: string;
  readonly artifactsGc: "none";
}

export async function withdrawMarketplaceRelease(
  input: WithdrawReleaseInput,
): Promise<WithdrawReceipt> {
  assertReleaseIdentity(input);
  return withIndexLock(input.indexPath, async () => {
    const index = await readMarketplaceIndex(input.indexPath);
    const existing = findReleaseEntry(index, input);
    if (!existing) {
      throw new IndexOperationError(
        "PACKAGE_RELEASE_NOT_FOUND",
        `${input.packageKey}@${input.version} is not registered in ${input.indexPath}`,
      );
    }
    if (existing.state === "withdrawn") {
      return {
        ok: true as const,
        action: "already-withdrawn" as const,
        packageKey: existing.packageKey,
        version: existing.version,
        artifactDigest: existing.artifactDigest,
        listed: existing.listed,
        state: "withdrawn" as const,
        index: input.indexPath,
        indexDigest: sha256Hex(serializeMarketplaceIndex(index)),
        artifactsGc: "none" as const,
      };
    }
    const packages = index.packages.map((entry) =>
      entry.packageKey === input.packageKey && entry.version === input.version
        ? { ...entry, state: "withdrawn" as const }
        : entry,
    );
    await writeMarketplaceIndexAtomic(input.indexPath, {
      schemaVersion: index.schemaVersion,
      packages,
    });
    return {
      ok: true as const,
      action: "withdrawn" as const,
      packageKey: existing.packageKey,
      version: existing.version,
      artifactDigest: existing.artifactDigest,
      listed: existing.listed,
      state: "withdrawn" as const,
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
  const packageKey = argument("--package");
  const version = argument("--version");
  const missing = (
    [
      ["--index", indexPath],
      ["--package", packageKey],
      ["--version", version],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !indexPath || !packageKey || !version) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "INPUT_INVALID",
        message: `missing required arguments: ${missing.join(", ")}`,
        usage:
          "bun scripts/plugin-packages/withdraw.ts --index <marketplace.json> --package <publisher/name> --version <x.y.z>",
      }),
    );
    process.exitCode = 2;
    return;
  }
  try {
    const receipt = await withdrawMarketplaceRelease({
      indexPath,
      packageKey,
      version,
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
