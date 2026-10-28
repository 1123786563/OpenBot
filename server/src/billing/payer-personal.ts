import type { Database } from "../db/client";
import { createPayerAccount, type PayerAccount, type PayerRef } from "./payer";

/**
 * The payer resolution module's personal branch: an authenticated user IS their billing subject.
 * The company branch (02.3) resolves from trusted business context and the Bot branches (04.5,
 * 05.3) will resolve from a granted authorization, but every one of them funnels into the same
 * PayerRef layer — this branch is the seam those later tickets reuse, and the only one that
 * exists until they land.
 *
 * The security property is structural, not checked: `resolvePayerForPersonalUser` consumes only
 * the authenticated subject's own id, so a forged company id or a client-supplied payment account
 * cannot change the answer — those fields are not inputs. The complement is the explicit refusal:
 * requests that still carry an account identity (`userId`, `externalCustomerId`, …) are answered
 * with `PayerCrossAccountAccessError` at the boundary, never an empty result and never a read of
 * someone else's key.
 */

/** The authenticated identity the personal branch resolves from: exactly one field is read. */
export type PersonalUserIdentity = {
  /** The authenticated user's own stable id (auth/guards.ts `AuthenticatedActor["id"]`). */
  id: string;
};

/**
 * A request that tried to name an account other than the authenticated subject's own. The credit
 * read routes throw it from their boundary middleware and map it to a 400 — never an empty
 * result, which is how a cross-account read hides as a permissions bug instead of the forgery it
 * is — and programmatic consumers (the Bot authorization paths) can match on the stable code.
 */
export class PayerCrossAccountAccessError extends Error {
  readonly code = "payer_cross_account_denied";
  constructor(message: string) {
    super(message);
    this.name = "PayerCrossAccountAccessError";
  }
}

/**
 * The query/body parameter names that carry an account identity a client must never supply.
 * `userId` and `externalCustomerId` are the forgeries the ticket names; `payerId`/`accountId`
 * are the mapping layer's own ids, and `companyId`/`tenantId` are the company branch's subject
 * — a personal request has no business naming any of them, whoever the value names.
 */
export const foreignAccountIdentityKeys = [
  "userId",
  "externalCustomerId",
  "payerId",
  "accountId",
  "companyId",
  "tenantId",
] as const;

/**
 * Matching is case- and separator-insensitive, so `UserID` and `user_id` cannot ride past
 * the refusal a `userId` gets.
 */
const normalizeForeign = (key: string) =>
  key.toLowerCase().replace(/[_-]/g, "");
const foreignKeySet = new Set(foreignAccountIdentityKeys.map(normalizeForeign));

/**
 * The first account-identity parameter present in a request's fields — answered with the key as
 * the request spelled it, so the refusal names what arrived — or null. An empty-string value
 * still counts: the refusal answers "this request tried to name an account", and presence is
 * that attempt — the value's content is evidence, not permission.
 */
export function findForeignAccountIdentity(
  source: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(source)) {
    if (foreignKeySet.has(key.toLowerCase())) return key;
  }
  return null;
}

/**
 * Resolve the one personal payer for an authenticated user — pure, no database, the same rule as
 * the payer layer's id check so a bad identity dies before any lookup. Callers pass the
 * authenticated actor; extra fields on it are ignored by contract (and pinned by test), which is
 * what makes the forged-company-id answer "unchanged" rather than "wrong".
 */
export function resolvePayerForPersonalUser(
  user: PersonalUserIdentity,
): PayerRef {
  if (
    typeof user?.id !== "string" ||
    user.id.length === 0 ||
    user.id.trim() !== user.id
  ) {
    throw new TypeError(
      "resolvePayerForPersonalUser needs the authenticated user's own non-empty id with no leading or trailing whitespace.",
    );
  }
  return { kind: "personal", id: user.id };
}

/**
 * Resolve the personal account for an authenticated user, creating it idempotently when this is
 * their first visit — through the payer layer's race-safe `createPayerAccount`, so concurrent
 * first requests leave exactly one mapping. An account is born a mapping row and nothing else:
 * no grant, no ledger row, no balance. The replay answer carries the same account as the first
 * create: callers cannot tell, and need not care, whether they opened it.
 */
export async function resolvePersonalPayerAccount(
  database: Database,
  user: PersonalUserIdentity,
): Promise<PayerAccount> {
  const { account } = await createPayerAccount(
    database,
    resolvePayerForPersonalUser(user),
  );
  return account;
}
