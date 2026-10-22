import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayCatalogSyncState } from "../db/schema";
import { type ModelRef, modelRefKey } from "./catalog";
import { GATEWAY_CATALOG_SYNC_STATE_ID } from "./catalog-sync";

/*
 * The catalog freshness gate (Bifrost 03.6, #228).
 *
 * ONE FACT, ONE GATE. The catalog's trustworthiness is a clock question: the
 * last FULLY successful sync (catalog AND prices, 03.4's `lastSuccessfulSyncAt`)
 * is the "last good" every price verdict stands on, and past the freshness cap
 * that evidence is too old to price a real charge with. This module owns that
 * verdict end to end — the default cap, the deployment's configured cap, the
 * pure comparison, the database read, and the two seams downstream code binds
 * to:
 *
 *   - `assertCatalogFresh` — the admission gate. The Reserve protocol's
 *     transactional revalidation calls it INSIDE its admission transaction, so
 *     a sync either commits before the gate reads it or waits until after the
 *     reservation commits; there is no window in which a stale catalog prices a
 *     fresh hold (review-253 F3 made this module the single source of truth;
 *     the inline predicate it replaced is gone).
 *   - `isCatalogFresh` (via {@link createCatalogFreshnessGate}) — the boolean
 *     seam 01.8's model-capability filter consumes, so a stale model is not
 *     OFFERED in the first place (review-230 F1's second connection point).
 *
 * WHAT EXPIRY SAYS. A verdict past the cap is `catalog_stale`; before any sync
 * ever landed, `catalog_never_synced`. The vocabulary is closed and always
 * names freshness — never model-not-found. The model may be perfectly open and
 * priced; what expired is the evidence both stand on, and the displayable
 * reason (and the refusal detail, which names the affected model ref and the
 * freshness facts and nothing else) must say exactly that.
 *
 * WHAT EXPIRY DOES NOT TOUCH. Requests already holding a reservation settle on
 * the basis they locked at admission — their snapshotVersion and rateVersion
 * are facts of their own admission, never re-read from a newer sync. The gate
 * gates ADMISSION only; settlement and release run on the locked basis whether
 * the catalog is fresh, stale, or never synced.
 *
 * RECOVERY NEEDS NO RESTART. Nothing here caches: every call reads the sync
 * state as of its `now`, so the next successful sync (the 03.4 scheduler's own
 * cadence, or an administrator's sync-now) releases new requests by itself.
 */

/**
 * The parent spec's freshness cap: a catalog older than this does not price new
 * requests. Overridable per deployment through
 * {@link catalogFreshnessWindowConfig} / the reserve service's
 * `catalogFreshnessWindowMs`.
 */
export const DEFAULT_CATALOG_FRESHNESS_WINDOW_MS = 15 * 60 * 1000;

/** The variable a deployment sets to move the cap; validated, never guessed. */
export const BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE =
  "BIFROST_CATALOG_FRESHNESS_WINDOW_MS";

/** Why a gate said no: the freshness vocabulary, closed — never model-not-found. */
export type CatalogFreshnessRefusalReasonCode =
  | "catalog_never_synced"
  | "catalog_stale";

/** The freshness facts a refusal carries: the affected model and nothing else's. */
export type CatalogFreshnessRefusalDetail = {
  /** The refused model's own display key — never another subject's data. */
  modelRef: string;
  /** The cap the verdict was judged against (configurable; shown so operators see which). */
  freshnessWindowMs: number;
  /** Present exactly when a sync HAS landed: the last good time, ISO. */
  lastSuccessfulSyncAt?: string;
  /** Present exactly when a sync HAS landed: now − last good, in milliseconds. */
  ageMs?: number;
};

/** A fresh verdict: the sync is inside the window, admission may proceed. */
export type CatalogFreshnessAcceptance = {
  fresh: true;
  lastSuccessfulSyncAt: string;
  ageMs: number;
  windowMs: number;
};

/** A refused verdict: freshness expired (or never existed), with its displayable detail. */
export type CatalogFreshnessRefusal = {
  fresh: false;
  reasonCode: CatalogFreshnessRefusalReasonCode;
  detail: CatalogFreshnessRefusalDetail;
};

export type CatalogFreshnessVerdict =
  | CatalogFreshnessAcceptance
  | CatalogFreshnessRefusal;

/**
 * Read the cap from the deployment environment, or answer the default. A
 * set-but-invalid value stops the caller (the deployment wiring, at boot) with
 * the variable named — a silent fallback to fifteen minutes would have a
 * deployment running the cap it refused.
 */
export function catalogFreshnessWindowConfig(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_CATALOG_FRESHNESS_WINDOW_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(
      `${BIFROST_CATALOG_FRESHNESS_WINDOW_MS_VARIABLE} must be a positive whole number of milliseconds, got "${raw}".`,
    );
  }
  return value;
}

