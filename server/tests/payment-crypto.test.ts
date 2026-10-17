import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  aesGcmDecrypt,
  amountStringToCents,
  certificatePublicKey,
  certificateSerial,
  centsToAmountString,
  generateOutTradeNo,
  rsaSign,
  rsaVerify,
} from "../src/billing/payments/crypto";

/*
 * Vector material lives in ./fixtures as PEM files (see ./fixtures/README.md): they are test
 * fixtures only, generated for this suite, never credentials. The certificate's serial is pinned
 * below so a re-generation of the fixture cannot silently pass; the key pair is exercised through
 * sign/verify both ways.
 */
const fixtureDir = join(hereDir, "fixtures");
const fixtureCertificate = readFileSync(
  join(fixtureDir, "payment-test-certificate.pem"),
  "utf8",
);
const fixtureKey = readFileSync(join(fixtureDir, "payment-test-key.pem"), "utf8");
/** `openssl x509 -serial` at fixture-creation time; see ./fixtures/README.md. */
const FIXTURE_CERT_SERIAL = "4473fb87fb910b2526b2c61c3768cc8c3fad5c09";

describe("RSA-SHA256 signing and verification", () => {
  test("a signature verifies over the bytes it signed", () => {
    const canonical =
      "app_id=demo&method=alipay.trade.precreate&total_amount=88.00";
    const signature = rsaSign(fixtureKey, canonical);
    expect(rsaVerify(fixtureCertificate, canonical, signature)).toBe(true);
  });

  test("tampering one byte fails verification", () => {
    const canonical =
      "app_id=demo&method=alipay.trade.precreate&total_amount=88.00";
    const signature = rsaSign(fixtureKey, canonical);
    expect(rsaVerify(fixtureCertificate, `${canonical}x`, signature)).toBe(false);
    expect(
      rsaVerify(fixtureCertificate, canonical.replace("88.00", "99.00"), signature),
    ).toBe(false);
  });

  test("a signature from another key fails verification", () => {
    const { generateKeyPairSync } = require("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const foreign = rsaSign(
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      "app_id=demo&amount=1.00",
    );
    expect(rsaVerify(fixtureCertificate, "app_id=demo&amount=1.00", foreign)).toBe(
      false,
    );
  });

  test("signing is deterministic over the same canonical string", () => {
    const canonical = "openbot-payment-vector-v1";
    expect(rsaSign(fixtureKey, canonical)).toBe(rsaSign(fixtureKey, canonical));
  });

  test("an unparseable key maps to the unconfigured sentinel, not a leak", () => {
    expect(() => rsaSign("not a pem", "x")).toThrow(/unconfigured/);
  });
});

describe("AES-256-GCM callback decryption", () => {
  const key = Buffer.alloc(32, 7);
  const nonce = "nonce123";
  const aad = "transaction";

  function encrypt(plain: string, aadValue: string, keyBuffer: Buffer): string {
    const { createCipheriv } = require("node:crypto");
    const cipher = createCipheriv(
      "aes-256-gcm",
      keyBuffer,
      Buffer.from(nonce, "utf8"),
    );
    cipher.setAAD(Buffer.from(aadValue, "utf8"));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]).toString("base64");
  }

  test("roundtrip: WeChat's wire shape (tag appended) decrypts", () => {
    const plain = '{"out_trade_no":"po-abc","trade_state":"SUCCESS"}';
    expect(aesGcmDecrypt(key, nonce, aad, encrypt(plain, aad, key))).toBe(plain);
  });

  test("a wrong key fails authentication", () => {
    const ciphertext = encrypt("secret", aad, key);
    expect(aesGcmDecrypt(Buffer.alloc(32, 8), nonce, aad, ciphertext)).toBeNull();
  });

  test("tampered ciphertext fails authentication", () => {
    const raw = Buffer.from(encrypt("hello", aad, key), "base64");
    raw[0] ^= 1;
    expect(aesGcmDecrypt(key, nonce, aad, raw.toString("base64"))).toBeNull();
  });

  test("mismatched AAD fails authentication", () => {
    const ciphertext = encrypt("hello", aad, key);
    expect(aesGcmDecrypt(key, nonce, "other", ciphertext)).toBeNull();
  });

  test("a truncated ciphertext is refused, not crashed on", () => {
    expect(aesGcmDecrypt(key, nonce, aad, Buffer.from([1, 2, 3]).toString("base64"))).toBe(
      null,
    );
  });
});

describe("amount strings to integer cents", () => {
  test("the exact spellings both channels send", () => {
    expect(amountStringToCents("88.00")).toBe(8800);
    expect(amountStringToCents("0.01")).toBe(1);
    expect(amountStringToCents("128.5")).toBe(12850);
    expect(amountStringToCents("7")).toBe(700);
    expect(amountStringToCents("0")).toBe(0);
  });

  test("more than two decimal places is refused, never rounded", () => {
    expect(amountStringToCents("88.001")).toBeNull();
    expect(amountStringToCents("88.0001")).toBeNull();
  });

  test("non-numeric and negative shapes are refused", () => {
    expect(amountStringToCents("")).toBeNull();
    expect(amountStringToCents("abc")).toBeNull();
    expect(amountStringToCents("-1.00")).toBeNull();
    expect(amountStringToCents("1e3")).toBeNull();
    expect(amountStringToCents(" 88.00")).toBeNull();
    expect(amountStringToCents("88.00 ")).toBeNull();
    expect(amountStringToCents(".50")).toBeNull();
  });

  test("unsafe magnitudes are refused", () => {
    expect(amountStringToCents("99999999999999999999.99")).toBeNull();
  });

  test("cents back to the wire spelling", () => {
    expect(centsToAmountString(8800)).toBe("88.00");
    expect(centsToAmountString(1)).toBe("0.01");
    expect(centsToAmountString(12850)).toBe("128.50");
    expect(() => centsToAmountString(1.5)).toThrow();
    expect(() => centsToAmountString(-1)).toThrow();
  });
});

describe("X.509 serial derivation", () => {
  test("the pinned fixture serial derives lowercase hex", () => {
    expect(certificateSerial(fixtureCertificate)).toBe(FIXTURE_CERT_SERIAL);
  });

  test("the certificate's public key verifies a signature its key made", () => {
    const signature = rsaSign(fixtureKey, "payload");
    expect(rsaVerify(certificatePublicKey(fixtureCertificate), "payload", signature)).toBe(
      true,
    );
  });

  test("a malformed PEM maps to the unconfigured sentinel", () => {
    expect(() => certificateSerial("garbage")).toThrow(/unconfigured/);
    expect(() => certificatePublicKey("garbage")).toThrow(/unconfigured/);
  });
});

describe("short order numbers", () => {
  test("shape: po- plus 16 hex, 19 characters, within WeChat's 32-byte ceiling", () => {
    const id = generateOutTradeNo();
    expect(id).toMatch(/^po-[0-9a-f]{16}$/);
    expect(id.length).toBe(19);
    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(32);
  });

  test("generated ids do not collide in practice", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      seen.add(generateOutTradeNo());
    }
    expect(seen.size).toBe(1000);
  });
});
