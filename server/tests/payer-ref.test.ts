import { describe, expect, test } from "bun:test";
import { deploymentExternalCustomerId } from "../src/billing/service";
import {
  assertPayerRef,
  externalCustomerIdForPayer,
  isPayerRef,
  PAYER_KINDS,
  PayerOwnerUnknownError,
} from "../src/billing/payer-ref";

/*
 * The payer contract's pure half: the PayerRef shape every finance consumer constructs
 * server-side, and the one derivation that turns a payer into the external customer key the
 * existing credit tables are keyed by. No database here — determinism, injectivity and refusal
 * are pure facts of the contract (ticket #215: PayerRef 是唯一计费主体表达；推导确定性、
 * 跨 kind 不碰撞、unknown_owner 永不可推导).
 */

describe("PAYER_KINDS", () => {
  test("is exactly the four kinds the spec names", () => {
    expect([...PAYER_KINDS]).toEqual([
      "personal",
      "company",
      "legacy_deployment",
      "unknown_owner",
    ]);
  });
});

describe("isPayerRef", () => {
  test("accepts each kind with a non-empty id", () => {
    for (const kind of PAYER_KINDS) {
      expect(isPayerRef({ kind, id: "u1" })).toBe(true);
    }
  });

  test("refuses malformed refs", () => {
    expect(isPayerRef({ kind: "personal" })).toBe(false); // no id
    expect(isPayerRef({ id: "u1" })).toBe(false); // no kind
    expect(isPayerRef({ kind: "team", id: "u1" })).toBe(false); // unknown kind
    expect(isPayerRef({ kind: "personal", id: "" })).toBe(false);
    expect(isPayerRef({ kind: "personal", id: 7 })).toBe(false);
    expect(isPayerRef(null)).toBe(false);
    expect(isPayerRef("personal:u1")).toBe(false);
  });
});

describe("assertPayerRef", () => {
  test("answers the ref itself for a valid payer", () => {
    const payer = { kind: "personal" as const, id: "user-1" };
    expect(assertPayerRef(payer)).toBe(payer);
  });

  test("treats a malformed ref as a caller bug (TypeError)", () => {
    expect(() => assertPayerRef({ kind: "personal", id: "" })).toThrow(
      TypeError,
    );
    expect(() => assertPayerRef({ kind: "personal", id: " u1" })).toThrow(
      TypeError,
    );
    expect(() => assertPayerRef({ kind: "personal", id: "u1 " })).toThrow(
      TypeError,
    );
    expect(() => assertPayerRef({ kind: "team", id: "u1" })).toThrow(TypeError);
    expect(() =>
      assertPayerRef({ kind: 42 as unknown as string, id: "t1" }),
    ).toThrow(TypeError);
  });
});

describe("externalCustomerIdForPayer", () => {
  test("is deterministic: the same payer always answers the same key", () => {
    const payer = { kind: "personal" as const, id: "user-1" };
    expect(externalCustomerIdForPayer(payer)).toBe(
      externalCustomerIdForPayer(payer),
    );
    expect(externalCustomerIdForPayer(payer)).toBe("payer-personal-user-1");
    expect(
      externalCustomerIdForPayer({ kind: "company", id: "tenant-9" }),
    ).toBe("payer-company-tenant-9");
  });

  test("is injective across kinds: the same id in two kinds never collides", () => {
    const id = "same-stable-id";
    const keys = new Set(
      (
        [
          { kind: "personal", id },
          { kind: "company", id },
          { kind: "legacy_deployment", id },
        ] as const
      ).map((payer) => externalCustomerIdForPayer(payer)),
    );
    expect(keys.size).toBe(3);
  });

  test("legacy_deployment derivation IS the one deployment key, not a copy of its format", () => {
    expect(
      externalCustomerIdForPayer({
        kind: "legacy_deployment",
        id: "tenant-42",
      }),
    ).toBe(deploymentExternalCustomerId("tenant-42"));
  });

  test("refuses unknown_owner: no key can ever be derived for an isolated owner", () => {
    expect(() =>
      externalCustomerIdForPayer({ kind: "unknown_owner", id: "stray-key" }),
    ).toThrow(PayerOwnerUnknownError);
  });
});
