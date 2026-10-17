import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  DEPLOYMENT_INITIATOR,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import { getLogger } from "../../../shared/logger";

/**
 * The billing protocol's own service identity (Bifrost #252, 06.1).
 *
 * Reserve, Status, Settle and Release move credits between accounts. The doors that move credits
 * get their own credential, and that credential gets its own kind in the vault: NOT a Bot service
 * credential, NOT a user session. The ticket's warning is the design's first line — the two
 * credentials both prove "some service is calling", but only this one may move credits, so a Bot
 * credential presented here must read as exactly what it is: a credential for a different door.
 * Separating the kinds makes the confusion unrepresentable in the vault rather than merely
 * checked against at the door.
 *
 * WHO THE CALLER IS. Exactly one identity per deployment holds this credential: the deployment's
 * Bifrost admission extension (07.1/07.2 mount and use it). The kind, provider and keyId below
 * are therefore constants, not per-caller data — `credentials_active_key_idx` keeps at most one
 * live row for them, which makes issue-and-rotate race-safe the way a Bot's credential is.
 *
 * WHAT AUTHENTICATION ANSWERS. Every failure — no header, a token that is not ours, a
 * well-shaped token that was never issued, a rotated-away secret, a deployment that never
 * issued one at all — is one uniform 401 that says nothing about accounts, balances or grants.
 * The refusal path never queries an account: there is no balance to leak because no account was
 * read. Which cause it was lives in exactly one place, the audit row (the same discipline
 * `/internal/routines/run` holds), so an operator can investigate while the wire stays
 * branch-proof.
 *
 * WHAT EVERY CALL LEAVES BEHIND. One audit row per protocol call, refused or not. A `called` row
 * binds the identity the credential proved with the request it came with — method and path, the
 * shape of the call and nothing of its contents. A `refused` row records that the boundary was
 * tried and held. A protocol call that leaves no row is a bug, whatever its outcome.
 */

/** The vault kind this module owns, and the only kind its code can produce. */
export const CREDIT_SERVICE_CREDENTIAL_KIND = "credit_service";
/** The trusted caller is the deployment's Bifrost gateway; the provider names it. */
export const CREDIT_SERVICE_CREDENTIAL_PROVIDER = "bifrost";
/** One billing identity per deployment; the keyId is fixed, so the vault holds one live row. */
export const CREDIT_SERVICE_CREDENTIAL_KEY_ID = "gateway";

/**
 * Recognisable on sight, so a leaked one can be found in a log or by a secret scanner — and
 * visibly NOT `obot_bsvc_`: a Bot credential and a billing credential must not even look alike.
 */
const SECRET_PREFIX = "obot_csvc_";

/** 32 random bytes, the same material the deployment's other secrets use. Nobody types this. */
const SECRET_BYTES = 32;

/**
 * Mint a billing protocol secret: `<prefix><base64url secret>`. There is one billing identity,
 * so unlike a Bot's token the secret carries no id — the vault key it verifies against is a
 * constant of this module, not something a caller gets to claim.
 */
export function mintCreditServiceSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

/**
 * Parse a presented secret into the part to verify, or null when the presentation is not even
 * shaped like one of ours. Null is not an answer a caller can show anyone: the authenticator
 * turns it into the same uniform failure as everything else. A Bot credential
 * (`obot_bsvc_…`) fails here first — the prefix is where the two doors differ.
 */
export function parseCreditServiceSecret(
  presented: unknown,
): { secret: string } | null {
  if (typeof presented !== "string" || !presented.startsWith(SECRET_PREFIX)) {
    return null;
  }
  const secret = presented.slice(SECRET_PREFIX.length);
  if (!secret) return null;
  return { secret };
}

/** The identity a verified credential proves — and nothing about users, accounts or credits. */
export type CreditServiceIdentity = {
  kind: typeof CREDIT_SERVICE_CREDENTIAL_KIND;
  provider: typeof CREDIT_SERVICE_CREDENTIAL_PROVIDER;
  keyId: typeof CREDIT_SERVICE_CREDENTIAL_KEY_ID;
};

/** The one identity this module can ever answer with. A constant, for the same reason the key is. */
const CREDIT_SERVICE_IDENTITY: CreditServiceIdentity = {
  kind: CREDIT_SERVICE_CREDENTIAL_KIND,
  provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
  keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
};

/**
 * How a refusal presents internally. Every cause maps to this class, so nothing upstream can
 * branch on which one it was; {@link CreditServiceNotConfiguredError} exists only so the audit
 * row can name the cause the response withholds.
 */
export class CreditServiceAuthFailureError extends Error {
  constructor(message = "Credit service authentication failed.") {
    super(message);
    this.name = "CreditServiceAuthFailureError";
  }
}

/**
 * No live billing credential is on file. To the caller this is indistinguishable from any other
 * refusal — a deployment that never issued a credential and a caller with a wrong secret both
 * get the same 401 — but the audit row says `unconfigured`, because "nobody can get in" and
 * "you specifically cannot get in" are different incidents for the operator reading the trail.
 */
