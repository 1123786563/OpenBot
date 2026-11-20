import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  skillMarketVersionDisablements as disablements,
  skillMarketInstallations,
  skillMarketRuns,
  skillMarketSources,
} from "../db/schema";
import { catalogSegment, exactVersion, skillHubOrigin } from "./config";

export const marketVersionIdentity = z.object({
  source: z.string().refine((value) => skillHubOrigin(value) === value),
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

function pausedVersionMessage(version: string, reason: string) {
  return `Run paused. ${marketVersionDisabledMessage(version, reason)}`;
}

export type MarketRunScope = {
  actorId: string;
  botId: string;
  threadId: string;
  runId: string;
};

export type MarketRunControl = {
  check(): Promise<void>;
  recordComputerToolCall(callId: string): Promise<void>;
};

export class MarketRunPaused extends Error {
  override name = "MarketRunPaused";
}

function matchesRun(run: MarketRunScope) {
  return and(
    eq(skillMarketRuns.actorId, run.actorId),
    eq(skillMarketRuns.botId, run.botId),
    eq(skillMarketRuns.threadId, run.threadId),
    eq(skillMarketRuns.runId, run.runId),
  );
}

export async function marketRunPauseReason(
  database: Pick<Database, "select">,
  run: MarketRunScope,
) {
  const [saved] = await database
    .select({ reason: skillMarketRuns.pauseReason })
    .from(skillMarketRuns)
    .where(matchesRun(run));
  return saved?.reason ?? null;
}

/** Resolve a governed browser tool call from the run that emitted it. */
export async function marketRunForComputerCall(
  database: Pick<Database, "select">,
  scope: Omit<MarketRunScope, "runId">,
  callId: string,
) {
  const runs = await database
    .select({
      runId: skillMarketRuns.runId,
      pauseReason: skillMarketRuns.pauseReason,
    })
    .from(skillMarketRuns)
    .where(
      and(
        eq(skillMarketRuns.actorId, scope.actorId),
        eq(skillMarketRuns.botId, scope.botId),
        eq(skillMarketRuns.threadId, scope.threadId),
        sql`${callId} = any(${skillMarketRuns.computerToolCalls})`,
      ),
    )
    .limit(2);
  if (runs.length > 1)
    throw new MarketRunPaused(
      "OpenBot could not verify which market skill run requested this computer action.",
    );
  return runs[0];
}

export function marketVersionMethods(database: Database) {
  return {
    marketVersionDisableReason: (version: MarketVersionKey) =>
      marketVersionDisableReason(database, version),

    async registerMarketRun(
      run: MarketRunScope,
      version: MarketVersionIdentity,
      previousRunId?: string,
    ) {
      await database.transaction(async (transaction) => {
        await lockVersion(transaction, version);
        const disabled = await marketVersionDisableReason(transaction, version);
        const previousPause = previousRunId
          ? await marketRunPauseReason(transaction, {
              ...run,
              runId: previousRunId,
            })
          : null;
        await transaction
          .insert(skillMarketRuns)
          .values({
            ...run,
            source: version.source,
            registrySkillId: version.registrySkillId,
            versionId: version.versionId,
            pauseReason:
              previousPause ??
              (disabled
                ? pausedVersionMessage(version.version, disabled)
                : null),
          })
          .onConflictDoNothing();
        const [saved] = await transaction
          .select()
          .from(skillMarketRuns)
          .where(matchesRun(run));
        if (versionKey(saved) !== versionKey(version))
          throw new Error(
            "This run has already loaded a different market skill version.",
          );
      });
      return {
        async check() {
          const reason = await marketRunPauseReason(database, run);
          if (reason) throw new MarketRunPaused(reason);
        },
        async recordComputerToolCall(callId: string) {
          await database
            .update(skillMarketRuns)
            .set({
              computerToolCalls: sql`array_append(${skillMarketRuns.computerToolCalls}, ${callId})`,
            })
            .where(
              and(
                matchesRun(run),
                sql`not (${callId} = any(${skillMarketRuns.computerToolCalls}))`,
              ),
            );
        },
      } satisfies MarketRunControl;
    },

    marketRunPauseReason: (run: MarketRunScope) =>
      marketRunPauseReason(database, run),

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
          // A run stays paused even if the version is restored before it next wakes up.
          await transaction
            .update(skillMarketRuns)
            .set({ pauseReason: pausedVersionMessage(version.version, reason) })
            .where(
              and(
                eq(skillMarketRuns.source, version.source),
                eq(skillMarketRuns.registrySkillId, version.registrySkillId),
                eq(skillMarketRuns.versionId, version.versionId),
                isNull(skillMarketRuns.pauseReason),
              ),
            );
        }
      });
    },
  };
}
