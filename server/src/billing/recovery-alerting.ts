import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  creditRecoveryAlerts,
  creditRecoveryItems,
} from "../db/schema/credit-reservations";

/*
 * The persistent-anomaly alert for unknown-dispatch recovery items (Bifrost 08.6).
 *
 * WHAT THIS MODULE IS. A read-side pass over the recovery queue that tells a human an
 * item is STUCK — its retries have crossed a threshold, or it has simply dwelt past a
 * limit with no resolution — and keeps telling the truth about it: once, then sparsely,
 * then louder, then never again until somebody acts. Alerting is notification and
 * nothing else: the Resume hint's rule is structural, not aspirational — this module
 * writes ONLY `credit_recovery_alerts`. It never releases, never settles, never
 * re-dispatches, never touches the reservation, the item, the ledger or the outbox; an
 * operator's attention is the only thing it moves. The evidenced disposal (08.9) is the
 * only path that acts on the anomaly, and it does so on evidence, not on this alert.
 *
 * WHEN AN ITEM ALERTS. Two independent triggers, either one sufficient (the ticket's
 * "超过重试阈值或停留时限"): `failureCount >= failureThreshold` (08.4's counter —
 * 08.5 grows it only on still-unknown) or `now - detectedAt >= dwellLimitMs` (how long
 * the anomaly has existed at all). A young item with few failures alerts on neither.
 *
 * THE LEVEL LADDER (the ticket's 首次告警 / 重复告警 / 长期未处置升级, made a state
 * machine so the words mean one thing each):
 *
 *   first     the item crossed a trigger and has no alert row — insert one, notify;
 *   repeat    still unresolved `repeatIntervalMs` after the last notification — the
 *             row advances, notify; earlier re-crossings are DEDUPLICATED (no write,
 *             no notification — the spam the 去重 criterion exists to prevent);
 *   escalated still unhandled `escalationAfterMs` after the FIRST notification — the
 *             row escalates once, notify, and never fires again: an unattended queue
 *             plateaus instead of filling the channel forever.
 *
 * Dedup is DURABLE, not in-memory: the unique index on item_id means one alert row per
 * item ever, so a restart (or two replicas racing) re-enters the existing row's ladder
 * instead of blasting a fresh "new anomaly". Racing advances are absorbed by guarded
 * updates — the loser of a race reads its own update as zero rows and stays silent.
 *
 * WHAT AN ALERT CARRIES — AND NEVER CARRIES. The disposal facts an operator needs
 * (归属账户、金额上限、停留时长、最近原因、失败次数), with the account reference MASKED at
 * write time (`maskAccountRef`): the alert channel is wider than the payer layer, and a
 * full `openbot-personal-<userId>` key is account data the channel has no need for. The
 * recent reason rides as the item's closed-vocabulary stable code — never the provider's
 * answer prose, which lives in `credit_recovery_queries` for 08.8's view under its own
 * rules. No credentials, no other accounts' data: the event is built from the item row
 * alone, and the tests hold the serialized event to exactly that.
 *
 * THE SINK IS A SEAM. `AlertSink.emit` is the wiring point for whatever the deployment
 * actually notifies through (channel webhook, ops queue, …); none is wired today, so the
 * default sink is the operational log — a stable-code line, no driver text, masked
 * account — which is a real notification surface, not a refusal: alerting with nowhere
 * configured to shout still beats silence, and unlike 08.5's source there is no answer
 * here that could be fabricated from nothing.
 */

/** The alert level ladder: first → repeat → escalated (terminal). */
export type RecoveryAlertLevel = "first" | "repeat" | "escalated";

/** What crossed to make the alert fire. */
export type RecoveryAlertTrigger = "failure_threshold" | "dwell_limit";

/** The thresholds and windows the ladder runs on; every one deployment-tunable. */
export type RecoveryAlertConfig = {
  /** failureCount at or beyond this alerts (08.4's counter, grown by 08.5). */
  failureThreshold: number;
  /** An item unresolved this long after detection alerts however few its failures. */
  dwellLimitMs: number;
  /** Minimum spacing between notifications; re-crossings inside it are deduplicated. */
  repeatIntervalMs: number;
  /** Unhandled this long after the FIRST notification, the alert escalates once. */
  escalationAfterMs: number;
};

