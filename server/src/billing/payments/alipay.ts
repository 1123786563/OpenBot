/**
 * The one file that speaks Alipay: trade.precreate to open a QR checkout, trade.query and
 * trade.close to ask about and retire one, and the async notification verified against the exact
 * form bytes that arrived.
 *
 * Two verifications, deliberately spelled differently, because the two surfaces differ:
 *
 * - The gateway's synchronous response is an envelope whose signature covers the *inner* JSON
 *   string exactly as the envelope carries it — `{"alipay_trade_precreate_response":"<json>","sign":
 *   "<b64>"}`. The signed body is that inner string verbatim: never re-serialised, never sorted,
 *   nothing stripped from inside it. A response without a top-level `sign` is refused outright
 *   (fail-closed): an unsigned success is not a success we can prove. This mirrors the Go
 *   implementation this seam descends from (WeKnora alipay.go's response verification).
 * - The async notification is a flat form whose signature covers the canonical string: every
 *   parameter except `sign` and `sign_type`, keys in ASCII order, joined `k=v&` with values as
 *   the form decoded them — never re-encoded.
 *
 * DEVIATION, on purpose and recorded here where the next reader will find it: `seller_id` is not
 * checked on notifications. The multi-merchant check matters when one gateway endpoint serves
 * many merchants; this deployment configures exactly one app_id, and the notification's `app_id`
 * IS checked against it — a notification naming any other app is refused before its trade state
 * is read.
 *
 * Only RSA2 is signed with and accepted from. The credential never reaches a message: every key
 * failure surfaces as the `unconfigured` sentinel from the crypto layer, and every wire refusal
 * as `invalid_response` or `unreachable` built here from the code alone.
 */
import { BillingError } from "../types";
import {
  amountStringToCents,
  rsaSign,
  rsaVerify,
} from "./crypto";
import { postForm, type ChannelHttpConfig } from "./channel-http";
import type {
  PaymentFact,
  PaymentProvider,
  PaymentSession,
  PaymentSessionInput,
} from "./provider";

const GATEWAY_PATH = "/gateway.do";

export type AlipayConfig = ChannelHttpConfig & {
  appId: string;
  privateKeyPem: string;
  alipayPublicKeyPem: string;
  gatewayUrl: string;
  /**
   * The wall clock, injectable: the request timestamp must be the wire's `yyyy-MM-dd HH:mm:ss`
   * shape, and a test pins it rather than sleeping past a minute boundary.
   */
  now?: () => Date;
};

