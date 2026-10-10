import { describe, expect, test } from "bun:test";
import { canonicalString, createAlipayProvider } from "../src/billing/payments/alipay";
import type { ChannelHttpConfig } from "../src/billing/payments/channel-http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * All channel tests run against a captured fake fetch — no socket is ever opened. The fixture
 * keys under ./fixtures are test-vector material (see ./fixtures/README.md).
 */
const fixtureDir = join(import.meta.dir, "fixtures");
const privateKeyPem = readFileSync(join(fixtureDir, "payment-test-key.pem"), "utf8");
const alipayPublicKeyPem = readFileSync(
  join(fixtureDir, "payment-test-certificate.pem"),
  "utf8",
);

const config: ChannelHttpConfig & {
  appId: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  gatewayUrl: string;
  now: () => Date;
} = {
  appId: "2021000100000000",
  privateKeyPem,
  alipayPublicKeyPem,
  gatewayUrl: "https://openapi.alipay.com",
  assertTarget: async () => undefined,
  now: () => new Date("2026-10-10T02:00:00Z"),
};

/** Sign a canonical string with the fixture key — stands in for Alipay's own platform key. */
function platformSign(canonical: string): string {
  // The platform's private key is not available; for the test vectors the platform role is
  // played by the same fixture pair, so verification runs against the certificate public key.
  const { rsaSign } = require("../src/billing/payments/crypto");
  return rsaSign(privateKeyPem, canonical);
}

function envelope(responseKey: string, inner: object): string {
  const innerText = JSON.stringify(inner);
  return JSON.stringify({
    [responseKey]: innerText,
    sign: platformSign(innerText),
    sign_type: "RSA2",
  });
}

function precreateResponse(order: Record<string, unknown>): string {
  return envelope("alipay_trade_precreate_response", {
    code: "10000",
    msg: "Success",
    out_trade_no: "po-abc",
    qr_code: "https://qr.alipay.com/bax000",
    trade_no: "202610102200140000",
    ...order,
  });
}

