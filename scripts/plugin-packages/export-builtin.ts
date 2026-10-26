/**
 * PKG11 (#470, Spec §12.2): export the legacy marketplace catalogue
 * (CATALOGUE_SKILLS / CATALOGUE_EXPERTS code constants) as ONE real built-in
 * package — `openbot/legacy-catalogue` — under `plugins/packages/`, publish
 * it into `plugins/marketplace.json` and store its content-addressed
 * artifact, so a deployment's existing experts and skills exist as governed
 * package resources before anything migrates.
 *
 *   bun scripts/plugin-packages/export-builtin.ts \
 *     [--repo-root .] [--version 1.0.0] [--category builtin]
 *
 * The export is DETERMINISTIC: the same catalogue constants produce the same
 * bytes and therefore the same artifact digest, run after run. It never
 * executes package content, never dials the network and never touches a
 * database. The content hashes it computes are the migration manifest's
 * reference hashes — the single source both the generator and
 * `migrate-legacy.ts` compare legacy rows against, so "content hash exactly
 * matches" means exactly the same function both sides.
 *
 * Idempotence: same catalogue → same digest → the index entry is a metadata
 * no-op. A changed catalogue changes the digest, which `assertNoDigestConflict`
 * refuses under the same version (the immutability rule every release
 * follows); the operator bumps `--version`, exactly like any other package.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CATALOGUE_EXPERTS,
  CATALOGUE_SKILLS,
  type CatalogueExpert,
  type CatalogueSkill,
} from "../../server/src/marketplace/catalogue";
import {
  BUILTIN_PACKAGE_KEY,
  builtinExpertContentHash,
  builtinSkillContentHash,
} from "../../server/src/marketplace/legacy-migration";
import {
  buildArtifact,
  storeArtifact,
} from "../../server/src/plugin-packages/artifact";
import {
  PackageIdSchema,
  type PackageManifestV1,
} from "../../shared/enterprise/plugin-package-contracts";
import {
  assertNoDigestConflict,
  findReleaseEntry,
  IndexOperationError,
  readMarketplaceIndex,
  withIndexLock,
  writeMarketplaceIndexAtomic,
} from "./index-file";

/** Where the package tree lands inside the repository. */
export const BUILTIN_PACKAGE_DIR = "plugins/packages/openbot/legacy-catalogue";
export const BUILTIN_CATEGORY = "builtin";
export const BUILTIN_VERSION_DEFAULT = "1.0.0";

/** YAML double-quoted scalar: JSON string quoting is valid YAML quoting. */
function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function skillMarkdown(skill: CatalogueSkill): string {
  return [
    "---",
    `name: ${skill.slug}`,
    `description: ${yamlQuote(skill.summary)}`,
    "---",
    "",
    `# ${skill.title}`,
    "",
    skill.instructions,
    "",
  ].join("\n");
}

function expertTemplateJson(expert: CatalogueExpert): string {
  return `${JSON.stringify(
    {
      name: expert.name,
      summary: expert.tagline,
      systemPrompt: expert.roleDescription,
      skills: expert.skills,
    },
    null,
    2,
  )}\n`;
}

function builtinManifest(version: string): PackageManifestV1 {
  const resources: PackageManifestV1["resources"] = [
    ...CATALOGUE_SKILLS.map((skill) => ({
      kind: "skill" as const,
      id: skill.slug,
      path: `skills/${skill.slug}/SKILL.md`,
    })),
    ...CATALOGUE_EXPERTS.map((expert) => ({
      kind: "expertTemplate" as const,
      id: expert.slug,
      path: `experts/${expert.slug}.json`,
      skills: expert.skills,
    })),
  ];
  return {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "legacy-catalogue",
    version,
    display: {
      name: "OpenBot 内置目录",
      summary: "由旧市场目录导出的内置专家与技能（PKG11 迁移基线）。",
    },
    resources,
    dependencies: [],
  };
}

/** Every slug must be a valid package resource id, or the export refuses. */
function assertCatalogueShapes(): void {
  for (const skill of CATALOGUE_SKILLS) {
    if (!PackageIdSchema.safeParse(skill.slug).success) {
      throw new IndexOperationError(
        "INPUT_INVALID",
        `catalogue skill slug is not a package id: ${skill.slug}`,
      );
    }
  }
  const skillSlugs = new Set(CATALOGUE_SKILLS.map((skill) => skill.slug));
  for (const expert of CATALOGUE_EXPERTS) {
    if (!PackageIdSchema.safeParse(expert.slug).success) {
      throw new IndexOperationError(
        "INPUT_INVALID",
        `catalogue expert slug is not a package id: ${expert.slug}`,
      );
    }
    for (const ref of expert.skills) {
      if (!skillSlugs.has(ref)) {
        throw new IndexOperationError(
          "INPUT_INVALID",
          `catalogue expert ${expert.slug} references unknown skill: ${ref}`,
        );
      }
    }
  }
}

