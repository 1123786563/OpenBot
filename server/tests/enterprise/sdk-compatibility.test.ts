import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import {
  EventSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
} from "@ag-ui/core/schemas";
import {
  CopilotKitCore,
  IntelligenceAgent,
  ProxiedCopilotRuntimeAgent,
  ɵcreateThreadStore,
  ɵselectThreads,
} from "@copilotkit/core";
import {
  SDK_COMPATIBILITY,
  verifySdkCompatibilityFixture,
} from "../../../shared/runtime-compatibility";
import { createRuntimeTestFixture } from "./fixtures/platform";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const fixturePath = resolve(hereDir, "fixtures/runtime-wire.json");

describe("locked CopilotKit and AG-UI wire compatibility", () => {
  test("records_locked_versions_hashes_and_all_sdk_routes", () => {
    expect(SDK_COMPATIBILITY.copilotkit.version).toBe("1.77.0");
    expect(SDK_COMPATIBILITY.copilotkit_core.version).toBe("1.77.0");
    expect(SDK_COMPATIBILITY.ag_ui.version).toBe("1.0.1");
    expect(SDK_COMPATIBILITY.ag_ui_client.version).toBe("1.0.1");
    expect(SDK_COMPATIBILITY.copilotkit.integrity).toMatch(/^sha512-/);
    expect(SDK_COMPATIBILITY.ag_ui.integrity).toMatch(/^sha512-/);
    expect(SDK_COMPATIBILITY.ag_ui_client.integrity).toMatch(/^sha512-/);
    expect(SDK_COMPATIBILITY.routes.map(({ operation }) => operation)).toEqual([
      "info",
      "run",
      "connect",
      "stop",
      "threads_list",
    ]);
    expect(
      SDK_COMPATIBILITY.platform_routes.map(({ operation }) => operation),
    ).toEqual(["threads_create", "threads_delete"]);
  });

  test("installed_sdk_package_metadata_matches_recorded_hashes", async () => {
    for (const [relativePath, expectedHash] of [
      [
        "../../node_modules/@copilotkit/runtime/package.json",
        SDK_COMPATIBILITY.copilotkit.package_json_sha256,
      ],
      [
        "../../node_modules/@copilotkit/core/package.json",
        SDK_COMPATIBILITY.copilotkit_core.package_json_sha256,
      ],
      [
        "../../node_modules/@ag-ui/core/package.json",
        SDK_COMPATIBILITY.ag_ui.package_json_sha256,
      ],
      [
        "../../node_modules/@ag-ui/client/package.json",
        SDK_COMPATIBILITY.ag_ui_client.package_json_sha256,
      ],
    ]) {
      const source = await readFile(resolve(hereDir, relativePath));
      expect(createHash("sha256").update(source).digest("hex")).toBe(
        expectedHash,
      );
    }
    const lockfile = await readFile(
      resolve(hereDir, "../../../bun.lock"),
      "utf8",
    );
    expect(lockfile).toContain(SDK_COMPATIBILITY.copilotkit.integrity);
    expect(lockfile).toContain(SDK_COMPATIBILITY.copilotkit_core.integrity);
    expect(lockfile).toContain(SDK_COMPATIBILITY.ag_ui.integrity);
    expect(lockfile).toContain(SDK_COMPATIBILITY.ag_ui_client.integrity);
  });

  test("golden_samples_cover_sdk_requests_responses_and_ui_activity", async () => {
    const samples = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(verifySdkCompatibilityFixture(samples)).toEqual({ valid: true });
    expect(
      samples.samples.map(({ operation }: { operation: string }) => operation),
    ).toEqual(SDK_COMPATIBILITY.routes.map(({ operation }) => operation));
    expect(samples.ui_contract.activity_event_types).toContain(
      "activity-snapshot",
    );
    expect(samples.ui_contract.attachment_part_types).toEqual([
      "file",
      "image",
      "document",
    ]);
    expect(samples.ui_contract.tool_request_shapes).toContain("tool_call");
    expect(
      samples.samples.every(
        (sample: { provenance?: { package?: string; callsite?: string } }) =>
          typeof sample.provenance?.package === "string" &&
          typeof sample.provenance.callsite === "string",
      ),
    ).toBe(true);
    expect(
      samples.platform_samples.every(
        (sample: { provenance?: { kind?: string } }) =>
          sample.provenance?.kind === "planned_platform_contract",
      ),
    ).toBe(true);
    expect(samples.interactions.tool_result.event.type).toBe(
      "TOOL_CALL_RESULT",
    );
    expect(samples.interactions.tool_result.provenance.package).toBe(
      "@ag-ui/core@1.0.1",
    );
    expect(samples.interactions.approval_resume.provenance.package).toBe(
      "@ag-ui/client@1.0.1",
    );
    expect(samples.interactions.approval_resume.provenance.callsite).toBe(
      "HttpAgent.runAgent/requestInit",
    );
    expect(
      String(
        (
          EventSchema.parse(samples.interactions.tool_result.event) as {
            type: string;
          }
        ).type,
      ),
    ).toBe("TOOL_CALL_RESULT");
    expect(samples.interactions.approval_wait.event.outcome.type).toBe(
      "interrupt",
    );
    expect(
      (
        EventSchema.parse(samples.interactions.approval_wait.event) as {
          outcome: { type: string };
        }
      ).outcome.type,
    ).toBe("interrupt");
    expect(samples.interactions.approval_resume.request.method).toBe("POST");
    expect(samples.interactions.approval_resume.request.path).toBe(
      "/api/copilotkit/agent/default/run",
    );
    const resumeInput = RunAgentInputSchema.parse(
      samples.interactions.approval_resume.request.body,
    );
    expect(resumeInput.resume).toMatchObject([
      { interruptId: "approval-golden-1", status: "resolved" },
    ]);
    expect(ResumeEntrySchema.parse(resumeInput.resume?.[0])).toMatchObject({
      interruptId: "approval-golden-1",
      status: "resolved",
    });
    expect(samples.interactions.reconnect.request.body.lastSeenEventId).toBe(
      "event-golden-2",
    );
    expect(
      String(
        EventSchema.parse(
          samples.interactions.history_replay.response.body.events[0],
        ).type,
      ),
    ).toBe("TEXT_MESSAGE_CONTENT");
    expect(samples.sse_response.content_type).toBe("text/event-stream");
    expect(samples.sse_response.provenance.package).toBe("@ag-ui/client@1.0.1");
    expect(
      samples.sse_response.events.map((event: { type: string }) =>
        String((EventSchema.parse(event) as { type: string }).type),
      ),
    ).toContain("RUN_FINISHED");
    expect(
      samples.interactions.resume_events.map((event: { type: string }) =>
        String((EventSchema.parse(event) as { type: string }).type),
      ),
    ).toContain("TOOL_CALL_RESULT");
    const runSample = samples.samples.find(
      ({ operation }: { operation: string }) => operation === "run",
    );
    expect(samples.sse_response.events).toEqual(runSample.response.body.events);
    for (const event of runSample.response.body.events) {
      expect(EventSchema.parse(event)).toBeDefined();
    }
  });

  test("locked_http_agent_emits_the_golden_run_request_and_accepts_sdk_sse_events", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const samples = JSON.parse(await readFile(fixturePath, "utf8"));
    const goldenRunBody = samples.samples.find(
      ({ operation }: { operation: string }) => operation === "run",
    ).request.body;
    const responseBatches = [
      samples.samples.find(
        ({ operation }: { operation: string }) => operation === "run",
      ).response.body.events,
      samples.interactions.resume_events,
    ];
    let responseIndex = 0;
    const agent = new HttpAgent({
      agentId: "default",
      threadId: "thread-golden-1",
      url: "http://127.0.0.1/api/copilotkit/agent/default/run",
      initialMessages: [
        {
          id: "message-golden-1",
          role: "user",
          content: [{ type: "text", text: "Summarize this file" }],
        },
      ],
      fetch: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        const responseEvents = responseBatches[responseIndex++] ?? [];
        const body = responseEvents
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join("");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    await agent.runAgent({ runId: "run-golden-1" });
    await agent.runAgent({
      runId: "run-resume-1",
      resume: [
        {
          interruptId: "approval-golden-1",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1/api/copilotkit/agent/default/run",
    );
    expect(RunAgentInputSchema.parse(requests[0]?.body)).toMatchObject({
      threadId: "thread-golden-1",
      runId: "run-golden-1",
    });
    expect(requests[0]?.body).toMatchObject(goldenRunBody);
    expect(RunAgentInputSchema.parse(requests[1]?.body)).toMatchObject({
      threadId: "thread-golden-1",
      runId: "run-resume-1",
      resume: [
        {
          interruptId: "approval-golden-1",
          status: "resolved",
          payload: { approved: true },
        },
      ],
    });
    expect(requests[1]?.body).toEqual(
      samples.interactions.approval_resume.request.body,
    );
    for (const event of responseBatches.flat())
      expect(EventSchema.parse(event as never)).toEqual(event as never);
  });

  test("locked_copilotkit_client_calls_capture_discovery_history_stop_and_reconnect", async () => {
    const samples = JSON.parse(await readFile(fixturePath, "utf8"));
    const captured: Array<{
      url: string;
      method: string;
      body?: unknown;
      headers?: HeadersInit;
    }> = [];
    let resolveInfoRequest!: () => void;
    const infoRequested = new Promise<void>((resolve) => {
      resolveInfoRequest = resolve;
    });
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    let stopResponse: Response | undefined;
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      const method = String(init.method ?? "GET");
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      captured.push({
        url,
        method,
        ...(body === undefined ? {} : { body }),
        headers: init.headers,
      });
      if (url.endsWith("/info")) {
        resolveInfoRequest();
        return Response.json(
          samples.samples.find(
            ({ operation }: { operation: string }) => operation === "info",
          ).response.body,
        );
      }
      if (url.includes("/threads?")) {
        const next = new URL(url).searchParams.has("cursor");
        const firstPage = samples.samples.find(
          ({ operation }: { operation: string }) =>
            operation === "threads_list",
        ).response.body;
        return Response.json(
          next
            ? {
                threads: [
                  {
                    ...firstPage.threads[0],
                    id: "thread-golden-2",
                    name: "Billing",
                  },
                ],
                nextCursor: null,
              }
            : firstPage,
        );
      }
      if (url.endsWith("/agent/default/stop/thread-golden-1")) {
        stopResponse = Response.json(
          samples.samples.find(
            ({ operation }: { operation: string }) => operation === "stop",
          ).response.body,
        );
        return stopResponse;
      }
      if (url.endsWith("/agent/default/connect") && body?.lastSeenEventId)
        return Response.json(samples.interactions.reconnect.response.body);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "http://localhost" } },
    });
    try {
      const core = new CopilotKitCore({
        runtimeUrl: "http://127.0.0.1/api/copilotkit",
        deferInitialConnection: true,
      });
      const runtimeConnected = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("CopilotKit /info response was not accepted")),
          2_000,
        );
        core.subscribe({
          onRuntimeConnectionStatusChanged: ({ status }) => {
            if (String(status).toLowerCase().includes("connected")) {
              clearTimeout(timeout);
              resolve();
            }
          },
        });
      });
      core.connect();
      await Promise.all([infoRequested, runtimeConnected]);

      const threadStore = ɵcreateThreadStore({ fetch: globalThis.fetch });
      threadStore.start();
      threadStore.setContext({
        runtimeUrl: "http://127.0.0.1/api/copilotkit",
        headers: {},
        agentId: "default",
        limit: 20,
      });
      for (let i = 0; i < 30 && threadStore.getState().nextCursor == null; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ɵselectThreads(threadStore.getState())).toMatchObject([
        { id: "thread-golden-1", name: "Support" },
      ]);
      expect(threadStore.getState().nextCursor).toBe("cursor-golden-2");
      threadStore.fetchNextPage();
      for (
        let i = 0;
        i < 30 && ɵselectThreads(threadStore.getState()).length < 2;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ɵselectThreads(threadStore.getState())).toMatchObject([
        { id: "thread-golden-1", name: "Support" },
        { id: "thread-golden-2", name: "Billing" },
      ]);
      expect(
        captured.find(({ url }) => new URL(url).searchParams.has("cursor"))
          ?.url,
      ).toContain("cursor=cursor-golden-2");
      expect(threadStore.getState().nextCursor).toBeNull();
      threadStore.stop();

      const stopAgent = new ProxiedCopilotRuntimeAgent({
        runtimeUrl: "http://127.0.0.1/api/copilotkit",
        runtimeMode: "sse",
        agentId: "default",
        threadId: "thread-golden-1",
        fetch: async (input) =>
          String(input).endsWith("/info")
            ? Response.json({
                version: "1.77.0",
                mode: "sse",
                agents: { default: {} },
              })
            : new Promise<Response>(() => {}),
      });
      const stopRunSubscription = stopAgent
        .run({
          threadId: "thread-golden-1",
          runId: "run-golden-1",
          protocolVersion: "1.0",
          state: {},
          messages: [],
          tools: [],
          context: [],
        })
        .subscribe({ error: () => {} });
      for (
        let i = 0;
        i < 30 &&
        (stopAgent as unknown as { activeRun?: unknown }).activeRun == null;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (stopAgent as unknown as { activeRun?: { runId?: string } }).activeRun
          ?.runId,
      ).toBe("run-golden-1");
      stopAgent.abortRun();
      for (
        let i = 0;
        i < 30 && !captured.some(({ url }) => url.includes("/stop/"));
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));

      const connectSample = samples.samples.find(
        ({ operation }: { operation: string }) => operation === "connect",
      );
      const replayEvents = connectSample.response.body.events as Array<{
        type: string;
      }>;
      const historyAgent = new ProxiedCopilotRuntimeAgent({
        runtimeUrl: "http://127.0.0.1/api/copilotkit",
        runtimeMode: "sse",
        agentId: "default",
        fetch: async (url, init) => {
          if (String(url).endsWith("/info"))
            return Response.json({
              version: "1.77.0",
              mode: "sse",
              agents: { default: {} },
            });
          captured.push({
            url: String(url),
            method: String(init?.method ?? "GET"),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          const sse = replayEvents
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join("");
          return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const historyEvents: Array<{ type: string; delta?: string }> = [];
      await new Promise<void>((resolve, reject) => {
        historyAgent
          .connect({
            threadId: "thread-golden-1",
            runId: "run-golden-1",
            protocolVersion: "1.0",
            state: {},
            messages: [],
            tools: [],
            context: [],
          })
          .subscribe({
            next: (event) =>
              historyEvents.push(event as (typeof historyEvents)[number]),
            error: reject,
            complete: resolve,
          });
      });

      const joinFrames: unknown[][] = [];
      class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        binaryType = "";
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        constructor(_url: string) {
          queueMicrotask(() => {
            this.readyState = 1;
            this.onopen?.({} as Event);
          });
        }
        send(data: string) {
          const frame = JSON.parse(data) as unknown[];
          if (frame[3] !== "phx_join") return;
          joinFrames.push(frame);
          const [joinRef, ref, topic] = frame;
          queueMicrotask(() =>
            this.deliver([
              joinRef,
              ref,
              topic,
              "phx_reply",
              { status: "ok", response: {} },
            ]),
          );
          setTimeout(() => {
            for (const event of samples.interactions.reconnect.replayed_events)
              this.deliver([joinRef, null, topic, "ag_ui_event", event]);
            this.deliver([
              joinRef,
              null,
              topic,
              "replay_complete",
              { latestEventId: "event-golden-3" },
            ]);
            this.deliver([
              joinRef,
              null,
              topic,
              "stream_idle",
              { latestEventId: "event-golden-3" },
            ]);
          }, 0);
        }
        deliver(frame: unknown[]) {
          this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
        }
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 1000 } as CloseEvent);
        }
      }
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
      const reconnectAgent = new IntelligenceAgent(
        {
          runtimeUrl: "http://127.0.0.1/api/copilotkit",
          url: "ws://127.0.0.1/socket",
          agentId: "default",
          fetch: globalThis.fetch,
        },
        { lastSeenEventIds: new Map([["thread-golden-1", "event-golden-2"]]) },
      );
      reconnectAgent.threadId = "thread-golden-1";
      const reconnectResponse: unknown = await reconnectAgent.connectAgent({
        runId: "run-golden-1",
      });

      const discovery = captured.find(({ url }) => url.endsWith("/info"));
      const history = captured.find(({ url }) => url.includes("/threads?"));
      const stop = captured.find(({ url }) => url.includes("/stop/"));
      const historyConnect = captured.find(
        ({ url, body }) =>
          url.endsWith("/connect") &&
          !(
            typeof body === "object" &&
            body !== null &&
            "lastSeenEventId" in body
          ),
      );
      const reconnect = captured.find(
        ({ url, body }) =>
          url.endsWith("/connect") &&
          typeof body === "object" &&
          body !== null &&
          "lastSeenEventId" in body,
      );
      expect(discovery).toMatchObject({
        url: `http://127.0.0.1${samples.samples.find(({ operation }: { operation: string }) => operation === "info").request.path}`,
        method: "GET",
      });
      expect(
        samples.samples.find(
          ({ operation }: { operation: string }) => operation === "info",
        ).provenance,
      ).toMatchObject({
        package: "@copilotkit/core@1.77.0",
        callsite: "AgentRegistry.fetchRuntimeInfo",
      });
      expect(history?.url).toBe(
        `http://127.0.0.1${samples.samples.find(({ operation }: { operation: string }) => operation === "threads_list").request.path}`,
      );
      expect(stop?.url).toBe(
        `http://127.0.0.1${samples.samples.find(({ operation }: { operation: string }) => operation === "stop").request.path}`,
      );
      expect(stop).toMatchObject({
        method: "POST",
        body: { runId: "run-golden-1" },
      });
      expect(new Headers(stop?.headers).get("content-type")).toBe(
        "application/json",
      );
      expect(
        samples.samples.find(
          ({ operation }: { operation: string }) => operation === "stop",
        ).response,
      ).toMatchObject({
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          stopped: true,
          interrupt: {
            type: "RUN_ERROR",
            message: "Run stopped by user",
            code: "STOPPED",
          },
        },
        client_behavior: "ignored_by_locked_client",
      });
      expect(stopResponse?.bodyUsed).toBe(false);
      stopRunSubscription.unsubscribe();
      expect(historyConnect).toMatchObject({
        url: `http://127.0.0.1${connectSample.request.path}`,
        method: connectSample.request.method,
        body: connectSample.request.body,
      });
      expect(reconnect?.body).toMatchObject({
        threadId: "thread-golden-1",
        runId: "run-golden-1",
        lastSeenEventId: "event-golden-2",
      });
      expect(reconnect?.body).toMatchObject(
        samples.interactions.reconnect.request.body,
      );
      expect(reconnectResponse).toMatchObject({
        newMessages: [{ role: "assistant", content: " replayed" }],
      });
      expect(joinFrames[0]?.[4]).toMatchObject(
        samples.interactions.reconnect.channel_join,
      );
      expect(
        historyEvents.filter((event) => event.type === "TEXT_MESSAGE_CONTENT"),
      ).toEqual(replayEvents);
      expect(samples.interactions.history_replay.response.body.events).toEqual(
        replayEvents,
      );
      expect(reconnect?.method).toBe("POST");
      expect(reconnect?.url).toBe(
        "http://127.0.0.1/api/copilotkit/agent/default/connect",
      );
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("fixture_uses_controlled_scope_clock_and_requires_dedicated_database_url", async () => {
    const fixture = createRuntimeTestFixture({
      now: "2026-10-09T00:00:00.000Z",
    });
    expect(fixture.scope.tenantId).toBe("tenant-test");
    expect(fixture.clock.now().toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(() =>
      fixture.testDatabaseUrl({ DATABASE_URL: "postgres://localhost/openbot" }),
    ).toThrow(/TEST_DATABASE_URL/);
    expect(() =>
      fixture.testDatabaseUrl({
        TEST_DATABASE_URL: "postgres://localhost/openbot",
      }),
    ).toThrow(/must not point at the live openbot database/);
    expect(
      fixture.testDatabaseUrl({
        TEST_DATABASE_URL: "postgres://localhost/openbot_test",
      }),
    ).toBe("postgres://localhost/openbot_test");
    let opened = false;
    await expect(
      fixture.openIsolatedDatabase(
        async () => {
          opened = true;
          return { close() {} };
        },
        { DATABASE_URL: "postgres://localhost/openbot" },
      ),
    ).rejects.toThrow(/TEST_DATABASE_URL/);
    expect(opened).toBe(false);
    await fixture.close();
  });

  test("fixture_refuses_database_open_after_close", async () => {
    const fixture = createRuntimeTestFixture();
    await fixture.close();
    let opened = false;
    await expect(
      fixture.openIsolatedDatabase(
        async () => {
          opened = true;
          return { close() {} };
        },
        { TEST_DATABASE_URL: "postgres://localhost/openbot_test" },
      ),
    ).rejects.toThrow(/already closed/);
    expect(opened).toBe(false);
  });

  test("fixture_closes_database_that_resolves_after_close_once", async () => {
    const fixture = createRuntimeTestFixture();
    let resolveOpen!: (database: { close(): void }) => void;
    const pending = fixture.openIsolatedDatabase(
      () =>
        new Promise<{ close(): void }>((resolve) => {
          resolveOpen = resolve;
        }),
      { TEST_DATABASE_URL: "postgres://localhost/openbot_test" },
    );
    let closeCount = 0;
    await fixture.close();
    resolveOpen({
      close() {
        closeCount += 1;
      },
    });
    await expect(pending).rejects.toThrow(/already closed/);
    await fixture.close();
    expect(closeCount).toBe(1);
  });
});
