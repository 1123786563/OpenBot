import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createCipheriv, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WechatConfig } from "../src/billing/payments/wechat";
import { createWechatProvider } from "../src/billing/payments/wechat";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

/*
 * WeChat Pay v3 against captured fetches and self-made vectors: the platform certificate role is
 * played by the fixture certificate (./fixtures/README.md), so callback verification runs a real
 * RSA check and a real AES-256-GCM decryption. No socket opens.
 */
const fixtureDir = join(hereDir, "fixtures");
const merchantKey = readFileSync(
  join(fixtureDir, "payment-test-key.pem"),
  "utf8",
);
const platformCert = readFileSync(
  join(fixtureDir, "payment-test-certificate.pem"),
  "utf8",
);
const { rsaSign, certificateSerial } =
  require("../src/billing/payments/crypto") as {
    rsaSign: (key: string, canonical: string) => string;
    certificateSerial: (pem: string) => string;
  };

const apiv3Key = "0123456789abcdef0123456789abcdef"; // 32 bytes, test-only
const PLATFORM_SERIAL = certificateSerial(platformCert);
const MERCHANT_SERIAL = "merchant-serial-0001";
const NOW = 1_791_900_000; // fixed epoch second

const config: WechatConfig = {
  mchid: "1900000001",
  appid: "wx0000000000000000",
  apiv3Key,
  merchantSerialNo: MERCHANT_SERIAL,
  merchantPrivateKeyPem: merchantKey,
  platformCertificates: [platformCert],
  gatewayUrl: "https://api.mch.weixin.qq.com",
  skewSeconds: 300,
  assertTarget: async () => undefined,
  nowSeconds: () => NOW,
  nonce: () => "nonce-nonce-nonce",
};

/** Sign the way the platform would, with the fixture key over the callback canonical. */
function platformSign(timestamp: string, nonce: string, body: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(`${timestamp}\n${nonce}\n${body}\n`);
  return signer.sign(merchantKey, "base64");
}

/** Build a signed, encrypted callback request body and headers. */
function callback(
  resource: Record<string, unknown>,
  options: {
    timestamp?: string;
    nonce?: string;
    serial?: string;
    key?: Buffer;
    /** The AAD the resource is encrypted under. */
    aad?: string;
    /** What the envelope CLAIMS the AAD was; defaults to the real one. Diverge to test refusal. */
    envelopeAad?: string;
  } = {},
): { headers: Headers; body: string } {
  const timestamp = options.timestamp ?? String(NOW);
  const nonce = options.nonce ?? "callback-nonce";
  const serial = options.serial ?? PLATFORM_SERIAL;
  const key = options.key ?? Buffer.from(apiv3Key, "utf8");
  const aad = options.aad ?? "transaction";
  const claimedAad = options.envelopeAad ?? aad;

  const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(nonce, "utf8"));
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plain = JSON.stringify(resource);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]).toString(
    "base64",
  );

  const raw = JSON.stringify({
    id: "evt-1",
    event_type: "TRANSACTION.SUCCESS",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      ciphertext,
      associated_data: claimedAad,
      nonce,
    },
  });
  const headers = new Headers({
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": nonce,
    "wechatpay-signature": platformSign(timestamp, nonce, raw),
    "wechatpay-serial": serial,
  });
  return { headers, body: raw };
}

const settledResource = {
  mchid: "1900000001",
  appid: "wx0000000000000000",
  out_trade_no: "po-abc",
  transaction_id: "4200001234202610100000000000",
  trade_state: "SUCCESS",
  amount: { total: 8800, currency: "CNY" },
};

