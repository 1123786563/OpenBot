import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createActivityFeed } from "../src/openmuse-activity/feed";
import {
  OPENMUSE_REDACTED_LAST_ERROR,
  type OpenMuseDeletionCleanupView,
} from "../src/openmuse-deletion/retention";
import { createOpenMuseOpsSignalsRoutes } from "../src/openmuse-ops/routes";
import {
  createOpenMuseOpsSignals,
  type OpenMuseOpsConnectorFailureRow,
  type OpenMuseOpsSignal,
  type OpenMuseOpsTaskQueueRow,
  type OpenMuseOpsUncertainActionRow,
} from "../src/openmuse-ops/signals";
import type { StoredReviewedAction } from "../src/openmuse-reviewed-actions/store";
import {
  createOpenMuseTaskStore,
  type OpenMuseTaskRows,
  type StoredOpenMuseTask,
} from "../src/openmuse-tasks/store";

/*
 * O05 (contracts §10, issue #92): the operator's health surface over the four
 * failure seams — connector refresh failures (G04's refresh_required rows),
 * stuck queued Tasks (the WorkQueue's due/lease semantics), outcome_unknown
 * Reviewed actions (R04) and retryable cleanup rows (D09). The aggregation is
 * pure over injected readers and an injected clock, so every threshold below
 * is a fixture, never a sleep. The owner's own projections are NOT rebuilt
 * here: one delayed task in the owner's list and one uncertain write in the
 * feed's outcome_unknown marker are re-asserted exactly once each, proving
 * this ticket aggregates operator visibility rather than adding a second
 * owner surface.
 */

const T0 = new Date("2026-10-12T08:00:00.000Z");
const MINUTE = 60_000;

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

/** §10's operator seat: the admin the signals route answers. */
const actorAdmin: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};

let currentActor: AuthenticatedActor = actorAdmin;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

/** The empty D09 view a healthy cleanup answers with. */
function emptyCleanupView(): OpenMuseDeletionCleanupView {
  return { retentionDays: 30, markers: [] };
}

/** One admin app over injected readers — the route plus the aggregation. */
function opsWorld(deps: Parameters<typeof createOpenMuseOpsSignals>[0]) {
  const app = createOpenMuseOpsSignalsRoutes({
    requireUser,
    signals: createOpenMuseOpsSignals(deps),
  });
  return app;
}

async function signalsOf(
  deps: Parameters<typeof createOpenMuseOpsSignals>[0],
): Promise<OpenMuseOpsSignal[]> {
  return (await createOpenMuseOpsSignals(deps)()).signals;
}

/** The four faults §10 names, one per seam, as the stores would hold them. */
function fourFaults() {
  const connections: OpenMuseOpsConnectorFailureRow[] = [
    {
      id: "conn-1",
      provider: "gmail",
      // A reason that quotes the credential it failed on — G06's display
      // guard must replace it before an operator ever reads it.
      lastError: `refresh failed with ya29.${"a0ARrdaM".repeat(8)}`,
    },
  ];
  const taskQueue: OpenMuseOpsTaskQueueRow[] = [
    {
      key: "task-1",
      taskId: "task-1",
      runAt: new Date(T0.getTime() - 6 * MINUTE),
      claimedBy: null,
      leaseUntil: null,
      finishedAt: null,
      attempts: 0,
      lastError: null,
    },
    // Round 6 (M34): a retry-exhausted row (attempts at the claim's cap,
    // unclaimed, unfinished) is a terminal state awaiting reap — it must NOT
    // read as a stuck/queued-runnable task.
    {
      key: "task-done-with",
      taskId: "task-done-with",
      runAt: new Date(T0.getTime() - 6 * MINUTE),
      claimedBy: null,
      leaseUntil: null,
      finishedAt: null,
      attempts: 2,
      lastError: "the turn ended ambiguously",
    },
  ];
  const uncertainReviewed: OpenMuseOpsUncertainActionRow[] = [
    {
      actionId: "action-1",
      ownerUserId: actorOne.id,
      createdAt: new Date(T0.getTime() - 2 * MINUTE),
      attempt: { attemptId: "attempt-1", reconciliation: null },
    },
  ];
  const cleanupView = (): Promise<OpenMuseDeletionCleanupView> =>
    Promise.resolve({
      retentionDays: 30,
      markers: [
        {
          userId: actorOne.id,
          disabledAt: T0.toISOString(),
          phase: "fenced",
          restoreUntil: null,
          retentionElapsed: false,
          retryable: 1,
          unresolved: [
            {
              kind: "openmuse-file",
              id: "file-1",
              state: "retryable_error",
              lastError: "byte store refused to delete",
              at: T0.toISOString(),
            },
          ],
        },
      ],
    });
  return { connections, taskQueue, uncertainReviewed, cleanupView };
}

