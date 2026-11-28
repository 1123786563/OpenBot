import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import { settleReactWork } from "./settle-react-work";

/**
 * The Access page's "Bots it can ask" section is drawn only when its read succeeds, so a failed
 * read used to make the whole block vanish with no way back. This pins the in-place recovery.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let handoffStatus = 503;

function serving() {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/handoff")) {
        if (handoffStatus !== 200) {
          return Response.json(
            { error: "Unavailable" },
            { status: handoffStatus },
          );
        }
        return Response.json({
          handoff: {
            enabled: true,
            canGrant: true,
            reachable: [],
            grantable: [],
          },
        });
      }
      if (path === "/api/agents" || path === "/api/agents?hidden=true") {
        return Response.json({ agents: [] });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function draw() {
  serving();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HandoffPanel agentId="expenses" />
    </QueryClientProvider>,
  );
}

test("a failed read of the Bots it can ask shows the error and retries in place", async () => {
  const view = draw();
  expect(
    await view.findByText("Couldn’t load the Bots this Bot can ask"),
  ).toBeTruthy();
  handoffStatus = 200;
  await userEvent
    .setup({ document })
    .click(view.getByRole("button", { name: "Retry" }));

  await waitFor(() =>
    expect(
      view.queryByText("Couldn’t load the Bots this Bot can ask"),
    ).toBeNull(),
  );
  expect(await view.findByText("No other Bots yet")).toBeTruthy();
});