function providerWith(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof createWechatProvider> {
  return createWechatProvider({
    ...config,
    fetch: (async (url: URL | string, init?: RequestInit) =>
      handler(
        url instanceof URL ? url : new URL(String(url)),
        init ?? {},
      )) as typeof fetch,
  });
}

describe("request side (captured fetch)", () => {
  test("native order posts the merchant body and answers a code_url checkout", async () => {
    let captured: { url: URL; authorization: string; body: string } | undefined;
    const provider = providerWith((url, init) => {
      captured = {
        url,
        authorization: String(
          (init.headers as Record<string, string>).authorization,
        ),
        body: String(init.body),
      };
      return new Response(
        JSON.stringify({ code_url: "weixin://wxpay/bazook" }),
        {
          status: 200,
        },
      );
    });
    const session = await provider.createSession({
      outTradeNo: "po-abc",
      description: "OpenBot Pro · one month",
      amountCents: 8800,
      currency: "CNY",
      notifyUrl: "https://openbot.example/api/payments/callbacks/wechat",
      expiresAt: new Date(NOW * 1000 + 15 * 60_000),
    });
    expect(session.checkout).toEqual({
      kind: "qrcode",
      payload: "weixin://wxpay/bazook",
    });
    expect(captured?.url.toString()).toBe(
      "https://api.mch.weixin.qq.com/v3/pay/transactions/native",
    );
    const body = JSON.parse(captured?.body ?? "{}");
    expect(body).toMatchObject({
      appid: "wx0000000000000000",
      mchid: "1900000001",
      out_trade_no: "po-abc",
      notify_url: "https://openbot.example/api/payments/callbacks/wechat",
    });
    expect(body.amount).toEqual({ total: 8800, currency: "CNY" });
    expect(body.time_expire).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,
    );

    // The Authorization header re-derives: same canonical, same signature.
    const authorization = captured?.authorization ?? "";
    expect(authorization.startsWith("WECHATPAY2-SHA256-RSA2048 ")).toBe(true);
    const mchid = /mchid="([^"]+)"/.exec(authorization)?.[1];
    const nonce = /nonce_str="([^"]+)"/.exec(authorization)?.[1];
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1];
    const timestamp = /timestamp="([^"]+)"/.exec(authorization)?.[1];
    const serial = /serial_no="([^"]+)"/.exec(authorization)?.[1];
    expect(mchid).toBe("1900000001");
    expect(serial).toBe(MERCHANT_SERIAL);
    expect(timestamp).toBe(String(NOW));
    const canonical = `POST\n/v3/pay/transactions/native\n${timestamp}\n${nonce}\n${captured?.body}\n`;
    expect(rsaSign(merchantKey, canonical)).toBe(signature);
  });

  test("query maps trade_state SUCCESS to a paid fact with integer cents", async () => {
    const provider = providerWith(
      () =>
        new Response(
          JSON.stringify({
            out_trade_no: "po-abc",
            transaction_id: "4200001234202610100000000000",
            trade_state: "SUCCESS",
            amount: { total: 8800, currency: "CNY" },
          }),
          { status: 200 },
        ),
    );
    const fact = await provider.queryPayment("po-abc");
    expect(fact).toMatchObject({
      outTradeNo: "po-abc",
      state: "paid",
      channelTransactionId: "4200001234202610100000000000",
      amountCents: 8800,
      currency: "CNY",
    });
  });

  test("a query stating a foreign amount currency carries it; one naming none stays silent", async () => {
    // The wire's own word kept verbatim (audit A5): a resource that says USD keeps USD for the
    // settlement gate to refuse, and a resource naming no currency states none — the adapter no
    // longer filters the field down to CNY.
    const foreign = providerWith(
      () =>
        new Response(
          JSON.stringify({
            out_trade_no: "po-abc",
            transaction_id: "4200001234202610100000000000",
            trade_state: "SUCCESS",
            amount: { total: 8800, currency: "USD" },
          }),
          { status: 200 },
        ),
    );
    expect((await foreign.queryPayment("po-abc")).currency).toBe("USD");
    const silent = providerWith(
      () =>
        new Response(
          JSON.stringify({
            out_trade_no: "po-abc",
            transaction_id: "4200001234202610100000000000",
            trade_state: "SUCCESS",
            amount: { total: 8800 },
          }),
          { status: 200 },
        ),
    );
    expect((await silent.queryPayment("po-abc")).currency).toBeUndefined();
  });

  test("query maps NOTPAY to pending and CLOSED to closed", async () => {
    const provider = providerWith((url) => {
      if (String(url).includes("po-open")) {
        return new Response(JSON.stringify({ trade_state: "NOTPAY" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ trade_state: "CLOSED" }), {
        status: 200,
      });
    });
    expect((await provider.queryPayment("po-open")).state).toBe("pending");
    expect((await provider.queryPayment("po-shut")).state).toBe("closed");
  });

  test("an unknown trade_state stays pending — never an invented payment", async () => {
    const provider = providerWith(
      () =>
        new Response(JSON.stringify({ trade_state: "SOMETHING_NEW" }), {
          status: 200,
        }),
    );
    expect((await provider.queryPayment("po-x")).state).toBe("pending");
  });

  test("a 404 is the channel's 'no such order' verdict: a closed fact, not an error", async () => {
    // Both spellings the gate hands back: an empty body and a JSON error body. The status line
    // is the verdict, so the sweeper can expire the stranded order either way.
    const empty = providerWith(() => new Response("", { status: 404 }));
    expect(await empty.queryPayment("po-abc")).toEqual({
      outTradeNo: "po-abc",
      state: "closed",
    });
    const withBody = providerWith(
      () =>
        new Response(JSON.stringify({ code: "ORDER_NOT_EXIST" }), {
          status: 404,
        }),
    );
    expect(await withBody.queryPayment("po-abc")).toEqual({
      outTradeNo: "po-abc",
      state: "closed",
    });
  });

  test("a 429/5xx gateway answers unreachable (retryable)", async () => {
    const provider = providerWith(
      () => new Response("slow down", { status: 429 }),
    );
    await expect(provider.queryPayment("po-abc")).rejects.toThrow(
      /unreachable/,
    );
  });

  test("a non-JSON 2xx answers invalid_response", async () => {
    const provider = providerWith(
      () => new Response("<html>bad gateway</html>", { status: 200 }),
    );
    await expect(provider.queryPayment("po-abc")).rejects.toThrow(
      /invalid_response/,
    );
  });
});

