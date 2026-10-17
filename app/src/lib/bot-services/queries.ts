import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** The registry row as the wire carries it: timestamps are ISO strings, everything else as stored. */
export type BotServiceRecord = {
  botId: string;
  displayName: string;
  kind: "builtin" | "external";
  capabilities: string[];
  status: "active" | "disabled";
  registeredBy: string;
  disabledAt: string | null;
  disabledBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export const botServiceKeys = {
  all: ["botServices"] as const,
  list: () => [...botServiceKeys.all, "list"] as const,
};

export function botServiceListQueryOptions() {
  return queryOptions({
    queryKey: botServiceKeys.list(),
    queryFn: async (): Promise<BotServiceRecord[]> => {
      return client("/api/admin/bot-services", "botServices", {
        fallbackKey: "botServices.load",
      });
    },
  });
}
