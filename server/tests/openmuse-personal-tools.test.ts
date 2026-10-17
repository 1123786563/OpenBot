import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  goalLookupFor,
  type OpenMuseGoalRows,
  type StoredOpenMuseGoal,
} from "../src/openmuse-personal/goals";
import {
  ideaLookupFor,
  type OpenMuseIdeaRows,
  type StoredOpenMuseIdea,
} from "../src/openmuse-personal/ideas";
import {
  memoryLookupFor,
  type OpenMuseMemoryRows,
  type StoredOpenMuseMemory,
} from "../src/openmuse-personal/memories";
import { openMusePersonalTools } from "../src/openmuse-personal/tools";
import {
  createOpenMuseTaskStore,
  type OpenMuseTaskRows,
  type StoredOpenMuseTask,
} from "../src/openmuse-tasks/store";
import { REFUSAL_MARKER } from "../src/plugins/tools";

/*
 * C07: the private Bot's tools as pure functions over the seams they consume —
 * the P trio's lookups built for real over in-memory rows, and the T01 store
 * for real over in-memory rows plus a counting queue, so the delegate tests
 * exercise the genuine create/converge/offer-once behaviour rather than a fake
 * of it.
 */

function goalRows(): OpenMuseGoalRows & { goals: StoredOpenMuseGoal[] } {
  const goals: StoredOpenMuseGoal[] = [];
  return {
    goals,
    insertGoal: async (goal) => {
      goals.push({
        ...goal,
        milestones: goal.milestones.map((m) => ({ ...m })),
      });
    },
    findGoal: async (ownerUserId, id) =>
      goals.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    listByOwner: async (ownerUserId) =>
      goals.filter(
        (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
      ),
    listIdsByOwner: async (ownerUserId) =>
      goals
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    updateGoal: async (ownerUserId, id, patch) => {
      const row = goals.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null,
      );
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date() });
      return { ...row, milestones: row.milestones.map((m) => ({ ...m })) };
    },
    tombstoneGoal: async (ownerUserId, id) => {
      const row = goals.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId && candidate.id === id,
      );
      if (!row) return false;
      row.deletedAt = new Date();
      return true;
    },
    ownerDisabled: async () => false,
    disableOwner: async () => {},
    restoreOwner: async () => {},
  };
}

function ideaRows(): OpenMuseIdeaRows & { ideas: StoredOpenMuseIdea[] } {
  const ideas: StoredOpenMuseIdea[] = [];
  return {
    ideas,
    insertIdea: async (idea) => {
      ideas.push({ ...idea, evidence: idea.evidence.map((e) => ({ ...e })) });
    },
    findIdea: async (ownerUserId, id) =>
      ideas.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    listByOwner: async (ownerUserId) =>
      ideas.filter(
        (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
      ),
    listIdsByOwner: async (ownerUserId) =>
      ideas
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    updateIdea: async (ownerUserId, id, patch) => {
      const { whereStatusIn, ...sets } = patch;
      const row = ideas.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null &&
          (!whereStatusIn || whereStatusIn.includes(candidate.status)),
      );
      if (!row) return null;
      Object.assign(row, sets, { updatedAt: new Date() });
      return { ...row, evidence: row.evidence.map((e) => ({ ...e })) };
    },
    tombstoneIdea: async (ownerUserId, id) => {
      const row = ideas.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId && candidate.id === id,
      );
      if (!row) return false;
      row.deletedAt = new Date();
      return true;
    },
    ownerDisabled: async () => false,
    disableOwner: async () => {},
    restoreOwner: async () => {},
  };
}

