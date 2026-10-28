import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  spyOn,
  test,
} from "../../tests/support/bun-test-compat";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { observeApprovalAgent } from "@/lib/copilot/approval-context";
import { useFrontendTool } from "@/lib/copilot/approval-tools";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  selectionKeys,
  selectionStorageKey,
  storeSelection,
} from "@/lib/enterprise/tenant/selection";

/**
 * The handler the SDK keeps for a computer change.
 *
 * The SDK registers a frontend tool's handler once and never re-registers it when the handler's
 * closure changes, so anything the handler reads from render time is frozen at first render. The
 * handler used to read the "Ask before making changes" switch that way, saw it still loading, and
 * sent every change straight to the computer outside any run; the server then answered "This action
 * needs an authenticated run before it can be approved." This drives the handler the SDK actually
 * kept, captured at first render, with no inbox loaded at all.
 *
 * Spies on the module namespace rather than `mock.module`, because bun cannot take a module mock
 * back off: it would stay installed for every test file walked into the same process afterwards,
 * and those files would get this fake SDK instead of the real one. These spies are restored below.
 */

type Registered = Parameters<typeof ReactCoreV2.useFrontendTool>[0];
const registered: Registered[] = [];
const stopped: unknown[] = [];
const useCopilotKitSpy = spyOn(ReactCoreV2, "useCopilotKit").mockImplementation(
  () =>
    ({
      copilotkit: { stopAgent: (input: unknown) => stopped.push(input) },
    }) as never,
);
function register<T extends Record<string, unknown>>(
  tool: ReactCoreV2.ReactFrontendTool<T>,
) {
  if (!registered.some((entry) => entry.name === tool.name))
    registered.push(tool as unknown as Registered);
}
const useFrontendToolSpy = spyOn(
  ReactCoreV2,
  "useFrontendTool",
).mockImplementation(register);
afterAll(() => {
  useCopilotKitSpy.mockRestore();
  useFrontendToolSpy.mockRestore();
});

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const direct: unknown[] = [];
function Tools() {
  useFrontendTool({
    name: "computer_click",
    description: "Click",
    handler: async (args: Record<string, unknown>) => {
      direct.push(args);
      return { clicked: true };
    },
  });
  return null;
}

