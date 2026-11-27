import { Platform } from "react-native";
import type { Memory, Routine } from "./api/generated/model";

export function isLocalMobilePreview(
  route: string,
  preview: string | string[] | undefined,
): boolean {
  if (!__DEV__) return false;
  if (Platform.OS === "ios") {
    if (process.env.EXPO_PUBLIC_MOBILE_PREVIEW !== "1") return false;
    if (route === "/") return true;
  } else if (
    Platform.OS !== "web" ||
    typeof window === "undefined" ||
    window.location.hostname !== "localhost"
  ) {
    return false;
  }
  return (
    preview === "1" &&
    (route === "/" ||
      route === "/conversation" ||
      route === "/bots" ||
      route === "/bot" ||
      route === "/routine" ||
      route === "/computer" ||
      route === "/plugins" ||
      route === "/memory" ||
      route === "/rules")
  );
}

export const previewConversations = [
  {
    id: "weekly-plan",
    name: "Plan the week",
    botId: "Workspace Assistant",
    prompt: "Help me plan this week around the product demo on Thursday.",
    reply:
      "Monday: confirm the demo scope. Tuesday: prepare the walkthrough. Wednesday: do a dry run and resolve any blockers.",
  },
  {
    id: "meeting-notes",
    name: "Summarize meeting notes",
    botId: "Research Assistant",
    prompt: "What did we decide in the launch planning meeting?",
    reply:
      "We agreed to launch to the pilot group first. Alex will draft the announcement and Morgan will confirm the rollout date.",
  },
  {
    id: "project-update",
    name: "Draft a project update",
    botId: "Writing Assistant",
    prompt: "Draft a short project update for the team.",
    reply:
      "The core workflow is ready for review. This week we're testing the pilot experience and collecting feedback before launch.",
  },
];

export const previewBots = [
  {
    id: "workspace",
    name: "Workspace Assistant",
    title: "Plans work and tracks follow-ups",
  },
  {
    id: "research",
    name: "Research Assistant",
    title: "Finds and summarizes information",
  },
  {
    id: "writing",
    name: "Writing Assistant",
    title: "Drafts updates and notes",
  },
];

export const previewRoutines: Routine[] = previewBots.map((bot, index) => {
  const conversation = previewConversations[index];
  return {
    id: `sample-${bot.id}`,
    botId: bot.id,
    instruction: [
      "Send me a Monday planning brief",
      "Summarize new research every Friday",
      "Draft the weekly project update",
    ][index],
    schedule: index === 0 ? "Mondays at 9 AM" : "Fridays at 9 AM",
    cron: index === 0 ? "0 9 * * 1" : "0 9 * * 5",
    timezone: "Asia/Shanghai",
    title: null,
    conversation: {
      id: conversation.id,
      name: bot.name,
      title: conversation.name,
      gone: false,
    },
    enabled: index !== 1,
    nextRunAt: index === 0 ? "2026-11-30T01:00:00Z" : "2026-12-04T01:00:00Z",
    lastRun: null,
    goalId: null,
    createdAt: "2026-11-20T01:00:00Z",
  };
});

export const previewSkills = [
  {
    slug: "weekly-planning",
    title: "Weekly planning",
    summary: "Turn deadlines and meetings into a weekly plan.",
  },
  {
    slug: "meeting-recap",
    title: "Meeting recap",
    summary: "Extract decisions and follow-ups from notes.",
  },
];

export const previewTools = [
  {
    ref: "calendar/list_events",
    description: "Read upcoming events from the team calendar.",
  },
];

const memoryFields = {
  sourceId: null,
  sourceApp: null,
  sourceLink: null,
  observedAt: null,
  createdAt: "2026-11-20T01:00:00Z",
  updatedAt: "2026-11-20T01:00:00Z",
};

export const previewMemories: Memory[] = [
  {
    ...memoryFields,
    id: "sample-preference",
    content: "Keep weekly updates brief and list decisions first.",
    provenance: "Personal preference",
    enabled: true,
    formedBy: "person",
    formedByBotId: null,
    reviewState: "confirmed",
  },
  {
    ...memoryFields,
    id: "sample-reminder",
    content: "Schedule planning reminders for Monday mornings.",
    provenance: "Planning conversation",
    enabled: false,
    formedBy: "bot",
    formedByBotId: "workspace",
    reviewState: "unreviewed",
  },
];
