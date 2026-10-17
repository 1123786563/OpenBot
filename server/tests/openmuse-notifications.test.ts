import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createOpenMuseNotificationRoutes } from "../src/openmuse-notifications/routes";
import {
  createOpenMuseNotificationStore,
  type OpenMuseNotificationRows,
  type OpenMuseNotificationStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseNotification,
} from "../src/openmuse-notifications/store";

/*
 * T12 (contracts §7): the enumerated events each create exactly ONE
 * user-scoped item keyed userId/taskId/eventKind/attemptKey; per-user readAt
 * persists; a foreign user cannot mark. Emit is exactly-once under its key.
 */

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

let currentActor: AuthenticatedActor = actorOne;
const guardAdmits = true;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  if (!guardAdmits) {
    return context.json({ error: "Sign in first." }, 401);
  }
  context.set("actor", currentActor);
  await next();
};

/**
 * In-memory row seam: same contract as the drizzle rows, rows live as data.
 * The unique key and the set-once readAt are the seam's own semantics, so
 * the store's exactly-once and idempotent-mark contracts are exercised here
 * the way the database's unique index and coalesce enforce them.
 */
function fakeRows(): OpenMuseNotificationRows & {
  notifications: StoredOpenMuseNotification[];
} {
  const notifications: StoredOpenMuseNotification[] = [];
  const disabled = new Set<string>();
  const keyOf = (row: StoredOpenMuseNotification) =>
    `${row.userId}/${row.taskId}/${row.eventKind}/${row.attemptKey}`;
  const newestFirst = (
    a: StoredOpenMuseNotification,
    b: StoredOpenMuseNotification,
  ) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1);
  return {
    notifications,
    insertNotification: async (row) => {
      if (notifications.some((existing) => keyOf(existing) === keyOf(row)))
        return false;
      notifications.push({ ...row });
      return true;
    },
    findNotificationByKey: async (userId, taskId, eventKind, attemptKey) =>
      notifications.find(
        (row) =>
          keyOf(row) === `${userId}/${taskId}/${eventKind}/${attemptKey}`,
      ) ?? null,
    pageByOwner: async (userId, page) =>
      notifications
        .filter((row) => row.userId === userId)
        .filter((row) => {
          if (!page.before) return true;
          const time =
            row.createdAt.getTime() - page.before.createdAt.getTime();
          return time < 0 || (time === 0 && row.id < page.before!.id);
        })
        .sort(newestFirst)
        .slice(0, page.limit),
    listIdsByOwner: async (userId) =>
      notifications.filter((row) => row.userId === userId).map((row) => row.id),
    getNotification: async (id) =>
      notifications.find((row) => row.id === id) ?? null,
    markNotificationRead: async (userId, id, at) => {
      // Owner-scoped in the call, like the drizzle seam's single statement:
      // a foreign row is indistinguishable from a missing one.
      const row = notifications.find(
        (candidate) => candidate.id === id && candidate.userId === userId,
      );
      if (row === undefined) return null;
      // Set once, like the database's coalesce: a repeat keeps the instant.
      if (row.readAt === null) row.readAt = at;
      return { ...row };
    },
    ownerDisabled: async (userId) => disabled.has(userId),
    disableOwner: async (userId) => {
      disabled.add(userId);
    },
    restoreOwner: async (userId) => {
      disabled.delete(userId);
    },
  };
}

