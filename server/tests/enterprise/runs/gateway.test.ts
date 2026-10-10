import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { EnterpriseVariables } from "../../../src/enterprise/app";
import { mountRunGateway, type GatewayDeps } from "../../../src/enterprise/runs/gateway";
import type { CreatedRun, RunServiceE1 } from "../../../src/enterprise/runs/service";
import { deriveCapabilitySecret } from "../../../src/enterprise/runs/service";
import type { RuntimeInvocation } from "../../../src/enterprise/runtime/wire";
import type { EnterpriseRuntimeConfig } from "../../../src/enterprise/runtime/config";
import type { Scope } from "../../../src/enterprise/contracts";
import type { CreateRun, RunEventView, RunView } from "../../../../shared/enterprise/run-contracts";

/*
 * Gateway unit plane: a fake service + a scripted fake Go endpoint, the same
 * discipline as the probe. The real service/ledger pair has its own
 * integration suite (service.test.ts); here the SSE binding is what's under
 * test — passthrough, ledger mapping, replay discipline, cancel honesty.
 */

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
  input_digest: "digest",
  model_route_ref: "route-1",
  budget_reservation_id: "res-1",
  lease_id: "lease-1",
  fencing_token: "1",
  expires_at: "2099-01-01T00:00:00Z",
};

const RUNTIME: EnterpriseRuntimeConfig = {
  serviceCredential: "shared-secret",
  serviceId: "runtime-go-test",
  executionUrl: "http://go.test/internal/enterprise/v1/runtime/execution",
  cancelUrl: "http://go.test/internal/enterprise/v1/runtime/cancel",
  runWriterDatabaseUrl: "unused",
  runtimeWriterDatabaseUrl: "unused",
  modelBaseUrl: "https://model.example/v4",
  modelAlias: "alias",
  modelRouteRef: "route-1",
  expertVersion: "assistant-v1",
  expertInstructionPath: "/unused",
  governedTools: [],
  budgetCapMicros: 1_000_000,
  budgetCurrency: "USD",
  leaseTtlMs: 600_000,
  capabilityTtlMs: 300_000,
};

const SCOPE: Scope = Object.freeze({
  tenantId: "tenant-1",
  principalId: "principal-1",
  userId: "user-1",
  role: "member" as const,
  epoch: 1,
});

function createdRun(overrides: Partial<CreatedRun> = {}): CreatedRun {
  return {
    run: {
      run_id: "run-1",
      thread_id: "thread-1",
      status: "queued",
      revision: "0",
      latest_seq: "0",
      reconciliation_required: false,
      reason_code: null,
    },
    replayed: false,
    invocation: INVOCATION,
    capabilities: { runtime: "cap-runtime", control: "cap-control" },
    inputDigest: "digest",
    execution: { runId: "turn-1", threadId: "thread-1", text: "hello" },
    ...overrides,
  };
}

type Harness = {
  app: Hono<{ Variables: EnterpriseVariables }>;
  events: Array<Record<string, unknown>>;
  cancelled: Array<{ headers: Record<string, string> }>;
  setStream: (frames: string[] | "refuse") => void;
  setReplay: (replay: boolean) => void;
};

