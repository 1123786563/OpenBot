import { AsyncLocalStorage } from "node:async_hooks";
import {
  type MarketSkillSnapshot,
  marketSkillSnapshotSchema,
} from "@openbot/toolkit/continuation";
import { and, eq, exists, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  bifrostMarketReviews,
  skillMarketVersionDisablements as disablements,
  skillMarketEquivalences,
  skillMarketInstallations,
  skillMarketRuns,
} from "../db/schema";
import {
  bifrostNamespace,
  bifrostSlug,
  catalogSegment,
  exactVersion,
  skillHubOrigin,
} from "./config";

import {
  equivalentVersionKeys,
  equivalentVersions,
  lockMarketEquivalences,
  type MarketVersionKey,
} from "./equivalences";

const versionIdentityFields = z.object({
  registrySkillId: z.number().int().min(1).max(2147483647),
  versionId: z.number().int().min(1).max(2147483647),
  version: exactVersion,
});
const skillHubVersion = versionIdentityFields.extend({
  source: z.string().refine((value) => skillHubOrigin(value) === value),
  namespace: catalogSegment,
  slug: catalogSegment,
});
const bifrostVersion = versionIdentityFields.extend({
  source: z.literal(bifrostNamespace),
  namespace: z.literal(bifrostNamespace),
  slug: bifrostSlug,
});
export const marketVersionIdentity = z.union([skillHubVersion, bifrostVersion]);

const disableReason = { reason: z.string().trim().min(1).max(500) };
export const disableMarketVersion = z.union([
  skillHubVersion.extend(disableReason),
  bifrostVersion.extend(disableReason),
]);

export type MarketVersionIdentity = z.infer<typeof marketVersionIdentity>;
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
  const [key] =
    version.source === bifrostNamespace
      ? await equivalentVersionKeys(database, version)
      : [version];
  const [disabled] = await database
    .select({ reason: disablements.reason })
    .from(disablements)
    .where(matchesVersion(key));
  return disabled?.reason ?? null;
}

export function installedMarketDisablement(database: Pick<Database, "select">) {
  const install = skillMarketInstallations;
  const legacy = skillMarketEquivalences;
  return or(
    and(
      eq(disablements.source, install.registry),
      eq(disablements.registrySkillId, install.registrySkillId),
      eq(disablements.versionId, install.versionId),
    ),
    and(
      eq(install.registry, bifrostNamespace),
      exists(
        equivalentVersions(database).where(
          and(
            eq(bifrostMarketReviews.skillId, install.registrySkillId),
            eq(bifrostMarketReviews.id, install.versionId),
            eq(legacy.source, disablements.source),
            eq(legacy.registrySkillId, disablements.registrySkillId),
            eq(legacy.versionId, disablements.versionId),
          ),
        ),
      ),
    ),
  );
}