describe("GET /api/admin/openmuse-ops/signals", () => {
  test("four injected faults answer four signal rows with safe ids, each citing its source row; nothing secret rides along", async () => {
    const faults = fourFaults();
    const app = opsWorld({
      now: () => T0,
      refreshRequired: async () => faults.connections,
      taskQueue: async () => faults.taskQueue,
      uncertainReviewed: async () => faults.uncertainReviewed,
      cleanupView: faults.cleanupView,
    });

    const response = await app.request("/signals");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { signals: OpenMuseOpsSignal[] };
    expect(body.signals).toHaveLength(4);

    const [connector, task, uncertain, cleanup] = body.signals;
    // The connector row: G04's refresh_required, sanitized through G06's
    // display guard — the token-shaped reason is the fixed redaction.
    expect(connector.kind).toBe("connector_refresh_failure");
    expect(connector.id).toBe("conn-1");
    expect(connector.source).toContain("openmuse-connectors");
    expect(connector.detail).toBe(`gmail: ${OPENMUSE_REDACTED_LAST_ERROR}`);

    // The stuck Task: §10 row — the operator sees the Task ID and the queue
    // reason, nothing of the owner's.
    expect(task.kind).toBe("stuck_task");
    expect(task.id).toBe("task-1");
    expect(task.reason).toBe("queued-runnable");
    expect(task.source).toContain("openmuse-tasks");

    // The uncertain Reviewed action: attempt ID, whose it is, and the
    // reconciliation status.
    expect(uncertain.kind).toBe("uncertain_reviewed_action");
    expect(uncertain.id).toBe("attempt-1");
    expect(uncertain.reconciliation).toBe("pending");
    expect(uncertain.detail).toBe(
      `owner ${actorOne.id}: reconciliation: pending`,
    );
    expect(uncertain.source).toContain("openmuse-reviewed-actions");

    // The retryable cleanup row: resource kind, safe ID, last error.
    expect(cleanup.kind).toBe("cleanup_retry");
    expect(cleanup.id).toBe("file-1");
    expect(cleanup.resource).toBe("openmuse-file");
    expect(cleanup.detail).toBe("byte store refused to delete");
    expect(cleanup.source).toContain("openmuse-deletion");

    // §9-safe: no token shapes, no byte-store keys, anywhere in the answer.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ya29.");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("openmuse-files/");
  });

  test("a healthy deployment answers an empty signals list", async () => {
    const app = opsWorld({
      now: () => T0,
      refreshRequired: async () => [],
      taskQueue: async () => [],
      uncertainReviewed: async () => [],
      cleanupView: async () => emptyCleanupView(),
    });

    const response = await app.request("/signals");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signals: [] });
  });

  test("a non-admin is refused 403 and never reads the surface", async () => {
    const faults = fourFaults();
    const app = opsWorld({
      now: () => T0,
      refreshRequired: async () => faults.connections,
      taskQueue: async () => faults.taskQueue,
      uncertainReviewed: async () => faults.uncertainReviewed,
      cleanupView: faults.cleanupView,
    });

    currentActor = actorOne;
    try {
      const response = await app.request("/signals");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Administrator access required.",
      });
    } finally {
      currentActor = actorAdmin;
    }
  });
});