test("a change goes to the server's gate even when nothing about approvals has loaded", async () => {
  const posted: { path: string; body: unknown }[] = [];
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // Only the gate's own calls are evidence here. Since MOD19 (#639) the tool registration
      // also holds the scope seam, whose auth read (`/api/me`) may fire during the render; the
      // scope it answers with stays pending in this harness, which is exactly the state under
      // test — a gate POST that rides no selection pair.
      if (String(path).startsWith("/api/approvals/")) {
        posted.push({
          path: String(path),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
      }
      return Response.json(
        { waiting: true, approvalId: "approval-1" },
        { status: 202 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const queries = new QueryClient();
    const invalidated: unknown[] = [];
    const invalidate = queries.invalidateQueries.bind(queries);
    queries.invalidateQueries = ((filters?: unknown) => {
      invalidated.push(filters);
      return invalidate(filters as never);
    }) as typeof queries.invalidateQueries;
    render(
      <QueryClientProvider client={queries}>
        <Tools />
      </QueryClientProvider>,
    );
    const tool = registered.find((entry) => entry.name === "computer_click");
    // The shape of the SDK's agent the handler reads: its subscriber hooks, thread and history.
    const toolCall = {
      id: "click-call",
      type: "function" as const,
      function: {
        name: "computer_click",
        arguments: '{"ref":"e7","snapshotId":3}',
      },
    };
    const subscribers: {
      onRunInitialized?: (input: { input: unknown }) => void;
    }[] = [];
    const agent = {
      threadId: "thread",
      state: {},
      messages: [
        { id: "u1", role: "user", content: "Submit the form" },
        { id: "a1", role: "assistant", content: "", toolCalls: [toolCall] },
      ],
      subscribe: (subscriber: (typeof subscribers)[number]) => {
        subscribers.push(subscriber);
        return { unsubscribe: () => undefined };
      },
    };
    const stop = observeApprovalAgent(agent as never);
    for (const subscriber of subscribers)
      subscriber.onRunInitialized?.({
        input: {
          runId: "run-1",
          threadId: "thread",
          messages: agent.messages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      });
    const result = await tool?.handler?.({ ref: "e7", snapshotId: 3 }, {
      agent,
      toolCall,
    } as never);
    stop();
    expect(direct).toEqual([]);
    expect(posted).toEqual([
      {
        path: "/api/approvals/computer/default",
        body: expect.objectContaining({
          runId: "run-1",
          threadId: "thread",
          toolCallId: "click-call",
          toolName: "computer_click",
          args: { ref: "e7", snapshotId: 3 },
        }),
      },
    ]);
    expect(result).toEqual({ waiting: true });
    expect(stopped).toHaveLength(1);
    // The card is drawn now, not on the inbox's next poll.
    expect(invalidated).toEqual([{ queryKey: ["approvals"] }]);
  } finally {
    global.fetch = originalFetch;
  }
});

/*
 * MOD19 / Issue #639: the registered handler reads the selection pair when it RUNS (the holder
 * rule active-bot.tsx owns), and the 202 card clears both inbox homes when a scope is in force.
 * These two probes are the same drive as the test above, with the scope seeded through the real
 * seam — they live here because the SDK namespace spy they need is Bun-only, and this suite is
 * where that harness already lives.
 */

const USER = "user-mod19";
const ACME = { tenantId: "acme", workspaceId: "acme-finance" };

/** The same reactive fact the tool's holder reads, shown so the drive can wait for it. */
function ScopeProbe() {
  const scope = useScopedCache();
  return (
    <span data-testid="scope-state">
      {scope.status === "open"
        ? `open ${JSON.stringify(scope.selection)}`
        : scope.status}
    </span>
  );
}

async function driveGateWithScope(
  seedSelection: { tenantId: string; workspaceId: string } | null,
): Promise<{
  posted: { path: string; headers: Record<string, string> }[];
  invalidated: unknown[];
  stoppedCount: number;
}> {
  const posted: { path: string; headers: Record<string, string> }[] = [];
  const invalidated: unknown[] = [];
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(path).startsWith("/api/approvals/")) {
        const headers =
          init?.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : ((init?.headers ?? {}) as Record<string, string>);
        posted.push({ path: String(path), headers });
        return Response.json({ waiting: true }, { status: 202 });
      }
      return Response.json({ user: { id: USER } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queries = new QueryClient();
  const invalidate = queries.invalidateQueries.bind(queries);
  queries.invalidateQueries = ((filters?: unknown) => {
    invalidated.push(filters);
    return invalidate(filters as never);
  }) as typeof queries.invalidateQueries;
  try {
    if (seedSelection) storeSelection(USER, seedSelection);
    // The registry dedupes by name, so a stale definition from an earlier render (whose holder
    // belongs to an unmounted instance) would be the one the drive hits. Re-register against this
    // render's holder, and count this run's stops only.
    registered.length = 0;
    stopped.length = 0;
    render(
      <QueryClientProvider client={queries}>
        <Tools />
        <ScopeProbe />
      </QueryClientProvider>,
    );
    // The handler reads the holder, which is current at the render AFTER the auth read answers —
    // wait for the scope to be open before driving it, or the drive races the /api/me observer.
    await waitFor(() =>
      expect(
        globalThis.document.querySelector('[data-testid="scope-state"]')
          ?.textContent ?? "",
      ).toContain("open"),
    );
    const tool = registered.find((entry) => entry.name === "computer_click");
    const toolCall = {
      id: "click-call",
      type: "function" as const,
      function: { name: "computer_click", arguments: '{"ref":"e7"}' },
    };
    const subscribers: {
      onRunInitialized?: (input: { input: unknown }) => void;
    }[] = [];
    const agent = {
      threadId: "thread",
      state: {},
      messages: [
        { id: "u1", role: "user", content: "Submit the form" },
        { id: "a1", role: "assistant", content: "", toolCalls: [toolCall] },
      ],
      subscribe: (subscriber: (typeof subscribers)[number]) => {
        subscribers.push(subscriber);
        return { unsubscribe: () => undefined };
      },
    };
    const stop = observeApprovalAgent(agent as never);
    for (const subscriber of subscribers)
      subscriber.onRunInitialized?.({
        input: {
          runId: "run-1",
          threadId: "thread",
          messages: agent.messages,
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
      });
    await tool?.handler?.({ ref: "e7" }, { agent, toolCall } as never);
    stop();
    return { posted, invalidated, stoppedCount: stopped.length };
  } finally {
    global.fetch = originalFetch;
    if (seedSelection)
      window.localStorage.removeItem(selectionStorageKey(USER));
  }
}

test("with an open scope the gate POST rides the pair and both inbox homes are cleared", async () => {
  const { posted, invalidated, stoppedCount } = await driveGateWithScope(ACME);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.headers["x-openbot-tenant"]).toBe(ACME.tenantId);
  expect(posted[0]?.headers["x-openbot-workspace"]).toBe(ACME.workspaceId);
  const keys = invalidated.map(
    (filters) => (filters as { queryKey?: unknown[] }).queryKey,
  );
  expect(keys).toContainEqual(["approvals"]);
  expect(keys).toContainEqual([
    ...selectionKeys.workspaceScope(USER, ACME.tenantId, ACME.workspaceId),
    "approvals",
  ]);
  expect(stoppedCount).toBe(1);
});

test("a personal context (open, no selection) rides no pair like the pending scope", async () => {
  const { posted } = await driveGateWithScope(null);
  expect(posted).toHaveLength(1);
  expect(posted[0]?.headers["x-openbot-tenant"]).toBeUndefined();
  expect(posted[0]?.headers["x-openbot-workspace"]).toBeUndefined();
});