/** The arguments the pure verdict compares: one timestamp against one clock. */
export type EvaluateCatalogFreshnessArgs = {
  /** The last FULLY successful sync's time; null before the first one ever. */
  lastSuccessfulSyncAt: Date | null;
  /** The injected clock's now — the whole verdict is a function of this. */
  now: Date;
  /** The cap in effect; `catalogFreshnessWindowConfig`'s answer in production. */
  windowMs: number;
};

/**
 * The pure core of the gate: no database, no clock of its own. `now` exactly at
 * the cap is still fresh — the refusal is a strict `>`, because a cap of "15
 * minutes" names the last whole minute a request may still trust the catalog,
 * and a boundary the deployment can actually observe must not depend on
 * sub-millisecond luck.
 */
export function evaluateCatalogFreshness(args: EvaluateCatalogFreshnessArgs):
  | CatalogFreshnessAcceptance
  | {
      fresh: false;
      reasonCode: CatalogFreshnessRefusalReasonCode;
      detail: Omit<CatalogFreshnessRefusalDetail, "modelRef">;
    } {
  const { lastSuccessfulSyncAt, now, windowMs } = args;
  if (lastSuccessfulSyncAt === null) {
    return {
      fresh: false,
      reasonCode: "catalog_never_synced",
      detail: { freshnessWindowMs: windowMs },
    };
  }
  const ageMs = now.getTime() - lastSuccessfulSyncAt.getTime();
  if (ageMs > windowMs) {
    return {
      fresh: false,
      reasonCode: "catalog_stale",
      detail: {
        freshnessWindowMs: windowMs,
        lastSuccessfulSyncAt: lastSuccessfulSyncAt.toISOString(),
        ageMs,
      },
    };
  }
  return {
    fresh: true,
    lastSuccessfulSyncAt: lastSuccessfulSyncAt.toISOString(),
    ageMs,
    windowMs,
  };
}

/**
 * Any handle that can SELECT: a pool, or the admission transaction. One type
 * for both, because the gate's whole point is that the reserve revalidation and
 * a standalone probe run the SAME verdict over the SAME read.
 */
export type CatalogFreshnessReader = Pick<Database, "select">;

/** The gate's input beyond the handle: which model asks, on whose clock. */
export type AssertCatalogFreshArgs = {
  modelRef: ModelRef;
  now: Date;
  windowMs?: number;
};

/**
 * The admission gate: read the sync state through the given handle and return
 * the verdict for `modelRef` at `now`. Never throws for a freshness answer — a
 * missing row IS the `catalog_never_synced` verdict, not an error. Callers map
 * a refusal onto their own reason-code surface; the reserve's refusal detail is
 * this verdict's detail, verbatim.
 */
export async function assertCatalogFresh(
  reader: CatalogFreshnessReader,
  args: AssertCatalogFreshArgs,
): Promise<CatalogFreshnessVerdict> {
  const windowMs = args.windowMs ?? DEFAULT_CATALOG_FRESHNESS_WINDOW_MS;
  const [row] = await reader
    .select({
      lastSuccessfulSyncAt: gatewayCatalogSyncState.lastSuccessfulSyncAt,
    })
    .from(gatewayCatalogSyncState)
    .where(eq(gatewayCatalogSyncState.id, GATEWAY_CATALOG_SYNC_STATE_ID))
    .limit(1);
  const verdict = evaluateCatalogFreshness({
    lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt ?? null,
    now: args.now,
    windowMs,
  });
  if (verdict.fresh) return verdict;
  return {
    ...verdict,
    detail: { ...verdict.detail, modelRef: modelRefKey(args.modelRef) },
  };
}

/** What the factory hands out: the two seams downstream code binds to. */
export type CatalogFreshnessGate = {
  /**
   * The boolean seam (01.8's model-capability filter consumes this shape): is
   * the catalog fresh enough to offer `modelRef` right now? `now` defaults to
   * the factory's injected clock.
   */
  isCatalogFresh(modelRef: ModelRef, now?: Date): Promise<boolean>;
  /** The full verdict behind the boolean, for surfaces that show the reason. */
  assertCatalogFresh(
    modelRef: ModelRef,
    now?: Date,
  ): Promise<CatalogFreshnessVerdict>;
};

/**
 * Bind the gate to a database handle, a cap, and a clock. The clock is
 * injectable (tests pin it; production uses the app clock), the cap defaults to
 * the parent spec's fifteen minutes — and nothing is cached: recovery is the
 * next successful sync, never a restart.
 */
export function createCatalogFreshnessGate(deps: {
  database: CatalogFreshnessReader;
  windowMs?: number;
  now?: () => Date;
}): CatalogFreshnessGate {
  const windowMs = deps.windowMs ?? DEFAULT_CATALOG_FRESHNESS_WINDOW_MS;
  const verdictFor = (
    modelRef: ModelRef,
    now?: Date,
  ): Promise<CatalogFreshnessVerdict> =>
    assertCatalogFresh(deps.database, {
      modelRef,
      now: now ?? deps.now?.() ?? new Date(),
      windowMs,
    });
  return {
    async isCatalogFresh(modelRef, now) {
      return (await verdictFor(modelRef, now)).fresh;
    },
    assertCatalogFresh: verdictFor,
  };
}
