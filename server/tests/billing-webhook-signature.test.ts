import { describe, expect, test } from "bun:test";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
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

const WIRE_BODY = JSON.stringify({
  event_id: "evt-1",
  webhook_type: "customer.created",
  object_id: "lago-customer-1",
  external_customer_id: "deployment-1",
});
const WIRE_PAYLOAD = JSON.parse(WIRE_BODY);

function jwtHeaders(jwt: string, algorithm?: string): Headers {
  const headers = new Headers({ "x-lago-signature": jwt });
  if (algorithm !== undefined) {
    headers.set("x-lago-signature-algorithm", algorithm);
  }
  return headers;
}

function hmacHeaders(signature: string, algorithm = "hmac"): Headers {
  return new Headers({
    "x-lago-signature": signature,
    "x-lago-signature-algorithm": algorithm,
  });
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

  test("accepts a correctly signed delivery and reads it", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({
      ok: true,
      delivery: {
        eventId: "evt-1",
        webhookType: "customer.created",
        objectId: "lago-customer-1",
        externalCustomerId: "deployment-1",
      },
    });
  });

  test("accepts the same delivery without the algorithm header (jwt is the default)", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const result = await verifier.verify(
      new Headers({ "x-lago-signature": jwt }),
      WIRE_BODY,
    );
    expect(result).toMatchObject({ ok: true });
  });

  test("refuses a tampered payload under a valid signature", async () => {
    const jwt = signDeliveryLikeProvider(WIRE_PAYLOAD, privateKeyPem);
    const [h, , s] = jwt.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        data: JSON.stringify({ ...WIRE_PAYLOAD, event_id: "evt-evil" }),
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
    const jwt = signDeliveryLikeProvider(
      { event_id: "evt-1", webhook_type: "customer.created" },
      privateKeyPem,
    );
    const result = await verifier.verify(jwtHeaders(jwt), WIRE_BODY);
    expect(result).toEqual({ ok: false });
  });

  test("treats member order in `data` as irrelevant (JSON semantics, not bytes)", async () => {
    const reordered = JSON.stringify({
      external_customer_id: "deployment-1",
      object_id: "lago-customer-1",
      webhook_type: "customer.created",
      event_id: "evt-1",
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
    expect(await verifier.verify(new Headers({}), WIRE_BODY)).toEqual({
      ok: false,
    });
  });

  test("refuses a body that is not the provider's payload shape", async () => {
    const body = JSON.stringify({ event_id: "evt-1" });
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
      delivery: {
        eventId: "evt-1",
        webhookType: "customer.created",
        objectId: "lago-customer-1",
        externalCustomerId: "deployment-1",
      },
    });
  });

  test("(b) a `data` string whose JSON is not the raw body is refused", async () => {
    const jwt = manuallySigned(
      {
        data: JSON.stringify({
          event_id: "evt-1",
          webhook_type: "customer.created",
        }),
      },
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
    expect(result).toMatchObject({
      ok: true,
      delivery: { eventId: "evt-1", webhookType: "customer.created" },
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
