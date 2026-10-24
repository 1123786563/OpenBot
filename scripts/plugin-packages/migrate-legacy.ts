/**
 * PKG11 (#470, Spec §12): migrate the legacy marketplace's stock —
 * `expert_installs`, catalogue skill rows, skill `plugin_grants` and the
 * enterprise connector-install inventory — onto the governed plugin-package
 * module. Dry-run first; apply binds a digest and re-verifies every source
 * row; shadow-read compares the two read paths for one scope without
 * writing. All database statements live in
 * `server/src/marketplace/legacy-migration.ts`; apply lives in
 * `./migrate-legacy-apply.ts`.
 *
 *   bun scripts/plugin-packages/migrate-legacy.ts dry-run --out manifest.json
 *   bun scripts/plugin-packages/migrate-legacy.ts apply \
 *     --manifest manifest.json --digest <manifestDigest> \
 *     --tenant <t> --workspace <w> --actor <userId>
 *   bun scripts/plugin-packages/migrate-legacy.ts shadow-read \
 *     --tenant <t> --workspace <w> [--out report.json]
 *
 * CHANNELS. Inventory reads (legacy tables + ownership/connector evidence)
 * run on a read-only superuser/setup connection — the restricted roles
 * deliberately cannot enumerate across tenants, and an inventory is exactly
 * that. Every WRITE goes through the verified restricted channels:
 * `--directory-url` / `--data-url` / `--operator-url` (or their
 * `ENTERPRISE_*` / `ENTERPRISE_TEST_*` environment fallbacks), under a real
 * `tenant_admin` CompanyAdmin issued by the production authorizer.
 *
 * WHAT MAPS, AND WHAT NEVER DOES (A09): only content-hash-equal,
 * scope-proven records. Privately edited rows stay legacy, untouched; a Bot
 * owner never proves a company/team; connector installs stay legacy until a
 * package declares them. Single writer: apply writes only
 * `enterprise_package_*` rows through the package module's own services;
 * the legacy marketplace routes keep their tables and are never written
 * here (Spec §12.3).
 */

import { writeFile } from "node:fs/promises";
import {
  BUILTIN_PACKAGE_KEY,
  type BuiltinFacts,
  buildManifest,
  builtinFacts,
  openMigrationChannels,
  readLegacyInventory,
  shadowReadForScope,
} from "../../server/src/marketplace/legacy-migration";
import { readMarketplaceIndex } from "./index-file";

/** The built-in package's newest index entry (or null when unregistered). */
export async function builtinIndexEntry(indexPath: string): Promise<{
  packageKey: string;
  version: string;
  artifactDigest: string;
} | null> {
  const index = await readMarketplaceIndex(indexPath);
  const entries = index.packages.filter(
    (entry) => entry.packageKey === BUILTIN_PACKAGE_KEY,
  );
  if (entries.length === 0) return null;
  const newest = [...entries]
    .sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true }))
    .at(-1);
  return newest ?? null;
}

export async function builtinFactsFromIndex(
  indexPath: string,
): Promise<BuiltinFacts> {
  return builtinFacts(await builtinIndexEntry(indexPath));
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

const INDEX_PATH_DEFAULT = "plugins/marketplace.json";

async function main(): Promise<number> {
  const command = process.argv[2];
  const indexPath = argument("--index") ?? INDEX_PATH_DEFAULT;

  if (command === "dry-run") {
    const out = argument("--out");
    if (!out) throw new Error("dry-run requires --out <manifest.json>");
    const { channels, close } = await openMigrationChannels({
      legacyUrl: argument("--legacy-url"),
      setupUrl: argument("--setup-url"),
    });
    try {
      const builtin = await builtinFactsFromIndex(indexPath);
      const inventory = await readLegacyInventory(
        channels.legacy,
        channels.setup,
        builtin,
      );
      const manifest = buildManifest(builtin, inventory);
      await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.log(
        JSON.stringify(
          {
            written: out,
            manifestDigest: manifest.manifestDigest,
            counts: manifest.counts,
          },
          null,
          2,
        ),
      );
      return 0;
    } finally {
      await close();
    }
  }

  if (command === "shadow-read") {
    const tenantId = argument("--tenant");
    const workspaceId = argument("--workspace");
    if (!tenantId || !workspaceId) {
      throw new Error("shadow-read requires --tenant and --workspace");
    }
    const { channels, close } = await openMigrationChannels({
      legacyUrl: argument("--legacy-url"),
      setupUrl: argument("--setup-url"),
    });
    try {
      const builtin = await builtinFactsFromIndex(indexPath);
      const report = await shadowReadForScope(
        channels.legacy,
        channels.setup,
        { tenantId, workspaceId },
        builtin,
      );
      const out = argument("--out");
      if (out) {
        await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      console.log(JSON.stringify(report, null, 2));
      return 0;
    } finally {
      await close();
    }
  }

  if (command === "apply") {
    const { runApply } = await import("./migrate-legacy-apply");
    const manifestPath = argument("--manifest");
    const digest = argument("--digest");
    const tenantId = argument("--tenant");
    const workspaceId = argument("--workspace");
    const actorUserId = argument("--actor");
    if (!manifestPath || !digest || !tenantId || !workspaceId || !actorUserId) {
      throw new Error(
        "apply requires --manifest, --digest, --tenant, --workspace, --actor",
      );
    }
    const outcome = await runApply({
      manifestPath,
      expectedDigest: digest,
      scope: { tenantId, workspaceId },
      actorUserId,
      indexPath,
      artifactRoot: argument("--artifacts"),
      urls: {
        legacyUrl: argument("--legacy-url"),
        setupUrl: argument("--setup-url"),
        directoryUrl: argument("--directory-url"),
        dataUrl: argument("--data-url"),
        operatorUrl: argument("--operator-url"),
      },
    });
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.refused ? 2 : 0;
  }

  throw new Error(
    `unknown command: ${command ?? "(none)"} — use dry-run | apply | shadow-read`,
  );
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "migrate-legacy failed without a message",
      }),
    );
    process.exitCode = 1;
  }
}
