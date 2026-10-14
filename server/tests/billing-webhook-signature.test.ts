import { describe, expect, test } from "bun:test";
import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import {
  createWebhookVerifier,
  signDeliveryLikeProvider,
} from "../src/billing/webhook-signature";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const HMAC_KEY = "hmac-secret-from-endpoint-creation";

/*
 * The wire, exactly as the provider builds it (Webhooks::BaseService): `webhook_type` and
 * `object_type` at the top level, the serialised subject object nested under a member named by
 * `object_type`, and no `event_id` anywhere in the body — the event's identity is the
 * `X-Lago-Unique-Key` header, so the fixtures below carry it as a header and the assertions read
 * it back out of the delivery.
 */
const WIRE_BODY = JSON.stringify({
  webhook_type: "subscription.terminated",
  object_type: "subscription",
  organization_id: "lago-org-1",
  subscription: {
    lago_id: "lago-sub-1",
    external_id: "deployment-1-sub",
    external_customer_id: "deployment-1",
    plan_code: "pro",
    status: "terminated",
  },
});
const WIRE_PAYLOAD = JSON.parse(WIRE_BODY);
const EVENT_ID = "uk-evt-1";
const EXPECTED_DELIVERY = {
  eventId: EVENT_ID,
  webhookType: "subscription.terminated",
  objectId: "lago-sub-1",
  externalCustomerId: "deployment-1",
};

/** The replay-evidence hash (audit A7): sha256 of the raw body, lowercase hex. */
const sha256Of = (body: string) =>
  createHash("sha256").update(body).digest("hex");

function jwtHeaders(
  jwt: string,
  algorithm?: string,
  uniqueKey: string | null = EVENT_ID,
): Headers {
  const headers = new Headers({ "x-lago-signature": jwt });
  if (algorithm !== undefined) {
    headers.set("x-lago-signature-algorithm", algorithm);
  }
  if (uniqueKey !== null) {
    headers.set("x-lago-unique-key", uniqueKey);
  }
  return headers;
}

function hmacHeaders(
  signature: string,
  algorithm = "hmac",
  uniqueKey: string | null = EVENT_ID,
): Headers {
  const headers = new Headers({
    "x-lago-signature": signature,
    "x-lago-signature-algorithm": algorithm,
  });
  if (uniqueKey !== null) {
    headers.set("x-lago-unique-key", uniqueKey);
  }
  return headers;
}

function hmacOf(body: string, key = HMAC_KEY): string {
  return createHmac("sha256", key).update(body).digest("base64");
}

