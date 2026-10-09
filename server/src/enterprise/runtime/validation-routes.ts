import { Hono } from "hono";

/*
 * ---------------------------------------------------------------------------
 * The v0.2 enterprise wire (master plan §4.2 + 01 plan R2): the internal
 * validation endpoint for the Go runtime. Everything above this marker is
 * the LEGACY assertion-format route, kept verbatim as its own regression
 * suite; it is not the enterprise contract and must never be mounted where
 * the envelope route below serves.
 * ---------------------------------------------------------------------------
 */

/** The full internal path the enterprise route serves (master §4.1). */
export const RUNTIME_VALIDATE_PATH = "/internal/enterprise/v1/runtime/validate";

/** The initiator kinds the wire contract freezes. */
const INITIATOR_KINDS = ["user", "schedule"] as const;

/**
 * The strict RuntimeInvocation (master plan §4.2, wire schema v1):
 * snake_case, every field required except delegation_ref, which a scheduled
 * initiation must carry. This is the ONLY identity-carrying body shape the
 * enterprise validation endpoint accepts.
 */
export type RuntimeInvocation = {
  schema_version: string;
  tenant_id: string;
  principal_id: string;
  actor_id: string;
  initiator_kind: (typeof INITIATOR_KINDS)[number];
  run_id: string;
  attempt_id: string;
  turn_id: string;
  thread_id: string;
  expert_version: string;
  input_digest: string;
  model_route_ref: string;
  budget_reservation_id: string;
  lease_id: string;
  fencing_token: string;
  expires_at: string;
  delegation_ref?: string;
};

/** The fields a RuntimeInvocation must carry, and the one it may. */
const REQUIRED_INVOCATION_FIELDS = [
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
] as const satisfies Array<Exclude<keyof RuntimeInvocation, "delegation_ref">>;

const OPTIONAL_INVOCATION_FIELDS = ["delegation_ref"] as const;

/** RFC3339 with an offset — the one timestamp shape the wire freezes. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * What the host's verify decided. The route maps each verdict to exactly one
 * status; the host — which holds the capability keys and the authoritative
 * ledgers — is the only place these judgements can be made.
 */
export type InvocationVerifyOutcome =
  | { status: "ok" }
  /** Service credential unknown, or capability invalid/expired/wrong audience. */
  | { status: "invalid_credential" }
  /**
   * Verified credentials whose bindings do not hold: envelope vs capability
   * (run/attempt/turn/thread), or the CURRENT lease — an expired or
   * superseded lease is a binding refusal, not a credential failure.
   */
  | { status: "binding_mismatch" }
  /** The authoritative ledger could not be queried: neither yes nor no. */
  | { status: "unavailable" };

/** What the host supplies to make envelope verification real. No default. */
export type InvocationValidationDeps = {
  verify(input: {
    serviceCredential: string;
    capability: string;
    invocation: RuntimeInvocation;
  }): Promise<InvocationVerifyOutcome>;
};

/**
 * The enterprise validation routes: one POST at the full internal path.
 *
 * Statuses, and only these: missing service authentication (or capability)
 * is 401; a body that is not the strict envelope is 400 with a specific
 * error code; an unverifiable credential is 401; a binding mismatch (the
 * current-lease case included) is 403; a ledger the plane cannot query is
 * 503. Success returns the minimal verified envelope — the invocation it
 * just vouched for, field for field, and nothing else: no user object, no
 * key, no member list. A runtime is a caller the fewer cells it can read,
 * the fewer it can leak.
 */
