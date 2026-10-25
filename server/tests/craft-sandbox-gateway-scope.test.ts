import { describe, expect, test } from "../../tests/support/e2e-compat";
import { loadCraftConfig } from "../src/craft/config";
import { SandboxExecutionScopeUnavailableError } from "../src/craft/errors";
import {
  POD_EVENT_BUS_CLOSED,
  PodEventBus,
} from "../src/craft/opencode/event-bus";
import {
  OpencodeHttpError,
  OpencodeServeClient,
} from "../src/craft/opencode/serve-client";
import { createSandboxGateway } from "../src/craft/sandbox-gateway";

/**
 * #618: the agent-sandbox proxy (MT050) refuses a token-only request, so every
 * craft gateway call must state the deployment's execution ownership
 * (x-openbot-tenant-id / x-openbot-workspace-id) beside the token — and a
 * deployment without a resolvable scope must fail CLOSED: the displayable
 * error below, with fetchImpl never called, on every one of the three
 * outbound groups (file API, opencode-serve client + event bus, snapshot /
 * restore).
 */

const TENANT = "acme-co";
const WORKSPACE = "team-1";

const scopedConfig = loadCraftConfig({
  OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: TENANT,
  OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: WORKSPACE,
});
const unscopedConfig = loadCraftConfig({});

type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string>;
};

/**
 * Records every outbound call and answers the gateway's verbs with the shapes
 * the production callers parse (listing array, session id, snapshot bytes,
 * SSE stream). Tests never touch a real sandbox.
 */
function recordingFetch() {
  const calls: Recorded[] = [];
  let sseEnd: (() => void) | null = null;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    if (
      method === "GET" &&
      (url.pathname === "/event" || url.pathname === "/events")
    ) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseEnd = () => controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "GET" && url.pathname === "/file") return Response.json([]);
    if (method === "POST" && url.pathname === "/session")
      return Response.json({ id: "ses_scope" });
    if (method === "GET" && url.pathname === "/workspace/snapshot")
      return new Response(new Uint8Array([1, 2, 3]));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl, endSse: () => sseEnd?.() };
}

/** Resolves once the predicate holds; throws at the deadline so a hang fails loud. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The shared header assertions: both ownership headers with the configured values,
 * riding BESIDE the token and bot id the proxy also requires. */
function expectScopeHeaders(headers: Record<string, string>): void {
  expect(headers["x-openbot-tenant-id"]).toBe(TENANT);
  expect(headers["x-openbot-workspace-id"]).toBe(WORKSPACE);
  expect(headers["x-sandbox-token"]).toBe("sandbox-secret");
  expect(headers["x-openbot-bot-id"]).toBe("craft");
}

const scopedGateway = (fetchImpl: typeof fetch) =>
  createSandboxGateway({
    config: scopedConfig,
    connectionFor: () => ({
      botId: "craft",
      baseUrl: "http://gw.test",
      token: "sandbox-secret",
    }),
    fetchImpl,
  });

describe("#618 config: the deployment-level execution scope pair", () => {
  test("both plain ids parse into the scope", () => {
    expect(scopedConfig.sandboxExecutionScope).toEqual({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
    });
  });

  test("one half missing leaves no scope — a half scope is no scope", () => {
    expect(
      loadCraftConfig({
        OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: TENANT,
      }).sandboxExecutionScope,
    ).toBe(null);
    expect(
      loadCraftConfig({
        OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: WORKSPACE,
      }).sandboxExecutionScope,
    ).toBe(null);
    expect(unscopedConfig.sandboxExecutionScope).toBe(null);
  });

  test("a malformed id is dropped, not clamped", () => {
    expect(
      loadCraftConfig({
        OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: "Acme_Co",
        OPENBOT_CRAFT_SANDBOX_EXECUTION_WORKSPACE_ID: WORKSPACE,
      }).sandboxExecutionScope,
    ).toBe(null);
  });
});