type Fixture = {
  store: OpenMuseNotificationStore;
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixture(): Fixture {
  const rows = fakeRows();
  // A strictly-advancing clock: emits land in distinct instants, so the
  // newest-first order never leans on the id tiebreak.
  let tick = 0;
  const store = createOpenMuseNotificationStore({
    rows,
    now: () => new Date(1_700_000_000_000 + tick++ * 1_000),
  });
  const app = createOpenMuseNotificationRoutes({ store, requireUser });
  return { store, rows, app };
}

/**
 * A row the store never emitted, planted straight into the seam so the id
 * (and therefore the cursor's bytes) is chosen, not random: `~~` in the id
 * is the one ASCII shape whose standard-base64 cursor emits `+`, the char a
 * form-decoding client turns into a space.
 */
function seededNotification(
  rows: ReturnType<typeof fakeRows>,
  id: string,
  createdAt: Date,
): StoredOpenMuseNotification {
  const row: StoredOpenMuseNotification = {
    id,
    userId: "user-1",
    taskId: `task-${id}`,
    eventKind: "task.succeeded",
    attemptKey: "seed",
    title: "Seeded",
    detail: null,
    createdAt,
    readAt: null,
  };
  rows.notifications.push(row);
  return row;
}

describe("emit (T12)", () => {
  test("creates exactly one item keyed userId/taskId/eventKind/attemptKey; a duplicate key creates no second row", async () => {
    const { store, rows } = fixture();
    const first = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
      detail: "Done.",
    });
    expect(first.created).toBe(true);
    expect(first.notification).toMatchObject({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      readAt: null,
    });
    // The same key again: the stored item answers, created=false.
    const second = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
      detail: "Done.",
    });
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(rows.notifications).toHaveLength(1);
  });

  test("every enumerated event kind keys independently; each user's items are their own", async () => {
    const { store, rows } = fixture();
    for (const eventKind of [
      "task.succeeded",
      "task.failed",
      "task.waiting_input",
      "monitor.matched",
    ] as const) {
      await store.emit({
        userId: "user-1",
        taskId: "task-1",
        eventKind,
        attemptKey: "1",
        title: "t",
      });
    }
    expect(rows.notifications).toHaveLength(4);
    // The same event for another user is their own item.
    await store.emit({
      userId: "user-2",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "t",
    });
    expect(rows.notifications).toHaveLength(5);
  });

  test("D02's deletion-fence bypass lands a task.cancelled notice for a fenced owner — the fence otherwise refuses", async () => {
    const { store } = fixture();
    await store.disableOwner("user-1");
    // Without the bypass, a fenced owner gets no new notifications — the
    // fence's own contract (pinned by the §9 lifecycle suite below).
    await expect(
      store.emit({
        userId: "user-1",
        taskId: "task-a",
        eventKind: "task.cancelled",
        attemptKey: "shutdown",
        title: "Task cancelled",
      }),
    ).rejects.toThrow(/disabled/);
    // The work shutdown's notice is the one deliberate exception: its owner
    // is fenced by the time it fires, so the bypass is the only way the
    // promised notice lands at all.
    const landed = await store.emit({
      userId: "user-1",
      taskId: "task-a",
      eventKind: "task.cancelled",
      attemptKey: "shutdown",
      title: "Task cancelled",
      detail: "Cancelled by account deletion.",
      bypassDeletionFence: true,
    });
    expect(landed.created).toBe(true);
    expect(landed.notification).toMatchObject({
      eventKind: "task.cancelled",
      attemptKey: "shutdown",
    });
  });
});

describe("list and read (T12)", () => {
  test("list is owner-scoped, newest first, with readAt; a foreign owner sees none", async () => {
    const { store } = fixture();
    await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    await store.emit({
      userId: "user-1",
      taskId: "task-2",
      eventKind: "monitor.matched",
      attemptKey: "hash-b",
      title: "Monitor matched",
    });
    await store.emit({
      userId: "user-2",
      taskId: "task-3",
      eventKind: "task.failed",
      attemptKey: "1",
      title: "Task failed",
    });
    const { notifications } = await store.list("user-1", { limit: 25 });
    expect(notifications.map((row) => row.taskId)).toEqual([
      "task-2",
      "task-1",
    ]);
    expect(notifications.every((row) => row.readAt === null)).toBe(true);
    const foreign = await store.list("user-2", { limit: 25 });
    expect(foreign.notifications.map((row) => row.taskId)).toEqual(["task-3"]);
  });

  test("markRead sets readAt once; a repeat is idempotent; a foreign item is not there", async () => {
    const { store } = fixture();
    const { notification } = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.waiting_input",
      attemptKey: "1",
      title: "Task needs your answer",
    });
    const read = await store.markRead("user-1", notification.id);
    expect(read?.readAt).toBeInstanceOf(Date);
    const again = await store.markRead("user-1", notification.id);
    expect(again?.readAt?.getTime()).toBe(read?.readAt?.getTime());
    // A foreign user's mark is indistinguishable from a missing item.
    expect(await store.markRead("user-2", notification.id)).toBeNull();
  });

  test("markRead stamps readAt with the same clock createdAt uses — one time source, never readAt before createdAt", async () => {
    const fixed = new Date("2026-10-13T00:00:00Z");
    const rows = fakeRows();
    const store = createOpenMuseNotificationStore({
      rows,
      now: () => fixed,
    });
    const { notification } = await store.emit({
      userId: "user-1",
      taskId: "task-clock",
      eventKind: "task.failed",
      attemptKey: "1",
      title: "Task failed",
    });
    expect(notification.createdAt.toISOString()).toBe(fixed.toISOString());
    const read = await store.markRead("user-1", notification.id);
    expect(read?.readAt?.toISOString()).toBe(fixed.toISOString());
  });
});

