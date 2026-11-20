import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  environmentManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DirectChatLearning } from "@/components/channels/direct-chat-learning";

test("Learn now starts analysis and shows its pending proposal and source", async () => {
  GlobalRegistrator.register();
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  const client = new QueryClient();
  const analysis = {
    id: "analysis-1",
    startedAt: "2026-11-20T10:00:00Z",
    evidenceCount: 1,
    reason: null,
  };
  const initial = {
    enabled: true,
    available: true,
    latest: null,
    lastResult: null,
    proposals: [],
  };
  const running = { ...initial, latest: { ...analysis, state: "running" } };
  const proposed = { ...analysis, state: "proposed" };
  let started = false;
  let readsAfterStart = 0;
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
        expect(url).toBe(
          "/api/copilotkit/threads/direct-thread/learn?agentId=bot-1",
        );
        if (options?.method === "POST") {
          started = true;
          return Response.json(running, { status: 202 });
        }
        if (!started) return Response.json(initial);
        if (readsAfterStart++ === 0) return Response.json(running);

        return Response.json({
          ...initial,
          latest: proposed,
          lastResult: proposed,
          proposals: [
            {
              id: analysis.id,
              state: "pending_review",
              title: "Prepare a checklist",
              instructions: "List the steps in order.",
              evidence: [
                {
                  runId: "run-1",
                  userMessageId: "question-1",
                  assistantMessageId: "reply-1",
                  prompt: "How should I prepare?",
                  reply: "Start with a checklist.",
                },
              ],
            },
          ],
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const view = render(
      <QueryClientProvider client={client}>
        <DirectChatLearning threadId="direct-thread" agentId="bot-1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await view.findByRole("button", { name: "Learning" }));
    fireEvent.click(await view.findByRole("button", { name: "Learn now" }));
    await view.findByText("Analyzing 1 completed turn…");
    await view.findByText(
      "Last result · Proposal ready for review from 1 completed turn.",
      {},
      { timeout: 3000 },
    );
    await view.findByText("Pending review");
    fireEvent.click(view.getByText("Evidence (1 turn)"));
    expect(view.getByText(/How should I prepare/)).toBeTruthy();
    expect(view.getByText(/Start with a checklist/)).toBeTruthy();
  } finally {
    cleanup();
    client.clear();
    transport.mockRestore();
    environmentManager.setIsServer(() => wasServer);
    GlobalRegistrator.unregister();
  }
});
