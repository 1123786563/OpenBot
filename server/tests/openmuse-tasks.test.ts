describe("the cancel matrix (round 6 M43)", () => {
  test("waiting_input and waiting_review rows cancel — the quota slot has an owner exit", async () => {
    const rows = fakeRows(() => new Date());
    const store = createOpenMuseTaskStore({ rows });
    for (const status of ["waiting_input", "waiting_review"] as const) {
      const created = await store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        prompt: "parked",
        idempotencyKey: null,
      });
      rows.tasks[rows.tasks.length - 1]!.status = status;
      const cancelled = await store.requestCancel("user-1", created.task.id);
      expect(cancelled.outcome).toBe("cancelled");
      if (cancelled.outcome === "cancelled") {
        expect(cancelled.task.status).toBe("cancelled");
      }
    }
    // Terminal rows still re-answer themselves (unchanged).
    const done = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "done",
      idempotencyKey: null,
    });
    await store.settleTask(done.task.id, { status: "succeeded" });
    const settled = await store.requestCancel("user-1", done.task.id);
    // A succeeded row is terminal: the CAS refuses, and the wrapper answers
    // the row's own state.
    expect(settled.outcome).not.toBe("cancelled");
  });
});

describe("the create-side quota bound (round 6 M35)", () => {
  test("store.create refuses past the cap even when the pre-check was bypassed", async () => {
    const now = () => new Date();
    const rows = fakeRows(now);
    const store = createOpenMuseTaskStore({ rows });
    for (let index = 0; index < ACTIVE_TASKS_PER_USER; index += 1) {
      const landed = await store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        prompt: `task ${index}`,
        idempotencyKey: null,
      });
      expect(landed.created).toBe(true);
    }
    await expect(
      store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        prompt: "one too many",
        idempotencyKey: null,
      }),
    ).rejects.toBeInstanceOf(OpenMuseTaskQuotaError);
    // A terminal row frees a slot; another owner is unaffected.
    await store.settleTask(rows.tasks[0]!.id, { status: "succeeded" });
    const freed = await store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "after a slot freed",
      idempotencyKey: null,
    });
    expect(freed.created).toBe(true);
    const other = await store.create({
      ownerUserId: "user-2",
      botId: "bot-1",
      kind: "agent",
      prompt: "another owner",
      idempotencyKey: null,
    });
    expect(other.created).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createOpenMuseAccountDeletionRoutes } from "../src/openmuse-deletion/routes";
import { createOpenMuseWorkShutdown } from "../src/openmuse-deletion/shutdown";
import { createOpenMuseTasksRoutes } from "../src/openmuse-tasks/routes";
import { createOpenMuseTaskRunner } from "../src/openmuse-tasks/runner";
import {
  createOpenMuseTaskStore,
  documentTaskCarriage,
  documentTaskInput,
  OpenMuseOwnerDisabledError,
  type OpenMuseTaskRows,
  type OpenMuseTaskStore,
  type StoredOpenMuseTask,
  OpenMuseTaskQuotaError,
} from "../src/openmuse-tasks/store";
import { ACTIVE_TASKS_PER_USER } from "../src/openmuse-tasks/capacity";

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
let guardAdmits = true;
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

/** Each owner's one private OpenMuse Bot, as the route resolves it through the template store. */
const privateBots: Record<string, string> = {
  "user-1": "bot-1",
  "user-2": "bot-2",
};

/**
 * T10: the clock the fixture reads — the store's create computes the initial
 * nextCheckAt from it and the rows' resume re-arms from it, the way the
 * database's clock does in production.
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

/** In-memory row seam: same contract as the drizzle rows, rows live as data. */
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
      ) {
        throw new Error("duplicate idempotency key");
      }
      // M35, mirrored from the drizzle rows: the insert enforces the quota
      // bound itself (single-threaded here, so the mirror is the plain
      // count) — the create path's pre-checks are the fast path only.
      const active = tasks.filter(
        (row) =>
          row.ownerUserId === task.ownerUserId &&
          row.status !== "succeeded" &&
          row.status !== "failed" &&
          row.status !== "cancelled",
      ).length;
      if (active >= ACTIVE_TASKS_PER_USER) {
        throw new OpenMuseTaskQuotaError();
      }
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
    /** The settle seam, with the T07 attempts CAS: a stale generation lands nothing. */
    updateTask: async (id, patch) => {
      const row = tasks.find((task) => task.id === id);
      if (!row) return null;
      if (patch.ifAttempts !== undefined && row.attempts !== patch.ifAttempts)
        return null;
      // T04×T07: the status allow-list the claim names, mirroring the drizzle WHERE.
      if (patch.ifStatus && !patch.ifStatus.includes(row.status)) return null;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.status) row.status = patch.status;
      // T10: a monitor's re-armed due instant lands in the same settle.
      if (patch.nextCheckAt) row.nextCheckAt = patch.nextCheckAt;
      // T11: the observation cursor and the failure streak land in the same
      // settle — checked for !== undefined, a zero streak must land.
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
      return snapshot(row);
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
      // M43, mirrored from the drizzle rows: waiting_input/waiting_review
      // cancel too — a waiting row holds an active quota slot and its owner
      // needs the exit.
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
     * retained rows are stamped with the generation that wrote them (the
     * pre-bump attempts, as the drizzle SET reads the old row); T06×T10: a
     * monitor retries to `scheduled` re-armed now, not parked in `queued`.
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
    ...overrides,
  };
}

type Fixture = {
  store: OpenMuseTaskStore;
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(overrides: Partial<Fixture> = {}): Fixture {
  const rows = fakeRows();
  const store = createOpenMuseTaskStore({ rows });
  const app = createOpenMuseTasksRoutes({
    store,
    requireUser,
    resolvePrivateBotId: async (ownerUserId) =>
      privateBots[ownerUserId] ?? null,
  });
  return { store, rows, app, ...overrides };
}

function postTask(
  app: Hono<{ Variables: AppVariables }>,
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  return app.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * T05: the offer seam a resume re-offers through (the same one create uses in
 * production), recording every offer so "exactly once" is assertable.
 */
function recordingQueue() {
  const offered: Array<{
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
    /** T10: the scheduled offer's due instant, as the real queue's runAt. */
    runAt?: Date;
  }> = [];
  return {
    offered,
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
      runAt?: Date;
    }) => {
      offered.push(item);
      return "queued" as const;
    },
  };
}

/** The T05 fixture: same shape as fixtureFor, plus the queue a resume offers through. */
function fixtureWithQueue() {
  const rows = fakeRows();
  const queue = recordingQueue();
  const store = createOpenMuseTaskStore({ rows, queue });
  const app = createOpenMuseTasksRoutes({
    store,
    requireUser,
    resolvePrivateBotId: async (ownerUserId) =>
      privateBots[ownerUserId] ?? null,
  });
  return { rows, queue, store, app };
}

/** The T10 fixture: a clock-driven store, so nextCheckAt is asserted, not guessed. */
function monitorFixture() {
  const clock = clockAt("2026-10-01T00:00:00Z");
  const rows = fakeRows(clock.now);
  const queue = recordingQueue();
  const store = createOpenMuseTaskStore({ rows, queue, now: clock.now });
  const app = createOpenMuseTasksRoutes({
    store,
    requireUser,
    resolvePrivateBotId: async (ownerUserId) =>
      privateBots[ownerUserId] ?? null,
  });
  return { clock, rows, queue, store, app };
}

describe("POST / (create)", () => {
  test("creates one agent task in queued state with the §7 contract fields", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "Summarise the unread mail.",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("string");
    expect(body.ownerUserId).toBe("user-1");
    expect(body.botId).toBe("bot-1");
    expect(body.kind).toBe("agent");
    expect(body.status).toBe("queued");
    expect(body.attempts).toBe(1);
    expect(body.steps).toEqual([]);
    expect(body.evidence).toEqual([]);
    expect(body.artifactIds).toEqual([]);
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
    expect(fixture.rows.tasks).toHaveLength(1);
  });

  test("same owner + same Idempotency-Key returns the same task and inserts one row", async () => {
    const fixture = fixtureFor();
    const first = await postTask(
      fixture.app,
      { botId: "bot-1", kind: "agent", prompt: "a" },
      "retry-key",
    );
    expect(first.status).toBe(201);
    const retried = await postTask(
      fixture.app,
      { botId: "bot-1", kind: "agent", prompt: "a" },
      "retry-key",
    );
    expect(retried.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };
    const retriedBody = (await retried.json()) as { id: string };
    expect(retriedBody.id).toBe(firstBody.id);
    expect(fixture.rows.tasks).toHaveLength(1);
  });

  test("a botId that is not the actor's private Bot is 404", async () => {
    const fixture = fixtureFor();
    const foreign = await postTask(fixture.app, {
      botId: "bot-2",
      kind: "agent",
      prompt: "a",
    });
    expect(foreign.status).toBe(404);
    currentActor = actorTwo;
    try {
      const wrongOwner = await postTask(fixture.app, {
        botId: "bot-1",
        kind: "agent",
        prompt: "a",
      });
      expect(wrongOwner.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("an invalid kind or an empty prompt is 400", async () => {
    const fixture = fixtureFor();
    const badKind = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "banana",
      prompt: "a",
    });
    expect(badKind.status).toBe(400);
    const emptyPrompt = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "",
    });
    expect(emptyPrompt.status).toBe(400);
    const neither = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
    });
    expect(neither.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("a finance task carries a CSV File id instead of a prompt (T13)", async () => {
    // Updated with the T13 finding fix (ocr-ob-certify, finding 29): finance
    // creation now owner-validates the CSV through the files seam like
    // document's {fileId, versionId} pair, so the fixture provides one. The
    // matrix this test pins — csvFileId required, prompt refused, other kinds
    // refused — is unchanged below.
    const fixture = financeFixture();
    fixture.addCsv("user-1", "file-1");
    const created = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "finance",
      csvFileId: "file-1",
    });
    expect(created.status).toBe(201);
    const dto = (await created.json()) as Record<string, unknown>;
    expect(dto.kind).toBe("finance");
    expect(dto.status).toBe("queued");
    // The DTO never exposes the prompt carriage — the File id is the row's
    // private input, consumed by the runner only.
    expect("prompt" in dto).toBe(false);
    expect("csvFileId" in dto).toBe(false);
    expect(fixture.rows.tasks).toHaveLength(1);
    expect(fixture.rows.tasks[0].prompt).toBe("file-1");

    const withoutFile = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "finance",
    });
    expect(withoutFile.status).toBe(400);
    const withPrompt = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "finance",
      prompt: "summarize my spending",
      csvFileId: "file-1",
    });
    expect(withPrompt.status).toBe(400);
    const onAnotherKind = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      csvFileId: "file-1",
    });
    expect(onAnotherKind.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(1);
  });

  /*
   * T13's contract gate, mirrored from document's: without the files seam the
   * runner can never read the CSV, so creation answers 503 rather than writing
   * a row that is guaranteed to fail; and the CSV is owner-validated at
   * creation — a foreign, missing or tombstoned File answers the same 404.
   */
  test("finance creation answers 503 without the files seam, 404 for a CSV the caller does not own", async () => {
    const bare = fixtureFor();
    const unavailable = await postTask(bare.app, {
      botId: "bot-1",
      kind: "finance",
      csvFileId: "file-1",
    });
    expect(unavailable.status).toBe(503);
    expect(bare.rows.tasks).toHaveLength(0);

    const fixture = financeFixture();
    const foreign = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "finance",
      csvFileId: "file-1",
    });
    expect(foreign.status).toBe(404);
    expect(fixture.rows.tasks).toHaveLength(0);
  });
});

