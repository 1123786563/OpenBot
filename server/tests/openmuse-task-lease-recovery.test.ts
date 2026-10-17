import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  createOpenMuseTaskRunner,
  OPENMUSE_TASK_KIND,
} from "../src/openmuse-tasks/runner";
import {
  createOpenMuseTaskStore,
  type OpenMuseTaskRows,
  type StoredOpenMuseTask,
} from "../src/openmuse-tasks/store";

/*
 * T07 (issue #64): lease-loss recovery on the shared WorkQueue. Task 0 proved
 * the queue's contract — an expired lease is re-claimable, each claim bumps the
 * item's attempts, claim caps at maxAttempts, finish is keyed on the owner —
 * so these fakes model exactly that: `expire` hands the item back, `claim`
 * increments and enforces the cap, `finish` refuses a foreign owner.
 */

type ClaimInput = {
  kind: string;
  owner: string;
  leaseMs: number;
  limit?: number;
  maxAttempts?: number;
};

/** The queue as Task 0 read it: attempts-per-claim, expiry frees the item, finish keys on owner. */
function leaseQueue() {
  const items = new Map<
    string,
    {
      payload: Record<string, unknown>;
      attempts: number;
      claimedBy: string | null;
    }
  >();
  const claims: ClaimInput[] = [];
  const finished: string[] = [];
  return {
    items,
    claims,
    finished,
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      if (items.has(item.key)) return "already" as const;
      items.set(item.key, {
        payload: item.payload ?? {},
        attempts: 0,
        claimedBy: null,
      });
      return "queued" as const;
    },
    claim: async (input: ClaimInput) => {
      claims.push(input);
      const due = [...items.entries()]
        .filter(
          ([key, item]) =>
            !finished.includes(key) &&
            item.claimedBy === null &&
            item.attempts < (input.maxAttempts ?? 5),
        )
        .slice(0, input.limit ?? 1);
      return due.map(([key, item]) => {
        item.attempts += 1;
        item.claimedBy = input.owner;
        return {
          kind: OPENMUSE_TASK_KIND,
          key,
          payload: item.payload,
          attempts: item.attempts,
        };
      });
    },
    finish: async ({
      key,
      owner,
    }: {
      kind: string;
      key: string;
      owner: string;
    }) => {
      const item = items.get(key);
      if (!item || item.claimedBy !== owner) return false;
      item.claimedBy = null;
      finished.push(key);
      return true;
    },
    purge: async () => 0,
    /** The lease expires: the item is free for the next claim, attempts keep their count. */
    expire: (key: string) => {
      const item = items.get(key);
      if (item) item.claimedBy = null;
    },
    /** A previous attempt claimed, ran, and lost the lease without settling. */
    simulateLostLease: (key: string) => {
      const item = items.get(key);
      if (item) {
        item.attempts += 1;
        item.claimedBy = null;
      }
    },
  };
}

