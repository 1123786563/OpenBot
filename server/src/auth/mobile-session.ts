import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { ValidatedSelection } from "@openbot/shared/auth-directory";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  accounts,
  authMembers,
  authMobileHandoffCodes,
  authMobileSessionAdmissions,
  authMobileSessionHandles,
  authOrganizations,
  authTeamBindings,
  authTeamMembers,
  authTeams,
  billingCompanyFinanceGrants,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  sessions,
  users,
} from "../db/schema";
import type { AssuranceRef, CompanyAssurance } from "./company-assurance";
import {
  COMPANY_REAUTH_REQUIRED,
  isCompanyAssuranceRefusal,
} from "./company-assurance";
import {
  createDirectoryAuthority,
  isAuthorityRefusal,
} from "./directory/authority";

/*
 * T05.12 (#568, original task P12; interfaces §5.2 / F2): the mobile
 * enterprise session handoff's decision half. The routes
 * (mobile-session-routes.ts) are thin; every fact this module answers is a
 * database fact read inside the exchange transaction, so a concurrent
 * sign-out, disable or second exchange is decided by the row locks, not by
 * whatever the caller claims.
 *
 * Three surfaces, all frozen by the interfaces excerpt:
 *
 *   authorize — the system browser's GET. Requires a live BA session, a
 *     registered client, that client's registered redirect and a PKCE S256
 *     challenge; mints a 120-second single-use code bound to all of them and
 *     answers a 303 to the registered redirect carrying only
 *     code/state/intentId — never the BA session token.
 *
 *   exchange — the registered BFF's POST, authenticated by the BFF service
 *     credential (constant-time digest compare). Inside one transaction on
 *     the code row's lock: replay, expiry, intent, client, redirect and
 *     PKCE are verified, then the ORIGINAL BA session is locked and
 *     re-verified live (alive, same user), the user's remote
 *     issuer/subject mapping (T05.09's accounts binding) and the principal's
 *     current identity generation are read, the opaque handle is minted
 *     (SHA-256 only at rest, at most 1800 seconds, capped by the session's
 *     own expiry) and the code is consumed — or nothing is.
 *
 * A wrong verifier, client, authority, account or a replay never issues a
 * handle and never consumes the code: the refusal rolls the transaction
 * back, leaving a pending code for nobody but its rightful owner.
 *
 *   admission — the registered BFF's POST /session/authorize (T05.13): one
 *     ACTION, not a reusable bearer. The BFF's service credential names the
 *     client; the opaque handle names the person; the caller may add only a
 *     requestId, a whitelisted operation, a stable selector and a resource
 *     id — any actor-shaped field of its own is refused before a lock is
 *     taken. Inside one transaction the handle's session, account, remote
 *     binding and identity generation are re-verified LIVE (nothing
 *     positive is ever cached across admissions), a selected company is
 *     re-checked against the same eligibility facts the scope lister reads
 *     and the T05.04 proof gate, and exactly one admission row — the
 *     (handle, requestId) fence — is written. The same requestId never
 *     admits twice.
 */

/** The one provider id the T05.09 remote-identity binding writes (organization-store.ts). */
const ORGANIZATION_PROVIDER = "organization";

/** The handle's fixed audience: the registered mobile BFF, nothing else. */
export const MOBILE_HANDLE_AUDIENCE = "openmuse-mobile-bff";

/** The code window and the handle ceiling, in seconds (interfaces §5.2). */
export const HANDOFF_CODE_WINDOW_SECONDS = 120;
export const HANDLE_LIFETIME_SECONDS = 1800;

/**
 * The admission surface's frozen operation whitelist (interfaces §5.2): the
 * operation words the registered BFF may ask an admission for, each saying
 * whether the action runs inside a selected company. A word outside the list
 * is never admissible; P17 wires the routes these words name.
 */
export const MOBILE_ADMISSIBLE_OPERATIONS: Readonly<
  Record<string, "none" | "company" | "team">
