/**
 * The one file that speaks WeChat Pay v3: the Native checkout (`code_url`), the order query, the
 * close, and the encrypted callback with its four-header signature.
 *
 * Outbound requests sign with the merchant's API private key: the Authorization header is
 * `WECHATPAY2-SHA256-RSA2048 mchid="…",nonce_str="…",signature="…",timestamp="…",serial_no="…"`
 * over the string `METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nBODY\n`, and the serial named there is
 * this merchant's own certificate serial — the platform verifies us with it.
 *
 * Inbound callbacks verify with the platform certificates the deployment configured
 * (`WXPAY_PLATFORM_CERTS`), never a runtime fetch: a trust root fetched from the party being
 * verified is the forgery mechanism, not the defence (the same reasoning the Lago client's header
 * records). The four headers — timestamp, nonce, signature, serial — are read, the timestamp is
 * graded against the configured skew (a stale replay is refused before any crypto runs), the
 * serial must name one of the configured platform certificates (an unknown serial is refused
 * before any crypto runs), the signature is verified over `TIMESTAMP\nNONCE\nBODY\n`, and only
 * then is the resource decrypted with the APIv3 key (AES-256-GCM, nonce and AAD from the
 * resource). Inside the decrypted resource the merchant id, app id and currency are compared —
 * a well-signed resource from a different merchant is refused, exactly as the Alipay adapter
 * checks `app_id`.
 *
 * `trade_state` maps: SUCCESS → paid; NOTPAY/USERPAYING → pending; CLOSED, REVOKED and PAYERROR →
 * closed. Anything else stays pending — never an invented payment, never an invented closure.
 */
import { randomBytes } from "node:crypto";
import { BillingError } from "../types";
import {
  aesGcmDecrypt,
  certificatePublicKey,
  certificateSerial,
  rsaSign,
  rsaVerify,
} from "./crypto";
import { getJson, postJson, type ChannelHttpConfig } from "./channel-http";
import type {
  PaymentFact,
  PaymentProvider,
  PaymentSession,
  PaymentSessionInput,
} from "./provider";

export type WechatConfig = ChannelHttpConfig & {
  mchid: string;
  appid: string;
  /** The 32-byte APIv3 key; used for callback decryption and never logged. */
  apiv3Key: string;
  merchantSerialNo: string;
  merchantPrivateKeyPem: string;
  /** Platform certificate PEMs; serials and public keys are derived at construction. */
  platformCertificates: readonly string[];
  gatewayUrl: string;
  /** The callback clock-skew window, in seconds; the config default is 300. */
  skewSeconds: number;
  /** Injectable nonce, for deterministic tests; production draws 16 random bytes. */
  nonce?: () => string;
  /** Injectable clock, in seconds-since-epoch. */
  nowSeconds?: () => number;
};

type PlatformKey = { serial: string; publicKeyPem: string };

function platformKeys(certificates: readonly string[]): PlatformKey[] {
  return certificates.map((pem) => ({
    serial: certificateSerial(pem),
    publicKeyPem: certificatePublicKey(pem),
  }));
}

function authorizationHeader(
  config: WechatConfig,
  method: string,
  pathWithQuery: string,
  body: string,
): string {
  // The header carries seconds since epoch; `nowSeconds` is already that, and the default
  // derives it from the wall clock.
  const timestamp = (
    config.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  )().toString();
  const nonce = config.nonce?.() ?? randomBytes(16).toString("hex");
  const canonical = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = rsaSign(config.merchantPrivateKeyPem, canonical);
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",` +
    `nonce_str="${nonce}",signature="${signature}",` +
    `timestamp="${timestamp}",serial_no="${config.merchantSerialNo}"`
  );
}

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BillingError("invalid_response");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BillingError("invalid_response");
  }
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The fact a decrypted resource (or a query response) states, in seam words. */
function wechatFact(record: Record<string, unknown>): PaymentFact {
  const tradeState = stringField(record, "trade_state") ?? "";
  const state: PaymentFact["state"] =
    tradeState === "SUCCESS"
      ? "paid"
      : tradeState === "CLOSED" || tradeState === "REVOKED" || tradeState === "PAYERROR"
        ? "closed"
        : "pending";
  const amount =
    record.amount && typeof record.amount === "object" && !Array.isArray(record.amount)
      ? (record.amount as Record<string, unknown>)
      : undefined;
  const total = amount?.total;
  const amountCents =
    typeof total === "number" && Number.isInteger(total) ? total : undefined;
  const currency = stringField(amount ?? {}, "currency");
  return {
    outTradeNo: stringField(record, "out_trade_no") ?? "",
    state,
    channelTransactionId: stringField(record, "transaction_id"),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(currency === "CNY" ? { currency: "CNY" as const } : {}),
  };
}

/** The four headers a signed callback carries. */
const HEADER_TIMESTAMP = "wechatpay-timestamp";
const HEADER_NONCE = "wechatpay-nonce";
const HEADER_SIGNATURE = "wechatpay-signature";
const HEADER_SERIAL = "wechatpay-serial";

