import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  bifrostMarketReviews,
  bifrostMarketSkills,
  skillMarketEquivalences as equivalents,
} from "../db/schema";
import type { BifrostPackageIdentity } from "./bifrost";
import { bifrostNamespace } from "./config";

export type MarketTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type Reader = Pick<Database, "select">;
type Source = { source: string; namespace: string; slug: string };
export type MarketVersionKey = {
  source: string;
  registrySkillId: number;
  versionId: number;
};

// Publish the receipt atomically with respect to command, version and dispatch writes.
export async function lockMarketEquivalences(
  transaction: MarketTransaction,
  mode: "read" | "publish",
) {
  await transaction.execute(
    mode === "read"
      ? sql`select pg_advisory_xact_lock_shared(138, 1)`
      : sql`select pg_advisory_xact_lock(138, 1)`,
  );
}

export async function commandSource(
  database: Reader,
  source: Source,
  targetSkillId?: string,
): Promise<Source> {
  if (source.source !== bifrostNamespace || !targetSkillId) return source;
  const [alias] = await database
    .select({
      source: equivalents.source,
      namespace: equivalents.namespace,
      slug: equivalents.slug,
    })
    .from(equivalents)
    .where(
      and(
        eq(equivalents.targetSkillId, targetSkillId),
        eq(equivalents.targetSlug, source.slug),
      ),
    )
    .limit(1);
  return alias ?? source;
}

export async function verifiedBifrostPackageMatches(
  database: Reader,
  identity: BifrostPackageIdentity,
) {
  const saved = await database
    .select()
    .from(equivalents)
    .where(
      or(
        eq(equivalents.targetVersionId, identity.versionId),
        and(
          eq(equivalents.targetSkillId, identity.skillId),
          eq(equivalents.version, identity.version),
        ),
      ),
    );

  return saved.every(
    (saved) =>
      saved.targetVersionId === identity.versionId &&
      saved.targetSkillId === identity.skillId &&
      saved.targetSlug === identity.slug &&
      saved.version === identity.version &&
      saved.fingerprint === identity.fingerprint,
  );
}

const exactBifrostReview = and(
  eq(bifrostMarketReviews.skillId, bifrostMarketSkills.id),
  eq(bifrostMarketReviews.versionUuid, equivalents.targetVersionId),
  eq(bifrostMarketReviews.slug, equivalents.targetSlug),
  eq(bifrostMarketReviews.version, equivalents.version),
  eq(bifrostMarketReviews.fingerprint, equivalents.fingerprint),
);

export function equivalentVersions(database: Reader) {
  return database
    .select({
      legacy: {
        source: equivalents.source,
        namespace: equivalents.namespace,
        slug: equivalents.slug,
        version: equivalents.version,
        registrySkillId: equivalents.registrySkillId,
        versionId: equivalents.versionId,
      },
      bifrost: {
        registrySkillId: bifrostMarketSkills.id,
        versionId: bifrostMarketReviews.id,
      },
    })
    .from(equivalents)
    .innerJoin(
      bifrostMarketSkills,
      eq(bifrostMarketSkills.skillUuid, equivalents.targetSkillId),
    )
    .innerJoin(bifrostMarketReviews, exactBifrostReview);
}

export async function equivalentVersionKeys(
  database: Reader,
  version: MarketVersionKey,
) {
  const [pair] = await equivalentVersions(database).where(
    version.source === bifrostNamespace
      ? and(
          eq(bifrostMarketReviews.skillId, version.registrySkillId),
          eq(bifrostMarketReviews.id, version.versionId),
        )
      : and(
          eq(equivalents.source, version.source),
          eq(equivalents.registrySkillId, version.registrySkillId),
          eq(equivalents.versionId, version.versionId),
        ),
  );
  return pair
    ? [pair.legacy, { ...pair.bifrost, source: bifrostNamespace }]
    : [version];
}