/** T13: the finance creation gate's own files seam — one owned CSV, one row store. */
function financeFixture() {
  const owned = new Set<string>();
  const rows = fakeRows();
  const app = createOpenMuseTasksRoutes({
    store: createOpenMuseTaskStore({ rows }),
    requireUser,
    resolvePrivateBotId: async (ownerUserId) =>
      ownerUserId === "user-1" ? "bot-1" : null,
    files: {
      getOwnedFile: async (ownerUserId: string, id: string) =>
        owned.has(`${ownerUserId}:${id}`)
          ? {
              file: {
                id,
                name: `${id}.csv`,
                mimeType: "text/csv",
                size: 4,
                sha256: `${id}-sha`,
                versionId: `${id}-v1`,
                createdAt: new Date(),
              },
              read: async () => new Uint8Array([105, 100, 10]),
            }
          : null,
    },
  });
  return {
    rows,
    app,
    addCsv: (ownerUserId: string, id: string) => {
      owned.add(`${ownerUserId}:${id}`);
    },
  };
}

describe("GET / (list)", () => {
  test("returns only the owner's tasks, newest first, paging default 25 / max 100", async () => {
    const fixture = fixtureFor();
    const when = new Date("2026-10-01T00:00:00Z");
    for (let index = 0; index < 30; index += 1) {
      const id = `t${index.toString().padStart(2, "0")}`;
      await fixture.rows.insertTask(
        storedTask({
          id,
          ownerUserId: "user-1",
          createdAt: new Date(when.getTime() + index * 1_000),
          updatedAt: new Date(when.getTime() + index * 1_000),
        }),
      );
    }
    await fixture.rows.insertTask(
      storedTask({
        id: "foreign",
        ownerUserId: "user-2",
        createdAt: new Date(when.getTime() + 99_000),
      }),
    );

    const first = await fixture.app.request("/?limit=25");
    const firstBody = (await first.json()) as {
      tasks: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstBody.tasks).toHaveLength(25);
    expect(firstBody.tasks[0]?.id).toBe("t29");
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await fixture.app.request(
      `/?limit=25&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    );
    const secondBody = (await second.json()) as {
      tasks: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(secondBody.tasks.map((task) => task.id)).toEqual([
      "t04",
      "t03",
      "t02",
      "t01",
      "t00",
    ]);
    expect(secondBody.nextCursor).toBeUndefined();
    expect(firstBody.tasks.some((task) => task.id === "foreign")).toBe(false);

    const refused = await fixture.app.request("/?limit=abc");
    expect(refused.status).toBe(400);
    const clamped = await fixture.app.request("/?limit=101");
    expect(clamped.status).toBe(200);
    const refusedCursor = await fixture.app.request("/?cursor=not-base64");
    expect(refusedCursor.status).toBe(400);
  });
});

describe("GET /:id", () => {
  test("returns the owner's full record and 404 for a foreign or missing id", async () => {
    const fixture = fixtureFor();
    const created = (await (
      await postTask(fixture.app, {
        botId: "bot-1",
        kind: "agent",
        prompt: "a",
      })
    ).json()) as { id: string; createdAt: string; updatedAt: string };

    const own = await fixture.app.request(`/${created.id}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      id: created.id,
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      status: "queued",
      attempts: 1,
      steps: [],
      evidence: [],
      artifactIds: [],
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });

    const missing = await fixture.app.request("/no-such-task");
    expect(missing.status).toBe(404);

    await fixture.rows.insertTask(
      storedTask({ id: "foreign", ownerUserId: "user-2" }),
    );
    const foreign = await fixture.app.request("/foreign");
    expect(foreign.status).toBe(404);
  });
});

describe("authentication", () => {
  test("without a session both verbs answer 401", async () => {
    const fixture = fixtureFor();
    guardAdmits = false;
    try {
      const create = await postTask(fixture.app, {
        botId: "bot-1",
        kind: "agent",
        prompt: "a",
      });
      expect(create.status).toBe(401);
      const list = await fixture.app.request("/");
      expect(list.status).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});

describe("restart durability", () => {
  test("a second store over the same rows still lists the task", async () => {
    const fixture = fixtureFor();
    await postTask(
      fixture.app,
      { botId: "bot-1", kind: "agent", prompt: "durable" },
      "durable-key",
    );
    const restarted = createOpenMuseTaskStore({ rows: fixture.rows });
    const listed = await restarted.list("user-1", { limit: 25 });
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]?.kind).toBe("agent");
    expect(listed.tasks[0]?.status).toBe("queued");
  });
});

describe("mounted through the mobile bff", () => {
  test("creates under /openmuse-tasks through the bff aggregation seam", async () => {
    const fixture = fixtureFor();
    const { createMobileBffRoutes } = await import("../src/mobile-bff/routes");
    const { createMobileBffWorkspace } = await import(
      "../src/mobile-bff/workspace"
    );
    const bff = createMobileBffRoutes({
      requireUser,
      workspace: createMobileBffWorkspace({
        agentProfileStore: undefined,
        channelStore: undefined,
      }),
      openMuseTasks: fixture.app,
    });
    const response = await bff.request("/openmuse-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-1",
        kind: "agent",
        prompt: "through the bff",
      }),
    });
    expect(response.status).toBe(201);
    const list = await bff.request("/openmuse-tasks");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { tasks: Array<{ id: string }> };
    expect(body.tasks).toHaveLength(1);
  });

  test("refuses an oversized body with 413 even though the bff limit never wraps it", async () => {
    const fixture = fixtureFor();
    const { createMobileBffRoutes } = await import("../src/mobile-bff/routes");
    const { createMobileBffWorkspace } = await import(
      "../src/mobile-bff/workspace"
    );
    const bff = createMobileBffRoutes({
      requireUser,
      workspace: createMobileBffWorkspace({
        agentProfileStore: undefined,
        channelStore: undefined,
      }),
      openMuseTasks: fixture.app,
    });
    const response = await bff.request("/openmuse-tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Past the sub-app's own 64 KiB ceiling: mounted before the bff's 8 KiB
      // family limit, nothing else would bound the buffered body.
      body: JSON.stringify({
        botId: "bot-1",
        kind: "agent",
        prompt: "x".repeat(70_000),
      }),
    });
    expect(response.status).toBe(413);
    expect(fixture.rows.tasks).toHaveLength(0);
  });
});

describe("request body limit", () => {
  test("a maximal prompt (20k chars) still passes the sub-app's own 64 KiB limit", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "y".repeat(20_000),
    });
    expect(response.status).toBe(201);
  });

  test("a body past 64 KiB answers 413 before anything is buffered or written", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "z".repeat(70_000),
    });
    expect(response.status).toBe(413);
    expect(fixture.rows.tasks).toHaveLength(0);
  });
});

