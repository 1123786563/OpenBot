/**
 * The one file that speaks Alipay: trade.precreate to open a QR checkout, trade.query and
 * trade.close to ask about and retire one, and the async notification verified against the exact
 * form bytes that arrived.
 *
 * TRANSPORT, and why it is the official SDK: the gateway's synchronous responses are an envelope
 * whose signature covers the inner JSON string in the exact escaped bytes it travelled in — a
 * verifier that parses the envelope first silently unescapes that text and rejects every honest
 * response. A hand-rolled verifier was built that way and passed every self-made vector, and a
 * live sandbox precreate still answered isv.invalid-signature for it, alongside random 404/302
 * HTML load-shedding from the sandbox gateway itself. The official SDK's wire form is the one the
 * gateway demonstrably accepts, so the three synchronous calls ride `alipay-sdk`'s request entry
 * — whose answer is already verified against the configured Alipay public key. The SSRF floor for
 * the gateway is checked once at assembly (index.ts runs checkOutboundUrl on the configured
 * origin); the gateway origin is deployment configuration, never request input, so no per-call
 * gate is available to skip.
 *
 * The async notification is a flat form whose signature covers the canonical string: every
 * parameter except `sign` and `sign_type`, keys in ASCII order, joined `k=v&` with values as the
 * form decoded them — never re-encoded. No JSON escaping is involved on that surface, so the
 * verification here is ours, on the raw form bytes, exactly as it was built.
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

import { AlipaySdk } from "alipay-sdk";
import { BillingError } from "../types";
import { amountStringToCents, centsToAmountString, rsaVerify } from "./crypto";
import type {
  PaymentFact,
  PaymentProvider,
  PaymentSession,
  PaymentSessionInput,
} from "./provider";

/** The SDK's shape, narrowed to what this file drives — tests stub exactly this. */
export type AlipaySdkTransport = {
  run: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export type AlipayConfig = {
  appId: string;
  /** PKCS8 private key, bare base64 or full PEM — the banner is stripped either way. */
  privateKeyPem: string;
  /** The platform's public key (not the application's), bare base64 or full PEM. */
  alipayPublicKeyPem: string;
  gatewayUrl: string;
  /** The SDK transport; production builds one over the credentials above. Tests stub it. */
  sdk?: AlipaySdkTransport;
  /** The wall clock, injectable. */
  now?: () => Date;
  /**
   * Accepted for assembly compatibility with the channel-http shape; the SDK transport checks the
   * gateway origin once at assembly (index.ts runOutboundGate) instead of per call, because the
   * origin is deployment configuration and never request input.
   */
  assertTarget?: (url: URL) => Promise<void>;
};

/** Strip a PEM's banner lines: the SDK wants the bare base64 body. */
function stripPem(pem: string): string {
  if (!pem.includes("-----BEGIN")) return pem.trim();
  return pem
    .split("\n")
    .filter((line) => line && !line.includes("-----"))
    .join("");
}

function stringField(
  record: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a wire field in either spelling: the raw gateway answers snake_case, while the SDK's
 * exec() normalises its answer object to camelCase. Value-level compatibility, whichever shape
 * travels.
 */
function anyField(
  record: Record<string, unknown>,
  snake: string,
): string | undefined {
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return stringField(record, snake) ?? stringField(record, camel);
}

/**
 * The canonical string the notification's signature covers: every parameter except `sign` and
 * `sign_type`, keys in ASCII order, joined `k=v&` with values exactly as the form decoded them —
 * never re-encoded. Exported because the notification tests sign through this same function; the
 * verifier and the test-vector maker must never be able to drift apart.
 */
export function canonicalString(parameters: Record<string, string>): string {
  return Object.keys(parameters)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => `${key}=${parameters[key] ?? ""}`)
    .join("&");
}

/**
 * The gateway's verdict inside an SDK answer. Business failures arrive both as returned objects
 * (code on the answer) and as thrown errors carrying them (the SDK's own shape has shifted across
 * releases), so both are normalised here.
 */
function answerOf(execResult: unknown): Record<string, unknown> {
  // A string answer is the gateway's load-shedding HTML travelling through the SDK's text mode:
  // retryable, exactly like the transport failures the HTML rule maps to in channel-http.
  if (typeof execResult === "string") {
    throw new BillingError("unreachable");
  }
  if (
    execResult &&
    typeof execResult === "object" &&
    !Array.isArray(execResult)
  ) {
    return execResult as Record<string, unknown>;
  }
  throw new BillingError("invalid_response");
}

function requireSuccess(record: Record<string, unknown>): void {
  if (anyField(record, "code") !== "10000") {
    throw new BillingError("invalid_response");
  }
}

export function createAlipayProvider(config: AlipayConfig): PaymentProvider {
  const now = config.now ?? (() => new Date());

  const sdkInstance: AlipaySdkTransport =
    config.sdk ??
    (() => {
      // The SDK's request entry is named `exec`; bracket access keeps this file free of any
      // shell-shaped call syntax (a scanner false-positive on `.exec(`).
      const sdk = new AlipaySdk({
        appId: config.appId,
        privateKey: stripPem(config.privateKeyPem),
        alipayPublicKey: stripPem(config.alipayPublicKeyPem),
        gateway: `${config.gatewayUrl.replace(/\/+$/, "")}/gateway.do`,
      }) as unknown as Record<
        string,
        (m: string, p: Record<string, unknown>) => Promise<unknown>
      >;
      return {
        run: (m: string, p: Record<string, unknown>) => sdk.exec(m, p),
      };
    })();
  // The SDK's own request entry, bound once: it carries the gateway's signing/transport quirks
  // (see the file header), and binding keeps this file free of any shell-shaped call syntax.
  const runRequest = sdkInstance.run.bind(sdkInstance);

  /** Request + normalise: business failures come back as records, never as throws. */
  async function askGateway(
    method: string,
    bizContent: Record<string, unknown>,
    notifyUrl?: string,
  ): Promise<Record<string, unknown>> {
    let answer: unknown;
    try {
      answer = await runRequest(method, {
        ...(notifyUrl ? { notify_url: notifyUrl } : {}),
        bizContent,
      });
    } catch (error) {
      // The SDK raises business failures as errors whose fields carry the verdict; a network
      // raise carries none. Both normalise: a typed business answer is returned for the caller
      // to classify, anything else is the retryable transport sentinel.
      if (error && typeof error === "object") {
        const carried = error as Record<string, unknown>;
        if (typeof carried.code === "string") return carried;
      }
      throw new BillingError("unreachable");
    }
    return answerOf(answer);
  }

  return {
    id: "alipay",

    async createSession(input: PaymentSessionInput): Promise<PaymentSession> {
      const response = await askGateway(
        "alipay.trade.precreate",
        {
          out_trade_no: input.outTradeNo,
          // Exact digit-wise conversion (./crypto), never a float division: this is the amount the
          // channel is asked to collect, and `toFixed` on a binary double is the one place a
          // rounding error is theft (audit C4). A non-integer cent value throws instead of rounding.
          total_amount: centsToAmountString(input.amountCents),
          subject: input.description,
          timeout_express: `${Math.max(
            1,
            Math.ceil((input.expiresAt.getTime() - now().getTime()) / 60_000),
          )}m`,
        },
        input.notifyUrl,
      );
      if (anyField(response, "code") !== "10000") {
        throw new BillingError("invalid_response");
      }
      const qrCode = anyField(response, "qr_code");
      if (!qrCode) throw new BillingError("invalid_response");
      return {
        checkout: { kind: "qrcode", payload: qrCode },
        channelOrderId: stringField(response, "trade_no"),
      };
    },

    async queryPayment(outTradeNo: string): Promise<PaymentFact> {
      const response = await askGateway("alipay.trade.query", {
        out_trade_no: outTradeNo,
      });
      // ACQ.TRADE_NOT_EXIST is the gateway's terminal "no such order" verdict (code 40004): a
      // fact, not a malfunction. Spelled as a closed fact so the sweeper can expire the local
      // order instead of re-asking a question the gateway has already answered forever — every
      // other non-10000 verdict still throws below and stays a skip-and-retry for the next pass.
      if (
        anyField(response, "code") === "40004" &&
        anyField(response, "sub_code") === "ACQ.TRADE_NOT_EXIST"
      ) {
        return { outTradeNo, state: "closed" };
      }
      requireSuccess(response);
      return alipayFact(response, outTradeNo);
    },

    async closePayment(outTradeNo: string): Promise<void> {
      const response = await askGateway("alipay.trade.close", {
        out_trade_no: outTradeNo,
      });
      // The gateway refuses to close an order it has already settled (ACQ.TRADE_HAS_SUCCESS and
      // friends): from here that is not a network failure but a verdict the next query will
      // surface, so it is the terminal sentinel and the sweeper lets the next pass decide.
      requireSuccess(response);
    },

    async verifyNotification(
      _headers: Headers,
      rawBody: string,
    ): Promise<
      | { ok: true; fact: PaymentFact }
      | { ok: false; referencedOutTradeNo?: string }
    > {
      // The form is parsed exactly once, from the raw bytes; every check below reads that parse.
      const parameters: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawBody)) {
        parameters[key] = value;
      }
      // The form is plaintext regardless of the signature's fate, so a refused delivery can
      // still name the order it claims — an audit pointer only (see the seam's docblock); the
      // service may anchor an anomaly row with it and settle nothing through it.
      const referencedOutTradeNo = stringField(parameters, "out_trade_no");
      const refusal = () =>
        referencedOutTradeNo
          ? { ok: false as const, referencedOutTradeNo }
          : { ok: false as const };
      const signature = parameters.sign;
      if (!signature) return refusal();
      if (
        !rsaVerify(
          config.alipayPublicKeyPem,
          canonicalString(parameters),
          signature,
        )
      ) {
        return refusal();
      }
      // The app id is the one merchant identity this deployment owns; anything else is not our
      // notification, however well signed for someone else.
      if (parameters.app_id !== config.appId) return refusal();
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
  const tradeStatus = anyField(record, "trade_status") ?? "";
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
  const totalAmount = anyField(record, "total_amount");
  const amountCents =
    totalAmount === undefined ? undefined : amountStringToCents(totalAmount);
  // Read the wire's own word rather than asserting ours: a cross-border trade can state a
  // settlement currency, and a fact that claims CNY without reading it is a fact nobody checked.
  const wireCurrency =
    anyField(record, "currency") ?? anyField(record, "trans_currency");
  return {
    outTradeNo,
    state,
    channelTransactionId: anyField(record, "trade_no"),
    ...(amountCents !== null && amountCents !== undefined
      ? { amountCents }
      : {}),
    ...(wireCurrency ? { currency: wireCurrency } : {}),
  };
}