/** The gateway's timestamp shape, in the +08:00 offset the gateway grades on. */
function gatewayTimestamp(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/**
 * The canonical string both verifications build: parameters minus `sign`/`sign_type`, keys in
 * ASCII order, joined `k=v&`, values exactly as decoded — never re-encoded.
 */
export function canonicalString(
  parameters: Record<string, string>,
): string {
  return Object.keys(parameters)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${parameters[key] ?? ""}`)
    .join("&");
}

function signParameters(
  parameters: Record<string, string>,
  privateKeyPem: string,
): Record<string, string> {
  return {
    ...parameters,
    sign_type: "RSA2",
    sign: rsaSign(privateKeyPem, canonicalString(parameters)),
  };
}

function encodeForm(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Parse one envelope, and verify it over the inner JSON string's exact bytes. */
function verifyEnvelope(
  envelopeText: string,
  responseKey: string,
  alipayPublicKeyPem: string,
): Record<string, unknown> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new BillingError("invalid_response");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new BillingError("invalid_response");
  }
  const record = envelope as Record<string, unknown>;
  const inner = record[responseKey];
  const signature = record.sign;
  if (typeof inner !== "string" || typeof signature !== "string") {
    // No signature at all is fail-closed, not a pass-through: an unsigned response proves
    // nothing, whatever its `code` claims.
    throw new BillingError("invalid_response");
  }
  if (!rsaVerify(alipayPublicKeyPem, inner, signature)) {
    throw new BillingError("invalid_response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    throw new BillingError("invalid_response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BillingError("invalid_response");
  }
  return parsed as Record<string, unknown>;
}

/** The gateway's own verdict inside a verified response: 10000 or nothing. */
function requireSuccess(response: Record<string, unknown>): void {
  const head = response.head;
  const verdict: Record<string, unknown> =
    head && typeof head === "object" && !Array.isArray(head)
      ? (head as Record<string, unknown>)
      : response;
  if (verdict.code !== "10000") {
    throw new BillingError("invalid_response");
  }
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function createAlipayProvider(config: AlipayConfig): PaymentProvider {
  const gateway = config.gatewayUrl.replace(/\/+$/, "");
  const now = config.now ?? (() => new Date());

  function buildRequest(
    method: string,
    bizContent: Record<string, unknown>,
    notifyUrl?: string,
  ): string {
    const parameters: Record<string, string> = {
      app_id: config.appId,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: gatewayTimestamp(now()),
      version: "1.0",
      biz_content: JSON.stringify(bizContent),
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    };
    return encodeForm(signParameters(parameters, config.privateKeyPem));
  }

  return {
    id: "alipay",

    async createSession(input: PaymentSessionInput): Promise<PaymentSession> {
      const text = await postForm(
        config,
        new URL(`${gateway}${GATEWAY_PATH}`),
        buildRequest(
          "alipay.trade.precreate",
          {
            out_trade_no: input.outTradeNo,
            total_amount: (input.amountCents / 100).toFixed(2),
            subject: input.description,
            timeout_express: `${Math.max(
              1,
              Math.ceil((input.expiresAt.getTime() - Date.now()) / 60_000),
            )}m`,
          },
          input.notifyUrl,
        ),
      );
      const response = verifyEnvelope(
        text,
        "alipay_trade_precreate_response",
        config.alipayPublicKeyPem,
      );
      requireSuccess(response);
      const qrCode = stringField(response, "qr_code");
      if (!qrCode) throw new BillingError("invalid_response");
      return {
        checkout: { kind: "qrcode", payload: qrCode },
        channelOrderId: stringField(response, "trade_no"),
      };
    },

    async queryPayment(outTradeNo: string): Promise<PaymentFact> {
      const text = await postForm(
        config,
        new URL(`${gateway}${GATEWAY_PATH}`),
        buildRequest("alipay.trade.query", { out_trade_no: outTradeNo }),
      );
      const response = verifyEnvelope(
        text,
        "alipay_trade_query_response",
        config.alipayPublicKeyPem,
      );
      // ACQ.TRADE_NOT_EXIST is the gateway's terminal "no such order" verdict (code 40004): a
      // fact, not a malfunction. Spelled as a closed fact so the sweeper can expire the local
      // order instead of re-asking a question the gateway has already answered forever — every
      // other non-10000 verdict (a system error, a transient refusal) still throws below and
      // stays a skip-and-retry for the next pass.
      if (
        stringField(response, "code") === "40004" &&
        stringField(response, "sub_code") === "ACQ.TRADE_NOT_EXIST"
      ) {
        return { outTradeNo, state: "closed" };
      }
      requireSuccess(response);
      return alipayFact(response, outTradeNo);
    },

    async closePayment(outTradeNo: string): Promise<void> {
      const text = await postForm(
        config,
        new URL(`${gateway}${GATEWAY_PATH}`),
        buildRequest("alipay.trade.close", { out_trade_no: outTradeNo }),
      );
      const response = verifyEnvelope(
        text,
        "alipay_trade_close_response",
        config.alipayPublicKeyPem,
      );
      // The gateway refuses to close an order it has already settled (ACQ.TRADE_HAS_SUCCESS and
      // friends): from here that is not a network failure but a verdict the next query will
      // surface, so it is the terminal sentinel and the sweeper lets the next pass decide.
      requireSuccess(response);
    },

    async verifyNotification(
      _headers: Headers,
      rawBody: string,
    ): Promise<{ ok: true; fact: PaymentFact } | { ok: false }> {
      // The form is parsed exactly once, from the raw bytes; every check below reads that parse.
      const parameters: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawBody)) {
        parameters[key] = value;
      }
      const signature = parameters.sign;
      if (!signature) return { ok: false };
      if (!rsaVerify(config.alipayPublicKeyPem, canonicalString(parameters), signature)) {
        return { ok: false };
      }
      // The app id is the one merchant identity this deployment owns; anything else is not our
      // notification, however well signed for someone else.
      if (parameters.app_id !== config.appId) return { ok: false };
      const outTradeNo = stringField(parameters, "out_trade_no");
      if (!outTradeNo) return { ok: false };
      return { ok: true, fact: alipayFact(parameters, outTradeNo) };
    },

    successAck: { body: "success", contentType: "text/plain" },
  };
}

/**
 * The fact a verified Alipay surface (query response or notification) states, in seam words.
 * The amount is converted through the exact-decimal path and dropped when it is not a number we
 * can hold — the service compares it against the order's snapshot, so an unreadable amount can
 * never silently pass as a match.
 */
function alipayFact(
  record: Record<string, unknown>,
  outTradeNo: string,
): PaymentFact {
  const tradeStatus = stringField(record, "trade_status") ?? "";
  const state: PaymentFact["state"] =
    tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED"
      ? "paid"
      : tradeStatus === "WAIT_BUYER_PAY"
        ? "pending"
        : tradeStatus === "TRADE_CLOSED"
          ? "closed"
          : // An unrecognised status is a pending fact: never an invented payment, never an
            // invented closure — the query loop re-asks, the notification answered 409.
            "pending";
  const totalAmount = stringField(record, "total_amount");
  const amountCents = totalAmount === undefined ? undefined : amountStringToCents(totalAmount);
  return {
    outTradeNo,
    state,
    channelTransactionId: stringField(record, "trade_no"),
    ...(amountCents !== null && amountCents !== undefined ? { amountCents } : {}),
    currency: "CNY",
  };
}
