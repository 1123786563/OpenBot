import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { YourRecordings } from "@/components/browser/your-recordings";

test("a saved Recording starts Learning in the chosen Conversation using only that Recording", async () => {
  GlobalRegistrator.register();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const id = "54feda29-d215-4c50-ac55-6b4ff7d215ac";
  const status = {
    enabled: true,
    available: true,
    scope: { personId: "person", botId: "bot", threadId: "chosen-thread" },
    autoApprove: true,
    latest: null,
    lastResult: null,
    proposals: [],
  };
  const starts: unknown[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
        if (url === "/api/recorder/recordings")
          return Response.json({
            canManage: true,
            nextCursor: null,
            recordings: [
              {
                id,
                title: "Pack a shipment",
                recordedAt: "2026-11-23T12:00:00Z",
                ended: "succeeded",
                reason: null,
              },
            ],
          });
        if (url === "/api/settings/learning/review")
          return Response.json({
            mode: "openbot",
            autoApprove: true,
            conversations: [
              {
                channelId: "other",
                threadId: "other-thread",
                botId: "other-bot",
                title: "Draft labels",
                botName: "Label Bot",
              },
              {
                channelId: "chosen",
                threadId: "chosen-thread",
                botId: "bot",
                title: "Ship orders",
                botName: "Shipping Bot",
              },
            ],
          });
        expect(url).toBe(
          "/api/copilotkit/threads/chosen-thread/learn?agentId=bot",
        );
        if (options?.method === "POST") {
          starts.push(JSON.parse(String(options.body)));
          return Response.json(status, { status: 202 });
        }
        expect(options?.method ?? "GET").toBe("GET");
        return Response.json(status);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const view = render(
      <QueryClientProvider client={client}>
        <YourRecordings />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await view.findByRole("button", {
        name: "Learn from recording Pack a shipment",
      }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: /Shipping Bot.*Ship orders/ }),
    );
    expect(await view.findByText(/uses Test Credits/)).toBeTruthy();
    expect(starts).toEqual([]);
    fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
    await waitFor(() =>
      expect(starts).toEqual([{ evidence: [{ kind: "recording", id }] }]),
    );
  } finally {
    cleanup();
    client.clear();
    transport.mockRestore();
    GlobalRegistrator.unregister();
  }
});
