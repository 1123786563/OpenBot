import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { openmuseGoals } from "../db/schema/openmuse";
import { createOwnerDisabled, OpenMuseOwnerDisabledError } from "./shared";

export { OpenMuseOwnerDisabledError };

/**
 * OpenMuse private Goals (contracts §7, ticket P01): owner CRUD over one
 * table with jsonb milestones — single-row writes, so a patch (including a
 * full milestone replacement) lands atomically. Delete tombstones; D05
 * restores, D06 purges. `goalLookupFor` is the read-only tool seam the
 * private Bot's runtime will call: it answers EXACTLY id, title and
 * milestone statuses — no description, no category, no other owner's row.
 */

/** §7 Goal statuses, as the OpenMuse service defined them. */
export type OpenMuseGoalStatus = "active" | "paused" | "completed";
/** A milestone carries the original's done flag as a status. */
export type OpenMuseMilestoneStatus = "todo" | "done";

export type OpenMuseGoalMilestone = {
  id: string;
  title: string;
  status: OpenMuseMilestoneStatus;
};

export type StoredOpenMuseGoal = {
  id: string;
  ownerUserId: string;
  title: string;
  description: string;
  category: string;
  status: OpenMuseGoalStatus;
  milestones: OpenMuseGoalMilestone[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseGoalRows = {
  insertGoal(goal: StoredOpenMuseGoal): Promise<void>;
  /** A live owned row, or null — foreign and tombstoned are indistinguishable. */
  findGoal(ownerUserId: string, id: string): Promise<StoredOpenMuseGoal | null>;
  listByOwner(ownerUserId: string): Promise<StoredOpenMuseGoal[]>;
  /**
   * §9 (D08): every owned id, tombstones included — listByOwner is live-only
   * for the API, but the deletion manifest owes the soft-deleted rows too,
   * or the final purge could never remove them.
   */
  listIdsByOwner(ownerUserId: string): Promise<string[]>;
  /** One write: whichever fields the patch names, milestones replaced whole. */
  updateGoal(
    ownerUserId: string,
    id: string,
    patch: Partial<
      Pick<
        StoredOpenMuseGoal,
        "title" | "description" | "category" | "status" | "milestones"
      >
    >,
  ): Promise<StoredOpenMuseGoal | null>;
  tombstoneGoal(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): hard-delete the owner's rows for the manifest's ids — one
   * statement, so a batch is atomic. Owner-scoped: a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteGoals(ownerUserId: string, ids: string[]): Promise<void>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
};

export type OpenMuseGoalStore = {
  create(input: {
    ownerUserId: string;
    title: string;
    description: string;
    category: string;
    /** Milestone titles; each becomes {id, title, status: "todo"}. */
    milestones: string[];
  }): Promise<StoredOpenMuseGoal>;
  list(ownerUserId: string): Promise<StoredOpenMuseGoal[]>;
  get(ownerUserId: string, id: string): Promise<StoredOpenMuseGoal | null>;
  patch(
    ownerUserId: string,
    id: string,
    patch: {
      title?: string;
      description?: string;
      category?: string;
      status?: OpenMuseGoalStatus;
      milestones?: OpenMuseGoalMilestone[];
    },
  ): Promise<StoredOpenMuseGoal | null>;
  delete(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteGoals`, owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, ids: string[]): Promise<void>;
  /** §9 lifecycle hook: refuse work for a disabled owner. */
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  enumerateOwner(
    ownerUserId: string,
  ): Promise<Array<{ kind: "openmuse-goal"; id: string }>>;
};

function newId(): string {
  return `openmuse-goal-${crypto.randomUUID()}`;
}

export function createOpenMuseGoalStore(deps: {
  rows: OpenMuseGoalRows;
}): OpenMuseGoalStore {
  const guard = async (ownerUserId: string) => {
    if (await deps.rows.ownerDisabled(ownerUserId))
      throw new OpenMuseOwnerDisabledError(ownerUserId);
  };

  return {
    async create(input) {
      await guard(input.ownerUserId);
      const now = new Date();
      const goal: StoredOpenMuseGoal = {
        id: newId(),
        ownerUserId: input.ownerUserId,
        title: input.title,
        description: input.description,
        category: input.category,
        status: "active",
        milestones: input.milestones.map((title) => ({
          id: crypto.randomUUID(),
          title,
          status: "todo" as const,
        })),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await deps.rows.insertGoal(goal);
      return goal;
    },
    async list(ownerUserId) {
      await guard(ownerUserId);
      return deps.rows.listByOwner(ownerUserId);
    },
    get: (ownerUserId, id) => deps.rows.findGoal(ownerUserId, id),
    async patch(ownerUserId, id, patch) {
      await guard(ownerUserId);
      return deps.rows.updateGoal(ownerUserId, id, patch);
    },
    async delete(ownerUserId, id) {
      await guard(ownerUserId);
      return deps.rows.tombstoneGoal(ownerUserId, id);
    },
    disableOwner: (ownerUserId) => deps.rows.disableOwner(ownerUserId),
    restoreOwner: (ownerUserId) => deps.rows.restoreOwner(ownerUserId),
    hardDelete: (ownerUserId, ids) =>
      deps.rows.hardDeleteGoals(ownerUserId, ids),
    async enumerateOwner(ownerUserId) {
      // §9 enumeration owes tombstones too: listIdsByOwner ignores deletedAt
      // so the manifest names every row D08 must purge, not only live ones.
      return (await deps.rows.listIdsByOwner(ownerUserId)).map((id) => ({
        kind: "openmuse-goal" as const,
        id,
      }));
    },
  };
}

/** The exact record the private Bot's tool may see — nothing more. */
export type GoalToolRecord = {
  id: string;
  title: string;
  milestoneStatuses: OpenMuseMilestoneStatus[];
};

/**
 * The P01 tool seam: a read-only, owner-bound Goal lookup. No runtime tool
 * registry exists yet in this codebase; C07 (observable assistant
 * delegation) ports the runtime and wires this lookup in as the Bot's
 * `goal.read` tool — a foreign owner's id, or a Bot without the owner's
 * grant, simply gets null because the lookup never leaves its owner.
 */
export function goalLookupFor(
  deps: { rows: OpenMuseGoalRows },
  ownerUserId: string,
): (id: string) => Promise<GoalToolRecord | null> {
  return async (id) => {
    const goal = await deps.rows.findGoal(ownerUserId, id);
    if (!goal) return null;
    return {
      id: goal.id,
      title: goal.title,
      milestoneStatuses: goal.milestones.map((milestone) => milestone.status),
    };
  };
}

function rowToGoal(row: typeof openmuseGoals.$inferSelect): StoredOpenMuseGoal {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    milestones: row.milestones,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** The drizzle-backed row seam. */
export function createOpenMuseGoalRows(database: Database): OpenMuseGoalRows {
  const ownerDisabledRow = createOwnerDisabled(database);
  const live = (ownerUserId: string, id: string) =>
    and(
      eq(openmuseGoals.ownerUserId, ownerUserId),
      eq(openmuseGoals.id, id),
      isNull(openmuseGoals.deletedAt),
    );
  return {
    async insertGoal(goal) {
      await database.insert(openmuseGoals).values({
        id: goal.id,
        ownerUserId: goal.ownerUserId,
        title: goal.title,
        description: goal.description,
        category: goal.category,
        status: goal.status,
        milestones: goal.milestones,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        deletedAt: goal.deletedAt,
      });
    },
    async findGoal(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(openmuseGoals)
        .where(live(ownerUserId, id))
        .limit(1);
      return row ? rowToGoal(row) : null;
    },
    async listByOwner(ownerUserId) {
      const rows = await database
        .select()
        .from(openmuseGoals)
        .where(
          and(
            eq(openmuseGoals.ownerUserId, ownerUserId),
            isNull(openmuseGoals.deletedAt),
          ),
        )
        .orderBy(desc(openmuseGoals.createdAt), desc(openmuseGoals.id));
      return rows.map(rowToGoal);
    },
    async listIdsByOwner(ownerUserId) {
      const rows = await database
        .select({ id: openmuseGoals.id })
        .from(openmuseGoals)
        .where(eq(openmuseGoals.ownerUserId, ownerUserId));
      return rows.map((row) => row.id);
    },
    async updateGoal(ownerUserId, id, patch) {
      const [row] = await database
        .update(openmuseGoals)
        .set({ ...patch, updatedAt: new Date() })
        .where(live(ownerUserId, id))
        .returning();
      return row ? rowToGoal(row) : null;
    },
    async tombstoneGoal(ownerUserId, id) {
      const rows = await database
        .update(openmuseGoals)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(live(ownerUserId, id))
        .returning({ id: openmuseGoals.id });
      return rows.length > 0;
    },
    async hardDeleteGoals(ownerUserId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseGoals)
        .where(
          and(
            eq(openmuseGoals.ownerUserId, ownerUserId),
            inArray(openmuseGoals.id, ids),
          ),
        );
    },
    /*
     * D01's marker is the deleted-owner fence — the same phase-aware read
     * the /api/mobile fence and the tasks rows make: disabled while the
     * marker is still `fenced`, lifted by D05's restore. BOUNDARY RECORDED:
     * the read paths (get / goalLookupFor) stay unguarded — the HTTP reads
     * sit behind the /api/mobile fence, and the Bot tool seam is reached
     * only through the runner the tasks rows already fence.
     */
    ownerDisabled: ownerDisabledRow,
    async disableOwner() {},
    async restoreOwner() {},
  };
}

/** §7 DTO the client renders; explicit fields, no row internals leak. */
function goalDto(goal: StoredOpenMuseGoal) {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    category: goal.category,
    status: goal.status,
    milestones: goal.milestones,
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

const createInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4_000).default(""),
  category: z.string().trim().max(50).default("Personal"),
  milestones: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
});

const milestoneInput = z.strictObject({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  status: z.enum(["todo", "done"]),
});

const patchInput = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4_000).optional(),
  category: z.string().trim().max(50).optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z.array(milestoneInput).max(50).optional(),
});

/**
 * `/openmuse-goals` (mounted under `/api/mobile` by the app seam): the
 * owner's private Goals behind the session guard.
 */
export function createOpenMuseGoalsRoutes(deps: {
  store: OpenMuseGoalStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.post("/", async (context) => {
    const input = createInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json(
        { error: "A title and milestones are required." },
        400,
      );
    }
    try {
      const goal = await deps.store.create({
        ownerUserId: context.var.actor.id,
        title: input.data.title,
        description: input.data.description,
        category: input.data.category,
        milestones: input.data.milestones,
      });
      return context.json(goalDto(goal), 201);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/", async (context) => {
    try {
      const goals = await deps.store.list(context.var.actor.id);
      return context.json({ goals: goals.map(goalDto) });
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/:id", async (context) => {
    const goal = await deps.store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!goal) return context.json({ error: "There is no such Goal." }, 404);
    return context.json(goalDto(goal));
  });

  routes.patch("/:id", async (context) => {
    const input = patchInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json({ error: "That Goal update is not valid." }, 400);
    }
    try {
      const goal = await deps.store.patch(
        context.var.actor.id,
        context.req.param("id"),
        input.data,
      );
      if (!goal) return context.json({ error: "There is no such Goal." }, 404);
      return context.json(goalDto(goal));
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.delete("/:id", async (context) => {
    try {
      const deleted = await deps.store.delete(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!deleted)
        return context.json({ error: "There is no such Goal." }, 404);
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
