import { describe, expect, test } from "bun:test";

import {
  createRuntimeVerifier,
  type CapabilityLookup,
  type CapabilityRecord,
} from "../../src/enterprise/runtime/verifier";
import { invocationEnvelopeDigest } from "../../src/enterprise/runtime/envelope-digest";
import { createRuntimeInvocationValidationRoutes } from "../../src/enterprise/runtime/validation-routes";
import {
  RUNTIME_CAPABILITY_HEADER,
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

const CAPABILITY_SECRET = "capability-secret-runtime";

function matchingRecord(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
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

function verifierWith(record: CapabilityRecord | null | Error) {
  const findCapability: CapabilityLookup = async () => {
    if (record instanceof Error) throw record;
    return record;
  };
  return createRuntimeVerifier({
    serviceCredential: "shared-secret",
    expectedServiceId: "runtime-go-1",
    findCapability,
    now: () => NOW,
  });
}

describe("createRuntimeVerifier", () => {
  test("matching credentials and bindings verify", async () => {
    const verdict = await verifierWith(matchingRecord())({
      serviceCredential: "shared-secret",
      capability: CAPABILITY_SECRET,
      invocation: INVOCATION,
    });
    expect(verdict).toEqual({ status: "ok" });
  });

  test("a wrong service credential is refused before any lookup", async () => {
    let lookedUp = false;
    const findCapability: CapabilityLookup = async () => {
      lookedUp = true;
      return matchingRecord();
    };
    const verify = createRuntimeVerifier({
      serviceCredential: "shared-secret",
      findCapability,
      now: () => NOW,
    });
    const verdict = await verify({
      serviceCredential: "wrong-secret",
      capability: CAPABILITY_SECRET,
      invocation: INVOCATION,
    });
    expect(verdict).toEqual({ status: "invalid_credential" });
    expect(lookedUp).toBe(false);
  });

  test("unknown, revoked, expired, wrong-audience and wrong-service tokens are credential failures", async () => {
    for (const record of [
      null,
      matchingRecord({ revokedAt: new Date("2026-10-10T11:00:00Z") }),
      matchingRecord({ expiresAt: new Date("2026-10-10T11:59:59Z") }),
      matchingRecord({ audience: "model" }),
      matchingRecord({ serviceId: "someone-else" }),
    ]) {
      const verdict = await verifierWith(record)({
        serviceCredential: "shared-secret",
        capability: CAPABILITY_SECRET,
        invocation: INVOCATION,
      });
      expect(verdict).toEqual({ status: "invalid_credential" });
    }
  });

  test("a capability minted for a different envelope is a binding mismatch", async () => {
    const verdict = await verifierWith(
      matchingRecord({ envelopeDigest: "0".repeat(64) }),
    )({
      serviceCredential: "shared-secret",
      capability: CAPABILITY_SECRET,
      invocation: INVOCATION,
    });
    expect(verdict).toEqual({ status: "binding_mismatch" });
  });

  test("borrowed bindings for another attempt, lease or fence are binding mismatches", async () => {
    for (const overrides of [
      { attemptId: "attempt-2" },
      { leaseId: "lease-9" },
      { fencingToken: 4 },
      { runId: "run-2" },
    ]) {
      const verdict = await verifierWith(matchingRecord(overrides))({
        serviceCredential: "shared-secret",
        capability: CAPABILITY_SECRET,
        invocation: INVOCATION,
      });
      expect(verdict).toEqual({ status: "binding_mismatch" });
    }
  });

  test("a ledger that cannot be asked is unavailable, never a guess", async () => {
    const verdict = await verifierWith(new Error("connection refused"))({
      serviceCredential: "shared-secret",
      capability: CAPABILITY_SECRET,
      invocation: INVOCATION,
    });
    expect(verdict).toEqual({ status: "unavailable" });
  });
});

describe("the mounted validation route with the real verifier", () => {
  function appWith(record: CapabilityRecord | null) {
    return createRuntimeInvocationValidationRoutes({
      verify: verifierWith(record),
    });
  }

  function request(record: CapabilityRecord | null, headers: Record<string, string>) {
    return appWith(record).request(
      "/internal/enterprise/v1/runtime/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(INVOCATION),
      },
    );
  }

  test("verified credentials echo the envelope and nothing else", async () => {
    const response = await request(matchingRecord(), {
      [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "shared-secret",
      [RUNTIME_CAPABILITY_HEADER]: CAPABILITY_SECRET,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(INVOCATION);
  });

  test("an unknown service credential is 401 through the route", async () => {
    const response = await request(matchingRecord(), {
      [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "nope",
      [RUNTIME_CAPABILITY_HEADER]: CAPABILITY_SECRET,
    });
    expect(response.status).toBe(401);
  });

  test("a capability borrowed from another run is 403 through the route", async () => {
    const response = await request(matchingRecord({ runId: "run-2" }), {
      [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "shared-secret",
      [RUNTIME_CAPABILITY_HEADER]: CAPABILITY_SECRET,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "binding_mismatch" });
  });

  test("a capability for an unknown tenant is 401 through the route", async () => {
    const otherTenant = await appWith(null).request(
      "/internal/enterprise/v1/runtime/validate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "shared-secret",
          [RUNTIME_CAPABILITY_HEADER]: CAPABILITY_SECRET,
        },
        body: JSON.stringify({ ...INVOCATION, tenant_id: "tenant-x" }),
      },
    );
    expect(otherTenant.status).toBe(401);
  });

  test("a ledger outage is 503 through the route", async () => {
    const app = createRuntimeInvocationValidationRoutes({
      verify: createRuntimeVerifier({
        serviceCredential: "shared-secret",
        findCapability: async () => {
          throw new Error("connection refused");
        },
        now: () => NOW,
      }),
    });
    const response = await app.request(
      "/internal/enterprise/v1/runtime/validate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RUNTIME_SERVICE_CREDENTIAL_HEADER]: "shared-secret",
          [RUNTIME_CAPABILITY_HEADER]: CAPABILITY_SECRET,
        },
        body: JSON.stringify(INVOCATION),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });
});
