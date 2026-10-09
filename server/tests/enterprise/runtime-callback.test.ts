import { describe, expect, test } from "bun:test";
import {
  hashCallbackToken,
  mintCallbackToken,
  mintRunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
  type RunAssertion,
} from "../../src/agents/callback-token";
import type { AgentProfileStore } from "../../src/agents/profile-store";
import { createApp, type DeploymentToolCaller } from "../../src/app";
import { loadConfig } from "../../src/config";
import { testEnvironment } from "../support/environment";

/*
 * The Go runtime candidate's tool callback lands on the EXISTING
 * `/api/agent-tools/call`, with the wire shape its client sends:
 *   POST {run, name, args} + x-openbot-agent-token.
 *
 * These tests pin the refusal semantics that route already had — an unknown
 * token, an expired or forged assertion, a token that belongs to another
 * Bot — against that Go-client shape, so the candidate cannot quietly
 * soften them. The refusals must happen BEFORE dispatch (the deployment
 * caller observes nothing), and identity for the audit-bound call must come
 * from the signed assertion, never from args.
 */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const BOT = "knowledge";
const OTHER_BOT = "risk-analyst";

const RUN: RunAssertion = {
  botId: BOT,
  actorId: "actor_1",
  runId: "run_1",
  threadId: "thread_1",
};

/*
 * Real token primitives, no stubbed verdicts: per-agent tokens stored only
 * as hashes, exactly as the host wires them. Rotation is modelled by
 * deleting an entry, which is what rotating away from a token does.
 */
const knowledgeToken = mintCallbackToken();
const otherBotToken = mintCallbackToken();
const openTokenHashes = new Map<string, { id: string }>([
  [hashCallbackToken(knowledgeToken), { id: BOT }],
  [hashCallbackToken(otherBotToken), { id: OTHER_BOT }],
]);

const profileStore = {
  agentForCallbackToken: async (hash: string) =>
    openTokenHashes.get(hash) ?? null,
} as unknown as AgentProfileStore;

function callbackApp(caller?: DeploymentToolCaller) {
  const parameters: Parameters<typeof createApp> = [
    loadConfig(testEnvironment({ KEY_ENCRYPTION_KEY: KEY })),
  ];
  parameters[9] = profileStore;
  parameters[28] = caller;
  return createApp(...parameters);
}

/** The request the Go callback client sends: {run, name, args} + token. */
function goCallbackRequest(
  run: string,
  options: { token?: string; args?: Record<string, unknown>; name?: string } = {},
) {
  return {
    method: "POST" as const,
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": options.token ?? knowledgeToken,
    },
    body: JSON.stringify({
      run,
      name: options.name ?? "parallel/web_search",
      args: options.args ?? { query: "incident" },
    }),
  };
}

const signedRun = (over: Partial<RunAssertion> = {}) =>
  mintRunAssertion({ ...RUN, ...over }, KEY);

