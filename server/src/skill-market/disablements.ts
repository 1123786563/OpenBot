import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  skillMarketVersionDisablements as disablements,
  skillMarketInstallations,
  skillMarketSources,
} from "../db/schema";
import { catalogSegment, exactVersion } from "./config";

export const marketVersionIdentity = z.object({
  source: z
    .httpUrl()
    .max(2048)
    .refine((value) => URL.parse(value)?.origin === value),
  namespace: catalogSegment,
  slug: catalogSegment,
  registrySkillId: z.number().int().min(1).max(2147483647),
  versionId: z.number().int().min(1).max(2147483647),
  version: exactVersion,
});

export const disableMarketVersion = marketVersionIdentity.extend({
  reason: z.string().trim().min(1).max(500),
});

export type MarketVersionIdentity = z.infer<typeof marketVersionIdentity>;
type MarketVersionKey = Pick<
  MarketVersionIdentity,
  "source" | "registrySkillId" | "versionId"
>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function versionKey(version: MarketVersionKey) {
  return JSON.stringify([
    version.source,
    version.registrySkillId,
    version.versionId,
  ]);
}

function matchesVersion(version: MarketVersionKey) {
  return and(
    eq(disablements.source, version.source),
    eq(disablements.registrySkillId, version.registrySkillId),
    eq(disablements.versionId, version.versionId),
  );
}

export async function marketVersionDisableReason(
  database: Pick<Database, "select">,
  version: MarketVersionKey,
) {
  const [disabled] = await database
    .select({ reason: disablements.reason })
    .from(disablements)
    .where(matchesVersion(version));
  return disabled?.reason ?? null;
}

// The transaction lock also covers the absence of a registry row.
async function lockVersion(
  transaction: Transaction,
  version: MarketVersionKey,
) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`skill-market-version:${versionKey(version)}`}, 0))`,
  );
}

// Call inside the transaction that writes the new installation or switches its snapshot.
export async function qualifyMarketVersionForWrite(
  transaction: Transaction,
  version: MarketVersionKey,
) {
  await lockVersion(transaction, version);
  return marketVersionDisableReason(transaction, version);
}

export function marketVersionDisabledMessage(version: string, reason: string) {
  return `Market skill version ${version} is disabled by an OpenBot administrator. Reason: ${reason}`;
}

export function marketVersionMethods(database: Database) {
  return {
    marketVersionDisableReason: (version: MarketVersionKey) =>
      marketVersionDisableReason(database, version),

    async marketVersionsForAdministration() {
      const installed = await database
        .selectDistinct({
          source: skillMarketSources.registry,
          namespace: skillMarketSources.namespace,
          slug: skillMarketSources.slug,
          registrySkillId: skillMarketInstallations.registrySkillId,
          versionId: skillMarketInstallations.versionId,
          version: skillMarketInstallations.version,
        })
        .from(skillMarketInstallations)
        .innerJoin(
          skillMarketSources,
          eq(skillMarketSources.command, skillMarketInstallations.command),
        );
      const disabled = await database.select().from(disablements);
      const versions = new Map<
        string,
        MarketVersionIdentity & { reason: string | null }
      >(
        installed.map((version) => [
          versionKey(version),
          { ...version, reason: null },
        ]),
      );
      for (const version of disabled)
        versions.set(versionKey(version), version);
      return [...versions.values()];
    },

    async setMarketVersionDisablement(
      version: MarketVersionIdentity,
      reason: string | null,
    ) {
      await database.transaction(async (transaction) => {
        await lockVersion(transaction, version);
        if (reason === null) {
          await transaction.delete(disablements).where(matchesVersion(version));
        } else {
          await transaction
            .insert(disablements)
            .values({ ...version, reason })
            .onConflictDoUpdate({
              target: [
                disablements.source,
                disablements.registrySkillId,
                disablements.versionId,
              ],
              set: { reason },
            });
        }
      });
    },
  };
}