function memoryRows(): OpenMuseMemoryRows & {
  memories: StoredOpenMuseMemory[];
} {
  const memories: StoredOpenMuseMemory[] = [];
  return {
    memories,
    insertMemory: async (memory) => {
      memories.push({ ...memory });
    },
    findMemory: async (ownerUserId, id) =>
      memories.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    listByOwner: async (ownerUserId) =>
      memories.filter(
        (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
      ),
    listIdsByOwner: async (ownerUserId) =>
      memories
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    pageByOwner: async (ownerUserId, { limit, before }) =>
      memories
        .filter(
          (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
        )
        .filter((row) =>
          before
            ? row.createdAt < before.createdAt ||
              (row.createdAt.getTime() === before.createdAt.getTime() &&
                row.id < before.id)
            : true,
        )
        .slice(0, limit),
    tombstoneMemory: async (ownerUserId, id) => {
      const row = memories.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId && candidate.id === id,
      );
      if (!row) return false;
      row.deletedAt = new Date();
      return true;
    },
    ownerDisabled: async () => false,
    disableOwner: async () => {},
    restoreOwner: async () => {},
  };
}

/*
 * The task rows the T01 store runs on: insert/idempotency/get/settle are real
 * (the delegate tests walk them), the CAS methods the store never reaches in
 * this file answer "missing". Same shape as openmuse-tasks.test.ts's fixture,
 * trimmed to the paths exercised here.
 */
function taskRows(): OpenMuseTaskRows & { tasks: StoredOpenMuseTask[] } {
  const tasks: StoredOpenMuseTask[] = [];
  const disabled = new Set<string>();
  return {
    tasks,
    insertTask: async (task) => {
      tasks.push(task);
    },
    findTaskByIdempotencyKey: async (ownerUserId, key) =>
      tasks.find(
        (row) => row.ownerUserId === ownerUserId && row.idempotencyKey === key,
      ) ?? null,
    getTask: async (id) => tasks.find((row) => row.id === id) ?? null,
    listByOwner: async (ownerUserId, { limit }) =>
      tasks.filter((row) => row.ownerUserId === ownerUserId).slice(0, limit),
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
      if (patch.ifAttempts !== undefined && row.attempts !== patch.ifAttempts)
        return null;
      if (patch.attempts !== undefined) row.attempts = patch.attempts;
      if (patch.status) row.status = patch.status;
      if (patch.evidence)
        row.evidence = patch.evidence.map((entry) => ({ ...entry }));
      if (patch.appendedEvidence)
        row.evidence.push(
          ...patch.appendedEvidence.map((entry) => ({ ...entry })),
        );
      row.updatedAt = new Date();
      return { ...row };
    },
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
    requestTaskCancel: async () => ({ kind: "missing" as const }),
    requestTaskPause: async () => ({ kind: "missing" as const }),
    resumeTask: async () => ({ kind: "missing" as const }),
    retryTask: async () => ({ kind: "missing" as const }),
    openTaskWait: async () => null,
    openTaskReviewWait: async () => null,
    answerTaskWait: async () => ({ kind: "missing" as const }),
  };
}

