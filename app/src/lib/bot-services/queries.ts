import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The Bifrost bot service registry as the admin page reads it (Bifrost #234, 04.1).
 *
 * A record here is an identity and a declaration, never a credential: the server returns no key
 * material on any of these paths, and this type is where that promise is visible — there is no
 * field a secret could arrive in.
 */
export type BotService = {
  botId: string;
  displayName: string;
  kind: "builtin" | "external";
  capabilities: string[];
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
};

/** The capabilities an administrator may declare, in the registry's canonical order. */
export const BOT_SERVICE_CAPABILITIES = [
  "chat",
  "image",
  "audio",
  "embedding",
  "realtime",
  "async",
] as const;

export const botServiceKeys = {
  all: ["bot-services"] as const,
  list: () => [...botServiceKeys.all, "list"] as const,
};

export function botServiceListQueryOptions() {
  return queryOptions({
    queryKey: botServiceKeys.list(),
    queryFn: async (): Promise<BotService[]> =>
      client("/api/admin/bot-services", "botServices", {
        fallbackKey: "botServices.load",
      }),
  });
}