export function createRuntimeInvocationValidationRoutes(
  deps: InvocationValidationDeps,
): Hono {
  const routes = new Hono();

  routes.post(RUNTIME_VALIDATE_PATH, async (c) => {
    // Service authentication first: no header is not a shape question, it
    // is an unauthenticated caller.
    const serviceCredential =
      c.req.header("x-openbot-runtime-service-credential") ?? "";
    const capability = c.req.header("x-openbot-runtime-capability") ?? "";
    if (!serviceCredential || !capability) {
      return c.json({ error: "missing_service_auth" }, 401);
    }

    let text: string;
    try {
      text = await readCappedBody(c.req.raw.body, MAX_BODY_BYTES);
    } catch {
      return c.json({ error: "body_too_large" }, 413);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const body = raw as Record<string, unknown>;

    // Strict schema: unknown fields are refused, not ignored — a caller
    // smuggling extra keys into an identity body is probing, not configuring.
    const known = new Set<string>([
      ...REQUIRED_INVOCATION_FIELDS,
      ...OPTIONAL_INVOCATION_FIELDS,
    ]);
    const unknownField = Object.keys(body).find((key) => !known.has(key));
    if (unknownField !== undefined) {
      return c.json({ error: "unknown_field" }, 400);
    }

    const missing = REQUIRED_INVOCATION_FIELDS.filter(
      (field) => typeof body[field] !== "string" || (body[field] as string) === "",
    );
    if (missing.length > 0) {
      return c.json({ error: "missing_fields" }, 400);
    }
    if (
      body.delegation_ref !== undefined &&
      (typeof body.delegation_ref !== "string" || body.delegation_ref === "")
    ) {
      return c.json({ error: "missing_fields" }, 400);
    }

    const invocation = body as unknown as RuntimeInvocation;

    if (!RFC3339.test(invocation.expires_at) || Number.isNaN(Date.parse(invocation.expires_at))) {
      return c.json({ error: "invalid_expires_at" }, 400);
    }
    if (!INITIATOR_KINDS.includes(invocation.initiator_kind)) {
      return c.json({ error: "invalid_initiator_kind" }, 400);
    }
    if (
      invocation.initiator_kind === "schedule" &&
      (invocation.delegation_ref === undefined || invocation.delegation_ref === "")
    ) {
      return c.json({ error: "schedule_requires_delegation" }, 400);
    }

    const verdict = await deps.verify({ serviceCredential, capability, invocation });
    switch (verdict.status) {
      case "ok":
        return c.json(invocation);
      case "invalid_credential":
        return c.json({ error: "unverified" }, 401);
      case "binding_mismatch":
        return c.json({ error: "binding_mismatch" }, 403);
      case "unavailable":
        return c.json({ error: "unavailable" }, 503);
    }
  });

  return routes;
}

/**
 * The Go runtime candidate's identity oracle.
 *
 * Go holds no signing key and no member database, so before an AG-UI run enters
 * its runner, the Go middleware asks this route to turn two presented
 * credentials — the `x-openbot-agent-token` header and the signed run assertion
 * in the body — into the whitelist of fields a run is allowed to know. TS does
 * the vouching here because TS is where signatures and membership already live.
 *
 * THE ROUTE RETURNS ONLY THE WHITELIST. Not the signed payload, not the key,
 * not a full User object: the caller is a runtime process, and the fewer cells
 * it can read, the fewer it can leak. Everything the Go side cannot read here,
 * it cannot be tricked into echoing into a model prompt or a log line later.
 */

/** The identity fields the Go runtime may bind a run to. Nothing else leaves. */
export type RuntimeVerificationIdentity = {
  tenantId: string;
  actorId: string;
  botId: string;
  runId: string;
  threadId: string;
};

/**
 * What the host supplies to make verification real.
 *
 * There is deliberately NO default implementation: a default that accepted
 * every identity would turn this route into an "on" switch for impersonation,
 * so a host that wires nothing gets a route that cannot be mounted, not a route
 * that says yes. Production wiring resolves the token against the agent token
 * store and the assertion against `readRunAssertion` with the deployment key;
 * the candidate stage exercises both through tests, and real tenants wait for
 * the T2 gate before any of this is mounted anywhere a request can reach.
 */
export type ValidationDeps = {
  verify(
    token: string,
    assertion: string,
  ): Promise<RuntimeVerificationIdentity | null>;
};

/**
 * How large a validation body may be.
 *
 * The assertion is a few hundred bytes of signed base64; anything bigger is not
 * a credential, it is an attempt to make the governance plane hold a payload it
 * was never asked to vouch for.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** The header carrying the agent token, shared with the legacy tool-call route. */
const AGENT_TOKEN_HEADER = "x-openbot-agent-token";

/**
 * Read a stream as text, refusing once it passes the cap.
 *
 * Counted in bytes as they arrive, so a hostile body is cut off mid-flight
 * rather than buffered whole and then measured. A body exactly at the cap is
 * fine; one byte over is refused.
 */
async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      throw new Error("body exceeds the validation cap");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * The validation routes for the runtime candidate.
 *
 * Statuses, and only these: a missing field is 400, a credential that does not
 * verify is 401, a verified identity bound to a different run is 403. The
 * runId/threadId comparison is what makes a stolen-but-valid assertion useless
 * against somebody else's run: the deployment signed WHICH run it vouched for,
 * and this route checks the caller is that run.
 */
export function createRuntimeValidationRoutes(deps: ValidationDeps): Hono {
  const routes = new Hono();

  routes.post("/validate", async (c) => {
    // Read the body as bytes under a hard cap: a credential is a few hundred
    // bytes, and a caller trying to make the plane hold a giant payload is
    // stopped at the read, before any parse.
    let text: string;
    try {
      text = await readCappedBody(c.req.raw.body, MAX_BODY_BYTES);
    } catch {
      return c.json({ error: "body_too_large" }, 413);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "missing_fields" }, 400);
    }
    const body = raw as Record<string, unknown>;
    const assertion = body.assertion;
    const runId = body.runId;
    const threadId = body.threadId;
    if (
      typeof assertion !== "string" ||
      !assertion ||
      typeof runId !== "string" ||
      !runId ||
      typeof threadId !== "string" ||
      !threadId
    ) {
      return c.json({ error: "missing_fields" }, 400);
    }
    /*
     * A missing token is not a "missing field" the way a missing assertion is:
     * the assertion names the run, the token names the agent, and a caller that
     * presents no token has presented a credential that cannot verify. That is
     * verify()'s verdict to return (401), not a shape error (400), so the empty
     * string flows through and the host's real lookup refuses it like any other
     * unknown token.
     */
    const token = c.req.header(AGENT_TOKEN_HEADER) ?? "";
    const identity = await deps.verify(token, assertion);
    if (!identity) return c.json({ error: "unverified" }, 401);

    if (identity.runId !== runId || identity.threadId !== threadId) {
      return c.json({ error: "run_binding_mismatch" }, 403);
    }

    return c.json({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      botId: identity.botId,
      runId: identity.runId,
      threadId: identity.threadId,
    });
  });

  return routes;
}
