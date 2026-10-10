import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import {
  canonicalArgsDigest,
  createFakeToolInvocationPlane,
  type ToolCapabilityBinding,
} from "../../src/enterprise/runtime/tool-invocations";
import { testEnvironment } from "../support/environment";

/*
 * Two tool planes, two sections, one rule each (01 plan R3):
 *
 * 1. The ENTERPRISE contract section (master plan §4.1/§4.2): the internal
 *    tool-invocations endpoints the Go runtime's Prepare/Execute client
 *    talks to, expressed by the G1a isolated fake — (tenant, run,
 *    tool_call_id) dedup, operation binding, approval gating, receipts with
 *    the frozen status enum. The fake IS the platform semantics under test;
 *    the real ledger/ActionPolicy is P3's to build.
 *
 * 2. The LEGACY regression section below: the existing /api/agent-tools/call
 *    route and the refusal semantics it already had, pinned against the
 *    legacy client shape. The plan keeps these as regression (不修改其原
 *    部署安全语义); they are not the enterprise path and never a fallback
 *    for it.
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

/*
 * ---------------------------------------------------------------------------
 * The enterprise tool-invocation contract (master plan §4.1/§4.2, 01 plan
 * R3-A), exercised against the G1a isolated fake plane. The fake expresses
 * the PLATFORM semantics: dedup by (tenant, run, tool_call_id), binding of
 * step/target/digest/installation, approval gating, fencing, and receipts
 * with the frozen status enum. Identity never comes from the body: the
 * capability the headers present is the only tenant/principal source.
 * ---------------------------------------------------------------------------
 */
const TOOL_SERVICE_CREDENTIAL = "test-tool-plane-credential-not-a-real-one";
const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_beta";
const PRINCIPAL_A = "principal_alpha";
const RUN_1 = "run_1";
const ATTEMPT_1 = "attempt_1";
const FENCING_1 = "fencing_1";
const TOOL = "probe_governed";
const INSTALLATION = "probe_governed@1.0.0";

/** A shared capability registry, the way the validation plane holds one. */
const capabilities = new Map<string, ToolCapabilityBinding>();

function mintCapability(binding: Partial<ToolCapabilityBinding> = {}): string {
  const capability = `cap_${randomUUID()}`;
  capabilities.set(capability, {
    tenant_id: TENANT_A,
    principal_id: PRINCIPAL_A,
    run_id: RUN_1,
    attempt_id: ATTEMPT_1,
    fencing_token: FENCING_1,
    expires_at: Date.now() + 10 * 60_000,
    ...binding,
  });
  return capability;
}

/** The header pair the Go callback client presents. */
function toolHeaders(capability: string, credential = TOOL_SERVICE_CREDENTIAL) {
  return {
    "content-type": "application/json",
    "x-openbot-runtime-service-credential": credential,
    "x-openbot-runtime-capability": capability,
  };
}

function proposal(over: Record<string, unknown> = {}) {
  const args = { search: "incident" };
  return {
    tool_name: TOOL,
    run_id: RUN_1,
    attempt_id: ATTEMPT_1,
    tool_call_id: "run_1|attempt_1|probe_governed|001",
    step_id: "turn_1",
    installation_version: INSTALLATION,
    target: TOOL,
    args,
    args_digest: canonicalArgsDigest(args),
    fencing_token: FENCING_1,
    ...over,
  };
}

/** One fake plane plus its client-side caller, wired to the shared registry. */
function planeFixture(deps: Parameters<typeof createFakeToolInvocationPlane>[0] = {
  serviceCredential: TOOL_SERVICE_CREDENTIAL,
  capabilities,
}) {
  const plane = createFakeToolInvocationPlane(deps);
  const call = async (
    path: string,
    capability: string,
    body: unknown,
    credential?: string,
  ) =>
    await plane.routes.request(path, {
      method: "POST",
      headers: toolHeaders(capability, credential),
      body: JSON.stringify(body),
    });
  return { plane, call };
}

