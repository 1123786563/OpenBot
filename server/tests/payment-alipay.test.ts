import { describe, expect, test } from "../../tests/support/e2e-compat";
import { checkOutboundUrl } from "../src/billing/outbound";
import {
  canonicalString,
  createAlipayProvider,
} from "../src/billing/payments/alipay";
import { rsaSign } from "../src/billing/payments/crypto";
import { BillingError } from "../src/billing/types";

// Fixture RSA pair under ./fixtures — the same material the crypto tests sign with. The platform
// role (signing gateway answers) is played by the same pair.
const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;
const privateKeyPem = await Bun.file(
  join(fixtureDir, "payment-test-key.pem"),
).text();
const certificatePem = await Bun.file(
  join(fixtureDir, "payment-test-certificate.pem"),
).text();

import { join } from "node:path";

function joinFixtures(f: string) {
  return join(fixtureDir, f);
}
void joinFixtures;

const platformSign = (canonical: string) => rsaSign(privateKeyPem, canonical);

function providerWith(
  run: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  return createAlipayProvider({
    appId: "2021000100000000",
    privateKeyPem,
    alipayPublicKeyPem: certificatePem,
    gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com",
    sdk: { run },
    now: () => new Date("2026-10-10T02:00:00Z"),
  });
}

/** The sandbox's answer shape for a successful business call. */
function ok(extra: Record<string, unknown> = {}) {
  return { code: "10000", msg: "Success", ...extra };
}

