import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type OpenMuseNotificationRow,
  openmuseNotifications,
} from "../db/schema/openmuse";
import {
  createOwnerDisabled,
  OpenMuseOwnerDisabledError,
} from "../openmuse-personal/shared";

export { OpenMuseOwnerDisabledError };

/**
 * OpenMuse Task notifications (T12, contracts §7): each enumerated event —
 * task.succeeded, task.failed, task.waiting_input, task.waiting_review,
 * monitor.matched — creates exactly ONE user-scoped item keyed
 * userId/taskId/eventKind/attemptKey; per-user readAt persists; a foreign
 * user cannot mark. Events arrive through `emit` from the owning transition
 * (the task runner's settles and the monitor's matched check), never by
 * polling: this module records, it never infers.
 */

/**
 * The §7 enumerated events. `task.waiting_review` is defined so the
 * enumeration is whole, but NO producer emits it yet — T16 (review waits)
 * owns its first emission; the runner's emit type excludes it until then.
 * `task.cancelled` is D02's: the work shutdown's per-Task cancellation notice,
 * emitted through the deletion-fence bypass below (its owner is fenced by the
 * time it fires — the bypass is what makes the notice land at all).
 */
export type OpenMuseNotificationEvent =
  | "task.succeeded"
  | "task.failed"
  | "task.waiting_input"
  | "task.waiting_review"
  | "task.cancelled"
  | "monitor.matched";

/** T16's reserved event, recorded here as its future producer's contract. */
export const TASK_WAITING_REVIEW_EVENT = "task.waiting_review" as const;

