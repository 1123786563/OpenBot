/**
 * The trusted seam between OpenBot's tenancy layer and the shared self-hosted Hindsight
 * service (Hindsight 04 / #381).
 *
 * OpenBot stays the authority for who may touch which memory. This module is the only place
 * that turns an identity into a Hindsight placement: a trusted, server-issued `PlatformScope`
 * resolves to the company's PostgreSQL schema on the Hindsight side plus the bank ids that
 * identity may touch, and nothing else can reach that answer — a bank id, tenant id or
 * principal id arriving in a request body, query parameter or header has no entry point here.
 * The scope must carry the enterprise tenancy layer's `issuedScopes` marker
 * (../enterprise/tenancy/store.ts `assertTrustedScope`, the #82 contract), so a hand-built or
 * cloned scope is refused outright rather than trusted for its shape.
 *
 * The grant travels to Hindsight as a short-lived signed assertion (HMAC-SHA256 over a
 * canonical JSON body, `v1.<body>.<signature>`), sent alongside the deployment's shared
 * service API key. Hindsight's custom tenant extension (deploy/hindsight/extensions/
 * openbot_tenant) verifies the pair and confines every retain/recall/delete to the banks the
 * assertion names: the shared key alone is not a service identity, and a guessed bank is
 * rejected however well-formed it is. The verifier here is the byte-for-byte mirror of the
 * service-side check (canonical key order, url-safe base64, no padding), kept in this module
 * so tests and diagnostics prove the two sides agree without speaking to the service.
 *
 * Bank identity is derived, never chosen: `ob_c_`/`ob_u_`/`ob_t_`/`ob_s_`/`ob_b_` plus 16 hex
 * of SHA-256 over the trusted identifier, so the same global user holding principals in two
 * companies lands in two different schemas with two different banks, and no derivation
 * output is a valid guess for another subject's.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PlatformScope } from "../enterprise/contracts";
import { assertTrustedScope } from "../enterprise/tenancy/store";

/** One bank this identity may touch, and which restriction carved it. */
export type HindsightBankGrant = {
  id: string;
  kind: "user" | "team" | "source" | "bot";
};

/** A resolved placement: the company's schema on the Hindsight service, and its banks. */
export type HindsightBankScope = {
  schema: string;
  banks: readonly HindsightBankGrant[];
  tenantId: string;
  principalId: string;
};

/** What minting and verifying an assertion need. */
export type BankScopeAssertionOptions = {
  secret: string;
  /** How long the assertion stays valid; the mint rounds to whole seconds. */
  ttlMs: number;
  now?: Date;
};

/** The assertion's verified payload. Field names are the wire contract with the service side. */
export type BankScopeAssertionPayload = {
  v: 1;
  iss: "openbot";
  tid: string;
  pid: string;
  sch: string;
  b: string[];
  iat: number;
  exp: number;
};

/** Environment the assertion secret is read from (the one key, kept narrow on purpose). */
export type HindsightBankScopeEnv = Record<string, string | undefined>;

const ASSERTION_VERSION = "v1";
const ASSERTION_ISSUER = "openbot";
/** Keys in the exact order the canonical JSON body is serialized in. */
const PAYLOAD_KEYS = [
  "v",
  "iss",
  "tid",
  "pid",
  "sch",
  "b",
  "iat",
  "exp",
] as const;

function hash16(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`${namespace}:${value}`)
    .digest("hex")
    .slice(0, 16);
}

/** The company's schema on the shared Hindsight service: one schema per company, forever. */
export function companySchemaFor(tenantId: string): string {
  return `ob_c_${hash16("company", tenantId)}`;
}

/** The principal's own bank in their company: general personal preferences live here. */
export function userBankFor(principalId: string): string {
  return `ob_u_${hash16("user", principalId)}`;
}

/** A team-restricted bank inside the company (workspace-scoped memories). */
export function teamBankFor(workspaceId: string): string {
  return `ob_t_${hash16("team", workspaceId)}`;
}

/** A source-restricted bank: memories an authorized connected source contributed. */
export function sourceBankFor(sourceId: string): string {
  return `ob_s_${hash16("source", sourceId)}`;
}

/** A Bot-restricted bank: memories only the Bot that formed them may recall. */
export function botBankFor(agentId: string): string {
  return `ob_b_${hash16("bot", agentId)}`;
}

/**
 * Resolve the Hindsight placement of ONE trusted scope. The grant is the caller's own user
 * bank in their own company's schema — the general personal-preference bank of the spec. A
 * scope that was not issued by the enterprise tenancy layer throws `UNVERIFIED_SCOPE`; there
 * is no fallback placement, ever.
 */
export function resolveHindsightBankScope(
  scope: PlatformScope,
): HindsightBankScope {
  assertTrustedScope(scope);
  return {
    schema: companySchemaFor(scope.tenantId),
    banks: [{ id: userBankFor(scope.principalId), kind: "user" }],
    tenantId: scope.tenantId,
    principalId: scope.principalId,
  };
}

/** The current authorizations a source-bound recall may act on; read live by trusted server code. */
export type ScopedMemoryAuthorization = {
  /**
   * Whether the principal's membership in the ASKING workspace is currently active. The team
   * bank searched is the asking workspace's own — a conversation in team B never carries team
   * A's bank however many teams the person belongs to.
   */
  workspaceActive: boolean;
  /** Connected sources currently enabled for this principal (the registry's live answer). */
  sourceIds: readonly string[];
  /** The Bot asking, when one is: its own bank is searched only while it still holds its app. */
  agentId?: string;
};