export class CreditServiceNotConfiguredError extends CreditServiceAuthFailureError {
  constructor() {
    super("The credit service credential is not configured.");
    this.name = "CreditServiceNotConfiguredError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type CreditServiceAuthenticatorDependencies = {
  encryptionKey: string;
  /** The vault, able to find the live billing credential and read its ciphertext back. */
  credentialStore: CredentialStore & CredentialSecretReader;
};

export type CreditServiceAuthenticator = (
  presentedSecret: string,
) => Promise<CreditServiceIdentity>;

/**
 * Verify one presented secret against the deployment's live billing credential.
 *
 * Nothing is cached: every call re-reads the vault, so an issued credential works on the next
 * call and a rotated-away one dies on the next call. The comparison digests both sides to
 * equal-length buffers first, so the constant-time comparison never leaks how much of the
 * secret was right — the same order `bot-services/auth.ts` keeps, for the same reason.
 */
export function createCreditServiceAuthenticator(
  dependencies: CreditServiceAuthenticatorDependencies,
): CreditServiceAuthenticator {
  const { credentialStore } = dependencies;
  return async (presentedSecret) => {
    const parsed = parseCreditServiceSecret(presentedSecret);
    if (!parsed) throw new CreditServiceAuthFailureError();
    const live = await credentialStore.findLiveByKey({
      kind: CREDIT_SERVICE_CREDENTIAL_KIND,
      provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
      keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
    });
    if (!live) throw new CreditServiceNotConfiguredError();
    const stored = await credentialStore.readSecret(live.id);
    if (!stored || stored.revokedAt)
      throw new CreditServiceNotConfiguredError();
    const expected = await decryptSecret(
      dependencies.encryptionKey,
      stored.encryptedValue,
    );
    if (
      !timingSafeEqual(
        Buffer.from(sha256(presentedSecret)),
        Buffer.from(sha256(expected)),
      )
    ) {
      throw new CreditServiceAuthFailureError();
    }
    return CREDIT_SERVICE_IDENTITY;
  };
}

export type CreditServiceCredentialDependencies = {
  encryptionKey: string;
  credentialStore: CredentialStore;
  auditStore?: AuditStore;
};

export type IssuedCreditServiceCredential = {
  /** The plaintext, exactly once. It is in no audit row and no status read. */
  secret: string;
  credentialId: string;
  /** The secret's SHA-256 fingerprint, last four hex digits — identification, not recovery. */
  fingerprint: string;
};

/**
 * Mint and store the billing protocol's credential, or rotate the live one.
 *
 * First issue stores; every later call rotates: the previous secret is revoked and the new one
 * stored in the vault's one atomic write, so there is no committed moment at which two secrets
 * verify, and the old one is dead the moment this returns. The plaintext is returned exactly
 * once — the response that minted it is the only place it exists — which is what lets an
 * administrator carry it into the gateway's admission-extension configuration (07.1) without
 * any read path ever growing one.
 *
 * The lifecycle gets one audit row (`credential_issued`, `payload.rotated` saying which act it
 * was), beside the identity this minting makes callable: an access that can be granted with no
 * trail is a hole in exactly the record this ticket exists to write.
 */
export async function issueCreditServiceCredential(
  dependencies: CreditServiceCredentialDependencies,
): Promise<IssuedCreditServiceCredential> {
  const secret = mintCreditServiceSecret();
  const encryptedValue = await encryptSecret(
    dependencies.encryptionKey,
    secret,
  );
  const live = await dependencies.credentialStore.findLiveByKey({
    kind: CREDIT_SERVICE_CREDENTIAL_KIND,
    provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
    keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
  });
  const stored = live
    ? await dependencies.credentialStore.rotate({
        previousCredentialId: live.id,
        kind: CREDIT_SERVICE_CREDENTIAL_KIND,
        provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
        keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
        metadata: {},
        encryptedValue,
      })
    : await dependencies.credentialStore.create({
        kind: CREDIT_SERVICE_CREDENTIAL_KIND,
        provider: CREDIT_SERVICE_CREDENTIAL_PROVIDER,
        keyId: CREDIT_SERVICE_CREDENTIAL_KEY_ID,
        metadata: {},
        encryptedValue,
      });
  const fingerprint = sha256(secret).slice(-4);
  if (dependencies.auditStore) {
    await recordAuditEvent(dependencies.auditStore, {
      eventType: "credit_service.credential_issued",
      targetType: "credential",
      targetId: stored.id,
      initiator: DEPLOYMENT_INITIATOR,
      payload: { rotated: Boolean(live), fingerprint },
    });
  }
  return { secret, credentialId: stored.id, fingerprint };
}

/** The Variables the protocol routes read after the middleware has answered. */
export type CreditServiceVariables = AppVariables & {
  creditService: CreditServiceIdentity;
};

export type CreditServiceRouteDependencies = {
  authenticate: CreditServiceAuthenticator;
  auditStore?: AuditStore;
};

/** The one refusal body, byte-identical for every cause. The reason exists only in the trail. */
const UNIFORM_REFUSAL = {
  error: "Credit service authentication failed.",
  code: "credit_service_auth_failed",
} as const;

const log = getLogger("server");

/** The request shape a trail row records: which door, which way it was pushed. Nothing else. */
function requestShape(context: Context<{ Variables: CreditServiceVariables }>) {
  return { method: context.req.method, path: context.req.path };
}

async function recordRefusal(
  auditStore: AuditStore | undefined,
  reason: "missing-header" | "unconfigured" | "mismatch",
  shape: { method: string; path: string },
) {
  if (!auditStore) return;
  try {
    await recordAuditEvent(auditStore, {
      eventType: "credit_service.refused",
      targetType: "credit_protocol",
      initiator: DEPLOYMENT_INITIATOR,
      payload: {
        reason,
        method: shape.method,
        path: shape.path,
        note: "A billing protocol call was refused at service authentication.",
      },
    });
  } catch (error) {
    // Never fatal: the 401 is already decided. A trail that is briefly unavailable is not a
    // reason to turn a refusal into a 500, and never a reason to widen the response.
    log.error(
      { type: "credit-service-auth-audit-write-failed", error: String(error) },
      "credit-service-auth-audit-write-failed",
    );
  }
}

/**
 * Guard every billing protocol route with the deployment's service authentication.
 *
 * The credential arrives as `Authorization: Bearer <secret>`. A user session is not an
 * alternative here and a Bot credential is not a kind of this — both arrive as one uniform 401,
 * and the refused path never touches an account, so there is no balance or grant data any
 * refusal could carry. Every call, refused or not, writes its audit row before the handler (or
 * the refusal) answers.
 */
export function requireCreditService(
  dependencies: CreditServiceRouteDependencies,
): MiddlewareHandler<{ Variables: CreditServiceVariables }> {
  return async (context, next) => {
    const header = context.req.header("authorization");
    const presented = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length).trim()
      : undefined;
    const shape = requestShape(context);
    if (!presented) {
      await recordRefusal(dependencies.auditStore, "missing-header", shape);
      return context.json(UNIFORM_REFUSAL, 401);
    }
    try {
      const identity = await dependencies.authenticate(presented);
      context.set("creditService", identity);
      if (dependencies.auditStore) {
        try {
          await recordAuditEvent(dependencies.auditStore, {
            eventType: "credit_service.called",
            targetType: "credit_protocol",
            initiator: DEPLOYMENT_INITIATOR,
            payload: {
              method: shape.method,
              path: shape.path,
              provider: identity.provider,
              keyId: identity.keyId,
            },
          });
        } catch (error) {
          log.error(
            {
              type: "credit-service-auth-audit-write-failed",
              error: String(error),
            },
            "credit-service-auth-audit-write-failed",
          );
        }
      }
    } catch (error) {
      const reason =
        error instanceof CreditServiceNotConfiguredError
          ? "unconfigured"
          : "mismatch";
      await recordRefusal(dependencies.auditStore, reason, shape);
      return context.json(UNIFORM_REFUSAL, 401);
    }
    await next();
  };
}