describe("POST /:id/cancel (T04, §7 cancel matrix)", () => {
  test("queued → cancelled immediately: 200, status cancelled, attempts unchanged", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Summarise the mail.",
      idempotencyKey: null,
    });
    const response = await fixture.app.request(`/${task.id}/cancel`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
    };
    expect(body.status).toBe("cancelled");
    expect(body.attempts).toBe(1);
    const row = fixture.rows.tasks.find((stored) => stored.id === task.id);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancellationRequested).toBe(false);
  });

  test("scheduled → cancelled immediately, same shape", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "sched", status: "scheduled" }),
    );
    const response = await fixture.app.request("/sched/cancel", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
    };
    expect(body.status).toBe("cancelled");
    expect(body.attempts).toBe(1);
  });

  test("running → 200 with status running and cancellationRequested; the row keeps running", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "live", status: "running" }),
    );
    const response = await fixture.app.request("/live/cancel", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      cancellationRequested: boolean;
    };
    expect(body.status).toBe("running");
    expect(body.cancellationRequested).toBe(true);
    const row = fixture.rows.tasks.find((stored) => stored.id === "live");
    expect(row?.status).toBe("running");
    expect(row?.cancellationRequested).toBe(true);
  });

  test("terminal states answer 409 with the current status", async () => {
    const fixture = fixtureFor();
    for (const status of ["succeeded", "cancelled", "failed"] as const) {
      await fixture.rows.insertTask(
        storedTask({ id: `done-${status}`, status }),
      );
      const response = await fixture.app.request(`/done-${status}/cancel`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { currentStatus: string };
      expect(body.currentStatus).toBe(status);
    }
  });

  test("a second cancel on a cancel-requested running task is idempotent: 200, same body, no double flag", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "live", status: "running" }),
    );
    const first = await fixture.app.request("/live/cancel", { method: "POST" });
    const firstBody = await first.json();
    const row = fixture.rows.tasks.find((stored) => stored.id === "live");
    const flagSetAt = row?.updatedAt;
    const second = await fixture.app.request("/live/cancel", {
      method: "POST",
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(row?.cancellationRequested).toBe(true);
    expect(row?.updatedAt).toBe(flagSetAt);
  });

  test("a foreign owner's task and a missing id answer 404", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "theirs", ownerUserId: "user-2", status: "queued" }),
    );
    const foreign = await fixture.app.request("/theirs/cancel", {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
    const missing = await fixture.app.request("/no-such-task/cancel", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    const row = fixture.rows.tasks.find((stored) => stored.id === "theirs");
    expect(row?.status).toBe("queued");
  });

  test("§9: a disabled owner cannot cancel", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      idempotencyKey: null,
    });
    await fixture.store.disableOwner("user-1");
    const response = await fixture.app.request(`/${task.id}/cancel`, {
      method: "POST",
    });
    expect(response.status).toBe(403);
    await fixture.store.restoreOwner("user-1");
    const restored = await fixture.app.request(`/${task.id}/cancel`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
  });
});

describe("POST /:id/pause (T05, §7 pause matrix)", () => {
  test("queued → paused immediately: 200, status paused, attempts unchanged", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Summarise the mail.",
      idempotencyKey: null,
    });
    const response = await fixture.app.request(`/${task.id}/pause`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
      pauseRequested: boolean;
    };
    expect(body.status).toBe("paused");
    expect(body.attempts).toBe(1);
    expect(body.pauseRequested).toBe(false);
    const row = fixture.rows.tasks.find((stored) => stored.id === task.id);
    expect(row?.status).toBe("paused");
    expect(row?.pauseRequested).toBe(false);
  });

  test("scheduled → paused immediately, same shape", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "sched", status: "scheduled" }),
    );
    const response = await fixture.app.request("/sched/pause", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("paused");
  });

  test("running → 200 with status running and pauseRequested; the row keeps running", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "live", status: "running" }),
    );
    const response = await fixture.app.request("/live/pause", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      pauseRequested: boolean;
    };
    expect(body.status).toBe("running");
    expect(body.pauseRequested).toBe(true);
    const row = fixture.rows.tasks.find((stored) => stored.id === "live");
    expect(row?.status).toBe("running");
    expect(row?.pauseRequested).toBe(true);
  });

  test("a second pause on a pause-requested running task is idempotent: 200, same body, no double flag", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "live", status: "running" }),
    );
    const first = await fixture.app.request("/live/pause", { method: "POST" });
    const firstBody = await first.json();
    const row = fixture.rows.tasks.find((stored) => stored.id === "live");
    const flagSetAt = row?.updatedAt;
    const second = await fixture.app.request("/live/pause", { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(row?.pauseRequested).toBe(true);
    expect(row?.updatedAt).toBe(flagSetAt);
  });

  test("a paused task answering pause again is 409 with currentStatus paused", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(storedTask({ id: "held", status: "paused" }));
    const response = await fixture.app.request("/held/pause", {
      method: "POST",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { currentStatus: string };
    expect(body.currentStatus).toBe("paused");
  });

  test("terminal states answer 409 with the current status", async () => {
    const fixture = fixtureFor();
    for (const status of ["succeeded", "cancelled", "failed"] as const) {
      await fixture.rows.insertTask(
        storedTask({ id: `done-${status}`, status }),
      );
      const response = await fixture.app.request(`/done-${status}/pause`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { currentStatus: string };
      expect(body.currentStatus).toBe(status);
    }
  });

  test("a foreign owner's task and a missing id answer 404", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "theirs", ownerUserId: "user-2", status: "queued" }),
    );
    const foreign = await fixture.app.request("/theirs/pause", {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
    const missing = await fixture.app.request("/no-such-task/pause", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    const row = fixture.rows.tasks.find((stored) => stored.id === "theirs");
    expect(row?.status).toBe("queued");
  });

  test("§9: a disabled owner cannot pause", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      idempotencyKey: null,
    });
    await fixture.store.disableOwner("user-1");
    const response = await fixture.app.request(`/${task.id}/pause`, {
      method: "POST",
    });
    expect(response.status).toBe(403);
    await fixture.store.restoreOwner("user-1");
    const restored = await fixture.app.request(`/${task.id}/pause`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
  });
});

describe("POST /:id/resume (T05)", () => {
  test("paused → queued: 200, the pause flag cleared, re-offered exactly once", async () => {
    const fixture = fixtureWithQueue();
    await fixture.rows.insertTask(storedTask({ id: "held", status: "paused" }));
    const response = await fixture.app.request("/held/resume", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
    };
    expect(body.status).toBe("queued");
    expect(body.attempts).toBe(1);
    // The re-offer is one fresh queue identity carrying the task id in its
    // payload — not the task id itself, which a finished queue row occupies.
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: "held" },
    });
    expect(fixture.queue.offered[0]?.key).toMatch(/^held:/);
    const row = fixture.rows.tasks.find((stored) => stored.id === "held");
    expect(row?.status).toBe("queued");
    expect(row?.pauseRequested).toBe(false);
  });

  test("a second resume while queued is 409 with currentStatus queued, no second offer", async () => {
    const fixture = fixtureWithQueue();
    await fixture.rows.insertTask(storedTask({ id: "held", status: "paused" }));
    const first = await fixture.app.request("/held/resume", {
      method: "POST",
    });
    expect(first.status).toBe(200);
    const second = await fixture.app.request("/held/resume", {
      method: "POST",
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { currentStatus: string };
    expect(body.currentStatus).toBe("queued");
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("resume from any non-paused state is 409 with the current status", async () => {
    const fixture = fixtureFor();
    for (const status of [
      "queued",
      "running",
      "succeeded",
      "cancelled",
      "failed",
    ] as const) {
      await fixture.rows.insertTask(storedTask({ id: `r-${status}`, status }));
      const response = await fixture.app.request(`/r-${status}/resume`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { currentStatus: string };
      expect(body.currentStatus).toBe(status);
    }
  });

  test("a foreign owner's task and a missing id answer 404; a disabled owner is 403", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(
      storedTask({ id: "theirs", ownerUserId: "user-2", status: "paused" }),
    );
    const foreign = await fixture.app.request("/theirs/resume", {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
    const missing = await fixture.app.request("/no-such-task/resume", {
      method: "POST",
    });
    expect(missing.status).toBe(404);

    const held = fixtureWithQueue();
    await held.rows.insertTask(storedTask({ id: "held", status: "paused" }));
    await held.store.disableOwner("user-1");
    const disabled = await held.app.request("/held/resume", {
      method: "POST",
    });
    expect(disabled.status).toBe(403);
    expect(held.queue.offered).toHaveLength(0);
  });
});

describe("§9 lifecycle hook", () => {
  test("disableOwner blocks create and list; enumerateOwner returns task refs", async () => {
    const fixture = fixtureFor();
    const created = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      idempotencyKey: null,
    });
    await fixture.store.disableOwner("user-1");
    await expect(
      fixture.store.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        idempotencyKey: null,
      }),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);
    const response = await fixture.app.request("/");
    expect(response.status).toBe(403);
    const post = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
    });
    expect(post.status).toBe(403);

    await fixture.store.restoreOwner("user-1");
    const refs = await fixture.store.enumerateOwner("user-1");
    expect(refs).toEqual([{ kind: "openmuse-task", id: created.task.id }]);
    expect(await fixture.store.enumerateOwner("user-2")).toEqual([]);
  });
});

/**
 * T06: the queue the runner claims from — offer, claim-once, finish — so the
 * compatibility test drives the real runner over a retried row.
 */
function claimingQueue() {
  const offered: Array<{
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
  }> = [];
  const waiting = new Map<string, Record<string, unknown>>();
  const finished: string[] = [];
  return {
    offered,
    offer: async (item: {
      kind: string;
      key: string;
      payload?: Record<string, unknown>;
    }) => {
      offered.push(item);
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
    }) =>
      [...waiting.keys()]
        .filter((key) => !finished.includes(key))
        .slice(0, input.limit ?? 1)
        .map((key) => {
          const payload = waiting.get(key) ?? {};
          waiting.delete(key);
          return { kind: input.kind, key, payload, attempts: 1 };
        }),
    finish: async ({ key }: { key: string }) => {
      finished.push(key);
      return true;
    },
    purge: async () => 0,
  };
}

