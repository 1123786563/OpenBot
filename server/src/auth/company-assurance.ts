/*
 * Company assurance — the additional company-authentication proof of design
 * §9.1 and interfaces §5 (T02.10 / #532, original task P04).
 *
 * This file owns the FROZEN CONTRACT and, for now, one deliberately closed
 * implementation of it:
 *
 * - `CompanyAssurance.require(tx, identity, tenantId)` is the read-gate half a
 *   company-scoped business transaction calls. Since T05.04 / #560 it is LIVE
 *   in {@link createCompanyAssurance}: the data-role transaction's own
 *   controlled reads answer it (stored policy, active proof, live identity
 *   and company generations), a company with no stored policy answers `null`,
 *   and everything else is the controlled 403 COMPANY_REAUTH_REQUIRED — there
 *   is no "proof would have been nice" middle state, no optional dependency
 *   that skips the question, and no break-glass exception without an
 *   explicitly configured one (a consumer that forgets to inject the policy
 *   fails at construction, not at the first sensitive read).
 * - `challenge` and `complete` are the interactive halves. `challenge` is
 *   live since T05.01 / #557 and `complete` since T05.02 / #558, both
 *   through {@link createCompanyAssurance}: a signed-in session actor asking
 *   for a company whose stored challenge policy demands one gets a one-time,
 *   session-bound challenge row (max 600 seconds, written only by the 0218
 *   SECURITY DEFINER function) and the IdP redirect URL; the callback is
 *   verified by the assembled `SsoEvidenceBridge` (signature, issuer,
 *   audience, nonce, PKCE, one-time state consumption, signed auth_time/
 *   acr/amr) and completed under the tenant lock by the 0219 controlled
 *   functions — one-time consumption re-checked, original session/membership/
 *   policy re-verified, and the session-assurance proof written in the same
 *   transaction as the read gate's facts. The closed adapter keeps answering
 *   503 COMPANY_AUTH_NOT_READY for both halves when the live factory has not
 *   assembled the evidence bridge, so nothing changes for a deployment that
 *   has not wired it yet.
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

import { deflateRawSync } from "node:zlib";
import { sql as dsql } from "drizzle-orm";
import { encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type { DirectoryAuthority } from "./directory/authority";
import type {
  DirectoryActor,
  DirectoryTx,
  Version,
} from "./directory/contracts";
import {
  type SsoEvidenceBridge,
  type SsoOidcProviderSource,
  s256CodeChallenge,
} from "./sso-evidence";

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
 * The live factory (interfaces §5): `require` answers from the caller's own
 * transaction through the data role's controlled reads, `challenge` issues
 * real session-bound challenges through the 0218 controlled function, and
 * `complete` verifies the callback through the assembled evidence bridge and
 * writes the proof through 0219 — live when `evidence` is provided, the
 * closed 503 when not (an absent bridge must degrade loudly, never silently
 * accept a callback). The optional `sessions` port resolves the
 * rotation-final session the proof binds; absent, the challenge's own session
 * is the final one. Every other dependency is required — a missing policy or
 * redirect builder fails at construction, never at the first sensitive
 * request. (`policy` stays a required construction dependency: the demand
 * question itself is answered by the stored policy read inside `require`, and
 * the injected view is the construction-time guarantee the question cannot
 * silently disappear from an assembly.)
 */