export interface BuiltinExportReceipt {
  readonly packageKey: typeof BUILTIN_PACKAGE_KEY;
  readonly version: string;
  readonly artifactDigest: string;
  readonly files: readonly string[];
  readonly skillResources: number;
  readonly expertResources: number;
  readonly indexAction: "registered" | "metadata-noop";
  /** The reference hashes the migration manifest binds itself to. */
  readonly skills: ReadonlyArray<{ slug: string; contentHash: string }>;
  readonly experts: ReadonlyArray<{ slug: string; contentHash: string }>;
}

/**
 * Writes the package tree, stores the verified artifact and registers the
 * release in the marketplace index. Pure filesystem + index work; safe to
 * re-run (idempotent while the catalogue is unchanged).
 */
export async function exportBuiltinPackage(options: {
  repoRoot: string;
  version?: string;
  category?: string;
}): Promise<BuiltinExportReceipt> {
  assertCatalogueShapes();
  const version = options.version ?? BUILTIN_VERSION_DEFAULT;
  const category = options.category ?? BUILTIN_CATEGORY;
  const repoRoot = resolve(options.repoRoot);
  const packageDir = join(repoRoot, BUILTIN_PACKAGE_DIR);
  const indexPath = join(repoRoot, "plugins/marketplace.json");
  const artifactRoot = join(repoRoot, "plugins/.artifacts");

  const manifest = builtinManifest(version);
  const files: Array<{ path: string; content: string }> = [
    {
      path: "openbot.plugin.json",
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    ...CATALOGUE_SKILLS.map((skill) => ({
      path: `skills/${skill.slug}/SKILL.md`,
      content: skillMarkdown(skill),
    })),
    ...CATALOGUE_EXPERTS.map((expert) => ({
      path: `experts/${expert.slug}.json`,
      content: expertTemplateJson(expert),
    })),
  ];
  for (const file of files) {
    await mkdir(join(packageDir, dirnameOf(file.path)), { recursive: true });
    await writeFile(join(packageDir, file.path), file.content, "utf8");
  }

  const artifact = await buildArtifact(packageDir);
  await storeArtifact(artifact, artifactRoot);

  let indexAction: "registered" | "metadata-noop" = "metadata-noop";
  await withIndexLock(indexPath, async () => {
    const index = await readMarketplaceIndex(indexPath);
    const identity = { packageKey: BUILTIN_PACKAGE_KEY, version };
    assertNoDigestConflict(index, {
      ...identity,
      artifactDigest: artifact.digest,
    });
    const existing = findReleaseEntry(index, identity);
    if (!existing) {
      index.packages.push({
        packageKey: BUILTIN_PACKAGE_KEY,
        version,
        artifactDigest: artifact.digest,
        category,
        listed: true,
        state: "published",
      });
      indexAction = "registered";
    } else {
      /*
       * The export never decides lifecycle (OCR H2): a withdrawn or unlisted
       * release keeps its state and visibility — withdrawal is a PKG08 gate
       * decision, and a re-run of the export must not resurrect it. The
       * digest is already asserted identical above, so only the category is
       * a live metadata update here.
       */
      existing.artifactDigest = artifact.digest;
      existing.category = category;
    }
    await writeMarketplaceIndexAtomic(indexPath, index);
  });

  return {
    packageKey: BUILTIN_PACKAGE_KEY,
    version,
    artifactDigest: artifact.digest,
    files: files.map((file) => file.path),
    skillResources: CATALOGUE_SKILLS.length,
    expertResources: CATALOGUE_EXPERTS.length,
    indexAction,
    skills: CATALOGUE_SKILLS.map((skill) => ({
      slug: skill.slug,
      contentHash: builtinSkillContentHash(skill),
    })),
    experts: CATALOGUE_EXPERTS.map((expert) => ({
      slug: expert.slug,
      contentHash: builtinExpertContentHash(expert),
    })),
  };
}

/** `dirname` without pulling node:path twice in the file map loop. */
function dirnameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "." : path.slice(0, at);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

if (import.meta.main) {
  try {
    const receipt = await exportBuiltinPackage({
      repoRoot: argument("--repo-root") ?? process.cwd(),
      version: argument("--version"),
      category: argument("--category"),
    });
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "builtin export failed without a message",
      }),
    );
    process.exitCode = 1;
  }
}