describe("POST /:id/retry (T06, §7 retry matrix)", () => {
  test("failed → queued as a new attempt: attempts+1, flags cleared, old steps/evidence retained, re-offered once", async () => {
    const fixture = fixtureWithQueue();
    const attemptOneSteps = [
      {
        id: "run",
        title: "Run",
        dependsOn: [],
        status: "failed",
        result: "The turn errored.",
      },
    ];
    const attemptOneEvidence = [
      {
        id: "fell:prompt",
        kind: "user",
        title: "Your request",
        excerpt: "Summarise the mail.",
      },
    ];
    await fixture.rows.insertTask(
      storedTask({
        id: "fell",
        status: "failed",
        attempts: 1,
        cancellationRequested: true,
        pauseRequested: true,
        steps: attemptOneSteps,
        evidence: attemptOneEvidence,
      }),
    );
    const response = await fixture.app.request("/fell/retry", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
      steps: unknown[];
      evidence: unknown[];
    };
    expect(body.status).toBe("queued");
    expect(body.attempts).toBe(2);
    // §7: the new attempt retains every piece of the old one's evidence —
    // each retained row stamped with the generation that wrote it on the
    // ROW, so a later T07 recovery can tell history from the current
    // attempt. The DTO strips that internal stamp: the client sees the
    // steps and evidence, never the runner's generation bookkeeping.
    const stampedSteps = [{ ...attemptOneSteps[0], attempt: 1 }];
    const stampedEvidence = [{ ...attemptOneEvidence[0], attempt: 1 }];
    expect(body.steps).toEqual(attemptOneSteps);
    expect(body.evidence).toEqual(attemptOneEvidence);
    const row = fixture.rows.tasks.find((stored) => stored.id === "fell");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(2);
    expect(row?.cancellationRequested).toBe(false);
    expect(row?.pauseRequested).toBe(false);
    expect(row?.steps).toEqual(stampedSteps);
    expect(row?.evidence).toEqual(stampedEvidence);
    // One re-offer under a fresh queue identity, the same seam resume uses.
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: "fell" },
    });
    expect(fixture.queue.offered[0]?.key).toMatch(/^fell:/);
  });

  test("a failed monitor retries to scheduled re-armed now with a runAt-armed offer — never parked in queued", async () => {
    const fixture = fixtureWithQueue();
    const failedObservation = {
      id: "m-fell:observation:2026-10-01T00:30:00.000Z",
      kind: "web",
      title: "Monitor observation",
      excerpt: "price 245.10",
      matched: false,
    };
    await fixture.rows.insertTask(
      storedTask({
        id: "m-fell",
        kind: "monitor",
        status: "failed",
        attempts: 1,
        evidence: [failedObservation],
        monitorCondition: {
          type: "price_below",
          intervalMinutes: 30,
          source: "https://shop.example/widget",
          threshold: 250,
        },
        nextCheckAt: new Date("2026-10-01T00:30:00.000Z"),
      }),
    );
    const before = Date.now();
    const response = await fixture.app.request("/m-fell/retry", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
    };
    // T06×T10: the runner's monitor branch only executes `scheduled` rows,
    // so a retried monitor re-arms there — due now, because a retry is an
    // explicit ask for a fresh check (resume keeps the interval rhythm; a
    // retry does not make the owner wait one out).
    expect(body.status).toBe("scheduled");
    expect(body.attempts).toBe(2);
    const row = fixture.rows.tasks.find((stored) => stored.id === "m-fell");
    expect(row?.nextCheckAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(row?.nextCheckAt?.getTime()).toBeLessThanOrEqual(Date.now());
    // The re-offer is scheduled at the re-armed instant, exactly as resume's.
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]?.runAt?.getTime()).toBe(
      row?.nextCheckAt?.getTime(),
    );
    // The retained observation is stamped generation 1: history, not a
    // possible external effect of the retry's own attempt.
    expect(row?.evidence[0]).toMatchObject({
      ...failedObservation,
      attempt: 1,
    });
  });

  test("succeeded, cancelled and queued answer 409 with the current status", async () => {
    const fixture = fixtureFor();
    for (const status of ["succeeded", "cancelled", "queued"] as const) {
      await fixture.rows.insertTask(storedTask({ id: `r-${status}`, status }));
      const response = await fixture.app.request(`/r-${status}/retry`, {
        method: "POST",
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { currentStatus: string };
      expect(body.currentStatus).toBe(status);
    }
    const queued = fixture.rows.tasks.find(
      (stored) => stored.id === "r-queued",
    );
    expect(queued?.attempts).toBe(1);
  });

  test("two concurrent retries with one Idempotency-Key create ONE attempt; the second replays the retried record", async () => {
    const fixture = fixtureWithQueue();
    await fixture.rows.insertTask(storedTask({ id: "fell", status: "failed" }));
    const responses = await Promise.all([
      fixture.app.request("/fell/retry", {
        method: "POST",
        headers: { "Idempotency-Key": "one-shot" },
      }),
      fixture.app.request("/fell/retry", {
        method: "POST",
        headers: { "Idempotency-Key": "one-shot" },
      }),
    ]);
    for (const response of responses) expect(response.status).toBe(200);
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    const [first, second] = bodies as Array<{
      status: string;
      attempts: number;
    }>;
    expect(second).toEqual(first);
    expect(first.status).toBe("queued");
    expect(first.attempts).toBe(2);
    expect(
      fixture.rows.tasks.find((stored) => stored.id === "fell")?.attempts,
    ).toBe(2);
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("different keys retry again once the new attempt fails; a consumed key never double-applies", async () => {
    const fixture = fixtureWithQueue();
    await fixture.rows.insertTask(storedTask({ id: "fell", status: "failed" }));
    const first = await fixture.app.request("/fell/retry", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    expect(((await first.json()) as { attempts: number }).attempts).toBe(2);

    // The allowed cadence: another retry is accepted only once this new
    // attempt has failed; a queued or succeeded row is never retried.
    const row = fixture.rows.tasks.find((stored) => stored.id === "fell");
    if (!row) throw new Error("missing fixture row");
    row.status = "failed";

    // k1 is consumed — its one attempt already happened — so it replays the
    // current record instead of creating a third attempt.
    const replay = await fixture.app.request("/fell/retry", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      status: string;
      attempts: number;
    };
    expect(replayBody.status).toBe("failed");
    expect(replayBody.attempts).toBe(2);
    expect(fixture.queue.offered).toHaveLength(1);

    const second = await fixture.app.request("/fell/retry", {
      method: "POST",
      headers: { "Idempotency-Key": "k2" },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      status: string;
      attempts: number;
    };
    expect(secondBody.status).toBe("queued");
    expect(secondBody.attempts).toBe(3);
    expect(fixture.queue.offered).toHaveLength(2);
  });

  test("a foreign owner's task and a missing id answer 404; a disabled owner is 403 with no offer", async () => {
    const fixture = fixtureWithQueue();
    await fixture.rows.insertTask(
      storedTask({ id: "theirs", ownerUserId: "user-2", status: "failed" }),
    );
    const foreign = await fixture.app.request("/theirs/retry", {
      method: "POST",
    });
    expect(foreign.status).toBe(404);
    const missing = await fixture.app.request("/no-such-task/retry", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
    const row = fixture.rows.tasks.find((stored) => stored.id === "theirs");
    expect(row?.status).toBe("failed");
    expect(fixture.queue.offered).toHaveLength(0);

    await fixture.store.disableOwner("user-1");
    await fixture.rows.insertTask(storedTask({ id: "fell", status: "failed" }));
    const disabled = await fixture.app.request("/fell/retry", {
      method: "POST",
    });
    expect(disabled.status).toBe(403);
    expect(fixture.queue.offered).toHaveLength(0);
  });

  test("runner compatibility: the retried Task runs again and lands terminal with both attempts' evidence", async () => {
    const rows = fakeRows();
    const queue = claimingQueue();
    const store = createOpenMuseTaskStore({ rows, queue });
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
      runTurn: async () => ({ replyText: "Done on the second attempt." }),
    });
    await rows.insertTask(
      storedTask({
        id: "fell",
        status: "failed",
        prompt: "Summarise the mail.",
        steps: [
          {
            id: "run",
            title: "Run",
            dependsOn: [],
            status: "failed",
            result: "The turn errored.",
          },
        ],
        evidence: [
          {
            id: "fell:prompt",
            kind: "user",
            title: "Your request",
            excerpt: "Summarise the mail.",
          },
        ],
      }),
    );
    const { task } = await store.retryTask("user-1", "fell", null);
    expect(task.status).toBe("queued");
    expect(task.attempts).toBe(2);
    const report = await runner.sweep();
    expect(report.ran).toHaveLength(1);
    const row = rows.tasks.find((stored) => stored.id === "fell");
    expect(row?.status).toBe("succeeded");
    expect(row?.attempts).toBe(2);
    // Both attempts' evidence survives: attempt 1's failed run beside the
    // retried attempt's succeeded one, nothing truncated away.
    const steps = (row?.steps ?? []) as Array<{
      status: string;
      result?: string;
    }>;
    expect(steps).toHaveLength(2);
    expect(steps[0]?.status).toBe("failed");
    expect(steps[1]?.result).toBe("Done on the second attempt.");
    const evidenceIds = (row?.evidence ?? []).map(
      (entry) => (entry as { id: string }).id,
    );
    expect(evidenceIds.filter((id) => id === "fell:prompt")).toHaveLength(2);
    expect(evidenceIds).toContain("fell:result");
  });
});

describe("T08 wait-for-input (§7 human wait)", () => {
  /** Opens one input wait on a freshly running row and hands back the stored row's wait. */
  async function openWaitOn(
    fixture: ReturnType<typeof fixtureFor>,
    id: string,
    fields?: Array<{ name: string; type: "string" | "boolean" }>,
  ) {
    await fixture.rows.insertTask(storedTask({ id, status: "running" }));
    const opened = await fixture.store.openWait(id, {
      ifAttempts: 1,
      question: "Forward which address?",
      ...(fields !== undefined ? { fields } : {}),
    });
    expect(opened?.status).toBe("waiting_input");
    return opened?.wait;
  }

  function answerWait(
    app: Hono<{ Variables: AppVariables }>,
    taskId: string,
    waitId: string,
    values: unknown,
  ): Promise<Response> {
    return app.request(`/${taskId}/wait/${waitId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
    });
  }

  test("openWait: running → waiting_input with the §7 wait record; each open mints a fresh waitId", async () => {
    const fixture = fixtureFor();
    const one = await openWaitOn(fixture, "live-1");
    const two = await openWaitOn(fixture, "live-2");
    expect(one).toMatchObject({
      taskId: "live-1",
      kind: "input",
      question: "Forward which address?",
    });
    expect(one?.waitId).toBeTypeOf("string");
    expect(one?.createdAt).toBeTypeOf("string");
    expect(one?.answeredAt).toBeUndefined();
    expect(one?.waitId).not.toBe(two?.waitId);
    // T07's generation CAS: a stale attempt lands no wait at all.
    expect(
      await fixture.store.openWait("live-1", {
        ifAttempts: 2,
        question: "stale",
      }),
    ).toBeNull();
    // GET /:id exposes the open wait so the client can render it.
    const detail = await fixture.app.request("/live-1");
    const body = (await detail.json()) as {
      status: string;
      wait?: { waitId: string; question: string };
    };
    expect(body.status).toBe("waiting_input");
    expect(body.wait?.waitId).toBe(one?.waitId);
    expect(body.wait?.question).toBe("Forward which address?");
  });

  test("openWait refuses a row that is not running: nothing lands", async () => {
    const fixture = fixtureFor();
    await fixture.rows.insertTask(storedTask({ id: "idle", status: "queued" }));
    expect(
      await fixture.store.openWait("idle", {
        ifAttempts: 1,
        question: "q",
      }),
    ).toBeNull();
    const row = fixture.rows.tasks.find((stored) => stored.id === "idle");
    expect(row?.wait).toBeUndefined();
    expect(row?.status).toBe("queued");
  });

  test("first valid answer consumes once: 200 queued, answeredAt and answer stored, re-offered exactly once", async () => {
    const fixture = fixtureWithQueue();
    const wait = await openWaitOn(fixture, "held", [
      { name: "address", type: "string" },
      { name: "confirmed", type: "boolean" },
    ]);
    const response = await answerWait(fixture.app, "held", wait?.waitId ?? "", {
      address: "x@openbot.test",
      confirmed: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
      wait?: { answeredAt?: string; answer?: Record<string, unknown> };
    };
    expect(body.status).toBe("queued");
    expect(body.attempts).toBe(1);
    expect(body.wait?.answeredAt).toBeTypeOf("string");
    expect(body.wait?.answer).toEqual({
      address: "x@openbot.test",
      confirmed: true,
    });
    // One fresh-identity re-offer, the same seam resume and retry use.
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: "held" },
    });
    expect(fixture.queue.offered[0]?.key).toMatch(/^held:/);
    const row = fixture.rows.tasks.find((stored) => stored.id === "held");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
  });

  test("a repeat answer returns the stored result: no second consume, no second offer", async () => {
    const fixture = fixtureWithQueue();
    const wait = await openWaitOn(fixture, "held", [
      { name: "address", type: "string" },
    ]);
    const first = await answerWait(fixture.app, "held", wait?.waitId ?? "", {
      address: "first@openbot.test",
    });
    expect(first.status).toBe(200);
    // The repeat may even carry different values: the stored answer is the answer.
    const repeat = await answerWait(fixture.app, "held", wait?.waitId ?? "", {
      address: "second@openbot.test",
    });
    expect(repeat.status).toBe(200);
    const body = (await repeat.json()) as {
      status: string;
      wait?: { answer?: Record<string, unknown> };
    };
    expect(body.status).toBe("queued");
    expect(body.wait?.answer).toEqual({ address: "first@openbot.test" });
    expect(fixture.queue.offered).toHaveLength(1);
    const row = fixture.rows.tasks.find((stored) => stored.id === "held");
    expect(row?.status).toBe("queued");
  });

  test("malformed values answer 400 and leave the wait open: wrong type, missing field, unknown field", async () => {
    const fixture = fixtureWithQueue();
    const wait = await openWaitOn(fixture, "held", [
      { name: "address", type: "string" },
      { name: "confirmed", type: "boolean" },
    ]);
    const cases: Array<Record<string, unknown>> = [
      { address: true, confirmed: true }, // wrong type
      { address: "x@openbot.test" }, // missing field
      { address: "x@openbot.test", confirmed: true, extra: "1" }, // unknown field
    ];
    for (const values of cases) {
      const response = await answerWait(
        fixture.app,
        "held",
        wait?.waitId ?? "",
        values,
      );
      expect(response.status).toBe(400);
      const row = fixture.rows.tasks.find((stored) => stored.id === "held");
      expect(row?.status).toBe("waiting_input");
      expect(row?.wait?.answeredAt).toBeUndefined();
    }
    // A body that is not {values: object} is refused at the route shape.
    const shapeless = await fixture.app.request(
      `/held/wait/${wait?.waitId}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: "just text" }),
      },
    );
    expect(shapeless.status).toBe(400);
    expect(fixture.queue.offered).toHaveLength(0);
  });

  test("a foreign owner's task, an invalid waitId and a missing task answer 404", async () => {
    const fixture = fixtureFor();
    // Foreign AND already answered: either way the answer is not theirs to give.
    await fixture.rows.insertTask(
      storedTask({
        id: "theirs",
        ownerUserId: "user-2",
        status: "waiting_input",
        wait: {
          waitId: "w-theirs",
          taskId: "theirs",
          kind: "input",
          question: "q",
          createdAt: new Date().toISOString(),
          answeredAt: new Date().toISOString(),
        },
      }),
    );
    const foreign = await answerWait(fixture.app, "theirs", "w-theirs", {});
    expect(foreign.status).toBe(404);

    await openWaitOn(fixture, "mine");
    const wrongWaitId = await answerWait(fixture.app, "mine", "no-such-wait", {
      address: "x",
    });
    expect(wrongWaitId.status).toBe(404);
    const missing = await answerWait(fixture.app, "no-such-task", "any", {});
    expect(missing.status).toBe(404);
    const row = fixture.rows.tasks.find((stored) => stored.id === "mine");
    expect(row?.status).toBe("waiting_input");
    expect(row?.wait?.answeredAt).toBeUndefined();
  });

  test("an open wait whose row moved on (cancelled) answers 409 with the current status", async () => {
    const fixture = fixtureFor();
    const wait = await openWaitOn(fixture, "gone", [
      { name: "a", type: "string" },
    ]);
    const row = fixture.rows.tasks.find((stored) => stored.id === "gone");
    if (row) row.status = "cancelled";
    const response = await answerWait(fixture.app, "gone", wait?.waitId ?? "", {
      a: "x",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { currentStatus: string };
    expect(body.currentStatus).toBe("cancelled");
    expect(row?.wait?.answeredAt).toBeUndefined();
  });

  test("restart durability: a second store over the same rows answers the open wait", async () => {
    const fixture = fixtureWithQueue();
    const wait = await openWaitOn(fixture, "held", [
      { name: "address", type: "string" },
    ]);
    const restarted = createOpenMuseTaskStore({
      rows: fixture.rows,
      queue: fixture.queue,
    });
    const result = await restarted.answerWait(
      "user-1",
      "held",
      wait?.waitId ?? "",
      {
        address: "after@restart.test",
      },
    );
    expect(result.outcome).toBe("answered");
    const row = fixture.rows.tasks.find((stored) => stored.id === "held");
    expect(row?.status).toBe("queued");
    expect(row?.wait?.answer).toEqual({ address: "after@restart.test" });
    expect(fixture.queue.offered).toHaveLength(1);
  });

  test("§9: a disabled owner cannot answer; the wait stays open", async () => {
    const fixture = fixtureWithQueue();
    const wait = await openWaitOn(fixture, "held", [
      { name: "address", type: "string" },
    ]);
    await fixture.store.disableOwner("user-1");
    const disabled = await answerWait(fixture.app, "held", wait?.waitId ?? "", {
      address: "x@openbot.test",
    });
    expect(disabled.status).toBe(403);
    expect(fixture.queue.offered).toHaveLength(0);
    await fixture.store.restoreOwner("user-1");
    const restored = await answerWait(fixture.app, "held", wait?.waitId ?? "", {
      address: "x@openbot.test",
    });
    expect(restored.status).toBe(200);
  });
});

describe("POST / (create, kind plan) (T09)", () => {
  test("a valid plan graph is accepted: the row stores every step pending with its graph", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "Clean up my inbox.",
      steps: [
        { id: "s1", title: "List unread mail", dependsOn: [] },
        { id: "s2", title: "Archive the old ones", dependsOn: ["s1"] },
        { id: "s3", title: "Report what stayed", dependsOn: ["s2"] },
      ],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      kind: string;
      status: string;
      steps: unknown[];
    };
    expect(body.kind).toBe("plan");
    expect(body.status).toBe("queued");
    expect(body.steps).toEqual([
      { id: "s1", title: "List unread mail", dependsOn: [], status: "pending" },
      {
        id: "s2",
        title: "Archive the old ones",
        dependsOn: ["s1"],
        status: "pending",
      },
      {
        id: "s3",
        title: "Report what stayed",
        dependsOn: ["s2"],
        status: "pending",
      },
    ]);
    expect(fixture.rows.tasks).toHaveLength(1);
  });

  test("a duplicated dependsOn entry does not read as a cycle: the peel counts real transitions", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [
        { id: "s1", title: "One", dependsOn: [] },
        // ["s1","s1"]: the dependent registers twice, the unmet set once —
        // re-enqueueing on the second delete would double-count the peel
        // and refuse this legal acyclic plan as a cycle.
        { id: "s2", title: "Two", dependsOn: ["s1", "s1"] },
      ],
    });
    expect(response.status).toBe(201);
    expect(fixture.rows.tasks).toHaveLength(1);
  });

  test("a cyclic graph answers 400 and inserts nothing", async () => {
    const fixture = fixtureFor();
    const twoCycle = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [
        { id: "s1", title: "One", dependsOn: ["s2"] },
        { id: "s2", title: "Two", dependsOn: ["s1"] },
      ],
    });
    expect(twoCycle.status).toBe(400);
    const selfCycle = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [{ id: "s1", title: "One", dependsOn: ["s1"] }],
    });
    expect(selfCycle.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("an unknown dependsOn id answers 400", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [{ id: "s1", title: "One", dependsOn: ["no-such-step"] }],
    });
    expect(response.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("more than 50 steps answers 400", async () => {
    const fixture = fixtureFor();
    const steps = Array.from({ length: 51 }, (_, index) => ({
      id: `s${index}`,
      title: `Step ${index}`,
      dependsOn: index === 0 ? [] : [`s${index - 1}`],
    }));
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps,
    });
    expect(response.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("duplicate step ids answer 400", async () => {
    const fixture = fixtureFor();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [
        { id: "s1", title: "One", dependsOn: [] },
        { id: "s1", title: "Also one", dependsOn: [] },
      ],
    });
    expect(response.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("steps on a non-plan kind, and a plan without steps, answer 400", async () => {
    const fixture = fixtureFor();
    const agentWithSteps = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "p",
      steps: [{ id: "s1", title: "One", dependsOn: [] }],
    });
    expect(agentWithSteps.status).toBe(400);
    const planWithoutSteps = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
    });
    expect(planWithoutSteps.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("§9: a disabled owner cannot create a plan task", async () => {
    const fixture = fixtureFor();
    await fixture.store.disableOwner("user-1");
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [{ id: "s1", title: "One", dependsOn: [] }],
    });
    expect(response.status).toBe(403);
    await fixture.store.restoreOwner("user-1");
    const restored = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "plan",
      prompt: "p",
      steps: [{ id: "s1", title: "One", dependsOn: [] }],
    });
    expect(restored.status).toBe(201);
  });
});