export function createCompanyAssurance(deps: {
  readonly policy: CompanyProofPolicyView;
  readonly challengePolicy: CompanyAuthChallengePolicyView;
  readonly redirect: CompanyAuthRedirectBuilder;
  readonly database: Pick<Database, "transaction">;
  readonly authority: Pick<DirectoryAuthority, "read" | "requireWrite">;
  /** The deployment's AES-GCM key (base64, 32 bytes) for the secret envelope. */
  readonly encryptionKey: string;
  /**
   * The OIDC/SAML evidence bridge (T01.06/T01.07). Absent keeps `complete`
   * on the closed adapter's controlled 503 — an assembled-without-bridge
   * factory issues challenges it can never lawfully complete.
   */
  readonly evidence?: SsoEvidenceBridge;
  /**
   * Resolves the request's current live session — the rotation-FINAL session
   * a proof binds (§9.1 step 4). Absent binds the challenge's own session,
   * which is honest only where the deployment performs no session rotation.
   */
  readonly sessions?: {
    resolveCurrent(
      request: Request,
    ): Promise<{ userId: string; sessionId: string } | null>;
  };
  /** Injectable for tests; production uses the wall clock. */
  readonly clock?: () => Date;
}): CompanyAssurance {
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

  /** A `Version` a reader may compare: a non-negative safe integer, never a default. */
  function isSafeVersion(value: unknown): value is number {
    return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
  }

  /** A timestamp column the driver hands back as a Date or an ISO string. */
  function dateOf(value: unknown): Date {
    return value instanceof Date ? value : new Date(String(value));
  }

  /**
   * The read half (T05.04 / #560, interfaces §5): one data-role business
   * transaction's live answer. The stored policy row IS the demand — no row
   * is the only null — and a demanded company passes only on the user's
   * ACTIVE proof whose policy revision, identity generation and company
   * generation still compare live in THIS transaction, whose stored expiry
   * is still ahead, and (for a session actor) which is bound to the actor's
   * own session. The returned ref's expiry is the STORED value 0219 computed
   * as least(session expiry, signed auth time + max age) — never recomputed,
   * so a later session refresh never extends the authentication age. A
   * platform actor (the workspace gate's scope holder, no session id of its
   * own) is answered by the user's freshest active proof — the disclosed
   * boundary until the scope carries its private session association. There
   * is no break-glass path here: without an explicitly configured exception
   * (an assembly surface), a demanded company without a usable proof is
   * refused, every time.
   */
  async function require(
    tx: DirectoryTx,
    identity: DirectoryActor,
    tenantId: string,
  ): Promise<AssuranceRef | null> {
    if (typeof tenantId !== "string" || !tenantId.trim()) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_ASSURANCE_TARGET_REQUIRED,
        "require was called without naming a company; the proof question is per company and cannot be answered for none",
      );
    }
    // The demand question, from the data role's controlled policy read: no
    // row is the ONLY "no additional proof" answer there is.
    const [policyRow] = rowsOfExecuted(
      await tx.execute(dsql`
        SELECT provider_id, protocol, policy_revision, max_auth_age_seconds
          FROM public.auth_read_company_auth_policy(${tenantId})`),
    );
    if (!policyRow) return null;
    const protocol = policyRow.protocol;
    if (
      typeof policyRow.provider_id !== "string" ||
      !policyRow.provider_id ||
      (protocol !== "oidc" && protocol !== "saml") ||
      !isSafeVersion(Number(policyRow.policy_revision)) ||
      !Number.isSafeInteger(Number(policyRow.max_auth_age_seconds)) ||
      Number(policyRow.max_auth_age_seconds) <= 0
    ) {
      throw new CompanyAssuranceRefusal(
        503,
        COMPANY_AUTH_NOT_READY,
        `company ${tenantId}'s stored proof policy is malformed: refusing to answer the proof question against an unnameable provider, protocol or window`,
      );
    }
    const policyRevision = Number(policyRow.policy_revision);
    const userId = identity?.userId;
    if (typeof userId !== "string" || !userId) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `company ${tenantId} requires an additional company proof and this actor carries no user a proof could belong to`,
      );
    }
    // The active proofs first, through the data role's controlled read (only
    // status='active' rows with no revocation time ever come back). The row
    // also names the principal the live generation reads key off — the data
    // role cannot list principals, by RLS design, so the proof hands the
    // question its own subject.
    const proofs = rowsOfExecuted(
      await tx.execute(dsql`
        SELECT assurance_id, principal_id, session_id, expires_at,
               policy_revision::text AS policy_revision,
               identity_generation::text AS identity_generation,
               company_generation::text AS company_generation
          FROM public.auth_read_session_assurances(${tenantId}, ${userId})`),
    );
    if (!proofs.some((proof) => proof.assurance_id)) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `company ${tenantId} requires an additional company proof and no active proof exists for this user — a linked identity provider account is not one`,
      );
    }
    const principalId = String(proofs[0]?.principal_id ?? "");
    if (!principalId) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `the stored proofs behind user ${userId} in company ${tenantId} name no principal; the live generations cannot be read to compare`,
      );
    }
    // The RLS gate the data role's principal read answers to: transaction-
    // local identity settings, exactly the ones every gate sets before its
    // own data-role reads. The proof's principal IS the user's principal, so
    // this only names what the caller's transaction already scopes to.
    await tx.execute(
      dsql`select set_config('app.user_id', ${userId}, true), set_config('app.principal_id', ${principalId}, true)`,
    );
    // The live identity generation the proof must still match.
    const [principal] = rowsOfExecuted(
      await tx.execute(dsql`
        SELECT identity_generation::text AS identity_generation
          FROM enterprise_principals WHERE id = ${principalId} LIMIT 1`),
    );
    if (!principal || !isSafeVersion(Number(principal.identity_generation))) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `user ${userId} has no principal with a comparable identity generation in company ${tenantId}; a proof cannot be compared against a missing version`,
      );
    }
    const identityGeneration = Number(principal.identity_generation);
    // The live company generation, through the data role's controlled clock
    // read (the same one the workspace gate stamps its scope from).
    const clocks = rowsOfExecuted(
      await tx.execute(dsql`
        SELECT kind, scope_id, generation::text AS generation, tombstone
          FROM public.auth_read_eligibility_clocks(${tenantId}, ${principalId})`),
    );
    const companyClock = clocks.find(
      (row) => row.kind === "company" && row.scope_id === tenantId,
    );
    if (
      !companyClock ||
      companyClock.tombstone === true ||
      !isSafeVersion(Number(companyClock.generation))
    ) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `the company clock behind user ${userId} in company ${tenantId} is missing, tombstoned or incomparable; the company generation a proof must match cannot be read`,
      );
    }
    const companyGeneration = Number(companyClock.generation);
    const now = clock();
    const sessionBound =
      identity.kind === "session" &&
      typeof identity.sessionId === "string" &&
      identity.sessionId
        ? identity.sessionId
        : null;
    let reason = "no active proof exists for this user and company";
    const usable = proofs
      .filter((proof) => {
        if (!proof.assurance_id) return false;
        if (Number(proof.policy_revision) !== policyRevision) {
          reason = `the stored proof's policy revision ${String(proof.policy_revision)} no longer matches the company's ${policyRevision}`;
          return false;
        }
        if (Number(proof.identity_generation) !== identityGeneration) {
          reason = `the identity generation changed since the proof was issued (${String(proof.identity_generation)} → ${identityGeneration})`;
          return false;
        }
        if (Number(proof.company_generation) !== companyGeneration) {
          reason = `the company generation changed since the proof was issued (${String(proof.company_generation)} → ${companyGeneration})`;
          return false;
        }
        const expiresAt = dateOf(proof.expires_at);
        if (!(expiresAt.getTime() > now.getTime())) {
          reason =
            "the proof's stored expiry (least of session expiry and the signed authentication time plus the policy's max age) has passed";
          return false;
        }
        if (
          sessionBound !== null &&
          String(proof.session_id ?? "") !== sessionBound
        ) {
          reason = `the proof is bound to session ${String(proof.session_id)}, not this one — only the session a verified callback completed for holds it`;
          return false;
        }
        return true;
      })
      // A platform actor may hold several active proofs (one per session);
      // the freshest expiry is the deterministic answer.
      .sort(
        (left, right) =>
          dateOf(right.expires_at).getTime() -
          dateOf(left.expires_at).getTime(),
      );
    const [proof] = usable;
    if (!proof) {
      throw new CompanyAssuranceRefusal(
        403,
        COMPANY_REAUTH_REQUIRED,
        `company ${tenantId} requires an additional company proof and none is usable (${reason}); complete the company authentication and retry`,
      );
    }
    return Object.freeze({
      assuranceId: String(proof.assurance_id),
      sessionId: String(proof.session_id),
      tenantId,
      policyRevision,
      identityGeneration,
      companyGeneration,
      expiresAt: dateOf(proof.expires_at).toISOString(),
    });
  }

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

  /**
   * The completion half (T05.02 / #558): the bridge consumes the challenge
   * one-time and verifies every protocol fact OUTSIDE any lock (an IdP
   * round trip never waits inside one), then the tenant lock re-verifies
   * the original session, membership and live policy and writes the proof
   * in the same transaction as that re-verification. A failed re-verification
   * leaves the challenge consumed and no proof written — fail-closed, and
   * the flow restarts with a fresh challenge.
   */
  async function complete(
    request: Request,
  ): Promise<{ sessionId: string; tenantId: string; returnPath: string }> {
    const evidence = deps.evidence;
    if (!evidence || typeof evidence.verify !== "function") {
      throw new CompanyAssuranceRefusal(
        503,
        COMPANY_AUTH_NOT_READY,
        "complete is not wired in this deployment: callback verification belongs to the evidence bridge, and no bridge was assembled, so no callback is accepted",
      );
    }
    // Protocol verification + at-most-once consumption, no lock held.
    const verified = await evidence.verify(request);

    // §9.1 step 4: bind the rotation-FINAL live session when the deployment
    // can name it; without the port, the challenge's own session is final.
    let finalSessionId: string | null = null;
    if (deps.sessions?.resolveCurrent) {
      const current = await deps.sessions.resolveCurrent(request);
      if (!current?.sessionId) {
        throw new CompanyAssuranceRefusal(
          401,
          COMPANY_AUTH_SESSION_EXPIRED,
          "the callback arrived with no live session to bind: a proof only ever binds the challenge's final live session, so the additional authentication must be restarted",
        );
      }
      finalSessionId = current.sessionId;
    }

    try {
      return await deps.database.transaction(async (tx) => {
        // The same authority gate every directory writer passes: legacy and
        // paused deployments never complete (T02.10's matrix, this surface
        // included).
        const authorityState = await deps.authority.read(tx);
        await deps.authority.requireWrite(
          tx,
          authorityState.authorityVersion,
          "ba",
        );
        const result = await tx.execute(dsql`
          SELECT assurance_id, session_id, tenant_id, return_path
            FROM public.auth_record_company_session_assurance(
              ${verified.challengeId}, ${`csa_${randomHex(16)}`},
              ${finalSessionId}, ${verified.issuer}, ${verified.subject},
              ${verified.authenticatedAt.toISOString()}::timestamptz,
              ${verified.strength})`);
        const [row] = rowsOfExecuted(result);
        if (!row?.assurance_id) {
          throw new Error("AUTH_COMPLETE_RECORD_EMPTY");
        }
        return {
          sessionId: String(row.session_id),
          tenantId: String(row.tenant_id),
          returnPath: String(row.return_path),
        };
      });
    } catch (error) {
      throw mapCompletionDatabaseError(error);
    }
  }

  const assurance: CompanyAssurance = {
    require,
    challenge,
    complete,
  };
  return Object.freeze(assurance);
}