function harness(): Harness {
  const app = new Hono<{ Variables: EnterpriseVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", SCOPE.userId);
    c.set("scope", SCOPE);
    await next();
  });
  // The real enterprise app maps EnterpriseError to its status in onError;
  // the bare test app needs the same mapping for refusal assertions.
  app.onError((error, c) => {
    const status = error instanceof Error && "status" in error ? (error as { status: number }).status : 500;
    return c.json({ error: String(error) }, status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  });

  const events: Array<Record<string, unknown>> = [];
  const terminals: Array<{ status: string; reasonCode?: string }> = [];
  const cancelled: Array<{ headers: Record<string, string> }> = [];
  let frames: string[] | "refuse" = [];
  let replay = false;

  const service = {
    async createE1() {
      const created = createdRun({ replayed: replay, ...(replay ? { invocation: undefined } : {}) });
      return created;
    },
    async appendEvent(input: { eventType: string; payload: unknown }) {
      events.push({ eventType: input.eventType, payload: input.payload });
      return events.length;
    },
    async markTerminal(input: { status: string; reasonCode?: string }) {
      terminals.push({ status: input.status, reasonCode: input.reasonCode });
    },
    async command(): Promise<RunView> {
      return {
        run_id: "run-1",
        thread_id: "thread-1",
        status: "cancel_requested",
        revision: "1",
        latest_seq: "0",
        reconciliation_required: false,
        reason_code: null,
      };
    },
    async get(): Promise<RunView> {
      return {
        run_id: "run-1",
        thread_id: "thread-1",
        status: "cancelled",
        revision: "2",
        latest_seq: "3",
        reconciliation_required: false,
        reason_code: "RUNTIME_FORGOT_RUN",
      };
    },
    async readEventsPinned(): Promise<RunEventView[]> {
      return [];
    },
  } as unknown as RunServiceE1;

  const deps: GatewayDeps = {
    service,
    runtime: RUNTIME,
    keyEncryptionKey: "k",
    fetchGo: (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (String(url) === RUNTIME.cancelUrl) {
        cancelled.push({ headers: Object.fromEntries(headers.entries()) });
        // The Go candidate forgets runs on restart; script that honestly.
        return new Response(JSON.stringify({ status: "cancel_requested" }), {
          status: cancelled.length === 1 ? 200 : 404,
        });
      }
      if (frames === "refuse") {
        return new Response("nope", { status: 503 });
      }
      const body = frames.map((frame) => `data: ${frame}\n\n`).join("");
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch,
  };
  mountRunGateway(app, deps);

  return {
    app,
    events,
    cancelled,
    setStream: (value) => {
      frames = value;
    },
    setReplay: (value) => {
      replay = value;
    },
  };
}

function post(h: Harness, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return h.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "key-1", ...headers },
    body: JSON.stringify(
      body ?? {
        workspace_id: "ws-1",
        expert_release_id: "rel-1",
        model_alias: "alias",
        input: { text: "hello" },
      },
    ),
  });
}