describe("the enterprise tool-invocations plane (G1a fake)", () => {
  test("prepare allocates one operation per (tenant, run, tool_call_id) and never acts", async () => {
    const { plane, call } = planeFixture();
    const capability = mintCapability();

    const first = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { operation_id: string; deduplicated: boolean };
    expect(firstBody.operation_id).toMatch(/^op_/);
    expect(firstBody.deduplicated).toBe(false);

    // The identical proposal again: SAME operation, marked deduplicated.
    const again = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { operation_id: string; deduplicated: boolean };
    expect(againBody.operation_id).toBe(firstBody.operation_id);
    expect(againBody.deduplicated).toBe(true);

    // One operation, and prepare proposed only: zero external effects.
    expect(plane.state.operations).toHaveLength(1);
    expect(plane.state.effects).toBe(0);
  });

  test("the same tool_call_id with different content is a 409 conflict", async () => {
    const { plane, call } = planeFixture();
    const capability = mintCapability();
    await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());

    const otherArgs = { search: "somewhere-else" };
    const conflicting = await call(
      "/internal/enterprise/v1/tool-invocations/prepare",
      capability,
      proposal({ args: otherArgs, args_digest: canonicalArgsDigest(otherArgs) }),
    );
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ error_code: "operation_conflict" });
    expect(plane.state.operations).toHaveLength(1);
    expect(plane.state.effects).toBe(0);
  });

  test("a submitted operation cannot be re-proposed past with a new tool_call_id", async () => {
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      outcome: () => ({ status: "submitted" }),
    });
    const capability = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const executed = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      capability,
      {
        operation_id,
        attempt_id: ATTEMPT_1,
        args_digest: canonicalArgsDigest({ search: "incident" }),
        fencing_token: FENCING_1,
      },
    );
    expect(executed.status).toBe(200);
    expect(((await executed.json()) as { status: string }).status).toBe("submitted");

    // The model proposes the SAME business content under a NEW tool_call_id:
    // the plane refuses to allocate a fresh operation and points at the
    // frozen one instead.
    const bypass = await call(
      "/internal/enterprise/v1/tool-invocations/prepare",
      capability,
      proposal({ tool_call_id: "run_1|attempt_1|probe_governed|002" }),
    );
    expect(bypass.status).toBe(409);
    expect(await bypass.json()).toMatchObject({
      error_code: "reconciliation_required",
      operation_id,
      reconciliation_required: true,
    });
    expect(plane.state.operations).toHaveLength(1);
  });

  test("the prepare body is a strict schema: unknown fields, missing fields, non-object args and wrong digests are all 400", async () => {
    const { plane, call } = planeFixture();
    const capability = mintCapability();
    const path = "/internal/enterprise/v1/tool-invocations/prepare";

    const unknownField = await call(path, capability, proposal({ sneaky: "extra" }));
    expect(unknownField.status).toBe(400);

    const { tool_name: _drop, ...missingField } = proposal();
    const missing = await call(path, capability, missingField);
    expect(missing.status).toBe(400);

    const nonObject = await call(
      path,
      capability,
      proposal({ args: ["not", "an", "object"], args_digest: canonicalArgsDigest({}) }),
    );
    expect(nonObject.status).toBe(400);

    const wrongDigest = await call(
      path,
      capability,
      proposal({ args_digest: canonicalArgsDigest({ search: "something-else" }) }),
    );
    expect(wrongDigest.status).toBe(400);

    expect(plane.state.operations).toHaveLength(0);
  });

  test("credentials: missing, wrong or unknown are 401; an expired capability is refused (no ignoreExpiry)", async () => {
    const { plane, call } = planeFixture();
    const path = "/internal/enterprise/v1/tool-invocations/prepare";

    const noHeaders = await plane.routes.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal()),
    });
    expect(noHeaders.status).toBe(401);

    const wrongCredential = await call(path, mintCapability(), proposal(), "not-the-credential");
    expect(wrongCredential.status).toBe(401);

    const unknownCapability = await call(path, "cap_signed_by_nobody", proposal());
    expect(unknownCapability.status).toBe(401);

    const expired = mintCapability({ expires_at: Date.now() - 1_000 });
    const expiredCall = await call(path, expired, proposal());
    expect(expiredCall.status).toBe(401);
  });

  test("a capability bound to another run or fencing cannot propose or spend", async () => {
    const { plane, call } = planeFixture();
    const otherRun = mintCapability({ run_id: "run_2" });
    const refused = await call("/internal/enterprise/v1/tool-invocations/prepare", otherRun, proposal());
    expect(refused.status).toBe(403);

    // The fencing check on execute: the body must carry the capability's
    // CURRENT fencing token, not the one the operation was prepared with.
    const owner = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", owner, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const wrongFencing = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      owner,
      {
        operation_id,
        attempt_id: ATTEMPT_1,
        args_digest: canonicalArgsDigest({ search: "incident" }),
        fencing_token: "fencing_stale",
      },
    );
    expect(wrongFencing.status).toBe(403);
    expect(plane.state.effects).toBe(0);
  });

  test("execute answers the full receipt contract on success", async () => {
    const { plane, call } = planeFixture();
    const capability = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    const executed = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      capability,
      {
        operation_id,
        attempt_id: ATTEMPT_1,
        args_digest: canonicalArgsDigest({ search: "incident" }),
        fencing_token: FENCING_1,
      },
    );
    expect(executed.status).toBe(200);
    const receipt = (await executed.json()) as Record<string, unknown>;
    // The minimal field set, exactly (master plan §4.2) plus the answer text.
    expect(Object.keys(receipt).sort()).toEqual([
      "error_code",
      "execution_attempt_id",
      "operation_id",
      "receipt_ref",
      "reconciliation_required",
      "result_text",
      "status",
    ]);
    expect(receipt.operation_id).toBe(operation_id);
    expect(receipt.execution_attempt_id).toMatch(/^exec_/);
    expect(receipt.status).toBe("succeeded");
    expect(receipt.reconciliation_required).toBe(false);
    expect(typeof receipt.result_text).toBe("string");
    // The effect happened exactly once, under its own execution attempt.
    expect(plane.state.effects).toBe(1);
    expect(plane.state.receipts).toHaveLength(1);
  });

  test("execute re-checks the current authorization before spending", async () => {
    const rechecks: unknown[] = [];
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      recheck: (input) => {
        rechecks.push(input);
        return { ok: false, error_code: "membership_revoked" };
      },
    });
    const capability = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    const refused = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      capability,
      {
        operation_id,
        attempt_id: ATTEMPT_1,
        args_digest: canonicalArgsDigest({ search: "incident" }),
        fencing_token: FENCING_1,
      },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error_code: "membership_revoked" });
    expect(plane.state.effects).toBe(0);

    // The re-check ran ONCE, with the operation, the request, and the
    // capability's own principal — the observable boundary that stands for
    // membership/ACL/installation/ActionPolicy/budget in G1a.
    expect(rechecks).toHaveLength(1);
    const observed = rechecks[0] as {
      principal_id: string;
      operation: { operation_id: string; tenant_id: string; target: string };
      execution: { args_digest: string; fencing_token: string };
    };
    expect(observed.principal_id).toBe(PRINCIPAL_A);
    expect(observed.operation.operation_id).toBe(operation_id);
    expect(observed.operation.tenant_id).toBe(TENANT_A);
    expect(observed.execution.fencing_token).toBe(FENCING_1);
  });

  test("an operation that needs approval is not spent without a valid approval_ref", async () => {
    const approvals = new Map();
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      requiresApproval: () => true,
      approvals,
    });
    const capability = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const digest = canonicalArgsDigest({ search: "incident" });
    const executeBody = (over: Record<string, unknown> = {}) => ({
      operation_id,
      attempt_id: ATTEMPT_1,
      args_digest: digest,
      fencing_token: FENCING_1,
      ...over,
    });
    const executePath = `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`;

    // No approval yet: refused, nothing spent.
    const without = await call(executePath, capability, executeBody());
    expect(without.status).toBe(403);
    expect(await without.json()).toMatchObject({ error_code: "approval_required" });
    expect(plane.state.effects).toBe(0);

    // An approval for OTHER arguments does not unlock this spend.
    approvals.set("approval_wrong_digest", {
      operation_id,
      args_digest: canonicalArgsDigest({ search: "different" }),
      expires_at: Date.now() + 60_000,
    });
    const wrongDigest = await call(executePath, capability, executeBody({ approval_ref: "approval_wrong_digest" }));
    expect(wrongDigest.status).toBe(403);
    expect(await wrongDigest.json()).toMatchObject({ error_code: "approval_invalid" });

    // An expired approval is not an approval.
    approvals.set("approval_expired", {
      operation_id,
      args_digest: digest,
      expires_at: Date.now() - 1_000,
    });
    const expired = await call(executePath, capability, executeBody({ approval_ref: "approval_expired" }));
    expect(expired.status).toBe(403);
    expect(await expired.json()).toMatchObject({ error_code: "approval_invalid" });

    // The matching, unexpired approval spends it once.
    approvals.set("approval_ok", {
      operation_id,
      args_digest: digest,
      expires_at: Date.now() + 60_000,
    });
    const approved = await call(executePath, capability, executeBody({ approval_ref: "approval_ok" }));
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { status: string }).status).toBe("succeeded");
    expect(plane.state.effects).toBe(1);
  });

  test("a submitted receipt freezes the operation: no second spend, and the re-proposal path is closed", async () => {
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      outcome: () => ({ status: "submitted" }),
    });
    const capability = mintCapability();
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const executePath = `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`;

    const first = await call(executePath, capability, {
      operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1,
    });
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as { status: string; reconciliation_required: boolean };
    expect(receipt.status).toBe("submitted");
    expect(receipt.reconciliation_required).toBe(true);

    // The same operation cannot be spent a second time while its outcome is
    // unknown to the plane.
    const second = await call(executePath, capability, {
      operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error_code: "reconciliation_required" });

    // Re-preparing under the ORIGINAL tool_call_id answers the freeze too.
    const reprepare = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    expect(reprepare.status).toBe(200);
    const reprepareBody = (await reprepare.json()) as {
      operation_id: string; deduplicated: boolean; reconciliation_required: boolean;
    };
    expect(reprepareBody.operation_id).toBe(operation_id);
    expect(reprepareBody.deduplicated).toBe(true);
    expect(reprepareBody.reconciliation_required).toBe(true);

    // One execution attempt was ever allocated.
    expect(plane.state.receipts).toHaveLength(1);
  });

  test("a receipt may be terminal failed without an effect", async () => {
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      outcome: () => ({ status: "failed", error_code: "vendor_refused" }),
    });
    const capability = mintCapability();
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const executed = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      capability,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1 },
    );
    const receipt = (await executed.json()) as { status: string; error_code: string; reconciliation_required: boolean };
    expect(receipt.status).toBe("failed");
    expect(receipt.error_code).toBe("vendor_refused");
    expect(receipt.reconciliation_required).toBe(false);
    expect(plane.state.effects).toBe(0);
  });

  test("operations are tenant-scoped: another tenant's capability cannot even see them", async () => {
    const { plane, call } = planeFixture();
    const owner = mintCapability();
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", owner, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    const intruder = mintCapability({ tenant_id: TENANT_B, principal_id: "principal_beta" });
    const probed = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      intruder,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: canonicalArgsDigest({ search: "incident" }), fencing_token: FENCING_1 },
    );
    // 404, not 403: the operation's existence is the owner tenant's knowledge.
    expect(probed.status).toBe(404);
    expect(plane.state.effects).toBe(0);

    // The same tool_call_id under the intruder's own run is a DIFFERENT
    // operation: the dedup key includes the tenant.
    const own = await call("/internal/enterprise/v1/tool-invocations/prepare", intruder, proposal());
    expect(own.status).toBe(200);
    expect(plane.state.operations).toHaveLength(2);
  });

  test("a reused operation after success stays one effect", async () => {
    const { plane, call } = planeFixture();
    const capability = mintCapability();
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    await call(`/internal/enterprise/v1/tool-invocations/${operation_id}/execute`, capability, {
      operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1,
    });

    // The same business operation proposed again after success: the SAME
    // operation is handed back (deduplicated), not a second one.
    const reprepare = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const body = (await reprepare.json()) as { operation_id: string; deduplicated: boolean };
    expect(body.operation_id).toBe(operation_id);
    expect(body.deduplicated).toBe(true);
    expect(plane.state.operations).toHaveLength(1);
    expect(plane.state.effects).toBe(1);
  });

  /*
   * R3-C acceptance-matrix G1a row (01 plan): 旧fencing、别租户、别主体、
   * 不同attempt 的调用 → 拒绝且不调用工具。 The tenant row is pinned above;
   * these pin the attempt, principal and lease boundaries of a SPEND.
   */
  test("a spend from a different attempt of the same run is refused", async () => {
    const { plane, call } = planeFixture();
    const owner = mintCapability(); // {RUN_1, ATTEMPT_1, FENCING_1}
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", owner, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    // A resumed run's second attempt, properly credentialed for itself: the
    // capability and body agree on attempt_2, but the operation belongs to
    // attempt_1. Cross-attempt spend is refused — that is reconciliation
    // territory, not a silent re-spend by the new attempt.
    const resumed = mintCapability({ attempt_id: "attempt_2" });
    const refused = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      resumed,
      { operation_id, attempt_id: "attempt_2", args_digest: digest, fencing_token: FENCING_1 },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error_code: "binding_mismatch" });
    expect(plane.state.effects).toBe(0);
    expect(plane.state.receipts).toHaveLength(0);
  });

  test("a spend from a different principal of the same tenant is refused", async () => {
    const { plane, call } = planeFixture();
    const owner = mintCapability(); // principal_alpha's run
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", owner, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    // Same tenant, same run/fencing/attempt binding, DIFFERENT principal:
    // even a capability the platform minted for that principal spends
    // nothing of another principal's operation.
    const colleague = mintCapability({ principal_id: "principal_beta" });
    const refused = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      colleague,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1 },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error_code: "binding_mismatch" });
    expect(plane.state.effects).toBe(0);
    expect(plane.state.receipts).toHaveLength(0);
  });

  test("an operation is bound to the fencing it was proposed under: a renewed lease cannot spend it", async () => {
    const { plane, call } = planeFixture();
    const first = mintCapability(); // fencing_1's lease
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", first, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    // The lease was renewed: a fresh, validly-minted capability now carries
    // fencing_2 for the same run/attempt/principal. The operation was
    // PROPOSED under fencing_1 — the old fencing may not spend it, and the
    // new fencing may not either (master §4.3: 旧fencing不能提交工具).
    const renewed = mintCapability({ fencing_token: "fencing_2" });
    const refused = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      renewed,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: "fencing_2" },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error_code: "binding_mismatch" });

    // And the operation the proposal's own lease CAN spend still spends
    // exactly once — the boundary refused the foreign spend, not the op.
    const spent = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      first,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1 },
    );
    expect(spent.status).toBe(200);
    expect(plane.state.effects).toBe(1);
  });

  /*
   * R3-B② (01 plan): an unknown outcome is machine-checkable and queryable.
   * The unknown receipt freezes the operation, and the freeze is visible
   * through the plane — re-prepare reports reconciliation_required instead
   * of a fresh operation, and a second spend is the reconciliation 409.
   */
  test("an unknown receipt freezes the operation and the freeze stays queryable", async () => {
    const { plane, call } = planeFixture({
      serviceCredential: TOOL_SERVICE_CREDENTIAL,
      capabilities,
      outcome: () => ({ status: "unknown" }),
    });
    const capability = mintCapability();
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };
    const executePath = `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`;

    const first = await call(executePath, capability, {
      operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1,
    });
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as {
      status: string; reconciliation_required: boolean; result_text?: string;
    };
    // Machine-checkable: the status IS the frozen enum's unknown, flagged
    // for reconciliation, and it is not dressed up as an answer.
    expect(receipt.status).toBe("unknown");
    expect(receipt.reconciliation_required).toBe(true);
    expect(receipt.result_text).toBeUndefined();

    // Queryable: re-preparing the same business content reports the SAME
    // frozen operation instead of allocating a fresh one.
    const requiry = await call("/internal/enterprise/v1/tool-invocations/prepare", capability, proposal());
    const requiryBody = (await requiry.json()) as {
      operation_id: string; deduplicated: boolean; reconciliation_required: boolean;
    };
    expect(requiryBody.operation_id).toBe(operation_id);
    expect(requiryBody.deduplicated).toBe(true);
    expect(requiryBody.reconciliation_required).toBe(true);

    // And a second spend attempt is the reconciliation 409, never a re-run.
    const second = await call(executePath, capability, {
      operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error_code: "reconciliation_required" });
    expect(plane.state.effects).toBe(0);
    expect(plane.state.receipts).toHaveLength(1);
  });

  /*
   * R3-B④ (01 plan): a short-term capability update re-authenticates per
   * call — the plane never remembers yesterday's credential. A re-issued
   * capability (the platform re-verified membership/lease before minting it)
   * spends from the first request; the expired original keeps being refused.
   */
  test("a re-issued capability re-authenticates per call; the expired original stays refused", async () => {
    const { plane, call } = planeFixture();
    const original = mintCapability();
    const digest = canonicalArgsDigest({ search: "incident" });
    const prepared = await call("/internal/enterprise/v1/tool-invocations/prepare", original, proposal());
    const { operation_id } = (await prepared.json()) as { operation_id: string };

    // The capability is re-issued after the approval round (same binding,
    // fresh expiry): per-call re-authentication accepts it immediately —
    // there is no process-level credential the update could bypass.
    const reissued = mintCapability();
    const spent = await call(
      `/internal/enterprise/v1/tool-invocations/${operation_id}/execute`,
      reissued,
      { operation_id, attempt_id: ATTEMPT_1, args_digest: digest, fencing_token: FENCING_1 },
    );
    expect(spent.status).toBe(200);
    expect(((await spent.json()) as { status: string }).status).toBe("succeeded");
    expect(plane.state.effects).toBe(1);

    // The expired original is still refused everywhere (no ignoreExpiry).
    const expired = mintCapability({ expires_at: Date.now() - 1_000 });
    const refused = await call("/internal/enterprise/v1/tool-invocations/prepare", expired, proposal());
    expect(refused.status).toBe(401);
  });
});
