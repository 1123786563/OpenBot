import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client, tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type {
  ScopedCache,
} from "@/lib/enterprise/tenant/scoped-cache";
import { sharedUseKeys } from "@/lib/plugins/shared-use";

/** A published Team Bot as this person sees it. Audience fields only for its owner and admins. */
export type TeamBot = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  mine: boolean;
  audience: "team" | "people";
  publishedAt: string;
  /** An administrator put it in this person's sidebar; they cannot hide it. */
  assigned: boolean;
  /** False while its name or description would leave teammates unable to see it. */
  visibleToTeam: boolean;
  /**
   * Whether THIS person may take the publication away: the owner or an administrator. A server
   * capability, answered per row — the sharing page renders the action from it and never
   * re-derives it from an ownership flag or a role of its own (MT085 AC1).
   */
  canUnpublish: boolean;
  /**
   * Whether THIS person may publish or re-aim the publication: the owner only. The server splits
   * this from `canUnpublish` exactly as its own `publish` and `unpublish` rules do — an
   * administrator may retire somebody else's publication but may not aim it (MT085).
   */
  canEditPublication: boolean;
  /** Whether THIS person may pin this Bot for groups: an administrator, answered per row (MT085). */
  canAssign: boolean;
  people?: string[];
  groups?: string[];
  assignments?: string[];
};
export type TeamBotsData = {
  teamBots: TeamBot[];
  /** This person's own Bots that are not published yet. */
  publishable: { id: string; name: string; title: string }[];
  /**
   * The audience ranges the server allows a publication to choose. The design's set — the whole
   * team, or named people and groups — and nothing wider: a cross-company option cannot be
   * offered because the server never names one (MT085 AC2).
   */
  publishAudiences: readonly ("team" | "people")[];
};

export const teamBotKeys = { all: ["team-bots"] as const };

export function teamBotsQueryOptions() {
  return queryOptions({
    queryKey: teamBotKeys.all,
    queryFn: async (): Promise<TeamBotsData> => {
      const response = await client("/api/team-bots", {
        fallbackKey: "teamBots.load",
      });
      return (await response.json()) as TeamBotsData;
    },
  });
}

/**
 * The sharing page's read, bound to the scope the screen holds (MT085): keyed under the scope's
 * own cache prefix, carrying the selection pair, and answered through the same generation guard
 * every scoped read passes — so a publication list that left under one selection never decorates
 * the scope that replaced it.
 */
export function scopedTeamBotsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, ...teamBotKeys.all]
        : [...teamBotKeys.all, ":scope-pending"],
    enabled: open !== null,
    queryFn:
      open === null
        ? () => new Promise<TeamBotsData>(() => {})
        : async ({ signal }): Promise<TeamBotsData> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/team-bots", {
                signal,
                fallbackKey: "teamBots.load",
                ...(open.selection ?? {}),
              });
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                  error?: unknown;
                } | null;
                throw new Error(
                  typeof body?.error === "string"
                    ? body.error
                    : "Team Bots could not be read.",
                );
              }
              return (await response.json()) as TeamBotsData;
            }),
  });
}

/** Where a teammate starts a private chat with a Team Bot; what "Copy link" copies. */
export function teamBotLink(botId: string, origin = window.location.origin) {
  return `${origin}/channel/new?agent=${encodeURIComponent(botId)}`;
}

const path = (botId: string, rest = "") =>
  `/api/team-bots/${encodeURIComponent(botId)}${rest}`;

/** The selection options a write here carries when a scope is in force (MT085). */
function scopeOptions(scope: ScopedCache | undefined) {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : {};
}

/** Any change to who can see a Bot changes the roster too — both cache homes. */
const refresh = (queryClient: QueryClient, scope?: ScopedCache) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: teamBotKeys.all }),
    queryClient.invalidateQueries({ queryKey: agentKeys.all }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...teamBotKeys.all],
          }),
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...agentKeys.all],
          }),
        ]
      : []),
  ]);

export function publishTeamBotMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      audience: "team" | "people";
      emails: string[];
      groups: string[];
    }) => {
      const { botId, ...body } = input;
      await client(path(botId, "/publication"), {
        method: "PUT",
        body,
        fallbackKey: "teamBots.publish",
        ...scopeOptions(scope),
      });
    },
    /* Publishing can widen who reaches a shared app, so the request inbox may now hold a
     * fresh one (or SharedAppNotice's own query may need to drop a request it just resolved). */
    onSettled: () =>
      Promise.all([
        refresh(queryClient, scope),
        queryClient.invalidateQueries({ queryKey: sharedUseKeys.requests() }),
      ]),
  });
}

export function unpublishTeamBotMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (botId: string) => {
      await client(path(botId, "/publication"), {
        method: "DELETE",
        fallbackKey: "teamBots.unpublish",
        ...scopeOptions(scope),
      });
    },
    onSettled: () => refresh(queryClient, scope),
  });
}

export function assignTeamBotMutationOptions(
  queryClient: QueryClient,
  scope?: ScopedCache,
) {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      group: string;
      remove?: boolean;
    }) => {
      await client(
        input.remove
          ? path(input.botId, `/assignments/${encodeURIComponent(input.group)}`)
          : path(input.botId, "/assignments"),
        {
          method: input.remove ? "DELETE" : "POST",
          ...(input.remove ? {} : { body: { group: input.group } }),
          fallbackKey: "teamBots.saveAssignment",
          ...scopeOptions(scope),
        },
      );
    },
    onSettled: () => refresh(queryClient, scope),
  });
}

export type TeamBotConsentDecision =
  | "allow_once"
  | "allow_always"
  | "allow_all_team_bots"
  | "skip";

export function teamBotConsentMutationOptions() {
  return mutationOptions({
    mutationFn: async (input: {
      botId: string;
      serverId: string;
      decision: TeamBotConsentDecision;
    }) => {
      await client(path(input.botId, "/consents"), {
        method: "POST",
        body: { serverId: input.serverId, decision: input.decision },
        fallbackKey: "teamBots.saveAnswer",
      });
    },
  });
}

export function clearTeamBotConsentsMutationOptions() {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/team-bots/consents", {
        method: "DELETE",
        fallbackKey: "teamBots.clearPreferences",
      });
    },
  });
}

/** Mirrors `TEAM_BOT_CONSENT_MARKER` in server/src/team-bots/team-bots.ts. */
export const TEAM_BOT_CONSENT_MARKER = "[team-bot-consent]";

/** A consent refusal's card data, or null for any other tool result. */
export function readTeamBotConsent(
  text: string | undefined,
): { botId: string; serverId: string; message: string } | null {
  if (!text?.startsWith(TEAM_BOT_CONSENT_MARKER)) return null;
  const rest = text.slice(TEAM_BOT_CONSENT_MARKER.length);
  const end = rest.indexOf("}");
  if (end < 0) return null;
  try {
    const parsed = JSON.parse(rest.slice(0, end + 1)) as {
      botId?: unknown;
      serverId?: unknown;
    };
    if (typeof parsed.botId !== "string" || typeof parsed.serverId !== "string")
      return null;
    return {
      botId: parsed.botId,
      serverId: parsed.serverId,
      message: rest.slice(end + 1).trim(),
    };
  } catch {
    return null;
  }
}
