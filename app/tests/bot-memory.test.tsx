import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Memory page after #732: what the memory service knows is managed in the memory
 * service, and the one duty left on this page is the Bot's background research.
 */

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

const research = (id: string, agentId: string, focus: string) => ({
  id,
  agentId,
  channelId: `channel-${agentId}`,
  focus,
  enabled: true,
  intervalMinutes: 240,
  nextRunAt: "2026-10-09T12:00:00Z",
  lastRunAt: null,
  lastStatus: "idle",
  lastError: null,
});

/** A refusal the server gives the next write, or none. */
let refuseWrite: string | null = null;
function serving() {
  refuseWrite = null;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // The scoped reads wait for the scope source before they ask anything.
    if (url === "/api/me") return Response.json({ user: { id: "user-1" } });
    if (init?.method && init.method !== "GET") {
      if (refuseWrite) {
        const error = refuseWrite;
        refuseWrite = null;
        return Response.json({ error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    if (url === "/api/proactive/settings") {
      return Response.json({
        settings: [
          research("p1", "expenses", "Unpaid invoices"),
          research("p2", "knowledge", "Stale pages"),
        ],
      });
    }
    if (url.startsWith("/api/channels")) {
      return Response.json({ channels: [], nextCursor: null });
    }
    return Response.json({
      agents: [
        { id: "expenses", name: "Expenses" },
        { id: "knowledge", name: "Knowledge" },
      ],
    });
  }) as unknown as typeof fetch;
}

function draw(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

test("only this Bot's background research is listed, with no Bot to pick", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(await view.findByText(/Unpaid invoices/)).toBeTruthy();
  expect(view.queryByText(/Stale pages/)).toBeNull();
  /*
   * HeroUI Select.Trigger is a plain button with aria-haspopup="listbox"; the
   * role="combobox" the ui/select wrapper forwards is dropped by HeroUI (interface
   * change request recorded in h04/REPORT.md). Address the trigger by role button.
   */
  expect(view.queryByRole("button", { name: /^Bot/ })).toBeNull();
});

test("reopening a research row after a failure starts without it", async () => {
  serving();
  const view = draw(<ProactiveResearchSettings agentId="expenses" />);
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Expenses/ }));
  refuseWrite = "Research is paused.";
  await user.click(await view.findByRole("button", { name: "Run now" }));
  expect((await view.findByRole("alert")).textContent).toBe(
    "Research is paused.",
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  await user.click(view.getByRole("button", { name: /Expenses/ }));
  await view.findByRole("button", { name: "Run now" });
  expect(view.queryByRole("alert")).toBeNull();
});
