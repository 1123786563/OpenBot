import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { BotService } from "./queries";
import { botServiceKeys } from "./queries";

/** A registration. Deliberately carries nothing a credential would: none is minted by registering. */
export type BotServiceRegistration = {
  botId: string;
  displayName: string;
  kind: "builtin" | "external";
  capabilities: string[];
};

/** An edit. The identity (botId, kind) is fixed at registration and never editable here. */
export type BotServiceEdit = {
  displayName?: string;
  capabilities?: string[];
};

export function registerBotServiceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: BotServiceRegistration) =>
      client<BotService>("/api/admin/bot-services", "botService", {
        method: "POST",
        body: input,
        fallbackKey: "botServices.operation",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: botServiceKeys.all }),
  });
}

export function editBotServiceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({ botId, edit }: { botId: string; edit: BotServiceEdit }) =>
      client<BotService>(
        `/api/admin/bot-services/${encodeURIComponent(botId)}`,
        "botService",
        {
          method: "PATCH",
          body: edit,
          fallbackKey: "botServices.operation",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: botServiceKeys.all }),
  });
}

export function setBotServiceStatusMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: ({
      botId,
      status,
    }: {
      botId: string;
      status: "active" | "disabled";
    }) =>
      client<BotService>(
        `/api/admin/bot-services/${encodeURIComponent(botId)}/${status === "disabled" ? "disable" : "enable"}`,
        "botService",
        {
          method: "POST",
          fallbackKey: "botServices.operation",
        },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: botServiceKeys.all }),
  });
}