describe("POST /:id/retry (T09 plan reset)", () => {
  test("retry resets the failed step and retains the succeeded step's status and evidence", async () => {
    const fixture = fixtureWithQueue();
    const succeededStep = {
      id: "s1",
      title: "Step one",
      dependsOn: [],
      status: "succeeded",
      result: "Done.",
      evidenceIds: ["plan-fell:step:s1"],
    };
    const failedStep = {
      id: "s2",
      title: "Step two",
      dependsOn: ["s1"],
      status: "failed",
      result: "Step two broke.",
    };
    const pendingStep = {
      id: "s3",
      title: "Step three",
      dependsOn: ["s2"],
      status: "pending",
    };
    const stepOneEvidence = {
      id: "plan-fell:step:s1",
      kind: "user",
      title: "Step one",
      excerpt: "Done.",
    };
    await fixture.rows.insertTask(
      storedTask({
        id: "plan-fell",
        kind: "plan",
        status: "failed",
        steps: [succeededStep, failedStep, pendingStep],
        evidence: [stepOneEvidence],
      }),
    );
    const response = await fixture.app.request("/plan-fell/retry", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      attempts: number;
      steps: unknown[];
      evidence: unknown[];
    };
    expect(body.status).toBe("queued");
    expect(body.attempts).toBe(2);
    // §7: the succeeded step is retained whole — status, result and evidence
    // link — while the failed one resets to a clean pending step. Every
    // retained ROW carries the generation stamp (attempt 1 wrote them); the
    // DTO strips the stamp, so the body answers the plain steps/evidence.
    expect(body.steps).toEqual([
      succeededStep,
      {
        id: "s2",
        title: "Step two",
        dependsOn: ["s1"],
        status: "pending",
      },
      {
        id: "s3",
        title: "Step three",
        dependsOn: ["s2"],
        status: "pending",
      },
    ]);
    expect(body.evidence).toEqual([stepOneEvidence]);
    const row = fixture.rows.tasks.find((stored) => stored.id === "plan-fell");
    expect(row?.steps).toEqual([
      { ...succeededStep, attempt: 1 },
      {
        id: "s2",
        title: "Step two",
        dependsOn: ["s1"],
        status: "pending",
        attempt: 1,
      },
      {
        id: "s3",
        title: "Step three",
        dependsOn: ["s2"],
        status: "pending",
        attempt: 1,
      },
    ]);
    expect(row?.evidence).toEqual([{ ...stepOneEvidence, attempt: 1 }]);
    expect(fixture.queue.offered).toHaveLength(1);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      payload: { ownerUserId: "user-1", taskId: "plan-fell" },
    });
  });
});

