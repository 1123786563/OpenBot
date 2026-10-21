import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { CopilotKitProvider, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import i18n from "@/lib/i18n";
import { SignInTool } from "@/lib/copilot/sign-in-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The open chat's sign-in card, drawn by the renderer the SDK actually keeps.
 *
 * The SDK registers a frontend tool's renderer once and does not re-register it when the function
 * changes, so anything the renderer reads from the registering component's render is frozen at first
 * render. The card used to take its request id from state the handler set, which the kept renderer
 * never saw: the card said "Waiting for you to sign in" with no way to open the form. This uses the
 * real provider and the real hook, so an SDK that changes how it keeps renderers is caught here too.
 */

beforeAll(async () => {
  GlobalRegistrator.register();
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  focusManager.setFocused(undefined);
});

const TOOL_CALL_ID = "call-sign-in";
const SITE = "https://shop.example";
const signInRequest = {
  id: "request-1",
  botId: "default",
  origin: SITE,
  reason: null,
  status: "pending" as string,
  method: null as string | null,
  outcome: null as string | null,
  threadId: null,
  toolCallId: TOOL_CALL_ID,
  controlRequestId: null,
  createdAt: "2026-10-12T10:00:00Z",
  expiresAt: "2026-10-12T10:15:00Z",
  resolvedAt: null as string | null,
  passwordManager: false,
  savedLogins: [],
};

function serving(open: (typeof signInRequest)[]) {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/sign-in-requests" && method === "POST")
        return Response.json(signInRequest, { status: 201 });
      if (path === "/api/sign-in-requests")
        return Response.json({ requests: open });
      if (path === `/api/sign-in-requests/${signInRequest.id}`)
        return Response.json(open[0] ?? signInRequest);
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

type Renderer = ComponentType<Record<string, unknown>>;
type Kept = {
  renderer?: Renderer;
  handler?: (args: unknown, context: unknown) => Promise<unknown>;
};

function Capture({ kept }: { kept: Kept }) {
  const { copilotkit } = useCopilotKit();
  const entry = copilotkit.renderToolCalls.find(
    (candidate) => candidate.name === "computer_request_sign_in",
  );
  kept.renderer = entry?.render as Renderer | undefined;
  kept.handler = copilotkit.getTool({
    toolName: "computer_request_sign_in",
  })?.handler as Kept["handler"];
  return null;
}

function Providers({
  queries,
  children,
}: {
  queries: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queries}>
      <CopilotKitProvider>{children}</CopilotKitProvider>
    </QueryClientProvider>
  );
}

test("the waiting card offers the private sign-in once the request exists", async () => {
  serving([]);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kept: Kept = {};
  const tree = render(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => expect(kept.handler).toBeDefined());

  // The chat draws the call as soon as it streams in, before the handler has opened the request.
  const Kept = kept.renderer as Renderer;
  const drawn = (
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
      <Kept
        name="computer_request_sign_in"
        args={{ site: SITE }}
        status="executing"
        toolCallId={TOOL_CALL_ID}
      />
    </Providers>
  );
  serving([]);
  tree.rerender(drawn);
  await tree.findByText("Waiting for you to sign in");
  // Long enough for a card that looks the request up to have looked once and found nothing.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // In a background tab nothing polls, so the request has to reach the card without a timer.
  focusManager.setFocused(false);
  serving([signInRequest]);

  // The model calls the tool: the handler opens the request on the server and waits on it.
  const stop = new AbortController();
  const answered = kept.handler?.(
    { site: SITE },
    { signal: stop.signal, toolCall: { id: TOOL_CALL_ID } },
  );

  const open = await tree.findByRole(
    "button",
    { name: /Open private sign-in/ },
    { timeout: 4000 },
  );
  focusManager.setFocused(undefined);
  fireEvent.click(open);
  await tree.findByText(`Sign in to ${SITE}`);
  await tree.findByText(/Goes to your Bot's browser/);

  stop.abort();
  await answered;
});

test("the waiting handler keeps waiting while the site asks for a code", async () => {
  const codeRequest = {
    ...signInRequest,
    status: "code_required",
    method: "typed",
  };
  const signedInRequest = {
    ...signInRequest,
    status: "signed_in",
    method: "typed",
    outcome: `Signed in to ${SITE}.`,
    resolvedAt: "2026-10-12T10:05:00Z",
  };
  serving([codeRequest]);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const kept: Kept = {};
  const tree = render(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
    </Providers>,
  );
  await waitFor(() => expect(kept.handler).toBeDefined());
  const Kept = kept.renderer as Renderer;
  tree.rerender(
    <Providers queries={queries}>
      <SignInTool />
      <Capture kept={kept} />
      <Kept
        name="computer_request_sign_in"
        args={{ site: SITE }}
        status="executing"
        toolCallId={TOOL_CALL_ID}
      />
    </Providers>,
  );
  await tree.findByText("Waiting for you to sign in");

  const stop = new AbortController();
  const answered = kept.handler?.(
    { site: SITE },
    { signal: stop.signal, toolCall: { id: TOOL_CALL_ID } },
  );

  const open = await tree.findByRole(
    "button",
    { name: /Open private sign-in/ },
    { timeout: 4000 },
  );
  fireEvent.click(open);
  await tree.findByText(`Sign in to ${SITE}`);
  // The dialog's form is on the code step, and on it alone: no password asked again.
  await tree.findByText("Enter the verification code");
  expect(tree.queryByText("Password")).toBeNull();

  // Longer than two polls of the waiting handler: a code step is not an answer, and the turn has
  // neither succeeded nor failed while it sits open.
  let returned: unknown = "waiting";
  void Promise.resolve(answered).then((value) => {
    returned = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 3500));
  expect(returned).toBe("waiting");
  await tree.findByText("Waiting for you to sign in");

  // The site accepts the code; only then does the waiting turn come back with a verdict.
  serving([signedInRequest]);
  const outcome = (await answered) as { signedIn?: boolean };
  expect(outcome.signedIn).toBe(true);

  // Leaving the conversation ends the card's binding: the pending list the card looked its request
  // up in is dropped rather than left for whatever mounts next.
  tree.unmount();
  expect(
    queries
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey.includes("sign-in-requests")),
  ).toEqual([]);
}, 15000);
