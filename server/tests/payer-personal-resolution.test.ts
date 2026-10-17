import { describe, expect, test } from "bun:test";
import { payerKey } from "../src/billing/payer";
import {
  findForeignAccountIdentity,
  resolvePayerForPersonalUser,
} from "../src/billing/payer-personal";

/*
 * The personal branch's pure side, no database: the resolution that turns ONE authenticated
 * identity into the one personal payer ref. The security property this ticket sells is structural
 * — the function consumes only the authenticated subject's own id, so a forged company id or
 * payment account id cannot change the answer because those fields are not inputs — and the tests
 * below pin that by handing the resolver objects that also carry the forgery fields a client
 * might submit. The id rule matches the payer layer's (non-empty, no whitespace drift), so a bad
 * identity dies here before any lookup, and the query-side identity keys get one shared spelling
 * for the route boundary's explicit refusal.
 */

describe("resolvePayerForPersonalUser resolves the authenticated subject only", () => {
  test("the answer is exactly the personal ref for the subject's own id", () => {
    const ref = resolvePayerForPersonalUser({ id: "usr_123" });
    expect(ref).toEqual({ kind: "personal", id: "usr_123" });
  });

  test("the resolved ref derives the personal account key the writer keys on", () => {
    const user = { id: "usr_key-check" };
    expect(payerKey(resolvePayerForPersonalUser(user))).toBe(
      "openbot-personal-usr_key-check",
    );
  });

  test("forged company ids and payment account ids on the identity change nothing", () => {
    // The forgeries a request might carry, attached to the identity object itself: the resolver
    // reads one field, so none of these can steer the answer — this test is the contract.
    const forged = {
      id: "usr_victim",
      tenantId: "tn_attacker",
      companyId: "co_attacker",
      externalCustomerId: "openbot-deployment-someone-elses",
      payerId: "pa_attacker",
      role: "admin" as const,
    };
    expect(resolvePayerForPersonalUser(forged)).toEqual({
      kind: "personal",
      id: "usr_victim",
    });
  });

  test("the resolution is deterministic: the same identity answers the same ref", () => {
    const user = { id: "usr_stable" };
    expect(resolvePayerForPersonalUser(user)).toEqual(
      resolvePayerForPersonalUser(user),
    );
  });

  test("an empty or whitespace-drifted id is refused before any lookup", () => {
    expect(() => resolvePayerForPersonalUser({ id: "" })).toThrow(TypeError);
    expect(() => resolvePayerForPersonalUser({ id: "  " })).toThrow(TypeError);
    expect(() => resolvePayerForPersonalUser({ id: " usr_1" })).toThrow(
      TypeError,
    );
    expect(() => resolvePayerForPersonalUser({ id: "usr_1 " })).toThrow(
      TypeError,
    );
  });
});

describe("findForeignAccountIdentity names the account identity a request must not carry", () => {
  test("each watched identity key is named when present", () => {
    for (const key of [
      "userId",
      "externalCustomerId",
      "payerId",
      "accountId",
      "companyId",
      "tenantId",
    ]) {
      expect(findForeignAccountIdentity({ [key]: "x" })).toBe(key);
    }
  });

  test("casing variants are caught too, named as the request spelled them", () => {
    expect(findForeignAccountIdentity({ UserID: "x" })).toBe("UserID");
    expect(findForeignAccountIdentity({ EXTERNALCUSTOMERID: "k" })).toBe(
      "EXTERNALCUSTOMERID",
    );
    expect(findForeignAccountIdentity({ TenantId: "t" })).toBe("TenantId");
  });

  test("an empty-string value still counts as present: existence is the refusal", () => {
    expect(findForeignAccountIdentity({ externalCustomerId: "" })).toBe(
      "externalCustomerId",
    );
  });

  test("the credit reads' own window and page grammar is not an identity", () => {
    expect(
      findForeignAccountIdentity({
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-31T00:00:00.000Z",
        page: "2",
      }),
    ).toBeNull();
  });

  test("an empty query carries no identity", () => {
    expect(findForeignAccountIdentity({})).toBeNull();
  });
});
