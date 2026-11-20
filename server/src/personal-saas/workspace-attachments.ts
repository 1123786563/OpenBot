import { and, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { attachments, personalWorkspaces, users } from "../db/schema";
import type { AccountGrant } from "./account-access";
import type { workspaceQuotas } from "./quotas";
import {
  type personalSaasStore,
  type Transaction,
  workspaceConversations,
} from "./store";

const maxUpload = 8 * 1024 * 1024;

export function workspaceAttachmentDrafts(
  tx: Pick<Transaction, "select">,
  workspaceId: string,
) {
  return tx
    .select({
      id: attachments.id,
      conversationId: attachments.channelId,
      name: attachments.name,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.uploadedBy, `personal-workspace:${workspaceId}`),
        isNull(attachments.attachedAt),
      ),
    );
}

export function workspaceAttachmentRoutes({
  quotas,
  getSession,
  withAuthorizedSession,
}: {
  quotas: ReturnType<typeof workspaceQuotas>;
  getSession(
    context: Context,
  ): Promise<{ token: string; grant: AccountGrant } | null>;
  withAuthorizedSession: ReturnType<
    typeof personalSaasStore
  >["withAuthorizedSession"];
}) {
  const app = new Hono();

  async function inWorkspace<T>(
    context: Context,
    operation: (
      tx: Transaction,
      target: { accountId: string; workspaceId: string },
      principal: string,
    ) => Promise<T>,
  ) {
    const session = await getSession(context);
    if (!session) return { kind: "denied" } as const;
    const accountId = session.grant.accountId;
    const result = await withAuthorizedSession(
      session.grant,
      session.token,
      async (tx) => {
        const [workspace] = await tx
          .select({ id: personalWorkspaces.id })
          .from(personalWorkspaces)
          .where(eq(personalWorkspaces.ownerId, accountId));
        if (!workspace) return { kind: "missing" } as const;
        const target = { accountId, workspaceId: workspace.id };
        return {
          kind: "ok",
          value: await operation(
            tx,
            target,
            `personal-workspace:${workspace.id}`,
          ),
        } as const;
      },
    );
    return result.authorized ? result.result : ({ kind: "denied" } as const);
  }

  function browser(context: Context) {
    return (
      !context.req.header("authorization") &&
      context.req.header("accept")?.includes("text/html")
    );
  }

  app.get("/", async (context) => {
    const result = await inWorkspace(context, (tx, target) =>
      workspaceAttachmentDrafts(tx, target.workspaceId),
    );
    if (result.kind === "denied")
      return context.json({ error: "authorization_required" }, 403);
    if (result.kind === "missing") return context.notFound();
    return context.json({ drafts: result.value });
  });

  app.post("/", bodyLimit({ maxSize: maxUpload + 16_384 }), async (context) => {
    const form = await context.req.formData().catch(() => undefined);
    const file = form?.get("file");
    const conversationId = form?.get("conversationId");
    if (
      !(file instanceof File) ||
      !file.size ||
      file.size > maxUpload ||
      file.name.length > 255 ||
      typeof conversationId !== "string" ||
      !conversationId ||
      conversationId.length > 255
    )
      return context.json({ error: "invalid_attachment" }, 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await inWorkspace(context, async (tx, target, principal) => {
      const scope = workspaceConversations(tx, target).as(
        "attachment_conversations",
      );
      const [conversation] = await tx
        .select({ id: scope.id })
        .from(scope)
        .where(eq(scope.id, conversationId));
      if (!conversation) return;
      await quotas.admitStorage(
        tx,
        target.accountId,
        target.workspaceId,
        bytes.length,
      );
      // The attachment foreign key expects a legacy user identity.
      await tx
        .insert(users)
        .values({
          id: principal,
          email: `${target.workspaceId}@workspace.invalid`,
        })
        .onConflictDoNothing({ target: users.id });
      const [stored] = await tx
        .insert(attachments)
        .values({
          channelId: conversation.id,
          uploadedBy: principal,
          name: file.name,
          mimeType: "application/octet-stream",
          sizeBytes: bytes.length,
          bytes,
        })
        .returning({ id: attachments.id });
      return stored;
    });
    if (result.kind === "denied")
      return context.json({ error: "authorization_required" }, 403);
    if (result.kind === "missing" || !result.value) return context.notFound();
    return context.json(result.value, 201);
  });

  app.post("/:id/withdraw", async (context) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.notFound();
    const result = await inWorkspace(
      context,
      async (tx, _target, principal) => {
        const [removed] = await tx
          .delete(attachments)
          .where(
            and(
              eq(attachments.id, id.data),
              eq(attachments.uploadedBy, principal),
              isNull(attachments.attachedAt),
            ),
          )
          .returning({ id: attachments.id });
        return removed;
      },
    );
    if (result.kind === "denied")
      return context.json({ error: "authorization_required" }, 403);
    if (result.kind === "missing" || !result.value) return context.notFound();
    return browser(context)
      ? context.redirect("/workspace", 303)
      : context.body(null, 204);
  });

  return app;
}
