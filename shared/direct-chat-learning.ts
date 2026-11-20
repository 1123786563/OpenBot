import { z } from "zod";

export const directChatProposal = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(4000),
});

const analysis = z.object({
  id: z.string(),
  state: z.enum([
    "running",
    "reconciling",
    "proposed",
    "skipped",
    "failed",
    "cancelled",
  ]),
  reason: z.string().nullable(),
  startedAt: z.string(),
  evidenceCount: z.number().int().nonnegative(),
});

export const directChatLearning = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  latest: analysis.nullable(),
  lastResult: analysis.nullable(),
  proposals: z.array(
    directChatProposal.extend({
      id: z.string(),
      state: z.literal("pending_review"),
      evidence: z.array(
        z.object({
          runId: z.string(),
          userMessageId: z.string(),
          assistantMessageId: z.string(),
          prompt: z.string(),
          reply: z.string(),
        }),
      ),
    }),
  ),
});
