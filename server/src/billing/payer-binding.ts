import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "../db/client";
import { CREDIT_SCALE } from "./credits";
import {
  createPayerAccount,
  type PayerAccount,
  PayerAccountConflictError,
  type PayerKind,
  type PayerRef,
  payerKey,
} from "./payer";

/**
 * The request's one payer (B5-219, parent spec #5 AC13, ADR 0004): admission, usage,
 * settlement and the carried remainder all name the account this module binds — and an
 * insufficient balance on it is a refusal, never a re-resolution and never a switch to
 * another account. The binding is created once per business request, carried explicitly
 * to every write the consumption path makes, and restorable across processes from the
 * persisted payer-account mapping (the authoritative kind+id record the payer layer
 * owns), so a recovering worker never guesses ownership from a key's shape.
 *
 * The security properties are structural, mirroring the payer layer's: `bindPayer`
 * resolves through `payerKey` alone, so a caller-supplied key can never name an account
 * its ref does not derive; `resolveConsumptionPayerBinding` re-derives every request
 * binding's key before trusting it, so a hand-built or tampered object is refused the
 * way 02.3 refuses an untrusted scope; and the deployment's own binding — the one
 * explicit default the consumption entry keeps until group 09 wires per-surface payer
 * resolution — is created at boot through the mapping layer, never reached for as a
 * bare string.
 */

/** The one payer a request is bound to, and the account key it was resolved to. */
export type PayerBinding = {
  readonly payer: PayerRef;
  /** `payerKey(payer)`, resolved exactly once when the binding was made. */
  readonly externalCustomerId: string;
  /** When the binding was made (ISO 8601) — diagnostic, never re-resolved from. */
  readonly boundAt: string;
};

/**
 * A request that tried to carry two payers, or a settlement that named an account other
 * than the one the request bound. Programmatic consumers match on the stable code; the
 * message names the conflict without embedding the foreign account's identity.
 */
export class PayerBindingConflictError extends Error {
  readonly code = "payer_binding_conflict";

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PayerBindingConflictError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The admission refusal for an insufficient balance (AC13: the ONLY semantics a short
 * balance has — refuse, name the account type and the available amount, switch nothing).
 * The message is the displayable part: it carries the bound account's own type and its
 * own available balance, and no account keys or other subjects' data — there is no
 * second account to name, because a refusal re-resolves nothing.
 */
export class CreditInsufficientError extends Error {
  override name = "CreditInsufficientError";
  readonly code = "credits_exhausted";
  readonly payerKind: PayerKind;
  readonly availableCents: number;

