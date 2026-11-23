import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { bifrostMarketReviews, bifrostMarketSkills } from "../db/schema";
import type { BifrostPackageIdentity } from "./bifrost";

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

export function bifrostReviewMethods(database: Database) {
  return {
    async bifrostReview(identity: BifrostPackageIdentity) {
      const [saved] = await exactReview(database, identity);
      return saved?.review;
    },

    async approveBifrostPackage(
      identity: BifrostPackageIdentity,
      reviewerId: string,
    ) {
      return database.transaction(async (transaction) => {
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
