import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { CopilotProvider } from "@/lib/copilot/provider";
import { Route as BotRoute } from "@/routes/_authed/_app/bot";
import { settleReactWork } from "./settle-react-work";

/*
 * `/bot` drawn for real: the app's own Copilot provider, the route, its chat view, the transcript
 * and the composer. The runtime is a stand-in at the HTTP boundary that behaves the way the real one
 * does (see `channel-failed-run-restore.test.tsx`): `/run` streams a run and records its events,
 * `/connect` replays every recorded run back to back, and the thread store holds what was said.
 *
 * Nothing here is a module mock. The fixture this replaces swapped `@copilotkit/react-core/v2` for
 * stubs, which bun cannot take back, so its `CopilotChat` div stood in for every file walked into
 * the same process, and the sixteen tests that drew it never rendered a chat at all.
 */

const NativeResponse = globalThis.Response;
/** The Bots this runtime knows about, as its `/info` tells the browser. */
const bots = ["general-assistant", "picked-harness", "hidden-bot"];
const originalFetch = globalThis.fetch;
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

type Event = Record<string, unknown>;

/** How the next `/run` goes. A fresh list per test. */
export type RunPlan =
  | { kind: "answers"; text: string }
  | { kind: "fails"; message: string; code?: string }
  /** The runtime itself is down: no run starts. */
  | { kind: "refuses" }
  /** Streams `events` and stays open until `releaseRun` ends it, as a Bot still working does. */
  | { kind: "holds"; events: Event[] };
let held: ((ending: Event[]) => void) | null = null;
/** The message the held run left open, and the run's own thread and id, for a stop to close. */
let heldOpen: {
  messageId: string | null;
  threadId: string;
  runId: string;
} | null = null;
/** End the run that is holding: `ending` is what the Bot did to finish. */
export function releaseRun(ending: Event[] = []) {
  held?.(ending);
}

export type Runtime = {
  plans: RunPlan[];
  /** Every event the runtime streamed for a thread, run after run: what `/connect` replays. */
  recorded: Map<string, unknown[]>;
  /** The thread store: what was said, and nothing about how a run ended. */
  stored: Map<string, Message[]>;
  /** The runs each thread has, as the messages read returns them. */
  threadRuns: Map<string, Record<string, unknown>[]>;
  /** Each stop this browser asked the server for, for a run by its id. */
  stops: { threadId: string; runId: string }[];
  /**
   * How a stop answers. `"ended"` is a run that ended between the read and the stop, which the
   * server confirms it did not stop; `"refused"` is a request the server fails.
   */
  stopAnswer: "confirms" | "ended" | "refused";
  /** Each run this browser asked the server to check the outcome of, by run id. */
  reconciles: string[];
  /** Each thread read of the messages route, oldest first. */
  reads: string[];
  /** Each abort this browser made of its own copy of a run, by thread. */
  aborts: string[];
  /** Each thread the chat joined, oldest first. */
  joins: { agentId: string; threadId: string }[];
  runs: RunAgentInput[];
  decisions: { id: string; decision: unknown }[];
  inbox: unknown[];
};
export const runtime: Runtime = {
  plans: [],
  recorded: new Map(),
  stored: new Map(),
  threadRuns: new Map(),
  stops: [],
  stopAnswer: "confirms",
  reconciles: [],
  reads: [],
  aborts: [],
  joins: [],
  runs: [],
  decisions: [],
  inbox: [],
};
let minted = 0;
/** A test's own answers, tried before the runtime's. Return undefined to fall through. */
let own: ((url: URL, request: () => Request) => unknown) | undefined;
export const answerWith = (answers: typeof own) => {
  own = answers;
};

