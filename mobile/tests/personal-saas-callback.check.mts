import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import {
  nativeExchange,
  parsePersonalSaasCallback,
  personalSaasCallbackUrl,
  personalWorkspace,
  workspaceAccessMs,
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

test("a paused handoff carries public status and no session token", () => {
  const status = {
    status: "paused",
    operationId: "89b4db61-9c69-435f-815b-3ee6de75a313",
    reason: "Trial paused for review.",
    supportEmail: "support@example.com",
  };
  deepStrictEqual(nativeExchange.parse(status), status);
  deepStrictEqual(
    nativeExchange.safeParse({ ...status, token: handoff }).success,
    false,
  );
});

test("a missing, exhausted, or malformed server grant cannot open cached workspace data", () => {
  deepStrictEqual(workspaceAccessMs.parse("1250"), 1250);
  for (const header of [null, "", "0", "-1", "1.5", "60001", "1e3", "25, 50"])
    deepStrictEqual(workspaceAccessMs.safeParse(header).success, false);
});

test("workspace usage keeps a full Bot limit and an unknown Computer count", () => {
  const quotas = {
    bot: { used: 4, limit: 4 },
    computer: { used: null, limit: 1 },
    storage: { used: 32, limit: 64 },
    automation: { used: 0, limit: 30 },
  };
  const parsed = personalWorkspace.parse({
    id: "workspace-1",
    personalAssistant: { id: "bot-1", name: "My Assistant" },
    quotas,
  });
  deepStrictEqual(parsed.quotas, quotas);
});