> = Object.freeze({
  // Account scope discovery can work before company onboarding.
  "scope.discover": "none",
  // Validate one explicit, fully versioned T03.02 company/team selection.
  "scope.validate": "team",
  "workspace.read": "team",
  "company.challenge": "company",
  "copilotkit.invoke": "team",
  "media.ticket": "team",
  "file.read": "team",
});

/** A registered mobile client, from deployment-controlled config only. */
export interface MobileHandoffClient {
  clientId: string;
  /** The one registered callback; the authorize redirect never points anywhere else. */
  redirectUri: string;
  /** The OpenBot authority origin handles name — config, never a request header. */
  authorityOrigin: string;
  /** The registered BFF service the exchange authenticates as. */
  bffServiceId: string;
  /** SHA-256 hex of the BFF service secret; the secret itself is never stored. */
  bffCredentialDigest: string;
}

/** Who the authorize route says is browsing: the app's real session reader. */
export interface MobileSessionIdentity {
  userId: string;
  sessionId: string;
}

export interface MobileAuthorizeInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface MobileExchangeInput {
  bffServiceId: string;
  bffServiceSecret: string;
  intentId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** The stable company/team selection an admission is asked to run inside. */
export interface MobileAdmissionSelector {
  tenantId: string;
  workspaceId?: string;
}

export interface MobileAdmissionInput {
  bffServiceId: string;
  bffServiceSecret: string;
  /** The opaque session handle the BFF holds; never a BA cookie or owner key. */
  handle: string;
  /** The one action this admission is for; never admits twice under a handle. */
  requestId: string;
  selector: MobileAdmissionSelector | null;
  operation: string;
  resourceId: string | null;
}

/**
 * The frozen per-action admission (interfaces §5.2): the actor is the
 * handle's verified fact — never the caller's — the scope echoes the
 * re-checked selection, the assurance is the T05.04 read gate's live answer,
 * and the admissionId is an opaque one-action fact, not a bearer: no token
 * key exists on this contract.
 */
export interface MobileAdmissionResponse {
  mode: "live";
  authMode: "enterprise";
  actor: Readonly<{
    userId: string;
    principalId: string | null;
    identityGeneration: number | null;
  }>;
  session: Readonly<{ sessionId: string; handleExpiresAt: string }>;
  scope:
    | Readonly<{ tenantId: string; workspaceId: null }>
    | ValidatedSelection
    | null;
  assurance: AssuranceRef | null;
  admissionId: string;
  operation: string;
  resourceId: string | null;
}

/** The frozen EnterpriseSessionResponse (interfaces §5.2); scope stays null until P17 discovers it. */
export interface EnterpriseSessionResponse {
  token: string;
  mode: "live";
  authMode: "enterprise";
  authority: string;
  expiresAt: string;
  user: Readonly<{ id: string; principalId: string | null }>;
  scope: null;
}

/** The closed refusal set; the route maps each to its wire shape. */
export type MobileSessionRefusalCode =
  | "CLIENT_UNREGISTERED"
  | "REDIRECT_UNREGISTERED"
  | "PKCE_METHOD_UNSUPPORTED"
  | "INVALID_REQUEST"
  | "BFF_CREDENTIAL_REQUIRED"
  | "BFF_CREDENTIAL_INVALID"
  | "CODE_UNKNOWN"
  | "CODE_EXPIRED"
  | "CODE_REPLAYED"
  | "INTENT_MISMATCH"
  | "CLIENT_MISMATCH"
  | "PKCE_VERIFICATION_FAILED"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "ACCOUNT_CHANGED"
  | "IDENTITY_DISABLED"
  | "SCOPE_REQUIRED"
  | "SCOPE_SELECTOR_CONFLICT"
  | "CLIENT_ASSERTED_ACTOR"
  | "ADMISSION_REUSED"
  | "COMPANY_REAUTH_REQUIRED"
  | "RESOURCE_NOT_FOUND"
  | "AUTHORITY_UNAVAILABLE";

const REFUSAL_STATUS: Record<
  MobileSessionRefusalCode,
  400 | 401 | 403 | 404 | 503
> = {
  CLIENT_UNREGISTERED: 400,
  REDIRECT_UNREGISTERED: 400,
  PKCE_METHOD_UNSUPPORTED: 400,
  INVALID_REQUEST: 400,
  BFF_CREDENTIAL_REQUIRED: 401,
  BFF_CREDENTIAL_INVALID: 401,
  CODE_UNKNOWN: 400,
  CODE_EXPIRED: 400,
  CODE_REPLAYED: 400,
  INTENT_MISMATCH: 400,
  CLIENT_MISMATCH: 400,
  PKCE_VERIFICATION_FAILED: 400,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  ACCOUNT_CHANGED: 401,
  SCOPE_REQUIRED: 400,
  SCOPE_SELECTOR_CONFLICT: 400,
  CLIENT_ASSERTED_ACTOR: 403,
  ADMISSION_REUSED: 403,
  COMPANY_REAUTH_REQUIRED: 403,
  IDENTITY_DISABLED: 403,
  RESOURCE_NOT_FOUND: 404,
  AUTHORITY_UNAVAILABLE: 503,
};

export class MobileSessionRefusal extends Error {
  readonly code: MobileSessionRefusalCode;
  readonly status: 400 | 401 | 403 | 404 | 503;
  constructor(code: MobileSessionRefusalCode) {
    super(code);
    this.code = code;
    this.status = REFUSAL_STATUS[code];
  }
}

export function isMobileSessionRefusal(
  error: unknown,
): error is MobileSessionRefusal {
  return error instanceof MobileSessionRefusal;
}

// A function declaration (not a const arrow) so TypeScript's control-flow
// analysis knows a refusal site ends the path.
function refuse(code: MobileSessionRefusalCode): never {
  throw new MobileSessionRefusal(code);
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** PKCE S256: the challenge is the unpadded base64url SHA-256 of the verifier. */
function pkceChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface MobileSessionHandoff {
  authorize(
    identity: MobileSessionIdentity,
    input: MobileAuthorizeInput,
  ): Promise<{ redirectLocation: string }>;
  exchange(input: MobileExchangeInput): Promise<EnterpriseSessionResponse>;
  admission(input: MobileAdmissionInput): Promise<MobileAdmissionResponse>;
}

export function createMobileSessionHandoff(deps: {
  database: Database;
  clients: ReadonlyArray<MobileHandoffClient>;
  assurance?: CompanyAssurance;
}): MobileSessionHandoff {
  const { database, clients, assurance } = deps;
  const authority = createDirectoryAuthority();

  const clientByClientId = new Map(
    clients.map((client) => [client.clientId, client] as const),
  );

  return {
    async authorize(identity, input) {
      const client = clientByClientId.get(input.clientId);
      if (!client) refuse("CLIENT_UNREGISTERED");
      if (input.redirectUri !== client.redirectUri)
        refuse("REDIRECT_UNREGISTERED");
      if (input.codeChallengeMethod !== "S256")
        refuse("PKCE_METHOD_UNSUPPORTED");
      // S256 challenges are exactly 43 unpadded base64url characters; a
      // `plain` challenge can never satisfy the shape either.
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
        input.state.length === 0 ||
        input.state.length > 2048
      ) {
        refuse("INVALID_REQUEST");
      }

      const code = randomBytes(32).toString("base64url");
      const intentId = randomUUID();
      await database.insert(authMobileHandoffCodes).values({
        codeDigest: sha256Hex(code),
        intentId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        codeChallenge: input.codeChallenge,
        authorityOrigin: client.authorityOrigin,
        // The database clock owns the window, so a skewed caller cannot mint
        // a longer-lived code.
        expiresAt: sql`now() + interval '${sql.raw(String(HANDOFF_CODE_WINDOW_SECONDS))} seconds'`,
      });

      const separator = client.redirectUri.includes("?") ? "&" : "?";
      const location = new URL(
        `${client.redirectUri}${separator}code=${encodeURIComponent(code)}&state=${encodeURIComponent(input.state)}&intentId=${encodeURIComponent(intentId)}`,
      );
      return { redirectLocation: location.href };
    },

    async exchange(input) {
      // Service authentication first: only the registered BFF, only by the
      // credential the deployment pinned, compared as digests in constant time.
      const client = clients.find(
        (candidate) => candidate.bffServiceId === input.bffServiceId,
      );
      const offered = Buffer.from(sha256Hex(input.bffServiceSecret), "hex");
      const pinned = Buffer.from(client?.bffCredentialDigest ?? "", "hex");
      if (
        !client ||
        offered.length !== pinned.length ||
        !timingSafeEqual(offered, pinned)
      ) {
        refuse("BFF_CREDENTIAL_INVALID");
      }
      // RFC 7636 verifier length; the charset check keeps the S256 math honest.
      if (
        input.codeVerifier.length < 43 ||
        input.codeVerifier.length > 128 ||
        !BASE64URL.test(input.codeVerifier) ||
        input.intentId.length === 0 ||
        input.intentId.length > 128
      ) {
        refuse("INVALID_REQUEST");
      }
      const codeDigest = sha256Hex(input.code);

      return database.transaction(async (tx) => {
        const [code] = await tx
          .select()
          .from(authMobileHandoffCodes)
          .where(eq(authMobileHandoffCodes.codeDigest, codeDigest))
          .for("update");
        if (!code) refuse("CODE_UNKNOWN");
        if (code.consumedAt) refuse("CODE_REPLAYED");

        // The database clock decides the window, not this process.
        const [clockRow] = await tx.execute<{ now: Date }>(
          sql`select now() as now`,
        );
        if (!clockRow) throw new Error("the database clock is unavailable");
        const now = new Date(clockRow.now);
        if (code.expiresAt.getTime() <= now.getTime()) refuse("CODE_EXPIRED");

        // Every binding the code carries must still be the one this exchange
        // presents; each mismatch refuses without consuming the code.
        if (code.intentId !== input.intentId) refuse("INTENT_MISMATCH");
        if (code.clientId !== client.clientId) refuse("CLIENT_MISMATCH");
        if (code.redirectUri !== input.redirectUri)
          refuse("REDIRECT_UNREGISTERED");
        if (
          !timingSafeEqual(
            Buffer.from(pkceChallengeOf(input.codeVerifier)),
            Buffer.from(code.codeChallenge),
          )
        ) {
          refuse("PKCE_VERIFICATION_FAILED");
        }

        // The ORIGINAL BA session, locked and re-verified live: expiry, revoke
        // or an account change between authorize and exchange ends here.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, code.sessionId))
          .for("update");
        if (
          !session ||
          session.userId !== code.userId ||
          session.expiresAt.getTime() <= now.getTime()
        ) {
          refuse("SESSION_EXPIRED");
        }
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, code.userId));
        if (!user) refuse("SESSION_EXPIRED");

        // The remote binding the session rode in on (T05.09): read fresh, in
        // the lock — a local-credential user simply has none.
        const [remoteBinding] = await tx
          .select({ issuer: accounts.issuer, subject: accounts.accountId })
          .from(accounts)
          .where(
            and(
              eq(accounts.providerId, ORGANIZATION_PROVIDER),
              eq(accounts.userId, code.userId),
            ),
          );
        const [principal] = await tx
          .select({
            id: enterprisePrincipals.id,
            status: enterprisePrincipals.status,
            identityGeneration: enterprisePrincipals.identityGeneration,
          })
          .from(enterprisePrincipals)
          .where(eq(enterprisePrincipals.userId, code.userId));
        // A globally disabled identity hands off nothing (the Global
        // Constraints: disable is the one company-independent kill).
        if (principal && principal.status !== "active")
          refuse("IDENTITY_DISABLED");

        const handle = randomBytes(32).toString("base64url");
        // The 1800-second ceiling, capped by the session's own expiry — the
        // handle never outlives the BA session it rode in on.
        const expiresAt = new Date(
          Math.min(
            now.getTime() + HANDLE_LIFETIME_SECONDS * 1000,
            session.expiresAt.getTime(),
          ),
        );
        await tx.insert(authMobileSessionHandles).values({
          handleDigest: sha256Hex(handle),
          codeDigest,
          userId: code.userId,
          sessionId: session.id,
          clientId: client.clientId,
          authorityOrigin: client.authorityOrigin,
          audience: MOBILE_HANDLE_AUDIENCE,
          principalId: principal?.id ?? null,
          issuer: remoteBinding?.issuer ?? null,
          subject: remoteBinding?.subject ?? null,
          identityGeneration: principal?.identityGeneration ?? null,
          expiresAt,
        });
        // The single-use arm: consume only a still-pending code. The row lock
        // already serializes racers onto this decision; the conditional WHERE
        // plus the handles' unique code_digest are the second and third fences.
        const consumed = await tx
          .update(authMobileHandoffCodes)
          .set({ consumedAt: sql`now()` })
          .where(
            and(
              eq(authMobileHandoffCodes.codeDigest, codeDigest),
              sql`${authMobileHandoffCodes.consumedAt} is null`,
            ),
          )
          .returning({ codeDigest: authMobileHandoffCodes.codeDigest });
        if (consumed.length !== 1) refuse("CODE_REPLAYED");

        return {
          token: handle,
          mode: "live" as const,
          authMode: "enterprise" as const,
          authority: client.authorityOrigin,
          expiresAt: expiresAt.toISOString(),
          user: { id: code.userId, principalId: principal?.id ?? null },
          scope: null,
        };
      });
    },

