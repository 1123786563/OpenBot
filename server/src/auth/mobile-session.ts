import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  accounts,
  authMobileHandoffCodes,
  authMobileSessionHandles,
  enterprisePrincipals,
  sessions,
  users,
} from "../db/schema";

/*
 * T05.12 (#568, original task P12; interfaces §5.2 / F2): the mobile
 * enterprise session handoff's decision half. The routes
 * (mobile-session-routes.ts) are thin; every fact this module answers is a
 * database fact read inside the exchange transaction, so a concurrent
 * sign-out, disable or second exchange is decided by the row locks, not by
 * whatever the caller claims.
 *
 * Two surfaces, both frozen by the interfaces excerpt:
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
 */

/** The one provider id the T05.09 remote-identity binding writes (organization-store.ts). */
const ORGANIZATION_PROVIDER = "organization";

/** The handle's fixed audience: the registered mobile BFF, nothing else. */
export const MOBILE_HANDLE_AUDIENCE = "openmuse-mobile-bff";

/** The code window and the handle ceiling, in seconds (interfaces §5.2). */
export const HANDOFF_CODE_WINDOW_SECONDS = 120;
export const HANDLE_LIFETIME_SECONDS = 1800;

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
  | "IDENTITY_DISABLED";

const REFUSAL_STATUS: Record<MobileSessionRefusalCode, 400 | 401 | 403> = {
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
  IDENTITY_DISABLED: 403,
};

export class MobileSessionRefusal extends Error {
  readonly code: MobileSessionRefusalCode;
  readonly status: 400 | 401 | 403;
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
}

export function createMobileSessionHandoff(deps: {
  database: Database;
  clients: ReadonlyArray<MobileHandoffClient>;
}): MobileSessionHandoff {
  const { database, clients } = deps;

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
          .set({ consumedAt: now })
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
  };
}
