import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createOpenMuseIdeaRows,
  createOpenMuseIdeaStore,
  createOpenMuseIdeasRoutes,
  ideaLookupFor,
  type OpenMuseIdeaRows,
  type OpenMuseIdeaStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseIdea,
} from "../src/openmuse-personal/ideas";

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

/** In-memory row store: same contract as the drizzle rows, rows live as data. */
function fakeRows(): OpenMuseIdeaRows & { ideas: StoredOpenMuseIdea[] } {
  const ideas: StoredOpenMuseIdea[] = [];
  const disabled = new Set<string>();
  return {
    ideas,
    insertIdea: async (idea) => {
      ideas.push({
        ...idea,
        evidence: idea.evidence.map((entry) => ({ ...entry })),
      });
    },
    findIdea: async (ownerUserId, id) =>
      ideas.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.id === id &&
          row.deletedAt === null,
      ) ?? null,
    listByOwner: async (ownerUserId) =>
      ideas
        .filter(
          (row) => row.ownerUserId === ownerUserId && row.deletedAt === null,
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id > b.id ? -1 : 1),
        ),
    // §9: tombstones included — the deletion enumeration's own listing.
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
          // The statement-level precondition: a row whose status left the
          // allowed set matches zero rows, like the drizzle WHERE.
          (!whereStatusIn || whereStatusIn.includes(candidate.status)),
      );
      if (row === undefined) {
        return null;
      }
      Object.assign(row, sets, { updatedAt: new Date() });
      return { ...row, evidence: row.evidence.map((entry) => ({ ...entry })) };
    },
    tombstoneIdea: async (ownerUserId, id) => {
      const row = ideas.find(
        (candidate) =>
          candidate.ownerUserId === ownerUserId &&
          candidate.id === id &&
          candidate.deletedAt === null,
      );
      if (row === undefined) {
        return false;
      }
      row.deletedAt = new Date();
      return true;
    },
    ownerDisabled: async (ownerUserId) => disabled.has(ownerUserId),
    disableOwner: async (ownerUserId) => {
      disabled.add(ownerUserId);
    },
    restoreOwner: async (ownerUserId) => {
      disabled.delete(ownerUserId);
    },
  };
}

/** The tasks-store get seam as tests drive it: rows keyed by owner, or null. */
type FakeTask = { id: string; ownerUserId: string };

function fakeGetTask(tasks: FakeTask[]) {
  return async (ownerUserId: string, taskId: string) =>
    tasks.find(
      (task) => task.ownerUserId === ownerUserId && task.id === taskId,
    ) ?? null;
}

type Fixture = {
  store: OpenMuseIdeaStore;
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(tasks: FakeTask[] = []): Fixture {
  const rows = fakeRows();
  const store = createOpenMuseIdeaStore({
    rows,
    getTask: fakeGetTask(tasks),
  });
  const app = createOpenMuseIdeasRoutes({ store, requireUser });
  return { store, rows, app };
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function accept(
  app: Hono<{ Variables: AppVariables }>,
  id: string,
  body: unknown,
) {
  return app.request(`/${id}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withdraw(app: Hono<{ Variables: AppVariables }>, id: string) {
  return app.request(`/${id}/withdraw`, { method: "POST" });
}

type IdeaDto = {
  id: string;
  title: string;
  reason: string;
  evidence: Array<{ kind: string; ref: string }>;
  prompt: string;
  kind: string;
  input: string;
  status: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One created Idea's answer DTO, so later tests reuse the creation truth. */
async function createOne(
  fixture: Fixture,
  input: Record<string, unknown> = {},
): Promise<IdeaDto> {
  const response = await post(fixture.app, {
    title: "Automate the newsletter",
    reason: "Saves an hour every week",
    evidence: [{ kind: "web", ref: "https://example.com/report" }],
    prompt: "Draft the weekly digest",
    kind: "activity-insight",
    input: "The chat on 2026-10-01 about mailing lists",
    ...input,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as IdeaDto;
}

describe("POST / (create)", () => {
  test("creates an Idea with the §7 fields, pending, no task", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    expect(typeof idea.id).toBe("string");
    expect(idea.title).toBe("Automate the newsletter");
    expect(idea.reason).toBe("Saves an hour every week");
    expect(idea.evidence).toEqual([
      { kind: "web", ref: "https://example.com/report" },
    ]);
    expect(idea.prompt).toBe("Draft the weekly digest");
    expect(idea.kind).toBe("activity-insight");
    expect(idea.input).toBe("The chat on 2026-10-01 about mailing lists");
    expect(idea.status).toBe("pending");
    expect(idea.taskId).toBeNull();
    expect(typeof idea.createdAt).toBe("string");
    expect(typeof idea.updatedAt).toBe("string");

    const row = fixture.rows.ideas[0];
    expect(row?.ownerUserId).toBe("user-1");
    expect(row?.status).toBe("pending");
    expect(row?.deletedAt).toBeNull();
  });

  test("defaults: empty reason, evidence, prompt, kind and input", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, { title: "Read longform" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      title: "Read longform",
      reason: "",
      evidence: [],
      prompt: "",
      kind: "",
      input: "",
      status: "pending",
      taskId: null,
    });
  });

  test("kind is enum-free: any string up to 50 characters is accepted", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, {
      title: "Someday",
      kind: "灵感 ✨",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as IdeaDto;
    expect(body.kind).toBe("灵感 ✨");
  });

  test("twenty evidence entries are accepted", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, {
      title: "Ok",
      evidence: Array.from({ length: 20 }, (_, index) => ({
        kind: "web",
        ref: `https://example.com/${index}`,
      })),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as IdeaDto;
    expect(body.evidence).toHaveLength(20);
  });

  test.each([
    ["an empty title", { title: "" }],
    ["a whitespace title", { title: "   " }],
    ["a 201-character title", { title: "x".repeat(201) }],
    ["a 51-character kind", { title: "Ok", kind: "x".repeat(51) }],
    ["a 51-character input", { title: "Ok", input: "x".repeat(51) }],
    [
      "21 evidence entries",
      {
        title: "Ok",
        evidence: Array.from({ length: 21 }, (_, index) => ({
          kind: "web",
          ref: `https://example.com/${index}`,
        })),
      },
    ],
    [
      "an evidence entry without a ref",
      { title: "Ok", evidence: [{ kind: "web" }] },
    ],
    [
      "an evidence entry without a kind",
      { title: "Ok", evidence: [{ ref: "https://example.com" }] },
    ],
    ["a non-string ref", { title: "Ok", evidence: [{ kind: "web", ref: 7 }] }],
    ["an unknown field", { title: "Ok", colour: "blue" }],
  ])("refuses %s with 400 and writes no row", async (_label, input) => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, input);
    expect(response.status).toBe(400);
    expect(fixture.rows.ideas).toHaveLength(0);
  });

  test("a 200-character title is accepted", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, { title: "x".repeat(200) });
    expect(response.status).toBe(201);
  });
});

