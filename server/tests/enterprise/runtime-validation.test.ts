import { describe, expect, test } from "bun:test";
import {
  hashCallbackToken,
  looksLikeCallbackToken,
  mintCallbackToken,
  mintRunAssertion,
  readRunAssertion,
} from "../../src/agents/callback-token";
import {
  createRuntimeValidationRoutes,
  type ValidationDeps,
} from "../../src/enterprise/runtime/validation-routes";

test("invalid runtime assertion cannot yield identity", async () => {
  const app = createRuntimeValidationRoutes({ verify: async () => null });
  const response = await app.request("/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assertion: "invalid", runId: "r", threadId: "s" }),
  });
  expect(response.status).toBe(401);
});

/*
 * Everything below drives the route with the REAL verification primitives the
 * host will wire: assertions minted by the existing mintRunAssertion, read back
 * by the existing readRunAssertion, against a token lookup holding the fixed
 * test members the candidate stage runs with (no real tenants exist until T2).
 * A forged credential therefore fails for the reason it fails in production,
 * not because a stub was told to say no.
 */
const KEY = "test-encryption-key-not-a-real-one";
const TENANT = "tenant_fixed_test_member";
const BOT = "knowledge";

const liveToken = mintCallbackToken();
const rotatedAwayToken = mintCallbackToken();
/** Tokens this isolated test process still honours; rotation empties entries. */
const openTokens = new Set([hashCallbackToken(liveToken)]);

/** The host's verify, exactly as production would compose it. */
const verify: ValidationDeps["verify"] = async (presented, assertion) => {
  const run = readRunAssertion(assertion, KEY);
  if (!run) return null;
  if (!looksLikeCallbackToken(presented)) return null;
  if (!openTokens.has(hashCallbackToken(presented))) return null;
  if (run.botId !== BOT) return null; // the token says which Bot may use it
  return {
    tenantId: TENANT,
    actorId: run.actorId,
    botId: run.botId,
    runId: run.runId,
    threadId: run.threadId ?? "",
  };
};

const routes = () => createRuntimeValidationRoutes({ verify });

const post = (body: unknown, token = liveToken) =>
  routes().request("/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openbot-agent-token": token,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const signedRun = (over: Partial<{ runId: string; threadId: string; actorId: string; botId: string }> = {}) =>
  mintRunAssertion(
    {
      botId: over.botId ?? BOT,
      actorId: over.actorId ?? "actor_1",
      runId: over.runId ?? "run_1",
      threadId: over.threadId ?? "thread_1",
    },
    KEY,
  );

describe("the runtime validation route", () => {
  test("returns only the whitelisted identity for a valid run", async () => {
    const response = await post({ assertion: signedRun(), runId: "run_1", threadId: "thread_1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "actorId",
      "botId",
      "runId",
      "tenantId",
      "threadId",
    ]);
    expect(body).toEqual({
      tenantId: TENANT,
      actorId: "actor_1",
      botId: BOT,
      runId: "run_1",
      threadId: "thread_1",
    });
  });

  test("refuses a body with missing fields", async () => {
    for (const body of [
      { runId: "run_1", threadId: "thread_1" }, // no assertion
      { assertion: signedRun(), threadId: "thread_1" }, // no runId
      { assertion: signedRun(), runId: "run_1" }, // no threadId
      { assertion: "", runId: "run_1", threadId: "thread_1" },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
  });

  test("refuses a body that is not JSON", async () => {
    const response = await post("this is not json");
    expect(response.status).toBe(400);
  });

  test("refuses an expired signature", async () => {
    // Minted at time zero: eleven minutes later the ten-minute life is over.
    const stale = mintRunAssertion(
      { botId: BOT, actorId: "actor_1", runId: "run_1", threadId: "thread_1" },
      KEY,
      0,
    );
    const response = await post({ assertion: stale, runId: "run_1", threadId: "thread_1" });
    expect(response.status).toBe(401);
  });

  test("refuses a forged actor: an assertion signed with another key", async () => {
    const forged = signedRun({ actorId: "the_admin" });
    // Same shape, signed by an attacker's key: readRunAssertion returns null.
    const attackerKey = mintRunAssertion(
      { botId: BOT, actorId: "the_admin", runId: "run_1", threadId: "thread_1" },
      "attacker-owns-this-key",
    );
    expect(forged).not.toBeNull();
    const response = await post({ assertion: attackerKey, runId: "run_1", threadId: "thread_1" });
    expect(response.status).toBe(401);
  });

  test("refuses a closed (rotated away) token, even with a valid assertion", async () => {
    // The assertion is real, but the token presenting it has been rotated.
    const response = await post(
      { assertion: signedRun(), runId: "run_1", threadId: "thread_1" },
      rotatedAwayToken,
    );
    expect(response.status).toBe(401);
  });

  test("refuses a token that belongs to another Bot", async () => {
    const response = await post({
      assertion: signedRun({ botId: "risk-analyst" }),
      runId: "run_1",
      threadId: "thread_1",
    });
    expect(response.status).toBe(401);
  });

  test("refuses a valid identity bound to a different run on the same thread", async () => {
    // Same thread, another run: what a second tenant's valid assertion looks
    // like against the first tenant's run. The signature vouches for WHICH
    // run, so a 403 — not a borrowed identity.
    const response = await post({
      assertion: signedRun({ runId: "run_other_tenant" }),
      runId: "run_1",
      threadId: "thread_1",
    });
    expect(response.status).toBe(403);
  });

  test("refuses a valid identity when the thread does not match", async () => {
    const response = await post({
      assertion: signedRun(),
      runId: "run_1",
      threadId: "thread_someone_elses",
    });
    expect(response.status).toBe(403);
  });

  test("refuses a validation body far larger than a credential ever is", async () => {
    const response = await post({
      assertion: signedRun(),
      runId: "run_1",
      threadId: "thread_1",
      padding: "x".repeat(128 * 1024),
    });
    expect(response.status).toBe(413);
  });
});