// The transaction lock also covers the absence of a registry row.
async function lockVersion(
  transaction: Transaction,
  version: MarketVersionKey,
) {
  await lockMarketEquivalences(transaction, "read");
  const [canonical] = await equivalentVersionKeys(transaction, version);
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`skill-market-version:${versionKey(canonical)}`}, 0))`,
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

// Routine and responsibility histories already persist this reason with the terminal run.
export function isMarketVersionPause(reason: string | null): reason is string {
  return (
    reason !== null &&
    /^Run paused\. Market skill version \S+ is disabled by an OpenBot administrator\. Reason: /.test(
      reason,
    )
  );
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
  dispatch: MarketDispatch;
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

export type MarketDispatch = <T>(start: () => Promise<T>) => Promise<T>;

/** SDKs wrap failures from custom fetch in their own connection errors. */
export async function withMarketFetch<T>(
  dispatch: MarketDispatch,
  request: (fetch: typeof globalThis.fetch) => Promise<T>,
): Promise<T> {
  const baseFetch = globalThis.fetch;
  let refused: MarketRunPaused | undefined;
  const fetch = Object.assign(
    async (...args: Parameters<typeof baseFetch>) => {
      try {
        return await dispatch(() => baseFetch(...args));
      } catch (error) {
        if (error instanceof MarketRunPaused) refused = error;
        throw error;
      }
    },
    { preconnect: baseFetch.preconnect },
  );
  try {
    return await request(fetch);
  } catch (error) {
    throw refused ?? error;
  }
}

const activeDispatch = new AsyncLocalStorage<MarketDispatch>();

export function withMarketDispatch<T>(
  dispatch: MarketDispatch | undefined,
  operation: () => T,
): T {
  return dispatch ? activeDispatch.run(dispatch, operation) : operation();
}

export function startMarketRequest<T>(start: () => Promise<T>): Promise<T> {
  const dispatch = activeDispatch.getStore();
  return dispatch ? dispatch(start) : start();
}

export async function registeredMarketDispatch(
  database: Database,
  run: MarketRunScope,
): Promise<MarketDispatch | undefined> {
  const [saved] = await database
    .select({ pauseReason: skillMarketRuns.pauseReason })
    .from(skillMarketRuns)
    .where(matchesRun(run));
  if (saved?.pauseReason) throw new MarketRunPaused(saved.pauseReason);
  return saved ? marketDispatchFor(database, run) : undefined;
}

export function marketDispatchFor(
  database: Database,
  run: MarketRunScope,
): MarketDispatch {
  return async (start) => {
    // A registered run's version is immutable. Calls without a market run
    // use the same transport without taking a market version lock.
    const [version] = await database
      .select({
        source: skillMarketRuns.source,
        registrySkillId: skillMarketRuns.registrySkillId,
        versionId: skillMarketRuns.versionId,
      })
      .from(skillMarketRuns)
      .where(matchesRun(run));
    if (!version) return start();

    const { response } = await database.transaction(async (transaction) => {
      await lockVersion(transaction, version);
      const reason = await marketRunPauseReason(transaction, run);
      if (reason) throw new MarketRunPaused(reason);

      // Invoke the transport while ordered against disablement. The boxed
      // promise lets the transaction commit while the response is in flight.
      const response = start();
      void response.catch(() => {});
      return { response };
    });
    return response;
  };
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
      snapshot: skillMarketRuns.snapshot,
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
  const [run] = runs;
  return (
    run && {
      ...run,
      snapshot:
        run.snapshot === null
          ? undefined
          : marketSkillSnapshotSchema.parse(run.snapshot),
    }
  );
}

export function marketVersionMethods(database: Database) {
  return {
    marketVersionDisableReason: (version: MarketVersionKey) =>
      marketVersionDisableReason(database, version),

    async registerMarketRun(
      run: MarketRunScope,
      version: MarketVersionIdentity,
      previousRunId?: string,
      snapshot?: MarketSkillSnapshot,
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
            snapshot,
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
        dispatch: marketDispatchFor(database, run),
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
          source: skillMarketInstallations.registry,
          namespace: skillMarketInstallations.namespace,
          slug: skillMarketInstallations.slug,
          registrySkillId: skillMarketInstallations.registrySkillId,
          versionId: skillMarketInstallations.versionId,
          version: skillMarketInstallations.version,
        })
        .from(skillMarketInstallations);
      const reviewed = await database
        .select({
          source: sql<string>`${bifrostNamespace}::text`,
          namespace: sql<string>`${bifrostNamespace}::text`,
          slug: bifrostMarketReviews.slug,
          registrySkillId: bifrostMarketReviews.skillId,
          versionId: bifrostMarketReviews.id,
          version: bifrostMarketReviews.version,
        })
        .from(bifrostMarketReviews);
      const pinned = await database
        .selectDistinct({
          source: skillMarketRuns.source,
          namespace: sql`${skillMarketRuns.snapshot}->'market'->>'namespace'`,
          slug: sql`${skillMarketRuns.snapshot}->'market'->>'slug'`,
          registrySkillId: skillMarketRuns.registrySkillId,
          versionId: skillMarketRuns.versionId,
          version: sql`${skillMarketRuns.snapshot}->'market'->>'version'`,
        })
        .from(skillMarketRuns)
        .where(isNotNull(skillMarketRuns.snapshot));
      const disabled = await database.select().from(disablements);
      const versions = new Map<
        string,
        MarketVersionIdentity & { reason: string | null }
      >(
        [...installed, ...reviewed].map((version) => [
          versionKey(version),
          { ...version, reason: null },
        ]),
      );
      for (const row of pinned) {
        const version = marketVersionIdentity.safeParse(row);
        if (version.success && !versions.has(versionKey(version.data)))
          versions.set(versionKey(version.data), {
            ...version.data,
            reason: null,
          });
      }
      for (const version of disabled) {
        versions.set(versionKey(version), version);
        for (const key of await equivalentVersionKeys(database, version)) {
          const equivalent = versions.get(versionKey(key));
          if (equivalent) equivalent.reason = version.reason;
        }
      }
      return [...versions.values()];
    },

    async setMarketVersionDisablement(
      version: MarketVersionIdentity,
      reason: string | null,
    ) {
      await database.transaction(async (transaction) => {
        await lockVersion(transaction, version);
        await applyMarketVersionDisablement(transaction, version, reason);
      });
    },
  };
}

export async function applyMarketVersionDisablement(
  transaction: Transaction,
  version: MarketVersionIdentity,
  reason: string | null,
) {
  const keys = await equivalentVersionKeys(transaction, version);
  if (reason === null) {
    await transaction
      .delete(disablements)
      .where(or(...keys.map(matchesVersion)));
    return;
  }
  await transaction.delete(disablements).where(or(...keys.map(matchesVersion)));
  const [canonical] = keys;
  await transaction
    .insert(disablements)
    .values({ ...version, ...canonical, reason })
    .onConflictDoUpdate({
      target: [
        disablements.source,
        disablements.registrySkillId,
        disablements.versionId,
      ],
      set: { reason },
    });
  // Close the dispatch boundary for both identities. Restoring never clears a saved run pause.
  await transaction
    .update(skillMarketRuns)
    .set({ pauseReason: pausedVersionMessage(version.version, reason) })
    .where(
      and(
        isNull(skillMarketRuns.pauseReason),
        or(
          ...keys.map((key) =>
            and(
              eq(skillMarketRuns.source, key.source),
              eq(skillMarketRuns.registrySkillId, key.registrySkillId),
              eq(skillMarketRuns.versionId, key.versionId),
            ),
          ),
        ),
      ),
    );
}
