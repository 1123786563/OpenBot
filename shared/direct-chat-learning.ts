import { z } from "zod";

export const directChatProposal = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(4000),
});

const scopeId = z.string().min(1).max(256);
export const directChatLearningScope = z
  .object({
    personId: scopeId,
    threadId: scopeId,
    botId: scopeId,
  })
  .strict();
export const directChatDecision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    scope: directChatLearningScope,
  })
  .strict();
export const directChatAutoApproval = z
  .object({
    autoApprove: z.boolean(),
  })
  .strict();
export const directChatReview = directChatDecision.extend({
  reviewerId: scopeId,
  mode: z.enum(["manual", "automatic"]),
  reviewedAt: z.string(),
});
export type DirectChatLearningScope = z.infer<typeof directChatLearningScope>;
export type DirectChatDecision = z.infer<typeof directChatDecision>;
export type DirectChatReview = z.infer<typeof directChatReview>;

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
  scope: directChatLearningScope,
  autoApprove: z.boolean(),
  latest: analysis.nullable(),
  lastResult: analysis.nullable(),
  proposals: z.array(
    directChatProposal.extend({
      id: z.string(),
      state: z.enum(["pending_review", "published", "rejected"]),
      review: directChatReview.nullable(),
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