/** The row seam as openmuse-task-runner.test.ts drives it, plus the T07 attempts CAS. */
function fakeRows(): OpenMuseTaskRows & { tasks: StoredOpenMuseTask[] } {
  const tasks: StoredOpenMuseTask[] = [];
  const snapshot = (row: StoredOpenMuseTask): StoredOpenMuseTask => ({
    ...row,
    steps: [...row.steps],
    evidence: [...row.evidence],
    artifactIds: [...row.artifactIds],
  });
  return {
    tasks,
    insertTask: async (task) => {
      tasks.push(snapshot(task));
    },
    findTaskByIdempotencyKey: async (ownerUserId, key) =>
      tasks.find(
        (row) => row.ownerUserId === ownerUserId && row.idempotencyKey === key,
      ) ?? null,
    getTask: async (id) => tasks.find((row) => row.id === id) ?? null,
    listByOwner: async () => [],
    listIdsByOwner: async (ownerUserId) =>
      tasks
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    countActiveByOwner: async (ownerUserId) =>
      tasks.filter(
        (row) =>
          row.ownerUserId === ownerUserId &&
          !["succeeded", "failed", "cancelled"].includes(row.status),
      ).length,
    updateTask: async (id, patch) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return null;
      // The T07 generation guard: a write from a stale attempt lands nothing.
      if (patch.ifAttempts !== undefined && row.attempts !== patch.ifAttempts)
        return null;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.status) row.status = patch.status;
      if (patch.nextCheckAt) row.nextCheckAt = patch.nextCheckAt;
      if (patch.monitorFailureStreak !== undefined)
        row.monitorFailureStreak = patch.monitorFailureStreak;
      if (patch.appendedSteps) row.steps.push(...patch.appendedSteps);
      // T11: a monitor's evidence is replaced whole — the capped latest rows.
      if (patch.evidence)
        row.evidence = patch.evidence.map((entry) => ({ ...entry }));
      if (patch.appendedEvidence)
        row.evidence.push(
          ...patch.appendedEvidence.map((entry) => ({ ...entry })),
        );
      row.updatedAt = new Date();
      return snapshot(row);
    },
    ownerDisabled: async () => false,
    disableOwner: async () => {},
    restoreOwner: async () => {},
    requestTaskCancel: async () => ({ kind: "missing" as const }),
    requestTaskPause: async () => ({ kind: "missing" as const }),
    resumeTask: async () => ({ kind: "missing" as const }),
    /**
     * T06's retry CAS as the scenarios below drive it: attempts+1, retained
     * rows stamped with the generation that wrote them, a monitor re-armed
     * `scheduled` now.
     */
    retryTask: async (id, retryKey, resetSteps) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return { kind: "missing" } as const;
      if (
        row.status === "failed" &&
        (retryKey === null || row.lastRetryKey !== retryKey)
      ) {
        if (row.kind === "monitor") {
          row.status = "scheduled";
          row.nextCheckAt = new Date();
        } else {
          row.status = "queued";
        }
        const stamped = row.attempts;
        row.attempts += 1;
        row.cancellationRequested = false;
        row.pauseRequested = false;
        if (retryKey !== null) row.lastRetryKey = retryKey;
        row.steps = (resetSteps ?? row.steps).map((step) => ({
          ...step,
          attempt: stamped,
        }));
        row.evidence = row.evidence.map((entry) => ({
          ...entry,
          attempt: stamped,
        }));
        row.updatedAt = new Date();
        return { kind: "applied", task: snapshot(row) } as const;
      }
      if (retryKey !== null && row.lastRetryKey === retryKey)
        return { kind: "replayed", task: snapshot(row) } as const;
      return { kind: "unapplied", task: snapshot(row) } as const;
    },
    /** T08; unused here, stubbed to satisfy the seam. */
    openTaskWait: async () => null,
    /** T16; unused here, stubbed to satisfy the seam. */
    openTaskReviewWait: async () => null,
    /** T08; unused here, stubbed to satisfy the seam. */
    answerTaskWait: async () => ({ kind: "missing" as const }),
  };
}

type TurnInput = { instruction?: string };

/** A full row as the store writes it; overrides pick the scenario. */
function storedTask(
  overrides: Partial<StoredOpenMuseTask> = {},
): StoredOpenMuseTask {
  const when = new Date("2026-10-01T00:00:00Z");
  return {
    id: "task-1",
    ownerUserId: "user-1",
    botId: "bot-1",
    kind: "agent",
    status: "queued",
    attempts: 1,
    steps: [],
    evidence: [],
    artifactIds: [],
    createdAt: when,
    updatedAt: when,
    idempotencyKey: null,
    cancellationRequested: false,
    pauseRequested: false,
    lastRetryKey: null,
    monitorFailureStreak: 0,
    ...overrides,
  };
}