describe("§10 stuck-Task thresholds (injected clock)", () => {
  const queued = (minutesAgo: number): OpenMuseOpsTaskQueueRow => ({
    key: "task-1",
    taskId: "task-1",
    runAt: new Date(T0.getTime() - minutesAgo * MINUTE),
    claimedBy: null,
    leaseUntil: null,
    finishedAt: null,
  });
  const leased = (
    leaseSecondsAgo: number,
    leaseSecondsLong: number,
  ): OpenMuseOpsTaskQueueRow => ({
    key: "task-2",
    taskId: "task-2",
    runAt: new Date(T0.getTime() - 10 * MINUTE),
    claimedBy: "worker-1",
    leaseUntil: new Date(
      T0.getTime() - leaseSecondsAgo * 1000 + leaseSecondsLong * 1000,
    ),
    finishedAt: null,
  });

  test("runnable queued 4 minutes is not stuck; 6 minutes is", async () => {
    const stuck = (rows: OpenMuseOpsTaskQueueRow[]) =>
      signalsOf({ now: () => T0, taskQueue: async () => rows }).then((all) =>
        all.filter((signal) => signal.kind === "stuck_task"),
      );
    // Only the task seam is wired, so the unwired three answer their own gap
    // rows; these assertions are about the TASK seam alone.
    expect(await stuck([queued(4)])).toEqual([]);
    const [signal] = await stuck([queued(6)]);
    expect(signal.kind).toBe("stuck_task");
    expect(signal.reason).toBe("queued-runnable");
  });

  test("an expired lease 30 seconds unrecovered is not stuck; 90 seconds is", async () => {
    const stuck = (rows: OpenMuseOpsTaskQueueRow[]) =>
      signalsOf({ now: () => T0, taskQueue: async () => rows }).then((all) =>
        all.filter((signal) => signal.kind === "stuck_task"),
      );
    expect(await stuck([leased(90, 60)])).toEqual([]);
    const [signal] = await stuck([leased(90, -90)]);
    expect(signal.kind).toBe("stuck_task");
    expect(signal.reason).toBe("expired-lease");
  });

  test("a claimed row with no lease is stuck on its own reason, never dropped", async () => {
    const stuck = (rows: OpenMuseOpsTaskQueueRow[]) =>
      signalsOf({ now: () => T0, taskQueue: async () => rows }).then((all) =>
        all.filter((signal) => signal.kind === "stuck_task"),
      );
    const claimed = { ...leased(0, 30), leaseUntil: null };
    const [signal] = await stuck([claimed]);
    expect(signal.kind).toBe("stuck_task");
    expect(signal.reason).toBe("claimed-no-lease");
    expect(signal.detail).toContain("never held a lease");
  });

  test("healthy queue shapes stay silent: live lease, not yet due, finished", async () => {
    // Only the task seam is wired here, so the unwired three answer their
    // own gap rows; the assertion is that the TASK seam contributes none.
    const signals = (
      await signalsOf({
        now: () => T0,
        taskQueue: async () => [
          leased(0, 30), // running now, lease 30s from now
          { ...queued(-2), key: "task-3", taskId: "task-3" }, // due in 2 min
          { ...queued(6), key: "task-4", taskId: "task-4", finishedAt: T0 }, // done
        ],
      })
    ).filter((signal) => signal.kind === "stuck_task");
    expect(signals).toEqual([]);
  });
});

describe("a missing seam is a visible signal, never an omission", () => {
  test("every unwired reader answers its own missing-seam row", async () => {
    const signals = await signalsOf({ now: () => T0 });
    expect(signals).toHaveLength(4);
    expect(signals.map((signal) => signal.kind)).toEqual([
      "missing_seam",
      "missing_seam",
      "missing_seam",
      "missing_seam",
    ]);
    expect(signals.map((signal) => signal.source)).toEqual([
      "missing-seam (openmuse-connectors)",
      "missing-seam (work/queue + openmuse-tasks)",
      "missing-seam (openmuse-reviewed-actions)",
      "missing-seam (openmuse-deletion)",
    ]);
  });

  test("a reader that fails answers the same gap, not a silent hole", async () => {
    const signals = await signalsOf({
      now: () => T0,
      refreshRequired: async () => {
        throw new Error("connection refused");
      },
      taskQueue: async () => [],
      uncertainReviewed: async () => [],
      cleanupView: async () => emptyCleanupView(),
    });
    // The failed seam is the gap; the three healthy ones contribute nothing.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe("missing_seam");
    expect(signals[0]?.source).toBe("missing-seam (openmuse-connectors)");
    // The failure's own reason rides the detail, truncated — a DB outage
    // must not read as the same mystery as a code bug.
    expect(signals[0]?.detail).toBe(
      "This seam failed to answer: connection refused",
    );
  });

  test("a failing reader's reason passes G06's display guard before an operator reads it", async () => {
    // A DB driver's message can quote the credential it failed on (the same reason
    // TOKEN_SHAPED exists for the recorded columns): the failure branch is an exit
    // like the cleanup view, so the guard runs here too — ordinary messages pass
    // through unchanged, token-shaped ones are replaced wholesale.
    const leaking = await signalsOf({
      now: () => T0,
      refreshRequired: async () => {
        throw new Error(
          "connect ECONNREFUSED bearer ya29.a0AfH6SMBx1234567890123456789012345678901234567890",
        );
      },
      taskQueue: async () => [],
      uncertainReviewed: async () => [],
      cleanupView: async () => emptyCleanupView(),
    });
    expect(leaking[0]?.detail).toBe(
      "This seam failed to answer: redacted: the recorded reason may quote a credential",
    );
  });
});