/** A token built by hand from arbitrary claims, for the shapes the helper signer cannot produce. */
function manuallySigned(claims: unknown, header: { alg: string }): string {
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

describe("createWebhookVerifier jwt mode (the default)", () => {
  const verifier = createWebhookVerifier({
    key: { mode: "jwt", publicKeyPem },
  });

  test("accepts a correctly signed delivery and reads it, identity from the header", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({
      ok: true,
      delivery: { ...EXPECTED_DELIVERY, bodyHash: sha256Of(WIRE_BODY) },
    });
  });

  test("accepts the same delivery without the algorithm header (jwt is the default)", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toMatchObject({ ok: true });
  });

  test("refuses a tampered payload under a valid signature", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const [h, , s] = jwt.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        data: JSON.stringify({
          ...WIRE_PAYLOAD,
          subscription: {
            ...WIRE_PAYLOAD.subscription,
            status: "active",
          },
        }),
      }),
    ).toString("base64url");
    const result = await verifier.verify(
      jwtHeaders(`${h}.${forgedPayload}.${s}`),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses a signature made with the wrong key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = signDeliveryLikeProvider(
      WIRE_PAYLOAD,
      other.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("refuses a signed `data` claim that is not the body that arrived", async () => {
    const otherBody = {
      webhook_type: "subscription.terminated",
      object_type: "subscription",
      organization_id: "lago-org-1",
      subscription: { ...WIRE_PAYLOAD.subscription, status: "active" },
    };
    const jwt = signDeliveryLikeProvider(otherBody, privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("treats member order in `data` as irrelevant (JSON semantics, not bytes)", async () => {
    const reordered = JSON.stringify({
      subscription: {
        status: "terminated",
        plan_code: "pro",
        external_customer_id: "deployment-1",
        external_id: "deployment-1-sub",
        lago_id: "lago-sub-1",
      },
      organization_id: "lago-org-1",
      object_type: "subscription",
      webhook_type: "subscription.terminated",
    });
    const jwt = signDeliveryLikeProvider(JSON.parse(reordered), privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toMatchObject({ ok: true });
  });

  test("refuses alg=none regardless of the signature material", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ data: WIRE_BODY })).toString(
      "base64url",
    );
    const result = await verifier.verify(
      jwtHeaders(`${header}.${payload}.unsecured`),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses an HMAC signature impersonating the public-key mode", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ data: WIRE_BODY })).toString(
      "base64url",
    );
    // Signed with the HMAC construction an attacker who only has the public PEM could produce.
    const mac = createHmac("sha256", publicKeyPem)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const result = await verifier.verify(
      jwtHeaders(`${header}.${payload}.${mac}`),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses a malformed token, a bad header JSON and a missing signature header", async () => {
    expect(await verifier.verify(jwtHeaders("not-a-jwt"), WIRE_BODY)).toEqual({
      ok: false,
    });
    expect(
      await verifier.verify(jwtHeaders("a.b.c", "jwt"), WIRE_BODY),
    ).toEqual({ ok: false });
    expect(await verifier.verify(jwtHeaders("", undefined), WIRE_BODY)).toEqual(
      { ok: false },
    );
  });

  test("refuses a body that is not the provider's payload shape", async () => {
    const body = JSON.stringify({ subscription: { lago_id: "lago-sub-1" } });
    const jwt = signDeliveryLikeProvider(JSON.parse(body), privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), body);
    expect(result).toEqual({ ok: false });
  });

  test("reads a base64-wrapped PEM the same as a bare one", async () => {
    const verifierWrapped = createWebhookVerifier({
      key: {
        mode: "jwt",
        publicKeyPem: Buffer.from(publicKeyPem).toString("base64"),
      },
    });
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifierWrapped.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toMatchObject({ ok: true });
  });

  test("a signed delivery without the unique-key header has no identity and no acceptance", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(
      jwtHeaders(jwt, undefined, null),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("reads a customer delivery's own external id out of the nested customer", async () => {
    const body = JSON.stringify({
      webhook_type: "customer.updated",
      object_type: "customer",
      organization_id: "lago-org-1",
      customer: { lago_id: "lago-customer-1", external_id: "deployment-1" },
    });
    const jwt = signDeliveryLikeProvider(JSON.parse(body), privateKeyPem);
    const result = await verifier.verify(
      jwtHeaders(jwt, undefined, "uk-cust-1"),
      body,
    );
    expect(result).toEqual({
      ok: true,
      delivery: {
        eventId: "uk-cust-1",
        webhookType: "customer.updated",
        objectId: "lago-customer-1",
        externalCustomerId: "deployment-1",
        bodyHash: sha256Of(body),
      },
    });
  });

  test("a delivery whose named object member is absent verifies, naming no customer", async () => {
    // The signature is over the body that arrived, so the delivery is authentic; its subject
    // object is missing, which is a payload this deployment treats as projecting nothing. The
    // verifier's job stops at naming what can be named.
    const body = JSON.stringify({
      webhook_type: "subscription.updated",
      object_type: "subscription",
      organization_id: "lago-org-1",
    });
    const jwt = signDeliveryLikeProvider(JSON.parse(body), privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), body);
    expect(result).toEqual({
      ok: true,
      delivery: {
        eventId: EVENT_ID,
        webhookType: "subscription.updated",
        bodyHash: sha256Of(body),
      },
    });
  });
});

describe("createWebhookVerifier jwt mode, the provider's real double-encoded shape", () => {
  const verifier = createWebhookVerifier({
    key: { mode: "jwt", publicKeyPem },
  });

  test("(a) `data` as a JSON string — the wire shape — verifies and reads correctly", async () => {
    // Built exactly as webhook.rb builds it: { data: payload.to_json, iss: <the instance's URL> }.
    // The `iss` is present in real tokens and ignored here (see the module header).
    const jwt = manuallySigned(
      { data: WIRE_BODY, iss: "https://api.getlago.com" },
      { alg: "RS256" },
    );
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({
      ok: true,
      delivery: { ...EXPECTED_DELIVERY, bodyHash: sha256Of(WIRE_BODY) },
    });
  });

  test("(b) a `data` string whose JSON is not the raw body is refused", async () => {
    const otherPayload = {
      webhook_type: "subscription.terminated",
      object_type: "subscription",
      organization_id: "lago-org-1",
      subscription: { ...WIRE_PAYLOAD.subscription, plan_code: "enterprise" },
    };
    const jwt = manuallySigned(
      { data: JSON.stringify(otherPayload) },
      { alg: "RS256" },
    );
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("(c) a `data` object — the defensive compatibility shape — still verifies", async () => {
    const jwt = manuallySigned({ data: WIRE_PAYLOAD }, { alg: "RS256" });
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toMatchObject({ ok: true });
  });

  test("a `data` string that is not JSON at all is refused", async () => {
    const jwt = manuallySigned({ data: "not json" }, { alg: "RS256" });
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });
});

describe("createWebhookVerifier hmac mode", () => {
  const verifier = createWebhookVerifier({
    key: { mode: "hmac", key: HMAC_KEY },
  });

  test("accepts a correct base64 HMAC-SHA256 of the raw body", async () => {
    const result = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY)),
      WIRE_BODY,
    );
    expect(result).toEqual({
      ok: true,
      delivery: { ...EXPECTED_DELIVERY, bodyHash: sha256Of(WIRE_BODY) },
    });
  });

  test("refuses a bad signature", async () => {
    const result = await verifier.verify(
      hmacHeaders(hmacOf("a different body")),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses the right signature over the wrong body", async () => {
    const result = await verifier.verify(
      hmacHeaders(hmacOf("another body")),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses a signature made with the wrong key", async () => {
    const result = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY, "wrong-key")),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("refuses a hex sha256 (the other provider's format) in base64 mode", async () => {
    const hex = createHmac("sha256", HMAC_KEY).update(WIRE_BODY).digest("hex");
    const result = await verifier.verify(hmacHeaders(hex), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("refuses a signed delivery without the unique-key header here too", async () => {
    const result = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY), "hmac", null),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });
});

describe("createWebhookVerifier mode routing", () => {
  test("a jwt delivery against an hmac deployment is refused", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "hmac", key: HMAC_KEY },
    });
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt, "jwt"), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("an hmac delivery against a jwt deployment is refused", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem },
    });
    const result = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY)),
      WIRE_BODY,
    );
    expect(result).toEqual({ ok: false });
  });

  test("an unknown algorithm header is refused by either mode", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const asJwt = createWebhookVerifier({ key: { mode: "jwt", publicKeyPem } });
    expect(await asJwt.verify(jwtHeaders(jwt, "ed25519"), WIRE_BODY)).toEqual({
      ok: false,
    });
    const asHmac = createWebhookVerifier({
      key: { mode: "hmac", key: HMAC_KEY },
    });
    expect(
      await asHmac.verify(hmacHeaders(hmacOf(WIRE_BODY), "ed25519"), WIRE_BODY),
    ).toEqual({ ok: false });
  });
});

