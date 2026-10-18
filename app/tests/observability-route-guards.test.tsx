import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { agentKeys, type AgentProfile } from "@/lib/agents/queries";
import { requireBotObservabilityAccess } from "@/lib/observability/route-guard";

const clientWith = (canManage: boolean) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.detail("bot-1"), {
    id: "bot-1",
    canManage,
  } as AgentProfile);
  return queryClient;
};

test("a manager reaches the observability page", async () => {
  const agent = await requireBotObservabilityAccess(clientWith(true), "bot-1");
  expect(agent.canManage).toBe(true);
});

for (const canManage of [false, undefined]) {
  test(`canManage=${String(canManage)} is redirected to /bots`, async () => {
    let thrown: unknown;
    try {
      await requireBotObservabilityAccess(
        clientWith(canManage as boolean),
        "bot-1",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
  });
}