function formOf(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

describe("canonical string", () => {
  test("keys sort in ASCII order, sign and sign_type are stripped, values stay decoded", () => {
    expect(
      canonicalString({
        sign_type: "RSA2",
        total_amount: "88.00",
        app_id: "demo",
        sign: "ignored",
        method: "alipay.trade.precreate",
      }),
    ).toBe("app_id=demo&method=alipay.trade.precreate&total_amount=88.00");
  });

  test("a value that arrives encoded stays decoded exactly once", () => {
    // subject=OpenBot%20Pro decodes to "OpenBot Pro" and the canonical carries the decoded form.
    const form = new URLSearchParams("subject=OpenBot%20Pro&app_id=demo&sign=s");
    const parameters: Record<string, string> = {};
    for (const [key, value] of form) parameters[key] = value;
    expect(canonicalString(parameters)).toBe("app_id=demo&subject=OpenBot Pro");
  });
});

describe("request side (captured fetch)", () => {
  test("trade.precreate posts a signed form and answers a QR checkout", async () => {
    let captured: { url: string; body: string } | undefined;
    const provider = createAlipayProvider({
      ...config,
      fetch: (async (url: URL | string, init?: RequestInit) => {
        captured = { url: String(url), body: String(init?.body) };
        return new Response(precreateResponse({}), { status: 200 });
      }) as typeof fetch,
    });
    const session = await provider.createSession({
      outTradeNo: "po-abc",
      description: "OpenBot Pro · one month",
      amountCents: 8800,
      currency: "CNY",
      notifyUrl: "https://openbot.example/api/payments/callbacks/alipay",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect(session.checkout).toEqual({ kind: "qrcode", payload: "https://qr.alipay.com/bax000" });
    expect(session.channelOrderId).toBe("202610102200140000");
    expect(captured?.url).toBe("https://openapi.alipay.com/gateway.do");

    // The captured form re-parses: the public parameters are all present, the timestamp is the
    // gateway's shape, and the signature verifies over the canonical of the sent parameters.
    const parameters: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(captured?.body ?? "")) {
      parameters[key] = value;
    }
    expect(parameters.app_id).toBe("2021000100000000");
    expect(parameters.method).toBe("alipay.trade.precreate");
    expect(parameters.charset).toBe("utf-8");
    expect(parameters.version).toBe("1.0");
    expect(parameters.sign_type).toBe("RSA2");
    expect(parameters.timestamp).toBe("2026-10-10 10:00:00");
    const biz = JSON.parse(parameters.biz_content ?? "{}");
    expect(biz.out_trade_no).toBe("po-abc");
    expect(biz.total_amount).toBe("88.00");
    expect(biz.subject).toBe("OpenBot Pro · one month");
    expect(
      platformSign(canonicalString(parameters)) === parameters.sign,
    ).toBe(true);
  });

  test("an unsigned gateway response is refused, fail-closed", async () => {
    const provider = createAlipayProvider({
      ...config,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            alipay_trade_precreate_response: JSON.stringify({
              code: "10000",
              qr_code: "https://qr.alipay.com/x",
            }),
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await expect(
      provider.createSession({
        outTradeNo: "po-abc",
        description: "d",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/cb",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/invalid_response/);
  });

  test("a response signed over a sorted string (not the inner JSON) is refused", async () => {
    const inner = JSON.stringify({ code: "10000", qr_code: "https://qr.alipay.com/x" });
    const wrongSignature = platformSign("code=10000&qr_code=https://qr.alipay.com/x");
    const provider = createAlipayProvider({
      ...config,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            alipay_trade_precreate_response: inner,
            sign: wrongSignature,
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await expect(
      provider.createSession({
        outTradeNo: "po-abc",
        description: "d",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/cb",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/invalid_response/);
  });

  test("tampering one character inside the inner JSON breaks the signature", async () => {
    const inner = JSON.stringify({ code: "10000", qr_code: "https://qr.alipay.com/x" });
    const signature = platformSign(inner);
    const tampered = inner.replace("10000", "10001");
    const provider = createAlipayProvider({
      ...config,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            alipay_trade_precreate_response: tampered,
            sign: signature,
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await expect(
      provider.createSession({
        outTradeNo: "po-abc",
        description: "d",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/cb",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/invalid_response/);
  });

  test("a gateway business refusal (head.code != 10000) is invalid_response", async () => {
    const provider = createAlipayProvider({
      ...config,
      fetch: (async () =>
        new Response(
          envelope("alipay_trade_precreate_response", {
            code: "40004",
            msg: "Business Failed",
            sub_code: "ACQ.INVALID_PARAMETER",
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    await expect(
      provider.createSession({
        outTradeNo: "po-abc",
        description: "d",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/cb",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/invalid_response/);
  });

  test("a transport failure maps to the retryable unreachable sentinel", async () => {
    const provider = createAlipayProvider({
      ...config,
      fetch: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    await expect(
      provider.createSession({
        outTradeNo: "po-abc",
        description: "d",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/cb",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/unreachable/);
  });
});

describe("notification verification", () => {
  const provider = createAlipayProvider({ ...config, fetch: (async () => {
    throw new Error("never called");
  }) }) as ReturnType<typeof createAlipayProvider>;

  function notification(parameters: Record<string, string>): Request {
    return new Request("https://openbot.example/api/payments/callbacks/alipay", {
      method: "POST",
      body: formOf(parameters),
    });
  }

  async function verifiedNotification(
    parameters: Record<string, string>,
  ): Promise<{ ok: boolean; fact?: unknown }> {
    const signed = {
      gmt_create: "2026-10-10 10:00:00",
      gmt_payment: "2026-10-10 10:01:00",
      notify_type: "trade_status_sync",
      ...parameters,
    };
    const signedWithSignature = {
      ...signed,
      sign: platformSign(canonicalString(signed)),
      sign_type: "RSA2",
    };
    const request = notification(signedWithSignature);
    const raw = await request.text();
    return provider.verifyNotification(request.headers, raw) as Promise<{
      ok: boolean;
      fact?: unknown;
    }>;
  }

  test("a well-signed TRADE_SUCCESS notification yields a paid fact", async () => {
    const result = await verifiedNotification({
      app_id: "2021000100000000",
      out_trade_no: "po-abc",
      trade_no: "202610102200140000",
      trade_status: "TRADE_SUCCESS",
      total_amount: "88.00",
    });
    expect(result.ok).toBe(true);
    expect(result.fact).toMatchObject({
      outTradeNo: "po-abc",
      state: "paid",
      channelTransactionId: "202610102200140000",
      amountCents: 8800,
    });
  });

  test("TRADE_FINISHED is paid; WAIT_BUYER_PAY is pending; TRADE_CLOSED is closed", async () => {
    const finished = await verifiedNotification({
      app_id: "2021000100000000",
      out_trade_no: "po-a",
      trade_no: "t1",
      trade_status: "TRADE_FINISHED",
      total_amount: "88.00",
    });
    expect((finished.fact as { state: string }).state).toBe("paid");
    const waiting = await verifiedNotification({
      app_id: "2021000100000000",
      out_trade_no: "po-b",
      trade_status: "WAIT_BUYER_PAY",
      total_amount: "88.00",
    });
    expect((waiting.fact as { state: string }).state).toBe("pending");
    expect((waiting.fact as { channelTransactionId?: string }).channelTransactionId).toBeUndefined();
    const closed = await verifiedNotification({
      app_id: "2021000100000000",
      out_trade_no: "po-c",
      trade_status: "TRADE_CLOSED",
      total_amount: "88.00",
    });
    expect((closed.fact as { state: string }).state).toBe("closed");
  });

  test("an unrecognised trade_status is a pending fact, never an invented payment", async () => {
    const result = await verifiedNotification({
      app_id: "2021000100000000",
      out_trade_no: "po-d",
      trade_status: "SOMETHING_NEW",
      total_amount: "88.00",
    });
    expect((result.fact as { state: string }).state).toBe("pending");
  });

  test("a tampered amount fails verification", async () => {
    const parameters = {
      gmt_create: "2026-10-10 10:00:00",
      app_id: "2021000100000000",
      out_trade_no: "po-abc",
      trade_no: "t9",
      trade_status: "TRADE_SUCCESS",
      total_amount: "88.00",
    };
    const signed = {
      ...parameters,
      sign: platformSign(canonicalString(parameters)),
      sign_type: "RSA2",
    };
    // The signature covers 88.00; the wire carries 99.00.
    const tampered = { ...signed, total_amount: "99.00" };
    const request = notification(tampered);
    const raw = await request.text();
    const result = await provider.verifyNotification(request.headers, raw);
    expect(result.ok).toBe(false);
  });

  test("a notification for another app_id is refused even when well signed", async () => {
    const result = await verifiedNotification({
      app_id: "someone-elses-app",
      out_trade_no: "po-abc",
      trade_no: "t10",
      trade_status: "TRADE_SUCCESS",
      total_amount: "88.00",
    });
    expect(result.ok).toBe(false);
  });

  test("a notification stripped of its sign is refused", async () => {
    const request = notification({
      app_id: "2021000100000000",
      out_trade_no: "po-abc",
      trade_status: "TRADE_SUCCESS",
      total_amount: "88.00",
    });
    const raw = await request.text();
    const result = await provider.verifyNotification(request.headers, raw);
    expect(result.ok).toBe(false);
  });

  test("the success ack is exactly the wire's success word", () => {
    expect(provider.successAck).toEqual({
      body: "success",
      contentType: "text/plain",
    });
  });
});
