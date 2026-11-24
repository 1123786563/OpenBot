import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import type { AuditInitiator } from "./initiator";

export const marketSkillIdentitySchema = z.object({
  source: z.string(),
  namespace: z.string(),
  slug: z.string(),
  registrySkillId: z.number().int(),
  version: z.string(),
  versionId: z.number().int(),
  fingerprint: z.string(),
});
export type MarketSkillIdentity = z.infer<typeof marketSkillIdentitySchema>;

export const marketSkillSnapshotSchema = z.object({
  slug: z.string(),
  title: z.string(),
  instructions: z.string(),
  market: marketSkillIdentitySchema,
});
export type MarketSkillSnapshot = z.infer<typeof marketSkillSnapshotSchema>;

/** Server middleware shares this selection with the tools that can pause the run. */
export const RUN_MARKET_SKILL = Symbol("run market skill");
export type RunWithMarketSkill = RunAgentInput & {
  [RUN_MARKET_SKILL]?: {
    /** Undefined before selection; null after selection found no market skill. */
    snapshot?: MarketSkillSnapshot | null;
  };
};

export function marketSkillForContinuation(input: RunWithMarketSkill) {
  const marketSkill = input[RUN_MARKET_SKILL]?.snapshot;
  return marketSkill ? { marketSkill } : {};
}

/**
 * Everything needed to pick a turn up again at the tool call it stopped on, once a person has
 * answered. Re-exported from approvals/types.ts, which parses and stores it.
 */
export type ApprovalContinuation = {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  messages: Message[];
  state: unknown;
  context: RunAgentInput["context"];
  forwardedProps: unknown;
  initiator?: AuditInitiator;
  budgeted?: true;
  marketSkill?: MarketSkillSnapshot;
};

const actionContext = new AsyncLocalStorage<ApprovalContinuation>();

/** Run a tool call with its continuation in scope, so a refusal inside it can be resumed later. */
export const withApprovalContext = <T>(
  context: ApprovalContinuation,
  run: () => Promise<T>,
): Promise<T> => actionContext.run(context, run);

export const currentApprovalContext = () => actionContext.getStore();