describe("#618 file API: every verb carries the ownership headers", () => {
  test("list / write / writeBytes / delete / read / readBytes all state the scope", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = scopedGateway(fetchImpl);
    const files = gateway.fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;

    await files.listFiles("dir");
    await files.writeFile("dir/a.txt", "hello");
    await files.writeFileBytes("dir/b.bin", new Uint8Array([1, 2]));
    expect(await files.deletePath("dir/b.bin")).toBe(true);
    expect(await files.readFile("dir/a.txt")).toBe("");
    expect(await files.readFileBytes("dir/b.bin")).toEqual(new Uint8Array(0));

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /file",
      "POST /file",
      "POST /file",
      "DELETE /file",
      "GET /file/content",
      "GET /file/content",
    ]);
    for (const call of calls) expectScopeHeaders(call.headers);
  });

  test("caller headers ride WITH the trust headers — none can override the deployment's", async () => {
    // OCR#4: headersFor() lands LAST, mirroring serve-client's buildHeaders, so
    // the token/bot-id/scope values are always the deployment's. No verb
    // forwards caller-controlled headers today (#618 forbids that shape); the
    // pin holds the merge order for the day one does: writeFile's own
    // content-type (the one init.headers a verb states) survives untouched
    // beside the four trust headers carrying the configured values.
    const { calls, fetchImpl } = recordingFetch();
    const files = scopedGateway(fetchImpl).fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;

    await files.writeFile("dir/a.txt", "hello");

    const write = calls.find((call) => call.method === "POST");
    expect(write?.headers["content-type"]).toBe("text/plain");
    expectScopeHeaders(write?.headers ?? {});
  });
});

describe("#618 opencode-serve: client and bus carry the ownership headers", () => {
  test("a gateway-built client states the scope on /session and /doc", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = scopedGateway(fetchImpl);
    const client = gateway.serveClientFor({ botId: "craft", directory: "dir" });
    expect(client).not.toBe(null);
    if (!client) return;

    expect(await client.ensureSession(null, { directory: "dir" })).toBe(
      "ses_scope",
    );
    expect(await client.healthCheck()).toBe(true);

    const sessionCall = calls.find((call) => call.url === "/session");
    const docCall = calls.find((call) => call.url === "/doc");
    expect(sessionCall?.method).toBe("POST");
    expect(docCall?.method).toBe("GET");
    expectScopeHeaders(sessionCall?.headers ?? {});
    expectScopeHeaders(docCall?.headers ?? {});
  });

  test("the event bus SSE connection states the scope", async () => {
    const { calls, fetchImpl, endSse } = recordingFetch();
    const gateway = scopedGateway(fetchImpl);
    const bus = gateway.eventBusFor({ botId: "craft", directory: "dir" });
    expect(bus).not.toBe(null);
    if (!bus) return;

    bus.subscribe("ses_scope");
    await waitFor(() => calls.some((call) => call.url === "/event"));
    expectScopeHeaders(
      calls.find((call) => call.url === "/event")?.headers ?? {},
    );

    endSse();
    bus.close();
    await bus.readerSettled();
  });

  test("a standalone OpencodeServeClient built with a scope carries it", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new OpencodeServeClient({
      baseUrl: "http://gw.test",
      config: scopedConfig,
      token: "sandbox-secret",
      botId: "craft",
      executionScope: { tenantId: TENANT, workspaceId: WORKSPACE },
      fetchImpl,
    });
    expect(await client.healthCheckStatus()).toBe(200);
    expectScopeHeaders(calls[0]?.headers ?? {});
  });

  test("a standalone PodEventBus built with a scope carries it on the SSE dial", async () => {
    const { calls, fetchImpl, endSse } = recordingFetch();
    const bus = new PodEventBus({
      baseUrl: "http://gw.test",
      config: scopedConfig,
      directory: "dir",
      token: "sandbox-secret",
      botId: "craft",
      executionScope: { tenantId: TENANT, workspaceId: WORKSPACE },
      fetchImpl,
    });
    bus.subscribe("ses_scope");
    await waitFor(() => calls.some((call) => call.url === "/event"));
    expectScopeHeaders(
      calls.find((call) => call.url === "/event")?.headers ?? {},
    );

    endSse();
    bus.close();
    await bus.readerSettled();
  });
});

