import { useSyncExternalStore } from "react";
import { defaultAgentProfile } from "./default-agent";
import type { AgentProfile } from "./queries";

/*
 * Which Bot each person put for Activity, Ideas and Goals. Kept in this browser, and kept per signed-in
 * person: the key carries their user id, so the next person on a shared machine starts from OpenBot's
 * own default Bot rather than the last person's choice. Choosing a Bot changes nothing on the server.
 */
// Keep the legacy key so existing choices survive the Web rollout.
function chosenBotKey(userId: string): string {
  return `openmuse-bot:${userId}`;
}

const choices = new Map<string, string | null>();
const listeners = new Set<() => void>();

function read(userId: string): string | null {
  if (!choices.has(userId)) {
    let stored: string | null = null;
    // localStorage throws in some privacy modes; these pages then start from the default Bot.
    try {
      stored = window.localStorage.getItem(chosenBotKey(userId));
    } catch {}
    choices.set(userId, stored);
  }
  return choices.get(userId) ?? null;
}

export function chooseBot(userId: string, agentId: string) {
  if (read(userId) === agentId) return;
  choices.set(userId, agentId);
  // The choice still holds for this visit when the browser refuses to store it.
  try {
    window.localStorage.setItem(chosenBotKey(userId), agentId);
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The Bot this person chose, or null before they choose one or while nobody is known yet. */
export function useChosenBotId(userId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (userId ? read(userId) : null),
    () => null,
  );
}

/** Looks up the requested or saved Bot in the accessible roster before falling back. */
export function resolveChosenBot(
  agents: readonly AgentProfile[] | undefined,
  chosenId: string | null,
  requestedId?: string,
): AgentProfile | undefined {
  if (!agents?.length) return undefined;
  return (
    agents.find((agent) => agent.id === requestedId) ??
    agents.find((agent) => agent.id === chosenId) ??
    defaultAgentProfile(agents)
  );
}