describe("the Go runtime's tool callback on /api/agent-tools/call", () => {
  test("a valid run answers a result and dispatches with the signed scope", async () => {
    const captured: Parameters<DeploymentToolCaller>[0][] = [];
    const app = callbackApp(async (input) => {
      captured.push(input);
      return { text: "search-ok", isError: false };
    });

    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(signedRun()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "search-ok", isError: false });

    // The shape the Go client sends is one name + args; the identity the
    // call executes with is the ASSERTION's, verified against the token.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      name: "parallel/web_search",
      args: { query: "incident" },
      botId: RUN.botId,
      actorId: RUN.actorId,
      run: { ...RUN, depth: 0, initiator: { kind: "person" } },
    });
  });

  test.each([
    ["an unknown token", { token: "unknown-token" }],
    ["an expired run", { run: mintRunAssertion(RUN, KEY, 0) }],
    [
      "a forged run",
      {
        run: mintRunAssertion(
          { ...RUN, actorId: "the_admin" },
          "attacker-owns-this-key",
        ),
      },
    ],
  ])("refuses %s before dispatch, as it always has", async (_label, options) => {
    let dispatched = false;
    const app = callbackApp(async () => {
      dispatched = true;
      return { text: "never", isError: false };
    });
    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(
        (options as { run?: string }).run ?? signedRun(),
        { token: (options as { token?: string }).token },
      ),
    );
    expect(response.status).toBe(401);
    expect(dispatched).toBe(false);
  });

  test("an expired assertion fails even though the approved-read would accept it", async () => {
    // The two readers exist for two doors: the callback path must use the
    // expiring one. This is the ignoreExpiry prohibition, as behaviour: an
    // assertion that readApprovedRunAssertion still accepts is REFUSED
    // here, because ten minutes have passed and no approval re-authorises
    // a live tool call.
    const stale = mintRunAssertion(RUN, KEY, 0);
    expect(readApprovedRunAssertion(stale, KEY)).not.toBeNull();
    expect(readRunAssertion(stale, KEY)).toBeNull();

    let dispatched = false;
    const app = callbackApp(async () => {
      dispatched = true;
      return { text: "never", isError: false };
    });
    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(stale),
    );
    expect(response.status).toBe(401);
    expect(dispatched).toBe(false);
  });

  test("refuses a token that belongs to another Bot", async () => {
    // The assertion is genuinely the knowledge Bot's, but the credential
    // presenting it was issued to a different agent: an agent must not be
    // able to spend another Bot's grants by replaying an assertion it saw.
    let dispatched = false;
    const app = callbackApp(async () => {
      dispatched = true;
      return { text: "never", isError: false };
    });
    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(signedRun(), { token: otherBotToken }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("That token is not for this Bot.");
    expect(dispatched).toBe(false);
  });

  test("refuses a rotated-away token even with a valid assertion", async () => {
    // Authorization revoked on the token side: the entry the hash resolves
    // to is gone, which is what rotation leaves behind.
    openTokenHashes.delete(hashCallbackToken(knowledgeToken));
    try {
      let dispatched = false;
      const app = callbackApp(async () => {
        dispatched = true;
        return { text: "never", isError: false };
      });
      const response = await app.request(
        "/api/agent-tools/call",
        goCallbackRequest(signedRun()),
      );
      expect(response.status).toBe(401);
      expect(dispatched).toBe(false);
    } finally {
      openTokenHashes.set(hashCallbackToken(knowledgeToken), { id: BOT });
    }
  });

  test("a revoked grant answers 200 with isError, not a transport failure", async () => {
    // Authorization revoked on the grant side keeps the existing shape: the
    // refusal is the tool's ANSWER (marker-led text, isError true) — the Go
    // client decodes it as a Result and the model is told what was blocked,
    // rather than the run dying on a "failed" tool.
    const app = callbackApp(async () => ({
      text: "Refused. The grant was revoked.",
      isError: true,
    }));
    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(signedRun()),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "Refused. The grant was revoked.",
      isError: true,
    });
  });

  test("identity stuffed into args authorises nothing", async () => {
    // args are the model's chosen data and travel verbatim; the identity
    // the call executes under comes from the assertion. A prompt-injected
    // "actorId" in args is data, not a credential.
    const captured: Parameters<DeploymentToolCaller>[0][] = [];
    const app = callbackApp(async (input) => {
      captured.push(input);
      return { text: "ok", isError: false };
    });
    const response = await app.request(
      "/api/agent-tools/call",
      goCallbackRequest(signedRun(), {
        args: {
          query: "incident",
          actorId: "the_admin",
          botId: OTHER_BOT,
          runId: "somebody-elses-run",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.botId).toBe(RUN.botId);
    expect(captured[0]?.actorId).toBe(RUN.actorId);
    // The forged values survived as args (they are data), and changed nothing.
    expect(captured[0]?.args).toMatchObject({ actorId: "the_admin", botId: OTHER_BOT });
  });

  test("refuses a request with no tool name", async () => {
    const app = callbackApp(async () => ({ text: "never", isError: false }));
    const response = await app.request("/api/agent-tools/call", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": knowledgeToken,
      },
      body: JSON.stringify({ run: signedRun(), args: {} }),
    });
    expect(response.status).toBe(400);
  });
});