describe("createAlipayProvider over the SDK transport", () => {
  test("createSession opens a QR checkout and reports the channel order id", async () => {
    let seen: { method: string; params: Record<string, unknown> } | undefined;
    const provider = providerWith(async (method, params) => {
      seen = { method, params };
      return ok({
        out_trade_no: "po-abc",
        qr_code: "https://qr.alipay.com/bax000",
        trade_no: "202610102200140000",
      });
    });
    const session = await provider.createSession({
      outTradeNo: "po-abc",
      description: "OpenBot Pro · one month",
      amountCents: 8800,
      currency: "CNY",
      notifyUrl: "https://openbot.example/api/payments/callbacks/alipay",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    expect(session.checkout).toEqual({
      kind: "qrcode",
      payload: "https://qr.alipay.com/bax000",
    });
    expect(session.channelOrderId).toBe("202610102200140000");
    expect(seen?.method).toBe("alipay.trade.precreate");
    const biz = seen?.params.bizContent as Record<string, unknown>;
    expect(biz.out_trade_no).toBe("po-abc");
    expect(biz.total_amount).toBe("88.00");
    expect(biz.subject).toBe("OpenBot Pro · one month");
    expect(seen?.params.notify_url).toBe(
      "https://openbot.example/api/payments/callbacks/alipay",
    );
  });

  test("a business refusal from the gateway is the terminal invalid_response", async () => {
    const provider = providerWith(async () => ({
      code: "40002",
      msg: "Invalid Arguments",
      sub_code: "isv.invalid-signature",
    }));
    const error = await provider
      .createSession({
        outTradeNo: "po-abc",
        description: "x",
        amountCents: 100,
        currency: "CNY",
        notifyUrl: "https://openbot.example/api/payments/callbacks/alipay",
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).code).toBe("invalid_response");
  });

  test("queryPayment maps ACQ.TRADE_NOT_EXIST to a closed fact, not an error", async () => {
    const provider = providerWith(async () => ({
      code: "40004",
      msg: "Business Failed",
      sub_code: "ACQ.TRADE_NOT_EXIST",
    }));
    const fact = await provider.queryPayment("po-missing");
    expect(fact.state).toBe("closed");
  });

  test("queryPayment reads WAIT_BUYER_PAY as pending with the amount for the snapshot check", async () => {
    const provider = providerWith(async () =>
      ok({
        out_trade_no: "po-abc",
        trade_status: "WAIT_BUYER_PAY",
        total_amount: "1.00",
        trade_no: "202610102200140000",
      }),
    );
    const fact = await provider.queryPayment("po-abc");
    expect(fact.state).toBe("pending");
    expect(fact.amountCents).toBe(100);
  });

  test("closePayment accepts the gateway's success", async () => {
    const provider = providerWith(async () => ok({ out_trade_no: "po-abc" }));
    await provider.closePayment("po-abc");
  });

  test("a raise carrying no verdict fields is the retryable unreachable", async () => {
    const provider = providerWith(async () => {
      throw new Error("socket hang up");
    });
    const error = await provider.queryPayment("po-abc").then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).code).toBe("unreachable");
    expect((error as BillingError).retryable).toBe(true);
  });

  test("the precreate amount is the exact decimal, not a float division", async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = providerWith(async (_method, params) => {
      calls.push(params.bizContent as Record<string, unknown>);
      return { code: "10000", qr_code: "https://qr.alipay.com/x" };
    });
    for (const [cents] of [
      [1, "0.01"],
      [1099, "10.99"],
      [12850, "128.50"],
      [4900, "49.00"],
      [2147483647, "21474836.47"],
    ] as const) {
      await provider.createSession({
        outTradeNo: `po-${cents}`,
        description: "test",
        amountCents: cents,
        currency: "CNY",
        notifyUrl: "https://example.test/cb",
        expiresAt: new Date(Date.now() + 900_000),
      });
    }
    expect(calls.map((call) => call.total_amount)).toEqual([
      "0.01",
      "10.99",
      "128.50",
      "49.00",
      "21474836.47",
    ]);
  });

  test("a non-integer cent amount is refused rather than rounded onto the wire", async () => {
    const provider = providerWith(async () => ({
      code: "10000",
      qr_code: "x",
    }));
    await expect(
      provider.createSession({
        outTradeNo: "po-1",
        description: "test",
        amountCents: 10.5,
        currency: "CNY",
        notifyUrl: "https://example.test/cb",
        expiresAt: new Date(Date.now() + 900_000),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("the notification verifier", () => {
  const PARAMETERS = {
    app_id: "2021000100000000",
    out_trade_no: "po-abc",
    trade_status: "TRADE_SUCCESS",
    total_amount: "1.00",
    trade_no: "202610102200140000",
  };

  function signedBody(extra: Record<string, string> = {}) {
    const parameters: Record<string, string> = {
      ...PARAMETERS,
      ...extra,
      gmt_payment: "2026-10-10 12:00:00",
    };
    const sign = platformSign(canonicalString(parameters));
    return new URLSearchParams({ ...parameters, sign }).toString();
  }

  function verifierOver(body: string) {
    const provider = providerWith(async () => ok({}));
    return provider.verifyNotification(new Headers(), body);
  }

  test("a correctly signed TRADE_SUCCESS notification verifies to a paid fact", async () => {
    const result = await verifierOver(signedBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fact.state).toBe("paid");
      expect(result.fact.amountCents).toBe(100);
      expect(result.fact.outTradeNo).toBe("po-abc");
    }
  });

  test("a notification naming a settlement currency carries it verbatim; silence stays silent", async () => {
    // The wire's own word, both spellings (audit A5): a cross-border trade states its currency
    // directly or as trans_currency, and a notification naming neither states none — the adapter
    // must not launder that silence into a CNY the wire never claimed.
    const stated = await verifierOver(signedBody({ currency: "USD" }));
    expect(stated.ok).toBe(true);
    if (stated.ok) expect(stated.fact.currency).toBe("USD");
    const crossBorder = await verifierOver(
      signedBody({ trans_currency: "USD" }),
    );
    expect(crossBorder.ok).toBe(true);
    if (crossBorder.ok) expect(crossBorder.fact.currency).toBe("USD");
    const silent = await verifierOver(signedBody());
    expect(silent.ok).toBe(true);
    if (silent.ok) expect(silent.fact.currency).toBeUndefined();
  });

  test("a tampered amount breaks the signature and is refused", async () => {
    const body = signedBody();
    const tampered = new URLSearchParams(body);
    tampered.set("total_amount", "999.00");
    tampered.set(
      "sign",
      platformSign(
        canonicalString(Object.fromEntries(tampered)).replace("999.00", "1.00"),
      ),
    );
    // Re-sign with the WRONG canonical (the untampered amounts) — the amount was swapped after
    // signing, which is the attack the verification exists to refuse.
    const forged = new URLSearchParams(body);
    forged.set("total_amount", "999.00");
    const result = await verifierOver(forged.toString());
    expect(result.ok).toBe(false);
    void tampered;
  });

  test("a notification naming another app is refused", async () => {
    const result = await verifierOver(
      signedBody({ app_id: "2021999999999999" }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("the SSRF floor stays wired for assembly", () => {
  test("the outbound floor still refuses loopback without the opt-in", async () => {
    const verdict = await checkOutboundUrl(
      "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
      { resolveDns: async () => [{ address: "127.0.0.1" }] },
    );
    expect(verdict.allowed).toBe(false);
  });
});
