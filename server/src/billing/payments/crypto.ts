/**
 * The primitives every payment channel needs, in one auditable file: RSA-SHA256 signing and
 * verification (Alipay's RSA2 and WeChat Pay v3's request signature are both this one algorithm),
 * AES-256-GCM decryption (WeChat's callback resource), exact decimal-to-cents conversion, X.509
 * certificate serial extraction, and the short order number.
 *
 * Zero new dependencies on purpose: `node:crypto` covers all of it, and a signature layer that
 * imports less is a signature layer that can be read in one sitting. Every function here is pure
 * over its inputs; the adapters above it translate the failures into the billing seam's sentinels.
 */
import {
  createDecipheriv,
  createSign,
  createVerify,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import { BillingError } from "../types";

/** RSA-SHA256 is both channels' one algorithm; neither accepts anything weaker. */
const SIGNATURE_ALGORITHM = "RSA-SHA256";

/**
 * Sign a canonical string with a PEM private key.
 *
 * The key never leaves this call: a failure to parse or use it surfaces as the terminal sentinel,
 * never as a message quoting the key material.
 */
export function rsaSign(privateKeyPem: string, canonical: string): string {
  try {
    const signer = createSign(SIGNATURE_ALGORITHM);
    signer.update(canonical);
    return signer.sign(privateKeyPem, "base64");
  } catch {
    throw new BillingError("unconfigured");
  }
}

/** Verify a base64 RSA-SHA256 signature over a canonical string. Tampered bytes answer false. */
export function rsaVerify(
  publicKeyPem: string,
  canonical: string,
  signatureBase64: string,
): boolean {
  try {
    const verifier = createVerify(SIGNATURE_ALGORITHM);
    verifier.update(canonical);
    return verifier.verify(publicKeyPem, signatureBase64, "base64");
  } catch {
    // An unparseable key or a malformed signature blob is a failed verification, not a throw:
    // the caller's answer to it is the same refusal either way.
    return false;
  }
}

/**
 * Decrypt a WeChat Pay v3 callback resource: AES-256-GCM with the 32-byte APIv3 key, the
 * callback's `nonce` as the IV and its `associated_data` as the AAD, with the 16-byte
 * authentication tag appended to the ciphertext — exactly the wire shape WeChat sends.
 *
 * Authentication failure (a wrong key, tampered ciphertext, mismatched AAD) answers null — the
 * caller maps it to a refusal, never to an ack.
 */
export function aesGcmDecrypt(
  key: Buffer,
  nonce: string,
  aad: string,
  ciphertextBase64: string,
): string | null {
  try {
    const raw = Buffer.from(ciphertextBase64, "base64");
    if (raw.length < 16) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce, "utf8"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * A decimal amount string ("88.00", "0.01", "128.5") as integer cents, exactly.
 *
 * Parsed as digits, never through `Number.parseFloat`: a float can represent 88.10 only
 * approximately, and a payment amount is one place a rounding error is theft. More than two
 * decimal places ("88.001") is refused — the channels never send one, so a string that carries
 * one is a tampered or malformed string, and accepting it would silently round. Answers null for
 * anything not shaped `^\d+(\.\d{1,2})?$` or past a safe integer.
 */
export function amountStringToCents(value: string): number | null {
  const match = value.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number.parseInt(match[1] ?? "", 10);
  const fraction = match[2] ?? "";
  const cents = Number.parseInt(fraction.padEnd(2, "0"), 10);
  const total = whole * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

/** The other direction, for the request the channels receive: integer cents, two decimal places. */
export function centsToAmountString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new BillingError("invalid_response");
  }
  const whole = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${whole}.${String(remainder).padStart(2, "0")}`;
}

/**
 * The serial number a certificate carries, lowercase hexadecimal, as WeChat Pay v3 names it in
 * callback headers and request signatures. A malformed PEM is a deployment wired wrong, so it
 * carries the terminal sentinel.
 */
export function certificateSerial(pem: string): string {
  try {
    return new X509Certificate(pem).serialNumber.toLowerCase();
  } catch {
    throw new BillingError("unconfigured");
  }
}

/** The public key inside a PEM certificate, for verifying against the platform certs. */
export function certificatePublicKey(pem: string): string {
  try {
    return new X509Certificate(pem).publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
  } catch {
    throw new BillingError("unconfigured");
  }
}

/**
 * The local order number: `po-` plus 16 hex characters, 19 characters total — inside WeChat's
 * 6–32-byte `out_trade_no` ceiling, and short enough to read aloud. Collision is handled by the
 * store (regenerate and retry), which is also the only caller.
 */
export function generateOutTradeNo(): string {
  return `po-${randomBytes(8).toString("hex")}`;
}
