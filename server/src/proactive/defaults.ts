/**
 * Background research, on by default (user decision 2026-10-31, restoring the pre-#732 default).
 *
 * A person who talks to one of their Bots in a conversation with that Bot alone gets background
 * research from it: the same read-only run (`proactive/restriction.ts`), every four hours, first
 * run one interval after the conversation so it never races it. Suggestions land in that
 * conversation.
 *
 * NEVER SWITCHED BACK ON. A settings row of any kind (on or off) means there is nothing to adopt;
 * removing one writes `default_opt_outs`, which adoption reads first. Both checks and the insert
 * run under one advisory lock per person and Bot (`lockResearchDefaults`), which removal — the
 * proactive store's `remove` and a Bot reset — takes too, so a removal and an adoption arriving
 * together cannot interleave into a re-creation. Removal waits for the lock; adoption only tries
 * it and steps aside when it is held, so it never parks a pooled connection behind another
 * transaction.
 *
 * Off for the whole deployment with OPENBOT_PROACTIVE_DEFAULTS=false; that stops new defaults and
 * touches no existing row. The memory-source half of the old default (`memory/defaults.ts`) left
 * with the old memory engine in #732 — memory sources are preserved data now, not a feature to
 * switch on.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { defaultOptOuts } from "../db/schema/defaults";
import { proactiveSettings } from "../db/schema/proactive";

/** How often background research runs when OpenBot switched it on, in minutes. */
export const DEFAULT_RESEARCH_INTERVAL_MINUTES = 240;
/** The shortest gap between two adoption passes for one person and Bot in this process. */
const MIN_INTERVAL_MS = 5 * 60_000;

/** A transaction or the database: anything that can run the statements below. */
type Executor = Pick<Database, "execute" | "select" | "insert">;

const lockKey = (ownerUserId: string, agentId: string) =>
  `openbot:defaults:${ownerUserId}:${agentId}`;

/**
 * Take the per-person, per-Bot lock adoption and removal share, waiting for it. Removal uses this:
 * a person's removal always lands. Transaction-scoped: held until the caller's transaction ends.
 */
export async function lockResearchDefaults(
  executor: Pick<Database, "execute">,
  ownerUserId: string,
  agentId: string,
) {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${lockKey(ownerUserId, agentId)}))`,
  );
}

/**
 * The same lock without waiting, for adoption. Held by anyone else means a removal or another
 * adoption for this pair is in flight, and either one settles the question, so adoption steps
 * aside rather than hold a pooled connection while it waits.
 */
async function tryLockResearchDefaults(
  executor: Pick<Database, "execute">,
  ownerUserId: string,
  agentId: string,
): Promise<boolean> {
  const rows = await executor.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext(${lockKey(ownerUserId, agentId)})) as locked`,
  );
  return [...rows][0]?.locked === true;
}

/** Record that a person turned background research down. Idempotent. */
export async function recordOptOut(
  executor: Pick<Database, "insert">,
  input: { ownerUserId: string; agentId: string },
) {
  await executor
    .insert(defaultOptOuts)
    .values({ ...input, feature: "proactive_research", scope: "" })
    .onConflictDoNothing();
}

async function declinedResearch(
  executor: Executor,
  ownerUserId: string,
  agentId: string,
) {
  const rows = await executor
    .select({ scope: defaultOptOuts.scope })
    .from(defaultOptOuts)
    .where(
      and(
        eq(defaultOptOuts.ownerUserId, ownerUserId),
        eq(defaultOptOuts.agentId, agentId),
        eq(defaultOptOuts.feature, "proactive_research"),
      ),
    );
  return rows.length > 0;
}

export type ResearchDefaults = ReturnType<typeof createResearchDefaults>;

export function createResearchDefaults(options: {
  database: Database;
  /** OPENBOT_PROACTIVE_DEFAULTS, on unless switched off. */
  research: boolean;
  /** The Bots in this person's conversation, or null when it is not theirs. */
  channelBots(ownerUserId: string, channelId: string): Promise<string[] | null>;
  /** Whether research from this Bot may be delivered to this conversation (see `deliveryScopeFor`). */
  canDeliver(
    ownerUserId: string,
    channelId: string,
    agentId: string,
  ): Promise<boolean>;
  mintThreadId(): string;
  now?: () => number;
  minIntervalMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}) {
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const log =
    options.log ??
    // biome-ignore lint/suspicious/noConsole: stable-code operational log
    ((entry) => console.warn(JSON.stringify(entry)));
  const lastRun = new Map<string, number>();

  /** True at most once per `minIntervalMs` for one key, so a busy conversation adopts once. */
  const due = (key: string) => {
    const at = now();
    const previous = lastRun.get(key);
    if (previous !== undefined && at - previous < minIntervalMs) return false;
    lastRun.set(key, at);
    // Bounded: an old key is worth nothing once its interval has passed.
    if (lastRun.size > 10_000)
      for (const [stale, when] of lastRun)
        if (at - when >= minIntervalMs) lastRun.delete(stale);
    return true;
  };

  const failed = (operation: string) => (error: unknown) =>
    log({
      type: "research-defaults-error",
      operation,
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    });

  /** Switch on background research by this Bot into this conversation. True when it did. */
  async function adoptResearch(
    ownerUserId: string,
    agentId: string,
    channelId: string,
  ): Promise<boolean> {
    if (!options.research) return false;
    if (!(await options.canDeliver(ownerUserId, channelId, agentId)))
      return false;
    const adopted = await options.database.transaction(async (transaction) => {
      if (!(await tryLockResearchDefaults(transaction, ownerUserId, agentId)))
        return false;
      if (await declinedResearch(transaction, ownerUserId, agentId))
        return false;
      const rows = await transaction
        .insert(proactiveSettings)
        .values({
          id: randomUUID(),
          ownerUserId,
          agentId,
          channelId,
          threadId: options.mintThreadId(),
          intervalMinutes: DEFAULT_RESEARCH_INTERVAL_MINUTES,
          enabled: true,
          nextRunAt: new Date(
            now() + DEFAULT_RESEARCH_INTERVAL_MINUTES * 60_000,
          ),
        })
        // One per person and Bot: a row already there, on or off, is the person's choice.
        .onConflictDoNothing()
        .returning({ id: proactiveSettings.id });
      return rows.length > 0;
    });
    if (adopted)
      log({
        type: "research-defaults",
        outcome: "research_adopted",
        agentId,
        timestamp: new Date().toISOString(),
      });
    return adopted;
  }

  return {
    adoptResearch,
    /**
     * A person said something in one of their conversations. When it is a conversation with one
     * Bot, switch on that Bot's research. Never waits and never throws.
     */
    personSpoke(ownerUserId: string, channelId: string) {
      if (!options.research) return;
      if (!due(`channel:${ownerUserId}:${channelId}`)) return;
      void (async () => {
        const bots = await options.channelBots(ownerUserId, channelId);
        // A group conversation would put research in front of Bots nobody asked.
        if (bots?.length !== 1) return;
        await adoptResearch(ownerUserId, bots[0] as string, channelId).catch(
          failed("research"),
        );
      })().catch(failed("personSpoke"));
    },
  };
}