/** The defaults a deployment inherits when it configures nothing. */
export const DEFAULT_RECOVERY_ALERT_CONFIG: RecoveryAlertConfig = {
  failureThreshold: 3,
  dwellLimitMs: 6 * 60 * 60 * 1000,
  repeatIntervalMs: 60 * 60 * 1000,
  escalationAfterMs: 24 * 60 * 60 * 1000,
};

/** One notification, as the sink receives it: the redacted disposal facts, nothing else. */
export type RecoveryAlertEvent = {
  alertId: string;
  itemId: string;
  reservationId: string;
  attemptId: string;
  level: RecoveryAlertLevel;
  trigger: RecoveryAlertTrigger;
  /** The owning account, masked — the full key never reaches a channel. */
  accountMasked: string;
  maximumCredits: number;
  /** How long the anomaly has existed when this notification fired. */
  dwellMilliseconds: number;
  failureCount: number;
  /** The item's last_reason stable code, when it has one. */
  reasonCode: string | null;
  alertedAt: string;
};

/** The seam a deployment wires its real notification channel into. */
export type RecoveryAlertSink = {
  /** The sink's own name, for the operational log's wiring lines. */
  readonly name: string;
  /** Deliver one notification; a throwing sink fails the pass loudly, never silently. */
  emit(event: RecoveryAlertEvent): Promise<void> | void;
};

/** What one evaluation pass did, for the caller's logs. */
export type RecoveryAlertBatch = {
  evaluatedAt: string;
  /** Unresolved items the pass considered. */
  evaluated: number;
  first: number;
  repeat: number;
  escalated: number;
  /** Crossings absorbed by the repeat interval — notified for, never re-notified. */
  deduplicated: number;
  /** Post-escalation crossings: the terminal level never re-fires. */
  suppressed: number;
  /** Items that triggered on neither axis and so were never alerting material. */
  notTriggering: number;
};

export type RecoveryAlerting = {
  /** One pass over the unresolved items: decide, advance the ladder, notify. Safe to
   * run concurrently and to re-run: the unique index and the guarded updates make every
   * re-entry idempotent. Writes ONLY alert rows. */
  evaluateAlerts(): Promise<RecoveryAlertBatch>;
};

export type RecoveryAlertingDependencies = {
  database: Database;
  /** The notification seam; the operational log by default. */
  sink?: RecoveryAlertSink;
  /** Injectable clock (可控时钟, the tests' handle on time). */
  now?: () => Date;
  /** Thresholds; the documented defaults when absent. */
  config?: Partial<RecoveryAlertConfig>;
  /** How many unresolved items one pass considers, oldest detection first; 500 default. */
  batchLimit?: number;
  /** Stable-code operational log (no driver error text); console.warn by default. */
  log?: (message: string) => void;
};

/** The alert row id shape: `cra-` plus 8 random bytes as hex (the family's draw). */
function generateRecoveryAlertId(): string {
  return `cra-${randomBytes(8).toString("hex")}`;
}

/**
 * Mask an account key for a channel: enough shape left to tell two accounts apart in a
 * list, never enough to reconstruct the key. Short keys keep a two-character head; the
 * ellipsis is the single-byte …, so the masked form cannot collide with a real key's
 * charset accidents.
 */
