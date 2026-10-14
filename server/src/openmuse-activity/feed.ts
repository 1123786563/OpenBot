import type { StoredOpenMuseNotification } from "../openmuse-notifications/store";
import type { StoredReviewedAction } from "../openmuse-reviewed-actions/store";

/**
 * The §8 Activity feed (V01 policy/reviewed, V02 task notifications): three
 * owner-bound sources in one list, each item carrying only its own type's
 * allowed actions. This module aggregates and dispatches — it never decides
 * anything itself: reads go through the approvals seam mobile-bff's
 * activity.ts already uses (`inbox().requests`), the reviewed store's
 * activity lister and the notifications store's owner list, and every
 * decision or mark is routed to the owning module's existing path.
 */

/** §8: default page 25, maximum 100. */
export const ACTIVITY_DEFAULT_LIMIT = 25;
export const ACTIVITY_MAX_LIMIT = 100;

export type ActivityItemType =
  | "policy_approval"
  | "reviewed_action"
  | "task_notification";

/** The §8 row shape; readAt is the task notification's own read mark, null on the other types. */
export type ActivityFeedItem = {
  id: string;
  type: ActivityItemType;
  sourceId: string;
  createdAt: string;
  status: string;
  title: string;
  detail: string;
  allowedActions: string[];
  readAt: string | null;
};

export type ActivityFeedPage = {
  items: ActivityFeedItem[];
  nextCursor: string | null;
};

/**
 * The approvals seam (Task 0): the same three touches mobile-bff's activity
 * and the approvals routes use — `inbox().requests` to read, `store.get` for
 * §8's re-read-before-deciding, and the owning service's `decide`. A feed
 * "approve" is the seam's `allow_once`: one tap must not write an always-rule.
 */
export type ActivityApprovalsSeam = {
  inbox(ownerUserId: string): Promise<{
    requests: PolicyApprovalRecord[];
  }>;
  decide(
    ownerUserId: string,
    id: string,
    decision: "allow_once" | "deny",
  ): Promise<PolicyApprovalRecord>;
  store: {
    get(ownerUserId: string, id: string): Promise<PolicyApprovalRecord>;
  };
};

/** What the feed needs of an approval row; the raw and public records both carry it. */
export type PolicyApprovalRecord = {
  id: string;
  status: "pending" | "approved" | "denied" | "consumed" | "completed";
  createdAt: Date;
  action: {
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    policy?: { reason: string };
  };
};

/** The reviewed module's decision path, re-used — never re-implemented here. */
export type ActivityReviewedSeam = {
  decide(
    ownerUserId: string,
    id: string,
    decision: "approve" | "deny",
  ): Promise<StoredReviewedAction | null>;
};

/** The reviewed store's one V01 addition: this owner's awaiting/outcome rows. */
export type ActivityReviewedLister = (
  ownerUserId: string,
  page: { limit: number; before?: { createdAt: Date; id: string } },
) => Promise<StoredReviewedAction[]>;

/**
 * The notifications store's owner list and mark (V02, §7/§8), re-used — the
 * feed never keeps its own read state or a second mark implementation.
 */