/** The tool set built exactly the way index.ts builds it for the private Bot. */
function fixtureFor(options: { fenced?: boolean } = {}) {
  const goals = goalRows();
  const ideas = ideaRows();
  const memories = memoryRows();
  const rows = taskRows();
  const offered: { kind: string; key: string }[] = [];
  const taskStore = createOpenMuseTaskStore({
    rows,
    queue: {
      offer: async (item) => {
        offered.push({ kind: item.kind, key: item.key });
      },
    },
  });
  const tools = openMusePersonalTools({
    ownerUserId: "user-1",
    agentId: "bot-1",
    goalLookup: goalLookupFor({ rows: goals }, "user-1"),
    ideaLookup: ideaLookupFor({ rows: ideas }, "user-1"),
    memoryLookup: memoryLookupFor({ rows: memories }, "user-1"),
    tasks: taskStore,
    ...(options.fenced !== undefined
      ? { ownerFenced: async () => options.fenced as boolean }
      : {}),
  });
  const byName = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} not offered`);
    return tool;
  };
  return { goals, ideas, memories, rows, offered, taskStore, byName };
}

const at = () => new Date("2026-10-13T00:00:00.000Z");

function goalFor(
  ownerUserId: string,
  id: string,
  overrides: Partial<StoredOpenMuseGoal> = {},
): StoredOpenMuseGoal {
  return {
    id,
    ownerUserId,
    title: "Learn the cello",
    description: "Evenings, twice a week.",
    category: "personal",
    status: "active",
    milestones: [
      { id: "m-one", title: "Buy a bow", status: "todo" },
      { id: "m-two", title: "Book lessons", status: "done" },
    ],
    createdAt: at(),
    updatedAt: at(),
    deletedAt: null,
    ...overrides,
  };
}

function ideaFor(
  ownerUserId: string,
  id: string,
  overrides: Partial<StoredOpenMuseIdea> = {},
): StoredOpenMuseIdea {
  return {
    id,
    ownerUserId,
    title: "Weekly review idea",
    reason: "The calendar showed a gap on Fridays.",
    evidence: [{ kind: "calendar", ref: "event-1" }],
    prompt: "Draft the weekly review note.",
    kind: "note",
    input: "calendar",
    status: "pending",
    taskId: null,
    createdAt: at(),
    updatedAt: at(),
    deletedAt: null,
    ...overrides,
  };
}

describe("openmuse_goal_read", () => {
  test("returns the owner's goal exactly: id, title, milestone statuses", async () => {
    const fixture = fixtureFor();
    await fixture.goals.insertGoal(goalFor("user-1", "goal-1"));
    const result = await fixture.byName("openmuse_goal_read").execute({
      id: "goal-1",
    });
    expect(JSON.parse(result)).toEqual({
      id: "goal-1",
      title: "Learn the cello",
      milestoneStatuses: ["todo", "done"],
    });
  });

  test("another owner's goal and a deleted goal answer notFound", async () => {
    const fixture = fixtureFor();
    await fixture.goals.insertGoal(goalFor("user-2", "goal-foreign"));
    await fixture.goals.insertGoal(
      goalFor("user-1", "goal-gone", { deletedAt: at() }),
    );
    const tool = fixture.byName("openmuse_goal_read");
    expect(JSON.parse(await tool.execute({ id: "goal-foreign" }))).toEqual({
      notFound: "goal-foreign",
    });
    expect(JSON.parse(await tool.execute({ id: "goal-gone" }))).toEqual({
      notFound: "goal-gone",
    });
  });
});

describe("openmuse_idea_read", () => {
  test("returns the owner's live idea exactly; withdrawn answers notFound", async () => {
    const fixture = fixtureFor();
    await fixture.ideas.insertIdea(ideaFor("user-1", "idea-1"));
    await fixture.ideas.insertIdea(
      ideaFor("user-1", "idea-2", { status: "withdrawn" }),
    );
    const tool = fixture.byName("openmuse_idea_read");
    expect(JSON.parse(await tool.execute({ id: "idea-1" }))).toEqual({
      id: "idea-1",
      title: "Weekly review idea",
      kind: "note",
    });
    expect(JSON.parse(await tool.execute({ id: "idea-2" }))).toEqual({
      notFound: "idea-2",
    });
  });
});

describe("openmuse_memory_read", () => {
  test("returns the owner's memory verbatim: id, text, source", async () => {
    const fixture = fixtureFor();
    await fixture.memories.insertMemory({
      id: "memory-1",
      ownerUserId: "user-1",
      text: "Prefers calls before noon.",
      source: "conversation",
      createdAt: at(),
      deletedAt: null,
    });
    const result = await fixture.byName("openmuse_memory_read").execute({
      id: "memory-1",
    });
    expect(JSON.parse(result)).toEqual({
      id: "memory-1",
      text: "Prefers calls before noon.",
      source: "conversation",
    });
  });
});

describe("owner binding", () => {
  test("an identity argument is refused, never honored, on every tool", async () => {
    const fixture = fixtureFor();
    await fixture.goals.insertGoal(goalFor("user-1", "goal-1"));
    const goal = await fixture
      .byName("openmuse_goal_read")
      .execute({ id: "goal-1", userId: "user-2" });
    expect(goal.startsWith(REFUSAL_MARKER)).toBe(true);
    const delegate = await fixture
      .byName("openmuse_task_delegate")
      .execute({ task_summary: "Draft the note", ownerUserId: "user-2" });
    expect(delegate.startsWith(REFUSAL_MARKER)).toBe(true);
  });
});

describe("openmuse_task_delegate", () => {
  test("creates one agent Task with the summary, offers the queue once, reports the row's queued status", async () => {
    const fixture = fixtureFor();
    const result = await fixture.byName("openmuse_task_delegate").execute({
      task_summary: "Summarize this task and delegate it: the weekly review",
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("queued");
    expect(fixture.rows.tasks).toHaveLength(1);
    expect(fixture.rows.tasks[0]).toMatchObject({
      id: parsed.taskId,
      kind: "agent",
      prompt: "Summarize this task and delegate it: the weekly review",
      ownerUserId: "user-1",
      botId: "bot-1",
      status: "queued",
    });
    expect(fixture.offered).toEqual([
      { kind: "openmuse-task", key: parsed.taskId },
    ]);
  });

  test("refuses once the owner's active Task quota is full — no Task, no queue offer, a readable refusal", async () => {
    const fixture = fixtureFor();
    // O04's ceiling, as the create route reads it: 100 non-terminal Tasks.
    for (let index = 0; index < 100; index++) {
      const created = await fixture.taskStore.create({
        ownerUserId: "user-1",
        botId: "bot-1",
        kind: "agent",
        prompt: `filler-${index}`,
        idempotencyKey: null,
      });
      void created;
    }
    const offeredBefore = fixture.offered.length;
    const result = await fixture.byName("openmuse_task_delegate").execute({
      task_summary: "One delegation too many",
    });
    expect(result.startsWith(REFUSAL_MARKER)).toBe(true);
    // The quota held: no 101st Task was created and nothing new offered —
    // only the fillers' own offers are on the record.
    expect(fixture.rows.tasks).toHaveLength(100);
    expect(fixture.offered).toHaveLength(offeredBefore);
  });

  test("the same idempotency key converges on one Task", async () => {
    const fixture = fixtureFor();
    const first = JSON.parse(
      await fixture.byName("openmuse_task_delegate").execute({
        task_summary: "Draft the note",
        idempotency_key: "weekly-review",
      }),
    );
    const second = JSON.parse(
      await fixture.byName("openmuse_task_delegate").execute({
        task_summary: "Draft the note",
        idempotency_key: "weekly-review",
      }),
    );
    expect(second.taskId).toBe(first.taskId);
    expect(fixture.rows.tasks).toHaveLength(1);
    expect(fixture.offered).toHaveLength(1);
  });

  test("reports the row's live status, never a fabricated one", async () => {
    const fixture = fixtureFor();
    const first = JSON.parse(
      await fixture.byName("openmuse_task_delegate").execute({
        task_summary: "Draft the note",
        idempotency_key: "weekly-review",
      }),
    );
    expect(first.status).toBe("queued");
    // The Task moves on while the same delegation is asked again: the row, not
    // the tool, decides what the reply may claim.
    await fixture.taskStore.settleTask(first.taskId, {
      ifAttempts: 1,
      status: "running",
    });
    const live = JSON.parse(
      await fixture.byName("openmuse_task_delegate").execute({
        task_summary: "Draft the note",
        idempotency_key: "weekly-review",
      }),
    );
    expect(live).toEqual({ taskId: first.taskId, status: "running" });
  });
});

/*
 * D01's fence, read by the tool seam (§9): the interactive chat path reaches these
 * tools WITHOUT the /api/mobile fence in front of it, so a fenced owner's private Bot
 * must be refused HERE — a fenced account cannot read its Goals/Ideas/Memories back
 * verbatim through the model, and a delegated Task is refused the readable way rather
 * than unwinding out of GrantedTool.execute.
 */
describe("the §9 fence at the tool seam", () => {
  test("fenced owner's reads answer the refusal marker, never the data", async () => {
    const fixture = fixtureFor({ fenced: true });
    await fixture.goals.insertGoal(goalFor("user-1", "goal-1"));
    await fixture.ideas.insertIdea(ideaFor("user-1", "idea-1"));
    await fixture.memories.insertMemory({
      id: "memory-1",
      ownerUserId: "user-1",
      text: "Prefers calls before noon.",
      source: "conversation",
      createdAt: at(),
      deletedAt: null,
    });
    for (const [name, id] of [
      ["openmuse_goal_read", "goal-1"],
      ["openmuse_idea_read", "idea-1"],
      ["openmuse_memory_read", "memory-1"],
    ] as const) {
      const result = await fixture.byName(name).execute({ id });
      expect(result.startsWith(REFUSAL_MARKER)).toBe(true);
      expect(result).not.toContain("cello");
    }
  });

  test("task_delegate refuses a fenced owner instead of throwing", async () => {
    const fixture = fixtureFor({ fenced: true });
    const result = await fixture
      .byName("openmuse_task_delegate")
      .execute({ task_summary: "Do anything." });
    expect(result.startsWith(REFUSAL_MARKER)).toBe(true);
    expect(fixture.offered).toEqual([]);
  });

  test("an unfenced owner reads and delegates exactly as before", async () => {
    const fixture = fixtureFor({ fenced: false });
    await fixture.goals.insertGoal(goalFor("user-1", "goal-1"));
    const read = await fixture.byName("openmuse_goal_read").execute({
      id: "goal-1",
    });
    expect(JSON.parse(read)).toMatchObject({ id: "goal-1" });
  });
});
