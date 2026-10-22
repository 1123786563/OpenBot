import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function StatefulChild() {
  const [value, setValue] = useState("");
  return (
    <label>
      Local note
      <input
        aria-label="Local note"
        onChange={(event) => setValue(event.currentTarget.value)}
        value={value}
      />
      <output aria-label="Local note state">{value}</output>
    </label>
  );
}

test("keeps mounted child state visible when a background Bot refresh fails", async () => {
  let requestCount = 0;
  global.fetch = (async () => {
    requestCount += 1;
    return requestCount === 1
      ? Response.json({ agent: BOT })
      : new Response(null, { status: 503 });
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <BotSubpage
          agentId="expenses"
          description="Manage finance workflows."
          title="Responsibilities"
        >
          {() => <StatefulChild />}
        </BotSubpage>
      ),
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );

  const input = await view.findByRole("textbox", { name: "Local note" });
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.type(input, "Keep this draft");
  expect(view.getByLabelText("Local note state").textContent).toBe(
    "Keep this draft",
  );
  expect((input as HTMLInputElement).value).toBe("Keep this draft");

  await client.invalidateQueries({ queryKey: agentKeys.detail("expenses") });

  await waitFor(() => expect(requestCount).toBe(2));
  expect(await view.findByRole("alert")).toBeTruthy();
  expect(view.getByRole("heading", { name: "Responsibilities" })).toBeTruthy();
  expect(view.getByRole("textbox", { name: "Local note" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("Keep this draft");
});
