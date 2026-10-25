/*
 * Company assurance — the additional company-authentication proof of design
 * §9.1 and interfaces §5 (T02.10 / #532, original task P04).
 *
 * This file owns the FROZEN CONTRACT and, for now, one deliberately closed
 * implementation of it:
 *
 * - `CompanyAssurance.require(tx, identity, tenantId)` is the read-gate half a
 *   company-scoped business transaction calls. Companies WITHOUT an additional
 *   proof policy answer `null`; a company that demands one answers a
 *   controlled 403 COMPANY_REAUTH_REQUIRED until the evidence bridge and the
 *   proof store are wired (P11). There is no "proof would have been nice"
 *   middle state and no optional dependency that skips the question: a
 *   consumer that forgets to inject the policy fails at construction, not at
 *   the first sensitive read.
 * - `challenge` and `complete` are the interactive halves. In this closed
 *   adapter they always answer 503 COMPANY_AUTH_NOT_READY: no challenge is
 *   ever issued, no callback is ever accepted, and therefore nothing can be
 *   "completed" against a deployment that has no evidence bridge. P11 replaces
 *   the factory; the interface does not change.
 *
 * Why the closed adapter exists at all: the read gate, the scope resolver and
 * the enterprise assemblers (T02.11/T03/P05) need the required dependency
 * NOW, when the full implementation does not exist yet. A `undefined` or
 * optional proof dependency in those call sites is exactly the bypass
 * interfaces §5 forbids, so the seam is a real object with real refusals.
 *
 * The evidence types (`VerifiedSsoEvidence`, `SsoEvidenceBridge`) already live
 * in `../sso-evidence.ts` (T01.06/T01.07) and are not re-declared here; the
 * proof a verified callback earns is the `AssuranceRef` below, whose
 * generations and policy revision the read gate compares live at use time.
 */

import type {
  DirectoryActor,
  DirectoryTx,
  Version,
} from "./directory/contracts";

/**
 * What a live, usable company proof looks like to a caller (interfaces §5):
 * the proof row's identity, the session it is bound to, the company it
 * unlocks, and the versions it was issued against. Deliberately not enough to
 * answer "is it still valid" — the read gate re-reads the stored proof and
 * compares, because a returned ref is a snapshot, not an authorization.
 */
export type AssuranceRef = Readonly<{
  assuranceId: string;
  sessionId: string;
  tenantId: string;
  policyRevision: Version;
  identityGeneration: Version;
  companyGeneration: Version;
  expiresAt: string;
}>;

/**
 * The frozen company proof contract (interfaces §5). `require` is callable
 * from the data role's business transaction (the T02.06 controlled read owns
 * the clocks/assurance grants); `challenge` starts an additional
 * authentication for a company whose policy demands one; `complete` accepts
 * the protocol callback and returns where to continue.
 */
export interface CompanyAssurance {
  require(
    tx: DirectoryTx,
    identity: DirectoryActor,
    tenantId: string,
  ): Promise<AssuranceRef | null>;
  challenge(
    identity: DirectoryActor,
    input: { tenantId: string; returnPath: string },
  ): Promise<{ challengeId: string; redirectUrl: string; expiresAt: string }>;
  complete(
    request: Request,
  ): Promise<{ sessionId: string; tenantId: string; returnPath: string }>;
}

/**
 * The one external fact the closed adapter needs: which companies require an
 * additional proof. P11 replaces this port with the stored auth-policy model;
 * keeping it a port here means the closed adapter never invents a policy
 * default of its own.
 */
export interface CompanyProofPolicyView {
  requiresProof(tenantId: string): Promise<boolean>;
}

/*
 * Stable refusal codes (interfaces §4/§5).
 */

/** A company whose policy demands proof, with no usable proof presented. */
export const COMPANY_REAUTH_REQUIRED = "COMPANY_REAUTH_REQUIRED";
/** The interactive halves are not wired in this deployment (P11 owns them). */
export const COMPANY_AUTH_NOT_READY = "COMPANY_AUTH_NOT_READY";
/** `require` was asked about no company; a policy answer cannot be invented. */
export const COMPANY_ASSURANCE_TARGET_REQUIRED =
  "COMPANY_ASSURANCE_TARGET_REQUIRED";
/** The factory was built without its required proof-policy dependency. */
export const COMPANY_ASSURANCE_POLICY_REQUIRED =
  "COMPANY_ASSURANCE_POLICY_REQUIRED";

/**
 * A company-assurance refusal. 403 is the "prove the company first" answer of
 * interfaces §4 (`COMPANY_REAUTH_REQUIRED`); 503 is the closed interactive
 * surface's answer. No code path here returns a proof ref it did not verify.
 */
export class CompanyAssuranceRefusal extends Error {
  constructor(
    readonly status: 403 | 503,
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CompanyAssuranceRefusal";
  }
}

export function isCompanyAssuranceRefusal(
  error: unknown,
): error is CompanyAssuranceRefusal {
  return error instanceof CompanyAssuranceRefusal;
}

/**
 * The closed adapter (interfaces §5): the required dependency for call sites
 * that gate company-scoped reads before P11 exists. `policy` is required —
 * passing it as optional, or leaving `require` undefined, is how a proof
 * requirement silently disappears.
 */
export function createClosedCompanyAssurance(deps: {
  readonly policy: CompanyProofPolicyView;
}): CompanyAssurance {
  const policy = deps?.policy;
  if (!policy || typeof policy.requiresProof !== "function") {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_ASSURANCE_POLICY_REQUIRED,
      "createClosedCompanyAssurance needs its proof-policy view: an optional or missing policy would let a company's additional-proof requirement disappear silently, which is the bypass interfaces §5 forbids",
    );
  }

  /** Both interactive halves are closed, and say so before touching anything. */
  function closed(operation: "challenge" | "complete"): never {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_AUTH_NOT_READY,
      `${operation} is not wired in this deployment: the company-auth evidence bridge (P11) owns challenge issuance and callback verification, so no challenge is issued and no callback is accepted`,
    );
  }

  const assurance: CompanyAssurance = {
    async require(_tx, _identity, tenantId) {
      // `_tx`/`_identity` are part of the frozen contract but this adapter
      // proves nothing against them: there is no proof store to read and no
      // session/principal to compare until P11 replaces this factory.
      if (typeof tenantId !== "string" || !tenantId.trim()) {
        throw new CompanyAssuranceRefusal(
          403,
          COMPANY_ASSURANCE_TARGET_REQUIRED,
          "require was called without naming a company; the proof question is per company and cannot be answered for none",
        );
      }
      const required = await policy.requiresProof(tenantId);
      // Only an explicit false is a "this company needs no additional proof"
      // answer. A missing or non-boolean answer is treated as proof-required,
      // so a broken policy fails closed instead of opening the read.
      if (required === false) return null;
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `company ${tenantId} requires an additional company proof, and this deployment cannot verify one until the evidence bridge (P11) is wired; authenticate against the company before retrying`,
      );
    },
    async challenge(_identity, _input) {
      return closed("challenge");
    },
    async complete(_request) {
      return closed("complete");
    },
  };
  // Frozen: a consumer must not be able to replace `require` with a function
  // that answers null, which would erase the requirement at the object level.
  return Object.freeze(assurance);
}
