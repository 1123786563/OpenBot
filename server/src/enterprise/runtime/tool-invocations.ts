import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";

/*
 * ---------------------------------------------------------------------------
 * The enterprise tool-invocation endpoints (master plan §4.1/§4.2, 01 plan
 * R3-A): the G1a ISOLATED FAKE of the platform's tool domain.
 *
 * What this file is: the two internal endpoints the Go runtime's
 * Prepare/Execute client talks to, with the platform semantics expressed as
 * an in-memory fake — dedup on (tenant_id, run_id, tool_call_id), binding of
 * step/target/args-digest/installation, approval gating, fencing checks and
 * receipts with the frozen status enum. Tests and the R4 probe mount it
 * against localhost only; it performs no real vendor action.
 *
 * What this file is NOT: the production tool ledger or an authorization
 * library. The real operation ledger, ActionPolicy, membership/ACL and
 * budget checks belong to P3/E1 and are deliberately NOT copied here — the
 * `recheck` dependency is the one observable boundary where those checks
 * live in production, and tests inject it to assert it runs.
 *
 * Identity never comes from the body: the tenant/principal is whatever the
 * short-term capability resolves to, the capability is re-validated on
 * every call, and an expired capability is refused (no ignoreExpiry — the
 * platform re-issues after re-verifying membership, delegation and lease).
 * ---------------------------------------------------------------------------
 */

/** The fixed internal prefix (master plan §4.1). */
export const TOOL_INVOCATIONS_PREFIX = "/internal/enterprise/v1/tool-invocations";

/** The strict proposal body (master plan §4.2 plus the G1a candidate's tool_name). */
export type ToolPreparation = {
  tool_name: string;
  run_id: string;
  attempt_id: string;
  tool_call_id: string;
  step_id: string;
  installation_version: string;
  target: string;
  args: Record<string, unknown>;
  args_digest: string;
  fencing_token: string;
};

/** What prepare answers: the operation reference and its gating facts. */
export type PreparationAnswer = {
  operation_id: string;
  requires_approval: boolean;
  safety_preview: string;
  deduplicated: boolean;
  reconciliation_required: boolean;
};

/** The strict execution request (operation_id rides the path AND the body). */
export type ToolExecutionRequest = {
  operation_id: string;
  attempt_id: string;
  args_digest: string;
  approval_ref?: string;
  fencing_token: string;
};

/** The receipt statuses the wire contract freezes. HTTP 200 is not completion. */
export type ReceiptStatus = "not_submitted" | "submitted" | "succeeded" | "failed" | "unknown";

/** The structured receipt (master plan §4.2 minimal set plus the answer text). */
export type Receipt = {
  operation_id: string;
  execution_attempt_id: string;
  status: ReceiptStatus;
  receipt_ref: string;
  error_code: string;
  reconciliation_required: boolean;
  result_text?: string;
};

/** What a capability resolves to: the identity source for every call. */
export type ToolCapabilityBinding = {
  tenant_id: string;
  principal_id: string;
  run_id: string;
  attempt_id: string;
  fencing_token: string;
  /** Epoch millis; the fake refuses expired capabilities outright. */
  expires_at: number;
};

/** The operation record the fake ledger holds. */
export type ToolOperationRecord = {
  operation_id: string;
  tenant_id: string;
  principal_id: string;
  run_id: string;
  attempt_id: string;
  tool_call_id: string;
  tool_name: string;
  step_id: string;
  target: string;
  args_digest: string;
  installation_version: string;
  /** The lease proof the operation was PROPOSED under; a renewed lease may not spend it. */
  fencing_token: string;
  status: "proposed" | ReceiptStatus;
  requires_approval: boolean;
};

/** What the re-check boundary observes on execute. */
export type RecheckInput = {
  principal_id: string;
  operation: ToolOperationRecord;
  execution: ToolExecutionRequest;
};

/** An approval the platform issued for one operation at one exact content. */
export type FakeApproval = {
  operation_id: string;
  args_digest: string;
  /** Epoch millis. */
  expires_at: number;
};

export type FakeToolPlaneDeps = {
  serviceCredential: string;
  /** Shared with the validation plane: the same capability authenticates both. */
  capabilities: Map<string, ToolCapabilityBinding>;
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
  /**
   * The one observable boundary where membership/ACL, installation
   * authorization, ActionPolicy, approval parameters and budget live in
   * production. Refusals here are 403 and spend nothing.
   */
  recheck?: (input: RecheckInput) => { ok: true } | { ok: false; error_code: string };
  /** Scripts the receipt a scripted execution answers. Default: succeeded. */
  outcome?: (operation: ToolOperationRecord) => {
    status: ReceiptStatus;
    result_text?: string;
    error_code?: string;
  };
  approvals?: Map<string, FakeApproval>;
};

