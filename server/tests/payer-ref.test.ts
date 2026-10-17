import { describe, expect, test } from "../../tests/support/e2e-compat";
import { deploymentExternalCustomerId } from "../src/billing/service";
import { type PayerRef, payerKey } from "../src/billing/payer";

/*
 * The payer reference's pure side, no database: the key derivation that lets CreditWriter keep
 * taking a plain external customer id string (its interface unchanged) while the billing subject
 * becomes { kind, id }. Two properties matter most: the derivation is deterministic per ref, and
 * keys never collide across kinds even when the subject ids do — "IDs must not collide or replay
 * between payer types" (parent spec). The legacy branch must converge on the one deployment key
 * derivation the service already exports, so this group's fallback path has a single spelling.
 */

describe("payerKey derives one stable account key per payer ref", () => {
  test("personal subjects derive a personal-prefixed key", () => {
    expect(payerKey({ kind: "personal", id: "usr_123" })).toBe(
      "openbot-personal-usr_123",
    );
  });

  test("company subjects derive a company-prefixed key", () => {
    expect(payerKey({ kind: "company", id: "tn_123" })).toBe(
      "openbot-company-tn_123",
    );
  });

  test("the same subject id under different kinds never collides", () => {
    const personal = payerKey({ kind: "personal", id: "same-id" });
    const company = payerKey({ kind: "company", id: "same-id" });
    const legacy = payerKey({ kind: "legacy_deployment", id: "same-id" });
    expect(new Set([personal, company, legacy]).size).toBe(3);
  });

  test("the derivation is deterministic: the same ref answers the same key", () => {
    const ref: PayerRef = { kind: "personal", id: "usr_stable" };
    expect(payerKey(ref)).toBe(payerKey(ref));
  });
});

describe("payerKey converges the legacy deployment key on the one existing spelling", () => {
  test("legacy_deployment refs reuse deploymentExternalCustomerId exactly", () => {
    for (const tenantId of ["tenant-a", "tenant-b", "0199-xyz"]) {
      expect(payerKey({ kind: "legacy_deployment", id: tenantId })).toBe(
        deploymentExternalCustomerId(tenantId),
      );
    }
  });

  test("a legacy ref answers a key with the deployment prefix the grants already use", () => {
    expect(payerKey({ kind: "legacy_deployment", id: "t1" })).toBe(
      "openbot-deployment-t1",
    );
  });
});

describe("payerKey refuses refs that must never reach a consumption path", () => {
  test("unknown_owner is isolated: no key can be derived for it", () => {
    // The quarantine semantics group 02.2 relies on: an unknown owner is auditable as a record
    // but can never be resolved into an account key a new charge could land on.
    expect(() => payerKey({ kind: "unknown_owner", id: "stray-key" })).toThrow(
      TypeError,
    );
  });

  test("an empty or blank subject id is a caller bug, refused before any lookup", () => {
    expect(() => payerKey({ kind: "personal", id: "" })).toThrow(TypeError);
    expect(() => payerKey({ kind: "company", id: "  " })).toThrow(TypeError);
  });

  test("an id with leading or trailing whitespace is refused, not silently trimmed", () => {
    // The derivation embeds the id verbatim, so a padded id must not become a padded key: the
    // strict check is what keeps " usr_1" and "usr_1" from ever naming two different accounts
    // that are secretly the same subject (review L2).
    expect(() => payerKey({ kind: "personal", id: " usr_1" })).toThrow(
      TypeError,
    );
    expect(() => payerKey({ kind: "personal", id: "usr_1 " })).toThrow(
      TypeError,
    );
    expect(() => payerKey({ kind: "company", id: "\ttn_1\n" })).toThrow(
      TypeError,
    );
    // An id that is merely unusual but clean still derives.
    expect(payerKey({ kind: "personal", id: "usr_1" })).toBe(
      "openbot-personal-usr_1",
    );
  });

  test("a kind outside the four the model knows is refused, not guessed", () => {
    expect(() => payerKey({ kind: "workspace" as never, id: "ws_1" })).toThrow(
      TypeError,
    );
  });
});