/**
 * The named refusal behind a failed completion, mapped without leaking which
 * company fact failed: session problems are one 401, and every "no proof for
 * you — restart the additional authentication" answer (unknown/consumed/
 * expired challenge, policy changed, membership or identity binding gone,
 * generations missing, replay conflict) is the one 403
 * COMPANY_REAUTH_REQUIRED. Anything the function raised that is not one of
 * its markers is a real fault and propagates untouched.
 */
function mapCompletionDatabaseError(error: unknown): unknown {
  const MAPPINGS: readonly (readonly [RegExp, 401 | 403 | 503, string])[] = [
    [/^AUTH_COMPLETE_SESSION_UNKNOWN/, 401, COMPANY_AUTH_SESSION_EXPIRED],
    [/^AUTH_COMPLETE_SESSION_MISMATCH/, 401, COMPANY_AUTH_SESSION_EXPIRED],
    [/^AUTH_COMPLETE_CHALLENGE_UNKNOWN/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_CHALLENGE_NOT_CONSUMED/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_CHALLENGE_EXPIRED/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_POLICY_UNKNOWN/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_POLICY_MISMATCH/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_NOT_A_MEMBER/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_IDENTITY_UNKNOWN/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_NO_PRINCIPAL/, 403, COMPANY_REAUTH_REQUIRED],
    [
      /^AUTH_COMPLETE_IDENTITY_GENERATION_MISSING/,
      403,
      COMPANY_REAUTH_REQUIRED,
    ],
    [/^AUTH_COMPLETE_COMPANY_GENERATION_MISSING/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_PROOF_CONFLICT/, 403, COMPANY_REAUTH_REQUIRED],
    [/^AUTH_COMPLETE_WRITER_ROLE_REQUIRED/, 503, COMPANY_AUTH_NOT_READY],
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
          `the callback completion was refused (${message.slice(0, 120)})`,
        );
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

/*
 * The stored policy model (T05.02 / #558): the production views behind the
 * T05.01 frozen ports, reading the 0219 policy table through its controlled
 * read. One row per company, at most; no row means the company runs no
 * additional challenge and the read gate answers `null`.
 */

/** One stored company policy row, as the views return it. */
export type StoredCompanyAuthPolicy = Readonly<{
  providerId: string;
  protocol: "oidc" | "saml";
  policyRevision: number;
  maxAuthAgeSeconds: number;
}>;

/**
 * The stored policy views: `challenge` answers the T05.01 issuance port,
 * `proof` answers the read gate's port (a stored policy row IS the demand
 * for an additional proof — an assembly replaces app.ts's no-policy default
 * with this view). Both fail closed: a malformed stored row is a 503, never
 * a silent "no policy".
 */
export function createStoredCompanyAuthPolicyViews(deps: {
  /** Any pool EXECUTE-granted on the 0219 policy read. */
  readonly database: Pick<Database, "execute">;
}): {
  readonly proof: CompanyProofPolicyView;
  readonly challenge: CompanyAuthChallengePolicyView;
} {
  if (!deps || typeof deps.database?.execute !== "function") {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_ASSURANCE_POLICY_REQUIRED,
      "createStoredCompanyAuthPolicyViews needs its database: without the policy read no company's challenge demand can be answered honestly",
    );
  }

  const storedPolicy = async (
    tenantId: string,
  ): Promise<StoredCompanyAuthPolicy | null> => {
    if (typeof tenantId !== "string" || !tenantId) {
      throw new CompanyAssuranceRefusal(
        400,
        COMPANY_ASSURANCE_TARGET_REQUIRED,
        "the policy question is per company and cannot be answered for none",
      );
    }
    const result = await deps.database.execute(dsql`
      SELECT provider_id, protocol, policy_revision, max_auth_age_seconds
        FROM public.auth_read_company_auth_policy(${tenantId})`);
    const [row] = rowsOfExecuted(result);
    if (!row) return null;
    const protocol = row.protocol;
    if (
      typeof row.provider_id !== "string" ||
      !row.provider_id ||
      (protocol !== "oidc" && protocol !== "saml") ||
      !Number.isSafeInteger(Number(row.policy_revision)) ||
      Number(row.policy_revision) < 0 ||
      !Number.isSafeInteger(Number(row.max_auth_age_seconds)) ||
      Number(row.max_auth_age_seconds) <= 0
    ) {
      throw new CompanyAssuranceRefusal(
        503,
        COMPANY_AUTH_NOT_READY,
        `company ${tenantId}'s stored challenge policy is malformed: refusing to issue or complete against an unnameable provider, protocol or window`,
      );
    }
    return {
      providerId: row.provider_id,
      protocol,
      policyRevision: Number(row.policy_revision),
      maxAuthAgeSeconds: Number(row.max_auth_age_seconds),
    };
  };

  return {
    proof: {
      async requiresProof(tenantId) {
        return (await storedPolicy(tenantId)) !== null;
      },
    },
    challenge: {
      async challengePolicy(tenantId) {
        const policy = await storedPolicy(tenantId);
        return policy === null
          ? null
          : {
              providerId: policy.providerId,
              protocol: policy.protocol,
              policyRevision: policy.policyRevision,
            };
      },
    },
  };
}

