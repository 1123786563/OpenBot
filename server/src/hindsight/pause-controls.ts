/**
 * Hindsight 14 (#392): the person's two separate pause switches — stop learning new memories,
 * and stop using existing ones.
 *
 * The two states are stored apart (one column each, per switch) because they answer different
 * questions and resume independently: pausing learning must never delete or confirm anything,
 * and pausing usage must never delete anything either — the records stay, only their use
 * stops. Both gates are entry gates on the seams the spec names as the module's ONLY public
 * entries, which is what makes web chat, channels and scheduled jobs obey the same rule
 * without three copies of it:
 *
 *   - The candidate-generation seam (the derived-judgment proposal entry — the one place the
 *     system proposes memories automatically) refuses while learning is paused, with the
 *     `learning-paused` reason so the surface can tell a pause from a dead basis. The
 *     person's own explicit acts — confirming, editing, rejecting, correcting, forgetting —
 *     are NOT gated: "本人明确操作的审核与遗忘仍可用".
 *   - Every recall seam (general preferences, source-bound facts, confirmed judgments) checks
 *     usage-paused FIRST, before any remote call is made, and answers empty. Because the
 *     check precedes the service call, the seam never raises its unavailability signal while
 *     paused, so the SQL degradation path (#385's facade) — reached only through that signal —
 *     answers empty too. A pause is the person's own choice, not an outage: it blocks
 *     silently, deletes nothing, and resumes without any side effect.
 *
 * Resuming a control clears exactly its own instant: no candidate is confirmed, no
 * authorization widened, no sync replayed — whatever the person confirms after resuming is
 * their own act, on the records that were there all along.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { hindsightPauseControls } from "../db/schema/hindsight-pause";
import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "./bank-scope";

/** The read-only half the recall and proposal seams consume. */
export interface HindsightPauseControls {
  learningPaused(tenantId: string, principalId: string): Promise<boolean>;
  usagePaused(tenantId: string, principalId: string): Promise<boolean>;
}

/** What the person's settings surface shows: both switches, each with its own instant. */
export type HindsightPauseState = {
  learningPausedAt: Date | null;
  usagePausedAt: Date | null;
};

/**
 * The SQL-backed switches: one row per (tenant, principal), each pause the instant it took
 * effect, each resume clearing its own column and nothing else. An absent row answers "both
 * active" — the default is an unpaused memory life, not a locked one.
 */
export function createDrizzlePauseControls(
  database: Database,
  options: { now?: () => Date } = {},
): HindsightPauseControls & {
  /** Pause learning: automatic candidate proposals stop from this instant on. */
  setLearningPaused(
    tenantId: string,
    principalId: string,
    paused: boolean,
  ): Promise<void>;
  /** Pause usage: recall of confirmed content stops from this instant on. */
  setUsagePaused(
    tenantId: string,
    principalId: string,
    paused: boolean,
  ): Promise<void>;
  getPauseState(
    tenantId: string,
    principalId: string,
  ): Promise<HindsightPauseState>;
} {
  const now = options.now ?? (() => new Date());
  return {
    async learningPaused(tenantId, principalId) {
      const [row] = await database
        .select({ learningPausedAt: hindsightPauseControls.learningPausedAt })
        .from(hindsightPauseControls)
        .where(
          and(
            eq(hindsightPauseControls.tenantId, tenantId),
            eq(hindsightPauseControls.principalId, principalId),
          ),
        )
        .limit(1);
      return (row?.learningPausedAt ?? null) !== null;
    },
    async usagePaused(tenantId, principalId) {
      const [row] = await database
        .select({ usagePausedAt: hindsightPauseControls.usagePausedAt })
        .from(hindsightPauseControls)
        .where(
          and(
            eq(hindsightPauseControls.tenantId, tenantId),
            eq(hindsightPauseControls.principalId, principalId),
          ),
        )
        .limit(1);
      return (row?.usagePausedAt ?? null) !== null;
    },
    async setLearningPaused(tenantId, principalId, paused) {
      await upsert(tenantId, principalId, {
        learningPausedAt: paused ? now() : null,
      });
    },
    async setUsagePaused(tenantId, principalId, paused) {
      await upsert(tenantId, principalId, {
        usagePausedAt: paused ? now() : null,
      });
    },
    async getPauseState(tenantId, principalId) {
      const [row] = await database
        .select()
        .from(hindsightPauseControls)
        .where(
          and(
            eq(hindsightPauseControls.tenantId, tenantId),
            eq(hindsightPauseControls.principalId, principalId),
          ),
        )
        .limit(1);
      return {
        learningPausedAt: row?.learningPausedAt ?? null,
        usagePausedAt: row?.usagePausedAt ?? null,
      };
    },
  };

  /** Set exactly one switch; the other column keeps whatever it already held. */
  async function upsert(
    tenantId: string,
    principalId: string,
    set: { learningPausedAt: Date | null } | { usagePausedAt: Date | null },
  ) {
    const at = now();
    await database
      .insert(hindsightPauseControls)
      .values({
        tenantId,
        principalId,
        learningPausedAt: "learningPausedAt" in set ? set.learningPausedAt : null,
        usagePausedAt: "usagePausedAt" in set ? set.usagePausedAt : null,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          hindsightPauseControls.tenantId,
          hindsightPauseControls.principalId,
        ],
        set: { ...set, updatedAt: at },
      });
  }
}

export type HindsightPauseControlsService = ReturnType<
  typeof createDrizzlePauseControls
>;

/**
 * Apply the usage gate at one recall seam's entry: resolve the trusted scope, read the switch
 * live, and answer whether this recall is blocked. Kept as one helper so every seam blocks
 * identically — before its remote call, silently, with nothing deleted.
 */
export async function usagePausedFor(
  pause: HindsightPauseControls | undefined,
  scope: PlatformScope,
): Promise<boolean> {
  if (!pause) return false;
  const identity = resolveHindsightBankScope(scope);
  return pause.usagePaused(identity.tenantId, identity.principalId);
}

/** The learning gate's twin, for the candidate-generation seam. */
export async function learningPausedFor(
  pause: HindsightPauseControls | undefined,
  scope: PlatformScope,
): Promise<boolean> {
  if (!pause) return false;
  const identity = resolveHindsightBankScope(scope);
  return pause.learningPaused(identity.tenantId, identity.principalId);
}
