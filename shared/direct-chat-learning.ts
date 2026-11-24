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
export const learningEvidenceSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), id: scopeId }),
  z.object({
    kind: z.literal("recording"),
    id: z.uuid().transform((id) => id.toLowerCase()),
  }),
]);
export type LearningEvidenceSelection = z.infer<
  typeof learningEvidenceSelection
>;
export const learningRequest = z
  .object({
    evidence: z.array(learningEvidenceSelection).min(1).max(8).optional(),
    revisesProposalId: z.uuid().optional(),
  })
  .strict();
export const learningEvidencePermission = z
  .object({ allowed: z.boolean() })
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

export const learningScheduleSettings = z
  .object({
    enabled: z.boolean(),
    intervalHours: z.number().int().min(1).max(168),
  })
  .strict();

const learningEvidence = z.union([
  z.object({
    source: learningEvidenceSelection,
    title: z.string(),
    excerpt: z.string(),
  }),
  z.object({
    runId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
    prompt: z.string(),
    reply: z.string(),
  }),
]);

export const directChatLearning = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  scope: directChatLearningScope,
  autoApprove: z.boolean(),
  latest: analysis.nullable(),
  lastResult: analysis.nullable(),
  schedule: learningScheduleSettings
    .extend({
      nextAt: z.string().nullable(),
      lastResult: analysis.nullable(),
    })
    .optional(),
  proposals: z.array(
    directChatProposal.extend({
      id: z.string(),
      state: z.enum([
        "pending_review",
        "published",
        "rejected",
        "revision_required",
        "paused",
      ]),
      review: directChatReview.nullable(),
      revisionSubmitted: z.boolean().optional(),
      evidence: z.array(learningEvidence),
    }),
  ),
});

export const openBotPersonalReview = z.object({
  mode: z.literal("openbot"),
  autoApprove: z.boolean().nullable(),
  conversations: z.array(
    z.object({
      channelId: scopeId,
      threadId: scopeId,
      botId: scopeId,
      title: z.string(),
      botName: z.string(),
    }),
  ),
});

export type OpenBotPersonalReview = z.infer<typeof openBotPersonalReview>;

export const adminLearningDecision = z
  .object({ decision: directChatDecision.shape.decision })
  .strict();

export const adminLearningHistory = z.object({
  runs: z.array(
    analysis.extend({
      proposal: directChatProposal
        .extend({
          evidence: z.array(learningEvidence),
          decision: adminLearningDecision.shape.decision.nullable(),
          canApprove: z.boolean(),
        })
        .nullable(),
    }),
  ),
});

const publishedSkillSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  botName: z.string(),
  access: z.enum(["owned", "shared"]),
});

export const publishedSkillCatalog = z.object({
  skills: z.array(publishedSkillSummary),
});

export const publishedSkillDetail = publishedSkillSummary.extend({
  instructions: z.string(),
  canShare: z.boolean(),
  shares: z.array(z.object({ recipientId: scopeId, email: z.string() })),
});

export const publishedSkillShare = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
