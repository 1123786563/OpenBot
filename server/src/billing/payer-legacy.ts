import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { payerAccounts } from "../db/schema/billing";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { enterpriseTenants } from "../db/schema/enterprise-tenancy";
import { createPayerAccount, readPayerAccountForKey } from "./payer";
import { deploymentExternalCustomerId } from "./service";

/**
 * The legacy-key migration (group 02.2): every external customer id the old billing stack ever
 * wrote into `credit_grants` or `credit_ledger` is put under an explicit payer-account mapping —
 * or, when nobody can vouch for it, quarantined as `unknown_owner`. It is the answer to "which
 * subject does this old key belong to?" that does not guess: attribution compares each key only
 * against keys derived FORWARD from a known identity (the deployment's own claimed ids, and the
 * tenant ids the company directory actually holds), never by reading a prefix off the key and
 * inferring a kind from its shape. A key that spells like a deployment key but names no identity
 * that exists is exactly the case string-shaped reasoning gets wrong, and it quarantines.
 *
 * What the migration never does: delete or rewrite a legacy record, create a grant or ledger
 * row, or move a balance to a personal or company account. It writes `payer_accounts` rows and
 * nothing else — the old records stay where and what they were, which is why re-running it is
 * safe (an already-mapped key is skipped, never reclassified) and why the quarantine is the
 * failure mode, not a default attribution: an unattributable key is kept for audit behind
 * `unknown_owner` rather than silently folded into some account that could be charged.
 */

/** One key's classification, as the report lists it. */
export type LegacyMappingOutcome =
  | {
      kind: "already_mapped";
      externalCustomerId: string;
      /** The id of the mapping row that already stood; left untouched. */
      accountId: string;
    }
  | {
      kind: "legacy_deployment";
      externalCustomerId: string;
      /** The claimed or directory identity the key was attributed to. */
      payerId: string;
    }
  | { kind: "unknown_owner"; externalCustomerId: string }
  | {
      kind: "unprocessed";
      externalCustomerId: string;
      /** Why this key could not be classified; the next run retries it. */
      reason: string;
    };

/** What one pass found, in numbers and in per-key detail. */
export type LegacyMappingReport = {
  /** Distinct legacy keys examined (the union over grants and ledger). */
  scannedKeys: number;
  /** Keys that already carried a mapping and were left exactly as they stood. */
  alreadyMapped: number;
  /** Keys newly attributed to a legacy_deployment account this run. */
  legacyDeploymentMapped: number;
  /** Keys newly quarantined as unknown_owner this run. */
  unknownOwnerQuarantined: number;
  /** Keys that errored and are left for the next run; each also appears in `outcomes`. */
  unprocessed: number;
  /** Per-key detail, in enumeration order. */
  outcomes: LegacyMappingOutcome[];
};

/**
 * Map every legacy external customer id, idempotently, and answer the report.
 *
 * `claimedDeploymentIds` is what the caller vouches for explicitly — in production the
 * deployment identity the billing seam already derives its customer key from
 * (`config.deploymentId ?? tenantPackage.tenantId`), passed in rather than reached for, so this
 * module never has to know how a deployment names itself. Tenant ids are checked the same way
 * from the other side: against the company directory's own rows. Both sources only ever
 * CONTRIBUTE candidate identities; a key is attributed when it equals a forward derivation from
 * one of them (`deploymentExternalCustomerId(id)`, the exact spelling the legacy stack wrote),
 * and anything else is quarantined.
 */