function frames(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function sse(events: unknown[]) {
  return new NativeResponse(frames(events), {
    headers: { "content-type": "text/event-stream" },
  });
}
function remember(threadId: string, messages: Message[]) {
  const known = runtime.stored.get(threadId) ?? [];
  const ids = new Set(known.map((message) => message.id));
  runtime.stored.set(threadId, [
    ...known,
    ...messages.filter((message) => !ids.has(message.id)),
  ]);
}

/**
 * One run, as the runtime streams it and records it. The person's message is stored whatever the run
 * comes to; what the Bot said once the run is over.
 */
function run(input: RunAgentInput): Response {
  runtime.runs.push(input);
  const plan = runtime.plans.shift();
  if (!plan) throw new Error("A run nobody planned for");
  const { threadId, runId } = input;
  const started = { type: "RUN_STARTED", threadId, runId };
  remember(
    threadId,
    input.messages.filter((message) => message.role === "user"),
  );
  const finish = (...events: Event[]) => {
    runtime.recorded.set(threadId, [
      ...(runtime.recorded.get(threadId) ?? []),
      started,
      ...events,
    ]);
    const said = events.filter(
      (event) => event.type === "TEXT_MESSAGE_CONTENT",
    );
    const opening = events.find((event) => event.type === "TEXT_MESSAGE_START");
    if (typeof opening?.messageId === "string" && said.length > 0)
      remember(threadId, [
        {
          id: opening.messageId,
          role: "assistant",
          content: said.map((event) => String(event.delta)).join(""),
        },
      ]);
    return sse([started, ...events]);
  };
  if (plan.kind === "refuses")
    return new NativeResponse(
      JSON.stringify({ error: "upstream unavailable" }),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    );
  if (plan.kind === "fails")
    return finish({
      type: "RUN_ERROR",
      message: plan.message,
      // `agent_error`, or the reason the server stopped a run (`stoppedRunEvent`).
      code: plan.code ?? "agent_error",
    });
  if (plan.kind === "holds") {
    // Open until released, as a stream the Bot is still writing to is.
    let rest: (ending: Event[]) => void = () => {};
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const opening = plan.events.find(
          (event) => event.type === "TEXT_MESSAGE_START",
        );
        heldOpen = {
          messageId:
            typeof opening?.messageId === "string" ? opening.messageId : null,
          threadId,
          runId,
        };
        controller.enqueue(encoder.encode(frames([started, ...plan.events])));
        rest = (ending) => {
          void finish(...plan.events, ...ending);
          controller.enqueue(encoder.encode(frames(ending)));
          controller.close();
        };
      },
    });
    held = (ending) => rest(ending);
    return new NativeResponse(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const messageId = `reply-${runId}`;
  return finish(
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: plan.text },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId, runId },
  );
}

/**
 * Call once at the top level of a test file. The hooks live behind a call rather than in this
 * module's own top level because bun files imported hooks under the first file that reaches them:
 * a second file that imported this one ran with no document at all.
 */
