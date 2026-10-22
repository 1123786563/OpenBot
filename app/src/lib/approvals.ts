import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/** The selection pair a scoped call rides, spread into the client options (MT086). */
type ScopePair = { tenantId?: string; workspaceId?: string };
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & { id: string };
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
export type ApprovalInboxData = {
  enabled: boolean;
  requests: {
    id: string;
    status: string;
    createdAt: string;
    action: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      threadId: string;
      toolCallId?: string;
      args: unknown;
      target: unknown;
      policy?: {
        behaviour: "allow" | "ask" | "hand_off" | "deny";
        source: string;
        reason: string;
      };
    };
  }[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: {
    id: string;
    botId: string;
    /** The Bot whose conversation this belongs to: for a hand-off, the Bot that handed it on. */
    conversationBotId?: string;
    threadId: string;
    question: string;
    why?: string;
    createdAt: string;
  }[];
};
export const approvalInboxOptions = () =>
  queryOptions({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalInboxData> => {
      const response = await client("/api/approvals", {
        fallbackKey: "approvals.load",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });

// ---------------------------------------------------------------------------
// The scoped half (MT086 / Issue #129): the approvals page reads and decides through here
// ---------------------------------------------------------------------------

/**
 * The refusal a scoped inbox read raises when the server answers that the approval surface is not
 * this person's to hold under the scope they carry — a suspended company, a left team.
 *
 * The status is the server's own (404, the canonical no-leak answer); the
 * page answers it with ONE unavailable state rather than a blank inbox, which would read as "no
 * approvals" over "no access" (MT086 AC2).
 */
export class ApprovalsUnavailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Approvals are not available under the scope you hold.");
    this.name = "ApprovalsUnavailableError";
    this.status = status;
  }
}

/**
 * The approvals inbox, bound to the scope the screen holds (MT086 / Issue #129, AC1).
 *
 * The key composes onto the scope's own cache prefix (`scoped-cache.ts`, MT083), so one person's
 * two scopes never share an inbox and a switch drops the old scope's wholesale; the request
 * carries the selection pair; and the answer passes the same generation guard every scoped read
 * passes, so an inbox that left under one selection never decorates the scope that replaced it.
 * The pair-shaped refusal (403/404) raises the typed unavailable error the page answers with the
 * one refusal state.
 */
export function scopedApprovalInboxOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    queryKey:
      open !== null
        ? [...open.prefix, "approvals"]
        : ["approvals", ":scope-pending"],
    enabled: open !== null,
    refetchInterval: 10_000,
    queryFn:
      open === null
        ? () => new Promise<ApprovalInboxData>(() => {})
        : async ({ signal }): Promise<ApprovalInboxData> =>
            guarded(queryClient, open.userId, async () => {
              const response = await tryClient("/api/approvals", {
                signal,
                fallbackKey: "approvals.load",
                ...(open.selection ?? {}),
              });
              if (response.status === 404) {
                throw new ApprovalsUnavailableError(response.status);
              }
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                  error?: unknown;
                } | null;
                throw new Error(
                  typeof body?.error === "string"
                    ? body.error
                    : "The approval inbox could not be read.",
                );
              }
              return (await response.json()) as ApprovalInboxData;
            }),
  });
}
export const decideApproval = (
  id: string,
  decision: ApprovalDecision,
  scope?: ScopePair,
) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallbackKey: "approvals.saveDecision",
    ...(scope ?? {}),
  });
export const revokeApprovalRule = (id: string, scope?: ScopePair) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "approvals.revoke",
    ...(scope ?? {}),
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (
  input: {
    enabled?: boolean;
    autoReview?: boolean;
    hostCommands?: HostCommandPolicy;
  },
  scope?: ScopePair,
) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.savePreference",
    ...(scope ?? {}),
  });
export const createApprovalRule = (input: ApprovalRuleInput, scope?: ScopePair) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallbackKey: "approvals.saveRule",
    ...(scope ?? {}),
  });
export const setTeamApprovalSettings = (
  input: {
    enforceAutoReview?: boolean;
    customRulesEnabled?: boolean;
    hostCommandsCap?: HostCommandPolicy;
  },
  scope?: ScopePair,
) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.saveTeamSetting",
    ...(scope ?? {}),
  });
export const createTeamApprovalRule = (
  input: ApprovalRuleInput,
  scope?: ScopePair,
) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallbackKey: "approvals.saveTeamRule",
    ...(scope ?? {}),
  });
export const revokeTeamApprovalRule = (id: string, scope?: ScopePair) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "approvals.removeTeamRule",
    ...(scope ?? {}),
  });
export const answerPersonQuestion = (
  id: string,
  response: string,
  scope?: ScopePair,
) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallbackKey: "teamBots.saveAnswer",
    ...(scope ?? {}),
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
  scope?: ScopePair,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.changeRule",
    ...(scope ?? {}),
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
  scope?: ScopePair,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.changeTeamRule",
    ...(scope ?? {}),
  });

const approvalsKey = ["approvals"] as const;

/**
 * The scope the writes here submit under (MT086 / Issue #129, AC1): an open scope's selection
 * rides the request as the client's own per-request pair, and a pending one submits nothing — a
 * decision cannot fire before its surface's scope source has answered.
 */
function scopePair(
  scope: ScopedCache | undefined,
): { tenantId?: string; workspaceId?: string } | undefined {
  return scope !== undefined && scope.status === "open"
    ? (scope.selection ?? {})
    : undefined;
}

/**
 * Server-derived answers are invalidated in both homes: the approvals surface's unscoped entries,
 * and — when a scope is in force — this scope's own subtree (MT083's prefix), where the scoped
 * inbox read lives.
 */
const settle = (queryClient: QueryClient, scope?: ScopedCache) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: approvalsKey }),
    ...(scope !== undefined && scope.status === "open"
      ? [
          queryClient.invalidateQueries({
            queryKey: [...scope.prefix, ...approvalsKey],
          }),
        ]
      : []),
  ]);

export const approvalPreferencesMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (input: Parameters<typeof setApprovalPreferences>[0]) =>
      setApprovalPreferences(input, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const createApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (input: ApprovalRuleInput) =>
      createApprovalRule(input, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const updateApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const revokeApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (id: string) => revokeApprovalRule(id, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const teamApprovalSettingsMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (input: Parameters<typeof setTeamApprovalSettings>[0]) =>
      setTeamApprovalSettings(input, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const createTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (input: ApprovalRuleInput) =>
      createTeamApprovalRule(input, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const updateTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
export const revokeTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (id: string) => revokeTeamApprovalRule(id, scopePair(scope)),
    onSettled: settle(queryClient, scope),
  });
/** Allow once, always allow, deny, or "I did it myself" on one waiting action. */
export const decideApprovalMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice, scopePair(scope)),
    onSuccess: settle(queryClient, scope),
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (
  queryClient: QueryClient,
  scope?: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response, scopePair(scope)),
    onSuccess: settle(queryClient, scope),
  });

/**
 * Whether a rule's Bot field covers this Bot, matched the way the server matches it (`policy.ts`):
 * `*` is anything, and a `*` inside a value is any run of characters.
 */
export function ruleCoversBot(pattern: string, agentId: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(agentId);
}
