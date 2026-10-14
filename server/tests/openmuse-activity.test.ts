import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Hono, MiddlewareHandler } from "hono";
import {
  ApprovalNotFoundError,
  type ApprovalRecord,
  ApprovalRefusedError,
} from "../src/approvals/types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createActivityFeed } from "../src/openmuse-activity/feed";
import { createOpenMuseActivityRoutes } from "../src/openmuse-activity/routes";
import {
  createOpenMuseNotificationStore,
  type OpenMuseNotificationRows,
  type OpenMuseNotificationStore,
  type StoredOpenMuseNotification,
} from "../src/openmuse-notifications/store";
import type { ReviewedActionExecutor } from "../src/openmuse-reviewed-actions/executor";
import type { ReviewedActionProposal } from "../src/openmuse-reviewed-actions/proposal";
import { REVIEWED_ACTION_TTL_MS } from "../src/openmuse-reviewed-actions/proposal";
import {
  createOpenMuseReviewedActionService,
  type OpenMuseReviewedActionService,
} from "../src/openmuse-reviewed-actions/service";
import {
  createOpenMuseActivityReviewedLister,
  OpenMuseOwnerDisabledError,
  type ReviewedActionRows,
  type StoredReviewedAction,
  type StoredReviewedAttempt,
} from "../src/openmuse-reviewed-actions/store";
import { createDatabase } from "../src/db/client";
import { openmuseReviewedActions } from "../src/db/schema/openmuse";
import { like } from "drizzle-orm";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

/** §8's operator seat: an admin reading their own feed sees the reconcile marker. */
const actorAdmin: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

/** A second owner: V02 proves the notification half of the feed is owner-bound too. */
const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

let currentActor: AuthenticatedActor = actorOne;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

/** The reviewed module's own in-memory row seam (the sibling test's fake). */
function fakeRows(): ReviewedActionRows & {
  actions: StoredReviewedAction[];
  attempts: StoredReviewedAttempt[];
} {
  const actions: StoredReviewedAction[] = [];
  const attempts: StoredReviewedAttempt[] = [];
  const disabled = new Set<string>();
  return {
    actions,
    attempts,
    insertAction: async (action) => {
      actions.push({
        ...action,
        attachmentVersionIds: [...action.attachmentVersionIds],
      });
    },
    getAction: async (id) => actions.find((row) => row.id === id) ?? null,
    listByOwner: async (ownerUserId, { limit, before }) =>
      actions
        .filter((row) => row.ownerUserId === ownerUserId)
        .filter((row) =>
          before
            ? row.createdAt < before.createdAt ||
              (row.createdAt.getTime() === before.createdAt.getTime() &&
                row.id < before.id)
            : true,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id > b.id ? -1 : 1),
        )
        .slice(0, limit),
    findSettledSameSend: async (ownerUserId, kind, payloadHash) =>
      actions
        .filter(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.kind === kind &&
            row.payloadHash === payloadHash &&
            (row.status === "executing" ||
              row.status === "outcome_unknown" ||
              row.status === "succeeded"),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ??
      null,
    resetStaleExecuting: async (cutoff) => {
      const recovered: string[] = [];
      for (const row of actions) {
        if (
          row.status !== "executing" ||
          row.decidedAt === null ||
          row.decidedAt >= cutoff
        )
          continue;
        row.status = "outcome_unknown";
        recovered.push(row.id);
      }
      return recovered;
    },
    claimTransition: async (id, from, to, patch) => {
      const row = actions.find((candidate) => candidate.id === id);
      if (!row || row.status !== from) return null;
      row.status = to;
      if (patch?.decidedAt !== undefined) row.decidedAt = patch.decidedAt;
      if (patch?.completedAt !== undefined) row.completedAt = patch.completedAt;
      if (patch?.providerRef !== undefined) row.providerRef = patch.providerRef;
      if (patch?.error !== undefined) row.error = patch.error;
      return { ...row };
    },
    insertAttempt: async (attempt) => {
      attempts.push({ ...attempt });
    },
    latestAttempt: async (actionId) =>
      attempts.find((attempt) => attempt.actionId === actionId) ?? null,
    updateAttempt: async (attemptId, patch) => {
      const attempt = attempts.find((row) => row.attemptId === attemptId);
      if (!attempt) return null;
      if (patch.fingerprint !== undefined)
        attempt.fingerprint = patch.fingerprint;
      if (patch.outcome !== undefined) attempt.outcome = patch.outcome;
      if (patch.providerRef !== undefined)
        attempt.providerRef = patch.providerRef;
      if (patch.completedAt !== undefined)
        attempt.completedAt = patch.completedAt;
      if (patch.reconciliation !== undefined)
        attempt.reconciliation = patch.reconciliation;
      return { ...attempt };
    },
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    listIdsByOwner: async (ownerUserId) =>
      actions
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
  };
}

