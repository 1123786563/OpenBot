import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { OpenMuseFileStore } from "../openmuse-files/store";
import { ACTIVE_TASKS_PER_USER, TASK_LIMIT_MESSAGE } from "./capacity";
import {
  type createOpenMuseTaskStore,
  documentTaskCarriage,
  OpenMuseOwnerDisabledError,
  OpenMuseTaskQuotaError,
  type OpenMuseTaskStore,
  type OpenMuseTaskWait,
  type StoredOpenMuseTask,
} from "./store";

/**
 * `/openmuse-tasks` (mounted under `/api/mobile` by the bff seam): creation
 * and listing of the owner's OpenMuse Tasks (T01). No runner, no transitions —
 * POST always lands `queued`; the private-Bot check resolves through the
 * template store so a foreign botId is a plain 404.
 */

const kinds = z.enum(["agent", "document", "monitor", "finance", "plan"]);

/** T09: one plan step as offered — the graph's shape; semantics are checked below. */
const planStepInput = z.strictObject({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  dependsOn: z.array(z.string().trim().min(1)).max(50).default([]),
});

/** T10: the §7 monitor condition — interval 1–10,080 minutes; the matrix is checked below. */
const monitorConditionInput = z.strictObject({
  type: z.enum(["change", "contains", "price_below"]),
  intervalMinutes: z.number().int().min(1).max(10_080),
  source: z.string().trim().min(1).max(2_000).optional(),
  selector: z.string().trim().min(1).max(500).optional(),
  threshold: z.number().finite().optional(),
});

/**
 * T10: the §7 matrix checks zod cannot express — price_below requires its
 * numeric threshold, contains/change their source string. Null means valid.
 */
function monitorConditionProblem(
  condition:
    | {
        type: string;
        threshold?: number;
        source?: string;
        selector?: string;
      }
    | undefined,
): string | null {
  if (!condition) return null;
  if (condition.type === "price_below" && condition.threshold === undefined)
    return "A price_below condition needs its threshold.";
  if (
    (condition.type === "contains" || condition.type === "change") &&
    condition.source === undefined
  )
    return `A ${condition.type} condition needs its source.`;
  // The runner's normalizer can never match a selector-less contains
  // observation (its needle IS the selector), so refusing it here beats a
  // monitor that runs, checks and consumes its queue slot forever without
  // ever being able to match.
  if (condition.type === "contains" && condition.selector === undefined)
    return "A contains condition needs its selector.";
  return null;
}

const createInput = z.strictObject({
  botId: z.string().trim().min(1),
  kind: kinds,
  /**
   * The owner's instruction — required for every kind but finance, whose
   * input is its CSV File (the cross-field matrix below checks which).
   */
  prompt: z.string().trim().min(1).max(20_000).optional(),
  /** T13: the finance task's CSV File id; the matrix below checks ownership of the field. */
  csvFileId: z.string().trim().min(1).optional(),
  /** T15: the document task's imported PDF File and the version it is bound to. */
  fileId: z.string().trim().min(1).optional(),
  versionId: z.string().trim().min(1).optional(),
  steps: z.array(planStepInput).min(1).max(50).optional(),
  /** T10: the monitor's condition; the cross-field matrix is checked below. */
  condition: monitorConditionInput.optional(),
});

/**
 * The row's prompt column by kind: a finance task's CSV File id, a document
 * task's File/version carriage, every other kind the owner's instruction
 * text. (T13/T15; the create matrix above has already checked each field.)
 */
function promptColumnOf(
  data: { kind: string; prompt?: string; csvFileId?: string },
  documentCarriage: string | undefined,
): string | undefined {
  if (data.kind === "finance") return data.csvFileId;
  if (data.kind === "document") return documentCarriage;
  return data.prompt;
}

/**
 * T09: the plan graph checks zod cannot express — unique ids, every dependsOn
 * naming a known id, and no cycle (a topological peel: a cycle leaves nodes
 * forever unpeeled). Null means the graph is valid.
 */
