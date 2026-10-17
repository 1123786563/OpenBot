import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { payerKey, type PayerRef } from "../billing/payer";
import type { Database } from "../db/client";
import { gatewayCustomers } from "../db/schema/gateway";
import type { GatewayCustomerProvisionResult } from "./customer";
import { GatewayCustomerProvisionError } from "./customer";
import { assertGatewayReadyForBilling } from "./readiness";

/*
 * The recoverable association (Bifrost 05.2) layered over 05.1's provisioning
 * seam (customer.ts) and its `gateway_customers` table — consumed, never
 * rebuilt: migration 0135 ALTERs the table 05.1 applied, and this module adds
 * the recovery machine on top of the seam's single create path.
 *
 * DIVISION OF LABOR. 05.1's `provisionCustomer` owns opening the account — the
 * gate, the remote create, the 409-resolve-by-deterministic-name, the mapping
 * insert. This module owns the states that surround it:
 *
 *   - the correlation key (`customerCorrelationKey`, the same deterministic
 *     derivation the billing stack keys its subjects on — `payerKey`), which
 *     05.1 already carries to the gateway as the remote name and 0135 records
 *     locally as `external_reference`;
 *   - the reservation: before the create is issued, a `pending` row (no remote
 *     id — 0135 made the column nullable for exactly this) records that an
 *     outcome may be in flight, so a crash mid-call cannot leave the local side
 *     ignorant that a create went out;
 *   - the recovery: a row found in `pending`/`recoverable` is resolved by
 *     looking the remote subject up by its correlation key BEFORE anything is
 *     created — found: adopt and confirm; definitive miss: the create never
 *     landed, and the row is handed to the seam, whose create completes it via
 *     adoption; lost lookup: stay `recoverable`, nothing is guessed;
 *   - the classification: only "the wire said nothing" failures
 *     (unreachable/timeout, a 409 that cannot be resolved) leave the row
 *     `recoverable`; every definitive refusal of the seam deletes the
 *     reservation — the remote proved it created nothing, so the next attempt
 *     starts clean.
 *
 * THE STATE MACHINE (`gateway_customers.provision_state`):
 *
 *     pending ──▶ confirmed            (the seam's create adopted the row)
 *        │
 *        └──▶ recoverable ──▶ confirmed (outcome unknown → found by key)
 *                 │
 *                 └──▶ (lookup miss) ──▶ seam create ──▶ confirmed
 *
 * Rows spelled 'active' are 05.1's own — a complete association whose remote id
 * is on file; this module's read boundary normalizes them to 'confirmed' rather
 * than rewriting applied rows. The transition to confirmed (by adoption or by
 * recovery) never repeats a create: the database's unique indexes arbitrate, and
 * the deterministic name makes a second remote customer unreachable.
 *
 * THE BOUNDARY. Recovery is the association and nothing more: no balance, no
 * grant, no ledger row and no virtual key is born, moved or copied here. And
 * like every paid model capability, it sits behind the readiness gate —
 * `assertGatewayReadyForBilling()` runs before anything else, so a not-ready
 * gateway refuses provisioning without a single remote call or local row.
 *
 * THE TRANSPORT SEAM (recovery lookups only — creates belong to 05.1's seam).
 * The lookup client speaks the gateway's customer read surface. Exactly one
 * failure kind — `GatewayCustomerTransportLostError`, "the request may have
 * succeeded but no answer arrived" — keeps the row `recoverable`; a definitive
 * "the remote holds no such subject" is answered with null, which is what
 * licenses the create.
 */

/** How far the local ↔ remote association has been confirmed (this layer's vocabulary). */
export type GatewayProvisionState = "pending" | "confirmed" | "recoverable";

/**
 * The stable correlation key a create request carries and recovery looks the
 * remote subject up by: deterministic per subject, shared with the billing
 * stack's own subject key, refused for quarantined kinds.
 */
export function customerCorrelationKey(ref: PayerRef): string {
  return payerKey(ref);
}

/**
 * The transport said nothing: the request may or may not have reached the
 * gateway, and the gateway may or may not have created the customer. This is
 * the ONLY failure a lookup client may raise for "outcome unknown" — a
 * gateway's own refusal is a definitive answer, not a lost one.
 */
