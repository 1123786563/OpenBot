import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
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
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallbackKey: "approvals.saveDecision",
  });
export const revokeApprovalRule = (id: string) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "approvals.revoke",
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (input: {
  enabled?: boolean;
  autoReview?: boolean;
  hostCommands?: HostCommandPolicy;
}) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.savePreference",
  });
export const createApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallbackKey: "approvals.saveRule",
  });
export const setTeamApprovalSettings = (input: {
  enforceAutoReview?: boolean;
  customRulesEnabled?: boolean;
  hostCommandsCap?: HostCommandPolicy;
}) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.saveTeamSetting",
  });
export const createTeamApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallbackKey: "approvals.saveTeamRule",
  });
export const revokeTeamApprovalRule = (id: string) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallbackKey: "approvals.removeTeamRule",
  });
export const answerPersonQuestion = (id: string, response: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallbackKey: "teamBots.saveAnswer",
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.changeRule",
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallbackKey: "approvals.changeTeamRule",
  });

const approvalsKey = ["approvals"] as const;
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: approvalsKey });

export const approvalPreferencesMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setApprovalPreferences,
    onSettled: settle(queryClient),
  });
export const createApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: revokeApprovalRule,
    onSettled: settle(queryClient),
  });
export const teamApprovalSettingsMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setTeamApprovalSettings,
    onSettled: settle(queryClient),
  });
export const createTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createTeamApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeTeamApprovalRule,
    onSettled: settle(queryClient),
  });
/** Allow once, always allow, deny, or "I did it myself" on one waiting action. */
export const decideApprovalMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: settle(queryClient),
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: settle(queryClient),
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