function fakeExecutor() {
  const calls: ReviewedActionProposal[] = [];
  let planned: Array<"succeeded" | "failed" | "outcome_unknown"> = [];
  const executor: ReviewedActionExecutor = {
    execute: async (proposal) => {
      calls.push(proposal);
      const outcome = planned.shift() ?? "succeeded";
      return {
        outcome,
        ...(outcome === "succeeded"
          ? { providerRef: `fake-ref-${calls.length}` }
          : {}),
        ...(outcome === "failed" ? { error: "the fake executor refused" } : {}),
        ...(outcome === "outcome_unknown"
          ? { error: "the provider call timed out" }
          : {}),
        fingerprint: "ab".repeat(32),
      };
    },
  };
  return {
    executor,
    calls,
    plan: (...outcomes: Array<"succeeded" | "failed" | "outcome_unknown">) => {
      planned = [...outcomes];
    },
  };
}

/**
 * The approvals seam Task 0 cites: `inbox().requests` for the read (what
 * mobile-bff/activity.ts consumes), `store.get` for §8's pre-decision
 * re-read, and `decide` — the owning module's decision path — for dispatch.
 * The fake counts decisions so the dispatch tests prove routing, not a
 * second implementation.
 */
function fakeApprovals() {
  const records: ApprovalRecord[] = [];
  const decisions: Array<{
    ownerUserId: string;
    id: string;
    decision: "allow_once" | "deny";
  }> = [];
  const find = (ownerUserId: string, id: string) =>
    records.find(
      (record) => record.id === id && record.ownerUserId === ownerUserId,
    );
  return {
    records,
    decisions,
    async open(ownerUserId: string, createdAt: Date): Promise<ApprovalRecord> {
      const record: ApprovalRecord = {
        id: `approval-${records.length + 1}`,
        ownerUserId,
        action: {
          actorId: ownerUserId,
          botId: "bot-1",
          toolRef: "mcp/gmail/send",
          effect: "write",
          scope: "gmail",
          args: { subject: "Lunch" },
          runId: "run-1",
          threadId: "thread-1",
          toolCallId: `call-${records.length + 1}`,
          actionDigest: `digest-${records.length + 1}`,
          policy: {
            behaviour: "ask",
            source: "default",
            reason: "Asks before changes.",
          },
        },
        status: "pending",
        decision: null,
        result: null,
        createdAt,
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      records.push(record);
      return record;
    },
    seam: {
      inbox: async (ownerUserId: string) => ({
        requests: records.filter(
          (record) => record.ownerUserId === ownerUserId,
        ),
      }),
      decide: async (
        ownerUserId: string,
        id: string,
        decision: "allow_once" | "deny",
      ) => {
        decisions.push({ ownerUserId, id, decision });
        const record = find(ownerUserId, id);
        if (!record) throw new ApprovalNotFoundError();
        if (record.status !== "pending")
          throw new ApprovalRefusedError("This request was already decided.");
        record.status = decision === "deny" ? "denied" : "approved";
        record.decision = decision;
        record.decidedAt = new Date();
        return record;
      },
      store: {
        get: async (ownerUserId: string, id: string) => {
          const record = find(ownerUserId, id);
          if (!record) throw new ApprovalNotFoundError();
          return record;
        },
      },
    },
  };
}

/**
 * The one store addition's contract, faked the house way (mirrors the
 * deployment lister): awaiting/outcome rows only, behind the §9 fence.
 */
function fakeReviewedLister(rows: ReturnType<typeof fakeRows>) {
  return async (
    ownerUserId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredReviewedAction[]> => {
    if (await rows.ownerDisabled(ownerUserId))
      throw new OpenMuseOwnerDisabledError();
    return (await rows.listByOwner(ownerUserId, page)).filter(
      (action) =>
        action.status === "awaiting_review" ||
        action.status === "outcome_unknown",
    );
  };
}

/**
 * The notifications module's own in-memory row seam (the sibling test's
 * fake): the feed's union read and its mark dispatch run against the store's
 * REAL code — the fake only supplies rows, so the exactly-once emit and the
 * set-once read mark are never re-implemented here.
 */
function fakeNotificationRows(): OpenMuseNotificationRows & {
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

let nowMs = Date.parse("2026-10-13T10:00:00.000Z");

type Fixture = {
  rows: ReturnType<typeof fakeRows>;
  executor: ReturnType<typeof fakeExecutor>;
  reviewed: OpenMuseReviewedActionService;
  approvals: ReturnType<typeof fakeApprovals>;
  notifications: OpenMuseNotificationStore;
  notificationRows: ReturnType<typeof fakeNotificationRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(): Fixture {
  const rows = fakeRows();
  const executor = fakeExecutor();
  const reviewed = createOpenMuseReviewedActionService({
    rows,
    executor: executor.executor,
    now: () => new Date(nowMs),
  });
  const approvals = fakeApprovals();
  const notificationRows = fakeNotificationRows();
  const notifications = createOpenMuseNotificationStore({
    rows: notificationRows,
    now: () => new Date(nowMs),
  });
  const feed = createActivityFeed({
    approvals: approvals.seam,
    reviewed,
    listReviewed: fakeReviewedLister(rows),
    notifications,
  });
  const app = createOpenMuseActivityRoutes({ feed, requireUser });
  return {
    rows,
    executor,
    reviewed,
    approvals,
    notifications,
    notificationRows,
    app,
  };
}

const mailPayload = {
  body: "See you at ten.",
  subject: "Lunch",
  to: ["ava@example.com"],
};

async function propose(
  reviewed: OpenMuseReviewedActionService,
  ownerUserId: string,
): Promise<StoredReviewedAction> {
  return await reviewed.propose(ownerUserId, {
    kind: "mail",
    payload: mailPayload,
    accountEmail: "owner@example.com",
    connectionGeneration: 2,
  });
}

function decision(
  app: Hono<{ Variables: AppVariables }>,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/mobile/openmuse-activity", () => {
  test("mixed feed: §8 DTO, newest first, per-type allowedActions", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1"); // 10:00
    await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:02:00.000Z")),
    );

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();

    const [policy, action] = body.items;
    expect(policy).toEqual({
      id: "policy_approval:approval-1",
      type: "policy_approval",
      sourceId: "approval-1",
      createdAt: "2026-10-13T10:02:00.000Z",
      status: "pending",
      title: "mcp/gmail/send",
      detail: "Asks before changes.",
      allowedActions: ["approve", "deny"],
      readAt: null,
    });
    expect(action).toEqual({
      id: `reviewed_action:${reviewed.id}`,
      type: "reviewed_action",
      sourceId: reviewed.id,
      createdAt: new Date(nowMs).toISOString(),
      status: "awaiting_review",
      title: "mail",
      detail: "owner@example.com",
      allowedActions: ["approve", "deny"],
      readAt: null,
    });
  });

  test("three-type merged feed: a task_notification joins in §8 order with its own DTO", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1"); // 10:00
    nowMs += 60_000; // 10:01
    const { notification } = await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
      detail: "The draft is sent.",
    });
    await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:02:00.000Z")),
    );

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item: { type: string }) => item.type)).toEqual([
      "policy_approval",
      "task_notification",
      "reviewed_action",
    ]);
    // §8's task_notification row: its own status vocabulary (read/unread),
    // mark_read alone, and its own read mark — no other type's verbs.
    expect(body.items[1]).toEqual({
      id: `task_notification:${notification.id}`,
      type: "task_notification",
      sourceId: notification.id,
      createdAt: "2026-10-13T10:01:00.000Z",
      status: "unread",
      title: "Task succeeded",
      detail: "The draft is sent.",
      allowedActions: ["mark_read"],
      readAt: null,
    });
    expect(body.items[0].id).toBe("policy_approval:approval-1");
    expect(body.items[2].id).toBe(`reviewed_action:${reviewed.id}`);
  });

  test("cursor discipline across the three-type union: default 25, boundary walk, 101 clamps, abc 400s", async () => {
    const fixture = fixtureFor();
    await propose(fixture.reviewed, "user-1"); // 10:00
    for (let index = 0; index < 26; index += 1) {
      nowMs += 60_000; // 10:01 .. 10:26
      await fixture.notifications.emit({
        userId: "user-1",
        taskId: `task-${index + 1}`,
        eventKind: "task.succeeded",
        attemptKey: "1",
        title: "Task succeeded",
      });
    }
    await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:40:00.000Z")),
    );

    const first = await fixture.app.request("/");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.items).toHaveLength(25);
    // The page boundary lands on a task_notification row: the cursor is
    // minted on one type and continues the walk across the others.
    expect(firstBody.items[24].type).toBe("task_notification");
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await fixture.app.request(
      `/?cursor=${firstBody.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.items).toHaveLength(3);
    expect(secondBody.nextCursor).toBeNull();
    const every = [...firstBody.items, ...secondBody.items];
    expect(every).toHaveLength(28);
    for (let index = 1; index < every.length; index += 1) {
      expect(every[index - 1].createdAt >= every[index].createdAt).toBe(true);
    }

    // 101 clamps to the §8 maximum of 100 — the whole 28-row union answers,
    // proving the clamp is a clamp and not a fall back to the default 25.
    const clamped = await fixture.app.request("/?limit=101");
    expect(clamped.status).toBe(200);
    expect((await clamped.json()).items).toHaveLength(28);

    const notALimit = await fixture.app.request("/?limit=abc");
    expect(notALimit.status).toBe(400);

    const garbage = await fixture.app.request("/?cursor=abc");
    expect(garbage.status).toBe(400);
  });

  test("outcome_unknown allows view for the owner, reconcile only for an admin actor", async () => {
    // The owner's own uncertain send: view, never reconcile.
    const fixture = fixtureFor();
    const uncertain = await propose(fixture.reviewed, "user-1");
    fixture.executor.plan("outcome_unknown");
    await fixture.reviewed.decide("user-1", uncertain.id, "approve");

    const ownerFeed = await fixture.app.request("/");
    const ownerBody = await ownerFeed.json();
    expect(ownerBody.items).toHaveLength(1);
    expect(ownerBody.items[0].status).toBe("outcome_unknown");
    expect(ownerBody.items[0].detail).toBe("the provider call timed out");
    expect(ownerBody.items[0].allowedActions).toEqual(["view"]);

    // The admin actor's own uncertain send: the reconcile marker appears.
    const adminUncertain = await propose(fixture.reviewed, "admin-1");
    fixture.executor.plan("outcome_unknown");
    await fixture.reviewed.decide("admin-1", adminUncertain.id, "approve");
    currentActor = actorAdmin;
    try {
      const adminFeed = await fixture.app.request("/");
      const adminBody = await adminFeed.json();
      expect(adminBody.items).toHaveLength(1);
      expect(adminBody.items[0].allowedActions).toEqual(["view", "reconcile"]);
    } finally {
      currentActor = actorOne;
    }
  });

  test("cursor discipline: default 25, 101 clamps, abc and bad cursors 400, foreign cursor 400", async () => {
    const fixture = fixtureFor();
    for (let index = 0; index < 26; index += 1) {
      nowMs += 60_000;
      await propose(fixture.reviewed, "user-1");
    }

    const first = await fixture.app.request("/");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.items).toHaveLength(25);
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await fixture.app.request(
      `/?cursor=${firstBody.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();
    // The whole walk is newest first.
    const every = [...firstBody.items, ...secondBody.items];
    for (let index = 1; index < every.length; index += 1) {
      expect(every[index - 1].createdAt >= every[index].createdAt).toBe(true);
    }

    // 101 clamps to the §8 maximum of 100 — all 26 rows answer, proving the
    // clamp is a clamp and not a fall back to the default 25.
    const clamped = await fixture.app.request("/?limit=101");
    expect(clamped.status).toBe(200);
    expect((await clamped.json()).items).toHaveLength(26);

    const notALimit = await fixture.app.request("/?limit=abc");
    expect(notALimit.status).toBe(400);

    const garbage = await fixture.app.request("/?cursor=abc");
    expect(garbage.status).toBe(400);

    const foreign = await fixture.app.request(`/?cursor=${foreignCursor()}`);
    expect(foreign.status).toBe(400);
  });

  test("same createdAt orders by descending id", async () => {
    const fixture = fixtureFor();
    const same = new Date(Date.parse("2026-10-13T10:00:00.000Z"));
    for (const id of [
      "openmuse-reviewed-action-b",
      "openmuse-reviewed-action-a",
    ]) {
      await fixture.rows.insertAction({
        id,
        ownerUserId: "user-1",
        kind: "mail",
        canonicalPayload: mailPayload,
        payloadHash: "ab".repeat(32),
        accountEmail: "owner@example.com",
        connectionGeneration: 2,
        targetId: null,
        targetVersion: null,
        attachmentVersionIds: [],
        status: "awaiting_review",
        expiresAt: new Date(same.getTime() + REVIEWED_ACTION_TTL_MS),
        createdAt: same,
        decidedAt: null,
        completedAt: null,
        providerRef: null,
        error: null,
      });
    }

    const response = await fixture.app.request("/");
    const body = await response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      "reviewed_action:openmuse-reviewed-action-b",
      "reviewed_action:openmuse-reviewed-action-a",
    ]);
  });

  test("§9 fence: a disabled owner's feed answers 403", async () => {
    const fixture = fixtureFor();
    await propose(fixture.reviewed, "user-1");
    await fixture.rows.disableOwner("user-1");
    const response = await fixture.app.request("/");
    expect(response.status).toBe(403);
  });

  test("§9 fence through the notifications seam: a disabled owner answers 403", async () => {
    const fixture = fixtureFor();
    await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    await fixture.notificationRows.disableOwner("user-1");
    const response = await fixture.app.request("/");
    expect(response.status).toBe(403);
  });
});

