import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { directChatRuns, opikRuns } from "../db/schema";

export const runFeedback = z.object({
  feedbackId: z.uuid().transform((id) => id.toLowerCase()),
  score: z.union([z.literal(0), z.literal(1)]),
  comment: z.string().max(4000).optional(),
});

export async function saveRunFeedback(
  transaction: Parameters<Parameters<Database["transaction"]>[0]>[0],
  target: { threadId: string; runId: string },
  feedback: z.infer<typeof runFeedback>,
) {
  const [run] = await transaction
    .select({
      status: directChatRuns.status,
      startedAt: directChatRuns.startedAt,
    })
    .from(directChatRuns)
    .where(
      and(
        eq(directChatRuns.threadId, target.threadId),
        eq(directChatRuns.id, target.runId),
      ),
    );
  if (!run || run.status === "running") return "absent";

  const values = { ...feedback, comment: feedback.comment ?? null };
  const [saved] = await transaction
    .insert(opikRuns)
    .values({
      ...target,
      ...values,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.startedAt,
      trace: "dropped",
    })
    .onConflictDoUpdate({
      target: [opikRuns.threadId, opikRuns.runId],
      set: values,
      setWhere: isNull(opikRuns.feedbackId),
    })
    .returning({ id: opikRuns.id });
  if (saved) return "accepted";

  const [existing] = await transaction
    .select({
      feedbackId: opikRuns.feedbackId,
      score: opikRuns.score,
      comment: opikRuns.comment,
    })
    .from(opikRuns)
    .where(
      and(
        eq(opikRuns.threadId, target.threadId),
        eq(opikRuns.runId, target.runId),
      ),
    );
  return existing?.feedbackId === values.feedbackId &&
    existing.score === values.score &&
    existing.comment === values.comment
    ? "accepted"
    : "conflict";
}
