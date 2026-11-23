import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../src/db/client";
import {
  skillMarketEquivalences,
  skillMarketInstallations,
  skillMarketMigrationReceipts,
  skillMarketRuns,
  skillMarketSources,
  skillMarketVersionDisablements,
} from "../../src/db/schema";
import {
  bifrostPackageIdentity,
  checkArchivePaths,
  type createBifrostMarket,
  maxFiles,
  maxPackageBytes,
} from "../../src/skill-market/bifrost";
import {
  bifrostNamespace,
  catalogSegment,
  skillHubConfirmation,
  skillHubOrigin,
} from "../../src/skill-market/config";
import {
  applyMarketVersionDisablement,
  marketVersionIdentity,
} from "../../src/skill-market/disablements";
import {
  equivalentVersionKeys,
  lockMarketEquivalences,
} from "../../src/skill-market/equivalences";
import { migrationReviewMatches } from "../../src/skill-market/reviews";
import { packageManifest } from "./source";

const sourceScope = z.object({
  source: z.string().refine((value) => skillHubOrigin(value) === value),
  namespace: catalogSegment,
});
const targetScope = z.object({
  registryId: z.string().min(1),
  namespace: z.literal(bifrostNamespace),
});
const fingerprint = bifrostPackageIdentity.shape.fingerprint;
const file = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(maxPackageBytes),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const evidence = z.object({
  source: marketVersionIdentity.and(z.object({ fingerprint })),
  package: z.object({
    files: z
      .array(file)
      .min(1)
      .max(maxFiles + 1),
    fingerprint,
  }),
  provenance: z.object({
    status: z.string(),
    ownerId: z.string(),
    createdBy: z.string(),
    publishedAt: z.iso.datetime().nullable(),
    yankedAt: z.iso.datetime().nullable(),
    yankReason: z.string().nullable(),
    reviews: z.array(
      z.object({
        reviewTaskId: z.string().regex(/^[0-9]+$/),
        status: z.string(),
        submittedBy: z.string(),
        reviewerId: z.string().nullable(),
        reviewedAt: z.iso.datetime().nullable(),
        comment: z.string().nullable(),
        decisionMethod: z.string().nullable(),
      }),
    ),
    confirmation: skillHubConfirmation.nullable(),
  }),
});
const receipt = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("verify"),
  ready: z.literal(true),
  snapshotId: z.string().min(1),
  source: sourceScope,
  target: targetScope,
  entries: z.array(
    z.discriminatedUnion("status", [
      evidence.extend({
        status: z.literal("verified"),
        target: bifrostPackageIdentity.extend(targetScope.shape),
      }),
      evidence.extend({
        status: z.enum(["withdrawn", "historical"]),
        target: z.null(),
      }),
    ]),
  ),
});

export const receiptScope = receipt.pick({
  snapshotId: true,
  source: true,
  target: true,
});

function recordUnique(index: Map<string, string>, key: string, value: string) {
  if (index.has(key) && index.get(key) !== value)
    throw new Error(
      "The verified receipt contains conflicting skill identities.",
    );
  index.set(key, value);
}

