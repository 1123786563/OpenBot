import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { OpenMuseConnectionRefusedError } from "../src/openmuse-connectors/google-oauth";
import {
  createDocumentReplyReview,
  createOpenMuseReviewedActionService,
} from "../src/openmuse-reviewed-actions/service";
import { createOpenMuseTasksRoutes } from "../src/openmuse-tasks/routes";
import {
  backoffMinutes,
  createOpenMuseTaskRunner,
  normalizeObservation,
  OPENMUSE_TASK_KIND,
  observationHash,
} from "../src/openmuse-tasks/runner";
import {
  createOpenMuseTaskStore,
  documentTaskCarriage,
  type OpenMuseTaskRows,
  type OpenMuseTaskStatus,
  type StoredOpenMuseTask,
} from "../src/openmuse-tasks/store";

/*
 * T02: one queued Task, claimed from the shared WorkQueue once, run through one
 * headless private-Bot turn under a deadline, and settled on the row. The fakes
 * mirror the real seams' contracts — the queue's claim-once/lease semantics,
 * the rows' jsonb updates — exactly as agents/wake-up.ts is tested.
 */

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

/** The store's create path offers through this; the runner claims through it. */
function fakeQueue() {
  const offered: Array<{
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
  }> = [];
  const finished: string[] = [];
  const claims: Array<{
    kind: string;
    owner: string;
    leaseMs: number;
    limit?: number;
    maxAttempts?: number;
  }> = [];
  const waiting = new Map<string, Record<string, unknown>>();
  return {
    offered,
    finished,
    claims,
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      offered.push(item);
      if (waiting.has(item.key)) return "already" as const;
      waiting.set(item.key, item.payload ?? {});
      return "queued" as const;
    },
    /** Claim-once: a key is handed out at most once until offered again. */
    claim: async (input: {
      kind: string;
      owner: string;
      leaseMs: number;
      limit?: number;
      maxAttempts?: number;
    }) => {
      claims.push(input);
      const due = [...waiting.keys()]
        .filter((key) => !finished.includes(key))
        .slice(0, input.limit ?? 1);
      return due.map((key) => {
        const payload = waiting.get(key) ?? {};
        waiting.delete(key);
        return { kind: OPENMUSE_TASK_KIND, key, payload, attempts: 1 };
      });
    },
    finish: async ({ key }: { key: string }) => {
      finished.push(key);
      return true;
    },
    purge: async () => 0,
  };
}

/**
 * T10: the clock the fixture reads — the store's create, the rows' resume and
 * the queue's due gate all consult it, the way the database's clock does in
 * production.
 */
function clockAt(iso: string) {
  let current = new Date(iso);
  return {
    now: () => current,
    advance: (minutes: number) => {
      current = new Date(current.getTime() + minutes * 60_000);
    },
  };
}

/** In-memory row seam, the T01 shape plus the T02 update. */
function fakeRows(
  now: () => Date = () => new Date(),
): OpenMuseTaskRows & { tasks: StoredOpenMuseTask[] } {
  const tasks: StoredOpenMuseTask[] = [];
  const disabled = new Set<string>();
  const snapshot = (row: StoredOpenMuseTask): StoredOpenMuseTask => ({
    ...row,
    steps: [...row.steps],
    evidence: [...row.evidence],
    artifactIds: [...row.artifactIds],
    ...(row.wait ? { wait: { ...row.wait } } : {}),
  });
  return {
    tasks,
    insertTask: async (task) => {
      if (
        task.idempotencyKey !== null &&
        tasks.some(
          (row) =>
            row.ownerUserId === task.ownerUserId &&
            row.idempotencyKey === task.idempotencyKey,
        )
      )
        throw new Error("duplicate idempotency key");
      tasks.push({
        ...task,
        steps: [...task.steps],
        evidence: [...task.evidence],
        artifactIds: [...task.artifactIds],
      });
    },
    findTaskByIdempotencyKey: async (ownerUserId, key) =>
      tasks.find(
        (row) => row.ownerUserId === ownerUserId && row.idempotencyKey === key,
      ) ?? null,
    getTask: async (id) => tasks.find((row) => row.id === id) ?? null,
    listByOwner: async (ownerUserId, { limit, before }) =>
      tasks
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
      // T07: the attempts CAS — a write from a stale generation lands nothing.
      if (patch.ifAttempts !== undefined && row.attempts !== patch.ifAttempts)
        return null;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.status) row.status = patch.status;
      // T10: a monitor's re-armed due instant lands in the same settle.
      if (patch.nextCheckAt) row.nextCheckAt = patch.nextCheckAt;
      // T11: the observation cursor and the failure streak land in the same
      // settle — explicitly checked for !== undefined, a zero streak must land.
      if (patch.lastObservationHash !== undefined)
        row.lastObservationHash = patch.lastObservationHash;
      if (patch.lastObservationAt !== undefined)
        row.lastObservationAt = patch.lastObservationAt;
      if (patch.monitorFailureStreak !== undefined)
        row.monitorFailureStreak = patch.monitorFailureStreak;
      // T09: a plan's steps carry its graph, so the runner replaces the
      // array (one step's status moves) instead of appending to it.
      if (patch.steps) row.steps = patch.steps.map((step) => ({ ...step }));
      if (patch.appendedSteps) row.steps.push(...patch.appendedSteps);
      // T11: a monitor's evidence is replaced whole — the capped latest rows.
      if (patch.evidence)
        row.evidence = patch.evidence.map((entry) => ({ ...entry }));
      if (patch.appendedEvidence)
        row.evidence.push(
          ...patch.appendedEvidence.map((entry) => ({ ...entry })),
        );
      // T13: artifact File ids link in the same guarded write.
      if (patch.appendedArtifactIds)
        row.artifactIds.push(...patch.appendedArtifactIds);
      row.updatedAt = new Date();
      return {
        ...row,
        steps: [...row.steps],
        evidence: [...row.evidence],
        artifactIds: [...row.artifactIds],
      };
    },
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    /** The §7 cancel CAS: one atomic transition per the matrix, or nothing. */
    requestTaskCancel: async (id) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return { kind: "missing" } as const;
      if (["queued", "scheduled", "paused"].includes(row.status)) {
        row.status = "cancelled";
        row.updatedAt = new Date();
        return { kind: "applied", task: snapshot(row) } as const;
      }
      if (row.status === "running" && !row.cancellationRequested) {
        row.cancellationRequested = true;
        row.updatedAt = new Date();
        return { kind: "applied", task: snapshot(row) } as const;
      }
      return { kind: "unapplied", task: snapshot(row) } as const;
    },
    /** The §7 pause CAS: queued/scheduled → paused, running → the flag, else nothing. */
    requestTaskPause: async (id) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return { kind: "missing" } as const;
      if (["queued", "scheduled"].includes(row.status)) {
        row.status = "paused";
        row.updatedAt = new Date();
        return { kind: "applied", task: snapshot(row) } as const;
      }
      if (row.status === "running" && !row.pauseRequested) {
        row.pauseRequested = true;
        row.updatedAt = new Date();
        return { kind: "applied", task: snapshot(row) } as const;
      }
      return { kind: "unapplied", task: snapshot(row) } as const;
    },
    /** T05: paused → queued with the flag cleared; every other state refuses. */
    resumeTask: async (id) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return { kind: "missing" } as const;
      if (row.status !== "paused")
        return { kind: "unapplied", task: snapshot(row) } as const;
      row.pauseRequested = false;
      // T10: a monitor resumes `scheduled`, re-armed now+interval from the
      // row's own condition — the same swap the drizzle rows compute with the
      // database's clock.
      if (row.kind === "monitor" && row.monitorCondition) {
        row.status = "scheduled";
        row.nextCheckAt = new Date(
          now().getTime() + row.monitorCondition.intervalMinutes * 60_000,
        );
      } else {
        row.status = "queued";
      }
      row.updatedAt = new Date();
      return { kind: "applied", task: snapshot(row) } as const;
    },
    /**
     * T06: the §7 retry CAS: failed → queued as a new attempt, once per retry
     * key. T09: a plan's reset steps land in the same atomic swap. T06×T07:
     * retained rows are stamped with the generation that wrote them; T06×T10:
     * a monitor retries to `scheduled` re-armed now.
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
    /** T08: running → waiting_input with the wait record, CAS'd on the attempts generation. */
    openTaskWait: async (id, patch) => {
      const row = tasks.find((task) => task.id === id);
      if (row?.status !== "running" || row.attempts !== patch.ifAttempts)
        return null;
      row.status = "waiting_input";
      row.wait = patch.wait;
      if (patch.appendedSteps) row.steps.push(...patch.appendedSteps);
      if (patch.appendedEvidence) row.evidence.push(...patch.appendedEvidence);
      row.updatedAt = new Date();
      return snapshot(row);
    },
    /** T16: running → waiting_review with the review wait, same CAS contract. */
    openTaskReviewWait: async (id, patch) => {
      const row = tasks.find((task) => task.id === id);
      if (row?.status !== "running" || row.attempts !== patch.ifAttempts)
        return null;
      row.status = "waiting_review";
      row.wait = patch.wait;
      if (patch.appendedSteps) row.steps.push(...patch.appendedSteps);
      if (patch.appendedEvidence) row.evidence.push(...patch.appendedEvidence);
      if (patch.appendedArtifactIds)
        row.artifactIds.push(...patch.appendedArtifactIds);
      row.updatedAt = new Date();
      return snapshot(row);
    },
    /** T08: the answer CAS — the first valid answer consumes once, or is classified. */
    answerTaskWait: async (id, waitId, answer) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return { kind: "missing" } as const;
      const wait = row.wait;
      if (wait?.waitId !== waitId) return { kind: "missing" } as const;
      if (wait.answeredAt !== undefined)
        return { kind: "replayed", task: snapshot(row) } as const;
      if (row.status !== "waiting_input")
        return { kind: "unapplied", task: snapshot(row) } as const;
      wait.answeredAt = new Date().toISOString();
      wait.answer = answer;
      row.status = "queued";
      row.updatedAt = new Date();
      return { kind: "consumed", task: snapshot(row) } as const;
    },
    /** D02: the §9 bulk transition, the same status guards as the CAS ones. */
    shutdownOwnerTasks: async (ownerUserId) => {
      const cancelled: string[] = [];
      const cancelRequested: string[] = [];
      for (const row of tasks) {
        if (row.ownerUserId !== ownerUserId) continue;
        if (
          [
            "queued",
            "scheduled",
            "paused",
            "waiting_input",
            "waiting_review",
          ].includes(row.status)
        ) {
          row.status = "cancelled";
          row.updatedAt = new Date();
          cancelled.push(row.id);
        } else if (row.status === "running" && !row.cancellationRequested) {
          row.cancellationRequested = true;
          row.updatedAt = new Date();
          cancelRequested.push(row.id);
        }
      }
      return { cancelled, cancelRequested };
    },
  };
}

type TurnInput = {
  ownerUserId: string;
  routineId: string;
  agentId: string;
  threadId: string;
  instruction: string;
  signal?: AbortSignal;
};

function fixtureFor(
  overrides: {
    deadlineMs?: number;
    /** T08: the injected classifier a test doubles as a wait producer. */
    inputWaitOf?: (turn: { replyText: string }) => {
      question: string;
      fields?: Array<{ name: string; type: "string" | "boolean" }>;
    } | null;
    /** T13: the openmuse-files seam a finance task reads and writes through. */
    files?: Pick<
      import("../src/openmuse-files/store").OpenMuseFileStore,
      "upload" | "getOwnedFile" | "appendVersion"
    >;
    /** T15: the PDF inspection seam a document task reads fields through. */
    extract?: import("../src/openmuse-documents/inspect").PdfFieldExtractor;
    /** T15: the PDF fill seam a document task writes its one copy through. */
    fill?: import("../src/openmuse-documents/fill").PdfFillAdapter;
    /** T12: the notification emit seam; absent still collects into `events`. */
    emitNotification?: (event: {
      userId: string;
      taskId: string;
      eventKind: string;
      attemptKey: string;
      title: string;
      detail?: string;
    }) => Promise<unknown>;
  } = {},
) {
  const queue = fakeQueue();
  const rows = fakeRows();
  const store = createOpenMuseTaskStore({ rows, queue });
  const app = createOpenMuseTasksRoutes({
    store,
    requireUser,
    resolvePrivateBotId: async (ownerUserId) =>
      ownerUserId === "user-1" ? "bot-1" : null,
    ...(overrides.files ? { files: overrides.files } : {}),
  });
  const turns: TurnInput[] = [];
  const statusesSeenByTurn: OpenMuseTaskStatus[] = [];
  // T12: the emitted notifications, collected by the default seam below.
  const events: Array<{
    userId: string;
    taskId: string;
    eventKind: string;
    attemptKey: string;
    title: string;
    detail?: string;
  }> = [];
  let turnResult: (input: TurnInput) => Promise<{ replyText: string }> =
    async () => ({ replyText: "Done." });
  const runner = createOpenMuseTaskRunner({
    queue,
    store,
    owner: "replica",
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
      statusesSeenByTurn.push(
        rows.tasks.find((task) => task.id === turnsTaskId)?.status ?? "queued",
      );
      return turnResult(input);
    },
    ...(overrides.deadlineMs ? { deadlineMs: overrides.deadlineMs } : {}),
    ...(overrides.inputWaitOf ? { inputWaitOf: overrides.inputWaitOf } : {}),
    ...(overrides.files ? { files: overrides.files } : {}),
    ...(overrides.extract ? { extract: overrides.extract } : {}),
    ...(overrides.fill ? { fill: overrides.fill } : {}),
    emitNotification:
      overrides.emitNotification ??
      (async (event) => {
        events.push(event);
      }),
  });
  let turnsTaskId = "";
  return {
    queue,
    rows,
    store,
    app,
    runner,
    turns,
    events,
    statusesSeenByTurn,
    rememberTaskForTurn(id: string) {
      turnsTaskId = id;
    },
    setTurn(impl: (input: TurnInput) => Promise<{ replyText: string }>) {
      turnResult = impl;
    },
    async postTask(body: Record<string, unknown>, idempotencyKey?: string) {
      const response = await app.request("/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ kind: "agent", botId: "bot-1", ...body }),
      });
      return (await response.json()) as StoredOpenMuseTask & { id: string };
    },
  };
}