export type ActivityNotificationsSeam = {
  list(
    ownerUserId: string,
    page: { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<{ notifications: StoredOpenMuseNotification[] }>;
  markRead(
    ownerUserId: string,
    id: string,
  ): Promise<StoredOpenMuseNotification | null>;
};

export type ActivityFeed = {
  read(
    ownerUserId: string,
    input: { limit?: number; cursor?: string; operator?: boolean },
  ): Promise<({ ok: true } & ActivityFeedPage) | { ok: false; error: string }>;
  decide(
    ownerUserId: string,
    id: string,
    input: { type: string; action: string; operator?: boolean },
  ): Promise<
    | { kind: "ok"; item: ActivityFeedItem }
    | { kind: "missing" }
    | { kind: "wrong_type" }
    | { kind: "bad_action" }
  >;
  markRead(
    ownerUserId: string,
    id: string,
  ): Promise<
    | { kind: "ok"; item: ActivityFeedItem }
    | { kind: "missing" }
    | { kind: "wrong_type" }
  >;
};

export const ACTIVITY_CURSOR_ERROR =
  "This cursor is not valid for this activity feed.";

export function createActivityFeed(deps: {
  approvals: ActivityApprovalsSeam;
  reviewed: ActivityReviewedSeam;
  listReviewed: ActivityReviewedLister;
  /**
   * The notifications seam (V02): index.ts wires the notification store's
   * own list/markRead here. Optional so a deployment (or test) can mount the
   * V01 union alone — absent it, task_notification ids 404, never
   * half-behave.
   */
  notifications?: ActivityNotificationsSeam;
}): ActivityFeed {
  return {
    async read(ownerUserId, input) {
      const limit = Math.min(
        Math.max(input.limit ?? ACTIVITY_DEFAULT_LIMIT, 1),
        ACTIVITY_MAX_LIMIT,
      );
      const before =
        input.cursor !== undefined && input.cursor !== ""
          ? decodeCursor(input.cursor, ownerUserId)
          : undefined;
      if (input.cursor !== undefined && input.cursor !== "" && !before)
        return { ok: false, error: ACTIVITY_CURSOR_ERROR };
      const operator = input.operator ?? false;
      const [inbox, reviewed, notifications] = await Promise.all([
        deps.approvals.inbox(ownerUserId),
        // One extra row detects whether a next page exists without a second read.
        deps.listReviewed(ownerUserId, {
          limit: limit + 1,
          ...(before ? { before } : {}),
        }),
        deps.notifications
          ? deps.notifications.list(ownerUserId, {
              limit: limit + 1,
              ...(before ? { cursor: before } : {}),
            })
          : { notifications: [] as StoredOpenMuseNotification[] },
      ]);
      const items = [
        // The approvals inbox is not cursor-paginated; the same predicate the
        // reviewed lister pushes into its query is applied in memory here.
        ...inbox.requests
          .filter((record) => !before || olderThan(record, before))
          .map(policyItem),
        ...reviewed.map((action) => reviewedItem(action, operator)),
        ...notifications.notifications.map(notificationItem),
      ].sort(byFeedOrder);
      const page = items.slice(0, limit);
      return {
        ok: true,
        items: page,
        nextCursor:
          items.length > limit && page.length > 0
            ? encodeCursor(ownerUserId, page[page.length - 1])
            : null,
      };
    },

    async decide(ownerUserId, id, input) {
      const parsed =
        /^(policy_approval|reviewed_action|task_notification):(.+)$/.exec(id);
      if (!parsed) return { kind: "missing" };
      const [, itemType, sourceId] = parsed;
      // §8: the wrong decision type is a 409 that leaves both records alone —
      // refused before any source is read or any owning module is called.
      // A task notification has no decision at all: mark_read (its own route)
      // is its only verb, so every decision body is a wrong type for its id.
      if (input.type !== itemType || itemType === "task_notification")
        return { kind: "wrong_type" };
      // A caller contract violation, not a missing row: the route's zod enum
      // makes this unreachable over HTTP, but a direct library caller with a
      // misspelled action must see its own bug, not a 404 that hides it.
      if (input.action !== "approve" && input.action !== "deny")
        return { kind: "bad_action" };
      if (itemType === "policy_approval") {
        // §8: re-read the source before acting. A request that is no longer
        // pending answers its current status; the seam is never asked to
        // re-decide a decided row.
        const current = await deps.approvals.store.get(ownerUserId, sourceId);
        if (current.status !== "pending")
          return { kind: "ok", item: policyItem(current) };
        const decided = await deps.approvals.decide(
          ownerUserId,
          sourceId,
          input.action === "approve" ? "allow_once" : "deny",
        );
        return { kind: "ok", item: policyItem(decided) };
      }
      // The reviewed module re-reads its own row inside decide — an expiry
      // past expiresAt flips it and answers 409/expired, and a settled row
      // re-answers itself without touching the provider.
      const settled = await deps.reviewed.decide(
        ownerUserId,
        sourceId,
        input.action,
      );
      if (!settled) return { kind: "missing" };
      return {
        kind: "ok",
        item: reviewedItem(settled, input.operator ?? false),
      };
    },

    async markRead(ownerUserId, id) {
      const parsed = /^task_notification:(.+)$/.exec(id);
      if (!parsed)
        // §8's matrix, read direction: mark_read is the task notification's
        // verb alone, so another type's id refuses as wrong-type and an
        // unknown shape is simply missing — no source is ever read.
        return /^(policy_approval|reviewed_action):.+/.test(id)
          ? { kind: "wrong_type" }
          : { kind: "missing" };
      if (!deps.notifications) return { kind: "missing" };
      // The notifications store owns the mark: owner scope and the set-once
      // instant live there, never a second implementation here.
      const stored = await deps.notifications.markRead(ownerUserId, parsed[1]);
      if (!stored) return { kind: "missing" };
      return { kind: "ok", item: notificationItem(stored) };
    },
  };
}

/**
 * §8 order: createdAt descending, then sourceId descending — the same
 * unprefixed (createdAt, sourceId) key the cursor encodes and every
 * per-source keyset filter compares, so the merge order and the cursor walk
 * are one total order (a type-prefixed id here would fork from the keyset at
 * equal createdAt across types and skip or duplicate boundary rows).
 */
function byFeedOrder(a: ActivityFeedItem, b: ActivityFeedItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.sourceId < b.sourceId ? 1 : -1;
}

function policyItem(record: PolicyApprovalRecord): ActivityFeedItem {
  return {
    id: `policy_approval:${record.id}`,
    type: "policy_approval",
    sourceId: record.id,
    createdAt: record.createdAt.toISOString(),
    status: record.status,
    title: record.action.toolRef,
    detail:
      record.action.policy?.reason ??
      `${record.action.effect} · ${record.action.scope}`,
    allowedActions: record.status === "pending" ? ["approve", "deny"] : [],
    readAt: null,
  };
}

function reviewedItem(
  action: StoredReviewedAction,
  operator: boolean,
): ActivityFeedItem {
  let allowedActions: string[] = [];
  if (action.status === "awaiting_review") {
    allowedActions = ["approve", "deny"];
  } else if (action.status === "outcome_unknown") {
    // §8: an uncertain send is viewable; only an operator may reconcile,
    // never the owner, and it is never retryable from the feed.
    allowedActions = operator ? ["view", "reconcile"] : ["view"];
  }
  return {
    id: `reviewed_action:${action.id}`,
    type: "reviewed_action",
    sourceId: action.id,
    createdAt: action.createdAt.toISOString(),
    status: action.status,
    title: action.kind,
    detail: action.error ?? action.accountEmail,
    allowedActions,
    readAt: null,
  };
}

/** §8: the task notification row — read/unread, mark_read alone, its own readAt. */
function notificationItem(
  record: StoredOpenMuseNotification,
): ActivityFeedItem {
  return {
    id: `task_notification:${record.id}`,
    type: "task_notification",
    sourceId: record.id,
    createdAt: record.createdAt.toISOString(),
    status: record.readAt ? "read" : "unread",
    title: record.title,
    detail: record.detail ?? record.eventKind,
    allowedActions: ["mark_read"],
    readAt: record.readAt ? record.readAt.toISOString() : null,
  };
}

/** Whether a source record sorts strictly after the cursor row (older in feed order). */
function olderThan(
  record: { createdAt: Date; id: string },
  before: { createdAt: Date; id: string },
): boolean {
  return (
    record.createdAt.getTime() < before.createdAt.getTime() ||
    (record.createdAt.getTime() === before.createdAt.getTime() &&
      record.id < before.id)
  );
}

/**
 * The owner-bound cursor: the owner is inside the token, so one person's
 * cursor is another person's 400, not a window into their feed. base64url —
 * the repo's rule for anything riding a query parameter (a standard-base64
 * `+` arrives here as a space); the url-safe decoder reads the old
 * standard-alphabet cursors too, so issued ones keep paging.
 */
function encodeCursor(ownerUserId: string, item: ActivityFeedItem): string {
  return Buffer.from(
    JSON.stringify({ o: ownerUserId, t: item.createdAt, i: item.sourceId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  raw: string,
  ownerUserId: string,
): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as {
      o?: unknown;
      t?: unknown;
      i?: unknown;
    };
    if (
      parsed.o !== ownerUserId ||
      typeof parsed.t !== "string" ||
      typeof parsed.i !== "string" ||
      parsed.i.length === 0
    )
      return null;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}
