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
 * - `challenge` and `complete` are the interactive halves. `complete` (the
 *   callback) is still closed — T05.02 owns callback verification — while
 *   `challenge` is live since T05.01 / #557 through
 *   {@link createCompanyAssurance}: a signed-in session actor asking for a
 *   company whose stored challenge policy demands one gets a one-time,
 *   session-bound challenge row (max 600 seconds, written only by the 0218
 *   SECURITY DEFINER function) and the IdP redirect URL. The closed adapter
 *   keeps answering 503 COMPANY_AUTH_NOT_READY for both halves, so nothing
 *   changes for a deployment that has not assembled the live factory yet.
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

import { sql as dsql } from "drizzle-orm";
import { encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type { DirectoryAuthority } from "./directory/authority";
import type {
  DirectoryActor,
  DirectoryTx,
  Version,
} from "./directory/contracts";
import { s256CodeChallenge } from "./sso-evidence";

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
/** The challenge request's returnPath left the site (or masqueraded as local). */
export const COMPANY_AUTH_RETURN_PATH_INVALID =
  "COMPANY_AUTH_RETURN_PATH_INVALID";
/** No usable session identity answered the challenge request. */
export const COMPANY_AUTH_AUTH_REQUIRED = "AUTH_REQUIRED";
/** The session the challenge is bound to is gone or belongs to someone else. */
export const COMPANY_AUTH_SESSION_EXPIRED = "SESSION_EXPIRED";
/**
 * The one not-found answer (MT011 canonical) for unknown company, a company
 * without a challenge policy, and a non-member: no side channel may name
 * which of the three facts failed.
 */
export const COMPANY_AUTH_TARGET_NOT_FOUND = "RESOURCE_NOT_FOUND";

/**
 * A company-assurance refusal. 403 is the "prove the company first" answer of
 * interfaces §4 (`COMPANY_REAUTH_REQUIRED`); 503 is the closed interactive
 * surface's answer; 400/401/404 are the live challenge's request-level
 * answers (bad returnPath, no usable session, uniform not-found). No code
 * path here returns a proof ref it did not verify.
 */
export class CompanyAssuranceRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 503,
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

/*
 * The live challenge half (T05.01 / #557): issue a one-time, session-bound
 * challenge row and hand back the IdP redirect. Callback verification and
 * completion stay with T05.02.
 */

/** design §9.1: a challenge lives at most 600 seconds. */
export const COMPANY_AUTH_CHALLENGE_MAX_AGE_SECONDS = 600;
/**
 * The issue-time guard band: `expires_at` is computed against this process's
 * clock but the row's CHECK compares it with the database's `created_at`, so
 * the stored value sits under the ceiling even across a small skew.
 */
const CHALLENGE_TTL_GUARD_MS = 250;

/** Which provider may answer the challenge, as the stored policy pins it. */
export type CompanyAuthChallengePolicy = Readonly<{
  providerId: string;
  protocol: "oidc" | "saml";
  policyRevision: Version;
}>;

/**
 * The stored challenge-policy answer for one company: `null` means the
 * company runs no additional challenge (and the request answers the uniform
 * 404 — a caller learns nothing about company existence from this surface).
 */
export interface CompanyAuthChallengePolicyView {
  challengePolicy(tenantId: string): Promise<CompanyAuthChallengePolicy | null>;
}

/** Everything the redirect builder needs to send the user to the IdP. */
export type CompanyAuthRedirectRequest = Readonly<{
  providerId: string;
  protocol: "oidc" | "saml";
  /** The correlation token. The row stores only its SHA-256 digest. */
  state: string;
  nonce: string;
  codeChallenge: string;
  protocolRequestId: string;
}>;

/**
 * Turns one challenge into the IdP's authorization URL. `null` means this
 * deployment cannot build one (no usable provider registration) and the
 * challenge refuses 503 before any row is written. Production builders live
 * with the provider registry (T05.02/T05.03).
 */
export interface CompanyAuthRedirectBuilder {
  buildRedirect(request: CompanyAuthRedirectRequest): Promise<string | null>;
}

/** A challenge row as the completion side (T05.02) will read it. */
export type ChallengeCompletableRecord = Readonly<{
  consumedAt: Date | null;
  expiresAt: Date;
}>;

/**
 * The one completeness fact, shared by issuance and completion: unclaimed
 * (never consumed) and not past its stored expiry. A consumed challenge is
 * never completable again, however fresh.
 */
export function isChallengeCompletable(
  record: ChallengeCompletableRecord,
  now: Date,
): boolean {
  return (
    record.consumedAt === null && record.expiresAt.getTime() > now.getTime()
  );
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "hex",
  );
}

function randomBase64url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