const promptStep = (task: StoredOpenMuseTask) => ({
  id: `${task.id}:prompt`,
  kind: "user",
  title: "Your request",
  excerpt: task.prompt,
});

describe("create path offers to the queue", () => {
  test("POST offers {kind, key} once per created row; an idempotent retry does not re-offer", async () => {
    const fixture = fixtureFor();
    const first = await fixture.postTask({ prompt: "a" }, "retry-key");
    expect(first.status).toBe("queued");
    await fixture.postTask({ prompt: "a" }, "retry-key");
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      key: first.id,
    });
    // A different row is its own piece of work.
    const second = await fixture.postTask({ prompt: "b" });
    expect(fixture.queue.offered).toHaveLength(2);
    expect(fixture.queue.offered[1]?.key).toBe(second.id);
  });

  test("a store built without a queue (T01 deployments) still creates", async () => {
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({ rows });
    const { task } = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      idempotencyKey: null,
    });
    expect(task.status).toBe("queued");
  });

  test("an offer failure after a successful insert propagates — never misread as an idempotent replay", async () => {
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({
      rows,
      queue: {
        offer: async () => {
          throw new Error("queue is down");
        },
      },
    });
    // The row IS on disk now; answering created=false here (the old single
    // catch's misread) would hand back a Task no queue item will ever claim.
    await expect(
      store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        prompt: "a",
        idempotencyKey: "offer-fails",
      }),
    ).rejects.toThrow(/queue is down/);
  });
});

describe("sweep", () => {
  test("claims the offered item once: queued→running→succeeded, one step, prompt+result evidence, finish, updatedAt advanced", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "Summarise the mail." });
    const stored = fixture.rows.tasks.find((row) => row.id === created.id);
    if (stored) {
      // Pin creation into the past so "updatedAt advanced" is not a same-millisecond coin flip.
      stored.createdAt = new Date(Date.now() - 60_000);
      stored.updatedAt = stored.createdAt;
    }
    fixture.rememberTaskForTurn(created.id);
    const report = await fixture.runner.sweep();
    expect(report).toEqual({ ran: [created.id], skipped: [] });

    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("succeeded");
    // The turn ran while the row said running.
    expect(fixture.statusesSeenByTurn).toEqual(["running"]);
    expect(task?.steps).toEqual([
      {
        id: "run",
        title: "Run",
        dependsOn: [],
        status: "succeeded",
        result: "Done.",
      },
    ]);
    expect(task?.evidence).toEqual([
      promptStep(task as StoredOpenMuseTask),
      {
        id: `${created.id}:result`,
        kind: "user",
        title: "Work completed",
        excerpt: "Done.",
      },
    ]);
    expect(fixture.queue.finished).toEqual([created.id]);
    expect(task?.updatedAt.getTime()).toBeGreaterThan(
      task?.createdAt.getTime() ?? 0,
    );
    expect(fixture.turns[0]).toMatchObject({
      ownerUserId: "user-1",
      agentId: "bot-1",
      threadId: "thread-1",
      instruction: "Summarise the mail.",
    });
    expect(fixture.turns[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a rejecting turn settles failed with the error detail capped at 500 chars", async () => {
    const fixture = fixtureFor();
    fixture.setTurn(async () => {
      throw new Error("x".repeat(600));
    });
    const created = await fixture.postTask({ prompt: "a" });
    const report = await fixture.runner.sweep();
    expect(report).toEqual({ ran: [], skipped: [created.id] });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("failed");
    const step = task?.steps[0] as { status: string; result: string };
    expect(step.status).toBe("failed");
    expect(step.result).toHaveLength(500);
    expect(step.result).toBe("x".repeat(500));
    expect(task?.evidence).toEqual([promptStep(task as StoredOpenMuseTask)]);
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("a turn that outlives the deadline fails the task and ignores the turn's late rejection", async () => {
    const fixture = fixtureFor({ deadlineMs: 20 });
    fixture.setTurn(
      (input) =>
        new Promise<{ replyText: string }>((_, reject) =>
          input.signal?.addEventListener("abort", () =>
            reject(new Error("the turn failed after the sweep gave up")),
          ),
        ),
    );
    const created = await fixture.postTask({ prompt: "a" });
    const report = await fixture.runner.sweep();
    expect(report).toEqual({ ran: [], skipped: [created.id] });
    // Let the losing turn's rejection land: an unhandled one would fail this file.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("failed");
    const step = task?.steps[0] as { status: string; result: string };
    expect(step.status).toBe("failed");
    expect(step.result).toContain("timed out");
    expect(fixture.turns[0]?.signal?.aborted).toBe(true);
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("nothing to claim is a no-op", async () => {
    const fixture = fixtureFor();
    expect(await fixture.runner.sweep()).toEqual({ ran: [], skipped: [] });
    expect(fixture.turns).toHaveLength(0);
  });

  test("a claim failure mid-sweep releases the slots it already began", async () => {
    const base = fakeQueue();
    let claims = 0;
    const queue = {
      ...base,
      claim: async (input: Parameters<typeof base.claim>[0]) => {
        claims += 1;
        // Round 1 claims the item; round 2 dies the way a transient DB
        // fault would — outside every per-item try.
        if (claims > 1) throw new Error("claim is down");
        return base.claim(input);
      },
    };
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({ rows, queue });
    const ends: number[] = [];
    let running = 0;
    const runner = createOpenMuseTaskRunner({
      queue,
      store,
      owner: "replica",
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
      runTurn: async () => ({ replyText: "Done." }),
      capacity: {
        claimLimit: () => (running >= 4 ? 0 : 1),
        begin: () => {
          running += 1;
          return true;
        },
        end: () => {
          running -= 1;
          ends.push(running);
        },
      },
    });
    const { task } = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      idempotencyKey: null,
    });
    await expect(runner.sweep()).rejects.toThrow(/claim is down/);
    // The slot round 1 began was released by the failure, not stranded:
    // without the release this count stays 1 and the process never claims
    // another Task.
    expect(ends).toEqual([0]);
    expect(rows.tasks.find((row) => row.id === task.id)?.status).toBe(
      "succeeded",
    );
  });

  test("a task row missing between offer and claim is finished with a skip, no crash", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    fixture.rows.tasks.splice(
      fixture.rows.tasks.findIndex((row) => row.id === created.id),
      1,
    );
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    expect(fixture.queue.finished).toEqual([created.id]);
    expect(fixture.turns).toHaveLength(0);
  });

  test("a second sweep after success does not re-run", async () => {
    const fixture = fixtureFor();
    await fixture.postTask({ prompt: "a" });
    await fixture.runner.sweep();
    expect(await fixture.runner.sweep()).toEqual({ ran: [], skipped: [] });
    expect(fixture.turns).toHaveLength(1);
  });

  test("a row already settled off-queue (cancelled) is skipped, not run", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    if (row) row.status = "cancelled";
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("claims with a lease at least the deadline and maxAttempts 2 (T07: one recovery)", async () => {
    const fixture = fixtureFor({ deadlineMs: 1_000 });
    await fixture.postTask({ prompt: "a" });
    await fixture.runner.sweep();
    const claim = fixture.queue.claims[0];
    expect(claim?.kind).toBe("openmuse-task");
    expect(claim?.leaseMs).toBeGreaterThanOrEqual(1_000);
    // Headroom for the settle writes: the lease outlives the turn's deadline.
    expect(claim?.leaseMs).toBe(61_000);
    // One fresh attempt plus exactly one lease recovery, never a third.
    expect(claim?.maxAttempts).toBe(2);
  });
});

describe("cancellation (T04)", () => {
  test("a cancel that lands before claim: the sweep skips execution and finishes cancelled", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.store.requestCancel("user-1", created.id);
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("cancelled");
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("cancel mid-run: the turn still finishes, the flag lands cancelled, not succeeded", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    fixture.setTurn(async () => {
      // The cancel lands while the turn is in flight, through the real store.
      await fixture.store.requestCancel("user-1", created.id);
      return { replyText: "Done." };
    });
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("cancelled");
    expect(task?.status).not.toBe("succeeded");
    // No run step is fabricated for a cancelled turn; a status note is left instead.
    expect(task?.steps).toEqual([]);
    const note = task?.evidence.find(
      (entry) => (entry as { id?: string }).id === `${created.id}:cancel`,
    ) as { title: string; excerpt: string } | undefined;
    expect(note?.title).toBe("Cancelled");
    expect(note?.excerpt).toContain("current step");
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("a turn that finishes without a cancel still settles succeeded", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    expect(await fixture.runner.sweep()).toEqual({
      ran: [created.id],
      skipped: [],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("succeeded");
  });
});

describe("pause and resume (T05)", () => {
  test("a pause that lands before claim: the sweep skips execution, the row stays paused, never runs", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.store.requestPause("user-1", created.id);
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("paused");
    expect(fixture.turns).toHaveLength(0);
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("pause mid-run: the turn still finishes, the row lands paused, not succeeded", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    fixture.setTurn(async () => {
      // The pause lands while the turn is in flight, through the real store.
      await fixture.store.requestPause("user-1", created.id);
      return { replyText: "Done." };
    });
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("paused");
    expect(task?.status).not.toBe("succeeded");
    // No run step is fabricated for a paused turn; a status note is left instead.
    expect(task?.steps).toEqual([]);
    const note = task?.evidence.find(
      (entry) => (entry as { id?: string }).id === `${created.id}:pause`,
    ) as { title: string; excerpt: string } | undefined;
    expect(note?.title).toBe("Paused");
    expect(note?.excerpt).toContain("current step");
    expect(fixture.queue.finished).toEqual([created.id]);
  });

  test("cancel wins over pause when both land mid-run: the row settles cancelled", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    fixture.setTurn(async () => {
      await fixture.store.requestPause("user-1", created.id);
      await fixture.store.requestCancel("user-1", created.id);
      return { replyText: "Done." };
    });
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [created.id],
    });
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("cancelled");
  });

  test("resume re-offers once and the next sweep runs the task to succeeded, flag cleared", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.store.requestPause("user-1", created.id);
    // The pre-claim pause is skipped by the sweep; the queue row finishes.
    await fixture.runner.sweep();
    await fixture.store.resumeTask("user-1", created.id);
    // Exactly one re-offer: create's, then resume's fresh-keyed one — never a
    // third, and never the task id again (a finished queue row owns it).
    expect(fixture.queue.offered).toHaveLength(2);
    expect(fixture.queue.offered[0]?.key).toBe(created.id);
    expect(fixture.queue.offered[1]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: created.id },
    });
    expect(fixture.queue.offered[1]?.key).not.toBe(created.id);
    const rerun = await fixture.runner.sweep();
    // The re-run is reported under the re-offer's fresh key, not the task id.
    expect(rerun.ran).toHaveLength(1);
    expect(rerun.ran[0]?.startsWith(`${created.id}:`)).toBe(true);
    expect(rerun.skipped).toEqual([]);
    const task = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(task?.status).toBe("succeeded");
    expect(task?.pauseRequested).toBe(false);
    expect(fixture.turns).toHaveLength(1);
  });

  test("a second resume while queued is refused by the status guard: no second re-offer", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.store.requestPause("user-1", created.id);
    await fixture.store.resumeTask("user-1", created.id);
    const second = await fixture.store.resumeTask("user-1", created.id);
    expect(second).toMatchObject({
      outcome: "terminal",
      task: { status: "queued" },
    });
    expect(fixture.queue.offered).toHaveLength(2);
  });
});

