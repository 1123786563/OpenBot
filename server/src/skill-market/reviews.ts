import { and, eq, or } from "drizzle-orm";
import type { Database } from "../db/client";
import { bifrostMarketReviews, bifrostMarketSkills } from "../db/schema";
import type { BifrostPackageIdentity } from "./bifrost";

import {
  lockMarketEquivalences,
  verifiedBifrostPackageMatches,
} from "./equivalences";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function exactReview(
  database: Pick<Database, "select">,
  identity: BifrostPackageIdentity,
) {
  return database
    .select({ review: bifrostMarketReviews })
    .from(bifrostMarketReviews)
    .innerJoin(
      bifrostMarketSkills,
      eq(bifrostMarketReviews.skillId, bifrostMarketSkills.id),
    )
    .where(
      and(
        eq(bifrostMarketSkills.skillUuid, identity.skillId),
        eq(bifrostMarketReviews.versionUuid, identity.versionId),
        eq(bifrostMarketReviews.slug, identity.slug),
        eq(bifrostMarketReviews.version, identity.version),
      ),
    );
}

export async function lockActiveBifrostReview(
  transaction: Transaction,
  identity: BifrostPackageIdentity,
) {
  const [saved] = await exactReview(transaction, identity).for("share", {
    of: bifrostMarketReviews,
  });
  return saved?.review.fingerprint === identity.fingerprint &&
    !saved.review.withdrawnAt
    ? saved.review
    : undefined;
}

export async function migrationReviewMatches(
  database: Pick<Database, "select">,
  identity: BifrostPackageIdentity,
) {
  const rows = await database
    .select({
      skillId: bifrostMarketSkills.skillUuid,
      versionId: bifrostMarketReviews.versionUuid,
      slug: bifrostMarketReviews.slug,
      version: bifrostMarketReviews.version,
      fingerprint: bifrostMarketReviews.fingerprint,
    })
    .from(bifrostMarketReviews)
    .innerJoin(
      bifrostMarketSkills,
      eq(bifrostMarketReviews.skillId, bifrostMarketSkills.id),
    )
    .where(
      or(
        eq(bifrostMarketReviews.versionUuid, identity.versionId),
        and(
          eq(bifrostMarketSkills.skillUuid, identity.skillId),
          eq(bifrostMarketReviews.version, identity.version),
        ),
      ),
    );
  return rows.every(
    (row) =>
      row.skillId === identity.skillId &&
      row.versionId === identity.versionId &&
      row.slug === identity.slug &&
      row.version === identity.version &&
      row.fingerprint === identity.fingerprint,
  );
}

export async function readBifrostReview(
  database: Pick<Database, "select">,
  identity: BifrostPackageIdentity,
) {
  const [saved] = await exactReview(database, identity);
  return saved?.review;
}

export function bifrostReviewMethods(database: Database) {
  return {
    bifrostReview: (identity: BifrostPackageIdentity) =>
      readBifrostReview(database, identity),

    async approveBifrostPackage(
      identity: BifrostPackageIdentity,
      reviewerId: string,
    ) {
      return database.transaction(async (transaction) => {
        await lockMarketEquivalences(transaction, "read");
        if (!(await verifiedBifrostPackageMatches(transaction, identity)))
          return false;
        await transaction
          .insert(bifrostMarketSkills)
          .values({ skillUuid: identity.skillId })
          .onConflictDoNothing();
        const [skill] = await transaction
          .select({ id: bifrostMarketSkills.id })
          .from(bifrostMarketSkills)
          .where(eq(bifrostMarketSkills.skillUuid, identity.skillId));
        await transaction
          .insert(bifrostMarketReviews)
          .values({
            skillId: skill.id,
            versionUuid: identity.versionId,
            slug: identity.slug,
            version: identity.version,
            fingerprint: identity.fingerprint,
            reviewedBy: reviewerId,
          })
          .onConflictDoNothing();
        return Boolean(await lockActiveBifrostReview(transaction, identity));
      });
    },

    async withdrawBifrostPackage(
      identity: BifrostPackageIdentity,
      reviewerId: string,
    ) {
      return database.transaction(async (transaction) => {
        const [saved] = await exactReview(transaction, identity).for("update", {
          of: bifrostMarketReviews,
        });
        if (!saved || saved.review.fingerprint !== identity.fingerprint)
          return false;
        if (!saved.review.withdrawnAt) {
          await transaction
            .update(bifrostMarketReviews)
            .set({ withdrawnAt: new Date(), withdrawnBy: reviewerId })
            .where(eq(bifrostMarketReviews.id, saved.review.id));
        }
        return true;
      });
    },
  };
}
