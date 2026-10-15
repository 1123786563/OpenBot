/**
 * The channel seam: what a payment provider is, in five methods and neutral words.
 *
 * Every provider word — envelope keys, header names, trade states as the wire spells them — stays
 * inside its adapter file. What crosses this seam is `PaymentFact` and the two ack bodies, nothing
 * else. Adding a channel means one more file implementing this type, not a change anywhere above.
 *
 * Shared client discipline, inherited from the Lago client (../lago.ts): `fetch` is injectable so
 * a test never opens a socket, `assertTarget` is a required constructor argument so no assembly
 * can build a client that skips the outbound gate, requests go out with `redirect: "error"` and an
 * abort timeout, and error messages carry the sentinel code alone — never a URL, a status line or
 * credential material.
 */
import type { PaymentProviderId } from "./types";

export type PaymentCheckout =
  | { kind: "qrcode"; payload: string }
  | { kind: "redirect"; url: string };

export type PaymentSessionInput = {
  /** The local order number, ≤32 bytes, unique per attempt. Collision retried by the store. */
  outTradeNo: string;
  description: string;
  /** Integer cents; only CNY is collected in v1. */
  amountCents: number;
  currency: "CNY";
  /** Where the channel's async notification must be posted: our own callbacks prefix. */
  notifyUrl: string;
  expiresAt: Date;
};

export type PaymentSession = {
  checkout: PaymentCheckout;
  channelOrderId?: string;
};

/**
 * Why a delivery was refused, when the channel can say: a timestamp outside the skew window
 * (`stale`) and a resource that would not decrypt (`decryption`) are different failures from a
 * bad signature, and the wire answers them with different status codes. Absent means the plain
 * case — wrong or missing signature material.
 */
export type NotificationRefusal = "stale" | "decryption";

/**
 * A channel-neutral payment fact. No local identity: the local order is found by `outTradeNo`
 * alone, because the delivery that carries this is anonymous.
 */
export type PaymentFact = {
  outTradeNo: string;
  state: "pending" | "paid" | "closed";
  channelTransactionId?: string;
  amountCents?: number;
  /**
   * The currency the CHANNEL states, verbatim, when it states one. Absent means the wire was
   * silent — not "CNY": the service compares this against the order snapshot and silence must
   * not be laundered into a match (audit A5).
   */
  currency?: string;
};

export type PaymentProvider = {
  readonly id: PaymentProviderId;
  /** Open a checkout for one order. Channel failures map to the billing seam's sentinels. */
  createSession(input: PaymentSessionInput): Promise<PaymentSession>;
  /** Ask the channel about one order. The sweeper and the polling read both ride on this. */
  queryPayment(outTradeNo: string): Promise<PaymentFact>;
  /**
   * Best-effort close of an order the channel may still honour. A close that fails because the
   * order was paid anyway surfaces `invalid_response`; the sweeper catches it and lets the next
   * pass's query settle the truth.
   */
  closePayment(outTradeNo: string): Promise<void>;
  /**
   * Verify one anonymous delivery against the exact bytes that arrived, and extract its fact.
   * `ok: false` covers every refusal — wrong signature, wrong headers, wrong merchant — with the
   * adapter's own reason staying inside it; the route layer answers the channel from the shape
   * alone. A refusal the channel grades differently (a stale timestamp, an undecryptable
   * resource) names itself, so the HTTP answer can differ the way the channel's own docs do.
   */
  verifyNotification(
    headers: Headers,
    rawBody: string,
  ): Promise<
    | { ok: true; fact: PaymentFact }
    | { ok: false; refusal?: NotificationRefusal }
  >;
  /** What a successful delivery is answered with, verbatim. */
  readonly successAck: { body: string; contentType: string };
};
