import { createHmac, createSign, createVerify, timingSafeEqual } from "node:crypto";
import type { VerifiedWebhook, WebhookVerifier } from "./types";

/**
 * The provider's own two webhook signature modes, verified the way it signs.
 *
 * jwt (its default): `X-Lago-Signature` carries a compact JWT whose `data` claim is the webhook
 * payload. The signature is RS256 over `header.payload`, so the verifier needs the provider
 * instance's public key — supplied here at construction, never fetched at runtime: a runtime fetch
 * of the trust root would let a hijacked API URL hand us the key that verifies its own forgeries.
 * The `alg` in the token header is a whitelist (`RS256`), not a value honoured: `none` and an
 * HMAC algorithm impersonating the public-key mode are both refused before anything is verified.
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

function deliveryOf(data: unknown): VerifiedWebhook | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const eventId = record.event_id;
  const webhookType = record.webhook_type;
  if (typeof eventId !== "string" || eventId.length === 0) return null;
  if (typeof webhookType !== "string" || webhookType.length === 0) return null;
  const objectId = record.object_id;
  const externalCustomerId = record.external_customer_id;
  return {
    eventId,
    webhookType,
    ...(typeof objectId === "string" && objectId.length > 0 ? { objectId } : {}),
    ...(typeof externalCustomerId === "string" && externalCustomerId.length > 0
      ? { externalCustomerId }
      : {}),
  };
}

export function createWebhookVerifier(config: {
  key: WebhookKeyConfig;
}): WebhookVerifier {
  const key = config.key;
  const pem = key.mode === "jwt" ? normalisePem(key.publicKeyPem) : null;
  const hmacKey = key.mode === "hmac" ? key.key : null;

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
        // different message than the one we are about to act on.
        const signedData = parseJson(
          Buffer.from(encodedPayload, "base64url").toString("utf8"),
        ) as { data?: unknown } | undefined;
        if (
          !signedData ||
          typeof signedData !== "object" ||
          !jsonEqual(signedData.data, parseJson(rawBody))
        ) {
          return { ok: false };
        }
        const delivery = deliveryOf(signedData.data);
        return delivery ? { ok: true, delivery } : { ok: false };
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
        const delivery = deliveryOf(parseJson(rawBody));
        return delivery ? { ok: true, delivery } : { ok: false };
      }

      return { ok: false };
    },
  };
}

/** Signs a delivery the way the provider does, for this file's own tests. */
export function signDeliveryLikeProvider(
  payload: unknown,
  privateKeyPem: string,
  header: { alg: string } = { alg: "RS256" },
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createSign("RSA-SHA256")
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(privateKeyPem)
    .toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
