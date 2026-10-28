import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/public";
import {
  type createOpenMuseNotificationStore,
  type OpenMuseNotificationStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseNotification,
} from "./store";

/**
 * `/openmuse-notifications` (mounted under `/api/mobile` by the app seam):
 * the owner's §7 notification feed (T12) — list newest first with readAt,
 * read one, mark one read. Creation is emit-only: the owning transition
 * records the item, this surface never writes one.
 */

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

/*
 * base64url, the repo's rule for anything that rides a query parameter
 * (auth/signed-value.ts spells out why): a standard-base64 cursor can carry
 * `+`, which a form-decoding client turns into a space and this route then
 * refuses as bad. The url-safe decoder still reads the old standard-alphabet
 * cursors, so already-issued ones keep paging.
 */
function encodeCursor(item: StoredOpenMuseNotification): string {
  return Buffer.from(
    JSON.stringify({ c: item.createdAt.toISOString(), i: item.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as {
      c?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.c !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.i.length === 0
    )
      return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** The §7 DTO the client renders; explicit fields, no row internals leak. */
function notificationDto(item: StoredOpenMuseNotification) {
  return {
    id: item.id,
    taskId: item.taskId,
    eventKind: item.eventKind,
    attemptKey: item.attemptKey,
    title: item.title,
    detail: item.detail,
    createdAt: item.createdAt.toISOString(),
    readAt: item.readAt ? item.readAt.toISOString() : null,
  };
}

export function createOpenMuseNotificationRoutes(deps: {
  store:
    | OpenMuseNotificationStore
    | ReturnType<typeof createOpenMuseNotificationStore>;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.get("/", async (context) => {
    const actor = context.var.actor;
    const parsed = listQuery.safeParse(context.req.query());
    if (!parsed.success)
      return context.json({ error: "Bad paging request." }, 400);
    const cursor = parsed.data.cursor
      ? decodeCursor(parsed.data.cursor)
      : undefined;
    if (parsed.data.cursor && !cursor)
      return context.json({ error: "Bad cursor." }, 400);
    try {
      // Clamp rather than refuse: a page-size knob beyond the ceiling still
      // answers, at the ceiling (contract default 25 / max 100).
      const limit = Math.min(parsed.data.limit ?? 25, 100);
      const { notifications } = await deps.store.list(actor.id, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const nextCursor =
        notifications.length === limit
          ? encodeCursor(notifications[notifications.length - 1])
          : undefined;
      return context.json({
        notifications: notifications.map(notificationDto),
        ...(nextCursor ? { nextCursor } : {}),
      });
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/:id", async (context) => {
    try {
      const item = await deps.store.get(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!item)
        return context.json({ error: "There is no such notification." }, 404);
      return context.json(notificationDto(item));
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/read", async (context) => {
    try {
      // Owner-scoped in the store: a foreign item is indistinguishable
      // from a missing one, so the answer is 404 either way.
      const item = await deps.store.markRead(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!item)
        return context.json({ error: "There is no such notification." }, 404);
      // A repeat mark replays the same first instant — idempotent by contract.
      return context.json(notificationDto(item), 200);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  return routes;
}
