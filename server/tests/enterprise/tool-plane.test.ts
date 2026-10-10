import { describe, expect, test } from "bun:test";

import { invocationEnvelopeDigest } from "../../src/enterprise/runtime/envelope-digest";
import {
  canonicalArgsDigest,
  TOOL_INVOCATIONS_PREFIX,
} from "../../src/enterprise/runtime/tool-invocations";
import { createToolInvocationPlane } from "../../src/enterprise/runtime/tool-plane";
import {
  createRuntimeVerifier,
  type CapabilityRecord,
} from "../../src/enterprise/runtime/verifier";
import {
  RUNTIME_CAPABILITY_HEADER,
  RUNTIME_INVOCATION_HEADER,
  RUNTIME_SERVICE_CREDENTIAL_HEADER,
  type RuntimeInvocation,
} from "../../src/enterprise/runtime/wire";

const NOW = new Date("2026-10-10T12:00:00Z");

const INVOCATION: RuntimeInvocation = {
  schema_version: "1",
  tenant_id: "tenant-1",
  principal_id: "principal-1",
  actor_id: "actor-1",
  initiator_kind: "user",
  run_id: "run-1",
  attempt_id: "attempt-1",
  turn_id: "turn-1",
  thread_id: "thread-1",
  expert_version: "assistant-v1",
  input_digest: "abcd1234",
  model_route_ref: "route-1",
  budget_reservation_id: "res-1",
  lease_id: "lease-1",
  fencing_token: "3",
  expires_at: "2026-10-10T12:05:00Z",
};

const CAPABILITY = "capability-secret";

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    id: "cap-1",
    tenantId: INVOCATION.tenant_id,
    serviceId: "runtime-go-1",
    audience: "runtime",
    envelopeDigest: invocationEnvelopeDigest(INVOCATION),
    runId: INVOCATION.run_id,
    attemptId: INVOCATION.attempt_id,
    leaseId: INVOCATION.lease_id,
    fencingToken: Number(INVOCATION.fencing_token),
    expiresAt: new Date("2026-10-10T12:05:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

function plane(
  capabilityRecord: CapabilityRecord,
  options: {
    governedTools?: Array<{ name: string; installationVersion: string }>;
    executor?: Parameters<typeof createToolInvocationPlane>[0]["executor"];
  } = {},
) {
  return createToolInvocationPlane({
    serviceCredential: "shared-secret",
    verify: createRuntimeVerifier({
      serviceCredential: "shared-secret",
      expectedServiceId: "runtime-go-1",
      findCapability: async () => capabilityRecord,
      now: () => NOW,
    }),
    governedTools: options.governedTools ?? [
      { name: "enterprise_echo", installationVersion: "v1" },
    ],
    ...(options.executor ? { executor: options.executor } : {}),
  });
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "shared-secret",
    [RUNTIME_CAPABILITY_HEADER]: CAPABILITY,
    [RUNTIME_INVOCATION_HEADER]: JSON.stringify(INVOCATION),
    ...extra,
  };
}

function preparation(overrides: Record<string, unknown> = {}) {
  const args = { message: "hello" };
  return {
    tool_name: "enterprise_echo",
    run_id: INVOCATION.run_id,
    attempt_id: INVOCATION.attempt_id,
    tool_call_id: "call-1",
    step_id: INVOCATION.turn_id,
    installation_version: "v1",
    target: "enterprise_echo",
    args,
    args_digest: canonicalArgsDigest(args),
    fencing_token: INVOCATION.fencing_token,
    ...overrides,
  };
}

function execution(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: operationId,
    attempt_id: INVOCATION.attempt_id,
    args_digest: canonicalArgsDigest({ message: "hello" }),
    fencing_token: INVOCATION.fencing_token,
    ...overrides,
  };
}

