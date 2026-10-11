import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { SkillFormValues } from "@/lib/skills/form";
export type DemonstrationDraft = SkillFormValues & {
  requiredTools: string[];
  sourceRecordingId: string;
};
export type Demonstration = {
  id: string;
  botId: string;
  title: string;
  status: "recording" | "stopped" | "drafted" | "published";
  actions: {
    kind: string;
    target: { role: string; name: string; sensitive: boolean };
  }[];
  draft: DemonstrationDraft | null;
  skillSlug: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** When the server stops this recording. Recordings are capped at ten minutes. */
  expiresAt: string;
  maxDurationMs: number;
  /** Whether the server's ten-minute limit, not a person, ended it. */
  reachedTimeLimit: boolean;
};
/** A routine made from a published demonstration skill. */
export type DemonstrationRoutine = {
  id: string;
  agentId: string;
  channelId: string;
  cron: string;
  timezone: string;
  instruction: string;
  nextRunAt: string;
};
export const demonstrationKeys = {
  all: ["demonstrations"] as const,
  bot: (botId: string) => ["demonstrations", botId] as const,
};
export const demonstrationsQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: demonstrationKeys.bot(botId),
    queryFn: (): Promise<Demonstration[]> =>
      client(
        `/api/demonstrations?botId=${encodeURIComponent(botId)}`,
        "demonstrations",
        { fallbackKey: "demonstrations.load" },
      ),
    refetchInterval: 2000,
  });
export const startDemonstration = (
  botId: string,
  title: string,
): Promise<Demonstration> =>
  client("/api/demonstrations", "demonstration", {
    method: "POST",
    body: { botId, title },
    fallbackKey: "demonstrations.start",
  });
export const stopDemonstration = (id: string) =>
  client(`/api/demonstrations/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    fallbackKey: "demonstrations.stop",
  });
export const draftDemonstration = (id: string): Promise<DemonstrationDraft> =>
  client(`/api/demonstrations/${encodeURIComponent(id)}/draft`, "draft", {
    method: "POST",
    fallbackKey: "demonstrations.draft",
  });
export const publishDemonstration = (id: string, slug: string) =>
  client(`/api/demonstrations/${encodeURIComponent(id)}/published`, {
    method: "POST",
    body: { slug },
    fallbackKey: "demonstrations.link",
  });
export const deleteDemonstration = (id: string) =>
  client(`/api/demonstrations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "demonstrations.delete",
  });
/** Run the demonstration's saved skill on a schedule, as an ordinary routine. */
export const scheduleDemonstration = (
  id: string,
  input: {
    cron: string;
    timezone?: string;
    channelId?: string;
    inputs?: string;
  },
): Promise<DemonstrationRoutine> =>
  client(`/api/demonstrations/${encodeURIComponent(id)}/schedule`, "routine", {
    method: "POST",
    body: input,
    fallbackKey: "demonstrations.schedule",
  });