describe("the run gateway", () => {
  test("execution streams Go's SSE frames through and lands each in the ledger", async () => {
    const h = harness();
    h.setStream([
      JSON.stringify({ type: "RUN_STARTED", id: "e1" }),
      JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", id: "e2", delta: "he" }),
      JSON.stringify({ type: "RUN_FINISHED", id: "e3" }),
    ]);
    const response = await post(h, "/runs");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain("RUN_STARTED");
    expect(text).toContain("TEXT_MESSAGE_CONTENT");
    expect(text).toContain("RUN_FINISHED");
    expect(h.events.map((event) => event.eventType)).toEqual([
      "run.started",
      "message.delta",
      "run.succeeded",
    ]);
  });

  test("the execution body is exactly the frozen AG-UI shape the digest vouches for", async () => {
    const h = harness();
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const app = new Hono<{ Variables: EnterpriseVariables }>();
    app.use("*", async (c, next) => {
      c.set("userId", SCOPE.userId);
      c.set("scope", SCOPE);
      await next();
    });
    const service = {
      async createE1() {
        return createdRun();
      },
      async appendEvent() {
        return 1;
      },
      async markTerminal() {},
    } as unknown as RunServiceE1;
    mountRunGateway(app, {
      service,
      runtime: RUNTIME,
      keyEncryptionKey: "k",
      fetchGo: (async (url: string | URL, init?: RequestInit) => {
        captured = {
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: String(init?.body),
        };
        return new Response("data: " + JSON.stringify({ type: "RUN_FINISHED" }) + "\n\n", {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    const response = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "k" },
      body: JSON.stringify({
        workspace_id: "ws-1",
        expert_release_id: "rel-1",
        model_alias: "alias",
        input: { text: "hello" },
      }),
    });
    expect(response.status).toBe(200);
    expect(captured?.url).toBe(RUNTIME.executionUrl);
    const parsedBody = JSON.parse(captured?.body ?? "{}") as {
      runId: string;
      threadId: string;
      messages: Array<{ role: string; content: string }>;
      forwardedProps: Record<string, never>;
    };
    // runId IS the invocation's turn_id (master §4.3); one user message, empty props.
    expect(parsedBody.runId).toBe("turn-1");
    expect(parsedBody.threadId).toBe("thread-1");
    expect(parsedBody.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(parsedBody.forwardedProps).toEqual({});
    // The service credential rides its own header; the capability rides its own.
    expect(captured?.headers["x-openbot-runtime-service-credential"]).toBe("shared-secret");
    expect(captured?.headers["x-openbot-runtime-capability"]).toBe("cap-runtime");
    const forwarded = JSON.parse(captured?.headers["x-openbot-runtime-invocation"] ?? "{}");
    expect(forwarded.run_id).toBe("run-1");
  });

  test("a replayed Idempotency-Key returns the existing run and never dials Go", async () => {
    const h = harness();
    h.setReplay(true);
    const response = await post(h, "/runs");
    expect(response.status).toBe(200);
    const view = (await response.json()) as { run_id: string; status: string };
    expect(view.run_id).toBe("run-1");
    expect(h.events).toHaveLength(0);
  });

  test("a runtime refusal marks the run failed and answers 503", async () => {
    const h = harness();
    h.setStream("refuse");
    const response = await post(h, "/runs");
    expect(response.status).toBe(503);
  });

  test("an interrupt-carrying RUN_FINISHED parks the run waiting, not succeeded", async () => {
    const h = harness();
    h.setStream([
      JSON.stringify({ type: "RUN_STARTED", id: "e1" }),
      JSON.stringify({
        type: "RUN_FINISHED",
        id: "e2",
        interrupt: { tool: "lookup" },
        reason: "tool_approval",
      }),
    ]);
    const response = await post(h, "/runs");
    expect(response.status).toBe(200);
    await response.text(); // the pump runs as the body is consumed
    expect(h.events.map((event) => event.eventType)).toEqual(["run.started", "run.waiting"]);
  });

  test("cancel dials Go with the control capability and the same envelope", async () => {
    const h = harness();
    // Seed the minted envelope through a create first.
    h.setStream([JSON.stringify({ type: "RUN_FINISHED" })]);
    await post(h, "/runs");

    const response = await post(h, "/runs/run-1/commands", { kind: "cancel" });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { cancel_requested: boolean };
    expect(view.cancel_requested).toBe(true);
    expect(h.cancelled).toHaveLength(1);
    // The control secret is DERIVED the same way the service derived it at
    // create time (HMAC over the key) — that determinism is the contract.
    expect(h.cancelled[0]?.headers["x-openbot-runtime-capability"]).toBe(
      deriveCapabilitySecret("k", "control", "tenant-1", "run-1"),
    );
    const envelope = JSON.parse(h.cancelled[0]?.headers["x-openbot-runtime-invocation"] ?? "{}");
    expect(envelope.run_id).toBe("run-1");
  });

  test("cancel without a live envelope answers cancel_requested without dialing", async () => {
    const h = harness();
    const response = await post(h, "/runs/run-unknown/commands", { kind: "cancel" });
    expect(response.status).toBe(200);
    expect(h.cancelled).toHaveLength(0);
  });

  test("non-cancel commands and missing keys are refused", async () => {
    const h = harness();
    const wrongKind = await post(h, "/runs/run-1/commands", { kind: "resume" });
    expect(wrongKind.status).toBe(400);

    const app2 = harness();
    const noKey = await app2.app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "ws-1",
        expert_release_id: "rel-1",
        model_alias: "alias",
        input: { text: "hello" },
      }),
    });
    expect(noKey.status).toBe(400);

    const smuggled = await post(app2, "/runs", {
      workspace_id: "ws-1",
      expert_release_id: "rel-1",
      model_alias: "alias",
      input: { text: "hello" },
      tenant_id: "someone-else",
    });
    expect(smuggled.status).toBe(400);
  });
});