describe("POST /:id/read (V02)", () => {
  test("allowedActions are exactly mark_read; unread → read; a repeat replays the same instant", async () => {
    const fixture = fixtureFor();
    const { notification } = await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.waiting_input",
      attemptKey: "1",
      title: "Task needs your answer",
    });
    nowMs += 60_000; // 10:01
    await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-2",
      eventKind: "monitor.matched",
      attemptKey: "hash-a",
      title: "Monitor matched",
    });

    const before = await fixture.app.request("/");
    const beforeBody = await before.json();
    expect(beforeBody.items).toHaveLength(2);
    expect(
      beforeBody.items.map(
        (item: { allowedActions: string[] }) => item.allowedActions,
      ),
    ).toEqual([["mark_read"], ["mark_read"]]);
    // A notification without a detail carries its event kind in detail.
    expect(beforeBody.items[0].detail).toBe("monitor.matched");
    expect(
      beforeBody.items.every(
        (item: { status: string; readAt: string | null }) =>
          item.status === "unread" && item.readAt === null,
      ),
    ).toBe(true);

    const read = await fixture.app.request(
      `/task_notification:${notification.id}/read`,
      { method: "POST" },
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({
      id: `task_notification:${notification.id}`,
      type: "task_notification",
      status: "read",
      allowedActions: ["mark_read"],
    });
    expect(typeof readBody.readAt).toBe("string");
    // The store's row is the one that moved — the feed dispatched, never marked.
    expect(
      fixture.notificationRows.notifications.find(
        (row) => row.id === notification.id,
      )?.readAt,
    ).toBeInstanceOf(Date);

    // A repeat mark replays the same first instant — idempotent by contract.
    const repeat = await fixture.app.request(
      `/task_notification:${notification.id}/read`,
      { method: "POST" },
    );
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).readAt).toBe(readBody.readAt);

    // The other row was never touched by the first row's mark.
    expect(
      fixture.notificationRows.notifications.find(
        (row) => row.id !== notification.id,
      )?.readAt,
    ).toBeNull();
  });

  test("marking read changes only that row: the reviewed action and the policy approval are untouched", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1"); // 10:00
    nowMs += 60_000; // 10:01
    const { notification } = await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    const policy = await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:02:00.000Z")),
    );
    const snapshot = JSON.stringify({
      approvals: fixture.approvals.records,
      actions: fixture.rows.actions,
    });

    const read = await fixture.app.request(
      `/task_notification:${notification.id}/read`,
      { method: "POST" },
    );
    expect(read.status).toBe(200);
    expect(
      JSON.stringify({
        approvals: fixture.approvals.records,
        actions: fixture.rows.actions,
      }),
    ).toBe(snapshot);

    // §8's matrix, both directions: a decision never claims a notification's
    // id, and mark_read never claims another type's id — all 409, and both
    // source stores stay exactly as they were.
    const reviewedOnNotification = await decision(
      fixture.app,
      `task_notification:${notification.id}`,
      { type: "reviewed_action", action: "approve" },
    );
    expect(reviewedOnNotification.status).toBe(409);
    expect((await reviewedOnNotification.json()).code).toBe("wrong_type");

    const policyOnNotification = await decision(
      fixture.app,
      `task_notification:${notification.id}`,
      { type: "policy_approval", action: "deny" },
    );
    expect(policyOnNotification.status).toBe(409);

    const readOnReviewed = await fixture.app.request(
      `/reviewed_action:${reviewed.id}/read`,
      { method: "POST" },
    );
    expect(readOnReviewed.status).toBe(409);
    expect((await readOnReviewed.json()).code).toBe("wrong_type");

    const readOnPolicy = await fixture.app.request(
      `/policy_approval:${policy.id}/read`,
      { method: "POST" },
    );
    expect(readOnPolicy.status).toBe(409);

    expect(
      JSON.stringify({
        approvals: fixture.approvals.records,
        actions: fixture.rows.actions,
      }),
    ).toBe(snapshot);
    expect(fixture.approvals.decisions).toHaveLength(0);
    expect(fixture.executor.calls).toHaveLength(0);
    expect(fixture.rows.actions[0].status).toBe("awaiting_review");
  });

  test("a foreign user's notifications are absent, and a foreign read is a 404", async () => {
    const fixture = fixtureFor();
    const own = await fixture.notifications.emit({
      userId: "user-1",
      taskId: "task-1",
      eventKind: "task.succeeded",
      attemptKey: "1",
      title: "Task succeeded",
    });
    nowMs += 60_000; // 10:01
    const foreign = await fixture.notifications.emit({
      userId: "user-2",
      taskId: "task-2",
      eventKind: "task.failed",
      attemptKey: "1",
      title: "Task failed",
    });

    const ownerFeed = await fixture.app.request("/");
    const ownerBody = await ownerFeed.json();
    expect(
      ownerBody.items.map((item: { sourceId: string }) => item.sourceId),
    ).toEqual([own.notification.id]);

    currentActor = actorTwo;
    try {
      const foreignFeed = await fixture.app.request("/");
      const foreignBody = await foreignFeed.json();
      expect(
        foreignBody.items.map((item: { sourceId: string }) => item.sourceId),
      ).toEqual([foreign.notification.id]);
      // Owner scope inside the store's mark: a foreign id is a missing one.
      const foreignRead = await fixture.app.request(
        `/task_notification:${own.notification.id}/read`,
        { method: "POST" },
      );
      expect(foreignRead.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
  });
});