describe("GET / (list) and owner scoping", () => {
  test("returns only the owner's ideas, newest first", async () => {
    const fixture = fixtureFor();
    const first = await createOne(fixture, { title: "First" });
    // Same-millisecond creations would leave the order to random uuids, so
    // the older row gets a strictly older clock.
    fixture.rows.ideas[0]!.createdAt = new Date(Date.now() - 60_000);
    const second = await createOne(fixture, { title: "Second" });
    currentActor = actorTwo;
    try {
      await createOne(fixture, { title: "Foreign" });
    } finally {
      currentActor = actorOne;
    }

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ideas: Array<{ id: string }> };
    expect(body.ideas.map((idea) => idea.id)).toEqual([second.id, first.id]);

    currentActor = actorTwo;
    try {
      const foreign = await fixture.app.request("/");
      const foreignBody = (await foreign.json()) as {
        ideas: Array<{ title: string }>;
      };
      expect(foreignBody.ideas.map((idea) => idea.title)).toEqual(["Foreign"]);
    } finally {
      currentActor = actorOne;
    }
  });

  test("a foreign id answers 404 for get, accept, withdraw and delete, and leaves the row alone", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    currentActor = actorTwo;
    try {
      expect((await fixture.app.request(`/${idea.id}`)).status).toBe(404);
      expect(
        (await accept(fixture.app, idea.id, { taskId: "task-own" })).status,
      ).toBe(404);
      expect((await withdraw(fixture.app, idea.id)).status).toBe(404);
      const deleted = await fixture.app.request(`/${idea.id}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    const row = fixture.rows.ideas[0];
    expect(row?.title).toBe("Automate the newsletter");
    expect(row?.deletedAt).toBeNull();
    expect(row?.status).toBe("pending");
    expect((await fixture.app.request(`/${idea.id}`)).status).toBe(200);
  });

  test("a missing id answers 404 for get, accept, withdraw and delete", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    expect((await fixture.app.request("/no-such-idea")).status).toBe(404);
    expect(
      (await accept(fixture.app, "no-such-idea", { taskId: "task-own" }))
        .status,
    ).toBe(404);
    expect((await withdraw(fixture.app, "no-such-idea")).status).toBe(404);
    expect(
      (await fixture.app.request("/no-such-idea", { method: "DELETE" })).status,
    ).toBe(404);
  });
});

describe("POST /:id/accept", () => {
  test("accepts onto an owned Task: status accepted, taskId set", async () => {
    const fixture = fixtureFor([
      { id: "task-own", ownerUserId: "user-1" },
      { id: "task-foreign", ownerUserId: "user-2" },
    ]);
    const idea = await createOne(fixture);

    const response = await accept(fixture.app, idea.id, {
      taskId: "task-own",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: idea.id,
      status: "accepted",
      taskId: "task-own",
    });

    const row = fixture.rows.ideas[0];
    expect(row?.status).toBe("accepted");
    expect(row?.taskId).toBe("task-own");
  });

  test("a foreign or missing Task refuses with 400 and changes nothing", async () => {
    const fixture = fixtureFor([
      { id: "task-own", ownerUserId: "user-1" },
      { id: "task-foreign", ownerUserId: "user-2" },
    ]);
    const idea = await createOne(fixture);

    for (const taskId of ["task-foreign", "no-such-task"]) {
      const response = await accept(fixture.app, idea.id, { taskId });
      expect(response.status).toBe(400);
    }

    const row = fixture.rows.ideas[0];
    expect(row?.status).toBe("pending");
    expect(row?.taskId).toBeNull();
  });

  test("a second accept onto the same Task is idempotent", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    await accept(fixture.app, idea.id, { taskId: "task-own" });
    const again = await accept(fixture.app, idea.id, { taskId: "task-own" });
    expect(again.status).toBe(200);
    const body = (await again.json()) as IdeaDto;
    expect(body.status).toBe("accepted");
    expect(body.taskId).toBe("task-own");
  });

  test("re-accepting onto another owned Task re-points, still one Task", async () => {
    const fixture = fixtureFor([
      { id: "task-one", ownerUserId: "user-1" },
      { id: "task-two", ownerUserId: "user-1" },
    ]);
    const idea = await createOne(fixture);
    await accept(fixture.app, idea.id, { taskId: "task-one" });
    const response = await accept(fixture.app, idea.id, { taskId: "task-two" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as IdeaDto;
    expect(body.status).toBe("accepted");
    expect(body.taskId).toBe("task-two");
  });

  test("accepting a withdrawn Idea answers 409", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    await withdraw(fixture.app, idea.id);
    const response = await accept(fixture.app, idea.id, {
      taskId: "task-own",
    });
    expect(response.status).toBe(409);
    const row = fixture.rows.ideas[0];
    expect(row?.status).toBe("withdrawn");
    expect(row?.taskId).toBeNull();
  });

  test("a withdraw that interleaves with accept's checks wins the write — the terminal state is never resurrected", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    // The race, replayed: accept's re-read answers the pre-withdraw snapshot
    // (stale), while the row itself was withdrawn between the checks and
    // the write. The conditional UPDATE matches zero rows and answers
    // missing instead of flipping the withdrawn row back to accepted.
    const current = fixture.rows.ideas.find((row) => row.id === idea.id);
    expect(current).toBeDefined();
    const stale = { ...current! };
    await fixture.store.withdraw("user-1", idea.id);
    const findIdea = fixture.rows.findIdea;
    fixture.rows.findIdea = async (ownerUserId, id) =>
      id === idea.id ? stale : findIdea(ownerUserId, id);
    const outcome = await fixture.store.accept("user-1", idea.id, "task-own");
    expect(outcome.outcome).toBe("missing");
    const row = fixture.rows.ideas.find(
      (candidate) => candidate.id === idea.id,
    );
    expect(row?.status).toBe("withdrawn");
    expect(row?.taskId).toBeNull();
  });

  test.each([
    ["a body without a taskId", {}],
    ["an empty taskId", { taskId: "" }],
    ["a non-string taskId", { taskId: 7 }],
  ])("refuses %s with 400", async (_label, body) => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    const response = await accept(fixture.app, idea.id, body);
    expect(response.status).toBe(400);
  });
});

describe("POST /:id/withdraw", () => {
  test("withdraws: status withdrawn, the owner still sees it", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    const response = await withdraw(fixture.app, idea.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: idea.id,
      status: "withdrawn",
      taskId: null,
    });

    const got = await fixture.app.request(`/${idea.id}`);
    expect(got.status).toBe(200);
    const listed = await fixture.app.request("/");
    const body = (await listed.json()) as { ideas: Array<{ id: string }> };
    expect(body.ideas.map((row) => row.id)).toContain(idea.id);
  });

  test("keeps taskId for history: accept then withdraw retains the link", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    await accept(fixture.app, idea.id, { taskId: "task-own" });
    const response = await withdraw(fixture.app, idea.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as IdeaDto;
    expect(body.status).toBe("withdrawn");
    // RECORDED CHOICE: the Task link stays for history instead of being
    // cleared — §9 restoration reads Ideas as read-only history.
    expect(body.taskId).toBe("task-own");
    const row = fixture.rows.ideas[0];
    expect(row?.taskId).toBe("task-own");
  });

  test("a second withdraw stays withdrawn (idempotent)", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    await withdraw(fixture.app, idea.id);
    const again = await withdraw(fixture.app, idea.id);
    expect(again.status).toBe(200);
    expect((await again.json()) as IdeaDto).toMatchObject({
      status: "withdrawn",
    });
  });
});

describe("DELETE /:id", () => {
  test("tombstones: get and list hide it, a second delete answers 404", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);

    const deleted = await fixture.app.request(`/${idea.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    expect((await fixture.app.request(`/${idea.id}`)).status).toBe(404);
    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { ideas: Array<{ id: string }> };
    expect(listed.ideas.map((row) => row.id)).not.toContain(idea.id);

    const row = fixture.rows.ideas[0];
    expect(row?.deletedAt).toBeInstanceOf(Date);

    const again = await fixture.app.request(`/${idea.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });
});

describe("the private Bot tool seam (ideaLookupFor)", () => {
  test("returns exactly id, title and kind for the owner", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    const lookup = ideaLookupFor({ rows: fixture.rows }, "user-1");
    expect(await lookup(idea.id)).toEqual({
      id: idea.id,
      title: "Automate the newsletter",
      kind: "activity-insight",
    });
  });

  test("another owner's lookup finds nothing", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    const foreign = ideaLookupFor({ rows: fixture.rows }, "user-2");
    expect(await foreign(idea.id)).toBeNull();
  });

  test("withdrawn and deleted ids stop returning", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    const lookup = ideaLookupFor({ rows: fixture.rows }, "user-1");

    await withdraw(fixture.app, idea.id);
    expect(await lookup(idea.id)).toBeNull();

    const kept = await createOne(fixture, { title: "Kept" });
    expect(await lookup(kept.id)).not.toBeNull();
    await fixture.app.request(`/${kept.id}`, { method: "DELETE" });
    expect(await lookup(kept.id)).toBeNull();
  });
});

describe("§9 lifecycle hook", () => {
  test("disableOwner blocks create, list, accept, withdraw and delete with the disabled error", async () => {
    const fixture = fixtureFor([{ id: "task-own", ownerUserId: "user-1" }]);
    const idea = await createOne(fixture);
    await fixture.store.disableOwner("user-1");

    await expect(
      fixture.store.create({
        ownerUserId: "user-1",
        title: "Nope",
        reason: "",
        evidence: [],
        prompt: "",
        kind: "",
        input: "",
      }),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);

    expect((await post(fixture.app, { title: "Nope" })).status).toBe(403);
    expect((await fixture.app.request("/")).status).toBe(403);
    expect(
      (await accept(fixture.app, idea.id, { taskId: "task-own" })).status,
    ).toBe(403);
    expect((await withdraw(fixture.app, idea.id)).status).toBe(403);
    expect(
      (await fixture.app.request(`/${idea.id}`, { method: "DELETE" })).status,
    ).toBe(403);
  });

  test("enumerateOwner owes tombstones too — every owned row, for the D08 purge to name", async () => {
    const fixture = fixtureFor();
    const first = await createOne(fixture, { title: "Kept" });
    const second = await createOne(fixture, { title: "Deleted" });
    await fixture.app.request(`/${second.id}`, { method: "DELETE" });

    // §9: listByOwner is live-only for the API, but the deletion manifest
    // must name the soft-deleted rows too, or the final purge can never
    // remove them and they outlive the completed deletion.
    expect(await fixture.store.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-idea", id: first.id },
      { kind: "openmuse-idea", id: second.id },
    ]);
    expect(await fixture.store.enumerateOwner("user-2")).toEqual([]);
  });
});

describe("authentication", () => {
  test("without a session the verbs answer 401", async () => {
    const fixture = fixtureFor();
    const idea = await createOne(fixture);
    guardAdmits = false;
    try {
      expect((await post(fixture.app, { title: "X" })).status).toBe(401);
      expect((await fixture.app.request("/")).status).toBe(401);
      expect((await fixture.app.request(`/${idea.id}`)).status).toBe(401);
      expect(
        (await accept(fixture.app, idea.id, { taskId: "task-own" })).status,
      ).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});

describe("the drizzle row seam shape", () => {
  test("createOpenMuseIdeaRows exposes the OpenMuseIdeaRows contract", () => {
    // Construction only: no database is dialed until a method runs, and the
    // wiring of the drizzle rows is exercised by the schema's migration.
    const rows = createOpenMuseIdeaRows({
      select: async () => [],
      insert: async () => {},
      update: async () => [],
    } as unknown as Parameters<typeof createOpenMuseIdeaRows>[0]);
    for (const method of [
      "insertIdea",
      "findIdea",
      "listByOwner",
      "listIdsByOwner",
      "updateIdea",
      "tombstoneIdea",
      "ownerDisabled",
      "disableOwner",
      "restoreOwner",
    ]) {
      expect(typeof rows[method as keyof typeof rows]).toBe("function");
    }
  });
});