describe("POST / (create, kind monitor) (T10)", () => {
  test("change, contains and price_below fixtures land scheduled, nextCheckAt = creation + interval, offered at that instant", async () => {
    const fixture = monitorFixture();
    const change = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "Tell me when the inbox changes.",
      condition: { type: "change", intervalMinutes: 30, source: "gmail:inbox" },
    });
    expect(change.status).toBe(201);
    const changeBody = (await change.json()) as {
      id: string;
      status: string;
      condition?: unknown;
      nextCheckAt?: string;
    };
    // §7: a monitor is born `scheduled`, its first check due one interval out.
    expect(changeBody.status).toBe("scheduled");
    expect(changeBody.condition).toEqual({
      type: "change",
      intervalMinutes: 30,
      source: "gmail:inbox",
    });
    expect(changeBody.nextCheckAt).toBe("2026-10-01T00:30:00.000Z");

    const contains = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "Watch the status page.",
      condition: {
        type: "contains",
        intervalMinutes: 60,
        source: "https://example.com/status",
        selector: "#status",
      },
    });
    expect(contains.status).toBe(201);

    const price = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "Ping me under 99.50.",
      condition: {
        type: "price_below",
        intervalMinutes: 10_080,
        source: "https://shop.example/widget",
        threshold: 99.5,
      },
    });
    expect(price.status).toBe(201);
    const priceBody = (await price.json()) as { nextCheckAt?: string };
    // 10,080 minutes is exactly seven days.
    expect(priceBody.nextCheckAt).toBe("2026-10-08T00:00:00.000Z");

    // The row carries the condition and the stored due instant.
    const row = fixture.rows.tasks.find(
      (stored) => stored.id === changeBody.id,
    );
    expect(row?.kind).toBe("monitor");
    expect(row?.status).toBe("scheduled");
    expect(row?.monitorCondition).toEqual({
      type: "change",
      intervalMinutes: 30,
      source: "gmail:inbox",
    });
    expect(row?.nextCheckAt?.toISOString()).toBe("2026-10-01T00:30:00.000Z");

    // One offer per monitor, each scheduled at its own nextCheckAt — the
    // queue's runAt is the scheduling mechanism, not a poll of due rows.
    expect(fixture.queue.offered).toHaveLength(3);
    expect(fixture.queue.offered[0]).toMatchObject({
      kind: "openmuse-task",
      key: changeBody.id,
    });
    expect(fixture.queue.offered[0]?.runAt?.toISOString()).toBe(
      "2026-10-01T00:30:00.000Z",
    );
  });

  test("a contains condition without its selector answers 400, not a silently dead monitor", async () => {
    // The runner's normalizer can never match a selector-less contains
    // observation, so refusing at creation beats a monitor that consumes
    // its checks forever without ever being able to fire.
    const fixture = monitorFixture();
    const response = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "Watch the status page.",
      condition: {
        type: "contains",
        intervalMinutes: 60,
        source: "https://example.com/status",
      },
    });
    expect(response.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("interval bounds: 1 and 10,080 pass; 0, 10,081 and 1.5 answer 400", async () => {
    const fixture = monitorFixture();
    const at = async (intervalMinutes: number) =>
      (
        await postTask(fixture.app, {
          botId: "bot-1",
          kind: "monitor",
          prompt: "p",
          condition: {
            type: "price_below",
            intervalMinutes,
            source: "https://shop.example/widget",
            threshold: 10,
          },
        })
      ).status;
    expect(await at(1)).toBe(201);
    expect(await at(10_080)).toBe(201);
    expect(await at(0)).toBe(400);
    expect(await at(10_081)).toBe(400);
    expect(await at(1.5)).toBe(400);
    // Only the two legal rows exist.
    expect(fixture.rows.tasks).toHaveLength(2);
  });

  test("the condition matrix: price_below without threshold, contains/change without source answer 400", async () => {
    const fixture = monitorFixture();
    const priceless = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "p",
      condition: {
        type: "price_below",
        intervalMinutes: 30,
        source: "https://shop.example/widget",
      },
    });
    expect(priceless.status).toBe(400);
    const sourcelessContains = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "p",
      condition: { type: "contains", intervalMinutes: 30 },
    });
    expect(sourcelessContains.status).toBe(400);
    const sourcelessChange = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "p",
      condition: { type: "change", intervalMinutes: 30 },
    });
    expect(sourcelessChange.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("a monitor without a condition, and a condition on another kind, answer 400", async () => {
    const fixture = monitorFixture();
    const bare = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "p",
    });
    expect(bare.status).toBe(400);
    const agentConditioned = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "p",
      condition: { type: "change", intervalMinutes: 30, source: "gmail:inbox" },
    });
    expect(agentConditioned.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("§9 and ownership unchanged: a disabled owner is 403, a foreign botId 404", async () => {
    const fixture = monitorFixture();
    await fixture.store.disableOwner("user-1");
    const disabled = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "monitor",
      prompt: "p",
      condition: { type: "change", intervalMinutes: 30, source: "gmail:inbox" },
    });
    expect(disabled.status).toBe(403);
    await fixture.store.restoreOwner("user-1");
    const foreign = await postTask(fixture.app, {
      botId: "bot-2",
      kind: "monitor",
      prompt: "p",
      condition: { type: "change", intervalMinutes: 30, source: "gmail:inbox" },
    });
    expect(foreign.status).toBe(404);
    expect(fixture.rows.tasks).toHaveLength(0);
  });
});

