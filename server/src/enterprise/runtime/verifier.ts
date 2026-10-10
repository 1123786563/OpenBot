/**
 * The real verifier behind /internal/enterprise/v1/runtime/validate.
 *
 * Two credentials arrive from the Go runtime: the deployment service credential (who may talk to
 * the plane at all) and the capability (which run this conversation is about). Neither is ever
 * trusted from a body: the invocation envelope names the tenant/run, the capability row is found
 * under that tenant+run pin, and every binding field is compared — a valid-but-borrowed
 * capability for another run is a binding refusal, not a credential failure, exactly as the
 * route's status mapping promises.
 *
 * The capability lookup is injected as a port so tests run without a database; the drizzle-backed
 * implementation (./capability-store.ts) opens one runtime-writer transaction pinned to the
 * invocation's tenant and run — the lookup cannot even SEE a capability belonging to another run.
 */
import { createHash } from "node:crypto";

import type { InvocationValidationDeps, InvocationVerifyOutcome } from "./validation-routes";
import { invocationEnvelopeDigest } from "./envelope-digest";
import type { RuntimeInvocation } from "./wire";

/** The columns of enterprise_capabilities the verifier needs; the token itself never lands in a row. */
export type CapabilityRecord = {
  id: string;
  tenantId: string;
  serviceId: string;
  audience: string;
  envelopeDigest: string;
  runId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

/** Finds the capability row for one tenant+run by token hash; `null` = no such token. */
export type CapabilityLookup = (
  tenantId: string,
  runId: string,
  tokenHash: string,
) => Promise<CapabilityRecord | null>;

export type RuntimeVerifierDeps = {
  /** The configured service credential; compared in constant time. */
  serviceCredential: string;
  /** The capability port; a throw is answered "unavailable", never guessed around. */
  findCapability: CapabilityLookup;
  /** The Go service identity capability rows must name, when the deployment pins one. */
  expectedServiceId?: string;
  /** Injectable clock for expiry tests. */
  now?: () => Date;
};

/** Constant-time equality over sha256 digests, so length never leaks. */
function sameSecret(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(presented, "utf8").digest();
  return a.length === b.length && timingSafeEqualBytes(a, b);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Every verdict except "ok" names which promise failed, in the route's own vocabulary:
 * invalid_credential (unknown service credential, unknown/revoked/expired/wrong-audience token,
 * wrong service), binding_mismatch (credentials that verify but bind another envelope), and
 * unavailable (the ledger could not be asked — neither yes nor no).
 */
export function createRuntimeVerifier(
  deps: RuntimeVerifierDeps,
): InvocationValidationDeps["verify"] {
  return async (input: {
    serviceCredential: string;
    capability: string;
    invocation: RuntimeInvocation;
  }): Promise<InvocationVerifyOutcome> => {
    if (!sameSecret(deps.serviceCredential, input.serviceCredential)) {
      return { status: "invalid_credential" };
    }

    const tokenHash = createHash("sha256")
      .update(input.capability, "utf8")
      .digest("hex");

    let record: CapabilityRecord | null;
    try {
      record = await deps.findCapability(
        input.invocation.tenant_id,
        input.invocation.run_id,
        tokenHash,
      );
    } catch {
      return { status: "unavailable" };
    }
    if (record === null) {
      return { status: "invalid_credential" };
    }
    if (record.revokedAt !== null) {
      return { status: "invalid_credential" };
    }
    const now = (deps.now ?? (() => new Date()))();
    if (record.expiresAt.getTime() <= now.getTime()) {
      return { status: "invalid_credential" };
    }
    if (record.audience !== "runtime" && record.audience !== "control") {
      return { status: "invalid_credential" };
    }
    if (
      deps.expectedServiceId !== undefined &&
      record.serviceId !== deps.expectedServiceId
    ) {
      return { status: "invalid_credential" };
    }

    if (
      record.envelopeDigest !== invocationEnvelopeDigest(input.invocation) ||
      record.runId !== input.invocation.run_id ||
      record.attemptId !== input.invocation.attempt_id ||
      record.leaseId !== input.invocation.lease_id ||
      String(record.fencingToken) !== input.invocation.fencing_token
    ) {
      return { status: "binding_mismatch" };
    }
    return { status: "ok" };
  };
}