describe("POST /:id/decision", () => {
  test("the wrong decision type is a 409 that changes nothing", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1");
    const policy = await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:01:00.000Z")),
    );
    const snapshot = JSON.stringify({
      approvals: fixture.approvals.records,
      actions: fixture.rows.actions,
    });

    const policyOnReviewed = await decision(
      fixture.app,
      `reviewed_action:${reviewed.id}`,
      { type: "policy_approval", action: "deny" },
    );
    expect(policyOnReviewed.status).toBe(409);
    expect((await policyOnReviewed.json()).code).toBe("wrong_type");

    const reviewedOnPolicy = await decision(
      fixture.app,
      `policy_approval:${policy.id}`,
      { type: "reviewed_action", action: "deny" },
    );
    expect(reviewedOnPolicy.status).toBe(409);

    expect(
      JSON.stringify({
        approvals: fixture.approvals.records,
        actions: fixture.rows.actions,
      }),
    ).toBe(snapshot);
    expect(fixture.approvals.decisions).toHaveLength(0);
    expect(fixture.executor.calls).toHaveLength(0);
  });

  test("a reviewed item that expires while the feed is open answers 409/expired", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1"); // expires 10:30
    nowMs += REVIEWED_ACTION_TTL_MS + 1;

    const response = await decision(
      fixture.app,
      `reviewed_action:${reviewed.id}`,
      {
        type: "reviewed_action",
        action: "approve",
      },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("expired");
    expect(body.status).toBe("expired");
    // The source row was re-read and flipped; the provider was never dialed.
    expect(fixture.rows.actions[0].status).toBe("expired");
    expect(fixture.executor.calls).toHaveLength(0);
  });

  test("a decided policy approval answers its current status, not a second decision", async () => {
    const fixture = fixtureFor();
    const policy = await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:01:00.000Z")),
    );

    const denied = await decision(fixture.app, `policy_approval:${policy.id}`, {
      type: "policy_approval",
      action: "deny",
    });
    expect(denied.status).toBe(200);
    expect((await denied.json()).status).toBe("denied");

    const again = await decision(fixture.app, `policy_approval:${policy.id}`, {
      type: "policy_approval",
      action: "approve",
    });
    expect(again.status).toBe(200);
    const againBody = await again.json();
    expect(againBody.status).toBe("denied");
    expect(againBody.allowedActions).toEqual([]);
    expect(fixture.approvals.decisions).toHaveLength(1);
  });

  test("dispatch happy paths: each decision routes to its owning module", async () => {
    const fixture = fixtureFor();
    const reviewed = await propose(fixture.reviewed, "user-1");
    fixture.executor.plan("succeeded");

    const reviewedDone = await decision(
      fixture.app,
      `reviewed_action:${reviewed.id}`,
      { type: "reviewed_action", action: "approve" },
    );
    expect(reviewedDone.status).toBe(200);
    const reviewedBody = await reviewedDone.json();
    expect(reviewedBody.status).toBe("succeeded");
    expect(reviewedBody.allowedActions).toEqual([]);
    expect(fixture.executor.calls).toHaveLength(1);

    const policy = await fixture.approvals.open(
      "user-1",
      new Date(Date.parse("2026-10-13T10:02:00.000Z")),
    );
    const policyDone = await decision(
      fixture.app,
      `policy_approval:${policy.id}`,
      { type: "policy_approval", action: "approve" },
    );
    expect(policyDone.status).toBe(200);
    expect((await policyDone.json()).status).toBe("approved");
    // The feed's approve is the approvals seam's allow_once: one feed tap
    // never writes an always-rule.
    expect(fixture.approvals.decisions).toEqual([
      { ownerUserId: "user-1", id: policy.id, decision: "allow_once" },
    ]);
  });

  test("a misspelled action is a contract violation (bad_action), not a 404 hiding it", async () => {
    const fixture = fixtureFor();
    const feed = createActivityFeed({
      approvals: fixture.approvals.seam,
      reviewed: fixture.reviewed,
      listReviewed: fakeReviewedLister(fixture.rows),
      notifications: fixture.notifications,
    });
    const action = await propose(fixture.reviewed, "user-1");
    // A library caller with a misspelled action must see its own bug; the
    // route's zod enum keeps this outcome off the HTTP surface entirely.
    const outcome = await feed.decide(
      "user-1",
      `reviewed_action:${action.id}`,
      {
        type: "reviewed_action",
        action: "approved",
      },
    );
    expect(outcome).toEqual({ kind: "bad_action" });
    // And the row itself is untouched — the refusal precedes any source read.
    expect(action.status).toBe("awaiting_review");
  });

  test("a foreign or unknown id is a 404", async () => {
    const fixture = fixtureFor();
    const foreign = await decision(fixture.app, "reviewed_action:missing-id", {
      type: "reviewed_action",
      action: "deny",
    });
    expect(foreign.status).toBe(404);

    const unknownPolicy = await decision(fixture.app, "policy_approval:none", {
      type: "policy_approval",
      action: "deny",
    });
    expect(unknownPolicy.status).toBe(404);
  });
});