describe("monitor pause, resume and cancel (T10)", () => {
  const condition = {
    type: "contains",
    intervalMinutes: 30,
    source: "https://example.com/status",
  };

  test("resume re-arms scheduled from now+interval and re-offers at that instant", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "monitor",
      prompt: "Watch the status page.",
      condition,
      idempotencyKey: null,
    });
    expect(task.status).toBe("scheduled");
    expect(fixture.queue.offered[0]?.runAt?.toISOString()).toBe(
      "2026-10-01T00:30:00.000Z",
    );
    await fixture.store.requestPause("user-1", task.id);
    // Ten minutes pass while paused: the re-arm is from NOW, not from the old
    // due instant — a paused monitor never fires a stale check on resume.
    fixture.clock.advance(10);
    const resumed = await fixture.store.resumeTask("user-1", task.id);
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.task.status).toBe("scheduled");
    expect(resumed.task.nextCheckAt?.toISOString()).toBe(
      "2026-10-01T00:40:00.000Z",
    );
    // One re-offer under a fresh queue identity, scheduled at the re-armed
    // instant — the same seam create offers through.
    expect(fixture.queue.offered).toHaveLength(2);
    expect(fixture.queue.offered[1]?.key.startsWith(`${task.id}:`)).toBe(true);
    expect(fixture.queue.offered[1]?.runAt?.toISOString()).toBe(
      "2026-10-01T00:40:00.000Z",
    );
  });

  test("cancel during scheduled lands cancelled now, with no offer beyond creation's", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "monitor",
      prompt: "Watch the status page.",
      condition,
      idempotencyKey: null,
    });
    const cancelled = await fixture.store.requestCancel("user-1", task.id);
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.task.status).toBe("cancelled");
    expect(fixture.queue.offered).toHaveLength(1);
  });
});

/*
 * T11 (issue #68): the observation cursor's storage seam. The settle write
 * carries the last committed observation's hash and time beside the failure
 * streak — one row, one write — so a restarted runner dedups against the
 * same cursor the previous one committed.
 */
describe("monitor observation cursor (T11)", () => {
  test("settleTask carries hash, time and streak; a zero streak lands too", async () => {
    const fixture = monitorFixture();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "monitor",
      prompt: "Ping me under 250.",
      condition: {
        type: "price_below",
        intervalMinutes: 30,
        source: "https://shop.example/widget",
        threshold: 250,
      },
      idempotencyKey: null,
    });
    const committedAt = new Date("2026-10-01T00:30:00.000Z");
    const settled = await fixture.store.settleTask(task.id, {
      ifAttempts: task.attempts,
      status: "scheduled",
      nextCheckAt: committedAt,
      lastObservationHash: "hash-1",
      lastObservationAt: committedAt,
      monitorFailureStreak: 3,
    });
    expect(settled?.lastObservationHash).toBe("hash-1");
    expect(settled?.lastObservationAt?.toISOString()).toBe(
      "2026-10-01T00:30:00.000Z",
    );
    expect(settled?.monitorFailureStreak).toBe(3);
    // The reset to zero lands — falsy, but explicit, so !== undefined is the check.
    const reset = await fixture.store.settleTask(task.id, {
      ifAttempts: task.attempts,
      monitorFailureStreak: 0,
    });
    expect(reset?.monitorFailureStreak).toBe(0);
    expect(await fixture.store.get("user-1", task.id)).toMatchObject({
      lastObservationHash: "hash-1",
      monitorFailureStreak: 0,
    });
  });
});

/*
 * T15 (§7 document flow): creation binds an imported PDF File version. The
 * {fileId, versionId} pair is owner-validated through the files store's one
 * reused seam (getOwnedFile — a foreign, missing or tombstoned File is the
 * same null, so existence is not disclosed), and the pair rides the prompt
 * column the way a finance task's csvFileId does — never exposed in the DTO.
 */
describe("POST / (create, kind document) (T15)", () => {
  /** The route's files seam: owner-scoped getOwnedFile, live PDFs only. */
  function documentFixture() {
    const files = new Map<
      string,
      { ownerUserId: string; versionId: string; mimeType: string }
    >();
    const seam = {
      addPdf: (
        ownerUserId: string,
        id: string,
        versionId: string,
        mimeType = "application/pdf",
      ) => {
        files.set(id, { ownerUserId, versionId, mimeType });
      },
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
        const file = files.get(id);
        if (!file || file.ownerUserId !== ownerUserId) return null;
        return {
          file: {
            id,
            name: `${id}.pdf`,
            mimeType: file.mimeType,
            size: 4,
            sha256: `${id}-sha`,
            versionId: file.versionId,
            createdAt: new Date(),
          },
          read: async () => new Uint8Array([1, 2, 3, 4]),
        };
      },
    };
    const rows = fakeRows();
    const store = createOpenMuseTaskStore({ rows });
    const app = createOpenMuseTasksRoutes({
      store,
      requireUser,
      resolvePrivateBotId: async (ownerUserId) =>
        privateBots[ownerUserId] ?? null,
      files: seam,
    });
    return { rows, store, app, ...seam };
  }

  test("creates one document task bound to the owner's imported File version", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "doc-1", "doc-1-v1");
    const created = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
    });
    expect(created.status).toBe(201);
    const dto = (await created.json()) as Record<string, unknown>;
    expect(dto.kind).toBe("document");
    expect(dto.status).toBe("queued");
    // The carriage never leaks: the DTO answers no prompt, no file binding.
    expect("prompt" in dto).toBe(false);
    expect("fileId" in dto).toBe(false);
    expect("versionId" in dto).toBe(false);
    expect(fixture.rows.tasks).toHaveLength(1);
    // The {fileId, versionId} pair rides the prompt column, as finance's does.
    expect(fixture.rows.tasks[0].prompt).toBe(
      JSON.stringify({ fileId: "doc-1", versionId: "doc-1-v1" }),
    );
  });

  test("a foreign File and a tombstoned File answer 404; nothing is written", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-2", "foreign-doc", "foreign-doc-v1");
    const foreign = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "foreign-doc",
      versionId: "foreign-doc-v1",
    });
    expect(foreign.status).toBe(404);
    const missing = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "no-such-doc",
      versionId: "no-such-doc-v1",
    });
    expect(missing.status).toBe(404);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("a version that is not the File's current version answers 400", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "doc-1", "doc-1-v2");
    const stale = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
    });
    expect(stale.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("a non-PDF File answers 400", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "csv-1", "csv-1-v1", "text/csv");
    const created = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "csv-1",
      versionId: "csv-1-v1",
    });
    expect(created.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("a document task rejects prompt and csvFileId carrying (T13's rule, inverse)", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "doc-1", "doc-1-v1");
    const withPrompt = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
      prompt: "fill the form",
    });
    expect(withPrompt.status).toBe(400);
    const withCsv = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
      csvFileId: "doc-1",
    });
    expect(withCsv.status).toBe(400);
    const withoutVersion = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
    });
    expect(withoutVersion.status).toBe(400);
    const withoutFile = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      versionId: "doc-1-v1",
    });
    expect(withoutFile.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("fileId and versionId on another kind answer 400", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "doc-1", "doc-1-v1");
    const onAgent = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "agent",
      prompt: "a",
      fileId: "doc-1",
      versionId: "doc-1-v1",
    });
    expect(onAgent.status).toBe(400);
    expect(fixture.rows.tasks).toHaveLength(0);
  });

  test("§9 unchanged: a disabled owner cannot create a document task", async () => {
    const fixture = documentFixture();
    fixture.addPdf("user-1", "doc-1", "doc-1-v1");
    await fixture.store.disableOwner("user-1");
    const created = await postTask(fixture.app, {
      botId: "bot-1",
      kind: "document",
      fileId: "doc-1",
      versionId: "doc-1-v1",
    });
    expect(created.status).toBe(403);
  });
});

/*
 * T16 (§7 reviewed reply): the carriage gains an optional reply binding —
 * what the S29 selection flow attaches at creation so the fill's successor
 * knows where the reviewed reply goes. The round trip keeps it intact; a
 * malformed binding is a malformed carriage (null), never half a reply.
 */
describe("documentTaskCarriage reply binding (T16)", () => {
  const reply = {
    to: ["landlord@example.com"],
    subject: "Re: Lease form",
    body: "Please find the filled lease form attached.",
    threadId: "thread-abc",
    replyToMessageId: "msg-123",
  };

  test("carries an optional reply binding through the round trip", () => {
    expect(
      documentTaskInput(documentTaskCarriage("doc-1", "doc-1-v1")),
    ).toEqual({ fileId: "doc-1", versionId: "doc-1-v1" });
    expect(
      documentTaskInput(documentTaskCarriage("doc-1", "doc-1-v1", reply)),
    ).toEqual({ fileId: "doc-1", versionId: "doc-1-v1", reply });
  });

  test("a malformed reply binding is a malformed carriage, never half of one", () => {
    expect(
      documentTaskInput(
        JSON.stringify({ fileId: "doc-1", versionId: "doc-1-v1", reply: "x" }),
      ),
    ).toBeNull();
    expect(
      documentTaskInput(
        JSON.stringify({
          fileId: "doc-1",
          versionId: "doc-1-v1",
          reply: { ...reply, threadId: "" },
        }),
      ),
    ).toBeNull();
    expect(
      documentTaskInput(
        JSON.stringify({
          fileId: "doc-1",
          versionId: "doc-1-v1",
          reply: { ...reply, to: [] },
        }),
      ),
    ).toBeNull();
  });
});

