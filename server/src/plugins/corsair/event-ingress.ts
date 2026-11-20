import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "../../db/client";
import { githubPilotEventReceipts } from "../../db/schema/corsair";
import { verifyGithubSignature } from "../../responsibilities/signatures";
import { githubId } from "./github";

const receiptTable = githubPilotEventReceipts;
const subject = z.object({
  id: githubId,
  number: githubId,
  created_at: z.iso.datetime({ offset: true }),
  closed_at: z.iso.datetime({ offset: true }).nullish(),
});
const envelope = z.object({
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
const openedComment = z.object({
  id: githubId,
  created_at: z.iso.datetime({ offset: true }),
});
const headers = z.object({
  deliveryId: z.uuid().transform((value) => value.toLowerCase()),
  event: z.string().regex(/^[a-z_]{1,64}$/),
});

export const githubPilotEventType = z.enum([
  "issues.opened",
  "issues.closed",
  "issue_comment.created",
]);

export type GithubEventScope = { workspaceId: string; registration: string };

export function createGithubEventIngress({
  database,
  workspaceId,
  registration,
  secret,
  isolatedSources,
}: GithubEventScope & {
  database: Database;
  secret: string;
  isolatedSources?: ReadonlySet<string>;
}) {
  const routes = new Hono();
  routes.use(
    "/webhook",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "GitHub event is too large." }, 413),
    }),
  );
  routes.onError((_error, c) =>
    c.json({ error: "GitHub receipt could not be persisted." }, 503),
  );
  routes.post("/webhook", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (
      !secret ||
      !verifyGithubSignature(secret, raw, c.req.header("x-hub-signature-256"))
    )
      return c.json({ error: "Invalid GitHub signature." }, 401);
    const identity = headers.safeParse({
      deliveryId: c.req.header("x-github-delivery"),
      event: c.req.header("x-github-event"),
    });
    if (!identity.success)
      return c.json({ error: "GitHub event identity is required." }, 400);
    const { deliveryId, event } = identity.data;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return c.json({ error: "GitHub event is not valid JSON." }, 400);
    }
    const parsed = envelope.safeParse(value);
    if (!parsed.success)
      return c.json({ error: "Invalid GitHub event envelope." }, 400);
    const { action, installation, repository } = parsed.data;
    const eventType = action ? `${event}.${action}` : event;
    const issue = subject.safeParse(parsed.data.issue);
    const comment = openedComment.safeParse(parsed.data.comment);
    const occurredAt = issue.success
      ? eventType === "issues.opened" && parsed.data.comment === undefined
        ? issue.data.created_at
        : eventType === "issues.closed" && parsed.data.comment === undefined
          ? issue.data.closed_at
          : eventType === "issue_comment.created" && comment.success
            ? comment.data.created_at
            : null
      : null;
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const [inserted] = await database
      .insert(receiptTable)
      .values({
        workspaceId,
        registration,
        deliveryId,
        bodyHash,
        eventType,
        installationId: installation ? String(installation.id) : null,
        repositoryId: repository ? String(repository.id) : null,
        pilotDispatch: !!(
          installation &&
          repository &&
          isolatedSources?.has(`${installation.id}/${repository.id}`)
        ),
        occurredAt: occurredAt ? new Date(occurredAt) : null,
        payload:
          occurredAt && issue.success && repository
            ? {
                repository,
                issue: { id: issue.data.id, number: issue.data.number },
                ...(comment.success
                  ? { comment: { id: comment.data.id } }
                  : {}),
              }
            : {},
      })
      .onConflictDoNothing()
      .returning({ id: receiptTable.id });
    if (inserted)
      return c.json({ receiptId: inserted.id, duplicate: false }, 202);
    const existing = await database
      .select({ id: receiptTable.id, bodyHash: receiptTable.bodyHash })
      .from(receiptTable)
      .where(
        and(
          eq(receiptTable.workspaceId, workspaceId),
          eq(receiptTable.registration, registration),
          or(
            eq(receiptTable.deliveryId, deliveryId),
            eq(receiptTable.bodyHash, bodyHash),
          ),
        ),
      );
    const sameBody = existing.find((row) => row.bodyHash === bodyHash);
    if (!sameBody || existing.length > 1)
      return c.json({ error: "Conflicting GitHub delivery identity." }, 409);
    return c.json({ receiptId: sameBody.id, duplicate: true }, 202);
  });
  return routes;
}