export class GatewayCustomerTransportLostError extends Error {
  readonly code = "gateway_customer_transport_lost";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayCustomerTransportLostError";
  }
}

/**
 * The remote outcome is unknown and the mapping is left `recoverable`. A retry
 * of `provisionCustomer` is safe and idempotent: it looks the remote subject
 * up by the correlation key first and creates only on a definitive miss — a
 * second customer is unreachable through this path.
 */
export class GatewayProvisionOutcomeUnknownError extends Error {
  readonly code = "gateway_provision_outcome_unknown";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayProvisionOutcomeUnknownError";
  }
}

/**
 * The gateway itself refused the create — a definitive answer, so nothing was
 * created remotely. The local reservation is removed before this is thrown;
 * the next attempt starts from a clean slate. The gateway's own error rides as
 * the cause.
 */
export class GatewayProvisionRefusedError extends Error {
  readonly code = "gateway_provision_refused";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayProvisionRefusedError";
  }
}

/**
 * The recovery lookup transport: how a lost association is found again.
 * Adapters must raise `GatewayCustomerTransportLostError` for outcome-unknown
 * failures; a definitive miss is `null`, and anything else is a definitive
 * refusal of the read. Creating is NOT this seam's business — 05.1's
 * provisioner owns it.
 */
export type GatewayCustomerClient = {
  /**
   * The customer the reference names, or null for a definitive "the remote
   * holds no such subject". A lookup failure with an unknown answer is a
   * `GatewayCustomerTransportLostError`, never null.
   */
  findCustomerByExternalReference: (
    externalReference: string,
  ) => Promise<{ customerId: string } | null>;
};

/** One association row, as this module answers it. */
export type GatewayCustomerMapping = {
  kind: "personal";
  payerId: string;
  /** The gateway's own customer id, or null while no outcome is on file. */
  customerId: string | null;
  externalReference: string;
  provisionState: GatewayProvisionState;
};

/** What `provisionCustomer` answers once the association is confirmed. */
export type ProvisionResult = {
  customerId: string;
  provisionState: "confirmed";
  /** True when this call recovered a lost association instead of creating. */
  recovered: boolean;
};

export type GatewayCustomerProvisioning = {
  /**
   * The one entry point: confirm this subject's gateway Customer, creating
   * the remote subject only when neither the local mapping nor the remote
   * correlation key names one. Idempotent, race-safe (the database's unique
   * indexes arbitrate, not a read-check) and repeatable — recovery runs as
   * often as it is called and always converges on the same answer.
   */
  provisionCustomer: (ref: PayerRef) => Promise<ProvisionResult>;
  /** The local mapping as it stands, or null. Reads only; no gate, no remote calls. */
  readCustomerMapping: (
    ref: PayerRef,
  ) => Promise<GatewayCustomerMapping | null>;
};

export type GatewayCustomerProvisioningDeps = {
  database: Database;
  /**
   * 05.1's provisioner (customer.ts) — the only writer of fresh gateway
   * Customers: gate, remote create, 409-resolve by deterministic name, insert
   * or reservation adoption. Never reimplemented here.
   */
  provisionCustomer: (ref: PayerRef) => Promise<GatewayCustomerProvisionResult>;
  /** The recovery lookup transport over the gateway's customer read surface. */
  client: GatewayCustomerClient;
};

/**
 * The seam reason codes that say "the wire said nothing" — the create MAY have
 * landed, so the reservation stays `recoverable`. Everything else the seam
 * raises is a definitive refusal (nothing was created), which deletes the
 * reservation.
 */
const OUTCOME_UNKNOWN_REASON_CODES: ReadonlySet<string> = new Set([
  "gateway_customer_unreachable",
  "gateway_customer_timeout",
  "gateway_customer_remote_conflict_unresolved",
]);

function mappingOf(
  row: typeof gatewayCustomers.$inferSelect,
): GatewayCustomerMapping {
  return {
    kind: "personal",
    payerId: row.payerId,
    customerId: row.gatewayCustomerId,
    externalReference: row.externalReference,
    // 'active' is 05.1's spelling of a complete association; the read boundary
    // normalizes instead of rewriting applied rows.
    provisionState:
      row.provisionState === "pending"
        ? "pending"
        : row.provisionState === "recoverable"
          ? "recoverable"
          : "confirmed",
  };
}

