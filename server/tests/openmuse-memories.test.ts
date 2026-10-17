import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  createOpenMuseMemoriesRoutes,
  createOpenMuseMemoryRows,
  createOpenMuseMemoryStore,
  memoryLookupFor,
  OPENMUSE_MEMORY_PAGE,
  type OpenMuseMemoryRows,
  type OpenMuseMemoryStore,
  OpenMuseOwnerDisabledError,
  type StoredOpenMuseMemory,
} from "../src/openmuse-personal/memories";

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

/**
 * In-memory row store: same contract as the drizzle rows, rows live as data.
 * `pageByOwner` mirrors the drizzle keyset: live owned rows, composite
 * (createdAt desc, id desc) order, tuple-below the cursor, then a slice.
 */
function fakeRows(): OpenMuseMemoryRows & { memories: StoredOpenMuseMemory[] } {
  const memories: StoredOpenMuseMemory[] = [];
  const disabled = new Set<string>();
  const live = (row: StoredOpenMuseMemory, ownerUserId: string) =>
    row.ownerUserId === ownerUserId && row.deletedAt === null;
  const newestFirst = (a: StoredOpenMuseMemory, b: StoredOpenMuseMemory) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1);
  return {
    memories,
    insertMemory: async (memory) => {
      memories.push({ ...memory });
    },
    findMemory: async (ownerUserId, id) =>
      memories.find((row) => live(row, ownerUserId) && row.id === id) ?? null,
    listByOwner: async (ownerUserId) =>
      memories.filter((row) => live(row, ownerUserId)).sort(newestFirst),
    // §9: tombstones included — the deletion enumeration's own listing.
    listIdsByOwner: async (ownerUserId) =>
      memories
        .filter((row) => row.ownerUserId === ownerUserId)
        .map((row) => row.id),
    pageByOwner: async (ownerUserId, page) =>
      memories
        .filter((row) => {
          if (!live(row, ownerUserId)) return false;
          if (!page.before) return true;
          // Tuple comparison in the newest-first scan: strictly below the
          // cursor's (createdAt, id), equal ids excluded.
          const time =
            row.createdAt.getTime() - page.before.createdAt.getTime();
          return time < 0 || (time === 0 && row.id < page.before!.id);
        })
        .sort(newestFirst)
        .slice(0, page.limit),
    tombstoneMemory: async (ownerUserId, id) => {
      const row = memories.find(
        (candidate) => live(candidate, ownerUserId) && candidate.id === id,
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
  store: OpenMuseMemoryStore;
  rows: ReturnType<typeof fakeRows>;
  app: Hono<{ Variables: AppVariables }>;
};

function fixtureFor(): Fixture {
  const rows = fakeRows();
  const store = createOpenMuseMemoryStore({ rows });
  const app = createOpenMuseMemoriesRoutes({ store, requireUser });
  return { store, rows, app };
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type MemoryDto = {
  id: string;
  text: string;
  source: string;
  createdAt: string;
};

/** One created Memory's answer DTO, so later tests reuse the creation truth. */
async function createOne(
  fixture: Fixture,
  input: Record<string, unknown> = {},
): Promise<MemoryDto> {
  const response = await post(fixture.app, {
    text: "The user prefers replies in Chinese on weekdays.",
    source: "chat",
    ...input,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as MemoryDto;
}

describe("POST / (create)", () => {
  test("creates a Memory with the §7 fields", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    expect(typeof memory.id).toBe("string");
    expect(memory.text).toBe(
      "The user prefers replies in Chinese on weekdays.",
    );
    expect(memory.source).toBe("chat");
    expect(typeof memory.createdAt).toBe("string");

    const row = fixture.rows.memories[0];
    expect(row?.ownerUserId).toBe("user-1");
    expect(row?.deletedAt).toBeNull();
  });

  test("the DTO carries exactly id, text, source and createdAt", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    expect(Object.keys(memory).sort()).toEqual([
      "createdAt",
      "id",
      "source",
      "text",
    ]);
  });

  test("defaults: an empty source", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture, { source: undefined });
    expect(memory.source).toBe("");
  });

  test("source is enum-free: any string up to 50 characters is accepted", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture, { source: "灵感 ✨" });
    expect(memory.source).toBe("灵感 ✨");
  });

  test.each([
    ["an empty text", { text: "" }],
    ["a whitespace text", { text: "   " }],
    ["a 10_001-character text", { text: "x".repeat(10_001) }],
    ["a 51-character source", { text: "Ok", source: "x".repeat(51) }],
    ["a non-string text", { text: 7 }],
    ["a non-string source", { text: "Ok", source: 7 }],
    ["an unknown field", { text: "Ok", colour: "blue" }],
  ])("refuses %s with 400 and writes no row", async (_label, input) => {
    const fixture = fixtureFor();
    const response = await post(fixture.app, input);
    expect(response.status).toBe(400);
    expect(fixture.rows.memories).toHaveLength(0);
  });

  test("a 10_000-character text and a 50-character source are accepted", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture, {
      text: "x".repeat(10_000),
      source: "y".repeat(50),
    });
    expect(memory.text).toHaveLength(10_000);
    expect(memory.source).toHaveLength(50);
  });
});

