import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { botServiceKeys } from "./queries";

export type BotServiceRegisterInput = {
  botId: string;
  displayName: string;
  kind: "builtin" | "external";
  capabilities: string[];
};

export type BotServiceEditInput = {
  displayName?: string;
  capabilities?: string[];
};

function invalidate(queryClient: QueryClient) {
  return () =>
    queryClient.invalidateQueries({ queryKey: botServiceKeys.all });
}

export function registerBotServiceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: BotServiceRegisterInput) =>
      client("/api/admin/bot-services", {
        method: "POST",
        body: input,
        fallbackKey: "botServices.operation",
      }),
    onSuccess: invalidate(queryClient),
  });
}

export function editBotServiceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({ botId, ...body }: { botId: string } & BotServiceEditInput) =>
      client(`/api/admin/bot-services/${botId}`, {
        method: "POST",
        body,
        fallbackKey: "botServices.operation",
      }),
    onSuccess: invalidate(queryClient),
  });
}

export function disableBotServiceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (botId: string) =>
      client(`/api/admin/bot-services/${botId}/disable`, {
        method: "POST",
        fallbackKey: "botServices.operation",
      }),
    onSuccess: invalidate(queryClient),
  });
}