    async admission(input) {
      // Service authentication first, exactly as the exchange does: only the
      // registered BFF, only by the pinned credential, digests in constant
      // time. The matched client is re-checked against the handle below — a
      // registered BFF's credential still cannot act on another client's
      // handle, so a credential can never switch users.
      const client = clients.find(
        (candidate) => candidate.bffServiceId === input.bffServiceId,
      );
      const offered = Buffer.from(sha256Hex(input.bffServiceSecret), "hex");
      const pinned = Buffer.from(client?.bffCredentialDigest ?? "", "hex");
      if (
        !client ||
        offered.length !== pinned.length ||
        !timingSafeEqual(offered, pinned)
      ) {
        refuse("BFF_CREDENTIAL_INVALID");
      }
      // The frozen request shape: a whitelisted operation, and a selector
      // exactly where that operation's scope discipline expects one.
      if (
        input.requestId.length === 0 ||
        input.requestId.length > 256 ||
        input.operation.length === 0
      ) {
        refuse("INVALID_REQUEST");
      }
      // resourceId rides the admission row: bound like every other admitted field.
      if (input.resourceId !== null && input.resourceId.length > 512) {
        refuse("INVALID_REQUEST");
      }
      if (!Object.hasOwn(MOBILE_ADMISSIBLE_OPERATIONS, input.operation)) {
        refuse("INVALID_REQUEST");
      }
      const scopeType = MOBILE_ADMISSIBLE_OPERATIONS[input.operation];
      if (scopeType === "none" && input.selector) {
        refuse("SCOPE_SELECTOR_CONFLICT");
      }
      if (scopeType !== "none" && !input.selector) refuse("SCOPE_REQUIRED");
      if (
        scopeType === "team" &&
        (!input.selector?.workspaceId ||
          input.selector.workspaceId.length > 100)
      ) {
        refuse("SCOPE_REQUIRED");
      }
      if (
        input.selector &&
        (input.selector.tenantId.length === 0 ||
          input.selector.tenantId.length > 100 ||
          (input.selector.workspaceId !== undefined &&
            input.selector.workspaceId.length > 100))
      ) {
        refuse("INVALID_REQUEST");
      }
      const handleDigest = sha256Hex(input.handle);

      try {
        return await database.transaction(async (tx) => {
          // The handle, locked: every fact below is read against THIS row, in
          // one transaction, on every admission — nothing positive survives
          // between two authorizes (无正向缓存).
          const [handleRow] = await tx
            .select()
            .from(authMobileSessionHandles)
            .where(eq(authMobileSessionHandles.handleDigest, handleDigest))
            .for("update");
          // A dead or unknown handle is the uniform "no usable session": the
          // session's death cascades the handle away, so expired, revoked and
          // never-issued all answer the same word, with no side channel.
          if (!handleRow) refuse("SESSION_EXPIRED");
          if (handleRow.clientId !== client.clientId) {
            refuse("BFF_CREDENTIAL_INVALID");
          }
          const [clockRow] = await tx.execute<{ now: Date }>(
            sql`select now() as now`,
          );
          if (!clockRow) throw new Error("the database clock is unavailable");
          const now = new Date(clockRow.now);
          if (handleRow.expiresAt.getTime() <= now.getTime()) {
            refuse("SESSION_EXPIRED");
          }

          // The ORIGINAL BA session, locked and re-verified live: revoke,
          // expiry or an account change ends here, on this action.
          const [sessionRow] = await tx
            .select()
            .from(sessions)
            .where(eq(sessions.id, handleRow.sessionId))
            .for("update");
          // Defensive: the FK cascade normally removes the handle with the
          // session; a surviving handle over a missing session is still dead.
          if (!sessionRow) refuse("SESSION_REVOKED");
          if (sessionRow.userId !== handleRow.userId) refuse("ACCOUNT_CHANGED");
          if (sessionRow.expiresAt.getTime() <= now.getTime()) {
            refuse("SESSION_EXPIRED");
          }
          const [userRow] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, handleRow.userId));
          if (!userRow) refuse("SESSION_REVOKED");

          // The principal the handle pinned: alive, and still on the same
          // identity generation. A re-key or a suspension lands on the NEXT
          // operation, never on a cached decision.
          const [principalRow] = await tx
            .select({
              id: enterprisePrincipals.id,
              status: enterprisePrincipals.status,
              identityGeneration: enterprisePrincipals.identityGeneration,
            })
            .from(enterprisePrincipals)
            .where(eq(enterprisePrincipals.userId, handleRow.userId));
          if ((principalRow?.id ?? null) !== handleRow.principalId) {
            refuse("ACCOUNT_CHANGED");
          }
          if (principalRow && principalRow.status !== "active") {
            refuse("IDENTITY_DISABLED");
          }
          if (
            principalRow &&
            (!Number.isSafeInteger(principalRow.identityGeneration) ||
              handleRow.identityGeneration !== principalRow.identityGeneration)
          ) {
            refuse("ACCOUNT_CHANGED");
          }
          const principal = principalRow;
          // The remote binding the handle verified: still this user's, still
          // the same issuer/subject (the T05.09 mapping, read fresh).
          const [binding] = await tx
            .select({
              issuer: accounts.issuer,
              subject: accounts.accountId,
            })
            .from(accounts)
            .where(
              and(
                eq(accounts.providerId, ORGANIZATION_PROVIDER),
                eq(accounts.userId, handleRow.userId),
              ),
            );
          if (
            (binding?.issuer ?? null) !== handleRow.issuer ||
            (binding?.subject ?? null) !== handleRow.subject
          ) {
            refuse("ACCOUNT_CHANGED");
          }

          // The selected company: prove the current authority branch and the
          // same eligibility facts T03.02 reads, in THIS transaction. Hidden,
          // suspended or revoked membership is the uniform 404.
          let assuranceRef: AssuranceRef | null = null;
          let validatedScope: ValidatedSelection | null = null;
          const selector = input.selector;
          if (selector) {
            if (!principal) refuse("RESOURCE_NOT_FOUND");
            const state = await authority.read(tx).catch((error: unknown) => {
              if (isAuthorityRefusal(error)) refuse("AUTHORITY_UNAVAILABLE");
              throw error;
            });
            if (state.directoryAuthority !== "ba") {
              refuse("AUTHORITY_UNAVAILABLE");
            }
            const [company] = await tx
              .select({
                tenantStatus: enterpriseTenants.status,
                memberStatus: enterpriseMemberships.status,
                memberEpoch: enterpriseMemberships.epoch,
                projectionRole: enterpriseMemberships.role,
                baRole: authMembers.role,
              })
              .from(authMembers)
              .innerJoin(
                authOrganizations,
                eq(authOrganizations.id, authMembers.organizationId),
              )
              .innerJoin(
                enterpriseTenants,
                eq(enterpriseTenants.id, authOrganizations.id),
              )
              .innerJoin(
                enterpriseMemberships,
                and(
                  eq(enterpriseMemberships.tenantId, authOrganizations.id),
                  eq(enterpriseMemberships.principalId, principal.id),
                ),
              )
              .where(
                and(
                  eq(authMembers.organizationId, selector.tenantId),
                  eq(authMembers.userId, handleRow.userId),
                ),
              )
              .limit(1);
            if (
              company?.tenantStatus !== "active" ||
              company.memberStatus !== "active"
            ) {
              refuse("RESOURCE_NOT_FOUND");
            }

            if (selector.workspaceId) {
              const [team] = await tx
                .select({
                  teamId: authTeamBindings.teamId,
                  workspaceStatus: enterpriseWorkspaceMemberships.status,
                })
                .from(authTeamBindings)
                .innerJoin(
                  authTeams,
                  and(
                    eq(authTeams.id, authTeamBindings.teamId),
                    eq(authTeams.organizationId, authTeamBindings.tenantId),
                  ),
                )
                .innerJoin(
                  authTeamMembers,
                  and(
                    eq(authTeamMembers.teamId, authTeamBindings.teamId),
                    eq(authTeamMembers.userId, handleRow.userId),
                  ),
                )
                .innerJoin(
                  enterpriseWorkspaceMemberships,
                  and(
                    eq(
                      enterpriseWorkspaceMemberships.tenantId,
                      authTeamBindings.tenantId,
                    ),
                    eq(
                      enterpriseWorkspaceMemberships.workspaceId,
                      authTeamBindings.workspaceId,
                    ),
                    eq(
                      enterpriseWorkspaceMemberships.principalId,
                      principal.id,
                    ),
                  ),
                )
                .where(
                  and(
                    eq(authTeamBindings.tenantId, selector.tenantId),
                    eq(authTeamBindings.workspaceId, selector.workspaceId),
                    eq(enterpriseWorkspaceMemberships.status, "active"),
                  ),
                )
                .limit(1);
              if (!team) refuse("RESOURCE_NOT_FOUND");

              const rawClocks = await tx.execute<Record<string, unknown>>(
                sql`select kind, scope_id, epoch::text as epoch, generation::text as generation, tombstone
                    from public.auth_read_eligibility_clocks(${selector.tenantId}, ${principal.id})`,
              );
              const clockRows = Array.isArray(rawClocks)
                ? rawClocks
                : ((rawClocks as { rows?: Record<string, unknown>[] }).rows ??
                  []);
              const companyClock = clockRows.find(
                (row) =>
                  row.kind === "company" && row.scope_id === selector.tenantId,
              );
              const teamClock = clockRows.find(
                (row) =>
                  row.kind === "team" && row.scope_id === selector.workspaceId,
              );
              const companyEpoch = Number(companyClock?.epoch);
              const companyGeneration = Number(companyClock?.generation);
              const teamEpoch = Number(teamClock?.epoch);
              const teamGeneration = Number(teamClock?.generation);
              if (
                !companyClock ||
                companyClock.tombstone === true ||
                !teamClock ||
                teamClock.tombstone === true ||
                !Number.isSafeInteger(companyEpoch) ||
                companyEpoch <= 0 ||
                !Number.isSafeInteger(companyGeneration) ||
                companyGeneration < 0 ||
                !Number.isSafeInteger(teamEpoch) ||
                teamEpoch <= 0 ||
                !Number.isSafeInteger(teamGeneration) ||
                teamGeneration < 0
              ) {
                refuse("RESOURCE_NOT_FOUND");
              }
              const [financeGrant] = await tx
                .select({ tenantId: billingCompanyFinanceGrants.tenantId })
                .from(billingCompanyFinanceGrants)
                .where(
                  and(
                    eq(billingCompanyFinanceGrants.tenantId, selector.tenantId),
                    eq(billingCompanyFinanceGrants.principalId, principal.id),
                  ),
                )
                .limit(1);
              const capabilities: string[] = [];
              if (company.baRole === "owner" || company.baRole === "admin") {
                capabilities.push(
                  "company:manage",
                  "team:members:manage",
                  "audit:metadata:read",
                );
              } else if (
                company.baRole === "auditor" ||
                company.projectionRole === "auditor"
              ) {
                capabilities.push("audit:metadata:read");
              }
              if (financeGrant) capabilities.push("finance:read");
              validatedScope = Object.freeze({
                tenantId: selector.tenantId,
                workspaceId: selector.workspaceId,
                organizationId: selector.tenantId,
                teamId: team.teamId,
                memberEpoch: companyEpoch,
                workspaceMemberEpoch: teamEpoch,
                companyGeneration,
                teamGeneration,
                capabilities: Object.freeze(capabilities),
              });
            }

            if (!assurance) refuse("AUTHORITY_UNAVAILABLE");
            try {
              assuranceRef = await assurance.require(
                tx,
                {
                  userId: handleRow.userId,
                  principalId: handleRow.principalId,
                  sessionId: sessionRow.id,
                  kind: "session",
                  bindingId: null,
                  provisioning: null,
                },
                selector.tenantId,
              );
            } catch (error) {
              if (isCompanyAssuranceRefusal(error)) {
                if (
                  error.status === 403 &&
                  error.code === COMPANY_REAUTH_REQUIRED
                ) {
                  refuse("COMPANY_REAUTH_REQUIRED");
                }
                refuse("AUTHORITY_UNAVAILABLE");
              }
              throw error;
            }
          }

          // The one-action fence: exactly one admission per (handle,
          // requestId), written only after every fact above verified in this
          // same transaction. The unique constraint decides replays, whatever
          // raced; the stored id is a digest, like the handle's.
          const admissionId = randomUUID();
          const [admission] = await tx
            .insert(authMobileSessionAdmissions)
            .values({
              admissionDigest: sha256Hex(admissionId),
              handleDigest,
              requestId: input.requestId,
              operation: input.operation,
              resourceId: input.resourceId ?? null,
            })
            .onConflictDoNothing({
              target: [
                authMobileSessionAdmissions.handleDigest,
                authMobileSessionAdmissions.requestId,
              ],
            })
            .returning({
              admissionDigest: authMobileSessionAdmissions.admissionDigest,
            });
          if (!admission) refuse("ADMISSION_REUSED");

          return {
            mode: "live" as const,
            authMode: "enterprise" as const,
            actor: {
              userId: handleRow.userId,
              principalId: principal?.id ?? null,
              identityGeneration: principal?.identityGeneration ?? null,
            },
            session: {
              sessionId: sessionRow.id,
              handleExpiresAt: handleRow.expiresAt.toISOString(),
            },
            scope: input.selector
              ? (validatedScope ?? {
                  tenantId: input.selector.tenantId,
                  workspaceId: null,
                })
              : null,
            assurance: assuranceRef,
            admissionId,
            operation: input.operation,
            resourceId: input.resourceId ?? null,
          };
        });
      } catch (error) {
        if (isMobileSessionRefusal(error)) throw error;
        refuse("AUTHORITY_UNAVAILABLE");
      }
    },
  };
}
