/**
 * The REAL tool-invocation plane behind /internal/enterprise/v1/tool-invocations.
 *
 * The G1a fake (./tool-invocations.ts) proved the wire; this module is the same contract with the
 * three production halves swapped in:
 *
 *   - AUTHENTICATION is the real verifier (./verifier.ts): the caller presents the service
 *     credential, the short-term capability AND the RuntimeInvocation envelope the run was
 *     validated with — the Go callback client forwards all three — so the capability is
 *     re-validated against the ledger's capability rows, not an in-memory map. A capability for
 *     another run never even resolves.
 *   - AUTHORIZATION is the governed tool registry from the runtime config: a tool the deployment
 *     never pinned, or a proposal naming a version other than the pinned installation, is a 403
 *     before any operation is allocated.
 *   - EXECUTION is a pluggable executor port. The default implements the built-in
 *     `enterprise_echo` tool; a deployment injects its own to reach real effect domains (P3 owns
 *     the full ActionPolicy surface, which stays OUT of here by design).
 *
 * What stays candidate-grade, on the record: the operation registry and receipts are in-memory in
 * this process. A restart forgets proposed operations (the Go side's OUTCOME_UNKNOWN discipline
 * already treats that correctly: a retried prepare re-proposes, a retried execute reconciles), and
 * the durable operation ledger belongs to P3/E1. Approvals are an injected map with the same
 * frozen semantics the fake froze.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import type { GovernedToolRef } from "./config";
import {
  canonicalArgsDigest,
  canonicalize,
  readStrictBody,
  TOOL_INVOCATIONS_PREFIX,
  type PreparationAnswer,
  type Receipt,
  type ReceiptStatus,
  type ToolCapabilityBinding,
  type ToolOperationRecord,
} from "./tool-invocations";
import type { InvocationValidationDeps } from "./validation-routes";
import {
  parseRuntimeInvocation,
  RUNTIME_CAPABILITY_HEADER,
  RUNTIME_INVOCATION_HEADER,
  RUNTIME_SERVICE_CREDENTIAL_HEADER,
} from "./wire";

export type ToolPlaneDeps = {
  /** The configured service credential, checked by the shared verifier. */
  serviceCredential: string;
  /** The real verify from ./verifier.ts — the same oracle the validation route mounts. */
  verify: InvocationValidationDeps["verify"];
  /** The deployment's governed tools; a proposal outside it is refused before allocation. */
  governedTools: ReadonlyArray<GovernedToolRef>;
  /** Executes one accepted spend. Default: the built-in enterprise_echo tool. */
  executor?: ToolExecutor;
  /** Approvals the platform issued; same frozen semantics as the fake plane. */
  approvals?: Map<string, { operation_id: string; args_digest: string; expires_at: number }>;
  requiresApproval?: (proposal: {
    tool_name: string;
    target: string;
    args_digest: string;
    installation_version: string;
  }) => boolean;
  safetyPreview?: (proposal: {
    tool_name: string;
    target: string;
    args_digest: string;
    installation_version: string;
  }) => string;
  now?: () => number;
};

/** One accepted spend handed to the effect domain. */
export type ToolExecutor = (input: {
  tenant_id: string;
  principal_id: string;
  operation: {
    tool_name: string;
    installation_version: string;
    target: string;
    step_id: string;
    args_digest: string;
  };
  args: Record<string, unknown>;
}) => Promise<{ status: "succeeded" | "failed"; result_text?: string; error_code?: string }>;

export type ToolPlane = {
  routes: Hono;
  state: {
    operations: ToolOperationRecord[];
    receipts: Receipt[];
    effects: number;
  };
};

/** The mounted route surface of the real tool plane (an alias keeping call sites honest). */
export type ToolPlaneRoutes = Hono;

const PREPARATION_FIELDS = [
  "tool_name",
  "run_id",
  "attempt_id",
  "tool_call_id",
  "step_id",
  "installation_version",
  "target",
  "args",
  "args_digest",
  "fencing_token",
] as const;

