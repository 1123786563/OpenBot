import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createOpenMuseGoalStore,
  createOpenMuseGoalsRoutes,
  goalLookupFor,
  type OpenMuseGoalRows,
  type OpenMuseGoalStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseGoal,
} from "../src/openmuse-personal/goals";

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
function fakeRows(): OpenMuseGoalRows & { goals: StoredOpenMuseGoal[] } {
  const goals: StoredOpenMuseGoal[] = [];
  const disabled = new Set<string>();
  return {
    goals,
    insertGoal: async (goal) => {
      goals.push({
        ...goal,
        milestones: goal.milestones.map((milestone) => ({ ...milestone })),
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
      goals
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
      if (row === undefined) {
        return null;
      }
      Object.assign(row, patch, { updatedAt: new Date() });
      return {
        ...row,
        milestones: row.milestones.map((milestone) => ({ ...milestone })),
      };
    },
    tombstoneGoal: async (ownerUserId, id) => {
      const row = goals.find(
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

type Fixture = {
  store: OpenMuseGoalStore;
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(): Fixture {
  const rows = fakeRows();
  const store = createOpenMuseGoalStore({ rows });
  const app = createOpenMuseGoalsRoutes({ store, requireUser });
  return { store, rows, app };
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(
  app: Hono<{ Variables: AppVariables }>,
  id: string,
  body: unknown,
) {
  return app.request(`/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type GoalDto = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: string;
  milestones: Array<{ id: string; title: string; status: string }>;
  createdAt: string;
  updatedAt: string;
};

/** One created Goal's answer DTO, so later tests reuse the creation truth. */
async function createOne(
  fixture: Fixture,
  input: Record<string, unknown> = {},
): Promise<GoalDto> {
  const response = await post(fixture.app, {
    title: "Learn the cello",
    description: "Evenings, gently",
    category: "Music",
    milestones: ["Buy a bow", "Book lessons"],
    ...input,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as GoalDto;
}

describe("POST / (create)", () => {
  test("creates a Goal with status active and todo milestones", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    expect(typeof goal.id).toBe("string");
    expect(goal.title).toBe("Learn the cello");
    expect(goal.description).toBe("Evenings, gently");
    expect(goal.category).toBe("Music");
    expect(goal.status).toBe("active");
    expect(goal.milestones).toHaveLength(2);
    for (const milestone of goal.milestones) {
      expect(typeof milestone.id).toBe("string");
      expect(milestone.status).toBe("todo");
    }
    expect(goal.milestones.map((milestone) => milestone.title)).toEqual([
      "Buy a bow",
      "Book lessons",
    ]);
    expect(typeof goal.createdAt).toBe("string");
    expect(typeof goal.updatedAt).toBe("string");

    const row = fixture.rows.goals[0];
    expect(row?.ownerUserId).toBe("user-1");
    expect(row?.status).toBe("active");
    expect(row?.deletedAt).toBeNull();
  });

  test("defaults: empty description, Personal category, no milestones", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, { title: "Read more" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      title: "Read more",
      description: "",
      category: "Personal",
      status: "active",
      milestones: [],
    });
  });

  test("category is enum-free: any string up to 50 characters is accepted", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, {
      title: "Someday",
      category: "健康与健身 ✨",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as GoalDto;
    expect(body.category).toBe("健康与健身 ✨");
  });

  test.each([
    ["an empty title", { title: "" }],
    ["a whitespace title", { title: "   " }],
    ["a 201-character title", { title: "x".repeat(201) }],
    ["a 51-character category", { title: "Ok", category: "x".repeat(51) }],
    [
      "51 milestones",
      {
        title: "Ok",
        milestones: Array.from({ length: 51 }, (_, index) => `m${index}`),
      },
    ],
    ["an empty milestone title", { title: "Ok", milestones: [""] }],
    [
      "a 201-character milestone title",
      { title: "Ok", milestones: ["x".repeat(201)] },
    ],
    ["a non-string milestone", { title: "Ok", milestones: [7] }],
  ])("refuses %s with 400 and writes no row", async (_label, input) => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, input);
    expect(response.status).toBe(400);
    expect(fixture.rows.goals).toHaveLength(0);
  });

  test("a 200-character title and 50 milestones are accepted", async () => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, {
      title: "x".repeat(200),
      milestones: Array.from({ length: 50 }, (_, index) => `m${index}`),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as GoalDto;
    expect(body.milestones).toHaveLength(50);
  });
});

describe("GET / (list) and owner scoping", () => {
  test("returns only the owner's goals, newest first", async () => {
    const fixture = fixtureFor();
    const first = await createOne(fixture, { title: "First" });
    // Same-millisecond creations would leave the order to random uuids, so
    // the older row gets a strictly older clock.
    fixture.rows.goals[0]!.createdAt = new Date(Date.now() - 60_000);
    const second = await createOne(fixture, { title: "Second" });
    currentActor = actorTwo;
    try {
      await createOne(fixture, { title: "Foreign" });
    } finally {
      currentActor = actorOne;
    }

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { goals: Array<{ id: string }> };
    expect(body.goals.map((goal) => goal.id)).toEqual([second.id, first.id]);

    currentActor = actorTwo;
    try {
      const foreign = await fixture.app.request("/");
      const foreignBody = (await foreign.json()) as {
        goals: Array<{ title: string }>;
      };
      expect(foreignBody.goals.map((goal) => goal.title)).toEqual(["Foreign"]);
    } finally {
      currentActor = actorOne;
    }
  });

  test("a foreign id answers 404 for get, patch and delete, and leaves the row alone", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    currentActor = actorTwo;
    try {
      expect((await fixture.app.request(`/${goal.id}`)).status).toBe(404);
      const renamed = await patch(fixture.app, goal.id, { title: "Stolen" });
      expect(renamed.status).toBe(404);
      const deleted = await fixture.app.request(`/${goal.id}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    const row = fixture.rows.goals[0];
    expect(row?.title).toBe("Learn the cello");
    expect(row?.deletedAt).toBeNull();
    expect((await fixture.app.request(`/${goal.id}`)).status).toBe(200);
  });

  test("a missing id answers 404 for get, patch and delete", async () => {
    const fixture = fixtureFor();
    expect((await fixture.app.request("/no-such-goal")).status).toBe(404);
    expect(
      (await patch(fixture.app, "no-such-goal", { title: "X" })).status,
    ).toBe(404);
    expect(
      (await fixture.app.request("/no-such-goal", { method: "DELETE" })).status,
    ).toBe(404);
  });
});

describe("PATCH /:id", () => {
  test("updates scalar fields", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    const response = await patch(fixture.app, goal.id, {
      title: "Learn the violin",
      description: "Mornings now",
      category: "Strings",
      status: "paused",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: goal.id,
      title: "Learn the violin",
      description: "Mornings now",
      category: "Strings",
      status: "paused",
    });
  });

  test("replaces milestones atomically: the new array is the whole truth", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    const response = await patch(fixture.app, goal.id, {
      milestones: [
        { id: "m-one", title: "Rent a cello", status: "done" },
        { id: "m-two", title: "First scale", status: "todo" },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GoalDto;
    expect(body.milestones).toEqual([
      { id: "m-one", title: "Rent a cello", status: "done" },
      { id: "m-two", title: "First scale", status: "todo" },
    ]);

    // The row holds exactly the replacement — the create-time milestones are gone.
    const row = fixture.rows.goals[0];
    expect(row?.milestones).toHaveLength(2);
    expect(row?.milestones.map((milestone) => milestone.id)).toEqual([
      "m-one",
      "m-two",
    ]);
  });

  test.each([
    ["an unknown status", { status: "abandoned" }],
    ["an empty title", { title: "" }],
    [
      "an unknown milestone status",
      { milestones: [{ id: "m", title: "T", status: "started" }] },
    ],
    [
      "a milestone without an id",
      { milestones: [{ title: "T", status: "todo" }] },
    ],
    [
      "51 milestones",
      {
        milestones: Array.from({ length: 51 }, (_, index) => ({
          id: `m${index}`,
          title: `T${index}`,
          status: "todo" as const,
        })),
      },
    ],
  ])("refuses %s with 400", async (_label, input) => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    const response = await patch(fixture.app, goal.id, input);
    expect(response.status).toBe(400);
  });
});

describe("DELETE /:id", () => {
  test("tombstones: get and list hide it, a second delete answers 404", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);

    const deleted = await fixture.app.request(`/${goal.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    expect((await fixture.app.request(`/${goal.id}`)).status).toBe(404);
    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { goals: Array<{ id: string }> };
    expect(listed.goals.map((row) => row.id)).not.toContain(goal.id);

    const row = fixture.rows.goals[0];
    expect(row?.deletedAt).toBeInstanceOf(Date);

    const again = await fixture.app.request(`/${goal.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });
});

describe("the private Bot tool seam (goalLookupFor)", () => {
  test("returns exactly id, title and milestone statuses for the owner", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    const lookup = goalLookupFor({ rows: fixture.rows }, "user-1");
    const record = await lookup(goal.id);
    expect(record).toEqual({
      id: goal.id,
      title: "Learn the cello",
      milestoneStatuses: ["todo", "todo"],
    });
  });

  test("follows milestone patches, and another owner's lookup finds nothing", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    await patch(fixture.app, goal.id, {
      milestones: [
        { id: "m-one", title: "Buy a bow", status: "done" },
        { id: "m-two", title: "Book lessons", status: "todo" },
      ],
    });
    const own = goalLookupFor({ rows: fixture.rows }, "user-1");
    expect(await own(goal.id)).toEqual({
      id: goal.id,
      title: "Learn the cello",
      milestoneStatuses: ["done", "todo"],
    });
    // A foreign owner's seam — or a Bot without a grant — gets no record.
    const foreign = goalLookupFor({ rows: fixture.rows }, "user-2");
    expect(await foreign(goal.id)).toBeNull();
  });

  test("after delete the id no longer returns", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    const lookup = goalLookupFor({ rows: fixture.rows }, "user-1");
    expect(await lookup(goal.id)).not.toBeNull();
    await fixture.app.request(`/${goal.id}`, { method: "DELETE" });
    expect(await lookup(goal.id)).toBeNull();
  });
});

describe("§9 lifecycle hook", () => {
  test("disableOwner blocks create, list, patch and delete with the disabled error", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    await fixture.store.disableOwner("user-1");

    await expect(
      fixture.store.create({
        ownerUserId: "user-1",
        title: "Nope",
        milestones: [],
      }),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);

    expect((await post(fixture.app, { title: "Nope" })).status).toBe(403);
    expect((await fixture.app.request("/")).status).toBe(403);
    expect((await patch(fixture.app, goal.id, { title: "Nope" })).status).toBe(
      403,
    );
    expect(
      (await fixture.app.request(`/${goal.id}`, { method: "DELETE" })).status,
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
      { kind: "openmuse-goal", id: first.id },
      { kind: "openmuse-goal", id: second.id },
    ]);
    expect(await fixture.store.enumerateOwner("user-2")).toEqual([]);
  });
});

describe("authentication", () => {
  test("without a session the verbs answer 401", async () => {
    const fixture = fixtureFor();
    const goal = await createOne(fixture);
    guardAdmits = false;
    try {
      expect((await post(fixture.app, { title: "X" })).status).toBe(401);
      expect((await fixture.app.request("/")).status).toBe(401);
      expect((await fixture.app.request(`/${goal.id}`)).status).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});
