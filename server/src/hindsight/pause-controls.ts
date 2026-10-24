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
 * active" — the default is an unpaused memory life, not a locked one. Each row also carries
 * the person's user id (migration 0210, RFW1-1): the writer holds the server-issued
 * `PlatformScope`, whose resolver selected the principal BY the session actor's user id, so
 * the stored attribution is that same server-side fact — the column the legacy user gate
 * below reads instead of touching the directory's row visibility.
 */
export function createDrizzlePauseControls(
  database: Database,
  options: { now?: () => Date } = {},
): HindsightPauseControls & {
  /**
   * Pause learning: automatic candidate proposals stop from this instant on. The user id is
   * the trusted scope's own actor attribution, never a wire value.
   */
  setLearningPaused(
    tenantId: string,
    principalId: string,
    userId: string,
    paused: boolean,
  ): Promise<void>;
  /**
   * Pause usage: recall of confirmed content stops from this instant on. Same server-side
   * user attribution as the learning switch.
   */
  setUsagePaused(
    tenantId: string,
    principalId: string,
    userId: string,
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
    async setLearningPaused(tenantId, principalId, userId, paused) {
      await upsert(tenantId, principalId, userId, {
        learningPausedAt: paused ? now() : null,
      });
    },
    async setUsagePaused(tenantId, principalId, userId, paused) {
      await upsert(tenantId, principalId, userId, {
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
    userId: string,
    set: { learningPausedAt: Date | null } | { usagePausedAt: Date | null },
  ) {
    const at = now();
    await database
      .insert(hindsightPauseControls)
      .values({
        tenantId,
        principalId,
        userId,
        learningPausedAt:
          "learningPausedAt" in set ? set.learningPausedAt : null,
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

/**
 * The legacy surfaces' gate (#392 FIX-W1, F-G1-2/F-G1-3; fail-open fixed in FIX-W8/RFW1-1):
 * the legacy memory store is the person's own, keyed by user id, and its callers (the legacy
 * engine's personal-memory middleware, the memory tools, the connector sync) carry a session
 * actor rather than a request-resolved `PlatformScope`. This bridge answers the same two
 * switches from the SAME table, by the person attribution each row carries from its write
 * time: the writer holds the server-issued scope, and the tenancy resolver selects the
 * principal BY the session actor's user id, so the stored `user_id` is the same server-side
 * fact a directory lookup would derive — nothing in a request body, query or header can name
 * a tenant, principal, user or bank here, the same discipline `resolveHindsightBankScope`
 * holds on the chain side.
 *
 * The read is deliberately a single-table lookup, NOT a join through `enterprise_principals`.
 * That table is FORCE ROW LEVEL SECURITY with policies only for the ob_ent_* capability
 * roles, so on the main application connection the enterprise form mandates (no superuser,
 * no BYPASSRLS, no capability membership) the join answered zero rows and both gates
 * silently failed open — a pause the person set was ignored, invisibly to every superuser
 * test topology (RFW1-1). Reading the stored attribution instead keeps the answer
 * independent of the directory's row visibility: there is no read-time identity resolution
 * left to fail quietly, and a read that does fail throws — the seams refuse rather than
 * proceed as if nothing were paused.
 *
 * The legacy store has no company column, so a pause the person set under ANY of their
 * principal rows stops it: the switch says "stop using my memories", and the only store it can
 * stop is the person-wide one. That is the fail-safe direction — a pause never leaks content —
 * and resuming clears exactly the switch that was set, nothing else.
 */
export function createUserPauseGate(database: Database): {
  learningPaused(ownerUserId: string): Promise<boolean>;
  usagePaused(ownerUserId: string): Promise<boolean>;
} {
  async function statesFor(ownerUserId: string): Promise<{
    learning: boolean;
    usage: boolean;
  }> {
    const rows = await database
      .select({
        learningPausedAt: hindsightPauseControls.learningPausedAt,
        usagePausedAt: hindsightPauseControls.usagePausedAt,
      })
      .from(hindsightPauseControls)
      .where(eq(hindsightPauseControls.userId, ownerUserId));
    return {
      learning: rows.some((row) => row.learningPausedAt !== null),
      usage: rows.some((row) => row.usagePausedAt !== null),
    };
  }
  return {
    async learningPaused(ownerUserId) {
      return (await statesFor(ownerUserId)).learning;
    },
    async usagePaused(ownerUserId) {
      return (await statesFor(ownerUserId)).usage;
    },
  };
}

export type HindsightUserPauseGate = ReturnType<typeof createUserPauseGate>;
