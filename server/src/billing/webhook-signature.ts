import {
  createHash,
  createHmac,
  createSign,
  createVerify,
  timingSafeEqual,
} from "node:crypto";
import type { VerifiedWebhook, WebhookVerifier } from "./types";

/**
 * The provider's own two webhook signature modes, verified the way it signs.
 *
 * jwt (its default): `X-Lago-Signature` carries a compact JWT whose `data` claim is the webhook
 * payload, encoded twice: the provider's own signer builds the claim as `{ data: payload.to_json }`
 * (getlago/lago-api app/models/webhook.rb `jwt_signature`), so what rides inside the JWT payload is
 * a JSON *string*, not the payload object. The verifier unwraps that string before comparing, and
 * also accepts the object spelling as a defensive compatibility — but the string is the shape a
 * real delivery arrives in, and the only one the signer below produces. The signature is RS256 over
 * `header.payload`, so the verifier needs the provider instance's public key — supplied here at
 * construction, never fetched at runtime: a runtime fetch of the trust root would let a hijacked
 * API URL hand us the key that verifies its own forgeries. The `alg` in the token header is a
 * whitelist (`RS256`), not a value honoured: `none` and an HMAC algorithm impersonating the
 * public-key mode are both refused before anything is verified.
 *
 * The payload the signature covers is the provider's wire shape (Webhooks::BaseService):
 * `{ webhook_type, object_type, organization_id, <object_type>: <serialised object> }` — the
 * subject object sits in a member named by `object_type`, so a `subscription.*` delivery nests its
 * `subscription` and a `customer.*` delivery nests its `customer`. There is no `event_id` in the
 * body at all: the event's identity rides only in the `X-Lago-Unique-Key` header (webhook.rb
 * `generate_headers` sets it to the webhook record's id), which is why the delivery below reads
 * that header and refuses a delivery without it — an event that cannot be named cannot be
 * de-duplicated, so it is not accepted as work.
 *
 * hmac: chosen when the provider's webhook endpoint is created with the hmac algorithm.
 * `X-Lago-Signature` is `base64(HMAC-SHA256(rawBody))`, compared in constant time.
 *
 * `X-Lago-Signature-Algorithm` routes between them and defaults to jwt when absent. A delivery
 * signed one way against a deployment configured the other way is refused (`ok: false` → the
 * route answers 401): it is either a misconfiguration or somebody probing.
 *
 * The token's `iss` is deliberately not checked. The self-hosted issuer value has no documented
 * guarantee, so a check would either always pass (matching nothing) or reject honest deliveries;
 * signature + algorithm whitelist + `data`-equals-body is the complete boundary here.
 *
 * The replay window (audit A7): the delivery's identity rides in an UNSIGNED header, so the
 * signature alone cannot stop one captured delivery from being replayed under fresh unique keys
 * forever. The token's own time claims bound that window WHEN THE PROVIDER SIGNS THEM; a
 * self-hosted provider that signs no time claim at all must keep delivering, and for that case
 * the body hash the verifier returns (sha256 of the verified raw body) plus the
 * `webhook_body_replay` reconciliation finding are the whole defense — evidence, not a refusal.
 * An operator who has confirmed their provider's tokens DO carry time claims may tighten
 * "when present" into "required"; nobody has observed the deployed provider's claim set yet.
 */
export type WebhookKeyConfig =
  | { mode: "jwt"; publicKeyPem: string }
  | { mode: "hmac"; key: string };

/** A PEM, or that PEM base64-wrapped; the wrapping is stripped once, at construction. */
function normalisePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
  return decoded.startsWith("-----BEGIN") ? decoded : trimmed;
}

/** Structural JSON equality (member order and repeated escapes are not meaning). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA).sort();
  const keysB = Object.keys(recordB).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key, index) =>
      key === keysB[index] && jsonEqual(recordA[key], recordB[key]),
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read one verified payload as a delivery, in the provider's wire shape.
 *
 * Identity first: the event id is the `X-Lago-Unique-Key` header, never a body member (see the
 * file header). Then the `webhook_type`, which is at the top level of the payload. The subject
 * object — where this reads which customer the event concerns, and the provider's own id for the
 * object — sits in a member named by `object_type`: a subscription delivery carries
 * `subscription.external_customer_id`, a customer delivery carries `customer.external_id`, and
 * both carry `lago_id`. A delivery about an object this deployment does not project (an invoice,
 * a wallet) simply yields no customer: that is finished work, not a refusal.
 */
function deliveryOf(
  headers: Headers,
  data: unknown,
): Omit<VerifiedWebhook, "bodyHash"> | null {
  const eventId = nonEmptyString(headers.get("x-lago-unique-key")?.trim());
  if (eventId === undefined) return null;

  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const webhookType = nonEmptyString(record.webhook_type);
  if (webhookType === undefined) return null;

  const objectType = nonEmptyString(record.object_type);
  const object = objectType !== undefined ? record[objectType] : undefined;
  const subject =
    object && typeof object === "object" && !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : undefined;
  // `external_customer_id` on the objects that carry one; `external_id` on a customer object,
  // which is this deployment's own external key for itself.
  const externalCustomerId = subject
    ? (nonEmptyString(subject.external_customer_id) ??
      nonEmptyString(subject.external_id))
    : undefined;
  const objectId = subject ? nonEmptyString(subject.lago_id) : undefined;

  return {
    eventId,
    webhookType,
    ...(objectId !== undefined ? { objectId } : {}),
    ...(externalCustomerId !== undefined ? { externalCustomerId } : {}),
  };
}

