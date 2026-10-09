import { describe, expect, test } from "bun:test";
import {
  createRuntimeInvocationValidationRoutes,
  RUNTIME_VALIDATE_PATH,
  type InvocationValidationDeps,
  type RuntimeInvocation,
} from "../../src/enterprise/runtime/validation-routes";

/*
 * The v0.2 enterprise wire (master plan §4.2 + 01 plan R2): the internal
 * validation endpoint a Go runtime presents a strict RuntimeInvocation and
 * a short-term capability to, and gets back the minimal verified envelope.
 *
 * Statuses, exactly these: a missing service authentication header is 401;
 * a body that is not the strict envelope is 400 (per-field, unknown fields
 * included); a capability that does not verify — invalid, expired, wrong
 * audience — is 401; a verified identity whose bindings do not match —
 * run/attempt/turn/thread, or the CURRENT lease — is 403; a plane that
 * cannot query its authoritative ledger is 503. The success body is the
 * envelope and nothing else: no user object, no key, no member list.
 *
 * The legacy assertion-format route keeps its own regression suite in
 * runtime-validation.test.ts; this file is the envelope contract.
 */

/** A complete, well-formed invocation; every test mutates from here. */
function invocation(over: Partial<RuntimeInvocation> = {}): RuntimeInvocation {
  return {
    schema_version: "1",
    tenant_id: "tenant_fixed_test_member",
    principal_id: "principal_1",
    actor_id: "actor_1",
    initiator_kind: "user",
    run_id: "run_1",
    attempt_id: "attempt_1",
    turn_id: "turn_1",
    thread_id: "thread_1",
    expert_version: "expert@1.0.0",
    input_digest: "a".repeat(64),
    model_route_ref: "route@1",
    budget_reservation_id: "budget_1",
    lease_id: "lease_1",
    fencing_token: "fencing_1",
    expires_at: "2099-01-01T00:00:00Z",
    ...over,
  };
}

const SERVICE_CREDENTIAL = "test-service-credential-not-a-real-one";
const CAPABILITY = "test-capability-not-a-real-one";

/** The host's verify, modelled per test; "ok" by default. */
function depsWith(
  outcome: Awaited<ReturnType<InvocationValidationDeps["verify"]>>,
  seen: InvocationValidationDeps["verify"][] = [],
): InvocationValidationDeps {
  return {
    verify: async (input) => {
      seen.push(input);
      return outcome;
    },
  };
}

function post(
  body: unknown,
  headerOverrides: Record<string, string | null> = {},
  deps: InvocationValidationDeps = depsWith({ status: "ok" }),
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-openbot-runtime-service-credential": SERVICE_CREDENTIAL,
    "x-openbot-runtime-capability": CAPABILITY,
  };
  for (const [key, value] of Object.entries(headerOverrides)) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  const app = createRuntimeInvocationValidationRoutes(deps);
  return app.request(RUNTIME_VALIDATE_PATH, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("the route lives at the full enterprise path", async () => {
  const app = createRuntimeInvocationValidationRoutes(depsWith({ status: "ok" }));
  const wrongPath = await app.request("/validate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-runtime-service-credential": SERVICE_CREDENTIAL,
      "x-openbot-runtime-capability": CAPABILITY,
    },
    body: JSON.stringify(invocation()),
  });
  expect(wrongPath.status).toBe(404);
  const rightPath = await post(invocation());
  expect(rightPath.status).toBe(200);
});