describe("the replay window (audit A7)", () => {
  test("an expired token is refused even though its signature and body are valid", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
    });
    const signature = signDeliveryLikeProvider(
      WIRE_PAYLOAD,
      privateKeyPem,
      { alg: "RS256" },
      { exp: Math.floor(Date.parse("2026-10-14T11:00:00Z") / 1000) },
    );
    const result = await verifier.verify(jwtHeaders(signature), WIRE_BODY);
    expect(result.ok).toBe(false);
  });

  test("a token inside its lifetime is accepted", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
    });
    const signature = signDeliveryLikeProvider(
      WIRE_PAYLOAD,
      privateKeyPem,
      { alg: "RS256" },
      { exp: Math.floor(Date.parse("2026-10-14T13:00:00Z") / 1000) },
    );
    const result = await verifier.verify(jwtHeaders(signature), WIRE_BODY);
    expect(result.ok).toBe(true);
  });

  test("an iat further in the past than the skew window is refused", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem },
      now: () => Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000),
      maxSkewSeconds: 300,
    });
    const signature = signDeliveryLikeProvider(
      WIRE_PAYLOAD,
      privateKeyPem,
      { alg: "RS256" },
      { iat: Math.floor(Date.parse("2026-10-14T11:00:00Z") / 1000) },
    );
    expect((await verifier.verify(jwtHeaders(signature), WIRE_BODY)).ok).toBe(
      false,
    );
  });

  test("a token with no time claims is still accepted, and its body hash is the evidence", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "jwt", publicKeyPem },
    });
    const result = await verifier.verify(
      jwtHeaders(signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem)),
      WIRE_BODY,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delivery.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the same body under two unique keys produces the same hash", async () => {
    const verifier = createWebhookVerifier({
      key: { mode: "hmac", key: "secret" },
    });
    const first = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY, "secret"), "hmac", "key-1"),
      WIRE_BODY,
    );
    const second = await verifier.verify(
      hmacHeaders(hmacOf(WIRE_BODY, "secret"), "hmac", "key-2"),
      WIRE_BODY,
    );
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.delivery.eventId).not.toBe(second.delivery.eventId);
      expect(first.delivery.bodyHash).toBe(second.delivery.bodyHash);
    }
  });
});
