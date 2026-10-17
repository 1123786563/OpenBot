import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import { payerAccounts } from "../db/schema/payer";
import {
  assertPayerRef,
  externalCustomerIdForPayer,
  PayerOwnerUnknownError,
  type PayerRef,
} from "./payer-ref";

// The service's refusal surface, re-exported so its consumers need one import for the seam.
export { PayerOwnerUnknownError } from "./payer-ref";

/**
 * The payer account layer (ticket #215): provisioning and resolution over the
 * `payer_accounts` mapping. This is the seam every later finance consumer (#216–#220 and the
 * group 02/05/10 tickets) goes through — they construct a PayerRef from trusted business
 * context, provision it once, and resolve it to the `externalCustomerId` the existing credit
 * tables are keyed by, so CreditWriter's own interface and semantics stay exactly as they are.
 *
 * What this layer does NOT do, deliberately: it moves no money. Creating an account writes one
 * `payer_accounts` row (and the billing-customer floor beneath it) and nothing else — no grant,
 * no ledger row, no balance copy, split or migration. Old records stay on their original key:
 * the `legacy_deployment` kind maps onto the existing deployment key by derivation, so the
 * deployment's history needs zero data movement to become an account.
 *
 * Resolution is fail-closed. `payerKey` answers the key of a REGISTERED account or refuses —
 * it never derives-and-continues for an unregistered subject, never falls back to another
 * account, and never resolves `unknown_owner`, even when an isolated row exists (the 02.2
 * mapping's audit records). A caller that forgets to provision gets a loud refusal, not a
 * silently self-registered payer.
 */

/**
 * No account is registered for this payer. The coded refusal that keeps resolution fail-closed:
 * there is no derived-string fallback, no implicit provisioning, no alternative account.
 */
export class PayerAccountMissingError extends Error {
  /** Stable, snake_case, the sentinel consumers can branch on. */
  readonly code = "payer_account_missing";
  constructor(message: string) {
    super(message);
    this.name = "PayerAccountMissingError";
  }
}

/** One account row, as the service answers it: the payer, its billing key, ISO times. */
export type PayerAccount = {
  id: string;
  payer: PayerRef;
  externalCustomerId: string;
  createdAt: string;
};

export type PayerAccountService = {
  /**
   * Provision the payer's account, idempotently: create it if absent, answer the existing row
   * if present. Concurrent creates of one payer all answer the same single row — the insert is
   * an insert-or-nothing against the `(kind, owner_id)` unique index and the loser re-reads the
   * winner's mapping. An existing row always wins over what was derived, so an explicitly bound
   * mapping (02.2) is never rewritten by provisioning.
   *
   * Writes no balance of any kind. Refuses `unknown_owner` (isolated owners are recorded by the
   * legacy mapping, never provisioned).
   */
  createPayerAccount(
    payer: PayerRef,
  ): Promise<{ created: boolean; account: PayerAccount }>;

  /**
   * Resolve the payer to the one `externalCustomerId` its account is billed through — the string
   * to hand CreditWriter. Registered accounts only: an unregistered payer throws
   * `PayerAccountMissingError` (no fallback), and `unknown_owner` throws
   * `PayerOwnerUnknownError` (isolation holds even with a row).
   */
  payerKey(payer: PayerRef): Promise<string>;
};

export function createPayerAccountService(
  database: Database,
): PayerAccountService {
  return {
    async createPayerAccount(payer) {
      assertPayerRef(payer);
      // Deriving is also the unknown_owner refusal: no key exists for an isolated owner.
      const externalCustomerId = externalCustomerIdForPayer(payer);

      // The customer floor, the same insert-if-absent CreditWriter lays under a first grant: the
      // account's foreign key must not be the thing that discovers the billing customer.
      await database
        .insert(billingCustomers)
        .values({ externalId: externalCustomerId, name: null })
        .onConflictDoNothing({ target: billingCustomers.externalId });

      // The concurrency authority: insert-or-nothing against the subject's unique index. Racers
      // derive the same key (deterministic), so one insert lands and every other racer's insert
      // becomes a no-op that falls through to the re-read below.
      //
      // The catch matters because the table has TWO unique indexes and Postgres only arbitrates
      // the one ON CONFLICT names: under concurrent identical inserts a racer can be told about
      // the collision by the OTHER index (the external-key one) first, which surfaces as a
      // unique-violation error rather than a do-nothing. That error is still the same race —
      // recover by re-reading, and only if the re-read finds nothing (the key was claimed by a
      // genuinely different subject) does the original violation propagate to the caller.
      let rows: (typeof payerAccounts.$inferSelect)[] = [];
      let violation: unknown;
      try {
        rows = await database
          .insert(payerAccounts)
          .values({
            id: `pa-${randomBytes(8).toString("hex")}`,
            kind: payer.kind,
            ownerId: payer.id,
            externalCustomerId,
          })
          .onConflictDoNothing({
            target: [payerAccounts.kind, payerAccounts.ownerId],
          })
          .returning();
      } catch (error) {
        if (!isPayerAccountCollision(error)) throw error;
        violation = error;
      }
      if (rows[0]) return { created: true, account: accountOf(rows[0]) };

      // The account already exists: the committed-state answer, never a read that could race a
      // concurrent insert of a different account.
      const [existing] = await database
        .select()
        .from(payerAccounts)
        .where(
          and(
            eq(payerAccounts.kind, payer.kind),
            eq(payerAccounts.ownerId, payer.id),
          ),
        )
        .limit(1);
      if (!existing) {
        // The mapping was claimed by a DIFFERENT subject: the account this payer derived a key
        // for already belongs to someone else, so the write fails with the database's own
        // violation rather than being swallowed into a silent no-op.
        if (violation) throw violation;
        throw new TypeError(
          "createPayerAccount: the account conflicted but no existing mapping was found.",
        );
      }
      return { created: false, account: accountOf(existing) };
    },

    async payerKey(payer) {
      assertPayerRef(payer);
      if (payer.kind === "unknown_owner") {
        // Isolation is checked before the lookup so an isolated ROW cannot become a resolved
        // key: the mapping's own record of "nobody established this owner" outranks the row.
        throw new PayerOwnerUnknownError(
          "payerKey: unknown_owner payers can never be resolved for billing.",
        );
      }
      const [row] = await database
        .select({ externalCustomerId: payerAccounts.externalCustomerId })
        .from(payerAccounts)
        .where(
          and(
            eq(payerAccounts.kind, payer.kind),
            eq(payerAccounts.ownerId, payer.id),
          ),
        )
        .limit(1);
      if (!row) {
        throw new PayerAccountMissingError(
          `payerKey: no payer account is registered for ${payer.kind} ${payer.id}. Provision one with createPayerAccount first; there is no fallback.`,
        );
      }
      return row.externalCustomerId;
    },
  };
}

type PayerAccountRow = typeof payerAccounts.$inferSelect;

/** Whether the error (or any of its causes) is a payer_accounts unique-index violation. */
function isPayerAccountCollision(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (
      current.message.includes(
        "duplicate key value violates unique constraint",
      ) &&
      current.message.includes('"payer_accounts_')
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function accountOf(row: PayerAccountRow): PayerAccount {
  return {
    id: row.id,
    payer: { kind: row.kind, id: row.ownerId },
    externalCustomerId: row.externalCustomerId,
    createdAt: row.createdAt.toISOString(),
  };
}