const EXECUTION_FIELDS = [
  "operation_id",
  "attempt_id",
  "args_digest",
  "approval_ref",
  "fencing_token",
] as const;

/**
 * The default executor: `enterprise_echo` answers with the canonical args as text — a real,
 * harmless effect that proves the whole chain end to end. Every other tool name fails closed;
 * the registry should have refused it earlier anyway.
 */
const echoExecutor: ToolExecutor = async ({ operation, args }) => {
  if (operation.tool_name !== "enterprise_echo") {
    return { status: "failed", error_code: "executor_not_available" };
  }
  return {
    status: "succeeded",
    result_text: canonicalArgsDigest(args) === "" ? "{}" : JSON.stringify(args),
  };
};

/**
 * Three-header authentication: the credential pair plus the envelope the capability was minted
 * for. The envelope is the trusted locator (tenant + run) the verifier's ledger lookup needs;
 * without it there is nothing to verify against, which is a 401, not a guess.
 */
type AuthRefusal = { code: string; status: 401 | 403 | 503 };

async function authenticate(
  headers: Headers,
  deps: ToolPlaneDeps,
): Promise<{ binding: ToolCapabilityBinding } | { error: AuthRefusal }> {
  const serviceCredential = headers.get(RUNTIME_SERVICE_CREDENTIAL_HEADER);
  const capability = headers.get(RUNTIME_CAPABILITY_HEADER);
  const invocation = headers.get(RUNTIME_INVOCATION_HEADER);
  if (!serviceCredential || !capability || !invocation) {
    return { error: { code: "unauthenticated", status: 401 } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(invocation);
  } catch {
    return { error: { code: "unauthenticated", status: 401 } };
  }
  const parsed = parseRuntimeInvocation(raw);
  if (!parsed.ok) {
    return { error: { code: "unauthenticated", status: 401 } };
  }
  const verdict = await deps.verify({ serviceCredential, capability, invocation: parsed.invocation });
  if (verdict.status === "unavailable") {
    return { error: { code: "unavailable", status: 503 } };
  }
  if (verdict.status === "invalid_credential") {
    return { error: { code: "unauthenticated", status: 401 } };
  }
  if (verdict.status === "binding_mismatch") {
    return { error: { code: "binding_mismatch", status: 403 } };
  }
  return {
    binding: {
      tenant_id: parsed.invocation.tenant_id,
      principal_id: parsed.invocation.principal_id,
      run_id: parsed.invocation.run_id,
      attempt_id: parsed.invocation.attempt_id,
      fencing_token: parsed.invocation.fencing_token,
      expires_at: Date.parse(parsed.invocation.expires_at) || 0,
    },
  };
}

/** Builds the real tool plane: the two fixed internal endpoints over real verification. */
export function createToolInvocationPlane(deps: ToolPlaneDeps): ToolPlane {
  const state: ToolPlane["state"] = { operations: [], receipts: [], effects: 0 };
  const executor = deps.executor ?? echoExecutor;
  /*
   * The proposed args, keyed by operation: the wire carries only the digest, so the plane keeps
   * the canonical JSON the digest signed and replays exactly that at execute time — the executor
   * never receives a body-provided copy of the args. Instance-scoped (per plane), so two tenants
   * proposing identical args can never see each other's entries.
   */
  const proposedArgs = new Map<string, string>();
  const api = new Hono();

  api.post(`${TOOL_INVOCATIONS_PREFIX}/prepare`, async (c) => {
    const auth = await authenticate(c.req.raw.headers, deps);
    if ("error" in auth) return c.json({ error_code: auth.error.code }, auth.error.status);
    const binding = auth.binding;

    const required = PREPARATION_FIELDS.filter((field) => field !== "args");
    const { body, error } = await readStrictBody(c.req.raw.body, PREPARATION_FIELDS, required);
    if (error) return c.json({ error_code: error }, 400);
    if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) {
      return c.json({ error_code: "invalid_args" }, 400);
    }
    const args = body.args as Record<string, unknown>;
    if (canonicalArgsDigest(args) !== body.args_digest) {
      return c.json({ error_code: "digest_mismatch" }, 400);
    }

    if (
      body.run_id !== binding.run_id ||
      body.attempt_id !== binding.attempt_id ||
      body.fencing_token !== binding.fencing_token
    ) {
      return c.json({ error_code: "binding_mismatch" }, 403);
    }

    // The governed registry: only deployment-pinned tools at their pinned versions may even be
    // proposed. This is the platform's tool authorization boundary; the executor is the effect.
    const registered = deps.governedTools.find((tool) => tool.name === body.tool_name);
    if (registered === undefined) {
      return c.json({ error_code: "tool_not_governed" }, 403);
    }
    if (registered.installationVersion !== body.installation_version) {
      return c.json({ error_code: "installation_version_mismatch" }, 403);
    }

    const proposal = {
      tool_name: body.tool_name as string,
      target: body.target as string,
      args_digest: body.args_digest as string,
      installation_version: body.installation_version as string,
    };

    const existing = state.operations.find(
      (op) =>
        op.tenant_id === binding.tenant_id &&
        op.run_id === body.run_id &&
        op.tool_call_id === body.tool_call_id,
    );
    if (existing) {
      const sameContent =
        existing.tool_name === proposal.tool_name &&
        existing.step_id === body.step_id &&
        existing.target === proposal.target &&
        existing.args_digest === proposal.args_digest &&
        existing.installation_version === proposal.installation_version;
      if (!sameContent) {
        return c.json({ error_code: "operation_conflict" }, 409);
      }
      return c.json(
        {
          operation_id: existing.operation_id,
          requires_approval: existing.requires_approval,
          safety_preview: previewOf(existing, deps),
          deduplicated: true,
          reconciliation_required:
            existing.status === "submitted" || existing.status === "unknown",
        } satisfies PreparationAnswer,
        200,
      );
    }

    const frozenTwin = state.operations.find(
      (op) =>
        op.tenant_id === binding.tenant_id &&
        op.run_id === body.run_id &&
        op.tool_call_id !== body.tool_call_id &&
        op.tool_name === proposal.tool_name &&
        op.target === proposal.target &&
        op.args_digest === proposal.args_digest &&
        op.installation_version === proposal.installation_version &&
        (op.status === "submitted" || op.status === "unknown"),
    );
    if (frozenTwin) {
      return c.json(
        {
          error_code: "reconciliation_required",
          operation_id: frozenTwin.operation_id,
          reconciliation_required: true,
        },
        409,
      );
    }

    const requiresApproval = deps.requiresApproval?.(proposal) ?? false;
    const record: ToolOperationRecord = {
      operation_id: `op_${randomUUID()}`,
      tenant_id: binding.tenant_id,
      principal_id: binding.principal_id,
      run_id: body.run_id as string,
      attempt_id: body.attempt_id as string,
      tool_call_id: body.tool_call_id as string,
      tool_name: proposal.tool_name,
      step_id: body.step_id as string,
      target: proposal.target,
      args_digest: proposal.args_digest,
      installation_version: proposal.installation_version,
      fencing_token: body.fencing_token as string,
      status: "proposed",
      requires_approval: requiresApproval,
    };
    state.operations.push(record);
    proposedArgs.set(record.operation_id, JSON.stringify(canonicalize(args)));
    return c.json(
      {
        operation_id: record.operation_id,
        requires_approval: requiresApproval,
        safety_preview: previewOf(record, deps),
        deduplicated: false,
        reconciliation_required: false,
      } satisfies PreparationAnswer,
      200,
    );
  });

  api.post(`${TOOL_INVOCATIONS_PREFIX}/:operation_id/execute`, async (c) => {
    const auth = await authenticate(c.req.raw.headers, deps);
    if ("error" in auth) return c.json({ error_code: auth.error.code }, auth.error.status);
    const binding = auth.binding;

    const required = EXECUTION_FIELDS.filter((field) => field !== "approval_ref");
    const { body, error } = await readStrictBody(c.req.raw.body, EXECUTION_FIELDS, required);
    if (error) return c.json({ error_code: error }, 400);
    if (
      body.approval_ref !== undefined &&
      (typeof body.approval_ref !== "string" || body.approval_ref === "")
    ) {
      return c.json({ error_code: "missing_fields" }, 400);
    }
    const pathOperationID = c.req.param("operation_id");
    if (body.operation_id !== pathOperationID) {
      return c.json({ error_code: "operation_id_mismatch" }, 400);
    }

    const operation = state.operations.find(
      (op) => op.operation_id === pathOperationID && op.tenant_id === binding.tenant_id,
    );
    if (!operation) {
      return c.json({ error_code: "operation_not_found" }, 404);
    }

    if (
      binding.run_id !== operation.run_id ||
      binding.principal_id !== operation.principal_id ||
      body.attempt_id !== binding.attempt_id ||
      body.attempt_id !== operation.attempt_id ||
      body.fencing_token !== binding.fencing_token ||
      body.fencing_token !== operation.fencing_token
    ) {
      return c.json({ error_code: "binding_mismatch" }, 403);
    }

    if (body.args_digest !== operation.args_digest) {
      return c.json({ error_code: "operation_conflict" }, 409);
    }

    if (operation.status === "submitted" || operation.status === "unknown") {
      return c.json(
        {
          error_code: "reconciliation_required",
          operation_id: operation.operation_id,
          reconciliation_required: true,
        },
        409,
      );
    }

    if (operation.requires_approval) {
      const approvalRef = body.approval_ref;
      if (approvalRef === undefined) {
        return c.json({ error_code: "approval_required" }, 403);
      }
      const approval = deps.approvals?.get(approvalRef);
      const now = deps.now ?? Date.now;
      if (
        !approval ||
        approval.operation_id !== operation.operation_id ||
        approval.args_digest !== operation.args_digest ||
        approval.expires_at < now()
      ) {
        return c.json({ error_code: "approval_invalid" }, 403);
      }
    }

    // The one effect boundary: the executor runs for the ACCEPTED spend only.
    let outcome: { status: ReceiptStatus; result_text?: string; error_code?: string };
    try {
      const executed = await executor({
        tenant_id: binding.tenant_id,
        principal_id: binding.principal_id,
        operation: {
          tool_name: operation.tool_name,
          installation_version: operation.installation_version,
          target: operation.target,
          step_id: operation.step_id,
          args_digest: operation.args_digest,
        },
        args: JSON.parse(proposedArgs.get(operation.operation_id) ?? "{}") as Record<
          string,
          unknown
        >,
      });
      outcome = executed;
    } catch {
      outcome = { status: "failed", error_code: "executor_error" };
    }

    const receipt: Receipt = {
      operation_id: operation.operation_id,
      execution_attempt_id: `exec_${randomUUID()}`,
      status: outcome.status,
      receipt_ref: `rcpt_${randomUUID()}`,
      error_code: outcome.error_code ?? "",
      reconciliation_required: outcome.status === "submitted" || outcome.status === "unknown",
      ...(outcome.status === "succeeded" || outcome.status === "failed"
        ? { result_text: outcome.result_text }
        : {}),
    };
    operation.status = outcome.status;
    if (outcome.status === "succeeded") {
      state.effects += 1;
    }
    state.receipts.push(receipt);
    return c.json(receipt, 200);
  });

  return { routes: new Hono().route("/", api), state };
}

function previewOf(
  operation: Pick<ToolOperationRecord, "tool_name" | "installation_version" | "target">,
  deps: ToolPlaneDeps,
): string {
  return (
    deps.safetyPreview?.({
      tool_name: operation.tool_name,
      target: operation.target,
      args_digest: "",
      installation_version: operation.installation_version,
    }) ??
    `would run ${operation.tool_name} ${operation.installation_version} on ${operation.target}`
  );
}
