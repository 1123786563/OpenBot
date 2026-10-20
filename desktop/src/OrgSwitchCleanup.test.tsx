// MT100 (Issue #143): the leave-organization surface. The Rust suite
// (cargo test org_switch_cleanup) pins the cleanup contract itself — this suite
// pins what the person sees: evidence counts on success, an honest unfinished
// message with a retry, and a failure box that also retries. The receipt the
// mock answers with is identifiers and counts only, the same shape the command
// returns.

import { afterAll, afterEach, beforeAll, expect, mock, test } from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { within } from "@testing-library/react";

type CleanupReceipt = {
  authority: string;
  credentials: string[];
  subscriptions: string[];
  mediaEntries: number;
  cacheEntries: number;
  completed: boolean;
};

let invokeCalls = 0;
let invokeAnswers: Array<
  CleanupReceipt | { __error: string }
> = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    if (command !== "leave_organization") {
      throw new Error(`unexpected command: ${command}`);
    }
    expect((args as { root: string }).root).toBe("/fixtures/openbot");
    invokeCalls += 1;
    const answer = invokeAnswers.shift();
    if (answer && "__error" in answer) throw new Error(answer.__error);
    return answer;
  },
}));

mock.module("./Problem", () => ({
  asProblem: (error: unknown) => ({
    said: error instanceof Error ? error.message : String(error),
  }),
  Failure: ({ problem }: { problem: { said: string } }) => (
    <p role="alert">{problem.said}</p>
  ),
}));

const { OrgSwitchCleanup } = await import("./OrgSwitchCleanup");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  invokeCalls = 0;
  invokeAnswers = [];
});
afterAll(() => GlobalRegistrator.unregister());

const doneReceipt: CleanupReceipt = {
  authority: "https://company-a.example",
  credentials: ["BILLING", "SESSION"],
  subscriptions: ["plan-a"],
  mediaEntries: 3,
  cacheEntries: 2,
  completed: true,
};

test("a completed cleanup shows the evidence counts and finishes", async () => {
  invokeAnswers = [doneReceipt];
  let left: CleanupReceipt | undefined;
  render(
    <OrgSwitchCleanup root="/fixtures/openbot" onLeft={(r) => (left = r)} />,
  );
  await act(async () => {
    fireEvent.click(within(document.body!).getByRole("button", { name: "Leave organization" }));
  });
  await waitFor(() => expect(within(document.body!).getByRole("status")).toBeTruthy());
  expect(within(document.body!).getByText(/2 credential/).textContent).toContain("2");
  expect(within(document.body!).getByText(/1 subscription/).textContent).toContain("1");
  expect(within(document.body!).getByText(/3 media file/).textContent).toContain("3");
  expect(within(document.body!).getByText(/2 cache file/).textContent).toContain("2");
  // The surface never renders values: identifier counts only.
  expect(within(document.body!).getByRole("status").textContent).not.toContain("cookie");
  expect(left).toBe(doneReceipt);
  expect(invokeCalls).toBe(1);
});

test("an unfinished cleanup says so, keeps its state retryable, and retries", async () => {
  invokeAnswers = [
    { ...doneReceipt, completed: false, credentials: ["SESSION"] },
    doneReceipt,
  ];
  const left: CleanupReceipt[] = [];
  render(
    <OrgSwitchCleanup root="/fixtures/openbot" onLeft={(r) => left.push(r)} />,
  );
  await act(async () => {
    fireEvent.click(within(document.body!).getByRole("button", { name: "Leave organization" }));
  });
  await waitFor(() =>
    expect(within(document.body!).getByText(/could not be removed/)).toBeTruthy(),
  );
  expect(left).toHaveLength(0);
  await act(async () => {
    fireEvent.click(within(document.body!).getByRole("button", { name: "Try again" }));
  });
  await waitFor(() =>
    expect(within(document.body!).getByText(/Removed this organization/)).toBeTruthy(),
  );
  expect(invokeCalls).toBe(2);
  expect(left).toHaveLength(1);
});

test("a failure shows the problem and a retry still runs", async () => {
  invokeAnswers = [
    { __error: "Start this OpenBot installation before leaving its organization." },
    doneReceipt,
  ];
  render(<OrgSwitchCleanup root="/fixtures/openbot" />);
  await act(async () => {
    fireEvent.click(within(document.body!).getByRole("button", { name: "Leave organization" }));
  });
  await waitFor(() =>
    expect(within(document.body!).getByRole("alert").textContent).toContain(
      "Start this OpenBot installation",
    ),
  );
  await act(async () => {
    fireEvent.click(within(document.body!).getByRole("button", { name: "Leave organization" }));
  });
  await waitFor(() => expect(within(document.body!).getByRole("status")).toBeTruthy());
  expect(invokeCalls).toBe(2);
});