/** Iterative percent-decoding, so `%2f%2f` cannot smuggle a protocol-relative path. */
function assertSiteLocalReturnPath(returnPath: string): void {
  const hasControlCharacter = (value: string): boolean => {
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  };
  const isShapedLocal = (value: string): boolean =>
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !hasControlCharacter(value);
  let candidate = returnPath;
  for (let round = 0; round < 3; round += 1) {
    if (!isShapedLocal(candidate)) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      break; // A malformed escape stays literal; the shape checks above already ran.
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  if (typeof returnPath !== "string" || !isShapedLocal(candidate)) {
    throw new CompanyAssuranceRefusal(
      400,
      COMPANY_AUTH_RETURN_PATH_INVALID,
      "returnPath must be a site-local absolute path: external hosts, protocol-relative forms, backslashes, control characters and their encoded disguises are refused",
    );
  }
}

/**
 * The named refusal behind a failed issuance, mapped without leaking which
 * company fact failed: user/session problems are one 401, company problems
 * one 404. Anything the function raised that is not one of its markers is a
 * real fault and propagates untouched.
 */
function mapChallengeDatabaseError(error: unknown): unknown {
  const MAPPINGS: readonly (readonly [RegExp, 401 | 404 | 503, string])[] = [
    [/^AUTH_CHALLENGE_USER_UNKNOWN/, 401, COMPANY_AUTH_SESSION_EXPIRED],
    [/^AUTH_CHALLENGE_SESSION_UNKNOWN/, 401, COMPANY_AUTH_SESSION_EXPIRED],
    [/^AUTH_CHALLENGE_SESSION_MISMATCH/, 401, COMPANY_AUTH_SESSION_EXPIRED],
    [/^AUTH_CHALLENGE_COMPANY_UNKNOWN/, 404, COMPANY_AUTH_TARGET_NOT_FOUND],
    [/^AUTH_CHALLENGE_NOT_A_MEMBER/, 404, COMPANY_AUTH_TARGET_NOT_FOUND],
    [/^AUTH_CHALLENGE_EXPIRY_OUT_OF_RANGE/, 503, COMPANY_AUTH_NOT_READY],
    [/^AUTH_CHALLENGE_WRITER_ROLE_REQUIRED/, 503, COMPANY_AUTH_NOT_READY],
  ];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message =
      current instanceof Error ? current.message : String(current);
    for (const [marker, status, code] of MAPPINGS) {
      if (marker.test(message)) {
        return new CompanyAssuranceRefusal(
          status,
          code,
          `the challenge issuance was refused (${message.slice(0, 120)})`,
        );
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

function rowsOfExecuted(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/**
 * The live factory (interfaces §5): `require` keeps the closed gate's exact
 * semantics, `challenge` issues real session-bound challenges through the
 * 0218 controlled function, `complete` stays closed until T05.02 wires the
 * callback. Every dependency is required — a missing policy or redirect
 * builder fails at construction, never at the first sensitive request.
 */
export function createCompanyAssurance(deps: {
  readonly policy: CompanyProofPolicyView;
  readonly challengePolicy: CompanyAuthChallengePolicyView;
  readonly redirect: CompanyAuthRedirectBuilder;
  readonly database: Pick<Database, "transaction">;
  readonly authority: Pick<DirectoryAuthority, "read" | "requireWrite">;
  /** The deployment's AES-GCM key (base64, 32 bytes) for the secret envelope. */
  readonly encryptionKey: string;
  /** Injectable for tests; production uses the wall clock. */
  readonly clock?: () => Date;
}): CompanyAssurance {
  const closed = createClosedCompanyAssurance({ policy: deps?.policy });
  if (
    !deps ||
    typeof deps.challengePolicy?.challengePolicy !== "function" ||
    typeof deps.redirect?.buildRedirect !== "function" ||
    typeof deps.database?.transaction !== "function" ||
    typeof deps.authority?.read !== "function" ||
    typeof deps.authority?.requireWrite !== "function" ||
    typeof deps.encryptionKey !== "string" ||
    !deps.encryptionKey
  ) {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_ASSURANCE_POLICY_REQUIRED,
      "createCompanyAssurance needs its challenge-policy view, redirect builder, writer database, authority gate and encryption key: a missing dependency would let challenge issuance silently degrade",
    );
  }
  const clock = deps.clock ?? (() => new Date());

  async function challenge(
    identity: DirectoryActor,
    input: { tenantId: string; returnPath: string },
  ): Promise<{ challengeId: string; redirectUrl: string; expiresAt: string }> {
    // Only a real session actor holds a session to bind: the challenge's
    // whole point is that the SAME session later completes it (T05.02).
    if (
      identity?.kind !== "session" ||
      typeof identity.userId !== "string" ||
      !identity.userId ||
      typeof identity.sessionId !== "string" ||
      !identity.sessionId
    ) {
      throw new CompanyAssuranceRefusal(
        401,
        COMPANY_AUTH_AUTH_REQUIRED,
        "challenge requires a signed-in session: a challenge binds to the original user and session, and neither platform actors nor anonymous callers have one",
      );
    }
    if (typeof input?.tenantId !== "string" || !input.tenantId.trim()) {
      throw new CompanyAssuranceRefusal(
        400,
        COMPANY_ASSURANCE_TARGET_REQUIRED,
        "challenge was called without naming a company; the challenge question is per company and cannot be answered for none",
      );
    }
    assertSiteLocalReturnPath(input.returnPath);

    const policy = await deps.challengePolicy.challengePolicy(input.tenantId);
    // Uniform 404: unknown company, no challenge policy, and (in the lock)
    // non-membership all answer identically.
    if (policy === null || policy === undefined) {
      throw new CompanyAssuranceRefusal(
        404,
        COMPANY_AUTH_TARGET_NOT_FOUND,
        "no company with a challenge policy answers this request",
      );
    }
    if (
      typeof policy.providerId !== "string" ||
      !policy.providerId ||
      (policy.protocol !== "oidc" && policy.protocol !== "saml") ||
      !Number.isSafeInteger(policy.policyRevision) ||
      policy.policyRevision < 0
    ) {
      throw new CompanyAssuranceRefusal(
        503,
        COMPANY_AUTH_NOT_READY,
        "the company's stored challenge policy is malformed: refusing to issue against an unnameable provider or protocol",
      );
    }

    const now = clock();
    const challengeId = `cac_${randomHex(16)}`;
    const state = randomBase64url(32);
    const nonce = policy.protocol === "oidc" ? randomBase64url(32) : "";
    const codeVerifier = policy.protocol === "oidc" ? randomBase64url(48) : "";
    const protocolRequestId =
      policy.protocol === "oidc" ? challengeId : `_${randomHex(16)}`;
    const codeChallenge =
      policy.protocol === "oidc" ? await s256CodeChallenge(codeVerifier) : "";

    // The redirect comes first: a deployment that cannot send the user to
    // its IdP persists nothing.
    const redirectUrl = await deps.redirect.buildRedirect({
      providerId: policy.providerId,
      protocol: policy.protocol,
      state,
      nonce,
      codeChallenge,
      protocolRequestId,
    });
    if (!redirectUrl) {
      throw new CompanyAssuranceRefusal(
        503,
        COMPANY_AUTH_NOT_READY,
        `no redirect can be built for provider ${policy.providerId}: the challenge is refused and nothing is persisted`,
      );
    }

    const stateDigest = await sha256Hex(state);
    const secretEnvelope = await encryptSecret(
      deps.encryptionKey,
      JSON.stringify({ nonce, codeVerifier, protocolRequestId }),
    );
    const expiresAt = new Date(
      now.getTime() +
        COMPANY_AUTH_CHALLENGE_MAX_AGE_SECONDS * 1000 -
        CHALLENGE_TTL_GUARD_MS,
    );

    let issued: { challengeId: string; expiresAt: Date };
    try {
      issued = await deps.database.transaction(async (tx) => {
        // The same authority gate every directory writer passes: legacy and
        // paused deployments never issue (T02.10's matrix, this surface
        // included).
        const authorityState = await deps.authority.read(tx);
        await deps.authority.requireWrite(
          tx,
          authorityState.authorityVersion,
          "ba",
        );
        const result = await tx.execute(dsql`
          SELECT challenge_id, expires_at
            FROM public.auth_issue_company_auth_challenge(
              ${challengeId}, ${identity.userId}, ${identity.sessionId},
              ${input.tenantId}, ${policy.providerId}, ${policy.protocol},
              ${policy.policyRevision}, ${input.returnPath},
              ${stateDigest}, ${secretEnvelope}, ${expiresAt.toISOString()}::timestamptz)`);
        const [row] = rowsOfExecuted(result);
        if (!row?.challenge_id) {
          throw new Error("AUTH_CHALLENGE_ISSUE_EMPTY");
        }
        return {
          challengeId: String(row.challenge_id),
          expiresAt: new Date(row.expires_at as string),
        };
      });
    } catch (error) {
      throw mapChallengeDatabaseError(error);
    }
    return {
      challengeId: issued.challengeId,
      redirectUrl,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  const assurance: CompanyAssurance = {
    require: closed.require,
    challenge,
    complete: closed.complete,
  };
  return Object.freeze(assurance);
}