function fixtureFor() {
  const queue = leaseQueue();
  const rows = fakeRows();
  const store = createOpenMuseTaskStore({ rows, queue });
  const turns: TurnInput[] = [];
  /** One runner per owner, as replicas are: they share the queue and the rows. */
  const runnerFor = (
    owner: string,
    turn: (input: TurnInput) => Promise<{ replyText: string }>,
  ) =>
    createOpenMuseTaskRunner({
      queue,
      store,
      owner,
      actorFor: async (id) => ({ id, role: "user" }),
      channels: {
        direct: async () => ({
          id: "c1",
          name: "",
          agentIds: ["bot-1"],
          threadId: "thread-1",
          active: true,
          lastMessageAt: null,
        }),
      },
      runTurn: async (input) => {
        turns.push(input);
        return turn(input);
      },
      // Long enough that a hanging first attempt outlives the test's recovery.
      deadlineMs: 60_000,
    });
  const seedTask = async () => {
    const { task } = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Summarise the mail.",
      idempotencyKey: null,
    });
    return task;
  };
  const row = (id: string) => {
    const found = rows.tasks.find((task) => task.id === id);
    if (!found) throw new Error(`row ${id} missing`);
    return found;
  };
  /** Await an async sweep's visible progress, never a fixed sleep. */
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    if (!check()) throw new Error("condition not reached");
  };
  return { queue, rows, store, turns, runnerFor, seedTask, row, until };
}