export function maskAccountRef(externalCustomerId: string): string {
  if (externalCustomerId.length <= 8) {
    return `${externalCustomerId.slice(0, 2)}…`;
  }
  return `${externalCustomerId.slice(0, 6)}…${externalCustomerId.slice(-4)}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The item facts the decision needs, as the pass reads them. */
type AlertableItem = {
  id: string;
  attemptId: string;
  reservationId: string;
  externalCustomerId: string;
  maximum: number;
  failureCount: number;
  lastReason: string | null;
  detectedAt: Date;
};

/** The existing alert row's ladder state, when one exists. */
type AlertLadderState = {
  level: RecoveryAlertLevel;
  firstAlertedAt: Date;
  lastAlertedAt: Date;
};

/** What the ladder decided for one item this pass. */
export type AlertDecision =
  | { action: "first"; trigger: RecoveryAlertTrigger }
  | { action: "repeat" }
  | { action: "escalate" }
  | { action: "deduplicated" }
  | { action: "suppressed" }
  | { action: "none" };

/**
 * The ladder as a pure function (the classifier discipline): given the item's facts, its
 * existing alert row (or none), the config and the clock, what should happen this pass.
 * Lifted out so the rule itself is testable without a database.
 */
export function decideAlertTransition(
  item: { failureCount: number; detectedAt: Date },
  existing: AlertLadderState | null,
  config: RecoveryAlertConfig,
  now: Date,
): AlertDecision {
  const dwell = now.getTime() - item.detectedAt.getTime();
  const overFailures = item.failureCount >= config.failureThreshold;
  const overDwell = dwell >= config.dwellLimitMs;
  if (!overFailures && !overDwell) {
    return { action: "none" };
  }
  if (!existing) {
    return {
      action: "first",
      trigger: overFailures ? "failure_threshold" : "dwell_limit",
    };
  }
  if (existing.level === "escalated") {
    // The terminal level: long-unhandled already said its loudest word.
    return { action: "suppressed" };
  }
  if (
    now.getTime() - existing.lastAlertedAt.getTime() <
    config.repeatIntervalMs
  ) {
    return { action: "deduplicated" };
  }
  if (
    now.getTime() - existing.firstAlertedAt.getTime() >=
    config.escalationAfterMs
  ) {
    return { action: "escalate" };
  }
  return { action: "repeat" };
}

export function createRecoveryAlerting(
  dependencies: RecoveryAlertingDependencies,
): RecoveryAlerting {
  const { database } = dependencies;
  const config: RecoveryAlertConfig = {
    ...DEFAULT_RECOVERY_ALERT_CONFIG,
    ...(dependencies.config ?? {}),
  };
  for (const [key, value] of Object.entries(config)) {
    if (!isPositiveInteger(value)) {
      throw new TypeError(
        `createRecoveryAlerting: config.${key} must be a positive integer (got ${String(value)})`,
      );
    }
  }
  const batchLimit = dependencies.batchLimit ?? 500;
  if (!isPositiveInteger(batchLimit)) {
    throw new TypeError(
      "createRecoveryAlerting: batchLimit must be a positive integer",
    );
  }
  const now = () => dependencies.now?.() ?? new Date();
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = dependencies.log ?? ((message: string) => console.warn(message));
  const sink: RecoveryAlertSink =
    dependencies.sink ??
    ({
      name: "operational-log",
      emit(event) {
        log(
          `billing: recovery alert level=${event.level} trigger=${event.trigger} item=${event.itemId} account=${event.accountMasked} max=${event.maximumCredits} dwellMs=${event.dwellMilliseconds} failures=${event.failureCount} reason=${event.reasonCode ?? "none"}`,
        );
      },
    } satisfies RecoveryAlertSink);

  async function notify(
    item: AlertableItem,
    alertId: string,
    level: RecoveryAlertLevel,
    trigger: RecoveryAlertTrigger,
    at: Date,
  ): Promise<void> {
    await sink.emit({
      alertId,
      itemId: item.id,
      reservationId: item.reservationId,
      attemptId: item.attemptId,
      level,
      trigger,
      accountMasked: maskAccountRef(item.externalCustomerId),
      maximumCredits: item.maximum,
      dwellMilliseconds: at.getTime() - item.detectedAt.getTime(),
      failureCount: item.failureCount,
      reasonCode: item.lastReason,
      alertedAt: at.toISOString(),
    });
  }

  return {
    async evaluateAlerts() {
      const at = now();
      const batch: RecoveryAlertBatch = {
        evaluatedAt: at.toISOString(),
        evaluated: 0,
        first: 0,
        repeat: 0,
        escalated: 0,
        deduplicated: 0,
        suppressed: 0,
        notTriggering: 0,
      };

      // The unresolved queue, oldest detection first — the same reads recovery's other
      // passes walk; resolved items are 08.9's receipts and not alerting material.
      const items = (await database
        .select({
          id: creditRecoveryItems.id,
          attemptId: creditRecoveryItems.attemptId,
          reservationId: creditRecoveryItems.reservationId,
          externalCustomerId: creditRecoveryItems.externalCustomerId,
          maximum: creditRecoveryItems.maximum,
          failureCount: creditRecoveryItems.failureCount,
          lastReason: creditRecoveryItems.lastReason,
          detectedAt: creditRecoveryItems.detectedAt,
        })
        .from(creditRecoveryItems)
        .where(ne(creditRecoveryItems.state, "resolved"))
        .orderBy(asc(creditRecoveryItems.detectedAt))
        .limit(batchLimit)) as AlertableItem[];
      batch.evaluated = items.length;

      if (items.length === 0) {
        return batch;
      }
      const ladders = new Map<string, AlertLadderState>();
      for (const row of await database
        .select({
          itemId: creditRecoveryAlerts.itemId,
          level: creditRecoveryAlerts.level,
          firstAlertedAt: creditRecoveryAlerts.firstAlertedAt,
          lastAlertedAt: creditRecoveryAlerts.lastAlertedAt,
        })
        .from(creditRecoveryAlerts)
        .where(
          inArray(
            creditRecoveryAlerts.itemId,
            items.map((item) => item.id),
          ),
        )) {
        ladders.set(row.itemId, {
          level: row.level,
          firstAlertedAt: row.firstAlertedAt,
          lastAlertedAt: row.lastAlertedAt,
        });
      }

      for (const item of items) {
        const existing = ladders.get(item.id) ?? null;
        const decision = decideAlertTransition(item, existing, config, at);

        if (decision.action === "none") {
          batch.notTriggering += 1;
          continue;
        }
        if (decision.action === "deduplicated") {
          batch.deduplicated += 1;
          continue;
        }
        if (decision.action === "suppressed") {
          batch.suppressed += 1;
          continue;
        }

        if (decision.action === "first") {
          const id = generateRecoveryAlertId();
          const inserted = await database
            .insert(creditRecoveryAlerts)
            .values({
              id,
              itemId: item.id,
              reservationId: item.reservationId,
              attemptId: item.attemptId,
              accountMasked: maskAccountRef(item.externalCustomerId),
              maximumCredits: item.maximum,
              failureCount: item.failureCount,
              reasonCode: item.lastReason,
              level: "first",
              lastTrigger: decision.trigger,
              detectedAt: item.detectedAt,
              firstAlertedAt: at,
              lastAlertedAt: at,
              escalatedAt: null,
              alertCount: 1,
              createdAt: at,
              updatedAt: at,
            })
            .onConflictDoNothing({
              target: creditRecoveryAlerts.itemId,
            })
            .returning({ id: creditRecoveryAlerts.id });
          // A racing writer already opened this item's ladder: their notification
          // happened, this one must not also happen.
          if (inserted.length === 0) {
            batch.deduplicated += 1;
            continue;
          }
          await notify(item, id, "first", decision.trigger, at);
          batch.first += 1;
          continue;
        }

        // repeat / escalate: guarded on the lastAlertedAt this pass read, so a racing
        // advance (or a restart between read and write) is absorbed as a no-op instead
        // of double-notifying — the loser reads zero rows and stays silent.
        if (!existing) {
          // Unreachable (the ladder answers repeat/escalate only for an existing row);
          // the silence keeps the guard below honest for the type, not just the runtime.
          continue;
        }
        const trigger = triggerOf(item, config);
        const guarded = and(
          eq(creditRecoveryAlerts.itemId, item.id),
          eq(creditRecoveryAlerts.lastAlertedAt, existing.lastAlertedAt),
        );
        const nextLevel: RecoveryAlertLevel =
          decision.action === "escalate" ? "escalated" : "repeat";
        const rows = await database
          .update(creditRecoveryAlerts)
          .set({
            level: nextLevel,
            lastTrigger: trigger,
            failureCount: item.failureCount,
            reasonCode: item.lastReason,
            lastAlertedAt: at,
            ...(decision.action === "escalate" ? { escalatedAt: at } : {}),
            alertCount: sql`${creditRecoveryAlerts.alertCount} + 1`,
            updatedAt: at,
          })
          .where(guarded)
          .returning({ id: creditRecoveryAlerts.id });
        if (rows.length === 0) {
          batch.deduplicated += 1;
          continue;
        }
        await notify(item, rows[0].id, nextLevel, trigger, at);
        if (decision.action === "escalate") {
          batch.escalated += 1;
        } else {
          batch.repeat += 1;
        }
      }
      return batch;
    },
  };
}

/** Which axis the item is over RIGHT NOW — the row's bookkeeping on an advance. */
function triggerOf(
  item: AlertableItem,
  config: RecoveryAlertConfig,
): RecoveryAlertTrigger {
  if (item.failureCount >= config.failureThreshold) {
    return "failure_threshold";
  }
  return "dwell_limit";
}
