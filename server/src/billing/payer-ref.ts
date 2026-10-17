import { deploymentExternalCustomerId } from "./service";

/**
 * The billing subject contract (ticket #215, Bifrost group 02): every credit the ledger ever
 * moves is owned by a payer, and this type is the one expression of that owner handed between
 * finance consumers. A payer is a DISCRIMINATED pair — the kind fixes what `id` means — never a
 * bare string:
 *
 * - `personal` — an OpenBot user's own balance (ADR 0002: the individual is the consumption
 *   subject for external Bot authorizations).
 * - `company` — a Tenant's company credit account (ADR 0004: company-workbench spending).
 * - `legacy_deployment` — the deployment-level account the current wiring bills to
 *   (`deploymentExternalCustomerId`), kept as an explicit kind so the convergence away from it
 *   (group 02.2) happens as visible mapping, not string guessing.
 * - `unknown_owner` — a recorded key whose owner could not be established. Isolation only: it
 *   exists so the ledger's history stays attributable; it can never fund new consumption.
 *
 * The pair is constructed by SERVER code from trusted business context (the authenticated user,
 * the company scope of a workbench call). No client-supplied payer is ever accepted, and no
 * balance shortfall may switch the payer — the routing decisions live in their own tickets
 * (02.3/02.4); this module only fixes what a payer IS once decided.
 *
 * Ids are stable business ids (a user id, a tenant id, a deployment tenant id): non-empty, and
 * never padded with surrounding whitespace, so two spellings of one owner cannot become two
 * accounts. Malformed refs are caller bugs and answer TypeError, the same seam discipline
 * CreditWriter keeps for its amounts.
 */

/** The four kinds of billing subject, the closed set the schema's check constraint repeats. */
export const PAYER_KINDS = [
  "personal",
  "company",
  "legacy_deployment",
  "unknown_owner",
] as const;

export type PayerKind = (typeof PAYER_KINDS)[number];

/** One billing subject: a kind that fixes the meaning, and the stable id within that kind. */
export type PayerRef = {
  kind: PayerKind;
  id: string;
};

/**
 * An unknown_owner payer can be recorded for audit but can never own new billing. Kept as a
 * coded domain error (not a TypeError) because an isolated record is a legal state of the world,
 * reached by the legacy mapping (02.2), that every consumption path must refuse.
 */
export class PayerOwnerUnknownError extends Error {
  /** Stable, snake_case, the sentinel later delivery/recovery paths match on. */
  readonly code = "unknown_owner";
  constructor(message: string) {
    super(message);
    this.name = "PayerOwnerUnknownError";
  }
}

/** Whether `value` is a well-formed payer: a known kind and a non-empty, unpadded id. */
export function isPayerRef(value: unknown): value is PayerRef {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { kind?: unknown; id?: unknown };
  return (
    typeof candidate.kind === "string" &&
    (PAYER_KINDS as readonly string[]).includes(candidate.kind) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    candidate.id.trim() === candidate.id
  );
}

/**
 * The runtime check behind the type: every service entry point calls this first, so a caller
 * that assembles a payer from untrusted or drifted input fails at the seam, before any write.
 */
export function assertPayerRef(payer: PayerRef): PayerRef {
  if (!isPayerRef(payer)) {
    throw new TypeError(
      "A payer needs a known kind (personal | company | legacy_deployment | unknown_owner) and a non-empty id without surrounding whitespace.",
    );
  }
  return payer;
}

/**
 * The billing key a payer's account is mapped to: the SAME externalCustomerId string the credit
 * tables are keyed by, so CreditWriter's interface keeps its exact semantics — consumers resolve
 * a payer to its key and hand the key to the writer they already use.
 *
 * Deterministic and injective by construction: the kind is embedded in the personal/company
 * prefixes and the legacy kind delegates to `deploymentExternalCustomerId` itself (the one place
 * that format lives), so two payers of different kinds can never derive the same key and the
 * same payer can never derive two. That determinism is what makes concurrent provisioning
 * trivially convergent: every racer derives the same target, and the account table's unique
 * indexes (./payer-account.ts) make only one mapping effective.
 *
 * `unknown_owner` refuses: no key can be derived for an owner nobody established, which is the
 * isolation the legacy mapping relies on — its rows are readable for audit, unusable for spend.
 */
export function externalCustomerIdForPayer(payer: PayerRef): string {
  assertPayerRef(payer);
  switch (payer.kind) {
    case "personal":
      return `payer-personal-${payer.id}`;
    case "company":
      return `payer-company-${payer.id}`;
    case "legacy_deployment":
      return deploymentExternalCustomerId(payer.id);
    case "unknown_owner":
      throw new PayerOwnerUnknownError(
        "unknown_owner payers are isolated for audit and can never own new billing.",
      );
  }
}