describe("service authentication", () => {
  test("a request without the service credential header is 401, before anything else", async () => {
    const seen: Parameters<InvocationValidationDeps["verify"]>[0][] = [];
    const deps: InvocationValidationDeps = {
      verify: async (input) => {
        seen.push(input);
        return { status: "ok" };
      },
    };
    const response = await post(
      invocation(),
      { "x-openbot-runtime-service-credential": null },
      deps,
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("an empty service credential is the same refusal", async () => {
    const response = await post(invocation(), {
      "x-openbot-runtime-service-credential": "",
    });
    expect(response.status).toBe(401);
  });

  test("a request without a capability header is 401", async () => {
    const response = await post(invocation(), {
      "x-openbot-runtime-capability": "",
    });
    expect(response.status).toBe(401);
  });
});

describe("the strict envelope schema", () => {
  test("every required field is load-bearing", async () => {
    const full = invocation();
    for (const key of Object.keys(full) as Array<keyof RuntimeInvocation>) {
      const body = { ...full } as Record<string, unknown>;
      delete body[key];
      const response = await post(body);
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error?: string };
      expect(error.error).toBe("missing_fields");
    }
  });

  test("unknown fields are refused, not ignored", async () => {
    const response = await post({ ...invocation(), user_object: { email: "someone" } });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error?: string };
    expect(error.error).toBe("unknown_field");
  });

  test("a non-object body is 400", async () => {
    for (const body of ["[]", '"string"', "null", "this is not json"]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
  });

  test("an expires_at that is not an RFC3339 timestamp is 400", async () => {
    for (const bad of ["not-a-timestamp", "0", "2099-13-45T99:00:00Z"]) {
      const response = await post(invocation({ expires_at: bad }));
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error?: string };
      expect(error.error).toBe("invalid_expires_at");
    }
  });

  test("an initiator kind outside the contract is 400", async () => {
    const response = await post(invocation({ initiator_kind: "attacker" }));
    expect(response.status).toBe(400);
  });

  test("a scheduled initiation must carry delegation_ref", async () => {
    const response = await post(invocation({ initiator_kind: "schedule" }));
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error?: string };
    expect(error.error).toBe("schedule_requires_delegation");
  });

  test("a user-initiated run carrying a delegation ref is accepted", async () => {
    const response = await post(invocation({ delegation_ref: "delegation_1" }));
    expect(response.status).toBe(200);
  });

  test("a body far larger than an envelope is 413", async () => {
    const response = await post({ ...invocation(), padding: "x".repeat(128 * 1024) });
    expect(response.status).toBe(413);
  });
});

describe("the host's verify verdicts", () => {
  test("an invalid or expired capability is 401", async () => {
    const response = await post(invocation(), {}, depsWith({ status: "invalid_credential" }));
    expect(response.status).toBe(401);
  });

  test("a binding mismatch — including the CURRENT lease — is 403", async () => {
    /*
     * 当前 lease 不符: the capability is real and unexpired, but the lease
     * it names is no longer the run's current lease (expired, superseded by
     * a recovered attempt). Only the authoritative ledger knows, which is
     * why this is the host verify's verdict — surfaced as a binding
     * refusal, never silently accepted.
     */
    const response = await post(invocation(), {}, depsWith({ status: "binding_mismatch" }));
    expect(response.status).toBe(403);
  });

  test("a ledger the plane cannot query is 503", async () => {
    const response = await post(invocation(), {}, depsWith({ status: "unavailable" }));
    expect(response.status).toBe(503);
  });

  test("the verify sees the service credential and the capability, never more", async () => {
    const seen: Parameters<InvocationValidationDeps["verify"]>[0][] = [];
    const deps: InvocationValidationDeps = {
      verify: async (input) => {
        seen.push(input);
        return { status: "ok" };
      },
    };
    const app = createRuntimeInvocationValidationRoutes(deps);
    await app.request(RUNTIME_VALIDATE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-runtime-service-credential": SERVICE_CREDENTIAL,
        "x-openbot-runtime-capability": CAPABILITY,
        "x-openbot-agent-token": "legacy-header-must-not-authorize",
      },
      body: JSON.stringify(invocation()),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      serviceCredential: SERVICE_CREDENTIAL,
      capability: CAPABILITY,
    });
  });
});

describe("the verified answer", () => {
  test("success returns the minimal envelope and nothing else", async () => {
    const response = await post(invocation({ delegation_ref: "delegation_1" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "schema_version",
        "tenant_id",
        "principal_id",
        "actor_id",
        "initiator_kind",
        "run_id",
        "attempt_id",
        "turn_id",
        "thread_id",
        "expert_version",
        "input_digest",
        "model_route_ref",
        "budget_reservation_id",
        "lease_id",
        "fencing_token",
        "expires_at",
        "delegation_ref",
      ].sort(),
    );
    expect(body.tenant_id).toBe("tenant_fixed_test_member");
    expect(body.turn_id).toBe("turn_1");
  });

  test("a user-initiated success carries no delegation_ref field at all", async () => {
    const response = await post(invocation());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect("delegation_ref" in body).toBe(false);
  });
});