describe("the owner's own projections are the existing ones, re-asserted once each", () => {
  test("a stuck queued Task is already visible in the owner's Task list", async () => {
    // The list-only rows this re-assertion touches; every other seam throws
    // rather than half-behaving, because nothing else is under test here.
    const tasks: StoredOpenMuseTask[] = [];
    const unused = <T>(): T => {
      throw new Error("not part of the owner-list re-assertion");
    };
    const rows: OpenMuseTaskRows = {
      insertTask: async (task) => {
        tasks.push(task);
      },
      findTaskByIdempotencyKey: async () => null,
      getTask: async (id) => tasks.find((task) => task.id === id) ?? null,
      listByOwner: async (ownerUserId, { limit }) =>
        tasks
          .filter((task) => task.ownerUserId === ownerUserId)
          .slice(0, limit),
      listIdsByOwner: async (ownerUserId) =>
        tasks
          .filter((task) => task.ownerUserId === ownerUserId)
          .map((t) => t.id),
      countActiveByOwner: async () => 0,
      updateTask: async () => null,
      ownerDisabled: async () => false,
      disableOwner: async () => {},
      restoreOwner: async () => {},
      requestTaskCancel: unused,
      requestTaskPause: unused,
      resumeTask: unused,
      retryTask: unused,
      openTaskWait: unused,
      openTaskReviewWait: unused,
      answerTaskWait: unused,
      shutdownOwnerTasks: unused,
      hardDeleteTasks: async () => {},
    };
    const store = createOpenMuseTaskStore({ rows });
    const { task } = await store.create({
      ownerUserId: actorOne.id,
      botId: "bot-1",
      kind: "agent",
      prompt: "Summarize the inbox",
      idempotencyKey: null,
    });
    // The queue seam is absent, so the row sits queued — the delayed state.
    expect(task.status).toBe("queued");
    const listed = await store.list(actorOne.id, { limit: 10 });
    expect(listed.tasks.map((row) => row.id)).toContain(task.id);
    expect(listed.tasks[0]?.status).toBe("queued");
  });

  test("an uncertain write is already marked in the owner's Activity feed", async () => {
    const uncertain: StoredReviewedAction = {
      id: "action-1",
      ownerUserId: actorOne.id,
      kind: "gmail.send",
      canonicalPayload: {},
      payloadHash: "hash-1",
      accountEmail: "one@openbot.test",
      connectionGeneration: 1,
      targetId: null,
      targetVersion: null,
      attachmentVersionIds: [],
      status: "outcome_unknown",
      expiresAt: new Date(T0.getTime() + 10 * MINUTE),
      createdAt: T0,
      decidedAt: T0,
      completedAt: T0,
      providerRef: null,
      error: "The send's outcome could not be read back.",
    };
    const feed = createActivityFeed({
      approvals: {
        inbox: async () => ({ requests: [] }),
        decide: async () => {
          throw new Error("not part of the feed re-assertion");
        },
        store: { get: async () => null },
      },
      reviewed: {
        decide: async () => {
          throw new Error("not part of the feed re-assertion");
        },
      },
      listReviewed: async () => [uncertain],
    });
    const page = await feed.read(actorOne.id, {});
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const item = page.items.find((row) => row.type === "reviewed_action");
    // §8's marker, owner seat: viewable, never reconcilable from the feed.
    expect(item?.status).toBe("outcome_unknown");
    expect(item?.allowedActions).toEqual(["view"]);
  });
});