/**
 * The production redirect builder (the T05.01 frozen port): turns one
 * challenge's correlation material into the registered provider's
 * authorization URL. `null` means this deployment cannot send the user to
 * that provider — the challenge refuses 503 before any row is written.
 */
export function createOidcRedirectBuilder(deps: {
  readonly providers: SsoOidcProviderSource;
}): CompanyAuthRedirectBuilder {
  if (!deps || typeof deps.providers?.authorization !== "function") {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_ASSURANCE_POLICY_REQUIRED,
      "createOidcRedirectBuilder needs its provider source: a builder that cannot name the IdP must refuse before anything is persisted",
    );
  }
  return {
    async buildRedirect(request) {
      if (request.protocol !== "oidc") return null;
      const authorization = await deps.providers.authorization(
        request.providerId,
      );
      if (!authorization) return null;
      const url = new URL(authorization.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", authorization.clientId);
      url.searchParams.set("redirect_uri", authorization.redirectUri);
      url.searchParams.set("scope", authorization.scopes);
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
  };
}

/*
 * The SAML half of the redirect builder (T05.03 / #559): SP-initiated SSO
 * over the HTTP-Redirect binding. The AuthnRequest names the challenge's
 * persisted `protocolRequestId` as its ID and this SP's entity ID and ACS URL
 * (the registered facts the signed assertion will be held to), is
 * raw-DEFLATE-compressed and base64'd into the `SAMLRequest` query parameter,
 * and the challenge's one-time `state` rides as `RelayState` — the two
 * correlation tokens the evidence bridge re-binds at the ACS.
 *
 * The AuthnRequest itself is unsigned: nothing in the challenge model stores
 * an SP signing key, and the evidence never trusts the request — only the
 * signed response, bound by RelayState/InResponseTo to the persisted
 * challenge. An IdP policy demanding signed AuthnRequests is a deployment
 * fact this surface cannot meet yet (the challenge refuses 503 before any
 * row is written when the registration is unusable), not a silent fallback.
 */
function escapeSamlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

function escapeSamlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function createSamlRedirectBuilder(deps: {
  readonly providers: SsoOidcProviderSource;
}): CompanyAuthRedirectBuilder {
  if (!deps || typeof deps.providers?.samlAuthorization !== "function") {
    throw new CompanyAssuranceRefusal(
      503,
      COMPANY_ASSURANCE_POLICY_REQUIRED,
      "createSamlRedirectBuilder needs its provider source: a builder that cannot name the IdP must refuse before anything is persisted",
    );
  }
  return {
    async buildRedirect(request) {
      if (request.protocol !== "saml") return null;
      const authorization = await deps.providers.samlAuthorization(
        request.providerId,
      );
      if (!authorization) return null;
      const authnRequest =
        `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="${escapeSamlAttribute(request.protocolRequestId)}" Version="2.0"` +
        ` IssueInstant="${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}"` +
        ` Destination="${escapeSamlAttribute(authorization.entryPoint)}"` +
        ` AssertionConsumerServiceURL="${escapeSamlAttribute(authorization.acsUrl)}"` +
        ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
        `<saml:Issuer>${escapeSamlText(authorization.spEntityId)}</saml:Issuer>` +
        `</samlp:AuthnRequest>`;
      const url = new URL(authorization.entryPoint);
      url.searchParams.set(
        "SAMLRequest",
        deflateRawSync(authnRequest).toString("base64"),
      );
      url.searchParams.set("RelayState", request.state);
      return url.toString();
    },
  };
}