describe("lease recovery (T07, issue #64)", () => {
  test("lease lost before any effect: the next sweep re-runs as a new attempt, exactly once", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    let releaseFirst: (value: { replyText: string }) => void = () => {};
    const firstTurn = new Promise<{ replyText: string }>(
      (resolve) => (releaseFirst = resolve),
    );
    // Sweep one hangs mid-turn; its lease expires underneath it.
    const stale = fixture.runnerFor("replica-a", () => firstTurn).sweep();
    await fixture.until(() => fixture.row(task.id).status === "running");
    fixture.queue.expire(task.id);

    const report = await fixture
      .runnerFor("replica-b", async () => ({ replyText: "Recovered." }))
      .sweep();
    expect(report).toEqual({ ran: [task.id], skipped: [] });
    const recovered = fixture.row(task.id);
    expect(recovered.status).toBe("succeeded");
    // ONE recovered attempt: the re-run is generation 2 on the row.
    expect(recovered.attempts).toBe(2);
    expect(
      (recovered.steps[0] as { status: string; result: string }).result,
    ).toBe("Recovered.");

    // The stale sweep's late success must not land over the recovery's.
    releaseFirst({ replyText: "Late from replica-a." });
    await stale;
    const after = fixture.row(task.id);
    expect(after.status).toBe("succeeded");
    expect((after.steps[0] as { result: string }).result).toBe("Recovered.");
    expect(after.attempts).toBe(2);

    // Nothing left to claim: the cap (maxAttempts 2) holds at one recovery.
    const third = await fixture
      .runnerFor("replica-c", async () => ({ replyText: "never" }))
      .sweep();
    expect(third).toEqual({ ran: [], skipped: [] });
    expect(fixture.turns).toHaveLength(2);
  });

  test("lease lost after possible external effect (evidence present): no replay, failed with a reconciliation-wait detail", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    // The dead attempt's aftermath: running, with an ambiguity marker in evidence.
    const dead = fixture.row(task.id);
    dead.status = "running";
    dead.evidence.push({
      id: `${task.id}:ambiguous`,
      kind: "user",
      title: "Possible external effect",
      excerpt: "the previous attempt may have acted",
    });
    fixture.queue.simulateLostLease(task.id);

    const report = await fixture
      .runnerFor("replica-b", async () => ({ replyText: "must not run" }))
      .sweep();
    expect(report).toEqual({ ran: [], skipped: [task.id] });
    expect(fixture.turns).toHaveLength(0);
    const after = fixture.row(task.id);
    expect(after.status).toBe("failed");
    // Not retried, attempts unchanged: the ambiguity is on the record, not replayed.
    expect(after.attempts).toBe(1);
    const step = after.steps[0] as { status: string; result: string };
    expect(step.status).toBe("failed");
    expect(step.result).toContain("ambiguous");
    expect(step.result).toContain("awaiting reconciliation");
    expect(fixture.queue.finished).toEqual([task.id]);
  });

  test("a previous attempt that advanced a step also refuses replay", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    const dead = fixture.row(task.id);
    dead.status = "running";
    dead.steps.push({
      id: "run",
      title: "Run",
      dependsOn: [],
      status: "failed",
      result: "settled the step, died before the status",
    });
    fixture.queue.simulateLostLease(task.id);

    await fixture
      .runnerFor("replica-b", async () => ({ replyText: "must not run" }))
      .sweep();
    expect(fixture.turns).toHaveLength(0);
    const after = fixture.row(task.id);
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(1);
  });

  /*
   * T06×T07: a retry retains the failed attempt's evidence and steps (the
   * §7 contract), so the recovery's prior-effect heuristic must read them
   * generation-scoped: rows the retry stamped with the generation that wrote
   * them are history with a KNOWN outcome, never an unknown external effect.
   */
  test("a retried task that loses its lease again recovers: retained prior-generation evidence does not block the re-run", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({
        id: "fell-again",
        status: "failed",
        evidence: [
          {
            id: "fell-again:prompt",
            kind: "user",
            title: "Your request",
            excerpt: "Summarise the mail.",
          },
        ],
        steps: [
          {
            id: "run",
            title: "Run",
            dependsOn: [],
            status: "failed",
            result: "The turn errored.",
          },
        ],
      }),
    );
    const { outcome } = await fixture.store.retryTask(
      "user-1",
      "fell-again",
      null,
    );
    expect(outcome).toBe("retried");
    expect(fixture.row("fell-again").attempts).toBe(2);
    // The retried attempt (generation 2) starts, then its lease is lost
    // mid-turn — the same shape as the first test above, one retry later.
    let releaseRetry: (value: { replyText: string }) => void = () => {};
    const hanging = new Promise<{ replyText: string }>(
      (resolve) => (releaseRetry = resolve),
    );
    const stale = fixture.runnerFor("replica-a", () => hanging).sweep();
    await fixture.until(() => fixture.row("fell-again").status === "running");
    const key = [...fixture.queue.items.entries()]
      .filter(([, item]) => item.payload.taskId === "fell-again")
      .map(([offered]) => offered)[0];
    fixture.queue.expire(key);

    const report = await fixture
      .runnerFor("replica-b", async () => ({
        replyText: "Recovered on generation 3.",
      }))
      .sweep();
    expect(report.ran).toEqual([key]);
    const after = fixture.row("fell-again");
    expect(after.status).toBe("succeeded");
    // Retry made generation 2; the recovery re-runs it as generation 3.
    expect(after.attempts).toBe(3);
    releaseRetry({ replyText: "late from replica-a" });
    await stale;
    expect(fixture.row("fell-again").status).toBe("succeeded");
    expect(fixture.row("fell-again").attempts).toBe(3);
  });

  test("a retried monitor that loses its lease recovers its check: retained observations stay history", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({
        id: "m-fell",
        kind: "monitor",
        status: "failed",
        evidence: [
          {
            id: "m-fell:observation:2026-10-01T00:30:00.000Z",
            kind: "web",
            title: "Monitor observation",
            excerpt: "price 245.10",
            matched: false,
          },
        ],
        monitorCondition: {
          type: "price_below",
          intervalMinutes: 30,
          source: "https://shop.example/widget",
          threshold: 250,
        },
        nextCheckAt: new Date("2026-10-01T00:30:00.000Z"),
      }),
    );
    const { outcome } = await fixture.store.retryTask("user-1", "m-fell", null);
    expect(outcome).toBe("retried");
    // T06×T10: the retried monitor re-arms scheduled, not queued.
    expect(fixture.row("m-fell").status).toBe("scheduled");
    // The retried check (generation 2) is mid-flight when its lease is lost.
    const dead = fixture.row("m-fell");
    dead.status = "running";
    const key = [...fixture.queue.items.entries()]
      .filter(([, item]) => item.payload.taskId === "m-fell")
      .map(([offered]) => offered)[0];
    fixture.queue.simulateLostLease(key);

    await fixture
      .runnerFor("replica-b", async () => {
        throw new Error("a monitor never runs a turn");
      })
      .sweep();
    const after = fixture.row("m-fell");
    // Generation-1 observations are retained history, so the recovery re-runs
    // the check as generation 3 — which fails here (no check producer wired
    // in this fixture) into the T11 backoff, still `scheduled` — instead of
    // failing the row as an ambiguous external effect.
    expect(after.status).toBe("scheduled");
    expect(after.attempts).toBe(3);
    expect(
      after.evidence.some(
        (entry) =>
          (entry as { title?: string }).title === "Possible external effect",
      ),
    ).toBe(false);
    expect(
      after.evidence.some(
        (entry) => (entry as { title?: string }).title === "Check failed",
      ),
    ).toBe(true);
  });

  test("a stale sweep cannot finish a new owner's claim: the CAS refuses its status write", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    let releaseFirst: (value: { replyText: string }) => void = () => {};
    const firstTurn = new Promise<{ replyText: string }>(
      (resolve) => (releaseFirst = resolve),
    );
    const stale = fixture.runnerFor("replica-a", () => firstTurn).sweep();
    await fixture.until(() => fixture.row(task.id).status === "running");
    fixture.queue.expire(task.id);

    // The new owner recovers the lease and settles a failure.
    await fixture
      .runnerFor("replica-b", async () => {
        throw new Error("replica-b failed");
      })
      .sweep();
    expect(fixture.row(task.id).status).toBe("failed");

    // The old generation's success arrives late: refused, outcome preserved.
    releaseFirst({ replyText: "replica-a late success" });
    await stale;
    const after = fixture.row(task.id);
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(2);
    expect(after.steps).toHaveLength(1);
    expect((after.steps[0] as { result: string }).result).toBe(
      "replica-b failed",
    );
    expect(
      after.evidence.some(
        (entry) =>
          (entry as { excerpt?: string }).excerpt === "replica-a late success",
      ),
    ).toBe(false);
  });

  test("requeue exactly once: a recovered attempt that fails again settles and never loops", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    let releaseFirst: (value: { replyText: string }) => void = () => {};
    const firstTurn = new Promise<{ replyText: string }>(
      (resolve) => (releaseFirst = resolve),
    );
    const stale = fixture.runnerFor("replica-a", () => firstTurn).sweep();
    await fixture.until(() => fixture.row(task.id).status === "running");
    fixture.queue.expire(task.id);

    // The recovery re-runs and fails cleanly: settle + finish, no third offer.
    const report = await fixture
      .runnerFor("replica-b", async () => {
        throw new Error("boom");
      })
      .sweep();
    expect(report).toEqual({ ran: [], skipped: [task.id] });
    const recovered = fixture.row(task.id);
    expect(recovered.status).toBe("failed");
    expect((recovered.steps[0] as { result: string }).result).toBe("boom");
    // The fake asserts finish was called: the queue row is done, not wedged.
    expect(fixture.queue.finished).toEqual([task.id]);

    releaseFirst({ replyText: "late" });
    await stale;
    const third = await fixture
      .runnerFor("replica-c", async () => ({ replyText: "never" }))
      .sweep();
    expect(third).toEqual({ ran: [], skipped: [] });
    expect(fixture.turns).toHaveLength(2);
    // Every claim asked for exactly one spare attempt.
    expect(fixture.queue.claims.every((claim) => claim.maxAttempts === 2)).toBe(
      true,
    );
  });

  test("F-TASK-2 shape: an ambiguous turn lands the reconciliation-wait path, not a plain failure", async () => {
    const fixture = fixtureFor();
    const task = await fixture.seedTask();
    // The turn runner does not throw this yet (F-TASK-2 wiring is live-gate
    // work); the marker is what it will throw, duck-typed by name.
    const ambiguous = new Error("stream died mid-tool-call");
    ambiguous.name = "AmbiguousTurnError";

    const report = await fixture
      .runnerFor("replica-a", async () => {
        throw ambiguous;
      })
      .sweep();
    expect(report).toEqual({ ran: [], skipped: [task.id] });
    const after = fixture.row(task.id);
    expect(after.status).toBe("failed");
    // No recovery happened, so no generation bump.
    expect(after.attempts).toBe(1);
    const step = after.steps[0] as { status: string; result: string };
    expect(step.status).toBe("failed");
    expect(step.result).toContain("awaiting reconciliation");
    // The possible-effect marker is on the evidence, for the reconciler.
    expect(
      after.evidence.some(
        (entry) => (entry as { id?: string }).id === `${task.id}:ambiguous`,
      ),
    ).toBe(true);
    expect(fixture.queue.finished).toEqual([task.id]);
  });
});
