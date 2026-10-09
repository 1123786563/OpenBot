import { Hono } from "hono";

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