describe("GET / (list) and owner scoping", () => {
  test("returns only the owner's memories, newest first", async () => {
    const fixture = fixtureFor();
    const first = await createOne(fixture, { text: "First" });
    // Same-millisecond creations would leave the order to random uuids, so
    // the older row gets a strictly older clock.
    fixture.rows.memories[0]!.createdAt = new Date(Date.now() - 60_000);
    const second = await createOne(fixture, { text: "Second" });
    currentActor = actorTwo;
    try {
      await createOne(fixture, { text: "Foreign" });
    } finally {
      currentActor = actorOne;
    }

    const response = await fixture.app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memories: Array<{ id: string }>;
      nextCursor: unknown;
    };
    expect(body.memories.map((memory) => memory.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(body.nextCursor).toBeNull();
  });

  test("same createdAt falls back to id descending, the siblings' cursor discipline", async () => {
    const fixture = fixtureFor();
    const one = await createOne(fixture, { text: "One" });
    const two = await createOne(fixture, { text: "Two" });
    const shared = new Date();
    fixture.rows.memories[0]!.createdAt = shared;
    fixture.rows.memories[1]!.createdAt = shared;

    const response = await fixture.app.request("/");
    const body = (await response.json()) as { memories: Array<{ id: string }> };
    expect(body.memories.map((memory) => memory.id)).toEqual(
      [one.id, two.id].sort().reverse(),
    );
  });

  test("a foreign list shows only that owner's memories", async () => {
    const fixture = fixtureFor();
    await createOne(fixture, { text: "Mine" });
    currentActor = actorTwo;
    try {
      await createOne(fixture, { text: "Theirs" });
      const foreign = await fixture.app.request("/");
      const foreignBody = (await foreign.json()) as {
        memories: Array<{ text: string }>;
      };
      expect(foreignBody.memories.map((memory) => memory.text)).toEqual([
        "Theirs",
      ]);
    } finally {
      currentActor = actorOne;
    }
  });

  test("pages reverse-chron with a cursor: no overlap, no gap, no tail cursor", async () => {
    const fixture = fixtureFor();
    const created: MemoryDto[] = [];
    const total = OPENMUSE_MEMORY_PAGE + 2;
    for (let index = 0; index < total; index += 1) {
      created.push(await createOne(fixture, { text: `Memory ${index}` }));
      // A strictly spaced clock makes the newest-first order deterministic.
      fixture.rows.memories[index]!.createdAt = new Date(
        Date.now() - (total - index) * 1_000,
      );
    }

    const firstPage = await fixture.app.request("/");
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      memories: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.memories).toHaveLength(OPENMUSE_MEMORY_PAGE);
    expect(typeof firstBody.nextCursor).toBe("string");
    // The page is the newest PAGE rows of the reverse-chron list.
    expect(firstBody.memories.map((memory) => memory.id)).toEqual(
      [...created]
        .reverse()
        .slice(0, OPENMUSE_MEMORY_PAGE)
        .map((m) => m.id),
    );

    const secondPage = await fixture.app.request(
      `/?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    );
    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as {
      memories: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.memories).toHaveLength(2);
    expect(secondBody.nextCursor).toBeNull();
    const seen = [...firstBody.memories, ...secondBody.memories].map(
      (memory) => memory.id,
    );
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...created].reverse().map((m) => m.id));
  });

  test("a cursor is stable across a repeated fetch of the same page", async () => {
    const fixture = fixtureFor();
    for (let index = 0; index < OPENMUSE_MEMORY_PAGE + 1; index += 1) {
      await createOne(fixture, { text: `Memory ${index}` });
      fixture.rows.memories[index]!.createdAt = new Date(
        Date.now() - (OPENMUSE_MEMORY_PAGE + 1 - index) * 1_000,
      );
    }
    const first = (await (await fixture.app.request("/")).json()) as {
      nextCursor: string | null;
    };
    const again = (await (await fixture.app.request("/")).json()) as {
      nextCursor: string | null;
    };
    expect(again.nextCursor).toBe(first.nextCursor);
  });

  test("a malformed cursor answers 400", async () => {
    const fixture = fixtureFor();
    await createOne(fixture);
    const response = await fixture.app.request("/?cursor=not-a-cursor");
    expect(response.status).toBe(400);
  });

  test("a safe integer beyond Date's range answers 400, not an Invalid-Date 500", async () => {
    const fixture = fixtureFor();
    await createOne(fixture);
    // 2^53-1 passes Number.isSafeInteger but is far outside JS Date's
    // ±8.64e15 ms span: the decode must refuse it like any other malformed
    // cursor, never hand pageByOwner an Invalid Date.
    const response = await fixture.app.request("/?cursor=9007199254740991%7Cx");
    expect(response.status).toBe(400);
  });
});

describe("GET /:id", () => {
  test("returns the exact record for the owner", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    const response = await fixture.app.request(`/${memory.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(memory);
  });

  test("a foreign id answers 404 for get and delete, and leaves the row alone", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    currentActor = actorTwo;
    try {
      expect((await fixture.app.request(`/${memory.id}`)).status).toBe(404);
      const deleted = await fixture.app.request(`/${memory.id}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(404);
    } finally {
      currentActor = actorOne;
    }
    const row = fixture.rows.memories[0];
    expect(row?.deletedAt).toBeNull();
    expect((await fixture.app.request(`/${memory.id}`)).status).toBe(200);
  });

  test("a missing id answers 404 for get and delete", async () => {
    const fixture = fixtureFor();
    expect((await fixture.app.request("/no-such-memory")).status).toBe(404);
    expect(
      (await fixture.app.request("/no-such-memory", { method: "DELETE" }))
        .status,
    ).toBe(404);
  });
});

describe("DELETE /:id", () => {
  test("tombstones: list, get and lookup all stop returning the id; a second delete answers 404", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);

    const deleted = await fixture.app.request(`/${memory.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    expect((await fixture.app.request(`/${memory.id}`)).status).toBe(404);
    const list = await fixture.app.request("/");
    const listed = (await list.json()) as { memories: Array<{ id: string }> };
    expect(listed.memories.map((row) => row.id)).not.toContain(memory.id);
    const lookup = memoryLookupFor({ rows: fixture.rows }, "user-1");
    expect(await lookup(memory.id)).toBeNull();

    const row = fixture.rows.memories[0];
    expect(row?.deletedAt).toBeInstanceOf(Date);

    const again = await fixture.app.request(`/${memory.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });
});

describe("the private Bot tool seam (memoryLookupFor)", () => {
  // RETRIEVAL SEMANTICS = EXPLICIT: the lookup answers an id with the exact
  // {id,text,source} record — no scoring, no relevance filtering, no
  // "useful" judgement. A record answers verbatim or not at all.
  test("returns exactly id, text and source for the owner", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    const lookup = memoryLookupFor({ rows: fixture.rows }, "user-1");
    expect(await lookup(memory.id)).toEqual({
      id: memory.id,
      text: "The user prefers replies in Chinese on weekdays.",
      source: "chat",
    });
  });

  test("another owner's lookup finds nothing", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    const foreign = memoryLookupFor({ rows: fixture.rows }, "user-2");
    expect(await foreign(memory.id)).toBeNull();
  });

  test("a missing id answers null without writing anything", async () => {
    const fixture = fixtureFor();
    const lookup = memoryLookupFor({ rows: fixture.rows }, "user-1");
    expect(await lookup("no-such-memory")).toBeNull();
  });
});

describe("§9 lifecycle hook", () => {
  test("disableOwner blocks create, list and delete with the disabled error", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    await fixture.store.disableOwner("user-1");

    await expect(
      fixture.store.create({
        ownerUserId: "user-1",
        text: "Nope",
        source: "",
      }),
    ).rejects.toBeInstanceOf(OpenMuseOwnerDisabledError);

    expect((await post(fixture.app, { text: "Nope" })).status).toBe(403);
    expect((await fixture.app.request("/")).status).toBe(403);
    expect(
      (await fixture.app.request(`/${memory.id}`, { method: "DELETE" })).status,
    ).toBe(403);
  });

  test("restoreOwner lifts the fence again", async () => {
    const fixture = fixtureFor();
    await fixture.store.disableOwner("user-1");
    await fixture.store.restoreOwner("user-1");
    expect((await post(fixture.app, { text: "Back" })).status).toBe(201);
  });

  test("enumerateOwner owes tombstones too — every owned row, for the D08 purge to name", async () => {
    const fixture = fixtureFor();
    const first = await createOne(fixture, { text: "Kept" });
    const second = await createOne(fixture, { text: "Deleted" });
    await fixture.app.request(`/${second.id}`, { method: "DELETE" });

    // §9: listByOwner is live-only for the API, but the deletion manifest
    // must name the soft-deleted rows too, or the final purge can never
    // remove them and they outlive the completed deletion.
    expect(await fixture.store.enumerateOwner("user-1")).toEqual([
      { kind: "openmuse-memory", id: first.id },
      { kind: "openmuse-memory", id: second.id },
    ]);
    expect(await fixture.store.enumerateOwner("user-2")).toEqual([]);
  });
});

describe("authentication", () => {
  test("without a session the verbs answer 401", async () => {
    const fixture = fixtureFor();
    const memory = await createOne(fixture);
    guardAdmits = false;
    try {
      expect((await post(fixture.app, { text: "X" })).status).toBe(401);
      expect((await fixture.app.request("/")).status).toBe(401);
      expect((await fixture.app.request(`/${memory.id}`)).status).toBe(401);
      expect(
        (await fixture.app.request(`/${memory.id}`, { method: "DELETE" }))
          .status,
      ).toBe(401);
    } finally {
      guardAdmits = true;
    }
  });
});

describe("the drizzle row seam shape", () => {
  test("createOpenMuseMemoryRows exposes the OpenMuseMemoryRows contract", () => {
    // Construction only: no database is dialed until a method runs, and the
    // wiring of the drizzle rows is exercised by the schema's migration.
    const rows = createOpenMuseMemoryRows({
      select: async () => [],
      insert: async () => {},
      update: async () => [],
    } as unknown as Parameters<typeof createOpenMuseMemoryRows>[0]);
    for (const method of [
      "insertMemory",
      "findMemory",
      "listByOwner",
      "listIdsByOwner",
      "pageByOwner",
      "tombstoneMemory",
      "ownerDisabled",
      "disableOwner",
      "restoreOwner",
    ]) {
      expect(typeof rows[method as keyof typeof rows]).toBe("function");
    }
  });
});
