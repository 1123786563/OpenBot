import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { openmuseMemories } from "../db/schema/openmuse";
import { createOwnerDisabled, OpenMuseOwnerDisabledError } from "./shared";

export { OpenMuseOwnerDisabledError };

/**
 * OpenMuse private Memories (contracts §7, ticket P03): owner CRUD over one
 * table of immutable texts — a Memory is written once, never updated, so a
 * row never changes after insert and there is no updated_at. Delete
 * tombstones; D05 restores, D06 purges. `memoryLookupFor` is the read-only
 * tool seam the private Bot's runtime will call: it answers EXACTLY id,
 * text and source — retrieval semantics are explicit (an id returns its
 * verbatim record), never a scored or "useful" result, and no other owner's
 * row or tombstoned id answers at all.
 */

export type StoredOpenMuseMemory = {
  id: string;
  ownerUserId: string;
  text: string;
  source: string;
  createdAt: Date;
  deletedAt: Date | null;
};



/** One list page, in the siblings' (createdAt desc, id desc) discipline. */
export const OPENMUSE_MEMORY_PAGE = 50;

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseMemoryRows = {
  insertMemory(memory: StoredOpenMuseMemory): Promise<void>;
  /** A live owned row, or null — foreign and tombstoned are indistinguishable. */
  findMemory(
    ownerUserId: string,
    id: string,
  ): Promise<StoredOpenMuseMemory | null>;
  /** Every live owned row, reverse-chron — the §9 enumeration walk. */
  listByOwner(ownerUserId: string): Promise<StoredOpenMuseMemory[]>;
  /**
   * §9 (D08): every owned id, tombstones included — listByOwner is live-only
   * for the API, but the deletion manifest owes the soft-deleted rows too,
   * or the final purge could never remove them.
   */
  listIdsByOwner(ownerUserId: string): Promise<string[]>;
  /** At most `limit` live owned rows strictly below the cursor, newest first. */
  pageByOwner(
    ownerUserId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredOpenMuseMemory[]>;
  tombstoneMemory(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): hard-delete the owner's rows for the manifest's ids — one
   * statement, so a batch is atomic. Owner-scoped: a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteMemories(ownerUserId: string, ids: string[]): Promise<void>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
};

/** A page of the owner's list plus the cursor the next page continues from. */
export type OpenMuseMemoryPage = {
  memories: StoredOpenMuseMemory[];
  nextCursor: string | null;
};

export type OpenMuseMemoryStore = {
  create(input: {
    ownerUserId: string;
    text: string;
    source: string;
  }): Promise<StoredOpenMuseMemory>;
  /** One reverse-chron page continuing below `before`, if given. */
  list(
    ownerUserId: string,
    before?: { createdAt: Date; id: string },
  ): Promise<OpenMuseMemoryPage>;
  get(ownerUserId: string, id: string): Promise<StoredOpenMuseMemory | null>;
  delete(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteMemories`, owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, ids: string[]): Promise<void>;
  /** §9 lifecycle hook: refuse work for a disabled owner. */
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  enumerateOwner(
    ownerUserId: string,
  ): Promise<Array<{ kind: "openmuse-memory"; id: string }>>;
};

function newId(): string {
  return `openmuse-memory-${crypto.randomUUID()}`;
}

/** The cursor is the last row's composite key, plain and self-describing. */
function encodeCursor(memory: StoredOpenMuseMemory): string {
  return `${memory.createdAt.getTime()}|${memory.id}`;
}

/** A malformed cursor answers null, so the route can refuse it as a 400. */
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const separator = cursor.indexOf("|");
  if (separator === -1) return null;
  const time = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  const createdAt = new Date(time);
  if (
    !Number.isSafeInteger(time) ||
    id === "" ||
    // JS Dates span ±8.64e15 ms; a safe integer beyond that range would
    // otherwise pass through as an Invalid Date and surface as a 500.
    Number.isNaN(createdAt.getTime())
  )
    return null;
  return { createdAt, id };
}

export function createOpenMuseMemoryStore(deps: {
  rows: OpenMuseMemoryRows;
}): OpenMuseMemoryStore {
  const guard = async (ownerUserId: string) => {
    if (await deps.rows.ownerDisabled(ownerUserId))
      throw new OpenMuseOwnerDisabledError(ownerUserId);
  };

  return {
    async create(input) {
      await guard(input.ownerUserId);
      const memory: StoredOpenMuseMemory = {
        id: newId(),
        ownerUserId: input.ownerUserId,
        text: input.text,
        source: input.source,
        createdAt: new Date(),
        deletedAt: null,
      };
      await deps.rows.insertMemory(memory);
      return memory;
    },
    async list(ownerUserId, before) {
      await guard(ownerUserId);
      // One row over the page size is the only "a next page exists" signal.
      const rows = await deps.rows.pageByOwner(ownerUserId, {
        limit: OPENMUSE_MEMORY_PAGE + 1,
        ...(before ? { before } : {}),
      });
      const memories = rows.slice(0, OPENMUSE_MEMORY_PAGE);
      const boundary = memories.at(-1);
      return {
        memories,
        nextCursor:
          rows.length > OPENMUSE_MEMORY_PAGE && boundary !== undefined
            ? encodeCursor(boundary)
            : null,
      };
    },
    get: (ownerUserId, id) => deps.rows.findMemory(ownerUserId, id),
    async delete(ownerUserId, id) {
      await guard(ownerUserId);
      return deps.rows.tombstoneMemory(ownerUserId, id);
    },
    disableOwner: (ownerUserId) => deps.rows.disableOwner(ownerUserId),
    restoreOwner: (ownerUserId) => deps.rows.restoreOwner(ownerUserId),
    hardDelete: (ownerUserId, ids) =>
      deps.rows.hardDeleteMemories(ownerUserId, ids),
    async enumerateOwner(ownerUserId) {
      // §9 enumeration owes tombstones too: listIdsByOwner ignores deletedAt
      // so the manifest names every row D08 must purge, not only live ones.
      return (await deps.rows.listIdsByOwner(ownerUserId)).map((id) => ({
        kind: "openmuse-memory" as const,
        id,
      }));
    },
  };
}

/** The exact record the private Bot's tool may see — nothing more. */
export type MemoryToolRecord = {
  id: string;
  text: string;
  source: string;
};

/**
 * The P03 tool seam: a read-only, owner-bound Memory lookup. No runtime tool
 * registry exists yet in this codebase; C07 (observable assistant
 * delegation) ports the runtime and wires this lookup in as the Bot's
 * `memory.read` tool — a foreign owner's id, or a Bot without the owner's
 * grant, simply gets null because the lookup never leaves its owner.
 * Retrieval is explicit: an id answers its verbatim record, no scoring.
 */
export function memoryLookupFor(
  deps: { rows: OpenMuseMemoryRows },
  ownerUserId: string,
): (id: string) => Promise<MemoryToolRecord | null> {
  return async (id) => {
    const memory = await deps.rows.findMemory(ownerUserId, id);
    if (!memory) return null;
    return { id: memory.id, text: memory.text, source: memory.source };
  };
}

function rowToMemory(
  row: typeof openmuseMemories.$inferSelect,
): StoredOpenMuseMemory {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    text: row.text,
    source: row.source,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

/** The drizzle-backed row seam. */
export function createOpenMuseMemoryRows(
  database: Database,
): OpenMuseMemoryRows {
  const ownerDisabledRow = createOwnerDisabled(database);
  const live = (ownerUserId: string, id: string) =>
    and(
      eq(openmuseMemories.ownerUserId, ownerUserId),
      eq(openmuseMemories.id, id),
      isNull(openmuseMemories.deletedAt),
    );
  const newestFirst = [
    desc(openmuseMemories.createdAt),
    desc(openmuseMemories.id),
  ];
  return {
    async insertMemory(memory) {
      await database.insert(openmuseMemories).values({
        id: memory.id,
        ownerUserId: memory.ownerUserId,
        text: memory.text,
        source: memory.source,
        createdAt: memory.createdAt,
        deletedAt: memory.deletedAt,
      });
    },
    async findMemory(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(openmuseMemories)
        .where(live(ownerUserId, id))
        .limit(1);
      return row ? rowToMemory(row) : null;
    },
    async listByOwner(ownerUserId) {
      const rows = await database
        .select()
        .from(openmuseMemories)
        .where(
          and(
            eq(openmuseMemories.ownerUserId, ownerUserId),
            isNull(openmuseMemories.deletedAt),
          ),
        )
        .orderBy(...newestFirst);
      return rows.map(rowToMemory);
    },
    async listIdsByOwner(ownerUserId) {
      const rows = await database
        .select({ id: openmuseMemories.id })
        .from(openmuseMemories)
        .where(eq(openmuseMemories.ownerUserId, ownerUserId));
      return rows.map((row) => row.id);
    },
    async pageByOwner(ownerUserId, page) {
      // Keyset, in the composite order the index backs: strictly below the
      // cursor's (createdAt, id) tuple, equal ids excluded.
      const below = page.before
        ? or(
            lt(openmuseMemories.createdAt, page.before.createdAt),
            and(
              eq(openmuseMemories.createdAt, page.before.createdAt),
              lt(openmuseMemories.id, page.before.id),
            ),
          )
        : undefined;
      const rows = await database
        .select()
        .from(openmuseMemories)
        .where(
          and(
            eq(openmuseMemories.ownerUserId, ownerUserId),
            isNull(openmuseMemories.deletedAt),
            ...(below ? [below] : []),
          ),
        )
        .orderBy(...newestFirst)
        .limit(page.limit);
      return rows.map(rowToMemory);
    },
    async tombstoneMemory(ownerUserId, id) {
      const rows = await database
        .update(openmuseMemories)
        .set({ deletedAt: new Date() })
        .where(live(ownerUserId, id))
        .returning({ id: openmuseMemories.id });
      return rows.length > 0;
    },
    async hardDeleteMemories(ownerUserId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseMemories)
        .where(
          and(
            eq(openmuseMemories.ownerUserId, ownerUserId),
            inArray(openmuseMemories.id, ids),
          ),
        );
    },
    /*
     * D01's marker is the deleted-owner fence — the same phase-aware read
     * the /api/mobile fence and the tasks rows make: disabled while the
     * marker is still `fenced`, lifted by D05's restore. BOUNDARY RECORDED:
     * the read paths (get / memoryLookupFor) stay unguarded — the HTTP reads
     * sit behind the /api/mobile fence, and the Bot tool seam is reached
     * only through the runner the tasks rows already fence.
     */
    ownerDisabled: ownerDisabledRow,
    async disableOwner() {},
    async restoreOwner() {},
  };
}

/** §7 DTO the client renders; explicit fields, no row internals leak. */
function memoryDto(memory: StoredOpenMuseMemory) {
  return {
    id: memory.id,
    text: memory.text,
    source: memory.source,
    createdAt: memory.createdAt.toISOString(),
  };
}

const createInput = z.strictObject({
  text: z.string().trim().min(1).max(10_000),
  // Enum-free by contract, like an Idea's kind.
  source: z.string().trim().max(50).default(""),
});

/**
 * `/openmuse-memories` (mounted under `/api/mobile` by the app seam): the
 * owner's private Memories behind the session guard.
 */
export function createOpenMuseMemoriesRoutes(deps: {
  store: OpenMuseMemoryStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.post("/", async (context) => {
    const input = createInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json({ error: "A text is required." }, 400);
    }
    try {
      const memory = await deps.store.create({
        ownerUserId: context.var.actor.id,
        text: input.data.text,
        source: input.data.source,
      });
      return context.json(memoryDto(memory), 201);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/", async (context) => {
    const cursor = context.req.query("cursor");
    const before =
      cursor === undefined || cursor === "" ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && cursor !== "" && before === null) {
      return context.json({ error: "That page cursor is not valid." }, 400);
    }
    try {
      const page = await deps.store.list(
        context.var.actor.id,
        before ?? undefined,
      );
      return context.json({
        memories: page.memories.map(memoryDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/:id", async (context) => {
    const memory = await deps.store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!memory)
      return context.json({ error: "There is no such Memory." }, 404);
    return context.json(memoryDto(memory));
  });

  routes.delete("/:id", async (context) => {
    try {
      const deleted = await deps.store.delete(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!deleted)
        return context.json({ error: "There is no such Memory." }, 404);
      return context.body(null, 204);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  return routes;
}
