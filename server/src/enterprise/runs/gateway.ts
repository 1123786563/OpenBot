import { createHash } from "node:crypto";
import type { Hono } from "hono";

import {
  CreateRunSchema,
  IdempotencyKeySchema,
} from "../../../../shared/enterprise/run-contracts";
import type { EnterpriseVariables } from "../app";
import type { Scope } from "../contracts";
import { EnterpriseError } from "../errors";
import type { EnterpriseRuntimeConfig } from "../runtime/config";
import type { RuntimeInvocation } from "../runtime/wire";
import {
  RUNTIME_CAPABILITY_HEADER,
  RUNTIME_INVOCATION_HEADER,
  RUNTIME_SERVICE_CREDENTIAL_HEADER,
} from "../runtime/wire";
import type { RunServiceE1 } from "./service";
import { type CreatedRun, deriveCapabilitySecret } from "./service";

/*
 * ---------------------------------------------------------------------------
 * The run gateway: the ONLY path a browser takes into the Go runtime. The
 * session + scope middlewares have already authenticated the caller when
 * these routes run; everything after that is the frozen AG-UI binding:
 *
 *   POST /runs                     create + execute (SSE passthrough)
 *   POST /runs/:id/commands        cancel (control capability → Go cancel)
 *   GET  /runs/:id                 the public run view
 *   GET  /runs/:id/events          replay the ledger's events by seq
 *
 * The execution body is built HERE from the strictly parsed request — the
 * AG-UI runId IS the invocation's turn_id, the message list is exactly the
 * one user text the input digest was computed over — so what Go's input
 * guard compares is what this module wrote, byte for byte.
 *
 * The minted invocation lives in this process's memory keyed by run: cancel
 * re-presents the SAME envelope the capability row hashes. A gateway restart
 * forgets it, and cancel then answers "unknown" honestly — reconciliation,
 * not a fake success (recovery belongs to E2).
 * ---------------------------------------------------------------------------
 */

export type GatewayDeps = {
  service: RunServiceE1;
  runtime: EnterpriseRuntimeConfig;
  keyEncryptionKey: string;
  /** Injectable for tests; production uses the global fetch with a timeout. */
  fetchGo?: typeof fetch;
};

const EXECUTION_TIMEOUT_MS = 120_000;
const CANCEL_TIMEOUT_MS = 10_000;

function executionBody(created: CreatedRun): string {
  return JSON.stringify({
    runId: created.execution.runId,
    threadId: created.execution.threadId,
    messages: [{ role: "user", content: created.execution.text }],
    forwardedProps: {},
  });
}

function executionHeaders(
  created: CreatedRun,
  serviceCredential: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    [RUNTIME_SERVICE_CREDENTIAL_HEADER]: serviceCredential,
    [RUNTIME_CAPABILITY_HEADER]: created.capabilities.runtime,
    [RUNTIME_INVOCATION_HEADER]: JSON.stringify(created.invocation),
  };
}

/** One AG-UI SSE frame from the byte stream: `data: {…}` lines, blank-line separated. */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) yield data;
      boundary = buffer.indexOf("\n\n");
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) {
    yield rest.slice(5).trim();
  }
}

/** Maps one AG-UI event to the ledger's event type and, at terminals, the run status. */
function ledgerMapping(event: Record<string, unknown>): {
  eventType: string;
  status?: "succeeded" | "failed" | "waiting_approval" | "waiting_input";
  reasonCode?: string;
} {
  const type = event.type;
  if (type === "RUN_STARTED") return { eventType: "run.started" };
  if (type === "TEXT_MESSAGE_START") return { eventType: "message.start" };
  if (type === "TEXT_MESSAGE_CONTENT") return { eventType: "message.delta" };
  if (type === "TEXT_MESSAGE_END") return { eventType: "message.end" };
  if (type === "TOOL_CALL_START") return { eventType: "tool.start" };
  if (type === "TOOL_CALL_ARGS") return { eventType: "tool.args" };
  if (type === "TOOL_CALL_END") return { eventType: "tool.end" };
  if (type === "RUN_FINISHED") {
    const interrupt = event.interrupt;
    if (interrupt !== undefined && interrupt !== null) {
      const reason = (event.reason as string | undefined) ?? "tool_approval";
      return {
        eventType: "run.waiting",
        status:
          reason === "operation_receipt_pending"
            ? "waiting_input"
            : "waiting_approval",
        reasonCode: reason,
      };
    }
    return { eventType: "run.succeeded", status: "succeeded" };
  }
  if (type === "RUN_ERROR") {
    return {
      eventType: "run.failed",
      status: "failed",
      reasonCode:
        typeof event.message === "string"
          ? event.message.slice(0, 200)
          : "RUN_ERROR",
    };
  }
  return { eventType: `raw.${typeof type === "string" ? type : "unknown"}` };
}