function generateRowId(): string {
  return `gc-${randomBytes(8).toString("hex")}`;
}

export function createGatewayCustomerProvisioning(
  deps: GatewayCustomerProvisioningDeps,
): GatewayCustomerProvisioning {
  const { database, client, provisionCustomer: seamProvisionCustomer } = deps;

  /** The row this correlation key names, or undefined. Reads only. */
  const readRowByReference = async (reference: string) => {
    const [row] = await database
      .select()
      .from(gatewayCustomers)
      .where(eq(gatewayCustomers.externalReference, reference))
      .limit(1);
    return row;
  };

  const markState = async (
    rowId: string,
    state: "recoverable" | "confirmed",
  ) => {
    await database
      .update(gatewayCustomers)
      .set({ provisionState: state })
      .where(eq(gatewayCustomers.id, rowId));
  };

  /**
   * The recovery branch: the row is a reservation (pending/recoverable, no
   * remote id). Look the subject up by the correlation key first; create only
   * on a definitive miss — and even then not here: the seam runs with the
   * reservation in place and its outcome adopts the row.
   */
  const recoverRow = async (
    row: typeof gatewayCustomers.$inferSelect,
    reference: string,
    ref: PayerRef,
  ): Promise<ProvisionResult> => {
    // A pending reservation now has an attempt underway on it: pending first
    // moves to recoverable — a crash mid-attempt is exactly the situation
    // recovery exists for.
    if (row.provisionState === "pending") {
      await markState(row.id, "recoverable");
    }

    let remote: { customerId: string } | null;
    try {
      remote = await client.findCustomerByExternalReference(reference);
    } catch (error) {
      // The lookup said nothing (transport loss) or failed before answering:
      // nothing is known about the remote, nothing changes, and the row stays
      // recoverable. Retrying is safe and idempotent.
      await markState(row.id, "recoverable");
      throw new GatewayProvisionOutcomeUnknownError(
        `The gateway customer lookup for ${reference} did not answer, so even the remote's state is unknown. The association stays recoverable; retrying is safe and idempotent.`,
        { cause: error },
      );
    }

    if (remote) {
      // Found: adopt the remote subject the lost create actually made and
      // confirm the association — the whole point of the correlation key. One
      // row, one customer; a racing adoption of the same entity answers the
      // same id either way.
      const [adopted] = await database
        .update(gatewayCustomers)
        .set({
          gatewayCustomerId: remote.customerId,
          provisionState: "confirmed",
        })
        .where(
          and(
            eq(gatewayCustomers.id, row.id),
            isNull(gatewayCustomers.gatewayCustomerId),
          ),
        )
        .returning();
      if (!adopted) {
        // A racing recovery adopted first — the row is complete already.
        // Same deterministic subject, so the same remote entity: answer it.
        const settled = await readRowByReference(reference);
        if (!settled || settled.gatewayCustomerId !== remote.customerId) {
          throw new GatewayProvisionOutcomeUnknownError(
            `The association for ${reference} was completed by another caller under a different remote entity; the outcome is unclear and the subject must be re-examined before provisioning.`,
          );
        }
      }
      return {
        customerId: remote.customerId,
        provisionState: "confirmed",
        recovered: true,
      };
    }

    // Definitive miss: the remote holds no such subject, so the create never
    // landed. The reservation stays in place and the seam creates — its
    // outcome adopts this very row (no second row, no second customer).
    return runSeamCreate(row.id, reference, ref, { recovered: true });
  };

  /**
   * The create, always the seam's: optionally reserve first (fresh path), run
   * 05.1's provisioner, and classify its failures — outcome-unknown keeps the
   * reservation recoverable, a definitive refusal removes it so the next
   * attempt starts clean.
   */
  const runSeamCreate = async (
    reservationId: string | null,
    reference: string,
    ref: PayerRef,
    opts: { recovered: boolean },
  ): Promise<ProvisionResult> => {
    if (reservationId === null) {
      // Record the attempt as pending BEFORE the create is issued, so a crash
      // mid-call cannot leave the local side ignorant that an outcome may be
      // in flight. The subject's unique index absorbs a racing caller; the
      // loser converges on the one row that survived.
      const inserted = await database
        .insert(gatewayCustomers)
        .values({
          id: generateRowId(),
          kind: "personal",
          payerId: ref.id,
          // The deterministic remote name IS the correlation key (05.1 derives
          // the same string); external_reference generates from it.
          gatewayCustomerName: reference,
          provisionState: "pending",
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const existing = await readRowByReference(reference);
        if (!existing) {
          // Only a hand-placed row holding this reference can produce it.
          throw new GatewayProvisionRefusedError(
            `provisionCustomer: the association row for this subject conflicted but none was found (reference ${reference}).`,
          );
        }
        if (existing.gatewayCustomerId !== null) {
          // A racing provisioner already completed the association.
          return {
            customerId: existing.gatewayCustomerId,
            provisionState: "confirmed",
            recovered: false,
          };
        }
        return recoverRow(existing, reference, ref);
      }
      reservationId = inserted[0].id;
    }
    const reservationRowId: string = reservationId;

    try {
      const result = await seamProvisionCustomer(ref);
      // The seam either created a fresh row or adopted this reservation —
      // both leave a complete association. `recovered` reports whether this
      // call entered through the recovery path.
      return {
        customerId: result.customerId,
        provisionState: "confirmed",
        recovered: opts.recovered,
      };
    } catch (error) {
      if (
        error instanceof GatewayCustomerProvisionError &&
        !OUTCOME_UNKNOWN_REASON_CODES.has(error.reasonCode)
      ) {
        // A definitive refusal: the gateway answered NO, so nothing was
        // created remotely and the reservation is removed — the next attempt
        // starts clean.
        await database
          .delete(gatewayCustomers)
          .where(eq(gatewayCustomers.id, reservationRowId));
        throw new GatewayProvisionRefusedError(
          `The gateway refused the customer create for ${reference}; nothing was created remotely and the local attempt was discarded. The next attempt starts clean.`,
          { cause: error },
        );
      }
      // The wire said nothing (unreachable/timeout/unresolvable conflict) or
      // the failure is not the seam's classified kind: the create MAY have
      // landed, so the reservation is marked recoverable and the outcome is
      // reported unknown. Never guessed into a refusal.
      await markState(reservationRowId, "recoverable");
      throw new GatewayProvisionOutcomeUnknownError(
        `The gateway customer create for ${reference} got no answer, so the remote outcome is unknown. The association is marked recoverable: the next provisioning call looks the subject up by its correlation key before creating. Retrying is safe and idempotent.`,
        { cause: error },
      );
    }
  };

  return {
    async provisionCustomer(ref) {
      // The gate first, like every paid model capability: a not-ready gateway
      // refuses provisioning before a single remote call or local row. (The
      // seam gates again internally; a ready gateway answers twice for free.)
      await assertGatewayReadyForBilling();

      // The correlation key derivation refuses the quarantined unknown_owner
      // kind; the gateway Customer is the personal user's principal, so every
      // other kind is refused too — 05.1's table and CHECK allow no other.
      const reference = customerCorrelationKey(ref);
      if (ref.kind !== "personal") {
        throw new GatewayProvisionRefusedError(
          "provisionCustomer: only a personal subject holds a gateway Customer principal; every other kind is refused.",
        );
      }

      // Lookup by the correlation key first — always, before anything is
      // created. The unique index on external_reference answers this.
      const existing = await readRowByReference(reference);

      if (
        existing &&
        existing.gatewayCustomerId !== null &&
        existing.provisionState !== "pending" &&
        existing.provisionState !== "recoverable"
      ) {
        // A complete association ('confirmed', or 05.1's 'active'): the
        // mapping itself is the idempotent answer.
        return {
          customerId: existing.gatewayCustomerId,
          provisionState: "confirmed",
          recovered: false,
        };
      }

      if (existing) {
        // A reservation: the remote outcome is not on file, so look before
        // anything is created.
        return recoverRow(existing, reference, ref);
      }

      // No association on file: the definitive local miss — reserve, then let
      // the seam create.
      return runSeamCreate(null, reference, ref, { recovered: false });
    },

    async readCustomerMapping(ref) {
      if (ref.kind !== "personal") return null;
      const row = await readRowByReference(payerKey(ref));
      return row ? mappingOf(row) : null;
    },
  };
}

/** Re-export so callers of this module can classify the seam's failures too. */
export { GatewayCustomerProvisionError };
export type { GatewayCustomerProvisionResult };