export function botRuntime() {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://localhost",
        );
        const request = () =>
          input instanceof Request ? input : new Request(url, init);
        const mine = await own?.(url, request);
        if (mine instanceof Response) return mine;
        const path = url.pathname;
        if (path === "/api/capabilities") return NativeResponse.json({});
        if (path === "/api/admin/enterprise/me")
          return NativeResponse.json({ capabilities: {}, enforced: false });
        if (path === "/api/approvals")
          return NativeResponse.json({
            enabled: true,
            requests: runtime.inbox,
            rules: [],
            teamRules: [],
            questions: [],
          });
        if (path === "/api/threads/mint")
          return NativeResponse.json({ threadId: `thread-${++minted}` });
        const known = path.match(/^\/api\/threads\/([^/]+)$/);
        if (known) return NativeResponse.json({ known: true });
        const thread = path.match(/\/threads\/([^/]+)\/messages$/);
        if (thread) {
          const threadId = decodeURIComponent(thread[1] ?? "");
          runtime.reads.push(threadId);
          const runs = runtime.threadRuns.get(threadId);
          return NativeResponse.json({
            messages: runtime.stored.get(threadId) ?? [],
            ...(runs ? { runs } : {}),
          });
        }
        const controlled = path.match(
          /\/threads\/([^/]+)\/runs\/([^/]+)\/(stop|reconcile)$/,
        );
        if (controlled) {
          const threadId = decodeURIComponent(controlled[1] ?? "");
          const runId = decodeURIComponent(controlled[2] ?? "");
          const runs = runtime.threadRuns.get(threadId) ?? [];
          const mine = (run: Record<string, unknown>) => run.id === runId;
          if (controlled[3] === "stop") {
            runtime.stops.push({ threadId, runId });
            if (runtime.stopAnswer === "refused")
              return NativeResponse.json(
                { error: "The run could not be stopped." },
                { status: 500 },
              );
            /*
             * As `stopDirectChatRun` leaves a run it was asked to stop: over, with its reason, and an
             * action it was dispatching left with an outcome nobody can vouch for. Only a run still
             * going is stopped, and only that is confirmed.
             */
            const wasRunning =
              runtime.stopAnswer === "confirms" &&
              runs.some((run) => mine(run) && run.status === "running");
            runtime.threadRuns.set(
              threadId,
              runs.map((run) =>
                mine(run) && wasRunning
                  ? {
                      ...run,
                      status: "failed",
                      stopReason: "stopped",
                      ...(run.externalOutcome === "dispatching" && {
                        externalOutcome: "unknown",
                      }),
                    }
                  : run,
              ),
            );
            return NativeResponse.json({ stopped: wasRunning });
          }
          runtime.reconciles.push(runId);
          // As `settleManagedReceipt` does: the model's record settles what became of the action.
          runtime.threadRuns.set(
            threadId,
            runs.map((run) =>
              mine(run) ? { ...run, externalOutcome: "executed" } : run,
            ),
          );
          return NativeResponse.json({ externalOutcome: "executed" });
        }
        /*
         * This browser's own abort, as the runtime carries it out: the run left open is closed and
         * ends RUN_FINISHED, outcome cancelled, never a RUN_ERROR (`finalizeRunEvents` in
         * @copilotkit/shared, with `stopRequested`).
         */
        const abort = path.match(
          /\/api\/copilotkit\/agent\/([^/]+)\/stop\/([^/]+)$/,
        );
        if (abort) {
          runtime.aborts.push(decodeURIComponent(abort[2] ?? ""));
          const open = heldOpen;
          heldOpen = null;
          held?.([
            ...(open?.messageId
              ? [{ type: "TEXT_MESSAGE_END", messageId: open.messageId }]
              : []),
            {
              type: "RUN_FINISHED",
              threadId: open?.threadId ?? "",
              runId: open?.runId ?? "",
              outcome: { type: "cancelled" },
            },
          ]);
          return NativeResponse.json({ stopped: true });
        }
        if (path.endsWith("/info"))
          return NativeResponse.json({
            version: "fixture",
            agents: Object.fromEntries(
              [...bots].map((id) => [
                id,
                { description: "Fixture", capabilities: {} },
              ]),
            ),
            mode: "sse",
            telemetryDisabled: true,
          });
        const agent = path.match(/\/api\/copilotkit\/agent\/([^/]+)\/(.+)$/);
        if (agent?.[2] === "connect") {
          const { threadId } = (await request().json()) as { threadId: string };
          runtime.joins.push({
            agentId: decodeURIComponent(agent[1] ?? ""),
            threadId,
          });
          return sse(runtime.recorded.get(threadId) ?? []);
        }
        if (agent?.[2] === "run")
          return run(RunAgentInputSchema.parse(await request().json()));
        const decision = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
        if (decision) {
          runtime.decisions.push({
            id: decodeURIComponent(decision[1] ?? ""),
            decision: (await request().json()) as { decision: unknown },
          });
          return NativeResponse.json({ ok: true });
        }
        return NativeResponse.json({ error: "not served" }, { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    cleanup();
    sessionStorage.clear();
    localStorage.clear();
    own = undefined;
    runtime.plans = [];
    runtime.recorded = new Map();
    runtime.stored = new Map();
    runtime.threadRuns = new Map();
    runtime.stops = [];
    runtime.stopAnswer = "confirms";
    runtime.reconciles = [];
    runtime.reads = [];
    runtime.aborts = [];
    runtime.joins = [];
    heldOpen = null;
    runtime.runs = [];
    runtime.decisions = [];
    runtime.inbox = [];
    held = null;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  afterAll(async () => {
    await settleReactWork();
    globalThis.fetch = originalFetch;
    GlobalRegistrator.unregister();
  });
}

export function agent(
  overrides: Partial<AgentProfile> & { id: string },
): AgentProfile {
  return {
    avatarSeed: "seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    name: "Agent",
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

export function queryClientWithAgents(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  return queryClient;
}

/** The roster cannot be read, so `/bot` cannot say which Bot is the default. */
export function failEveryRequest() {
  answerWith(() => new Response(null, { status: 500 }));
}

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  // The provider the signed-in app wraps every route in, reconnect and tools included.
  component: () => (
    <CopilotProvider>
      <Outlet />
    </CopilotProvider>
  ),
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof BotRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};

/*
 * TanStack's generated route tree wires file routes with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts), and the memory-router docs use an explicit test tree. The
 * createFileRoute update type exposed to tests does not include those generated wiring fields,
 * so this cast is confined to the file-route attachment point; the rendered component, router,
 * query data, and assertions stay typed.
 */
const testBotRoute = BotRoute.update({
  id: "/bot",
  path: "/bot",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([appRoute.addChildren([testBotRoute])]),
]);

export function renderBot(queryClient: QueryClient, initialEntry = "/bot") {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The thread the chat joined last: the one its composer posts to. */
export function currentJoin() {
  const join = runtime.joins.at(-1);
  expect(join).toBeDefined();
  return join as { agentId: string; threadId: string };
}