describe("callback verification (four headers + GCM)", () => {
  const provider = createWechatProvider(config);

  async function verified(
    resource: Record<string, unknown>,
    options?: Parameters<typeof callback>[1],
  ): Promise<{ ok: boolean; fact?: unknown }> {
    const { headers, body } = callback(resource, options);
    return provider.verifyNotification(headers, body) as Promise<{
      ok: boolean;
      fact?: unknown;
    }>;
  }

  test("a well-signed, well-encrypted SUCCESS callback verifies to a paid fact", async () => {
    const result = await verified(settledResource);
    expect(result.ok).toBe(true);
    expect(result.fact).toMatchObject({
      outTradeNo: "po-abc",
      state: "paid",
      channelTransactionId: "4200001234202610100000000000",
      amountCents: 8800,
    });
  });

  test("a missing header is refused", async () => {
    const { headers, body } = callback(settledResource);
    const stripped = new Headers(headers);
    stripped.delete("wechatpay-serial");
    expect((await provider.verifyNotification(stripped, body)).ok).toBe(false);
  });

  test("a stale timestamp outside the skew window is refused before crypto", async () => {
    const result = await verified(settledResource, {
      timestamp: String(NOW - 3600),
    });
    expect(result.ok).toBe(false);
  });

  test("a future timestamp outside the skew window is refused too", async () => {
    const result = await verified(settledResource, {
      timestamp: String(NOW + 3600),
    });
    expect(result.ok).toBe(false);
  });

  test("an unknown platform serial is refused, even with a valid signature from another key", async () => {
    const result = await verified(settledResource, {
      serial: "unknown-serial",
    });
    expect(result.ok).toBe(false);
  });

  test("a signature from a key the serial does not name is refused", async () => {
    const { headers, body } = callback(settledResource);
    const timestamp = headers.get("wechatpay-timestamp") ?? "";
    const nonce = headers.get("wechatpay-nonce") ?? "";
    const foreign = createSign("RSA-SHA256");
    foreign.update(`${timestamp}\n${nonce}\n${body}\n`);
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = createSign("RSA-SHA256");
    signer.update(`${timestamp}\n${nonce}\n${body}\n`);
    const wrong = signer.sign(
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      "base64",
    );
    const tampered = new Headers(headers);
    tampered.set("wechatpay-signature", wrong);
    void foreign;
    expect((await provider.verifyNotification(tampered, body)).ok).toBe(false);
  });

  test("a tampered body breaks the signature", async () => {
    const { headers, body } = callback(settledResource);
    const tampered = body.replace("SUCCESS", "SUCCESS ");
    expect((await provider.verifyNotification(headers, tampered)).ok).toBe(
      false,
    );
  });

  test("a wrong APIv3 key fails decryption", async () => {
    const result = await verified(settledResource, {
      key: Buffer.alloc(32, 9),
    });
    expect(result.ok).toBe(false);
  });

  test("a mismatched AAD fails decryption", async () => {
    // Encrypted under "transaction", the envelope claims "refund": the GCM authentication fails.
    const result = await verified(settledResource, {
      aad: "transaction",
      envelopeAad: "refund",
    });
    expect(result.ok).toBe(false);
  });

  test("a resource for another mchid is refused after correct verification", async () => {
    const result = await verified({ ...settledResource, mchid: "1900000002" });
    expect(result.ok).toBe(false);
  });

  test("a resource for another appid is refused after correct verification", async () => {
    const result = await verified({
      ...settledResource,
      appid: "wx9999999999999999",
    });
    expect(result.ok).toBe(false);
  });

  test("the success ack is exactly the wire's success JSON", () => {
    expect(provider.successAck).toEqual({
      body: '{"code":"SUCCESS"}',
      contentType: "application/json",
    });
  });
});
