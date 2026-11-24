import { queryOptions } from "@tanstack/react-query";
import type { BillingQuote } from "@/lib/billing/queries";
import { client } from "@/lib/client";

type ModelPick = { id: string; revision: string };
type ModelOption = ModelPick & { provider: string; model: string };
type ModelChoices = {
  saved: ModelPick | null;
  source: "conversation" | "bot" | "harness";
  options: ModelOption[];
} & (
  | { quote: BillingQuote; reason?: never }
  | { reason: string; quote?: never }
);

export const testCreditModelKey = ["test-credit-model"] as const;

function path(botId: string, threadId?: string) {
  const query =
    threadId === undefined ? "" : `?${new URLSearchParams({ threadId })}`;
  return `/api/copilotkit/agent/${encodeURIComponent(botId)}/test-credit-model${query}`;
}

export function testCreditModelQuery(botId: string, threadId?: string) {
  return queryOptions({
    queryKey: [...testCreditModelKey, botId, threadId],
    queryFn: ({ signal }): Promise<ModelChoices> =>
      client(path(botId, threadId), {
        signal,
        fallback: "Couldn't load verified models.",
      }).then((response) => response.json()),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export async function saveTestCreditModel(
  botId: string,
  threadId: string | undefined,
  selection: ModelPick | null,
): Promise<ModelChoices> {
  const response = await client(path(botId, threadId), {
    method: "PUT",
    body: { selection },
    fallback: "Couldn't save the model.",
  });
  return response.json();
}