function planStepsProblem(
  steps: Array<{ id: string; dependsOn: string[] }>,
): string | null {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) return "Plan step ids must be unique.";
  for (const step of steps)
    for (const dependency of step.dependsOn)
      if (!ids.has(dependency))
        return `The step "${step.id}" depends on an unknown step.`;
  const unmet = new Map(
    steps.map((step) => [step.id, new Set(step.dependsOn)] as const),
  );
  const dependents = new Map<string, string[]>(
    steps.map((step) => [step.id, [] as string[]]),
  );
  for (const step of steps)
    for (const dependency of step.dependsOn)
      dependents.get(dependency)?.push(step.id);
  const frontier = [...unmet.entries()]
    .filter(([, dependencies]) => dependencies.size === 0)
    .map(([id]) => id);
  let peeled = 0;
  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    peeled += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const dependencies = unmet.get(dependent);
      /*
       * Push on the real transition only: a duplicated dependsOn entry
       * (["a","a"]) registers the dependent twice but folds its unmet set
       * once, and re-enqueueing on the second delete would double-count the
       * peel — a legal acyclic plan would then read as a cycle.
       */
      if (dependencies?.delete(id) && dependencies.size === 0)
        frontier.push(dependent);
    }
  }
  return peeled === steps.length ? null : "Plan steps must not form a cycle.";
}

const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

/** T08: the values object only — the per-field schema check is the store's. */
const answerWaitInput = z.strictObject({
  values: z.record(z.string(), z.unknown()),
});

function encodeCursor(task: StoredOpenMuseTask): string {
  return Buffer.from(
    JSON.stringify({ c: task.createdAt.toISOString(), i: task.id }),
    "utf8",
  ).toString("base64");
}

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
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

/** The §7 human-wait DTO: what the client renders to collect the answer. */
function waitDto(wait: OpenMuseTaskWait) {
  return {
    waitId: wait.waitId,
    taskId: wait.taskId,
    kind: wait.kind,
    question: wait.question,
    ...(wait.fields !== undefined ? { fields: wait.fields } : {}),
    createdAt: wait.createdAt,
    ...(wait.answeredAt !== undefined ? { answeredAt: wait.answeredAt } : {}),
    ...(wait.answer !== undefined ? { answer: wait.answer } : {}),
  };
}

/**
 * Strips T06×T07's internal `attempt` generation stamp from jsonb rows: it
 * is the runner's recovery bookkeeping (retryTask's stampAttempt), not §7
 * client contract, and must not ride the DTO out.
 */