/*
 * D02 (§9 work shutdown): the bulk transition the delete route runs behind
 * D01's marker. Every not-yet-terminal row lands cancelled; a running row
 * only raises the §7 cancellation flag — T04's contract, the public status
 * stays running until the sweep's post-turn finalize lands cancelled. The
 * report's id lists are the marker's bookkeeping and the T12 emit's input.
 */
describe("§9 work shutdown (D02)", () => {
  test("shutdownOwner cancels queued/scheduled/paused/waiting rows and only flags running ones", async () => {
    const fixture = fixtureFor();
    fixture.rows.tasks.push(
      storedTask({ id: "t-queued", status: "queued" }),
      storedTask({ id: "t-scheduled", status: "scheduled" }),
      storedTask({ id: "t-paused", status: "paused" }),
      storedTask({ id: "t-waiting-input", status: "waiting_input" }),
      storedTask({ id: "t-waiting-review", status: "waiting_review" }),
      storedTask({ id: "t-running", status: "running" }),
      storedTask({ id: "t-succeeded", status: "succeeded" }),
      storedTask({ id: "t-failed", status: "failed" }),
      storedTask({ id: "t-already", status: "cancelled" }),
      storedTask({
        id: "t-foreign",
        status: "queued",
        ownerUserId: "user-2",
      }),
    );

    const report = await fixture.store.shutdownOwner("user-1");

    const byId = new Map(fixture.rows.tasks.map((row) => [row.id, row]));
    for (const id of [
      "t-queued",
      "t-scheduled",
      "t-paused",
      "t-waiting-input",
      "t-waiting-review",
    ]) {
      expect(byId.get(id)?.status, id).toBe("cancelled");
    }
    // Running: T04's contract — the flag raised, the public status held.
    expect(byId.get("t-running")?.status).toBe("running");
    expect(byId.get("t-running")?.cancellationRequested).toBe(true);
    // Terminal rows and a foreign owner's row are untouched.
    expect(byId.get("t-succeeded")?.status).toBe("succeeded");
    expect(byId.get("t-failed")?.status).toBe("failed");
    expect(byId.get("t-already")?.status).toBe("cancelled");
    expect(byId.get("t-foreign")?.status).toBe("queued");
    expect([...report.cancelled].sort()).toEqual(
      [
        "t-queued",
        "t-scheduled",
        "t-paused",
        "t-waiting-input",
        "t-waiting-review",
      ].sort(),
    );
    expect(report.cancelRequested).toEqual(["t-running"]);
  });

  test("a repeated shutdownOwner is idempotent: nothing further transitions", async () => {
    const fixture = fixtureFor();
    fixture.rows.tasks.push(
      storedTask({ id: "t-queued", status: "queued" }),
      storedTask({ id: "t-running", status: "running" }),
    );
    await fixture.store.shutdownOwner("user-1");
    const second = await fixture.store.shutdownOwner("user-1");
    expect(second.cancelled).toEqual([]);
    // The flag was already raised by the first pass; the status guard
    // refuses the repeat, exactly as T04's idempotent re-request.
    expect(second.cancelRequested).toEqual([]);
    expect(
      fixture.rows.tasks.find((row) => row.id === "t-running")?.status,
    ).toBe("running");
  });

  test("ownerDisabled answers the rows' deletion-marker check", async () => {
    const fixture = fixtureFor();
    expect(await fixture.store.ownerDisabled("user-1")).toBe(false);
    await fixture.rows.disableOwner("user-1");
    expect(await fixture.store.ownerDisabled("user-1")).toBe(true);
  });

  test("S39 core: the delete route's shutdown, behind the marker, cancels the queued Task and the scheduled Monitor and hands the reviewed seam its owner", async () => {
    const fixture = fixtureFor();
    fixture.rows.tasks.push(
      storedTask({ id: "t-agent", status: "queued" }),
      storedTask({
        id: "t-monitor",
        kind: "monitor",
        status: "scheduled",
        monitorCondition: {
          type: "change",
          source: "https://example.com",
          intervalMinutes: 30,
        },
        nextCheckAt: new Date("2026-10-01T00:30:00Z"),
      }),
    );
    const reviewedCancelled: string[] = [];
    const recorded: Array<{ userId: string; transitions: string[] }> = [];
    const emitted: string[] = [];
    const markers = new Set<string>();
    const shutdown = createOpenMuseWorkShutdown({
      tasks: fixture.store,
      reviewed: {
        cancelAwaiting: async (ownerUserId) => {
          reviewedCancelled.push(ownerUserId);
          return ["ra-awaiting"];
        },
      },
      record: async (userId, transitions) => {
        recorded.push({ userId, transitions });
      },
      emit: async (event) => {
        emitted.push(event.taskId);
      },
    });
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/openmuse-account",
      createOpenMuseAccountDeletionRoutes({
        requireUser,
        store: {
          delete: async (userId) => {
            markers.add(userId);
            return {
              userId,
              disabledAt: new Date("2026-10-13T00:00:00Z"),
              phase: "fenced" as const,
              restoreUntil: null,
              resources: [],
            };
          },
          get: async () => null,
          isDisabled: async (userId) => markers.has(userId),
          enumerateOwner: async () => [],
        },
        shutdownOwnerWork: shutdown,
      }),
    );

    const response = await app.request("/openmuse-account/delete", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    // The marker landed — the fence is live before any shutdown work ran.
    expect(markers).toEqual(new Set(["user-1"]));
    const byId = new Map(fixture.rows.tasks.map((row) => [row.id, row]));
    expect(byId.get("t-agent")?.status).toBe("cancelled");
    expect(byId.get("t-monitor")?.status).toBe("cancelled");
    expect(reviewedCancelled).toEqual(["user-1"]);
    // The bookkeeping and the best-effort T12 emit name what landed.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.userId).toBe("user-1");
    expect(recorded[0]?.transitions.slice().sort()).toEqual(
      [
        "openmuse-task:t-agent:cancelled",
        "openmuse-task:t-monitor:cancelled",
        "openmuse-reviewed-action:ra-awaiting:cancelled",
      ].sort(),
    );
    expect(emitted.slice().sort()).toEqual(["t-agent", "t-monitor"]);
  });
});

/*
 * T04×T07: the claim race. requestTaskCancel/requestTaskPause move queued/scheduled
 * rows WITHOUT touching attempts, so a sweep that read the row just before the
 * owner's cancel lands still holds a valid attempts CAS — the claim→running write
 * used to overwrite the cancelled row and run the Bot turn anyway (and re-arm a
 * cancelled monitor forever). The claim carries the status it read, and no settle
 * that is not itself the cancellation writes over a cancelled row.
 */
describe("claim race with the owner's cancel/pause CAS (T04×T07)", () => {
  test("a claim→running settle refuses a row cancelled between the read and the write", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Draft the note.",
      idempotencyKey: null,
    });
    // The sweep's read — queued, attempts N.
    const read = await fixture.store.get("user-1", task.id);
    expect(read?.status).toBe("queued");
    // The owner's cancel lands in the window between read and claim.
    expect(await fixture.store.requestCancel("user-1", task.id)).toMatchObject({
      outcome: "cancelled",
    });
    const claimed = await fixture.store.settleTask(task.id, {
      ifAttempts: read?.attempts ?? 0,
      status: "running",
      ifStatus: ["queued"],
    });
    expect(claimed).toBeNull();
    expect(await fixture.store.get("user-1", task.id)).toMatchObject({
      status: "cancelled",
    });
  });

  test("a pause landing in the claim window is not overwritten either", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Draft the note.",
      idempotencyKey: null,
    });
    const read = await fixture.store.get("user-1", task.id);
    expect(await fixture.store.requestPause("user-1", task.id)).toMatchObject({
      outcome: "paused",
    });
    const claimed = await fixture.store.settleTask(task.id, {
      ifAttempts: read?.attempts ?? 0,
      status: "running",
      ifStatus: ["queued"],
    });
    expect(claimed).toBeNull();
    expect(await fixture.store.get("user-1", task.id)).toMatchObject({
      status: "paused",
    });
  });

  test("a claim that does not name the status it read still refuses a cancelled row", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Draft the note.",
      idempotencyKey: null,
    });
    const read = await fixture.store.get("user-1", task.id);
    await fixture.store.requestCancel("user-1", task.id);
    // No ifStatus — the central guard is the row's own terminal state.
    const claimed = await fixture.store.settleTask(task.id, {
      ifAttempts: read?.attempts ?? 0,
      status: "running",
    });
    expect(claimed).toBeNull();
  });

  test("a terminal settle refuses a cancelled row: no succeeded/failed over a cancel", async () => {
    const fixture = fixtureFor();
    const { task } = await fixture.store.create({
      ownerUserId: "user-1",
      botId: "bot-1",
      kind: "agent",
      prompt: "Draft the note.",
      idempotencyKey: null,
    });
    const read = await fixture.store.get("user-1", task.id);
    await fixture.store.requestCancel("user-1", task.id);
    for (const status of ["succeeded", "failed", "scheduled"] as const) {
      const settled = await fixture.store.settleTask(task.id, {
        ifAttempts: read?.attempts ?? 0,
        status,
      });
      expect(settled).toBeNull();
    }
    expect(await fixture.store.get("user-1", task.id)).toMatchObject({
      status: "cancelled",
    });
  });
});
