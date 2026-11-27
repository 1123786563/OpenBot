import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { PilotComputerActions } from "@/components/manage/pilot-computer-actions";
import { settleReactWork } from "./settle-react-work";

const originalFetch = global.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("profile reset and workspace clear confirm independently for the selected Bot", async () => {
  const requests: { path: string; body: unknown }[] = [];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ changed: true });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <PilotComputerActions
        browserId="own-browser"
        browser
        execution
        bots={[{ id: "notes", name: "Notes" }]}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    view.getByRole("button", { name: "Reset browser profile for Notes" }),
  );
  const reset = within(await view.findByRole("alertdialog"));
  expect(reset.getByText(/sign in again/)).toBeTruthy();
  expect(requests).toEqual([]);
  fireEvent.click(reset.getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    view.getByRole("button", { name: "Clear workspace for Notes" }),
  );
  const clear = within(await view.findByRole("alertdialog"));
  expect(clear.getByText(/permanently deletes/)).toBeTruthy();
  expect(requests).toEqual([]);
  fireEvent.click(clear.getByRole("button", { name: "Clear workspace" }));
  await waitFor(() =>
    expect(requests).toEqual([
      {
        path: "/api/computers/notes/computers/clear-workspace",
        body: { confirmation: "clear-workspace" },
      },
    ]),
  );
});