describe("#618 snapshot pair: both directions state the ownership headers", () => {
  test("snapshot and restore carry the scope", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = scopedGateway(fetchImpl);

    expect(await gateway.snapshotArchiveFor("craft")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(await gateway.restoreWorkspace("craft", new Uint8Array([1]))).toBe(
      true,
    );

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /workspace/snapshot",
      "POST /workspace/restore",
    ]);
    for (const call of calls) expectScopeHeaders(call.headers);
  });
});

describe("#618 assembly seam: the boot file's lambda is the one the gateway reads", () => {
  test("executionScopeFor supplies the pair even when the config carries none", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = createSandboxGateway({
      config: unscopedConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      executionScopeFor: () => ({ tenantId: TENANT, workspaceId: WORKSPACE }),
      fetchImpl,
    });
    const files = gateway.fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;
    await files.listFiles("dir");
    expectScopeHeaders(calls[0]?.headers ?? {});
  });

  test("a lambda resolving null fails closed even when the config carries a pair", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = createSandboxGateway({
      config: scopedConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      executionScopeFor: () => null,
      fetchImpl,
    });
    const files = gateway.fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;
    await expect(files.listFiles("dir")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("#618 fail-closed: no scope, no request, a displayable reason", () => {
  const unscopedGateway = (fetchImpl: typeof fetch) =>
    createSandboxGateway({
      config: unscopedConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      fetchImpl,
    });

  test("every file verb refuses before any fetch", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const files = unscopedGateway(fetchImpl).fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;

    await expect(files.listFiles("dir")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    await expect(files.writeFile("dir/a.txt", "x")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    await expect(files.deletePath("dir/a.txt")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    await expect(files.readFile("dir/a.txt")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(calls).toHaveLength(0);
  });

  test("serve client verbs refuse before any fetch", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = unscopedGateway(fetchImpl).serveClientFor({
      botId: "craft",
      directory: "dir",
    });
    expect(client).not.toBe(null);
    if (!client) return;

    await expect(
      client.ensureSession(null, { directory: "dir" }),
    ).rejects.toThrow(SandboxExecutionScopeUnavailableError);
    expect(calls).toHaveLength(0);
  });

  test("the event bus refuses at subscribe, before any SSE dial", () => {
    const { calls, fetchImpl } = recordingFetch();
    const bus = unscopedGateway(fetchImpl).eventBusFor({
      botId: "craft",
      directory: "dir",
    });
    expect(bus).not.toBe(null);
    if (!bus) return;

    expect(() => bus.subscribe("ses_scope")).toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(calls).toHaveLength(0);
    bus.close();
  });

  test("snapshot and restore refuse before any fetch", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = unscopedGateway(fetchImpl);
    await expect(gateway.snapshotArchiveFor("craft")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    await expect(
      gateway.restoreWorkspace("craft", new Uint8Array([1])),
    ).rejects.toThrow(SandboxExecutionScopeUnavailableError);
    expect(calls).toHaveLength(0);
  });

  test("the belt: a null-scope reader entered without subscribe() is terminal, not laddered", async () => {
    // OCR#8: subscribe()'s gate is the door; readOneStream's belt is the
    // guarantee that no FUTURE entrypoint can dial unattributed. Driven on the
    // belt's own path (the reader loop, not the door), the refusal must close
    // the bus now — feeding it to the reconnect ladder would spend ~8 minutes
    // redialing a deployment fact and hand subscribers nothing but silence.
    const { calls, fetchImpl } = recordingFetch();
    const bus = new PodEventBus({
      baseUrl: "http://gw.test",
      config: unscopedConfig,
      directory: "dir",
      token: "sandbox-secret",
      botId: "craft",
      executionScope: null,
      fetchImpl,
    });
    const readerDone = (
      bus as unknown as { readerLoop: () => Promise<void> }
    ).readerLoop();
    try {
      await Promise.race([
        readerDone,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "the belt's refusal did not close the reader — it is feeding the reconnect ladder",
                ),
              ),
            3000,
          ),
        ),
      ]);
    } finally {
      bus.close();
    }
    expect(bus.isClosed()).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("the refusal names no ownership value", async () => {
    // A tenant is configured but its workspace half is missing: the pair is
    // unusable, and the refusal must not echo even the half it did see.
    const halfConfig = loadCraftConfig({
      OPENBOT_CRAFT_SANDBOX_EXECUTION_TENANT_ID: TENANT,
    });
    const { fetchImpl } = recordingFetch();
    const gateway = createSandboxGateway({
      config: halfConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      fetchImpl,
    });
    let message = "";
    try {
      await gateway.snapshotArchiveFor("craft");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(TENANT);
    expect(message).not.toContain(WORKSPACE);
    expect(message).not.toContain("sandbox-secret");
  });
});

describe("#618 FR-F2: a scope-mismatch 403 propagates — no retry, no fold, no fallback", () => {
  /**
   * The mismatch half of AC4: the sandbox gateway answers a bot already bound to another
   * scope with 403. Every craft face must carry that verdict out as an error — never fold
   * it into the null/false "absent" contracts, never retry it, never fall back to another
   * or a default scope. One dial per operation, the SAME configured pair on it, the throw.
   */
  const statusFetch = (status: number) => {
    const calls: Recorded[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url: url.pathname,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });
      return new Response(null, { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  test("file face: a 403 throws on every verb — only 404 degrades to null/false", async () => {
    const { calls, fetchImpl } = statusFetch(403);
    const files = scopedGateway(fetchImpl).fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;

    await expect(files.readFile("dir/a.txt")).rejects.toThrow(/answered 403/);
    await expect(files.readFileBytes("dir/b.bin")).rejects.toThrow(
      /answered 403/,
    );
    await expect(files.deletePath("dir/b.bin")).rejects.toThrow(/answered 403/);
    await expect(files.listFiles("dir")).rejects.toThrow(/answered 403/);
    await expect(files.writeFile("dir/a.txt", "x")).rejects.toThrow(
      /answered 403/,
    );

    // One dial per verb — the verdict is never retried — and every dial states the
    // same configured pair (no scope switch, no default fallback).
    expect(calls).toHaveLength(5);
    for (const call of calls) expectScopeHeaders(call.headers);
  });

  test("file face: the honest-absent contracts stay 404-scoped (regression pins)", async () => {
    const { calls, fetchImpl } = statusFetch(404);
    const files = scopedGateway(fetchImpl).fileApiFor("craft");
    expect(files).not.toBe(null);
    if (!files) return;

    expect(await files.readFile("dir/a.txt")).toBe(null);
    expect(await files.readFileBytes("dir/b.bin")).toBe(null);
    expect(await files.deletePath("dir/b.bin")).toBe(false);
    expect(calls).toHaveLength(3);
  });

  test("serve client: /session create against 403 rejects once, same scope", async () => {
    const { calls, fetchImpl } = statusFetch(403);
    const client = scopedGateway(fetchImpl).serveClientFor({
      botId: "craft",
      directory: "dir",
    });
    expect(client).not.toBe(null);
    if (!client) return;

    let caught: unknown = null;
    try {
      await client.ensureSession(null, { directory: "dir" });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof OpencodeHttpError).toBe(true);
    expect((caught as OpencodeHttpError).status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/session");
    expectScopeHeaders(calls[0]?.headers ?? {});
  });

  test("event bus: a 403 on the dial closes the bus terminally — no reconnect ladder", async () => {
    const { calls, fetchImpl } = statusFetch(403);
    const bus = scopedGateway(fetchImpl).eventBusFor({
      botId: "craft",
      directory: "dir",
    });
    expect(bus).not.toBe(null);
    if (!bus) return;

    const sub = bus.subscribe("ses_scope");
    try {
      await Promise.race([
        bus.readerSettled(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("bus reader did not settle after the 403")),
            3000,
          ),
        ),
      ]);
    } finally {
      bus.close();
    }
    // Terminal, not laddered: after ONE refused dial the bus is closed (the ladder
    // variant would still be "reconnecting" here, silently redialing the verdict).
    expect(bus.isClosed()).toBe(true);
    const dials = calls.filter(
      (call) => call.url === "/event" || call.url === "/events",
    );
    expect(dials).toHaveLength(1);
    expectScopeHeaders(dials[0]?.headers ?? {});
    // The subscriber's signal is the closed sentinel — the thing the turn layer
    // translates into a transport error, never silence, never success.
    expect(await sub.queue.shift({ timeoutMs: 100 })).toBe(
      POD_EVENT_BUS_CLOSED,
    );
  });

  test("snapshot read: a 403 throws — 403-as-null was the fold this closed", async () => {
    const { calls, fetchImpl } = statusFetch(403);
    const gateway = scopedGateway(fetchImpl);
    await expect(gateway.snapshotArchiveFor("craft")).rejects.toThrow(
      /answered 403/,
    );
    expect(calls).toHaveLength(1);
    expectScopeHeaders(calls[0]?.headers ?? {});

    // The honest "no snapshot yet" stays 404 → null; only 404 means absent.
    const notFound = statusFetch(404);
    const gateway404 = scopedGateway(notFound.fetchImpl);
    expect(await gateway404.snapshotArchiveFor("craft")).toBe(null);
    expect(notFound.calls).toHaveLength(1);
  });

  test("restore write: a 403 throws — folding it to false was the silent rebuild", async () => {
    // OCR#5: only 409 (mid-turn) and 400 (not a snapshot) are the honest
    // "could not restore this instant" → false; a scope-mismatch 403 (or any
    // other verdict) travels out as the error it is, mirroring the snapshot
    // half — false would dress a mismatch up as "nothing to restore" and the
    // wake would silently rebuild the workspace over it.
    const { calls, fetchImpl } = statusFetch(403);
    await expect(
      scopedGateway(fetchImpl).restoreWorkspace("craft", new Uint8Array([1])),
    ).rejects.toThrow(/answered 403/);
    expect(calls).toHaveLength(1); // one dial, never retried
    expectScopeHeaders(calls[0]?.headers ?? {});

    const conflict = statusFetch(409);
    expect(
      await scopedGateway(conflict.fetchImpl).restoreWorkspace(
        "craft",
        new Uint8Array([1]),
      ),
    ).toBe(false);
    const badPayload = statusFetch(400);
    expect(
      await scopedGateway(badPayload.fetchImpl).restoreWorkspace(
        "craft",
        new Uint8Array([1]),
      ),
    ).toBe(false);
  });
});

describe("#618 OCR#12: the liveness probe surfaces the refusal, not a cold start", () => {
  test("a null-scope client's healthCheckStatus throws — the catch must not fold it to null", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const client = new OpencodeServeClient({
      baseUrl: "http://gw.test",
      config: unscopedConfig,
      token: "sandbox-secret",
      botId: "craft",
      executionScope: null,
      fetchImpl,
    });
    await expect(client.healthCheckStatus()).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(calls).toHaveLength(0); // the refusal precedes the dial
  });

  test("the gateway's healthCheck propagates the refusal — no dial, no swallow", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const gateway = createSandboxGateway({
      config: unscopedConfig,
      connectionFor: () => ({
        botId: "craft",
        baseUrl: "http://gw.test",
        token: "sandbox-secret",
      }),
      fetchImpl,
    });
    await expect(gateway.healthCheck("craft")).rejects.toThrow(
      SandboxExecutionScopeUnavailableError,
    );
    expect(calls).toHaveLength(0);
  });
});