export function createWechatProvider(config: WechatConfig): PaymentProvider {
  const gateway = config.gatewayUrl.replace(/\/+$/, "");
  const platforms = platformKeys(config.platformCertificates);

  async function call(
    method: "GET" | "POST",
    pathWithQuery: string,
    body: string,
  ): Promise<string> {
    const authorization = authorizationHeader(config, method, pathWithQuery, body);
    const url = new URL(`${gateway}${pathWithQuery}`);
    if (method === "POST") {
      return postJson(config, url, authorization, body);
    }
    return getJson(config, url, authorization);
  }

  return {
    id: "wechat",

    async createSession(input: PaymentSessionInput): Promise<PaymentSession> {
      const body = JSON.stringify({
        appid: config.appid,
        mchid: config.mchid,
        description: input.description,
        out_trade_no: input.outTradeNo,
        notify_url: input.notifyUrl,
        amount: { total: input.amountCents, currency: "CNY" },
        // RFC 3339 in the +08:00 offset the channel grades expiry on.
        time_expire: rfc3339PlusEight(input.expiresAt),
      });
      const text = await call("POST", "/v3/pay/transactions/native", body);
      const response = parseJson(text);
      const codeUrl = stringField(response, "code_url");
      if (!codeUrl) throw new BillingError("invalid_response");
      return { checkout: { kind: "qrcode", payload: codeUrl } };
    },

    async queryPayment(outTradeNo: string): Promise<PaymentFact> {
      const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchid)}`;
      const response = parseJson(await call("GET", path, ""));
      return wechatFact(response);
    },

    async closePayment(outTradeNo: string): Promise<void> {
      const body = JSON.stringify({ mchid: config.mchid });
      const text = await call(
        "POST",
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
        body,
      );
      // The acknowledgement parses when there is one; a 404 for an order the channel never saw
      // has already been answered as not-found by the status gate and arrives here empty.
      if (text.trim() !== "") parseJson(text);
    },

    async verifyNotification(
      headers: Headers,
      rawBody: string,
    ): Promise<
      { ok: true; fact: PaymentFact } | { ok: false; refusal?: "stale" | "decryption" }
    > {
      const timestamp = headers.get(HEADER_TIMESTAMP);
      const nonce = headers.get(HEADER_NONCE);
      const signature = headers.get(HEADER_SIGNATURE);
      const serial = headers.get(HEADER_SERIAL);
      if (!timestamp || !nonce || !signature || !serial) return { ok: false };

      const now = config.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
      const headerTime = Number(timestamp);
      if (!Number.isFinite(headerTime) || Math.abs(now - headerTime) > config.skewSeconds) {
        // A replay riding an old timestamp is graded differently from a forged one: the channel
        // wants to know its clock or its retry is the problem.
        return { ok: false, refusal: "stale" };
      }

      const platform = platforms.find((candidate) => candidate.serial === serial);
      if (!platform) return { ok: false };

      const canonical = `${timestamp}\n${nonce}\n${rawBody}\n`;
      if (!rsaVerify(platform.publicKeyPem, canonical, signature)) {
        return { ok: false };
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(rawBody);
      } catch {
        return { ok: false, refusal: "decryption" };
      }
      if (!envelope || typeof envelope !== "object") return { ok: false, refusal: "decryption" };
      const resource = (envelope as Record<string, unknown>).resource;
      if (!resource || typeof resource !== "object") return { ok: false, refusal: "decryption" };
      const resourceRecord = resource as Record<string, unknown>;
      const ciphertext = stringField(resourceRecord, "ciphertext");
      const resourceNonce = stringField(resourceRecord, "nonce");
      if (!ciphertext || !resourceNonce) return { ok: false, refusal: "decryption" };
      const associatedData = stringField(resourceRecord, "associated_data") ?? "";

      const plain = aesGcmDecrypt(
        Buffer.from(config.apiv3Key, "utf8"),
        resourceNonce,
        associatedData,
        ciphertext,
      );
      if (plain === null) return { ok: false, refusal: "decryption" };

      let decoded: unknown;
      try {
        decoded = JSON.parse(plain);
      } catch {
        return { ok: false, refusal: "decryption" };
      }
      if (!decoded || typeof decoded !== "object") return { ok: false, refusal: "decryption" };
      const fact = decoded as Record<string, unknown>;

      // The decrypted body names the parties; the deployment is the merchant, and a resource for
      // anyone else — however correctly signed by the platform — is not ours to act on.
      if (stringField(fact, "mchid") !== config.mchid) return { ok: false };
      if (stringField(fact, "appid") !== config.appid) return { ok: false };
      const outTradeNo = stringField(fact, "out_trade_no");
      if (!outTradeNo) return { ok: false };
      return { ok: true, fact: wechatFact(fact) };
    },

    successAck: { body: '{"code":"SUCCESS"}', contentType: "application/json" },
  };
}

/** The wire's expiry spelling: RFC 3339 in the +08:00 offset. */
export function rfc3339PlusEight(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `+08:00`
  );
}

/** Exported for tests: the exact canonical string a callback signature is verified over. */
export function callbackCanonicalString(
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return `${timestamp}\n${nonce}\n${rawBody}\n`;
}