describe("wait-for-input outcome (T08)", () => {
  test("a turn the classifier flags settles waiting_input: wait record, waiting step, question evidence, queue finished", async () => {
    const fixture = fixtureFor({
      inputWaitOf: () => ({
        question: "Which mailbox should I summarise?",
        fields: [{ name: "mailbox", type: "string" }],
      }),
    });
    const created = await fixture.postTask({ prompt: "Summarise the mail." });
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("waiting_input");
    expect(row?.wait).toMatchObject({
      taskId: created.id,
      kind: "input",
      question: "Which mailbox should I summarise?",
      fields: [{ name: "mailbox", type: "string" }],
    });
    expect(row?.wait?.answeredAt).toBeUndefined();
    const steps = (row?.steps ?? []) as Array<{
      status: string;
      result?: string;
    }>;
    expect(steps.at(-1)).toMatchObject({
      status: "waiting",
      result: "Which mailbox should I summarise?",
    });
    const evidenceIds = (row?.evidence ?? []).map(
      (entry) => (entry as { id: string }).id,
    );
    expect(evidenceIds).toContain(`${created.id}:wait`);
    // The queue row is finished: the answer's re-offer owns any rerun.
    expect(fixture.queue.finished).toHaveLength(1);
  });

  test("answering the wait requeues and the next sweep finishes the run", async () => {
    let classify = 0;
    const fixture = fixtureFor({
      inputWaitOf: () =>
        classify++ === 0
          ? {
              question: "Which mailbox?",
              fields: [{ name: "mailbox", type: "string" }],
            }
          : null,
    });
    const created = await fixture.postTask({ prompt: "Summarise the mail." });
    await fixture.runner.sweep();
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("waiting_input");
    const waitId = row?.wait?.waitId;
    expect(waitId).toBeTypeOf("string");
    const answer = await fixture.app.request(
      `/${created.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { mailbox: "inbox" } }),
      },
    );
    expect(answer.status).toBe(200);
    // Create's offer, then the answer's one re-offer: exactly two.
    expect(fixture.queue.offered).toHaveLength(2);
    const rerun = await fixture.runner.sweep();
    expect(rerun.ran).toHaveLength(1);
    const settled = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(settled?.status).toBe("succeeded");
    // The turn that resumed saw the answer ride along? Not yet — the seam
    // passes the prompt only; the resume instruction is C07/T15's producer.
    expect(settled?.wait?.answeredAt).toBeTypeOf("string");
  });

  test("a cancel that lands mid-run outranks the wait classification", async () => {
    const fixture = fixtureFor({
      inputWaitOf: () => ({ question: "Which mailbox?" }),
    });
    const created = await fixture.postTask({ prompt: "Summarise the mail." });
    fixture.setTurn(async () => {
      // The cancel lands while the turn is in flight, through the real store.
      await fixture.store.requestCancel("user-1", created.id);
      return { replyText: "Which mailbox?" };
    });
    const report = await fixture.runner.sweep();
    expect(report.skipped).toHaveLength(1);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.wait).toBeUndefined();
  });
});

describe("plan tasks (T09)", () => {
  /** The S31 shape: three linear steps 1 → 2 → 3. */
  const linearPlan = () => ({
    kind: "plan" as const,
    prompt: "Clean the inbox.",
    steps: [
      { id: "s1", title: "Step one", dependsOn: [] },
      { id: "s2", title: "Step two", dependsOn: ["s1"] },
      { id: "s3", title: "Step three", dependsOn: ["s2"] },
    ],
  });

  type PlanStep = {
    id: string;
    title: string;
    dependsOn: string[];
    status: string;
    result?: string;
    evidenceIds?: string[];
  };

  const stepsOf = (fixture: ReturnType<typeof fixtureFor>, id: string) => {
    const row = fixture.rows.tasks.find((task) => task.id === id);
    return (row?.steps ?? []) as PlanStep[];
  };

  test("three linear steps run one per sweep, each through one runTurn carrying the step title", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    // The step is observed in each phase: pending before the sweep, running
    // while its turn is in flight, succeeded after it — in graph order.
    const stepRunningDuringTurn: string[] = [];
    fixture.setTurn(async (input) => {
      stepRunningDuringTurn.push(
        stepsOf(fixture, created.id).find((step) => step.status === "running")
          ?.id ?? "none",
      );
      return { replyText: `Done: ${input.instruction}` };
    });
    const first = await fixture.runner.sweep();
    expect(first.ran).toHaveLength(1);
    expect(stepRunningDuringTurn).toEqual(["s1"]);
    expect(stepsOf(fixture, created.id)).toEqual([
      {
        id: "s1",
        title: "Step one",
        dependsOn: [],
        status: "succeeded",
        result: "Done: Step one",
        evidenceIds: [`${created.id}:step:s1`],
      },
      { id: "s2", title: "Step two", dependsOn: ["s1"], status: "pending" },
      { id: "s3", title: "Step three", dependsOn: ["s2"], status: "pending" },
    ]);
    // One step per sweep: the task requeues between steps, re-offered under a
    // fresh queue identity the same seam resume and retry use.
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("queued");
    expect(fixture.queue.offered[1]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: created.id },
    });

    await fixture.runner.sweep();
    await fixture.runner.sweep();
    const settled = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(settled?.status).toBe("succeeded");
    expect(stepsOf(fixture, created.id).map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(fixture.turns.map((turn) => turn.instruction)).toEqual([
      "Step one",
      "Step two",
      "Step three",
    ]);
    expect(fixture.turns[0]).toMatchObject({
      ownerUserId: "user-1",
      agentId: "bot-1",
      threadId: "thread-1",
    });
    const evidenceIds = (settled?.evidence ?? []).map(
      (entry) => (entry as { id: string }).id,
    );
    expect(evidenceIds).toEqual([
      `${created.id}:step:s1`,
      `${created.id}:step:s2`,
      `${created.id}:step:s3`,
    ]);
  });

  test("a failure at step two retains step one, fails step two with its error, leaves step three pending", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    fixture.setTurn(async (input) => {
      if (input.instruction === "Step two") throw new Error("Step two broke.");
      return { replyText: "Done." };
    });
    await fixture.runner.sweep();
    const second = await fixture.runner.sweep();
    expect(second.ran).toHaveLength(0);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("failed");
    expect(stepsOf(fixture, created.id)).toEqual([
      {
        id: "s1",
        title: "Step one",
        dependsOn: [],
        status: "succeeded",
        result: "Done.",
        evidenceIds: [`${created.id}:step:s1`],
      },
      {
        id: "s2",
        title: "Step two",
        dependsOn: ["s1"],
        status: "failed",
        result: "Step two broke.",
      },
      { id: "s3", title: "Step three", dependsOn: ["s2"], status: "pending" },
    ]);
    expect(row?.evidence).toEqual([
      {
        id: `${created.id}:step:s1`,
        kind: "user",
        title: "Step one",
        excerpt: "Done.",
      },
    ]);
    // Stopped on failure: no re-offer beyond step one's own, and a further
    // sweep is a no-op — only an explicit retry starts anything new.
    expect(fixture.queue.offered).toHaveLength(2);
    expect(await fixture.runner.sweep()).toEqual({ ran: [], skipped: [] });
    expect(fixture.turns).toHaveLength(2);
  });

  test("restart mid-plan: a fresh store and runner over the same rows never re-runs the succeeded step", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    await fixture.runner.sweep();
    expect(stepsOf(fixture, created.id)[0]?.status).toBe("succeeded");
    // The worker restarts: new store and runner instances, same durable rows
    // and queue — the status check, not memory, decides what runs next.
    const instructions: string[] = [];
    const restarted = createOpenMuseTaskRunner({
      queue: fixture.queue,
      store: createOpenMuseTaskStore({
        rows: fixture.rows,
        queue: fixture.queue,
      }),
      owner: "replica",
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
        instructions.push(input.instruction);
        return { replyText: "Done." };
      },
    });
    const report = await restarted.sweep();
    expect(report.ran).toHaveLength(1);
    // Step one is never replayed; the next ready step runs.
    expect(instructions).toEqual(["Step two"]);
    expect(stepsOf(fixture, created.id).map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "pending",
    ]);
  });

  test("retry after a mid-plan failure re-runs from the failed step, retaining the succeeded step's evidence", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    let stepTwoFails = true;
    fixture.setTurn(async (input) => {
      if (input.instruction === "Step two" && stepTwoFails)
        throw new Error("Step two broke.");
      return { replyText: "Done." };
    });
    await fixture.runner.sweep();
    await fixture.runner.sweep();
    expect(
      fixture.rows.tasks.find((task) => task.id === created.id)?.status,
    ).toBe("failed");
    const retry = await fixture.app.request(`/${created.id}/retry`, {
      method: "POST",
    });
    expect(retry.status).toBe(200);
    const retried = (await retry.json()) as {
      status: string;
      attempts: number;
      steps: PlanStep[];
      evidence: unknown[];
    };
    expect(retried.status).toBe("queued");
    expect(retried.attempts).toBe(2);
    expect(retried.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "pending",
      "pending",
    ]);
    const evidenceBeforeRetry = retried.evidence;
    stepTwoFails = false;
    await fixture.runner.sweep();
    await fixture.runner.sweep();
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(2);
    // The new attempt re-ran from step two only; step one's evidence from
    // the first attempt is retained once, never duplicated or truncated.
    expect(fixture.turns.map((turn) => turn.instruction)).toEqual([
      "Step one",
      "Step two",
      "Step two",
      "Step three",
    ]);
    // The DTO's evidence carried no internal attempt stamps (the row's
    // retained history does), so compare modulo that stamp.
    const stripAttempt = (rows: unknown[]) =>
      rows.map((entry) => {
        if (entry === null || typeof entry !== "object") return entry;
        const { attempt: _attempt, ...rest } = entry as Record<string, unknown>;
        return rest;
      });
    expect(
      stripAttempt(row?.evidence ?? []).slice(0, evidenceBeforeRetry.length),
    ).toEqual(evidenceBeforeRetry);
    expect(
      (row?.evidence ?? []).filter(
        (entry) => (entry as { id: string }).id === `${created.id}:step:s1`,
      ),
    ).toHaveLength(1);
  });

  test("diamond graph: both branches run, in either order, before the join", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({
      kind: "plan",
      prompt: "p",
      steps: [
        { id: "s1", title: "Start", dependsOn: [] },
        { id: "s2a", title: "Left", dependsOn: ["s1"] },
        { id: "s2b", title: "Right", dependsOn: ["s1"] },
        { id: "s3", title: "Join", dependsOn: ["s2a", "s2b"] },
      ],
    });
    await fixture.runner.sweep();
    await fixture.runner.sweep();
    await fixture.runner.sweep();
    const midSteps = stepsOf(fixture, created.id);
    // After both branches: the join still waits — it cannot run before both.
    expect(fixture.turns.map((turn) => turn.instruction).slice(1)).toEqual(
      expect.arrayContaining(["Left", "Right"]),
    );
    expect(fixture.turns).toHaveLength(3);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("queued");
    expect(midSteps.find((step) => step.id === "s3")?.status).toBe("pending");
    await fixture.runner.sweep();
    const settled = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(settled?.status).toBe("succeeded");
    expect(fixture.turns[3]?.instruction).toBe("Join");
    expect(stepsOf(fixture, created.id).map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  test("pause mid-step parks the plan with the finished step succeeded; resume continues from the next", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    let pausedOnce = false;
    fixture.setTurn(async (input) => {
      if (input.instruction === "Step two" && !pausedOnce) {
        pausedOnce = true;
        await fixture.store.requestPause("user-1", created.id);
      }
      return { replyText: "Done." };
    });
    await fixture.runner.sweep();
    const halted = await fixture.runner.sweep();
    expect(halted.skipped).toHaveLength(1);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("paused");
    expect(stepsOf(fixture, created.id).map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "pending",
    ]);
    await fixture.store.resumeTask("user-1", created.id);
    await fixture.runner.sweep();
    const settled = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(settled?.status).toBe("succeeded");
    // Step two is never replayed after the resume: three turns total.
    expect(fixture.turns).toHaveLength(3);
    expect(fixture.turns[2]?.instruction).toBe("Step three");
  });

  test("an interrupted claim (T07 prior effect) fails the plan: succeeded steps retained, in-flight step failed, no turn runs", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask(linearPlan());
    await fixture.runner.sweep();
    // The worker dies mid-step-two: the row is left running with the step
    // running, and the lease's re-offer hands the item back at attempts 2.
    const rows = fixture.rows;
    const row = rows.tasks.find((task) => task.id === created.id);
    if (!row) throw new Error("missing fixture row");
    row.status = "running";
    row.steps = [
      ...row.steps.slice(0, 1),
      { ...(row.steps[1] as PlanStep), status: "running" },
      ...row.steps.slice(2),
    ];
    const turnsBefore = fixture.turns.length;
    const reoffered: Array<Record<string, unknown>> = [];
    // The queue's one-claim contract: the re-offered item is handed out
    // once, exactly as the real queue hands each item to one claim.
    let handedOut = false;
    const recovered = createOpenMuseTaskRunner({
      queue: {
        claim: async () => {
          if (handedOut) return [];
          handedOut = true;
          return [
            {
              kind: OPENMUSE_TASK_KIND,
              key: `${created.id}:recovery`,
              payload: { ownerUserId: "user-1", taskId: created.id },
              attempts: 2,
            },
          ];
        },
        finish: async () => true,
        purge: async () => 0,
        offer: async (item: { payload?: Record<string, unknown> }) => {
          reoffered.push(item.payload ?? {});
          return "queued" as const;
        },
      },
      store: fixture.store,
      owner: "replica",
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
      runTurn: async () => {
        throw new Error("no turn may run for an interrupted claim");
      },
    });
    const report = await recovered.sweep();
    expect(report.skipped).toHaveLength(1);
    // No replay of anything, and no new turn: the ambiguity is failed, not
    // guessed at. Step one stays succeeded; the in-flight step lands failed
    // with the reconciliation detail; the successor stays pending.
    expect(fixture.turns).toHaveLength(turnsBefore);
    const after = rows.tasks.find((task) => task.id === created.id);
    expect(after?.status).toBe("failed");
    const stepsAfter = stepsOf(fixture, created.id);
    expect(stepsAfter[0]).toMatchObject({ id: "s1", status: "succeeded" });
    expect(stepsAfter[1]?.status).toBe("failed");
    expect(stepsAfter[1]?.result).toContain("reconciliation");
    expect(stepsAfter[2]).toMatchObject({ id: "s3", status: "pending" });
    expect(reoffered).toHaveLength(0);
  });
});

describe("monitor checks (T10)", () => {
  /**
   * The queue with the real one's due semantics (work/queue.ts claim:
   * `run_at <= now()`): an offered item is claimable only at-or-after its
   * runAt, on the clock everyone in the fixture shares.
   */
  function scheduledQueue(now: () => Date) {
    const offered: Array<{
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
      runAt?: Date;
    }> = [];
    const finished: string[] = [];
    const waiting = new Map<
      string,
      { payload: Record<string, unknown>; runAt?: Date }
    >();
    return {
      offered,
      finished,
      offer: async (item: {
        kind: string;
        key: string;
        payload?: Record<string, unknown>;
        runAt?: Date;
      }) => {
        offered.push(item);
        if (waiting.has(item.key)) return "already" as const;
        waiting.set(item.key, {
          payload: item.payload ?? {},
          ...(item.runAt ? { runAt: item.runAt } : {}),
        });
        return "queued" as const;
      },
      claim: async (input: {
        kind: string;
        owner: string;
        leaseMs: number;
        limit?: number;
        maxAttempts?: number;
      }) =>
        [...waiting.entries()]
          .filter(
            ([key, item]) =>
              !finished.includes(key) &&
              (item.runAt === undefined ||
                item.runAt.getTime() <= now().getTime()),
          )
          .slice(0, input.limit ?? 1)
          .map(([key, item]) => {
            waiting.delete(key);
            return {
              kind: OPENMUSE_TASK_KIND,
              key,
              payload: item.payload,
              attempts: 1,
            };
          }),
      finish: async ({ key }: { key: string }) => {
        finished.push(key);
        return true;
      },
      purge: async () => 0,
    };
  }

  /** The T10 fixture: clock, runAt-aware queue, and the injected check seam. */
  function monitorFixture(deadlineMs?: number) {
    const clock = clockAt("2026-10-01T00:00:00Z");
    const queue = scheduledQueue(clock.now);
    const rows = fakeRows(clock.now);
    const store = createOpenMuseTaskStore({
      rows,
      queue,
      now: clock.now,
    });
    const checks: StoredOpenMuseTask[] = [];
    let observation = "price 245.10";
    let midCheck: (() => Promise<void>) | null = null;
    // T12: the emitted notifications, collected for the match tests below.
    const events: Array<{
      userId: string;
      taskId: string;
      eventKind: string;
      attemptKey: string;
      title: string;
      detail?: string;
    }> = [];
    const runner = createOpenMuseTaskRunner({
      queue,
      store,
      owner: "replica",
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
      // A monitor never runs a Bot turn: its checks go through the seam below.
      runTurn: async () => {
        throw new Error("a monitor never runs a turn");
      },
      checkMonitor: async (task) => {
        checks.push(task);
        if (midCheck) await midCheck();
        return { observation };
      },
      now: clock.now,
      emitNotification: async (event) => {
        events.push(event);
      },
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });
    return {
      clock,
      queue,
      rows,
      store,
      runner,
      checks,
      events,
      createMonitor: (intervalMinutes = 30) =>
        store.create({
          ownerUserId: "user-1",
          botId: "bot-1",
          kind: "monitor",
          prompt: "Ping me under 250.",
          condition: {
            type: "price_below",
            intervalMinutes,
            source: "https://shop.example/widget",
            threshold: 250,
          },
          idempotencyKey: null,
        }),
      setObservation: (text: string) => {
        observation = text;
      },
      setMidCheck: (hook: (() => Promise<void>) | null) => {
        midCheck = hook;
      },
    };
  }

  const rowOf = (fixture: ReturnType<typeof monitorFixture>, id: string) =>
    fixture.rows.tasks.find((task) => task.id === id);

  test("before nextCheckAt the claim is not due: no check, nothing changes", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.clock.advance(29);
    expect(await fixture.runner.sweep()).toEqual({ ran: [], skipped: [] });
    expect(fixture.checks).toHaveLength(0);
    expect(rowOf(fixture, task.id)?.status).toBe("scheduled");
  });

  test("at nextCheckAt the check runs once: observation evidence, nextCheckAt advanced by interval, back to scheduled, re-offered at the new instant", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.clock.advance(30);
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    expect(fixture.checks).toHaveLength(1);
    // The seam saw the condition it checks.
    expect(fixture.checks[0]?.monitorCondition).toMatchObject({
      type: "price_below",
      threshold: 250,
    });
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T01:00:00.000Z");
    // One observation row for this check, keyed by the check's due instant;
    // no run step is fabricated — the evidence is the record. T11: the row
    // carries its match verdict (245.10 < 250) — T12's notification seam.
    expect(row?.evidence).toEqual([
      {
        id: `${task.id}:observation:2026-10-01T00:30:00.000Z`,
        kind: "web",
        title: "Monitor observation",
        excerpt: "price 245.10",
        matched: true,
      },
    ]);
    expect(row?.steps).toEqual([]);
    // The next check is its own piece of work, offered at its due instant.
    expect(fixture.queue.offered).toHaveLength(2);
    expect(fixture.queue.offered[1]?.key.startsWith(`${task.id}:`)).toBe(true);
    expect(fixture.queue.offered[1]?.runAt?.toISOString()).toBe(
      "2026-10-01T01:00:00.000Z",
    );
    // Not due again until the new instant: one check per interval.
    expect(await fixture.runner.sweep()).toEqual({ ran: [], skipped: [] });
    expect(fixture.checks).toHaveLength(1);
  });

  test("the cycle repeats: each due check appends its own observation row", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.clock.advance(30);
    await fixture.runner.sweep();
    fixture.setObservation("price 244.80");
    fixture.clock.advance(30);
    const second = await fixture.runner.sweep();
    expect(second.ran).toHaveLength(1);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T01:30:00.000Z");
    expect(row?.evidence).toEqual([
      {
        id: `${task.id}:observation:2026-10-01T00:30:00.000Z`,
        kind: "web",
        title: "Monitor observation",
        excerpt: "price 245.10",
        matched: true,
      },
      {
        id: `${task.id}:observation:2026-10-01T01:00:00.000Z`,
        kind: "web",
        title: "Monitor observation",
        excerpt: "price 244.80",
        matched: true,
      },
    ]);
  });

  test("a change-heavy monitor's evidence is capped: only the latest rows are kept", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    const row = rowOf(fixture, task.id);
    if (!row) throw new Error("row missing");
    for (let index = 0; index < 50; index += 1)
      row.evidence.push({
        id: `${task.id}:observation:seed-${index}`,
        kind: "web",
        title: "Monitor observation",
        excerpt: `price 240.${index}`,
        matched: false,
      });
    fixture.clock.advance(30);
    fixture.setObservation("price 239.99");
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    // 50 retained + 1 new = 51 → capped back to the latest 50: the oldest
    // seeded row is pruned, the new observation lands at the tail. The row's
    // jsonb column no longer grows without bound for drifting sources.
    expect(row.evidence).toHaveLength(50);
    expect(
      row.evidence.some(
        (entry) =>
          (entry as { id?: string }).id === `${task.id}:observation:seed-0`,
      ),
    ).toBe(false);
    expect(
      row.evidence.some(
        (entry) =>
          (entry as { id?: string }).id === `${task.id}:observation:seed-1`,
      ),
    ).toBe(true);
    expect(row.evidence[49]).toMatchObject({
      title: "Monitor observation",
      excerpt: "price 239.99",
      matched: true,
    });
  });

  test("a hanging check cannot stall the sweep: the deadline races it into the backoff path", async () => {
    const fixture = monitorFixture(20);
    const { task } = await fixture.createMonitor(30);
    fixture.clock.advance(30);
    fixture.setMidCheck(() => new Promise(() => {}));
    const report = await fixture.runner.sweep();
    // The sweep completes: the check that never returns loses the deadline
    // race exactly as a turn does, and the failure lands in the T11 backoff.
    expect(report.skipped).toHaveLength(1);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.monitorFailureStreak).toBe(1);
    expect(
      row?.evidence.some((entry) =>
        /timed out/i.test(String((entry as { excerpt?: string }).excerpt)),
      ),
    ).toBe(true);
  });

  test("a failed check completes its cycle: failure note, backoff re-arm, stays scheduled", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.setMidCheck(async () => {
      throw new Error("the source refused the read");
    });
    fixture.clock.advance(30);
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(0);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("scheduled");
    // T11: the first failure backs off 15 minutes, not the interval.
    expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T00:45:00.000Z");
    expect(row?.evidence).toEqual([
      {
        id: `${task.id}:observation:2026-10-01T00:30:00.000Z`,
        kind: "web",
        title: "Check failed",
        excerpt: "the source refused the read",
      },
    ]);
    expect(fixture.queue.offered[1]?.runAt?.toISOString()).toBe(
      "2026-10-01T00:45:00.000Z",
    );
  });

  test("a stop landing during a FAILED check is consumed, never wedged behind the backoff", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.setMidCheck(async () => {
      // The owner cancels while the source is failing: requestCancel on a
      // `running` row only raises the internal flag, and the failure path
      // must honour it at its own safe boundary — or a persistently broken
      // source would wedge the stop behind the backoff forever.
      await fixture.store.requestCancel("user-1", task.id);
      throw new Error("the source refused the read");
    });
    fixture.clock.advance(30);
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(0);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("cancelled");
    // The failure is still recorded, and no re-offer ever appears.
    expect(row?.evidence.at(-1)).toMatchObject({
      title: "Check failed",
      excerpt: "the source refused the read",
    });
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("cancel during scheduled: at the due instant the row is claimed but never checks, no new offer appears", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    await fixture.store.requestCancel("user-1", task.id);
    fixture.clock.advance(30);
    // The due queue row is claimed and finished — reported as a skip, never a check.
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [task.id],
    });
    expect(fixture.checks).toHaveLength(0);
    expect(rowOf(fixture, task.id)?.status).toBe("cancelled");
    // Creation's offer only: stop prevented every later one.
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("pause during scheduled: same; resume re-arms and the next due check runs", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    await fixture.store.requestPause("user-1", task.id);
    fixture.clock.advance(30);
    expect(await fixture.runner.sweep()).toEqual({
      ran: [],
      skipped: [task.id],
    });
    expect(fixture.checks).toHaveLength(0);
    expect(rowOf(fixture, task.id)?.status).toBe("paused");
    expect(fixture.queue.offered).toHaveLength(1);

    // Five more minutes pass; resume re-arms now+interval (T0+65).
    fixture.clock.advance(5);
    await fixture.store.resumeTask("user-1", task.id);
    const reoffered = fixture.queue.offered[1];
    expect(reoffered?.runAt?.toISOString()).toBe("2026-10-01T01:05:00.000Z");
    fixture.clock.advance(30);
    const rerun = await fixture.runner.sweep();
    expect(rerun.ran).toHaveLength(1);
    expect(fixture.checks).toHaveLength(1);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("scheduled");
    expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T01:35:00.000Z");
    // The observation row is keyed by the check that actually ran (T0+65).
    expect(row?.evidence).toEqual([
      {
        id: `${task.id}:observation:2026-10-01T01:05:00.000Z`,
        kind: "web",
        title: "Monitor observation",
        excerpt: "price 245.10",
        matched: true,
      },
    ]);
  });

  test("cancel mid-check settles cancelled with the observation recorded; no new offer", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.setMidCheck(async () => {
      await fixture.store.requestCancel("user-1", task.id);
    });
    fixture.clock.advance(30);
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(0);
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("cancelled");
    const evidence = (row?.evidence ?? []) as Array<{
      id: string;
      title: string;
    }>;
    expect(evidence.map((entry) => entry.id)).toEqual([
      `${task.id}:observation:2026-10-01T00:30:00.000Z`,
      `${task.id}:cancel`,
    ]);
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("pause mid-check settles paused with the observation recorded", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.setMidCheck(async () => {
      await fixture.store.requestPause("user-1", task.id);
    });
    fixture.clock.advance(30);
    await fixture.runner.sweep();
    const row = rowOf(fixture, task.id);
    expect(row?.status).toBe("paused");
    const evidence = (row?.evidence ?? []) as Array<{ id: string }>;
    expect(evidence.map((entry) => entry.id)).toEqual([
      `${task.id}:observation:2026-10-01T00:30:00.000Z`,
      `${task.id}:pause`,
    ]);
    expect(fixture.queue.offered).toHaveLength(1);
  });

  /*
   * T11 (issue #68): observation identity and failure backoff. Identity is
   * sha256(monitorId + normalizedSource + normalizedValue) — the SAME
   * observation emits ONE item even across restarts; a NEW match emits one.
   * Failures back off 15/30/60 minutes, capped at six hours, reset on success.
   */
  describe("monitor observation identity, dedup and backoff (T11)", () => {
    test("normalization: source trimmed/lowercased with trailing slashes collapsed; value canonical per kind", () => {
      // Source: one URL-or-text normal form — trim, lowercase, drop trailing slashes.
      expect(
        normalizeObservation(
          {
            type: "change",
            intervalMinutes: 30,
            source: "  HTTPS://Shop.Example/Widget/  ",
          },
          "x",
        ).source,
      ).toBe("https://shop.example/widget");
      expect(
        normalizeObservation(
          { type: "change", intervalMinutes: 30, source: "Gmail:Inbox" },
          "x",
        ).source,
      ).toBe("gmail:inbox");
      // A sourceless condition (price_below's source is optional) hashes "".
      expect(
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "price 245.10",
        ).source,
      ).toBe("");
      // change → the trimmed string.
      expect(
        normalizeObservation(
          { type: "change", intervalMinutes: 30, source: "https://e.com/s" },
          "  same text  \n",
        ).value,
      ).toBe("same text");
      // contains → the bool of the match, as its canonical string.
      const contains = {
        type: "contains" as const,
        intervalMinutes: 30,
        source: "https://example.com/status",
        selector: "degraded",
      };
      expect(
        normalizeObservation(contains, "All systems degraded\n").value,
      ).toBe("true");
      expect(
        normalizeObservation(contains, "All systems operational").value,
      ).toBe("false");
      // A contains condition without a selector cannot match.
      expect(
        normalizeObservation(
          {
            type: "contains",
            intervalMinutes: 30,
            source: "https://example.com/status",
          },
          "degraded",
        ).value,
      ).toBe("false");
      // price_below → fixed two-decimal string.
      expect(
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "price 12.3",
        ).value,
      ).toBe("12.30");
      expect(
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "$12",
        ).value,
      ).toBe("12.00");
      // Thousands separators are stripped before the scan: "1,000.50" must
      // read as 1000.50, not truncate at the comma to 1.00.
      expect(
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "US$1,299.99",
        ).value,
      ).toBe("1299.99");
      expect(
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "now 1,000.50",
        ).value,
      ).toBe("1000.50");
      // A page with no readable price is an error, never a made-up value.
      expect(() =>
        normalizeObservation(
          { type: "price_below", intervalMinutes: 30, threshold: 250 },
          "no digits here",
        ),
      ).toThrow();
    });

    test("identity: same monitorId+source+value hashes equal (fixture vectors); any component differs", () => {
      // Fixture vectors — the exact recipe is part of the contract.
      expect(
        observationHash(
          "openmuse-task-fixture-1",
          "https://shop.example/widget",
          "245.10",
        ),
      ).toBe(
        "c6cdb2011fd40cd12a88706b83a12b0c6564f42a6cb56ea703640cde46eae21a",
      );
      expect(
        observationHash(
          "openmuse-task-fixture-1",
          "https://shop.example/widget",
          "244.80",
        ),
      ).toBe(
        "592ff66a9086bb32cc342eaccb9daf89972c6c70fc3f991cad01fa8a30c311e4",
      );
      expect(
        observationHash(
          "openmuse-task-fixture-2",
          "https://shop.example/widget",
          "245.10",
        ),
      ).toBe(
        "18dcb3859650e08c174019da45454000ae593563bb646586c313ed53d6cf32ef",
      );
      // Source variants that normalize equal hash equal — through the seam.
      const slashed = normalizeObservation(
        {
          type: "price_below",
          intervalMinutes: 30,
          threshold: 250,
          source: "HTTPS://Shop.Example/Widget/",
        },
        "price 245.10",
      );
      const plain = normalizeObservation(
        {
          type: "price_below",
          intervalMinutes: 30,
          threshold: 250,
          source: "https://shop.example/widget",
        },
        "price 245.10",
      );
      expect(slashed.source).toBe(plain.source);
      expect(
        observationHash(
          "openmuse-task-fixture-1",
          slashed.source,
          slashed.value,
        ),
      ).toBe(
        observationHash("openmuse-task-fixture-1", plain.source, plain.value),
      );
    });

    test("backoff minutes: 15/30/60 doubling, capped at six hours", () => {
      expect([1, 2, 3, 4, 5, 6, 8, 20].map(backoffMinutes)).toEqual([
        15, 30, 60, 120, 240, 360, 360, 360,
      ]);
    });

    test("dedup: the same observation emits nothing — zero new rows, no match signal, interval re-arm (not backoff)", async () => {
      const fixture = monitorFixture();
      const { task } = await fixture.createMonitor(30);
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      fixture.clock.advance(30);
      const second = await fixture.runner.sweep();
      expect(second.ran).toHaveLength(1);
      const row = rowOf(fixture, task.id);
      // ZERO new evidence rows — and therefore no matched row, no match signal.
      expect(row?.evidence).toHaveLength(1);
      expect(
        (row?.evidence[0] as { matched?: boolean } | undefined)?.matched,
      ).toBe(true);
      expect(row?.status).toBe("scheduled");
      // The interval re-arms normally — a repeated observation is not a failure.
      expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T01:30:00.000Z");
      expect(row?.monitorFailureStreak).toBe(0);
      expect(fixture.queue.offered.at(-1)?.runAt?.toISOString()).toBe(
        "2026-10-01T01:30:00.000Z",
      );
    });

    test("new observation: one evidence row with the match verdict, cursor hash+time updated", async () => {
      const fixture = monitorFixture();
      const { task } = await fixture.createMonitor(30);
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      fixture.setObservation("price 244.80");
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      const row = rowOf(fixture, task.id);
      expect(row?.evidence).toHaveLength(2);
      expect(
        (row?.evidence[1] as { matched?: boolean } | undefined)?.matched,
      ).toBe(true);
      // The cursor is the committed observation's identity and time.
      expect(row?.lastObservationHash).toBe(
        observationHash(task.id, "https://shop.example/widget", "244.80"),
      );
      expect(row?.lastObservationAt?.toISOString()).toBe(
        "2026-10-01T01:00:00.000Z",
      );
    });

    test("a change monitor's first observation is the baseline: the row lands, the verdict is not a match", async () => {
      const fixture = monitorFixture();
      const { task } = await fixture.store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "monitor",
        prompt: "Tell me when it changes.",
        condition: {
          type: "change",
          intervalMinutes: 30,
          source: "https://example.com/status",
        },
        idempotencyKey: null,
      });
      fixture.setObservation("  revision one  ");
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      let row = rowOf(fixture, task.id);
      expect(row?.evidence).toHaveLength(1);
      expect(
        (row?.evidence[0] as { matched?: boolean } | undefined)?.matched,
      ).toBe(false);
      expect(row?.lastObservationHash).toBe(
        observationHash(task.id, "https://example.com/status", "revision one"),
      );
      // The same content again: nothing new; changed content: a match.
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      fixture.setObservation("revision two");
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      row = rowOf(fixture, task.id);
      expect(row?.evidence).toHaveLength(2);
      expect(
        (row?.evidence[1] as { matched?: boolean } | undefined)?.matched,
      ).toBe(true);
    });

    test("restart: a re-instantiated store still dedups the repeated observation (cursor persisted)", async () => {
      const fixture = monitorFixture();
      const { task } = await fixture.createMonitor(30);
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      // A restart: fresh store and runner over the SAME rows. The pending
      // queue row stands in manually — in production it is the database's.
      const queue = scheduledQueue(fixture.clock.now);
      const store = createOpenMuseTaskStore({
        rows: fixture.rows,
        queue,
        now: fixture.clock.now,
      });
      const runner = createOpenMuseTaskRunner({
        queue,
        store,
        owner: "replica",
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
        runTurn: async () => {
          throw new Error("a monitor never runs a turn");
        },
        checkMonitor: async () => ({ observation: "price 245.10" }),
        now: fixture.clock.now,
      });
      await queue.offer({
        kind: OPENMUSE_TASK_KIND,
        key: `${task.id}:restart`,
        payload: { ownerUserId: "user-1", taskId: task.id },
      });
      fixture.clock.advance(30);
      const report = await runner.sweep();
      expect(report.ran).toHaveLength(1);
      // Still exactly one observation row — the cursor survived the restart.
      expect(rowOf(fixture, task.id)?.evidence).toHaveLength(1);
    });

    test("backoff: three failures delay 15/30/60 minutes; a success resets to the configured interval", async () => {
      const fixture = monitorFixture();
      const { task } = await fixture.createMonitor(30);
      fixture.setMidCheck(async () => {
        throw new Error("the source refused the read");
      });
      const dueAt = () => rowOf(fixture, task.id)?.nextCheckAt?.toISOString();
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      expect(dueAt()).toBe("2026-10-01T00:45:00.000Z");
      fixture.clock.advance(15);
      await fixture.runner.sweep();
      expect(dueAt()).toBe("2026-10-01T01:15:00.000Z");
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      expect(dueAt()).toBe("2026-10-01T02:15:00.000Z");
      expect(rowOf(fixture, task.id)?.monitorFailureStreak).toBe(3);
      // A success resets: the interval re-arms and the streak clears.
      fixture.setMidCheck(null);
      fixture.clock.advance(60);
      await fixture.runner.sweep();
      const row = rowOf(fixture, task.id);
      expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T02:45:00.000Z");
      expect(row?.monitorFailureStreak).toBe(0);
      // The next failure starts the sequence over at 15 minutes.
      fixture.setMidCheck(async () => {
        throw new Error("down again");
      });
      fixture.clock.advance(30);
      await fixture.runner.sweep();
      expect(dueAt()).toBe("2026-10-01T03:00:00.000Z");
    });

    test("long failure runs cap at six hours", async () => {
      const fixture = monitorFixture();
      await fixture.createMonitor(30);
      fixture.setMidCheck(async () => {
        throw new Error("down");
      });
      fixture.clock.advance(30);
      const delays: number[] = [];
      let previous = fixture.clock.now().getTime();
      for (let check = 0; check < 8; check += 1) {
        await fixture.runner.sweep();
        const due = rowOf(
          fixture,
          fixture.rows.tasks[0]?.id ?? "",
        )?.nextCheckAt;
        const delay = ((due?.getTime() ?? previous) - previous) / 60_000;
        delays.push(delay);
        previous = due?.getTime() ?? previous;
        fixture.clock.advance(delay);
      }
      expect(delays).toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
    });
  });

  test("T12: a matched observation emits monitor.matched keyed by the observation hash; a repeated one emits none", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.createMonitor(30);
    fixture.clock.advance(30);
    // price_below under 250: the default observation matches.
    await fixture.runner.sweep();
    expect(fixture.events).toEqual([
      {
        userId: "user-1",
        taskId: task.id,
        eventKind: "monitor.matched",
        attemptKey: observationHash(
          task.id,
          "https://shop.example/widget",
          "245.10",
        ),
        title: "Monitor matched",
        detail: "price 245.10",
      },
    ]);
    // The same observation again is the SAME one: no second notification.
    fixture.clock.advance(30);
    await fixture.runner.sweep();
    expect(fixture.events).toHaveLength(1);
  });
});

/*
 * T13: a finance Task's whole run — no Bot turn, just the openmuse-files
 * seam: read the owner's CSV, refuse or summarize, upload the summary as a
 * new owner-scoped File, link it through artifactIds. The fake mirrors the
 * files store's owner scope and its owner-scoped upload idempotency.
 */
describe("finance tasks (T13)", () => {
  const FIXTURE_CSV = [
    "date,description,amount,category",
    "2026-09-01,Salary,-4200.00,Income",
    "2026-09-02,Groceries,84.50,Food",
    "2026-09-03,Coffee,6.50,Food",
  ].join("\n");
  // Prior art numbers rows by CSV line, header = line 1: 6.501 on line 4.
  const BAD_AMOUNT_CSV = [
    "date,description,amount,category",
    "2026-09-01,Salary,-4200.00,Income",
    "2026-09-02,Groceries,84.50,Food",
    "2026-09-03,Tip,6.501,Food",
  ].join("\n");

  function fakeFiles() {
    const owned = new Map<string, { ownerUserId: string; bytes: Uint8Array }>();
    const uploads: Array<{
      ownerUserId: string;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
      idempotencyKey: string | null;
    }> = [];
    const byIdempotencyKey = new Map<string, string>();
    let serial = 0;
    let gate: Promise<void> | null = null;
    return {
      uploads,
      /** Stores one CSV the named owner owns; answers its File id. */
      addCsv(ownerUserId: string, csv: string): string {
        const id = `csv-${++serial}`;
        owned.set(id, { ownerUserId, bytes: Buffer.from(csv, "utf8") });
        return id;
      },
      /** T13: the file deleted between creation and the run — the race the
       * creation-time ownership check cannot see, the runner still must. */
      removeFile(id: string) {
        owned.delete(id);
      },
      /** Holds the next read open — the mid-run window a stop lands in. */
      holdNextRead(promise: Promise<void>) {
        gate = promise;
      },
      getOwnedFile: async (ownerUserId: string, id: string) => {
        if (gate) {
          await gate;
          gate = null;
        }
        const file = owned.get(id);
        if (!file || file.ownerUserId !== ownerUserId) return null;
        return {
          file: {
            id,
            name: `${id}.csv`,
            mimeType: "text/csv",
            size: file.bytes.byteLength,
            sha256: `${id}-sha`,
            versionId: `${id}-v1`,
            createdAt: new Date(),
          },
          read: async () => file.bytes,
        };
      },
      upload: async (input: {
        ownerUserId: string;
        name: string;
        mimeType: string;
        bytes: Uint8Array;
        idempotencyKey: string | null;
      }) => {
        const key =
          input.idempotencyKey === null
            ? null
            : `${input.ownerUserId}:${input.idempotencyKey}`;
        if (key !== null && byIdempotencyKey.has(key)) {
          const id = byIdempotencyKey.get(key) as string;
          return {
            file: {
              id,
              name: input.name,
              mimeType: input.mimeType,
              size: input.bytes.byteLength,
              sha256: `${id}-sha`,
              versionId: `${id}-v1`,
              createdAt: new Date(),
            },
            deduplicated: true,
          };
        }
        const id = `artifact-${++serial}`;
        uploads.push(input);
        if (key !== null) byIdempotencyKey.set(key, id);
        return {
          file: {
            id,
            name: input.name,
            mimeType: input.mimeType,
            size: input.bytes.byteLength,
            sha256: `${id}-sha`,
            versionId: `${id}-v1`,
            createdAt: new Date(),
          },
          deduplicated: false,
        };
      },
    };
  }

  function financeFixture() {
    const files = fakeFiles();
    return { ...fixtureFor({ files }), files };
  }

  test("a valid CSV settles succeeded with an owner-scoped artifact File and no Bot turn", async () => {
    const fixture = financeFixture();
    const csvFileId = fixture.files.addCsv("user-1", FIXTURE_CSV);
    const task = await fixture.postTask({ kind: "finance", csvFileId });
    const report = await fixture.runner.sweep();
    expect(report.ran).toEqual([task.id]);
    expect(fixture.turns).toHaveLength(0);
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("succeeded");
    expect(row?.artifactIds).toHaveLength(1);
    expect(fixture.files.uploads).toHaveLength(1);
    const upload = fixture.files.uploads[0];
    expect(upload.ownerUserId).toBe("user-1");
    expect(upload.mimeType).toBe("application/json");
    // One artifact per Task across re-runs: the files store's owner-scoped key.
    expect(upload.idempotencyKey).toBe(`openmuse-finance:${task.id}`);
    const artifact = JSON.parse(Buffer.from(upload.bytes).toString("utf8"));
    expect(artifact).toMatchObject({
      income: "4200.00",
      spending: "91.00",
      saved: "4109.00",
      byCategory: { Food: "91.00" },
      count: 3,
    });
    const evidence = (row?.evidence ?? []) as Array<{
      kind: string;
      title: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "file",
        title: "Transaction summary",
        excerpt: expect.stringContaining("saved 4109.00"),
      }),
    );
    const steps = (row?.steps ?? []) as Array<{ id: string; status: string }>;
    expect(steps).toContainEqual(
      expect.objectContaining({ id: "run", status: "succeeded" }),
    );
  });

  test("a bad amount refuses the whole CSV: failed with the row number, no artifact", async () => {
    const fixture = financeFixture();
    const csvFileId = fixture.files.addCsv("user-1", BAD_AMOUNT_CSV);
    const task = await fixture.postTask({ kind: "finance", csvFileId });
    const report = await fixture.runner.sweep();
    expect(report.skipped).toEqual([task.id]);
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    expect(row?.artifactIds).toEqual([]);
    expect(fixture.files.uploads).toHaveLength(0);
    const steps = (row?.steps ?? []) as Array<{
      id: string;
      status: string;
      result: string;
    }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        status: "failed",
        result: expect.stringMatching(/Row 4/),
      }),
    );
    const evidence = (row?.evidence ?? []) as Array<{
      title: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        title: "Import refused",
        excerpt: expect.stringMatching(/Row 4/),
      }),
    );
  });

  test("a missing or foreign CSV file settles failed with no artifact", async () => {
    const fixture = financeFixture();
    // Updated with the T13 finding fix (ocr-ob-certify, finding 29): a CSV the
    // caller does not own is refused at CREATION now (404, see the routes
    // suite), so the run-time failure this test pins is reached through the
    // race the creation check cannot close — the File deleted after creation.
    const csvFileId = fixture.files.addCsv("user-1", FIXTURE_CSV);
    const task = await fixture.postTask({ kind: "finance", csvFileId });
    fixture.files.removeFile(csvFileId);
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    expect(row?.artifactIds).toEqual([]);
    expect(fixture.files.uploads).toHaveLength(0);
    const steps = (row?.steps ?? []) as Array<{ id: string; result: string }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        result: expect.stringMatching(/could not be read/i),
      }),
    );
  });

  test("a cancel requested mid-run lands cancelled with the artifact recorded", async () => {
    const fixture = financeFixture();
    const csvFileId = fixture.files.addCsv("user-1", FIXTURE_CSV);
    const task = await fixture.postTask({ kind: "finance", csvFileId });
    let release = () => {};
    fixture.files.holdNextRead(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const sweeping = fixture.runner.sweep();
    for (
      let i = 0;
      i < 100 &&
      (await fixture.store.get("user-1", task.id))?.status !== "running";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    await fixture.store.requestCancel("user-1", task.id);
    release();
    await sweeping;
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("cancelled");
    // The artifact already exists, so it is linked beside the terminal
    // status, exactly as a monitor records its last observation.
    expect(row?.artifactIds).toHaveLength(1);
    expect(fixture.turns).toHaveLength(0);
  });

  test("without the files seam wired a finance task fails loudly, never silently", async () => {
    // Updated with the T13 finding fix (ocr-ob-certify, finding 29): the ROUTES
    // now answer 503 without the seam (pinned in openmuse-tasks.test.ts), so
    // the runner's own unwired-seam default — the loud refusal a row created
    // through the store seam still meets — is pinned through store.create.
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "finance",
      prompt: "file-1",
      idempotencyKey: null,
    });
    await fixture.queue.offer({
      kind: OPENMUSE_TASK_KIND,
      key: task.id,
      payload: { ownerUserId: "user-1" },
    });
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    const steps = (row?.steps ?? []) as Array<{ id: string; result: string }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        result: expect.stringMatching(/finance.*seam|seam.*finance/i),
      }),
    );
  });
});

describe("task notifications (T12)", () => {
  test("a successful turn emits one task.succeeded keyed by the attempt; never a waiting_review", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "a" });
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    expect(fixture.events).toEqual([
      {
        userId: "user-1",
        taskId: created.id,
        eventKind: "task.succeeded",
        attemptKey: "1",
        title: "Task succeeded",
        detail: "Done.",
      },
    ]);
    // waiting_review is T16's: no producer emits it yet.
    expect(
      fixture.events.some((event) => event.eventKind === "task.waiting_review"),
    ).toBe(false);
  });

  test("a rejecting turn emits task.failed with the error's detail", async () => {
    const fixture = fixtureFor();
    fixture.setTurn(async () => {
      throw new Error("the model refused");
    });
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.runner.sweep();
    expect(fixture.events).toEqual([
      {
        userId: "user-1",
        taskId: created.id,
        eventKind: "task.failed",
        attemptKey: "1",
        title: "Task failed",
        detail: "the model refused",
      },
    ]);
  });

  test("a flagged wait opens task.waiting_input with the question as its detail", async () => {
    const fixture = fixtureFor({
      inputWaitOf: ({ replyText }) =>
        replyText === "What size?"
          ? {
              question: "What size?",
              fields: [{ name: "size", type: "string" }],
            }
          : null,
    });
    fixture.setTurn(async () => ({ replyText: "What size?" }));
    const created = await fixture.postTask({ prompt: "a" });
    await fixture.runner.sweep();
    expect(fixture.events).toEqual([
      {
        userId: "user-1",
        taskId: created.id,
        eventKind: "task.waiting_input",
        attemptKey: "1",
        title: "Task needs your answer",
        detail: "What size?",
      },
    ]);
  });

  test("an emit that throws never fails the transition: the row still settles succeeded", async () => {
    const fixture = fixtureFor({
      emitNotification: async () => {
        throw new Error("notification store down");
      },
    });
    const created = await fixture.postTask({ prompt: "a" });
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(row?.status).toBe("succeeded");
  });
});

/** The §5 P-1-like vector: two fillable fields and one unsupported dropdown. */
const P1_FIELDS = [
  { kind: "text", name: "person.name", maxChars: 40 },
  { kind: "checkbox", name: "consent" },
  { kind: "dropdown", name: "region" },
] as const;

function documentFixture(
  extractFields: ReadonlyArray<{ kind: string; name: string }> = P1_FIELDS,
) {
  // The source File row: what the fill must never touch.
  const source = {
    id: "doc-1",
    ownerUserId: "user-1",
    versionId: "doc-1-v1",
    sha256: "doc-1-sha",
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
  const fills: Array<{
    supported: unknown;
    values: Record<string, string | boolean>;
  }> = [];
  const appended: Array<{
    ownerUserId: string;
    fileId: string;
    bytes: Uint8Array;
    parentVersionId: string;
    values: Record<string, string | boolean>;
    versionId: string;
  }> = [];
  let appendedSerial = 0;
  const files = {
    getOwnedFile: async (
      ownerUserId: string,
      id: string,
    ): Promise<{
      file: {
        id: string;
        name: string;
        mimeType: string;
        size: number;
        sha256: string;
        versionId: string;
        createdAt: Date;
      };
      read: () => Promise<Uint8Array>;
    } | null> => {
      if (source.id !== id || source.ownerUserId !== ownerUserId) return null;
      return {
        file: {
          id: source.id,
          name: "form.pdf",
          mimeType: "application/pdf",
          size: source.bytes.byteLength,
          sha256: source.sha256,
          versionId: source.versionId,
          createdAt: new Date(),
        },
        read: async () => source.bytes,
      };
    },
    upload: async () => {
      throw new Error("A document task never uploads; it appends versions.");
    },
    appendVersion: async (input: {
      ownerUserId: string;
      fileId: string;
      bytes: Uint8Array;
      parentVersionId: string;
      values: Record<string, string | boolean>;
    }) => {
      appendedSerial += 1;
      const versionId = `doc-1-v${appendedSerial + 1}`;
      appended.push({ ...input, versionId });
      return {
        versionId,
        fileId: input.fileId,
        bytePath: `bytes/${versionId}`,
        sha256: `sha-${versionId}`,
        createdAt: new Date(),
        parentVersionId: input.parentVersionId,
        values: input.values,
      };
    },
  };
  const extractCalls: number[] = [];
  const extract: import("../src/openmuse-documents/inspect").PdfFieldExtractor =
    async (bytes) => {
      extractCalls.push(bytes.byteLength);
      return {
        pageCount: 1,
        fields: extractFields.map((field) => ({
          ...field,
        })) as import("../src/openmuse-documents/inspect").ExtractedPdfField[],
      };
    };
  /*
   * R6's M26 made the seam loader-shaped: the adapter owns parsing. The fake
   * has no real PDF to parse, so it derives from the source bytes it closes
   * over — the same bytes the pre-M26 bytes-shaped seam received.
   */
  const fill: import("../src/openmuse-documents/fill").PdfFillAdapter = async (
    load,
    supported,
    values,
  ) => {
    expect(typeof load).toBe("function");
    fills.push({ supported, values });
    return new Uint8Array([...source.bytes, 9]);
  };
  const fixture = fixtureFor({ files, extract, fill });
  return {
    ...fixture,
    files,
    extract,
    fill,
    extractCalls,
    fills,
    appended,
    source,
  };
}

/*
 * T15 (§7 document flow): the runner's document cycle. The first sweep
 * inspects the bound PDF File (F05's seam) and opens ONE T08 input wait
 * carrying the required field schema; no fill happens before the answer.
 * The owner's valid answer consumes the wait (T08's CAS), the re-offered run
 * fills ONE derived version through F06's validateFill+applyFill with exactly
 * the answered values, and the row settles succeeded with the derived version
 * on artifactIds — the source File row is only ever read. The P-1-like
 * fixture (person.name text, consent checkbox, unsupported dropdown region)
 * mirrors the §5 contract vector; the live S29 end-to-end (a real imported
 * PDF through Gmail) is the integration step's evidence.
 */
describe("document tasks (T15)", () => {
  async function postDocumentTask(
    fixture: ReturnType<typeof documentFixture>,
  ): Promise<StoredOpenMuseTask & { id: string }> {
    return fixture.postTask({
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
    });
  }

  test("the inspect run opens one T08 wait with the P-1 schema; zero fills before the answer", async () => {
    const fixture = documentFixture();
    const task = await postDocumentTask(fixture);
    const report = await fixture.runner.sweep();
    expect(report.ran).toEqual([task.id]);
    // No Bot turn: the inspection is the executor, exactly as finance's parser.
    expect(fixture.turns).toHaveLength(0);
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("waiting_input");
    expect(row?.wait?.kind).toBe("input");
    expect(row?.wait?.fields).toEqual([
      { name: "person.name", type: "string" },
      { name: "consent", type: "boolean" },
    ]);
    expect(row?.wait?.question).toContain("person.name");
    expect(row?.wait?.question).toContain("consent");
    // The unsupported field is shown (S29: inspection lists all three).
    const evidence = (row?.evidence ?? []) as Array<{
      kind: string;
      title: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "file",
        title: "Document inspected",
        excerpt: expect.stringContaining("region"),
      }),
    );
    // NO fill before the answer: both seams count zero.
    expect(fixture.fills).toHaveLength(0);
    expect(fixture.appended).toHaveLength(0);
  });

  test("a valid answer fills ONE copy with exactly the answered values; source row untouched", async () => {
    const fixture = documentFixture();
    const task = await postDocumentTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    const answered = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: true },
        }),
      },
    );
    expect(answered.status).toBe(200);
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("succeeded");
    // Exactly ONE fill call, with exactly the answered values.
    expect(fixture.fills).toHaveLength(1);
    expect(fixture.fills[0].values).toEqual({
      "person.name": "Ava",
      consent: true,
    });
    // One derived version, parented by the task's bound version.
    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0].parentVersionId).toBe("doc-1-v1");
    expect(fixture.appended[0].ownerUserId).toBe("user-1");
    // The derived version id rides artifactIds and the evidence.
    expect(row?.artifactIds).toEqual([fixture.appended[0].versionId]);
    const evidence = (row?.evidence ?? []) as Array<{
      kind: string;
      title: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "file",
        title: "Document filled",
        excerpt: expect.stringContaining(fixture.appended[0].versionId),
      }),
    );
    // The source File row is only ever read: its sha re-read unchanged.
    const reread = await fixture.files.getOwnedFile("user-1", "doc-1");
    expect(reread?.file.sha256).toBe("doc-1-sha");
    expect(reread?.file.versionId).toBe("doc-1-v1");
  });

  test("an invalid answer is 400, the wait stays open, zero fills", async () => {
    const fixture = documentFixture();
    const task = await postDocumentTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    const wrongType = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: "yes" },
        }),
      },
    );
    expect(wrongType.status).toBe(400);
    const unknownField = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: true, region: "North" },
        }),
      },
    );
    expect(unknownField.status).toBe(400);
    // The wait is still open — no answer stored, nothing consumed.
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("waiting_input");
    expect(row?.wait?.answeredAt).toBeUndefined();
    expect(row?.wait?.answer).toBeUndefined();
    expect(fixture.fills).toHaveLength(0);
    expect(fixture.appended).toHaveLength(0);
  });

  test("restart mid-wait: a fresh store and runner over the same rows complete the flow once", async () => {
    const fixture = documentFixture();
    const task = await postDocumentTask(fixture);
    await fixture.runner.sweep();
    expect((await fixture.store.get("user-1", task.id))?.status).toBe(
      "waiting_input",
    );
    const waitId =
      (await fixture.store.get("user-1", task.id))?.wait?.waitId ?? "";
    // Re-instantiate the store and runner over the SAME rows and queue — the
    // restart a new process performs. The wait persists (T08 durability, the
    // document kind's re-assertion).
    const store2 = createOpenMuseTaskStore({
      rows: fixture.rows,
      queue: fixture.queue,
    });
    const runner2 = createOpenMuseTaskRunner({
      queue: fixture.queue,
      store: store2,
      owner: "replica",
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
      runTurn: async () => ({ replyText: "unused" }),
      files: fixture.files,
      extract: fixture.extract,
      fill: fixture.fill,
      emitNotification: async () => {},
    });
    const answered = await store2.answerWait("user-1", task.id, waitId, {
      "person.name": "Ava",
      consent: true,
    });
    expect(answered.outcome).toBe("answered");
    const report = await runner2.sweep();
    expect(report.ran).toHaveLength(1);
    const row = await store2.get("user-1", task.id);
    expect(row?.status).toBe("succeeded");
    expect(fixture.fills).toHaveLength(1);
    expect(fixture.appended).toHaveLength(1);
    expect(row?.artifactIds).toEqual([fixture.appended[0].versionId]);
  });

  test("the bound version drifting (a newer fill landed) refuses: failed, zero fills", async () => {
    const fixture = documentFixture();
    const task = await postDocumentTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    const answered = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: true },
        }),
      },
    );
    expect(answered.status).toBe(200);
    // The File moved on: someone filled it between the wait and the answer.
    fixture.source.versionId = "doc-1-v9";
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    expect(fixture.fills).toHaveLength(0);
    expect(fixture.appended).toHaveLength(0);
    const steps = (row?.steps ?? []) as Array<{
      id: string;
      status: string;
      result: string;
    }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        status: "failed",
        result: expect.stringMatching(/changed|no longer current/i),
      }),
    );
  });

  test("a PDF with no supported fields fails honestly instead of asking an empty question", async () => {
    const fixture = documentFixture([{ kind: "dropdown", name: "region" }]);
    const task = await postDocumentTask(fixture);
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    expect(row?.wait).toBeUndefined();
    expect(fixture.fills).toHaveLength(0);
  });

  test("without the files seam wired a document task fails loudly, never silently", async () => {
    const fixture = fixtureFor();
    const task = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "document",
      prompt: JSON.stringify({ fileId: "doc-1", versionId: "doc-1-v1" }),
      idempotencyKey: null,
    });
    await fixture.queue.offer({
      kind: OPENMUSE_TASK_KIND,
      key: task.task.id,
      payload: { ownerUserId: "user-1" },
    });
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.task.id);
    expect(row?.status).toBe("failed");
    const steps = (row?.steps ?? []) as Array<{ id: string; result: string }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        result: expect.stringMatching(/document.*seam|seam.*document/i),
      }),
    );
  });
});

/*
 * T16 (§7 reviewed reply): the document cycle's second half. T15's fill run,
 * when the carriage carries a reply binding, proposes ONE gmail.send through
 * openmuse-reviewed-actions' real service (the integration fixture: the fake
 * rows, the counting executor and requireConnection are the only doubles) —
 * the proposal binds the reply threadId/replyToMessageId, the connected
 * account and generation, and the EXACT derived attachment version — parks
 * the row `waiting_review` (the §7 review wait carrying the proposal binding,
 * T12's waiting_review notification's first producer) and re-offers itself:
 * the sweep POLLS the proposal's status, no webhook invented. Approve sends
 * exactly once and the task completes with the §6 receipt on the evidence;
 * deny and expiry fail the task with the filled File retained and zero sends;
 * outcome_unknown parks an uncertain marker and never resends — R04's
 * operator reconciliation owns that tail. A restart mid-wait picks the
 * binding back up from the durable wait and completes once.
 */
describe("document review replies (T16)", () => {
  /** The reply binding the S29 flow attaches to the carriage at creation. */
  const REPLY = {
    to: ["landlord@example.com"],
    subject: "Re: Lease form",
    body: "Please find the filled lease form attached.",
    threadId: "thread-abc",
    replyToMessageId: "msg-123",
  } as const;

  /** The connected Gmail seat the proposal binds. */
  const CONNECTION = {
    id: "conn-1",
    userId: "user-1",
    provider: "gmail" as const,
    accountEmail: "ava@gmail.test",
    status: "connected" as const,
    grantedScopes: [],
    generation: 3,
    alias: "alias-1",
    connectedAt: new Date("2026-10-01T00:00:00.000Z"),
    lastError: null,
  };

  /** The reviewed-actions half: the same fake rows/executor contract R02-R04
   * prove the real service against, minimal for the reply flow. */
  function reviewedFixture(
    plan: Array<"succeeded" | "failed" | "outcome_unknown"> = [],
  ) {
    const actions: import("../src/openmuse-reviewed-actions/store").StoredReviewedAction[] =
      [];
    const attempts: import("../src/openmuse-reviewed-actions/store").StoredReviewedAttempt[] =
      [];
    const disabled = new Set<string>();
    const rows: import("../src/openmuse-reviewed-actions/store").ReviewedActionRows =
      {
        insertAction: async (action) => {
          actions.push({
            ...action,
            attachmentVersionIds: [...action.attachmentVersionIds],
          });
        },
        getAction: async (id) => actions.find((row) => row.id === id) ?? null,
        listByOwner: async (ownerUserId, { limit }) =>
          actions
            .filter((row) => row.ownerUserId === ownerUserId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
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
          if (patch?.completedAt !== undefined)
            row.completedAt = patch.completedAt;
          if (patch?.providerRef !== undefined)
            row.providerRef = patch.providerRef;
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
          Object.assign(attempt, patch);
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
    const calls: import("../src/openmuse-reviewed-actions/proposal").ReviewedActionProposal[] =
      [];
    const planned = [...plan];
    const executor = {
      execute: async (
        proposal: import("../src/openmuse-reviewed-actions/proposal").ReviewedActionProposal,
      ) => {
        calls.push(proposal);
        const outcome = planned.shift() ?? "succeeded";
        return {
          outcome,
          ...(outcome === "succeeded"
            ? { providerRef: `fake-ref-${calls.length}` }
            : {}),
          ...(outcome === "failed"
            ? { error: "the fake executor refused" }
            : {}),
          fingerprint: "ab".repeat(32),
        };
      },
    };
    let clockMs = Date.parse("2026-10-13T10:00:00.000Z");
    const service = createOpenMuseReviewedActionService({
      rows,
      executor,
      now: () => new Date(clockMs),
    });
    let connected = true;
    const requireConnection = async () => {
      if (!connected)
        throw new OpenMuseConnectionRefusedError(
          "Connect gmail before using it.",
        );
      return CONNECTION;
    };
    const review = createDocumentReplyReview({ service, requireConnection });
    return {
      actions,
      attempts,
      reviewedRows: rows,
      service,
      review,
      calls,
      clock: {
        advance: (minutes: number) => {
          clockMs += minutes * 60_000;
        },
      },
      disconnect: () => {
        connected = false;
      },
    };
  }

  /**
   * The T16 fixture: T15's document fixture (files/extract/fill/app/store/
   * queue) plus a runner wired with the REAL reviewed-actions service through
   * the proposal-creation export — the integration fixture the reply flow is
   * proven against, with its own notification collector.
   */
  function reviewDocumentFixture(
    plan: Array<"succeeded" | "failed" | "outcome_unknown"> = [],
  ) {
    const base = documentFixture();
    const reviewed = reviewedFixture(plan);
    const events: Array<{
      eventKind: string;
      taskId: string;
      detail?: string;
    }> = [];
    const runner = createOpenMuseTaskRunner({
      queue: base.queue,
      store: base.store,
      owner: "replica",
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
      runTurn: async () => ({ replyText: "unused" }),
      files: base.files,
      extract: base.extract,
      fill: base.fill,
      review: reviewed.review,
      emitNotification: async (event) => {
        events.push(event);
      },
    });
    return { ...base, ...reviewed, runner, events };
  }

  /** One document task whose carriage carries the reply binding. */
  async function postReplyTask(
    fixture: ReturnType<typeof reviewDocumentFixture>,
  ): Promise<StoredOpenMuseTask & { id: string }> {
    const created = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "document",
      prompt: documentTaskCarriage("doc-1", "doc-1-v1", REPLY),
      idempotencyKey: null,
    });
    await fixture.queue.offer({
      kind: OPENMUSE_TASK_KIND,
      key: created.task.id,
      payload: { ownerUserId: "user-1" },
    });
    return created.task;
  }

  /** The flow through the park: inspect, answer, fill+propose. */
  async function parkReply(
    fixture: ReturnType<typeof reviewDocumentFixture>,
  ): Promise<{
    task: StoredOpenMuseTask & { id: string };
    proposalId: string;
  }> {
    const task = await postReplyTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    const answered = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: true },
        }),
      },
    );
    expect(answered.status).toBe(200);
    await fixture.runner.sweep();
    const parked = await fixture.store.get("user-1", task.id);
    const wait = parked?.wait as { proposalId?: string } | undefined;
    return { task, proposalId: wait?.proposalId ?? "" };
  }

  test("the fill proposes one bound gmail.send, parks waiting_review, emits the waiting_review notification, and later sweeps only poll", async () => {
    const fixture = reviewDocumentFixture();
    const { task } = await parkReply(fixture);
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("waiting_review");
    // The §7 review wait carries the proposal binding.
    expect(row?.wait?.kind).toBe("review");
    expect(
      typeof (row?.wait as { proposalId?: string } | undefined)?.proposalId,
    ).toBe("string");
    // ONE proposal, bound exactly as the catalog fixes it: the reply target,
    // the connected account and generation, the derived attachment version.
    expect(fixture.actions).toHaveLength(1);
    const action = fixture.actions[0];
    expect(action.kind).toBe("gmail.send");
    expect(action.canonicalPayload).toEqual({ ...REPLY });
    expect(action.accountEmail).toBe("ava@gmail.test");
    expect(action.connectionGeneration).toBe(3);
    expect(action.attachmentVersionIds).toEqual([
      fixture.appended[0].versionId,
    ]);
    // The derived version is linked and the fill happened exactly once.
    expect(row?.artifactIds).toEqual([fixture.appended[0].versionId]);
    expect(fixture.fills).toHaveLength(1);
    // T12's waiting_review EVENT's first producer is this park.
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        eventKind: "task.waiting_review",
        taskId: task.id,
      }),
    );
    // A sweep before any decision only polls: still parked, zero sends,
    // exactly one proposal.
    const poll = await fixture.runner.sweep();
    expect(poll.ran).toHaveLength(1);
    expect((await fixture.store.get("user-1", task.id))?.status).toBe(
      "waiting_review",
    );
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.actions).toHaveLength(1);
  });

  test("a park whose re-offer fails still reports ran, notifies, and never sinks the sweep", async () => {
    const fixture = reviewDocumentFixture();
    const task = await postReplyTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    /*
     * Arm the failure only after the answer's own re-offer lands: the
     * park's continuation offer is the seam under test. The park has
     * already committed when it fires, so its failure must be a loud
     * signal (offerContinuation's log) — never a misfiled skip that also
     * drops the waiting_review notification.
     */
    const baseOffer = fixture.queue.offer.bind(fixture.queue);
    let armed = false;
    fixture.queue.offer = async (item) => {
      if (armed) throw new Error("queue is down");
      return baseOffer(item);
    };
    const answered = await fixture.app.request(
      `/${task.id}/wait/${waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { "person.name": "Ava", consent: true },
        }),
      },
    );
    expect(answered.status).toBe(200);
    armed = true;
    const report = await fixture.runner.sweep();
    expect(report.ran).toHaveLength(1);
    expect(report.skipped).toHaveLength(0);
    expect((await fixture.store.get("user-1", task.id))?.status).toBe(
      "waiting_review",
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        eventKind: "task.waiting_review",
        taskId: task.id,
      }),
    );
    expect(fixture.calls).toHaveLength(0);
  });

  test("approve sends exactly once; the task completes with the receipt on the evidence", async () => {
    const fixture = reviewDocumentFixture();
    const { task, proposalId } = await parkReply(fixture);
    const decided = await fixture.service.decide(
      "user-1",
      proposalId,
      "approve",
    );
    expect(decided?.status).toBe("succeeded");
    // The task is still parked until a sweep observes the decision — the
    // poll is the observation, not a webhook.
    expect((await fixture.store.get("user-1", task.id))?.status).toBe(
      "waiting_review",
    );
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("succeeded");
    // Exactly ONE provider send across the whole flow, and one fill.
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].attachmentVersionIds).toEqual([
      fixture.appended[0].versionId,
    ]);
    expect(fixture.fills).toHaveLength(1);
    // The §6 receipt reference rides the evidence.
    const evidence = (row?.evidence ?? []) as Array<{
      id: string;
      title: string;
      excerpt: string;
    }>;
    const receipt = evidence.find((entry) => entry.id === `${task.id}:receipt`);
    expect(receipt?.excerpt).toContain(fixture.attempts[0].attemptId);
    expect(receipt?.excerpt).toContain("fake-ref-1");
  });

  test("deny fails the task with the reason; the filled File is retained and zero sends happen", async () => {
    const fixture = reviewDocumentFixture();
    const { task, proposalId } = await parkReply(fixture);
    const decided = await fixture.service.decide("user-1", proposalId, "deny");
    expect(decided?.status).toBe("denied");
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    expect(fixture.calls).toHaveLength(0);
    // The denial is on the evidence with its reason.
    const evidence = (row?.evidence ?? []) as Array<{
      id: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        id: `${task.id}:review-outcome`,
        excerpt: expect.stringMatching(/denied/i),
      }),
    );
    // Retained: the source File row is unchanged and the derived version
    // stays linked — a denial never tombstones either.
    const reread = await fixture.files.getOwnedFile("user-1", "doc-1");
    expect(reread?.file.sha256).toBe("doc-1-sha");
    expect(reread?.file.versionId).toBe("doc-1-v1");
    expect(row?.artifactIds).toEqual([fixture.appended[0].versionId]);
  });

  test("expiry fails the task like a denial, with the expired reason", async () => {
    const fixture = reviewDocumentFixture();
    const { task, proposalId } = await parkReply(fixture);
    // Past the §6 TTL: the decision refuses and flips the proposal expired.
    fixture.clock.advance(31);
    await expect(
      fixture.service.decide("user-1", proposalId, "approve"),
    ).rejects.toThrow(/expired/i);
    expect(fixture.calls).toHaveLength(0);
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("failed");
    const evidence = (row?.evidence ?? []) as Array<{
      id: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        id: `${task.id}:review-outcome`,
        excerpt: expect.stringMatching(/expired/i),
      }),
    );
    expect(fixture.calls).toHaveLength(0);
  });

  test("outcome_unknown parks an uncertain marker; later sweeps never resend; R04's reconcile still works", async () => {
    const fixture = reviewDocumentFixture(["outcome_unknown"]);
    const { task, proposalId } = await parkReply(fixture);
    const decided = await fixture.service.decide(
      "user-1",
      proposalId,
      "approve",
    );
    expect(decided?.status).toBe("outcome_unknown");
    await fixture.runner.sweep();
    let row = await fixture.store.get("user-1", task.id);
    // The task SURFACES the uncertainty and stays parked — never failed into
    // a lie, never resent.
    expect(row?.status).toBe("waiting_review");
    const evidence = (row?.evidence ?? []) as Array<{
      id: string;
      excerpt: string;
    }>;
    expect(evidence).toContainEqual(
      expect.objectContaining({
        id: `${task.id}:uncertain`,
        excerpt: expect.stringMatching(/uncertain|unknown|reconcil/i),
      }),
    );
    // Across further sweeps: zero resends (no second send, no second
    // proposal) — the uncertain marker ends the polling too.
    await fixture.runner.sweep();
    await fixture.runner.sweep();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.actions).toHaveLength(1);
    // R04's operator reconciliation on the same service still closes the
    // action; the task keeps its surfaced marker.
    const reconciled = await fixture.service.reconcile("admin-1", proposalId, {
      outcome: "confirmed_succeeded",
      evidence: "The provider console shows the message delivered.",
    });
    expect(reconciled?.status).toBe("succeeded");
    row = await fixture.store.get("user-1", task.id);
    expect(row?.status).toBe("waiting_review");
  });

  test("restart mid-waiting_review: the binding and wait persist; the post-restart decision completes once", async () => {
    const fixture = reviewDocumentFixture();
    const { task, proposalId } = await parkReply(fixture);
    expect((await fixture.store.get("user-1", task.id))?.status).toBe(
      "waiting_review",
    );
    // The restart: a fresh store and runner over the SAME rows and queue,
    // the SAME reviewed rows under a fresh service instance.
    const store2 = createOpenMuseTaskStore({
      rows: fixture.rows,
      queue: fixture.queue,
    });
    const service2 = createOpenMuseReviewedActionService({
      rows: fixture.reviewedRows,
      executor: {
        execute: async (proposal) => {
          fixture.calls.push(proposal);
          return {
            outcome: "succeeded",
            providerRef: `fake-ref-${fixture.calls.length}`,
            fingerprint: "ab".repeat(32),
          };
        },
      },
      now: () => new Date(Date.parse("2026-10-13T10:01:00.000Z")),
    });
    const runner2 = createOpenMuseTaskRunner({
      queue: fixture.queue,
      store: store2,
      owner: "replica",
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
      runTurn: async () => ({ replyText: "unused" }),
      files: fixture.files,
      extract: fixture.extract,
      fill: fixture.fill,
      review: createDocumentReplyReview({
        service: service2,
        requireConnection: async () => CONNECTION,
      }),
      emitNotification: async () => {},
    });
    const decided = await service2.decide("user-1", proposalId, "approve");
    expect(decided?.status).toBe("succeeded");
    const report = await runner2.sweep();
    expect(report.ran).toHaveLength(1);
    const row = await store2.get("user-1", task.id);
    expect(row?.status).toBe("succeeded");
    // Once across the restart: one fill, one send.
    expect(fixture.fills).toHaveLength(1);
    expect(fixture.calls).toHaveLength(1);
    expect(row?.artifactIds).toEqual([fixture.appended[0].versionId]);
  });

  test("a disconnected account fails the fill visibly before any proposal exists", async () => {
    const fixture = reviewDocumentFixture();
    fixture.disconnect();
    const task = await postReplyTask(fixture);
    await fixture.runner.sweep();
    const waiting = await fixture.store.get("user-1", task.id);
    const waitId = waiting?.wait?.waitId ?? "";
    await fixture.app.request(`/${task.id}/wait/${waitId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: { "person.name": "Ava", consent: true },
      }),
    });
    await fixture.runner.sweep();
    const row = await fixture.store.get("user-1", task.id);
    // The 409's sentence surfaces on the row — never fabricated past.
    expect(row?.status).toBe("failed");
    const steps = (row?.steps ?? []) as Array<{ id: string; result: string }>;
    expect(steps).toContainEqual(
      expect.objectContaining({
        id: "run",
        result: expect.stringMatching(/Connect gmail/i),
      }),
    );
    // No proposal, no park, no send — but the fill's derived version did land.
    expect(fixture.actions).toHaveLength(0);
    expect(fixture.calls).toHaveLength(0);
    expect((await fixture.store.get("user-1", task.id))?.wait?.kind).not.toBe(
      "review",
    );
  });

  /*
   * T16×T04 and the poll's own failure bound: a cancellation flag that rode
   * the park (the matrix 409s waiting_review, so a stop that landed mid-run is
   * the owner's only cancel path) is consumed at the poll's safe boundary
   * instead of re-offering forever; and a poll that cannot read backs its
   * re-offer off — a fresh queue key resets the queue's attempts counter, so
   * without the runAt the failure retried every sweep without any bound.
   */
  test("a cancellation flag parked with the wait is consumed by the poll, not re-offered forever", async () => {
    const fixture = reviewDocumentFixture();
    const { task, proposalId } = await parkReply(fixture);
    // The stop landed mid-run: the flag is on the row, the park kept it, and
    // the store's cancel matrix has no path that reaches a waiting_review row.
    const row = fixture.rows.tasks.find(
      (candidate) => candidate.id === task.id,
    );
    expect(row?.status).toBe("waiting_review");
    row!.cancellationRequested = true;
    const offeredBefore = fixture.queue.offered.length;

    await fixture.runner.sweep();

    const after = await fixture.store.get("user-1", task.id);
    expect(after?.status).toBe("cancelled");
    // Not re-offered: the parked poll is done.
    expect(fixture.queue.offered).toHaveLength(offeredBefore);
    expect(proposalId).toBeTruthy();
  });

  test("a poll that cannot read re-offers with a bounded backoff, not at the next sweep", async () => {
    const fixture = reviewDocumentFixture();
    const { task } = await parkReply(fixture);
    const before = fixture.queue.offered.length;
    // The reviewed seam goes dark — a DB outage, a bad migration, a code bug.
    const originalResolve = fixture.review.resolve.bind(fixture.review);
    fixture.review.resolve = async () => {
      throw new Error("connection refused");
    };

    const report = await fixture.runner.sweep();

    fixture.review.resolve = originalResolve;
    expect(report.skipped.some((key) => key.startsWith(task.id))).toBe(true);
    // The re-offer carries a delayed runAt: backoffMinutes(2) = 30 minutes,
    // the same ceiling the monitor failure branch uses — not the bare
    // re-offer that reset the queue's attempts counter every sweep.
    const reoffer = fixture.queue.offered
      .slice(before)
      .find((item) => item.key.includes(task.id)) as
      | { runAt?: Date }
      | undefined;
    expect(reoffer?.runAt).toBeInstanceOf(Date);
    expect(
      (reoffer!.runAt as Date).getTime() - Date.now(),
    ).toBeGreaterThanOrEqual(29 * 60_000);
  });
});

/*
 * D02 (§9 work shutdown): the runner's side of the marker. A shutdown's
 * cancellation flag on a running row rides T04's safe boundary — the
 * post-turn finalize lands cancelled and never re-offers. A claim that
 * arrives for a deleted owner — a monitor's due offer, a T07 recovery
 * re-offer after a lost lease — is finished-with-skip: no check, no turn,
 * no re-run, the row left exactly as the claim found it.
 */
describe("§9 work shutdown (D02)", () => {
  test("a running Task at deletion: the flag lands, the public status holds, the sweep's finalize lands cancelled with no re-offer", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "Summarize the week." });
    let releaseTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    fixture.setTurn(async () => {
      await gate;
      return { replyText: "Done." };
    });
    const sweeping = fixture.runner.sweep();
    // The turn is in flight when the deletion marker lands and D02's
    // shutdown raises the flag on the running row.
    while (fixture.turns.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await fixture.store.shutdownOwner("user-1");
    const mid = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(mid?.status).toBe("running");
    expect(mid?.cancellationRequested).toBe(true);
    releaseTurn?.();
    const report = await sweeping;
    expect(report.skipped).toHaveLength(1);
    const after = fixture.rows.tasks.find((row) => row.id === created.id);
    expect(after?.status).toBe("cancelled");
    // No re-offer: create's own offer is the only queue row ever offered.
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("T07 recovery of a deleted owner: finish-with-skip, zero re-runs, the row left untouched", async () => {
    const fixture = fixtureFor();
    const created = await fixture.postTask({ prompt: "Draft the note." });
    // The worker died mid-turn: the row is left running (effect-free) and the
    // lease's re-offer hands it back at attempts 2 — after the marker landed.
    const row = fixture.rows.tasks.find((task) => task.id === created.id);
    if (!row) throw new Error("missing fixture row");
    row.status = "running";
    await fixture.rows.disableOwner("user-1");
    // One claim, as the real queue hands each item out once.
    let handedOut = false;
    const recovered = createOpenMuseTaskRunner({
      queue: {
        // One claim, as the real queue hands each item out once.
        claim: async () => {
          if (handedOut) return [];
          handedOut = true;
          return [
            {
              kind: OPENMUSE_TASK_KIND,
              key: `${created.id}:recovery`,
              payload: { ownerUserId: "user-1", taskId: created.id },
              attempts: 2,
            },
          ];
        },
        finish: async () => true,
        purge: async () => 0,
        offer: async () => "queued" as const,
      },
      store: fixture.store,
      owner: "replica",
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
      runTurn: async () => {
        throw new Error("no turn may run for a deleted owner");
      },
    });
    const report = await recovered.sweep();
    expect(report.skipped).toHaveLength(1);
    expect(fixture.turns).toHaveLength(0);
    // Not recovered, not failed, not re-offered: no re-run of a deleted
    // owner's work, and no outcome guessed at on its behalf.
    const after = fixture.rows.tasks.find((task) => task.id === created.id);
    expect(after?.status).toBe("running");
    expect(after?.attempts).toBe(1);
  });

  test("a deleted owner's Monitor claims nothing: the due offer is skipped, no check, no new offer", async () => {
    const clock = clockAt("2026-10-01T00:00:00Z");
    const rows = fakeRows(clock.now);
    const offered: Array<Record<string, unknown>> = [];
    const finished: string[] = [];
    const waiting = new Map<
      string,
      { payload: Record<string, unknown>; runAt?: Date }
    >();
    const queue = {
      offered,
      offer: async (item: {
        key: string;
        payload?: Record<string, unknown>;
        runAt?: Date;
      }) => {
        if (waiting.has(item.key)) return "already" as const;
        waiting.set(item.key, {
          payload: item.payload ?? {},
          ...(item.runAt ? { runAt: item.runAt } : {}),
        });
        return "queued" as const;
      },
      claim: async () =>
        [...waiting.entries()]
          .filter(
            ([, item]) =>
              item.runAt === undefined ||
              item.runAt.getTime() <= clock.now().getTime(),
          )
          .slice(0, 1)
          .map(([key, item]) => {
            waiting.delete(key);
            return {
              kind: OPENMUSE_TASK_KIND,
              key,
              payload: item.payload,
              attempts: 1,
            };
          }),
      finish: async ({ key }: { key: string }) => {
        finished.push(key);
        return true;
      },
      purge: async () => 0,
    };
    const store = createOpenMuseTaskStore({ rows, queue, now: clock.now });
    const created = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "monitor",
      condition: {
        type: "change",
        source: "https://example.com",
        intervalMinutes: 30,
      },
      idempotencyKey: null,
    });
    let checks = 0;
    const runner = createOpenMuseTaskRunner({
      queue,
      store,
      owner: "replica",
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
      runTurn: async () => {
        throw new Error("no turn may run for a monitor");
      },
      checkMonitor: async () => {
        checks += 1;
        return { observation: "anything" };
      },
      now: clock.now,
    });
    // The check comes due, the marker lands, D02 cancels the row.
    clock.advance(31);
    await rows.disableOwner("user-1");
    await store.shutdownOwner("user-1");
    const report = await runner.sweep();
    expect(report.skipped).toHaveLength(1);
    expect(checks).toBe(0);
    const after = rows.tasks.find((task) => task.id === created.task.id);
    // The cancelled status the shutdown landed is what the claim saw; the
    // row never re-arms, and no next offer appears.
    expect(after?.status).toBe("cancelled");
    expect(after?.nextCheckAt).toEqual(new Date("2026-10-01T00:30:00Z"));
    const offeredAfter = [...waiting.keys()].length;
    expect(offeredAfter).toBe(0);
  });
});