describe("routes (T12)", () => {
  test("GET / lists the owner's items newest first as DTOs; GET /:id answers one; a foreign id is 404", async () => {
    const { store, app } = fixture();
    await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
      detail: "Done.",
    });
    await store.emit({
      userId: "user-2",
      taskId: "task-2",
      eventKind: "task.failed",
      attemptKey: "1",
      title: "Task failed",
    });
    currentActor = actorOne;
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
      detail: "Done.",
      readAt: null,
    });
    expect(body.notifications[0].id).toBeTruthy();
    expect(body.notifications[0].createdAt).toBeTruthy();

    const one = await app.request(`/${body.notifications[0].id}`);
    expect(one.status).toBe(200);

    const foreignId = (await store.list("user-2", { limit: 25 }))
      .notifications[0].id;
    expect((await app.request(`/${foreignId}`)).status).toBe(404);
  });

  test("POST /:id/read marks the owner's item once, replays the same readAt; a foreign item is 404", async () => {
    const { store, app } = fixture();
    const { notification } = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "monitor.matched",
      attemptKey: "hash-a",
      title: "Monitor matched",
    });
    currentActor = actorOne;
    const read = await app.request(`/${notification.id}/read`, {
      method: "POST",
    });
    expect(read.status).toBe(200);
    const firstBody = (await read.json()) as { readAt: string };
    expect(firstBody.readAt).toBeTruthy();
    const repeat = await app.request(`/${notification.id}/read`, {
      method: "POST",
    });
    expect(repeat.status).toBe(200);
    const secondBody = (await repeat.json()) as { readAt: string };
    expect(secondBody.readAt).toBe(firstBody.readAt);

    currentActor = actorTwo;
    const foreign = await app.request(`/${notification.id}/read`, {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
  });
});

describe("§9 lifecycle hooks (T12)", () => {
  test("a disabled owner is refused; enumerateOwner lists the owner's items; restore lifts the fence", async () => {
    const { store } = fixture();
    const { notification } = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    await store.disableOwner("user-1");
    await expect(store.list("user-1", { limit: 25 })).rejects.toBeInstanceOf(
      OpenMuseOwnerDisabledError,
    );
    await expect(
      store.markRead("user-1", notification.id),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);
    // get is a read path like list: the disabled owner's single read is the
    // same 403 the list already answers, never a silent peek.
    await expect(store.get("user-1", notification.id)).rejects.toBeInstanceOf(
      OpenMuseOwnerDisabledError,
    );
    expect(await store.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-notification", id: notification.id },
    ]);
    await store.restoreOwner("user-1");
    const { notifications } = await store.list("user-1", { limit: 25 });
    expect(notifications).toHaveLength(1);
  });

  test("a disabled owner's GET /:id answers 403, not 404 or 500", async () => {
    const { store, app } = fixture();
    const { notification } = await store.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    await store.disableOwner("user-1");
    currentActor = actorOne;
    expect((await app.request(`/${notification.id}`)).status).toBe(403);
  });
});

describe("cursor pagination (T12 §7)", () => {
  test("issued cursors are URL-safe base64url: no + / = rides the query string, and the walk repeats nothing", async () => {
    const { rows, app } = fixture();
    const base = 1_700_100_000_000;
    // Three rows over two pages; the newest id contains `~~`, the shape
    // whose STANDARD-base64 cursor emits `+` (uuid-shaped ids never do —
    // verified by sampling), so this row is the regression probe.
    seededNotification(rows, "openmuse-notification-~~probe", new Date(base));
    seededNotification(
      rows,
      "openmuse-notification-mid",
      new Date(base - 1_000),
    );
    seededNotification(
      rows,
      "openmuse-notification-old",
      new Date(base - 2_000),
    );
    currentActor = actorOne;

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await app.request(
        cursor ? `/?limit=1&cursor=${cursor}` : "/?limit=1",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        notifications: Array<{ id: string }>;
        nextCursor?: string;
      };
      if (body.nextCursor !== undefined) {
        expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      }
      seen.push(...body.notifications.map((row) => row.id));
      cursor = body.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      "openmuse-notification-~~probe",
      "openmuse-notification-mid",
      "openmuse-notification-old",
    ]);
  });

  test("a cursor issued under the old standard base64 (no + or /) still pages: the url-safe decoder reads both alphabets", async () => {
    const { rows, app } = fixture();
    const newest = seededNotification(
      rows,
      "openmuse-notification-newest",
      new Date(1_700_200_000_000),
    );
    seededNotification(
      rows,
      "openmuse-notification-oldest",
      new Date(1_700_200_000_000 - 1_000),
    );
    const legacy = Buffer.from(
      JSON.stringify({ c: newest.createdAt.toISOString(), i: newest.id }),
      "utf8",
    ).toString("base64");
    expect(legacy).not.toMatch(/[+/]/); // the legacy shape this covers
    currentActor = actorOne;
    const response = await app.request(`/?limit=1&cursor=${legacy}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      notifications: Array<{ id: string }>;
    };
    expect(body.notifications.map((row) => row.id)).toEqual([
      "openmuse-notification-oldest",
    ]);
  });
});