/** A cursor minted for another owner: owner-bound means it is refused. */
function foreignCursor(): string {
  return Buffer.from(
    JSON.stringify({
      o: "user-2",
      t: "2026-10-13T10:00:00.000Z",
      i: "openmuse-reviewed-action-x",
    }),
    "utf8",
  ).toString("base64");
}

describe("merged order and cursor alphabet (§8 one total order)", () => {
  /*
   * The merge's tiebreak and the cursor's keyset must be ONE total order:
   * the cursor encodes the unprefixed sourceId, so the merge tiebreaks on
   * sourceId too. A type-prefixed tiebreak forks the two orders whenever
   * types share a millisecond: an item the merge sorts after the cursor row
   * gets filtered out of the next page's keyset (a skip), or reappears (a
   * repeat). `z-1` vs `a-1` is the divergence probe: prefix order says
   * reviewed-before-policy, sourceId order says policy-first.
   */
  test("same createdAt across types: sourceId is the tiebreak, and the boundary walk neither skips nor repeats", async () => {
    const fixture = fixtureFor();
    const same = new Date(Date.parse("2026-10-13T10:00:00.000Z"));
    const approval = await fixture.approvals.open("user-1", same);
    approval.id = "z-1";
    await fixture.rows.insertAction({
      id: "openmuse-reviewed-action-a-1",
      ownerUserId: "user-1",
      kind: "mail",
      canonicalPayload: mailPayload,
      payloadHash: "ab".repeat(32),
      accountEmail: "owner@example.com",
      connectionGeneration: 2,
      targetId: null,
      targetVersion: null,
      attachmentVersionIds: [],
      status: "awaiting_review",
      expiresAt: new Date(same.getTime() + REVIEWED_ACTION_TTL_MS),
      createdAt: same,
      decidedAt: null,
      completedAt: null,
      providerRef: null,
      error: null,
    });

    const first = await fixture.app.request("/?limit=1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items.map((item) => item.id)).toEqual([
      "policy_approval:z-1",
    ]);
    const second = await fixture.app.request(
      `/?cursor=${firstBody.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.items.map((item) => item.id)).toEqual([
      "reviewed_action:openmuse-reviewed-action-a-1",
    ]);
    expect(secondBody.nextCursor).toBeNull();
  });

  test("issued cursors are URL-safe base64url: no + / = rides the query string", async () => {
    const fixture = fixtureFor();
    // `~~` in the source id is the shape whose STANDARD-base64 cursor emits
    // `+` (uuid-shaped ids never do — verified by sampling), so this row is
    // the regression probe for the alphabet.
    fixture.notificationRows.notifications.push({
      id: "openmuse-notification-~~probe-x",
      userId: "user-1",
      taskId: "task-probe",
      eventKind: "task.succeeded",
      attemptKey: "seed",
      title: "Task succeeded",
      detail: null,
      createdAt: new Date(nowMs),
      readAt: null,
    });
    fixture.notificationRows.notifications.push({
      id: "openmuse-notification-older",
      userId: "user-1",
      taskId: "task-older",
      eventKind: "task.succeeded",
      attemptKey: "seed",
      title: "Task succeeded",
      detail: null,
      createdAt: new Date(nowMs - 1_000),
      readAt: null,
    });
    const first = await fixture.app.request("/?limit=1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items.map((item) => item.id)).toEqual([
      "task_notification:openmuse-notification-~~probe-x",
    ]);
    expect(firstBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/*
 * The deployment lister's own keyset, against a real PostgreSQL: the SQL
 * must carry the same (createdAt, id) tiebreak the order walks, or a page
 * boundary on a shared millisecond silently drops the rows below the
 * cursor's id before the memory filter ever sees them.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "reviewed lister keyset (drizzle)",
  () => {
    // Created in beforeAll: bun still executes a skipped describe's body,
    // so a URL-less run must not dial (or throw) while collecting tests.
    let database: ReturnType<typeof createDatabase>;
    const rows: ReviewedActionRows = {
      ownerDisabled: async () => false,
    } as unknown as ReviewedActionRows;
    let listReviewed: ReturnType<typeof createOpenMuseActivityReviewedLister>;
    const prefix = `act-${crypto.randomUUID().slice(0, 8)}`;

    beforeAll(() => {
      database = createDatabase(testDatabaseUrl(), TEST_POOL);
      listReviewed = createOpenMuseActivityReviewedLister({
        database,
        rows,
      });
    });

    afterAll(async () => {
      if (database === undefined) return;
      await database
        .delete(openmuseReviewedActions)
        .where(like(openmuseReviewedActions.ownerUserId, `${prefix}%`));
      await database.$client.close();
    });

    test("same-millisecond rows survive the cursor: page two answers the ids below the boundary", async () => {
      const same = new Date(Date.parse("2026-10-13T10:00:00.000Z"));
      const ids = [`${prefix}-z`, `${prefix}-m`, `${prefix}-a`];
      for (const id of ids) {
        await database.insert(openmuseReviewedActions).values({
          id,
          ownerUserId: `${prefix}-owner`,
          kind: "mail",
          canonicalPayload: { subject: "Lunch" },
          payloadHash: "ab".repeat(32),
          accountEmail: "owner@example.com",
          connectionGeneration: 2,
          status: "awaiting_review",
          expiresAt: new Date(same.getTime() + REVIEWED_ACTION_TTL_MS),
          createdAt: same,
        });
      }
      const pageOne = await listReviewed(`${prefix}-owner`, { limit: 2 });
      expect(pageOne.map((action) => action.id)).toEqual([
        `${prefix}-z`,
        `${prefix}-m`,
      ]);
      const pageTwo = await listReviewed(`${prefix}-owner`, {
        limit: 2,
        before: { createdAt: same, id: `${prefix}-m` },
      });
      expect(pageTwo.map((action) => action.id)).toEqual([`${prefix}-a`]);
    });
  },
);
