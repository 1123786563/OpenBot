import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as ReactCoreV2 from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import { SandboxedTools } from "@/lib/copilot/sandboxed-tools";
import { settleReactWork } from "./settle-react-work";

const PUBLISHED = {
  name: "refund_card",
  html: '<p id="amount"></p>',
  css: "p { color: blue; }",
  jsFunctions:
    'document.getElementById("amount").textContent = window.__args.amount;',
  argumentSchema: {
    type: "object",
    properties: { amount: { type: "string" } },
  },
};

/** What the hook was handed, loosened: the SDK's own type needs no renderer to exist. */
type Registered = {
  render?: (props: {
    args?: Record<string, unknown>;
    result?: string;
    status?: string;
    toolCallId?: string;
  }) => React.ReactNode;
  handler: (args: unknown, context?: unknown) => Promise<string>;
};

let tools: Registered[];
let decision: unknown = { allowed: true };

// The SDK owns tool registration and iframe execution; this checks what reaches them.
const frontends = spyOn(ReactCoreV2, "useFrontendTool");
const renderer = spyOn(ReactCoreV2, "OpenGenerativeUIActivityRenderer");
// Created after happy-dom registers, which replaces the global `fetch`.
let fetcher: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  fetcher = spyOn(globalThis, "fetch");
});
beforeEach(() => {
  tools = [];
  frontends.mockClear();
  frontends.mockImplementation(((tool: unknown) => {
    tools.push(tool as Registered);
  }) as never);
  renderer.mockClear();
  renderer.mockImplementation(() => <div data-testid="sandbox-renderer" />);
  fetcher.mockClear();
  fetcher.mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("/api/sandboxed")) {
      return Response.json({ components: [PUBLISHED] });
    }
    if (url.includes("/decision")) return Response.json(decision);
    return Response.json({
      components: [{ name: PUBLISHED.name, description: "A refund" }],
    });
  }) as unknown as typeof fetch);
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  frontends.mockRestore();
  renderer.mockRestore();
  fetcher.mockRestore();
  GlobalRegistrator.unregister();
});

function Declares() {
  useActiveBot("bot-1");
  return null;
}

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      {/* Grants are fetched for the Bot on screen, once a surface has declared one. */}
      <ActiveBotProvider>
        <Declares />
        <SandboxedTools />
      </ActiveBotProvider>
    </QueryClientProvider>,
  );
  // The published list arrives through a query; wait for the tool it registers.
  // Both: the component is drawn only once the Bot's grants have arrived too.
  for (
    let waited = 0;
    (tools.length === 0 || fetcher.mock.calls.length < 2) && waited < 50;
    waited++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { view, queryClient };
}

test("a published component is drawn in its host with its source unchanged", async () => {
  const { queryClient } = await mount();
  try {
    const drawn = tools.at(-1)?.render?.({
      status: "complete",
      args: { amount: "12" },
    });
    const screen = render(drawn);
    const sandbox = screen.getByTestId("sandbox-renderer");
    expect(sandbox.closest("[data-sandbox-host]")).toBeTruthy();
    expect(screen.getByText("refund_card")).toBeTruthy();
    expect(renderer.mock.calls.at(-1)?.[0]).toMatchObject({
      content: {
        html: [PUBLISHED.html],
        css: PUBLISHED.css,
        jsFunctions: `window.__args = {"amount":"12"};\n${PUBLISHED.jsFunctions}`,
      },
    });
  } finally {
    queryClient.clear();
  }
});

test("a component the server refused is named in a refusal instead of being drawn", async () => {
  decision = { allowed: false, reason: "Not allowed here." };
  const { queryClient } = await mount();
  try {
    expect(
      await tools.at(-1)?.handler({}, { toolCall: { id: "call-1" } }),
    ).toBe("Not allowed here.");
    // The refusal is remembered in state, and the next render reads it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const screen = render(
      tools.at(-1)?.render?.({ status: "complete", toolCallId: "call-1" }),
    );
    expect(screen.getByText("Not shown: refund_card")).toBeTruthy();
    expect(
      screen.getByText("Not shown: refund_card").closest(".astryx-banner"),
    ).toBeTruthy();
    expect(
      screen.container.querySelector('[data-testid="sandbox-renderer"]'),
    ).toBeNull();
  } finally {
    decision = { allowed: true };
    queryClient.clear();
  }
});