async function prepare(
  app: ReturnType<typeof plane>["routes"],
  body: Record<string, unknown>,
  requestHeaders: Record<string, string> = headers(),
) {
  return app.request(`${TOOL_INVOCATIONS_PREFIX}/prepare`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

async function execute(
  app: ReturnType<typeof plane>["routes"],
  operationId: string,
  body: Record<string, unknown>,
  requestHeaders: Record<string, string> = headers(),
) {
  return app.request(`${TOOL_INVOCATIONS_PREFIX}/${operationId}/execute`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

describe("the real tool plane", () => {
  test("a governed proposal executes through the echo executor and returns a receipt", async () => {
    const { routes, state } = plane(record());
    const proposed = await prepare(routes, preparation());
    expect(proposed.status).toBe(200);
    const answer = (await proposed.json()) as {
      operation_id: string;
      requires_approval: boolean;
    };
    expect(answer.requires_approval).toBe(false);

    const spent = await execute(routes, answer.operation_id, execution(answer.operation_id));
    expect(spent.status).toBe(200);
    const receipt = (await spent.json()) as { status: string; result_text: string };
    expect(receipt.status).toBe("succeeded");
    expect(receipt.result_text).toBe(JSON.stringify({ message: "hello" }));
    expect(state.effects).toBe(1);
  });

  test("the executor receives the proposed canonical args, never a body-provided copy", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { routes } = plane(record(), {
      executor: async ({ args }) => {
        seen.push(args);
        return { status: "succeeded", result_text: "ok" };
      },
    });
    const proposed = await prepare(routes, preparation());
    const { operation_id } = (await proposed.json()) as { operation_id: string };
    // The execute body carries only the digest — no args field exists to smuggle.
    const spent = await execute(routes, operation_id, execution(operation_id));
    expect(spent.status).toBe(200);
    expect(seen).toEqual([{ message: "hello" }]);
  });

  test("a tool outside the governed registry is refused before allocation", async () => {
    const { routes, state } = plane(record());
    const refused = await prepare(
      routes,
      preparation({ tool_name: "shell", target: "shell", tool_call_id: "call-2" }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error_code: "tool_not_governed" });
    expect(state.operations).toHaveLength(0);
  });

  test("a proposal naming a version other than the pinned installation is refused", async () => {
    const { routes } = plane(record());
    const refused = await prepare(
      routes,
      preparation({ installation_version: "v0", tool_call_id: "call-3" }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error_code: "installation_version_mismatch" });
  });

  test("args that do not match their digest are refused", async () => {
    const { routes } = plane(record());
    const refused = await prepare(
      routes,
      preparation({ args_digest: "0".repeat(64), tool_call_id: "call-4" }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error_code: "digest_mismatch" });
  });

  test("a body naming another run or attempt is a binding mismatch", async () => {
    const { routes } = plane(record());
    const otherRun = await prepare(
      routes,
      preparation({ run_id: "run-2", tool_call_id: "call-5" }),
    );
    expect(otherRun.status).toBe(403);
    expect(await otherRun.json()).toEqual({ error_code: "binding_mismatch" });
  });

  test("missing or malformed invocation header is unauthenticated", async () => {
    const { routes } = plane(record());
    const noHeader = await prepare(routes, preparation(), {
      ...headers(),
      [RUNTIME_INVOCATION_HEADER]: "",
    });
    expect(noHeader.status).toBe(401);

    const garbage = await prepare(routes, preparation(), {
      ...headers(),
      [RUNTIME_INVOCATION_HEADER]: "not json",
    });
    expect(garbage.status).toBe(401);
  });

  test("a capability verified against another envelope is refused by the shared verifier", async () => {
    const { routes } = plane(
      record({ envelopeDigest: "0".repeat(64) }),
    );
    const refused = await prepare(routes, preparation());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error_code: "binding_mismatch" });
  });

  test("executing an unknown operation learns nothing, not even existence", async () => {
    const { routes } = plane(record());
    const notFound = await execute(routes, "op_missing", execution("op_missing"));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error_code: "operation_not_found" });
  });

  test("a failing executor returns a failed receipt with its error code", async () => {
    const { routes, state } = plane(record(), {
      executor: async () => ({ status: "failed" as const, error_code: "effect_refused" }),
    });
    const proposed = await prepare(routes, preparation());
    const { operation_id } = (await proposed.json()) as { operation_id: string };
    const spent = await execute(routes, operation_id, execution(operation_id));
    expect(spent.status).toBe(200);
    const receipt = (await spent.json()) as { status: string; error_code: string };
    expect(receipt.status).toBe("failed");
    expect(receipt.error_code).toBe("effect_refused");
    expect(state.effects).toBe(0);
  });

  test("a revoked capability cannot even prepare", async () => {
    const { routes } = plane(record({ revokedAt: new Date("2026-10-10T11:00:00Z") }));
    const refused = await prepare(routes, preparation());
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error_code: "unauthenticated" });
  });
});
