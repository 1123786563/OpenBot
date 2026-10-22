import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { paymentOrders } from "../../db/schema/payment";
import { type PayerRef, payerKey, readPayerAccountForKey } from "../payer";

/**
 * The legacy deployment key, derived through the payer layer's own legacy_deployment branch —
 * NOT a second spelling of the deployment-key derivation (the call-site inventory guard in
 * payer-no-fallback.test.ts pins exactly which files may name that derivation; the attribution
 * pass goes through the payer seam like every other consumer).
 */
const legacyDeploymentKey = (legacyDeploymentId: string): string =>
  payerKey({ kind: "legacy_deployment", id: legacyDeploymentId });

/**
 * The legacy-order attribution pass (ticket 10.1, AC14): every `payment_orders` row with no
 * owner gets one — or is quarantined — from explicit facts only, never a guess.
 *
 * The facts are 02.2's own results (`payer_accounts` rows): the deployment key the old billing
 * stack wrote (the payer layer's legacy_deployment key spelling of the caller-vouched
 * deployment id — the same derivation, and the same caller-side id source, as the billing
 * assembly's external customer key) is looked up in the mapping, and its verdict is copied
 * VERBATIM onto the unowned rows. A `legacy_deployment` mapping attributes the rows to that
 * legacy subject; a mapping that 02.2 itself quarantined (`unknown_owner`) keeps them
 * quarantined; a key with no mapping at all quarantines the rows on the derived key itself —
 * the identity nobody vouched for, recorded as data.
 *
 * The discipline is payer-legacy.ts's, applied to orders:
 *
 * - Write-once: the pass only ever touches rows whose owner is still NULL, so a recorded
 *   verdict — attributed OR quarantined — is never reclassified by a later run, even when the
 *   mapping changes afterwards. An operator who disagrees writes a new explicit decision; the
 *   pass never invents one.
 * - Quarantine over default: an order that cannot be attributed becomes `unknown_owner`, the
 *   kind the payer layer refuses to resolve into a billable account and no personal read scope
 *   can ever match — isolated, auditable, invisible to person-facing reads, never silently
 *   folded into whoever happened to click the buy button.
 * - Run order with 02.2: run the key mapping first, this pass second. Attributing first is SAFE
 *   (unmapped keys quarantine) but final for those rows — the quarantine, once recorded, stands.
 *
 * `legacyDeploymentId` is what the caller vouches for — in production
 * `config.deploymentId ?? tenantPackage.tenantId`, passed in rather than reached for, so this
 * module never has to know how a deployment names itself. A blank or padded id is refused:
 * deriving a key from it would mint an identity the legacy stack never wrote.
 */

/** One row's verdict, as the report lists it. */
export type LegacyOrderOwnershipOutcome =
  | {
      kind: "attributed";
      orderId: string;
      /** The owner the explicit mapping names, copied verbatim. */
      ownerPayerRef: PayerRef;
    }
  | {
      kind: "quarantined";
      orderId: string;
      /** The derived legacy key nobody vouched for (or whose own mapping verdict was quarantine). */
      legacyKey: string;
    }
  | {
      kind: "already_attributed";
      orderId: string;
      /** The verdict a concurrent pass wrote first, read back from the row. */
      ownerPayerRef: PayerRef;
    }
  | {
      kind: "unprocessed";
      orderId: string;
      /** Why this row could not be decided; the next run retries it. */
      reason: string;
    };

/** What one pass found, in numbers and in per-row detail. */
export type LegacyOrderOwnershipReport = {
  /** Rows with no owner at scan time — everything this pass had to decide. */
  scannedUnowned: number;
  /** Rows newly attributed to an explicit mapping's subject this run. */
  attributedFromMapping: number;
  /** Rows newly quarantined as unknown_owner this run (no mapping, or the mapping's own verdict). */
  quarantinedUnknownOwner: number;
  /** Rows a concurrent pass attributed first; left exactly as the winner wrote them. */
  alreadyAttributed: number;
  /** Rows that errored and stay unowned for the next run; each also appears in `outcomes`. */
  unprocessed: number;
  /** Per-row detail, in scan order. */
  outcomes: LegacyOrderOwnershipOutcome[];
};

function assertLegacyDeploymentId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
    throw new TypeError(
      "attributeLegacyOrderOwnership needs the deployment's own non-empty legacyDeploymentId with no leading or trailing whitespace: the id derives into the legacy billing key verbatim, and a padded id would mint an identity the legacy stack never wrote.",
    );
  }
}