  constructor(input: { payerKind: PayerKind; availableCents: number }) {
    const label = payerKindLabel(input.payerKind);
    super(
      `Insufficient credits on the ${label} payment account: ${(
        input.availableCents / CREDIT_SCALE
      ).toFixed(
        2,
      )} credits available. Ask for credits to be granted to this payment account, or reduce the size of the request.`,
    );
    this.payerKind = input.payerKind;
    this.availableCents = input.availableCents;
  }
}

/** The displayable word for an account kind. A quarantined kind is never displayable. */
function payerKindLabel(kind: PayerKind): string {
  switch (kind) {
    case "personal":
      return "personal";
    case "company":
      return "company";
    case "legacy_deployment":
      return "deployment";
    case "unknown_owner":
      throw new TypeError(
        "unknown_owner records are quarantined for audit and can never be named as a payment account.",
      );
    default:
      throw new TypeError(`unknown payer kind ${String(kind)}.`);
  }
}

/**
 * Bind the request's payer: resolve the ref to its account key exactly once, here, and
 * carry the answer forward unchanged. Input validation is `payerKey`'s own (a padded or
 * empty id, a quarantined kind), so a bad ref dies before any lookup — and the binding
 * is frozen, because a request whose payer could be edited after admission is a request
 * with two payers.
 */
export function bindPayer(ref: PayerRef): PayerBinding {
  return Object.freeze({
    payer: Object.freeze({ ...ref }),
    externalCustomerId: payerKey(ref),
    boundAt: new Date().toISOString(),
  });
}

/**
 * The settlement-side guard: the account a write names must be the one the request
 * bound. The refusal names the conflict, never the foreign account's id.
 */
export function assertSamePayer(binding: PayerBinding, ref: PayerRef): void {
  if (
    ref.kind !== binding.payer.kind ||
    ref.id !== binding.payer.id ||
    payerKey(ref) !== binding.externalCustomerId
  ) {
    throw new PayerBindingConflictError(
      "payer binding conflict: this request is already bound to a different payment account.",
    );
  }
}

/**
 * Cross-process restoration (group 08's recovery path): rebuild the binding from the
 * payer-account mapping row — the authoritative kind+id record — never from the key's
 * shape. A quarantined row, or one whose key does not derive from its own ref, is a
 * corrupt mapping: refused loudly, never turned into a billable binding.
 */
export function restorePayerBinding(account: PayerAccount): PayerBinding {
  const ref: PayerRef = { kind: account.kind, id: account.payerId };
  if (account.kind === "unknown_owner") {
    throw new PayerBindingConflictError(
      "restorePayerBinding: an unknown_owner record is quarantined for audit and can never be restored into a payment binding.",
    );
  }
  if (payerKey(ref) !== account.externalCustomerId) {
    throw new PayerBindingConflictError(
      "restorePayerBinding: the mapping row's key does not derive from its own ref; the mapping is corrupt and no binding is restored.",
    );
  }
  return Object.freeze({
    payer: Object.freeze(ref),
    externalCustomerId: account.externalCustomerId,
    boundAt: account.createdAt,
  });
}

/*
 * The request context, the same ambient pattern ./usage-origin.ts uses for the usage
 * origin: set once where the request is known (the surface or middleware that resolved
 * the payer), read at the consumption entry where the request context still exists. The
 * innermost binding wins; the outer one survives the inner scope.
 */
const payerStore = new AsyncLocalStorage<PayerBinding>();

/** Run `fn` (and everything it awaits) as work billed to `binding`. */
export function withPayerBinding<T>(
  binding: PayerBinding,
  fn: () => Promise<T>,
): Promise<T> {
  return payerStore.run(binding, fn);
}

/** The request's binding, or undefined when no surface bound one. */
export function currentPayerBinding(): PayerBinding | undefined {
  return payerStore.getStore();
}

/**
 * Structural integrity for a binding that arrived from outside this module: its key must
 * derive from its own ref. A hand-built object whose key names someone else is refused
 * here, at the consumption entry's trust boundary — the same answer an untrusted scope
 * gets in the company branch.
 */
function assertBindingCoherent(binding: PayerBinding, origin: string): void {
  if (payerKey(binding.payer) !== binding.externalCustomerId) {
    throw new PayerBindingConflictError(
      `${origin}: the binding's account key does not derive from its own payer ref; the binding is refused.`,
    );
  }
}

/**
 * The consumption entry's whole payer decision (B5-219 step 1+2), as one seam: a
 * request-bound payer is used as-is after its coherence is re-proven — never
 * re-resolved, never swapped, no matter what any balance says — and a request without
 * one resolves to the deployment's own binding, made once at boot and passed in here
 * explicitly. That second branch is the ONE deployment default the consumption path
 * keeps, until group 09 (09.2) wires per-surface payer resolution; the call-site
 * inventory test in payer-no-fallback.test.ts pins that no other deployment-key path
 * grows. Neither branch consults a balance: a short balance is refused downstream, on
 * the bound account, by `CreditInsufficientError`.
 */
export function resolveConsumptionPayerBinding(input: {
  requestBinding: PayerBinding | undefined;
  deploymentBinding: PayerBinding;
}): PayerBinding {
  if (input.requestBinding !== undefined) {
    assertBindingCoherent(
      input.requestBinding,
      "resolveConsumptionPayerBinding",
    );
    return input.requestBinding;
  }
  assertBindingCoherent(
    input.deploymentBinding,
    "resolveConsumptionPayerBinding",
  );
  return input.deploymentBinding;
}

/**
 * The deployment's own payer binding, made once at boot: the ref resolves through the
 * payer layer's race-safe account creation, so the mapping row exists and cross-process
 * recovery (`readPayerAccountForKey` + `restorePayerBinding`) can always restore it. A
 * key held by a different mapping — an operator's 02.2 quarantine, for instance — is a
 * loud boot-time conflict: the consumption path cannot run without a payer, and the
 * honest answer is a refusal with the conflict named, never a borrowed account and
 * never a silent re-key.
 */
export async function ensureDeploymentPayerBinding(
  database: Database,
  input: { id: string },
): Promise<PayerBinding> {
  try {
    const { account } = await createPayerAccount(database, {
      kind: "legacy_deployment",
      id: input.id,
    });
    return restorePayerBinding(account);
  } catch (error) {
    if (error instanceof PayerAccountConflictError) {
      throw new PayerBindingConflictError(
        "ensureDeploymentPayerBinding: the deployment's account key is held by a different payer mapping; the consumption entry refuses to bind it.",
        error,
      );
    }
    throw error;
  }
}
