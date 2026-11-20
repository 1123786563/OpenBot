import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "../../db/client";
import { githubPilotEventReceipts } from "../../db/schema/corsair";
import { verifyGithubSignature } from "../../responsibilities/signatures";
import type { CorsairEventOperations } from "./event-operations";
import type { EventTransaction } from "./event-triggers";
import { githubId } from "./github";
import { githubEventSubject } from "./github-event-subject";

const receiptTable = githubPilotEventReceipts;
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
  operations,
  planAccepted,
}: GithubEventScope & {
  database: Database;
  secret: string;
  isolatedSources?: ReadonlySet<string>;
  operations?: CorsairEventOperations;
  planAccepted?: (tx: EventTransaction, receiptId: string) => Promise<void>;
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
    const { issue, comment, occurredAt } = githubEventSubject(
      eventType,
      parsed.data,
    );
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    const [inserted] = await database.transaction(async (tx) => {
      const isolated = !!(
        installation &&
        repository &&
        isolatedSources?.has(`${installation.id}/${repository.id}`)
      );
      const owner =
        operations && repository
          ? await operations.nativeOwner(
              tx,
              { provider: "github", source: String(repository.id) },
              occurredAt,
              bodyHash,
            )
          : "legacy";
      const inserted = await tx
        .insert(receiptTable)
        .values({
          workspaceId,
          registration,
          deliveryId,
          bodyHash,
          eventType,
          installationId: installation ? String(installation.id) : null,
          repositoryId: repository ? String(repository.id) : null,
          pilotDispatch: isolated || owner === "corsair",
          occurredAt,
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
      if (inserted[0]) {
        await operations?.captureEvidence(
          tx,
          "github",
          deliveryId,
          inserted[0].id,
          raw,
        );
        await planAccepted?.(tx, inserted[0].id);
      }
      return inserted;
    });
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