export type CreditProtocolRouteDependencies = {
  authenticate?: CreditServiceAuthenticator;
  auditStore?: AuditStore;
  /**
   * The protocol's business routes — 06.2's Reserve, and the Status/Settle/Release surfaces
   * after it — carrying their own paths. Mounted inside the guard, so nothing mounted here is
   * reachable without the deployment's billing identity.
   */
  endpoints?: Hono<{ Variables: CreditServiceVariables }>;
};

/**
 * `/api/credit-protocol`: the billing protocol surface this ticket mounts the guard on. Today it
 * answers exactly one question — "which service identity does this credential say I am?" — the
 * deployment's own smoke test for a billing credential, the way 04.2's route is for a Bot's.
 * Fail-closed in both directions: no authenticator wired, no door (one tagged 503, not an open
 * surface); no valid credential, one uniform refusal.
 */
export function creditProtocolRoutes(
  dependencies: CreditProtocolRouteDependencies | undefined,
) {
  const app = new Hono<{ Variables: CreditServiceVariables }>();
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  if (!dependencies?.authenticate) {
    app.all("*", (context) =>
      context.json(
        {
          error: "Credit service authentication is not available.",
          code: "credit_service_unavailable",
        },
        503,
      ),
    );
    return app;
  }
  app.use(
    "*",
    requireCreditService({
      authenticate: dependencies.authenticate,
      auditStore: dependencies.auditStore,
    }),
  );
  app.get("/", (context) =>
    context.json({ creditService: context.get("creditService") }),
  );
  if (dependencies.endpoints) app.route("/", dependencies.endpoints);
  return app;
}