export async function attributeLegacyOrderOwnership(
  database: Database,
  options: { legacyDeploymentId: string },
): Promise<LegacyOrderOwnershipReport> {
  assertLegacyDeploymentId(options.legacyDeploymentId);
  const legacyKey = legacyDeploymentKey(options.legacyDeploymentId);

  // 02.2's verdict for this deployment's key, if the key mapping ran and vouched for it.
  const mapping = await readPayerAccountForKey(database, legacyKey);

  const outcomes: LegacyOrderOwnershipOutcome[] = [];
  const unowned = await database
    .select({ id: paymentOrders.id })
    .from(paymentOrders)
    .where(isNull(paymentOrders.ownerPayerKind));

  for (const { id } of unowned) {
    try {
      // The verdict the mapping names, verbatim; absent a mapping, the quarantine on the key.
      const verdict: PayerRef = mapping
        ? { kind: mapping.kind, id: mapping.payerId }
        : { kind: "unknown_owner", id: legacyKey };

      // The NULL guard is the write-once anchor: only a row that read back unowned AND still is
      // gets decided here; a concurrent winner's verdict is read back and reported, never overwritten.
      const updated = await database
        .update(paymentOrders)
        .set({ ownerPayerKind: verdict.kind, ownerPayerId: verdict.id })
        .where(
          and(eq(paymentOrders.id, id), isNull(paymentOrders.ownerPayerKind)),
        )
        .returning({
          id: paymentOrders.id,
          kind: paymentOrders.ownerPayerKind,
          payerId: paymentOrders.ownerPayerId,
        });
      if (updated[0]) {
        outcomes.push(
          verdict.kind === "unknown_owner"
            ? { kind: "quarantined", orderId: id, legacyKey: verdict.id }
            : { kind: "attributed", orderId: id, ownerPayerRef: verdict },
        );
        continue;
      }
      const [winner] = await database
        .select({
          kind: paymentOrders.ownerPayerKind,
          payerId: paymentOrders.ownerPayerId,
        })
        .from(paymentOrders)
        .where(eq(paymentOrders.id, id))
        .limit(1);
      if (winner?.kind && winner.payerId) {
        outcomes.push({
          kind: "already_attributed",
          orderId: id,
          ownerPayerRef: {
            kind: winner.kind as PayerRef["kind"],
            id: winner.payerId,
          },
        });
        continue;
      }
      throw new Error(
        `the ownership update for ${id} affected no rows but the row reads back unowned`,
      );
    } catch (error) {
      // One bad row must not stop the others: the failure is named in the report and the row
      // stays unowned, so a later run retries exactly it.
      outcomes.push({
        kind: "unprocessed",
        orderId: id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scannedUnowned: unowned.length,
    attributedFromMapping: outcomes.filter((o) => o.kind === "attributed")
      .length,
    quarantinedUnknownOwner: outcomes.filter((o) => o.kind === "quarantined")
      .length,
    alreadyAttributed: outcomes.filter((o) => o.kind === "already_attributed")
      .length,
    unprocessed: outcomes.filter((o) => o.kind === "unprocessed").length,
    outcomes,
  };
}

if (import.meta.main) {
  /**
   * Operator entry: `bun server/src/billing/payments/legacy-owner.ts`, against the deployment's
   * own database, AFTER payer-legacy.ts's key mapping ran (see the run-order note above). The
   * claimed identity comes from `OPENBOT_LEGACY_DEPLOYMENT_ID` — the same id the billing key
   * derives from (`config.deploymentId ?? tenantPackage.tenantId`).
   */
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this pass should attribute.",
    );
  }
  const legacyDeploymentId = (
    process.env.OPENBOT_LEGACY_DEPLOYMENT_ID ?? ""
  ).trim();
  if (!legacyDeploymentId) {
    throw new Error(
      "OPENBOT_LEGACY_DEPLOYMENT_ID must name the deployment identity the legacy billing key derives from; refusing to run without it.",
    );
  }
  const { createDatabase } = await import("../../db/client");
  const database = createDatabase(databaseUrl);
  try {
    const report = await attributeLegacyOrderOwnership(database, {
      legacyDeploymentId,
    });
    // The linter reserves console in server/src; a report line on stdout is the script's whole
    // output, so write it directly rather than loosening the rule for this one block.
    process.stdout.write(
      `${JSON.stringify({ database: new URL(databaseUrl).pathname, ...report })}\n`,
    );
  } finally {
    await database.$client.end();
  }
}
