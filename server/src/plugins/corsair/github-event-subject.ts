import { z } from "zod";
import { githubId } from "./github";

export const githubPilotEventType = z.enum([
  "issues.opened",
  "issues.closed",
  "issue_comment.created",
]);

export const githubEventEnvelope = z.object({
  action: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  installation: z.object({ id: githubId }).optional(),
  repository: z
    .object({ id: githubId, full_name: z.string().max(256) })
    .optional(),
  issue: z.unknown().optional(),
  comment: z.unknown().optional(),
});

const subject = z.object({
  id: githubId,
  number: githubId,
  created_at: z.iso.datetime({ offset: true }),
  closed_at: z.iso.datetime({ offset: true }).nullish(),
});
const openedComment = z.object({
  id: githubId,
  created_at: z.iso.datetime({ offset: true }),
});
export function githubEventSubject(
  eventType: string,
  value: { issue?: unknown; comment?: unknown },
) {
  const issue = subject.safeParse(value.issue);
  const comment = openedComment.safeParse(value.comment);
  const timestamp = issue.success
    ? eventType === "issues.opened" && value.comment === undefined
      ? issue.data.created_at
      : eventType === "issues.closed" && value.comment === undefined
        ? issue.data.closed_at
        : eventType === "issue_comment.created" && comment.success
          ? comment.data.created_at
          : null
    : null;
  return { issue, comment, occurredAt: timestamp ? new Date(timestamp) : null };
}