/**
 * Resolve the placement of ONE trusted scope across its CURRENT source-bound authorizations
 * (Hindsight 06 / #383). Same discipline as `resolveHindsightBankScope` — a server-issued
 * scope in, a derived placement out — but the grant is the bank set the authorizations name:
 * the asking workspace's team bank while membership there is active, one source bank per
 * enabled connected source, and the asking Bot's own bank when one is asking and still
 * authorized. The workspace itself comes from the trusted scope, never the request, and the
 * authorization snapshot is the CALLER's responsibility, read from current server state
 * (memberships, the grant registry); an inactive or empty snapshot resolves to a smaller or
 * empty grant, which the recall seam answers with nothing rather than guessing a bank.
 */
export function resolveScopedHindsightBankScope(
  scope: PlatformScope,
  authorization: ScopedMemoryAuthorization,
): HindsightBankScope {
  assertTrustedScope(scope);
  const banks: HindsightBankGrant[] = authorization.workspaceActive
    ? [{ id: teamBankFor(scope.workspaceId), kind: "team" }]
    : [];
  banks.push(
    ...[...new Set(authorization.sourceIds).values()].map(
      (sourceId): HindsightBankGrant => ({
        id: sourceBankFor(sourceId),
        kind: "source",
      }),
    ),
  );
  if (authorization.agentId !== undefined) {
    banks.push({ id: botBankFor(authorization.agentId), kind: "bot" });
  }
  return {
    schema: companySchemaFor(scope.tenantId),
    banks,
    tenantId: scope.tenantId,
    principalId: scope.principalId,
  };
}

/**
 * The placement of one authority row's own bank, for the persistent background tasks the spec
 * names as the second legitimate identity source (the sync queue of Hindsight 07 / #384 is
 * one). The identity comes from durable OpenBot state — the row's own attribution — and the
 * bank from the same derivations as every other placement, so a background task can never
 * name a bank its row does not own; there is deliberately no scope to assert here.
 */
export function backgroundTaskBankScope(
  identity: { tenantId: string; principalId: string },
  bank: HindsightBankGrant,
): HindsightBankScope {
  return {
    schema: companySchemaFor(identity.tenantId),
    banks: [bank],
    tenantId: identity.tenantId,
    principalId: identity.principalId,
  };
}

/**
 * Read the assertion-signing secret from the environment. The secret is shared with the
 * Hindsight deployment (its custom tenant extension verifies with the same value), so an
 * absent or blank declaration is an error, never a default: a defaulted secret would mint
 * assertions the service rightly refuses, or worse, ones it accepts.
 */
export function bankScopeAssertionSecret(
  env: HindsightBankScopeEnv = process.env,
): string {
  const secret = env.HINDSIGHT_BANK_ASSERTION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "HINDSIGHT_BANK_ASSERTION_SECRET must declare the secret shared with the Hindsight service's tenant extension before bank scope assertions can be minted.",
    );
  }
  return secret;
}

function canonicalPayload(
  grant: HindsightBankScope,
  issuedAt: Date,
  expiresAt: Date,
): BankScopeAssertionPayload {
  return {
    v: 1,
    iss: ASSERTION_ISSUER,
    tid: grant.tenantId,
    pid: grant.principalId,
    sch: grant.schema,
    b: [...grant.banks.map((bank) => bank.id)],
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
}

/**
 * Serialize the payload exactly the service side re-serializes it: fixed key order, no
 * insignificant whitespace. The HMAC is computed over this canonical string, so both sides
 * agree byte-for-byte without sharing anything but the secret.
 */
function canonicalJson(payload: BankScopeAssertionPayload): string {
  return `{${PAYLOAD_KEYS.map(
    (key) =>
      `${JSON.stringify(key)}:${JSON.stringify(payload[key as keyof BankScopeAssertionPayload])}`,
  ).join(",")}}`;
}

/** Mint the signed assertion carrying exactly the granted placement. */
export function mintBankScopeAssertion(
  grant: HindsightBankScope,
  options: BankScopeAssertionOptions,
): string {
  const issuedAt = options.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + options.ttlMs);
  const body = Buffer.from(
    canonicalJson(canonicalPayload(grant, issuedAt, expiresAt)),
  ).toString("base64url");
  const signature = createHmac("sha256", options.secret)
    .update(`${ASSERTION_VERSION}.${body}`)
    .digest("base64url");
  return `${ASSERTION_VERSION}.${body}.${signature}`;
}

/**
 * Verify an assertion the way the service side does (the mirror check; kept here so tests and
 * diagnostics can prove the two agree). Answers the payload, or null for anything malformed,
 * wrongly signed, or expired — a refusal, never an exception: callers treat "not verified"
 * and "absent" the same way.
 */
export function verifyBankScopeAssertion(
  token: string,
  options: { secret: string; now?: Date },
): BankScopeAssertionPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ASSERTION_VERSION) return null;
  const [, body, signature] = parts;
  const expected = createHmac("sha256", options.secret)
    .update(`${ASSERTION_VERSION}.${body}`)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;
  let payload: BankScopeAssertionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as BankScopeAssertionPayload;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || payload.iss !== ASSERTION_ISSUER) return null;
  if (typeof payload.sch !== "string" || !Array.isArray(payload.b)) return null;
  if (payload.b.some((bank) => typeof bank !== "string")) return null;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}