export function mountRunGateway(
  api: Hono<{ Variables: EnterpriseVariables }>,
  deps: GatewayDeps,
): void {
  const fetchGo = deps.fetchGo ?? fetch;
  /** The minted envelope per tenant|run; cancel re-presents it verbatim. */
  const minted = new Map<string, RuntimeInvocation>();

  api.post("/runs", async (c) => {
    const scope = c.var.scope;
    const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new EnterpriseError("IDEMPOTENCY_KEY_REQUIRED", 400);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new EnterpriseError("JSON_REQUIRED", 400);
    }
    const parsedRequest = CreateRunSchema.safeParse(raw);
    if (!parsedRequest.success) {
      throw new EnterpriseError("INVALID_RUN_REQUEST", 400);
    }

    const created = await deps.service.createE1({
      scope,
      key: idempotencyKey,
      request: parsedRequest.data,
    });

    // A replayed Idempotency-Key returns the EXISTING run without dialing the
    // runtime again — the first request's execution is the one that counts.
    if (created.replayed) {
      return c.json(created.run, 200);
    }
    const { invocation } = created;
    if (invocation === undefined) {
      // Unreachable from createE1's contract; a guard, not a repair.
      throw new EnterpriseError("RUNTIME_REFUSED", 503);
    }

    // The stream: Go's SSE frames pass through to the client as they arrive,
    // and each one lands in the ledger in arrival order before being forwarded.
    minted.set(`${scope.tenantId}|${created.run.run_id}`, invocation);
    const upstream = await fetchGo(deps.runtime.executionUrl, {
      method: "POST",
      headers: executionHeaders(created, deps.runtime.serviceCredential),
      body: executionBody(created),
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
    });
    if (!upstream.ok || !upstream.body) {
      // The runtime refused the run; the ledger keeps the refusal as the
      // terminal state instead of leaving a queued run nobody will serve.
      const code = upstream.status;
      await deps.service.markTerminal({
        tenantId: scope.tenantId,
        runId: created.run.run_id,
        status: "failed",
        reasonCode: `RUNTIME_REFUSED_${code}`,
      });
      throw new EnterpriseError("RUNTIME_REFUSED", 503);
    }

    const turnId = invocation.turn_id;
    const runId = created.run.run_id;
    const tenantId = scope.tenantId;
    const attemptId = invocation.attempt_id;
    const upstreamBody = upstream.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const data of sseEvents(upstreamBody)) {
            let event: Record<string, unknown> = {};
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            const mapped = ledgerMapping(event);
            await deps.service.appendEvent({
              tenantId,
              runId,
              attemptId,
              turnId,
              sourceEventId:
                typeof event.id === "string" ? event.id : crypto.randomUUID(),
              sourceDigest: createHash("sha256")
                .update(data, "utf8")
                .digest("hex"),
              eventType: mapped.eventType,
              payload: event,
            });
            if (mapped.status !== undefined) {
              await deps.service.markTerminal({
                tenantId,
                runId,
                status: mapped.status,
                reasonCode: mapped.reasonCode,
              });
            }
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            if (mapped.status === "succeeded" || mapped.status === "failed")
              break;
          }
        } catch {
          await deps.service
            .markTerminal({
              tenantId,
              runId,
              status: "failed",
              reasonCode: "RUNTIME_STREAM_BROKEN",
            })
            .catch(() => undefined);
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  });

  api.post("/runs/:id/commands", async (c) => {
    const scope = c.var.scope;
    const runId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new EnterpriseError("JSON_REQUIRED", 400);
    }
    const kind = (body as { kind?: unknown }).kind;
    if (kind !== "cancel") {
      throw new EnterpriseError("COMMAND_KIND_UNSUPPORTED", 400);
    }

    const view = await deps.service.command(scope, runId, {
      command_id: crypto.randomUUID(),
      expected_revision: "0",
      kind: "cancel",
    });

    // The control capability dials Go's cancel endpoint with the same
    // envelope the run was minted under (this process still holds it) —
    // E1-lite keeps this honest: a gateway restart forgets the envelope, a
    // passed TTL is refused by Go, and either way the run stays
    // cancel_requested with an honest unknown — reconciliation, not a fake
    // success (recovery belongs to E2).
    const cancelled = await cancelAtRuntime(
      deps,
      scope,
      runId,
      minted,
      fetchGo,
    ).catch(() => "unknown" as const);
    if (cancelled === "not_found") {
      // Go forgot the run (restart): the ledger says so instead of pretending.
      await deps.service.markTerminal({
        tenantId: scope.tenantId,
        runId,
        status: "cancelled",
        reasonCode: "RUNTIME_FORGOT_RUN",
      });
      return c.json(
        {
          ...(await deps.service.get(scope, runId)),
          cancel_requested: true,
          runtime: "not_found",
        },
        200,
      );
    }
    return c.json({ ...view, cancel_requested: true }, 200);
  });

  api.get("/runs/:id", async (c) => {
    const scope = c.var.scope;
    return c.json(await deps.service.get(scope, c.req.param("id")));
  });

  api.get("/runs/:id/events", async (c) => {
    const scope = c.var.scope;
    const runId = c.req.param("id");
    await deps.service.get(scope, runId); // 404 through the owner-pinned read first
    const after = Number(c.req.query("after") ?? "0");
    const limit = Math.min(
      Math.max(Number(c.req.query("limit") ?? "100"), 1),
      500,
    );
    const events = await deps.service.readEventsPinned({
      tenantId: scope.tenantId,
      runId,
      after: Number.isFinite(after) ? after : 0,
      limit,
    });
    return c.json({ items: events });
  });
}

async function cancelAtRuntime(
  deps: GatewayDeps,
  scope: Scope,
  runId: string,
  minted: Map<string, RuntimeInvocation>,
  fetchGo: typeof fetch,
): Promise<"requested" | "not_found" | "unknown"> {
  const envelope = minted.get(`${scope.tenantId}|${runId}`);
  if (envelope === undefined) return "unknown";
  const secret = deriveCapabilitySecret(
    deps.keyEncryptionKey,
    "control",
    scope.tenantId,
    runId,
  );
  try {
    const response = await fetchGo(deps.runtime.cancelUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNTIME_SERVICE_CREDENTIAL_HEADER]: deps.runtime.serviceCredential,
        [RUNTIME_CAPABILITY_HEADER]: secret,
        [RUNTIME_INVOCATION_HEADER]: JSON.stringify(envelope),
      },
      signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
    });
    if (response.status === 404) return "not_found";
    if (response.ok) return "requested";
    return "unknown";
  } catch {
    return "unknown";
  }
}