export type StoredOpenMuseNotification = {
  id: string;
  userId: string;
  taskId: string;
  eventKind: OpenMuseNotificationEvent;
  attemptKey: string;
  title: string;
  detail: string | null;
  createdAt: Date;
  readAt: Date | null;
};

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseNotificationRows = {
  /** False means the unique key already exists — the item is exactly-once. */
  insertNotification(row: StoredOpenMuseNotification): Promise<boolean>;
  findNotificationByKey(
    userId: string,
    taskId: string,
    eventKind: OpenMuseNotificationEvent,
    attemptKey: string,
  ): Promise<StoredOpenMuseNotification | null>;
  pageByOwner(
    userId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredOpenMuseNotification[]>;
  listIdsByOwner(userId: string): Promise<string[]>;
  getNotification(id: string): Promise<StoredOpenMuseNotification | null>;
  /**
   * Sets readAt once (coalesce with the store's own clock, so readAt and
   * createdAt share one time source), owner-scoped in the statement: null
   * means no such owned row — a foreign one is indistinguishable.
   */
  markNotificationRead(
    userId: string,
    id: string,
    at: Date,
  ): Promise<StoredOpenMuseNotification | null>;
  /**
   * D08 (§9): hard-delete the owner's rows for the manifest's ids — one
   * statement, so a batch is atomic. Owner-scoped: a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteNotifications(userId: string, ids: string[]): Promise<void>;
  ownerDisabled(userId: string): Promise<boolean>;
  disableOwner(userId: string): Promise<void>;
  restoreOwner(userId: string): Promise<void>;
};

export type OpenMuseNotificationStore = {
  /**
   * Record one event: the first call for a key creates the item, a repeat
   * answers the stored one with created=false — one item per key, ever.
   */
  emit(input: {
    userId: string;
    taskId: string;
    eventKind: OpenMuseNotificationEvent;
    attemptKey: string;
    title: string;
    detail?: string;
    /**
     * D02's §9 bypass, explicit and narrow: the work shutdown's cancellation
     * notices fire for an owner whose deletion marker is already on, by design
     * — without this flag those emits would always throw the fence's error and
     * the notice the shutdown promises could never land. Every other caller
     * keeps the fence: a deleted account gets no new notifications.
     */
    bypassDeletionFence?: boolean;
  }): Promise<{
    notification: StoredOpenMuseNotification;
    created: boolean;
  }>;
  /** The owner's items, newest first, with their readAt. */
  list(
    userId: string,
    page: { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<{ notifications: StoredOpenMuseNotification[] }>;
  /** One owned item; a foreign or missing one is null, like markRead. */
  get(userId: string, id: string): Promise<StoredOpenMuseNotification | null>;
  /**
   * Mark one item read, owner-scoped: a foreign or missing item is null (a
   * 404 at the route), a repeat keeps the first instant (idempotent).
   */
  markRead(
    userId: string,
    id: string,
  ): Promise<StoredOpenMuseNotification | null>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteNotifications`, owner-scoped and idempotent.
   */
  hardDelete(userId: string, ids: string[]): Promise<void>;
  /** §9 lifecycle hook: refuse work for a disabled owner. */
  disableOwner(userId: string): Promise<void>;
  restoreOwner(userId: string): Promise<void>;
  enumerateOwner(
    userId: string,
  ): Promise<Array<{ kind: "openmuse-notification"; id: string }>>;
};

function newId(): string {
  return `openmuse-notification-${crypto.randomUUID()}`;
}

export function createOpenMuseNotificationStore(deps: {
  rows: OpenMuseNotificationRows;
  now?: () => Date;
}): OpenMuseNotificationStore {
  const now = deps.now ?? (() => new Date());
  return {
    async emit(input) {
      if (
        !input.bypassDeletionFence &&
        (await deps.rows.ownerDisabled(input.userId))
      )
        throw new OpenMuseOwnerDisabledError(input.userId);
      const notification: StoredOpenMuseNotification = {
        id: newId(),
        userId: input.userId,
        taskId: input.taskId,
        eventKind: input.eventKind,
        attemptKey: input.attemptKey,
        title: input.title,
        detail: input.detail ?? null,
        createdAt: now(),
        readAt: null,
      };
      const created = await deps.rows.insertNotification(notification);
      if (created) return { notification, created: true };
      // The key's item already exists: answer it, never a second row.
      const stored = await deps.rows.findNotificationByKey(
        input.userId,
        input.taskId,
        input.eventKind,
        input.attemptKey,
      );
      // A row seam that lost the race without the row being readable is a
      // broken seam; refusing loudly beats a made-up item.
      if (stored === null)
        throw new Error("The notification's key is taken but unreadable.");
      return { notification: stored, created: false };
    },
    async list(userId, page) {
      if (await deps.rows.ownerDisabled(userId))
        throw new OpenMuseOwnerDisabledError(userId);
      const notifications = await deps.rows.pageByOwner(userId, {
        limit: page.limit,
        ...(page.cursor ? { before: page.cursor } : {}),
      });
      return { notifications };
    },
    async get(userId, id) {
      // The same fence list and markRead answer: a single read is not a
      // seam a disabled owner keeps.
      if (await deps.rows.ownerDisabled(userId))
        throw new OpenMuseOwnerDisabledError(userId);
      const current = await deps.rows.getNotification(id);
      return current && current.userId === userId ? current : null;
    },
    async markRead(userId, id) {
      if (await deps.rows.ownerDisabled(userId))
        throw new OpenMuseOwnerDisabledError(userId);
      // Owner-scoped in the statement (a foreign row is indistinguishable
      // from a missing one) and stamped with the same injectable clock
      // createdAt uses, so readAt never precedes createdAt.
      return deps.rows.markNotificationRead(userId, id, now());
    },
    disableOwner: (userId) => deps.rows.disableOwner(userId),
    restoreOwner: (userId) => deps.rows.restoreOwner(userId),
    hardDelete: (userId, ids) => deps.rows.hardDeleteNotifications(userId, ids),
    async enumerateOwner(userId) {
      return (await deps.rows.listIdsByOwner(userId)).map((id) => ({
        kind: "openmuse-notification" as const,
        id,
      }));
    },
  };
}

function rowToNotification(
  row: OpenMuseNotificationRow,
): StoredOpenMuseNotification {
  return {
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    eventKind: row.eventKind,
    attemptKey: row.attemptKey,
    title: row.title,
    detail: row.detail,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

/** The drizzle-backed row seam. */
export function createOpenMuseNotificationRows(
  database: Database,
): OpenMuseNotificationRows {
  const ownerDisabledRow = createOwnerDisabled(database);
  return {
    async insertNotification(row) {
      const inserted = await database
        .insert(openmuseNotifications)
        .values({
          id: row.id,
          userId: row.userId,
          taskId: row.taskId,
          eventKind: row.eventKind,
          attemptKey: row.attemptKey,
          title: row.title,
          detail: row.detail,
          createdAt: row.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: openmuseNotifications.id });
      return inserted.length > 0;
    },
    async findNotificationByKey(userId, taskId, eventKind, attemptKey) {
      const [row] = await database
        .select()
        .from(openmuseNotifications)
        .where(
          and(
            eq(openmuseNotifications.userId, userId),
            eq(openmuseNotifications.taskId, taskId),
            eq(openmuseNotifications.eventKind, eventKind),
            eq(openmuseNotifications.attemptKey, attemptKey),
          ),
        )
        .limit(1);
      return row ? rowToNotification(row) : null;
    },
    async pageByOwner(userId, page) {
      const below = page.before
        ? or(
            lt(openmuseNotifications.createdAt, page.before.createdAt),
            and(
              eq(openmuseNotifications.createdAt, page.before.createdAt),
              lt(openmuseNotifications.id, page.before.id),
            ),
          )
        : undefined;
      const rows = await database
        .select()
        .from(openmuseNotifications)
        .where(
          and(
            eq(openmuseNotifications.userId, userId),
            ...(below ? [below] : []),
          ),
        )
        .orderBy(
          desc(openmuseNotifications.createdAt),
          desc(openmuseNotifications.id),
        )
        .limit(page.limit);
      return rows.map(rowToNotification);
    },
    async listIdsByOwner(userId) {
      const rows = await database
        .select({ id: openmuseNotifications.id })
        .from(openmuseNotifications)
        .where(eq(openmuseNotifications.userId, userId));
      return rows.map((row) => row.id);
    },
    async getNotification(id) {
      const [row] = await database
        .select()
        .from(openmuseNotifications)
        .where(eq(openmuseNotifications.id, id))
        .limit(1);
      return row ? rowToNotification(row) : null;
    },
    async markNotificationRead(userId, id, at) {
      // Set once: coalesce keeps the first instant across repeat marks, and
      // the caller's clock (the store's injectable now) keeps readAt and
      // createdAt on one time source.
      const [row] = await database
        .update(openmuseNotifications)
        .set({
          readAt: sql`coalesce(${openmuseNotifications.readAt}, ${at})`,
        })
        .where(
          and(
            eq(openmuseNotifications.id, id),
            eq(openmuseNotifications.userId, userId),
          ),
        )
        .returning();
      return row ? rowToNotification(row) : null;
    },
    async hardDeleteNotifications(userId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseNotifications)
        .where(
          and(
            eq(openmuseNotifications.userId, userId),
            inArray(openmuseNotifications.id, ids),
          ),
        );
    },
    /*
     * D01's marker is the deleted-owner fence — the same read the /api/mobile
     * fence and the tasks rows make, phase-aware the same way: the owner is
     * disabled while the marker is still `fenced`, and D05's restore lifts
     * it. This covers the runner's emit path too, which never crosses the
     * HTTP fence.
     */
    ownerDisabled: ownerDisabledRow,
    async disableOwner() {},
    async restoreOwner() {},
  };
}
