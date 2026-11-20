import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import {
  parsePersonalSaasCallback,
  personalSaasCallbackUrl,
} from "../src/personal-saas-contract.ts";

const state = "a".repeat(43);
const handoff = "b".repeat(43);

test("the app exchanges only the expected callback for its current browser attempt", () => {
  const query = `?state=${state}&code=${handoff}`;
  deepStrictEqual(
    parsePersonalSaasCallback(`${personalSaasCallbackUrl}${query}`, state),
    { kind: "code", code: handoff },
  );
  for (const url of [
    `https://auth/personal-saas${query}`,
    `${personalSaasCallbackUrl}-other${query}`,
    `${personalSaasCallbackUrl}${query}&state=${state}`,
    `${personalSaasCallbackUrl}${query}&error=account_unavailable`,
    `${personalSaasCallbackUrl}${query}#unexpected`,
    `${personalSaasCallbackUrl}${query}#`,
  ]) {
    deepStrictEqual(parsePersonalSaasCallback(url, state), { kind: "invalid" });
  }
  deepStrictEqual(
    parsePersonalSaasCallback(
      `${personalSaasCallbackUrl}${query}`,
      "c".repeat(43),
    ),
    { kind: "invalid" },
  );
});

test("the app can show a retryable failure returned from a verified attempt", () => {
  deepStrictEqual(
    parsePersonalSaasCallback(
      `${personalSaasCallbackUrl}?state=${state}&error=email_unverified`,
      state,
    ),
    { kind: "error", error: "email_unverified" },
  );
});