export async function applySkillMarketReceipt(
  database: Database,
  market: Pick<ReturnType<typeof createBifrostMarket>, "readExactPackage">,
  expected: z.infer<typeof receiptScope>,
  input: unknown,
) {
  const report = receipt.parse(input);
  if (
    report.snapshotId !== expected.snapshotId ||
    !isDeepStrictEqual(report.source, expected.source) ||
    !isDeepStrictEqual(report.target, expected.target)
  )
    throw new Error("The verified receipt belongs to a different cutover.");

  const byVersion = new Map<number, (typeof report.entries)[number]>();
  const legacySlugs = new Map<string, string>();
  const legacyIds = new Map<string, string>();
  const legacySkills = new Map<string, string>();
  const targetSkills = new Map<string, string>();
  const targetSlugs = new Map<string, string>();
  const targetVersions = new Set<string>();
  const coordinates = new Set<string>();
  const mappings: (typeof skillMarketEquivalences.$inferInsert)[] = [];

  for (const entry of report.entries) {
    const { source, target, package: manifest } = entry;
    const paths = manifest.files.map(({ path }) => path);
    const digest = createHash("sha256");
    for (const file of manifest.files)
      digest.update(`${file.path}:${file.sha256}\n`);
    checkArchivePaths(paths.filter((path) => path !== "SKILL.md"));
    const coordinate = JSON.stringify([source.slug, source.version]);
    if (
      source.source !== report.source.source ||
      source.namespace !== report.source.namespace ||
      source.source === bifrostNamespace ||
      byVersion.has(source.versionId) ||
      coordinates.has(coordinate) ||
      paths.filter((path) => path === "SKILL.md").length !== 1 ||
      paths.some((path, index) => index > 0 && paths[index - 1] >= path) ||
      manifest.files.reduce((size, file) => size + file.size, 0) >
        maxPackageBytes ||
      source.fingerprint !== manifest.fingerprint ||
      manifest.fingerprint !== `sha256:${digest.digest("hex")}`
    )
      throw new Error(
        "The verified receipt contains inconsistent source evidence.",
      );

    byVersion.set(source.versionId, entry);
    coordinates.add(coordinate);
    recordUnique(legacySlugs, source.slug, String(source.registrySkillId));
    recordUnique(legacyIds, String(source.registrySkillId), source.slug);
    if (!target) continue;
    if (
      target.registryId !== report.target.registryId ||
      source.slug !== target.slug ||
      source.version !== target.version ||
      source.fingerprint !== target.fingerprint ||
      targetVersions.has(target.versionId)
    )
      throw new Error(
        "The verified receipt contains inconsistent target evidence.",
      );

    recordUnique(legacySkills, source.slug, target.skillId);
    recordUnique(targetSkills, target.skillId, source.slug);
    recordUnique(targetSlugs, target.slug, target.skillId);
    targetVersions.add(target.versionId);
    const exact = await market.readExactPackage(
      target.namespace,
      target.slug,
      target.version,
    );
    const { registryId, ...identity } = target;
    if (
      !isDeepStrictEqual(exact.packageIdentity, identity) ||
      !isDeepStrictEqual(packageManifest(exact.files), manifest)
    )
      throw new Error(
        "The Bifrost package no longer matches the verified receipt.",
      );

    mappings.push({
      ...source,
      registryId,
      targetSkillId: target.skillId,
      targetVersionId: target.versionId,
      targetSlug: target.slug,
    });
  }

  return database.transaction(async (transaction) => {
    await lockMarketEquivalences(transaction, "publish");
    const [saved] = await transaction
      .select()
      .from(skillMarketMigrationReceipts);
    if (saved) {
      if (!isDeepStrictEqual(saved.evidence, report))
        throw new Error(
          "A different SkillHub cutover receipt is already recorded.",
        );
      return "already-applied";
    }

    const installations = await transaction
      .select()
      .from(skillMarketInstallations)
      .where(
        and(
          eq(skillMarketInstallations.registry, report.source.source),
          eq(skillMarketInstallations.namespace, report.source.namespace),
        ),
      );
    const activeSnapshots = await transaction
      .selectDistinct({ snapshot: skillMarketRuns.snapshot })
      .from(skillMarketRuns)
      .where(eq(skillMarketRuns.source, report.source.source));
    const snapshots = [
      ...installations,
      ...activeSnapshots.flatMap(({ snapshot }) =>
        snapshot?.market.namespace === report.source.namespace
          ? [snapshot.market]
          : [],
      ),
    ];
    for (const snapshot of snapshots) {
      const source = byVersion.get(snapshot.versionId)?.source;
      if (
        !source ||
        snapshot.registrySkillId !== source.registrySkillId ||
        snapshot.slug !== source.slug ||
        snapshot.version !== source.version ||
        snapshot.fingerprint !== source.fingerprint
      )
        throw new Error(
          "A saved SkillHub snapshot has no matching receipt evidence.",
        );
    }

    const disabled = await transaction
      .select()
      .from(skillMarketVersionDisablements)
      .where(
        and(
          eq(skillMarketVersionDisablements.source, report.source.source),
          eq(skillMarketVersionDisablements.namespace, report.source.namespace),
        ),
      );
    for (const version of disabled) {
      const source = byVersion.get(version.versionId)?.source;
      if (
        !source ||
        version.registrySkillId !== source.registrySkillId ||
        version.slug !== source.slug ||
        version.version !== source.version
      )
        throw new Error(
          "A disabled SkillHub version has no matching receipt evidence.",
        );
    }

    const reservations = await transaction
      .select({ slug: skillMarketSources.slug })
      .from(skillMarketSources)
      .where(eq(skillMarketSources.registry, bifrostNamespace));
    if (reservations.some(({ slug }) => targetSlugs.has(slug)))
      throw new Error(
        "A migrated Bifrost skill already has a separate command reservation.",
      );

    // A prior review for the exact version must agree even if the catalog bytes were repaired.
    for (const entry of report.entries) {
      if (!entry.target) continue;
      if (!(await migrationReviewMatches(transaction, entry.target)))
        throw new Error(
          "An OpenBot review conflicts with the verified receipt.",
        );
    }

    await transaction
      .insert(skillMarketMigrationReceipts)
      .values({ registryId: report.target.registryId, evidence: report });
    for (const mapping of mappings) {
      await transaction.insert(skillMarketEquivalences).values(mapping);
      for (const key of await equivalentVersionKeys(transaction, mapping)) {
        const [disabled] = await transaction
          .select({ reason: skillMarketVersionDisablements.reason })
          .from(skillMarketVersionDisablements)
          .where(
            and(
              eq(skillMarketVersionDisablements.source, key.source),
              eq(
                skillMarketVersionDisablements.registrySkillId,
                key.registrySkillId,
              ),
              eq(skillMarketVersionDisablements.versionId, key.versionId),
            ),
          );
        if (!disabled) continue;
        await applyMarketVersionDisablement(
          transaction,
          mapping,
          disabled.reason,
        );
        break;
      }
    }
    return "applied";
  });
}