function withoutAttempt(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      return row;
    const { attempt: _attempt, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}

/** The §7 DTO the client renders; explicit fields, no row internals leak. */
function taskDto(task: StoredOpenMuseTask) {
  return {
    id: task.id,
    ownerUserId: task.ownerUserId,
    botId: task.botId,
    kind: task.kind,
    status: task.status,
    attempts: task.attempts,
    steps: withoutAttempt(task.steps),
    evidence: withoutAttempt(task.evidence),
    artifactIds: task.artifactIds,
    ...(task.wait !== undefined ? { wait: waitDto(task.wait) } : {}),
    // T10: a monitor's condition and due instant, so the client can render
    // what is watched and when it is next checked.
    ...(task.monitorCondition !== undefined
      ? { condition: task.monitorCondition }
      : {}),
    ...(task.nextCheckAt !== undefined
      ? { nextCheckAt: task.nextCheckAt.toISOString() }
      : {}),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function createOpenMuseTasksRoutes(deps: {
  store: OpenMuseTaskStore | ReturnType<typeof createOpenMuseTaskStore>;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** The owner's one private OpenMuse Bot, or null when they have none. */
  resolvePrivateBotId: (ownerUserId: string) => Promise<string | null>;
  /**
   * T15: the files seam a document task's {fileId, versionId} is
   * owner-validated through (getOwnedFile — the one reuse). Absent means the
   * deployment has not wired document tasks yet: creation answers 503 rather
   * than writing a row the runner could never run.
   */
  files?: Pick<OpenMuseFileStore, "getOwnedFile">;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  /*
   * This sub-app is mounted under /api/mobile BEFORE the bff's 8 KiB family
   * body limit, so that limit never wraps these handlers and this one is the
   * ceiling that stands in its place. 64 KiB: the create body's one large
   * field is the 20,000-character prompt, plus JSON framing and the plan or
   * monitor scaffolding around it — anything larger is not a Task a phone
   * meant to send, and both POSTs buffer req.json() whole before parsing, so
   * an unbounded body would be an unbounded allocation.
   */
  routes.use("*", bodyLimit({ maxSize: 64 * 1024 }));

  routes.post("/", async (context) => {
    const input = createInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json(
        { error: "A kind, a prompt and your Bot are required." },
        400,
      );
    }
    // T09: steps belong to a plan and a plan needs them; the graph itself —
    // unique ids, known dependencies, acyclic — is checked before anything
    // is written, so no half-plan can exist.
    if (input.data.kind === "plan" && input.data.steps === undefined) {
      return context.json({ error: "A plan needs its steps." }, 400);
    }
    if (input.data.kind !== "plan" && input.data.steps !== undefined) {
      return context.json({ error: "Only a plan carries steps." }, 400);
    }
    // T10: a monitor carries its condition and nothing else does — the same
    // shape the plan/steps pair uses, checked before anything is written.
    if (input.data.kind === "monitor" && input.data.condition === undefined) {
      return context.json({ error: "A monitor needs its condition." }, 400);
    }
    if (input.data.kind !== "monitor" && input.data.condition !== undefined) {
      return context.json(
        { error: "Only a monitor carries a condition." },
        400,
      );
    }
    // T13: a finance task's input is its CSV File, carried on the row as the
    // runner-consumed prompt — checked here so no half-shaped row is written.
    if (input.data.kind === "finance" && input.data.csvFileId === undefined) {
      return context.json({ error: "A finance task needs its CSV file." }, 400);
    }
    // T13's own document gate, mirrored: without the files seam the runner can
    // never read the CSV, so creation answers 503 rather than writing a row
    // that is guaranteed to fail (one doomed run plus one failure notification
    // per create otherwise), and the CSV is owner-validated at creation — the
    // same one-fetch existence check document's {fileId, versionId} gets.
    if (input.data.kind === "finance" && !deps.files) {
      return context.json({ error: "Finance tasks are not available." }, 503);
    }
    if (input.data.kind === "finance" && input.data.prompt !== undefined) {
      return context.json(
        { error: "A finance task takes a CSV file, not a prompt." },
        400,
      );
    }
    if (input.data.kind !== "finance" && input.data.csvFileId !== undefined) {
      return context.json(
        { error: "Only a finance task carries a CSV file." },
        400,
      );
    }
    // T15: a document task is bound to an imported File version and nothing
    // else — the matrix mirrors finance's: the pair is required, a prompt is
    // refused (finance's rule, inverse), and no other kind carries the pair.
    if (
      input.data.kind === "document" &&
      (input.data.fileId === undefined || input.data.versionId === undefined)
    ) {
      return context.json(
        { error: "A document task needs its File and version." },
        400,
      );
    }
    if (input.data.kind === "document" && input.data.prompt !== undefined) {
      return context.json(
        { error: "A document task takes a File, not a prompt." },
        400,
      );
    }
    if (
      input.data.kind !== "document" &&
      (input.data.fileId !== undefined || input.data.versionId !== undefined)
    ) {
      return context.json(
        { error: "Only a document task carries a File version." },
        400,
      );
    }
    if (
      input.data.kind !== "finance" &&
      input.data.kind !== "document" &&
      input.data.prompt === undefined
    ) {
      return context.json(
        { error: "A kind, a prompt and your Bot are required." },
        400,
      );
    }
    if (input.data.kind === "finance" && deps.files) {
      // §5: one fetch checks owner and deletion state at once — a foreign, a
      // missing and a tombstoned File answer the same null, so existence is
      // not disclosed.
      const owned = await deps.files.getOwnedFile(
        context.var.actor.id,
        input.data.csvFileId as string,
      );
      if (!owned) {
        return context.json({ error: "There is no such File." }, 404);
      }
    }
    let documentCarriage: string | undefined;
    if (input.data.kind === "document") {
      if (!deps.files) {
        return context.json(
          { error: "Document tasks are not available." },
          503,
        );
      }
      // §5: one fetch checks owner and deletion state at once — a foreign, a
      // missing and a tombstoned File answer the same null, so existence is
      // not disclosed.
      const owned = await deps.files.getOwnedFile(
        context.var.actor.id,
        input.data.fileId as string,
      );
      if (!owned) {
        return context.json({ error: "There is no such File." }, 404);
      }
      if (owned.file.mimeType !== "application/pdf") {
        return context.json({ error: "Only PDFs can be filled." }, 400);
      }
      if (owned.file.versionId !== input.data.versionId) {
        return context.json(
          { error: "That version is not the File's current version." },
          400,
        );
      }
      documentCarriage = documentTaskCarriage(
        input.data.fileId as string,
        input.data.versionId as string,
      );
    }
    const conditionProblem = monitorConditionProblem(input.data.condition);
    if (conditionProblem) return context.json({ error: conditionProblem }, 400);
    const graphProblem = input.data.steps
      ? planStepsProblem(input.data.steps)
      : null;
    if (graphProblem) return context.json({ error: graphProblem }, 400);
    const actor = context.var.actor;
    const privateBotId = await deps.resolvePrivateBotId(actor.id);
    if (!privateBotId || input.data.botId !== privateBotId) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    try {
      /*
       * Round 6 (M35) closed the recorded gap: the bound now lives in the
       * rows' insertTask (advisory-lock transaction), the single choke point
       * every caller funnels through. This pre-check stays as the fast
       * refusal path — the insert's own OpenMuseTaskQuotaError maps to the
       * same 409 below, so a racing caller that slips past this read still
       * meets the ceiling.
       */
      /*
       * O04 (§10 row 5): the per-user active-Task cap, ported from the legacy
       * service's create check — non-terminal Tasks count, terminal ones
       * never do, and the 101st answers the same 409 message. The count is
       * one count query, never a page scan: the rows' steps/evidence jsonb
       * columns do not cross the wire for a bound check. An idempotent
       * replay of a Task created below the cap replays as ever; one retried
       * only after the cap filled answers this 409 rather than the stored
       * row — re-reading after a slot frees resolves it.
       */
      if ((await deps.store.activeTasks(actor.id)) >= ACTIVE_TASKS_PER_USER) {
        return context.json({ error: TASK_LIMIT_MESSAGE }, 409);
      }
      const idempotencyKey =
        context.req.header("Idempotency-Key")?.trim() || null;
      const { task, created } = await deps.store.create({
        ownerUserId: actor.id,
        botId: privateBotId,
        kind: input.data.kind,
        // T13: a finance task's CSV File id rides the runner-consumed prompt
        // column; a document's File/version carriage does; every other kind
        // carries the owner's instruction text.
        prompt: promptColumnOf(input.data, documentCarriage),
        ...(input.data.steps ? { steps: input.data.steps } : {}),
        ...(input.data.condition ? { condition: input.data.condition } : {}),
        idempotencyKey,
      });
      return context.json(taskDto(task), created ? 201 : 200);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      // M35: the insert-side bound — the same 409 the pre-check answers.
      if (error instanceof OpenMuseTaskQuotaError) {
        return context.json({ error: TASK_LIMIT_MESSAGE }, 409);
      }
      throw error;
    }
  });

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
      const { tasks } = await deps.store.list(actor.id, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      const nextCursor =
        tasks.length === limit
          ? encodeCursor(tasks[tasks.length - 1])
          : undefined;
      return context.json({
        tasks: tasks.map(taskDto),
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
    const task = await deps.store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!task) return context.json({ error: "There is no such Task." }, 404);
    return context.json(taskDto(task));
  });

  routes.post("/:id/cancel", async (context) => {
    try {
      const result = await deps.store.requestCancel(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (result.outcome === "missing")
        return context.json({ error: "There is no such Task." }, 404);
      // §7: only non-terminal states cancel; a terminal one answers with
      // where it stands rather than a silent no-op.
      if (result.outcome === "terminal")
        return context.json(
          {
            error: "This Task can no longer be cancelled.",
            currentStatus: result.task.status,
          },
          409,
        );
      // `requested` keeps the public status running; the flag rides along so
      // the client can say "cancelling…" rather than guess.
      return context.json(
        {
          ...taskDto(result.task),
          cancellationRequested: result.task.cancellationRequested,
        },
        200,
      );
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/pause", async (context) => {
    try {
      const result = await deps.store.requestPause(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (result.outcome === "missing")
        return context.json({ error: "There is no such Task." }, 404);
      // §7: only queued/scheduled/running pause; every other state answers
      // with where it stands rather than a silent no-op.
      if (result.outcome === "terminal")
        return context.json(
          {
            error: "This Task can no longer be paused.",
            currentStatus: result.task.status,
          },
          409,
        );
      // `requested` keeps the public status running; the flag rides along so
      // the client can say "pausing…" rather than guess.
      return context.json(
        {
          ...taskDto(result.task),
          pauseRequested: result.task.pauseRequested,
        },
        200,
      );
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/retry", async (context) => {
    try {
      const result = await deps.store.retryTask(
        context.var.actor.id,
        context.req.param("id"),
        context.req.header("Idempotency-Key")?.trim() || null,
      );
      if (result.outcome === "missing")
        return context.json({ error: "There is no such Task." }, 404);
      // §7: only a failed Task retries, as a new attempt; anything else
      // answers with where it stands — a queued Task is already runnable,
      // a terminal one never resumes.
      if (result.outcome === "terminal")
        return context.json(
          {
            error: "This Task can no longer be retried.",
            currentStatus: result.task.status,
          },
          409,
        );
      // `replayed` answers the same record: the retry key already created
      // its one attempt, so the caller gets the current row without a second.
      return context.json(taskDto(result.task), 200);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/resume", async (context) => {
    try {
      const result = await deps.store.resumeTask(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (result.outcome === "missing")
        return context.json({ error: "There is no such Task." }, 404);
      // §7: only a paused Task resumes; anything else answers with where it
      // stands — a double resume is refused, not silently ignored.
      if (result.outcome === "terminal")
        return context.json(
          {
            error: "This Task can no longer be resumed.",
            currentStatus: result.task.status,
          },
          409,
        );
      return context.json(taskDto(result.task), 200);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/wait/:waitId/answer", async (context) => {
    const parsed = answerWaitInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success)
      return context.json({ error: "The answer's values are required." }, 400);
    try {
      const result = await deps.store.answerWait(
        context.var.actor.id,
        context.req.param("id"),
        context.req.param("waitId"),
        parsed.data.values,
      );
      // A wrong task, a foreign task or a wrong waitId: all just not there.
      if (result.outcome === "missing")
        return context.json({ error: "There is no such wait." }, 404);
      // §7: a malformed answer never consumes — the wait stays open for the
      // owner to answer again, so the error says what to fix, not 409.
      if (result.outcome === "invalid")
        return context.json({ error: result.error }, 400);
      if (result.outcome === "terminal")
        return context.json(
          {
            error: "This Task can no longer be answered.",
            currentStatus: result.task.status,
          },
          409,
        );
      // `answered` consumed once and requeued; `replayed` answers the stored
      // result without advancing twice — the same body either way.
      return context.json(taskDto(result.task), 200);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  return routes;
}