export type FakeToolPlane = {
  routes: Hono;
  state: {
    operations: ToolOperationRecord[];
    receipts: Receipt[];
    /** External effects actually performed (a succeeded execution each). */
    effects: number;
    /** Every re-check the plane ran, for tests to assert on. */
    rechecks: RecheckInput[];
  };
};

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
] as const satisfies Array<keyof ToolPreparation>;

const EXECUTION_FIELDS = [
  "operation_id",
  "attempt_id",
  "args_digest",
  "approval_ref",
  "fencing_token",
] as const satisfies Array<keyof ToolExecutionRequest>;

/** How large a tool-invocation body may be: args are bounded proposals. */
const MAX_BODY_BYTES = 256 * 1024;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The frozen canonical args digest: SHA-256 hex over compact JSON with
 * object keys sorted at every level — the same bytes Go's
 * callback.DigestArgs signs (encoding/json sorts map keys).
 */
export function canonicalArgsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(args))).digest("hex");
}

/** Reads the body as text under a hard cap, refusing mid-flight overflow. */
async function readCappedBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("body exceeds the tool-invocation cap");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Parses a strict object body; returns null with the reason it was refused. */
export async function readStrictBody(
  raw: ReadableStream<Uint8Array> | null,
  knownFields: readonly string[],
  requiredFields: readonly string[],
): Promise<{ body: Record<string, unknown>; error?: string }> {
  let text: string;
  try {
    text = await readCappedBody(raw);
  } catch {
    return { body: {}, error: "body_too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: {}, error: "invalid_body" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body: {}, error: "invalid_body" };
  }
  const body = parsed as Record<string, unknown>;
  const known = new Set(knownFields);
  if (Object.keys(body).some((key) => !known.has(key))) {
    return { body, error: "unknown_field" };
  }
  for (const field of requiredFields) {
    const value = body[field];
    if (typeof value !== "string" || value === "") {
      return { body, error: "missing_fields" };
    }
  }
  return { body };
}

/** Authenticates one call: the credential pair resolves to a binding or 401s. */
function authenticate(
  serviceCredential: string | undefined,
  capability: string | undefined,
  deps: FakeToolPlaneDeps,
): ToolCapabilityBinding | null {
  if (!serviceCredential || !capability) return null;
  if (serviceCredential !== deps.serviceCredential) return null;
  const binding = deps.capabilities.get(capability);
  if (!binding || binding.expires_at < Date.now()) return null;
  return binding;
}

/**
 * Builds the fake tool-invocation plane: the two fixed internal endpoints
 * and the observable state they produce.
 */
export function createFakeToolInvocationPlane(deps: FakeToolPlaneDeps): FakeToolPlane {
  const state: FakeToolPlane["state"] = {
    operations: [],
    receipts: [],
    effects: 0,
    rechecks: [],
  };
  const api = new Hono();

  api.post(`${TOOL_INVOCATIONS_PREFIX}/prepare`, async (c) => {
    const binding = authenticate(
      c.req.header("x-openbot-runtime-service-credential"),
      c.req.header("x-openbot-runtime-capability"),
      deps,
    );
    if (!binding) return c.json({ error_code: "unauthenticated" }, 401);

    const required = PREPARATION_FIELDS.filter((field) => field !== "args");
    const { body, error } = await readStrictBody(c.req.raw.body, PREPARATION_FIELDS, required);
    if (error) return c.json({ error_code: error }, 400);
    if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) {
      return c.json({ error_code: "invalid_args" }, 400);
    }
    const args = body.args as Record<string, unknown>;
    if (canonicalArgsDigest(args) !== body.args_digest) {
      // The digest signs the exact args: a mismatch is a proposal trying to
      // be one thing on the wire and another in the ledger.
      return c.json({ error_code: "digest_mismatch" }, 400);
    }

    // Binding: the proposal must be the run/attempt/fencing the capability
    // was minted for. Trusted fields are never completed from the caller.
    if (
      body.run_id !== binding.run_id ||
      body.attempt_id !== binding.attempt_id ||
      body.fencing_token !== binding.fencing_token
    ) {
      return c.json({ error_code: "binding_mismatch" }, 403);
    }

    const proposal = {
      tool_name: body.tool_name as string,
      target: body.target as string,
      args_digest: body.args_digest as string,
      installation_version: body.installation_version as string,
    };

    // The dedup key is (tenant, run, tool_call_id) — tenant from the
    // capability, never from the body.
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

    // The content guard: the SAME business content (tool, target, digest,
    // installation) under a DIFFERENT tool_call_id while a copy is
    // submitted/unknown is a re-proposal of a frozen operation, not a new
    // intent — the model must not get past it with a fresh key.
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

    // Allocate. Prepare only PROPOSES: no effect is performed or recorded.
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
    const binding = authenticate(
      c.req.header("x-openbot-runtime-service-credential"),
      c.req.header("x-openbot-runtime-capability"),
      deps,
    );
    if (!binding) return c.json({ error_code: "unauthenticated" }, 401);

    const required = EXECUTION_FIELDS.filter((field) => field !== "approval_ref");
    const { body, error } = await readStrictBody(c.req.raw.body, EXECUTION_FIELDS, required);
    if (error) return c.json({ error_code: error }, 400);
    if (body.approval_ref !== undefined && (typeof body.approval_ref !== "string" || body.approval_ref === "")) {
      return c.json({ error_code: "missing_fields" }, 400);
    }
    const pathOperationID = c.req.param("operation_id");
    if (body.operation_id !== pathOperationID) {
      return c.json({ error_code: "operation_id_mismatch" }, 400);
    }

    // Tenant-scoped existence: another tenant's capability learns nothing,
    // not even that the operation exists.
    const operation = state.operations.find(
      (op) => op.operation_id === pathOperationID && op.tenant_id === binding.tenant_id,
    );
    if (!operation) {
      return c.json({ error_code: "operation_not_found" }, 404);
    }

    // Binding: the capability names the CURRENT lease's principal, run,
    // attempt and fencing, and the operation was proposed under exactly
    // those. A spend from another attempt of the same run, another
    // principal, or a renewed lease is refused — that is reconciliation
    // territory, not a silent cross-boundary spend (master §4.3: 旧fencing
    // 不能提交工具; R3-C row: 不同attempt/别主体 → 拒绝且不调用工具).
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

    // The spend must be the exact content that was proposed.
    if (body.args_digest !== operation.args_digest) {
      return c.json({ error_code: "operation_conflict" }, 409);
    }

    // A frozen operation is not spent twice while its outcome is unknown.
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

    const execution: ToolExecutionRequest = {
      operation_id: body.operation_id as string,
      attempt_id: body.attempt_id as string,
      args_digest: body.args_digest as string,
      fencing_token: body.fencing_token as string,
      ...(body.approval_ref !== undefined ? { approval_ref: body.approval_ref as string } : {}),
    };

    // The re-check boundary: membership/ACL, installation authorization,
    // ActionPolicy, approval parameters, budget — one observable check the
    // production plane makes here and the fake lets tests watch.
    if (deps.recheck) {
      const verdict = deps.recheck({ principal_id: binding.principal_id, operation, execution });
      state.rechecks.push({ principal_id: binding.principal_id, operation, execution });
      if (!verdict.ok) {
        return c.json({ error_code: verdict.error_code }, 403);
      }
    }

    if (operation.requires_approval) {
      const approvalRef = execution.approval_ref;
      if (approvalRef === undefined) {
        return c.json({ error_code: "approval_required" }, 403);
      }
      const approval = deps.approvals?.get(approvalRef);
      if (
        !approval ||
        approval.operation_id !== operation.operation_id ||
        approval.args_digest !== operation.args_digest ||
        approval.expires_at < Date.now()
      ) {
        return c.json({ error_code: "approval_invalid" }, 403);
      }
    }

    // One execution attempt per accepted spend; the receipt is the answer.
    const scripted = deps.outcome?.(operation) ?? { status: "succeeded" as const };
    const receipt: Receipt = {
      operation_id: operation.operation_id,
      execution_attempt_id: `exec_${randomUUID()}`,
      status: scripted.status,
      receipt_ref: `rcpt_${randomUUID()}`,
      error_code: "error_code" in scripted && scripted.error_code ? scripted.error_code : "",
      reconciliation_required: scripted.status === "submitted" || scripted.status === "unknown",
      ...(scripted.status === "succeeded" || scripted.status === "failed"
        ? {
            result_text:
              "result_text" in scripted && scripted.result_text !== undefined
                ? scripted.result_text
                : `plane-effect:${operation.tool_name}`,
          }
        : {}),
    };
    if (scripted.status !== "not_submitted") {
      operation.status = scripted.status;
    }
    if (scripted.status === "succeeded") {
      state.effects += 1;
    }
    state.receipts.push(receipt);
    return c.json(receipt, 200);
  });

  return { routes: new Hono().route("/", api), state };
}

function previewOf(
  operation: Pick<ToolOperationRecord, "tool_name" | "installation_version" | "target">,
  deps: FakeToolPlaneDeps,
): string {
  const proposal = {
    tool_name: operation.tool_name,
    target: operation.target,
    args_digest: "",
    installation_version: operation.installation_version,
  };
  return (
    deps.safetyPreview?.(proposal) ??
    `would run ${operation.tool_name} ${operation.installation_version} on ${operation.target}`
  );
}