export function createWebhookVerifier(config: {
  key: WebhookKeyConfig;
  /** Injectable clock, in Unix seconds. */
  now?: () => number;
  /** How far a signed `iat` may sit in the past. Defaults to 300, the WeChat adapter's skew. */
  maxSkewSeconds?: number;
}): WebhookVerifier {
  const key = config.key;
  const nowSeconds = config.now ?? (() => Math.floor(Date.now() / 1000));
  const maxSkewSeconds = config.maxSkewSeconds ?? 300;
  const pem = key.mode === "jwt" ? normalisePem(key.publicKeyPem) : null;
  const hmacKey = key.mode === "hmac" ? key.key : null;
  const bodyHashOf = (rawBody: string) =>
    createHash("sha256").update(rawBody).digest("hex");

  return {
    async verify(headers, rawBody) {
      const algorithmHeader = headers.get("x-lago-signature-algorithm");
      const algorithm = algorithmHeader?.trim().toLowerCase() ?? "jwt";
      if (algorithm !== key.mode) return { ok: false };

      const signature = headers.get("x-lago-signature");
      if (!signature || signature.length === 0) return { ok: false };

      if (key.mode === "jwt" && pem) {
        const parts = signature.split(".");
        if (parts.length !== 3) return { ok: false };
        const [encodedHeader, encodedPayload, encodedSignature] = parts;

        const header = parseJson(
          Buffer.from(encodedHeader, "base64url").toString("utf8"),
        ) as { alg?: unknown } | undefined;
        // An algorithm whitelist, not an algorithm choice: only the mode the key was issued for.
        if (!header || typeof header !== "object" || header.alg !== "RS256") {
          return { ok: false };
        }

        let verified = false;
        try {
          verified = createVerify("RSA-SHA256")
            .update(`${encodedHeader}.${encodedPayload}`)
            .verify(pem, Buffer.from(encodedSignature, "base64url"));
        } catch {
          // A malformed key or signature is an unverified delivery, not a crash.
          return { ok: false };
        }
        if (!verified) return { ok: false };

        // The signed `data` claim must be the body that arrived, or the signature is over a
        // different message than the one we are about to act on. The claim is double-encoded on the
        // wire — a JSON string, per the provider's own signer — so a string is parsed into the
        // payload first; an object claim is read as-is, as defensive compatibility for an assembly
        // that ever produced that shape. A `data` string whose JSON is not the body fails the same
        // equality either way.
        const signedData = parseJson(
          Buffer.from(encodedPayload, "base64url").toString("utf8"),
        ) as { data?: unknown } | undefined | string | number | boolean;
        if (!signedData || typeof signedData !== "object") {
          return { ok: false };
        }
        const payload =
          typeof signedData.data === "string"
            ? parseJson(signedData.data)
            : signedData.data;
        if (!jsonEqual(payload, parseJson(rawBody))) {
          return { ok: false };
        }
        /*
         * The replay window (audit A7). The event identity rides in an UNSIGNED header, so the
         * signature alone cannot stop one captured delivery from being replayed under fresh
         * unique keys forever. The token's own time claims can: enforce them when the provider
         * signs them, and leave a body hash behind as evidence when it does not. Enforced
         * "when present" on purpose — a self-hosted provider that signs no time claim must keep
         * delivering, and the hash plus the reconcile finding is what bounds that case.
         */
        const claims = signedData as {
          exp?: unknown;
          iat?: unknown;
          nbf?: unknown;
        };
        const seconds = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value)
            ? value
            : undefined;
        const exp = seconds(claims.exp);
        const iat = seconds(claims.iat);
        const nbf = seconds(claims.nbf);
        const now = nowSeconds();
        if (exp !== undefined && now > exp) return { ok: false };
        if (nbf !== undefined && now + maxSkewSeconds < nbf)
          return { ok: false };
        if (iat !== undefined && now - iat > maxSkewSeconds)
          return { ok: false };
        if (iat !== undefined && iat - now > maxSkewSeconds)
          return { ok: false };
        const delivery = deliveryOf(headers, payload);
        return delivery
          ? {
              ok: true,
              delivery: { ...delivery, bodyHash: bodyHashOf(rawBody) },
            }
          : { ok: false };
      }

      if (key.mode === "hmac" && hmacKey !== null) {
        const expected = createHmac("sha256", hmacKey)
          .update(rawBody)
          .digest("base64");
        const given = Buffer.from(signature, "utf8");
        const wanted = Buffer.from(expected, "utf8");
        // Length is compared first because timingSafeEqual throws on a mismatch; the comparison
        // below is the constant-time one on equal-length values.
        if (given.length !== wanted.length) return { ok: false };
        if (!timingSafeEqual(given, wanted)) return { ok: false };
        const delivery = deliveryOf(headers, parseJson(rawBody));
        return delivery
          ? {
              ok: true,
              delivery: { ...delivery, bodyHash: bodyHashOf(rawBody) },
            }
          : { ok: false };
      }

      return { ok: false };
    },
  };
}

/**
 * Signs a delivery the way the provider does, for this file's own tests: the `data` claim is the
 * payload serialised to a JSON string — the double encoding the provider's own signer applies
 * (webhook.rb builds `{ data: payload.to_json }`) — so a test token has the real wire shape rather
 * than a shape the signer and the verifier agreed on between themselves. An `iss` claim is present
 * in real tokens and deliberately not reproduced or checked (see the header note).
 */
export function signDeliveryLikeProvider(
  payload: unknown,
  privateKeyPem: string,
  header: { alg: string } = { alg: "RS256" },
  timeClaims: { iat?: number; exp?: number; nbf?: number } = {},
): string {
  // `data` last is not required — the verifier reads the claim by name — but keeping it last makes
  // a test token's shape readable: time claims, then the double-encoded payload.
  const claims = { ...timeClaims, data: JSON.stringify(payload) };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  );
  const signature = createSign("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(privateKeyPem)
    .toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