export async function mapLegacyExternalCustomerIds(
  database: Database,
  options: { claimedDeploymentIds: readonly string[] },
): Promise<LegacyMappingReport> {
  // Only well-formed claimed ids derive keys: an empty or whitespace-padded id would mint a
  // key the legacy stack never wrote (`openbot-deployment-` bare, or a padded spelling), and
  // attributing a real key to it would be a mapping to a subject nobody named.
  const claimedIds = options.claimedDeploymentIds.filter(
    (id) => typeof id === "string" && id.length > 0 && id.trim() === id,
  );

  // The attribution table: derived key → the identity behind it. Claimed ids first, then the
  // directory's tenant ids (a Set on the id side keeps an id both sides share one entry).
  const attributedKeys = new Map<string, string>();
  for (const id of claimedIds) {
    attributedKeys.set(deploymentExternalCustomerId(id), id);
  }
  const directoryIds = await database
    .select({ id: enterpriseTenants.id })
    .from(enterpriseTenants);
  for (const { id } of directoryIds) {
    if (!attributedKeys.has(deploymentExternalCustomerId(id))) {
      attributedKeys.set(deploymentExternalCustomerId(id), id);
    }
  }

  // The full legacy key set: the union over grants and ledger. (Reservations and remainders
  // never introduce a key of their own — a hold requires available balance, which requires a
  // grant — so this union is complete, and it is the enumeration the ticket names.)
  const legacyKeys = await database.execute<{ external_customer_id: string }>(
    sql`SELECT external_customer_id FROM ${creditGrants}
        UNION
        SELECT external_customer_id FROM ${creditLedger}
        ORDER BY external_customer_id`,
  );

  const outcomes: LegacyMappingOutcome[] = [];
  for (const { external_customer_id: key } of legacyKeys) {
    try {
      // Idempotence anchor: a key that already carries a mapping keeps it — whatever kind the
      // earlier run (or an operator, or createPayerAccount on the live path) gave it.
      const existing = await readPayerAccountForKey(database, key);
      if (existing) {
        outcomes.push({
          kind: "already_mapped",
          externalCustomerId: key,
          accountId: existing.id,
        });
        continue;
      }

      const payerId = attributedKeys.get(key);
      if (payerId !== undefined) {
        // Explicit attribution, through the payer layer's own create so the same race-safe
        // insert, floor handling and conflict refusals apply as on the live path. The key was
        // matched by deriving it FROM `payerId`, so the account's mapping names that derivation
        // exactly; `inserted: false` here means a concurrent run won the row, which is an
        // already-mapped answer, not a second mapping.
        const created = await createPayerAccount(database, {
          kind: "legacy_deployment",
          id: payerId,
        });
        outcomes.push(
          created.inserted
            ? {
                kind: "legacy_deployment",
                externalCustomerId: key,
                payerId,
              }
            : {
                kind: "already_mapped",
                externalCustomerId: key,
                accountId: created.account.id,
              },
        );
        continue;
      }

      // Nobody vouches for this key: quarantine. The row is the audit record — the payer id is
      // the key itself, so each quarantined key holds exactly one row — and it is write-once
      // for every path this module knows: `payerKey` refuses the kind, so no consumer can ever
      // resolve it into a billable account. Same random-draw id shape payer.ts mints.
      const inserted = await database
        .insert(payerAccounts)
        .values({
          id: `pa-${randomBytes(8).toString("hex")}`,
          kind: "unknown_owner",
          payerId: key,
          externalCustomerId: key,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) {
        outcomes.push({ kind: "unknown_owner", externalCustomerId: key });
        continue;
      }
      // A concurrent run quarantined it between the read and the insert: the row exists now,
      // so this pass answers already-mapped rather than pretending it classified it.
      const raced = await readPayerAccountForKey(database, key);
      if (raced) {
        outcomes.push({
          kind: "already_mapped",
          externalCustomerId: key,
          accountId: raced.id,
        });
        continue;
      }
      throw new Error(
        `the quarantine insert for ${key} conflicted but no mapping row was found`,
      );
    } catch (error) {
      // One bad key must not stop the others: the failure is named in the report and the key
      // stays unmapped, so a later run retries exactly it.
      outcomes.push({
        kind: "unprocessed",
        externalCustomerId: key,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scannedKeys: legacyKeys.length,
    alreadyMapped: outcomes.filter((o) => o.kind === "already_mapped").length,
    legacyDeploymentMapped: outcomes.filter(
      (o) => o.kind === "legacy_deployment",
    ).length,
    unknownOwnerQuarantined: outcomes.filter((o) => o.kind === "unknown_owner")
      .length,
    unprocessed: outcomes.filter((o) => o.kind === "unprocessed").length,
    outcomes,
  };
}

if (import.meta.main) {
  /**
   * Operator entry: `bun server/src/billing/payer-legacy.ts`, against the deployment's own
   * database. The claimed identities come from `OPENBOT_LEGACY_DEPLOYMENT_IDS` (comma-
   * separated; typically the deployment id / tenant package id the billing key derives from) —
   * an operator who cannot vouch for any id passes nothing, and every key that no directory
   * tenant explains quarantines, which is the safe direction.
   */
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must point at the deployment database this migration should map.",
    );
  }
  const { createDatabase } = await import("../db/client");
  const claimed = (process.env.OPENBOT_LEGACY_DEPLOYMENT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const database = createDatabase(databaseUrl);
  try {
    const report = await mapLegacyExternalCustomerIds(database, {
      claimedDeploymentIds: claimed,
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
