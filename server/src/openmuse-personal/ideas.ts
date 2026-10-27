import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/public";
import type { Database } from "../db/client";
import { openmuseIdeas } from "../db/schema/openmuse";
import { createOwnerDisabled, OpenMuseOwnerDisabledError } from "./shared";

export { OpenMuseOwnerDisabledError };

/**
 * OpenMuse private Ideas (contracts §7, ticket P02): owner CRUD over one
 * table with jsonb evidence — single-row writes, so a state change lands
 * atomically. An ACCEPTED Idea points to exactly one Task: `taskId` is
 * validated on accept through the tasks store's owner-scoped get, so a
 * foreign or missing Task refuses without touching the row. Delete
 * tombstones; D05 restores, D06 purges. `ideaLookupFor` is the read-only
 * tool seam the private Bot's runtime will call: it answers EXACTLY id,
 * title and kind — no prompt, no evidence, no other owner's row, and
 * nothing once the Idea is withdrawn.
 */

/** §7 Idea statuses, as the OpenMuse service defined them. */
export type OpenMuseIdeaStatus = "pending" | "accepted" | "withdrawn";

/** A §7 evidence entry: an enum-free kind plus a reference to the source. */
export type OpenMuseIdeaEvidence = { kind: string; ref: string };

export type StoredOpenMuseIdea = {
  id: string;
  ownerUserId: string;
  title: string;
  reason: string;
  evidence: OpenMuseIdeaEvidence[];
  prompt: string;
  kind: string;
  input: string;
  status: OpenMuseIdeaStatus;
  /** The Task an accepted Idea points at; null while pending. */
  taskId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseIdeaRows = {
  insertIdea(idea: StoredOpenMuseIdea): Promise<void>;
  /** A live owned row, or null — foreign and tombstoned are indistinguishable. */
  findIdea(ownerUserId: string, id: string): Promise<StoredOpenMuseIdea | null>;
  listByOwner(ownerUserId: string): Promise<StoredOpenMuseIdea[]>;
  /**
   * §9 (D08): every owned id, tombstones included — listByOwner is live-only
   * for the API, but the deletion manifest owes the soft-deleted rows too,
   * or the final purge could never remove them.
   */
  listIdsByOwner(ownerUserId: string): Promise<string[]>;
  /**
   * One write: the accept or withdraw state change. `whereStatusIn`, when
   * given, is a precondition IN the statement — a row whose status left the
   * allowed set answers null (missing), so a concurrent state change wins
   * the write instead of being overwritten by a stale decision.
   */
  updateIdea(
    ownerUserId: string,
    id: string,
    patch: Partial<Pick<StoredOpenMuseIdea, "status" | "taskId">> & {
      whereStatusIn?: OpenMuseIdeaStatus[];
    },
  ): Promise<StoredOpenMuseIdea | null>;
  tombstoneIdea(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): hard-delete the owner's rows for the manifest's ids — one
   * statement, so a batch is atomic. Owner-scoped: a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteIdeas(ownerUserId: string, ids: string[]): Promise<void>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
};

/**
 * The tasks store's owner-scoped get, as accept needs it: a row only when
 * the Task exists AND is the owner's, null otherwise. Injected, so the Idea
 * module never imports the Task module (P01's same deferral discipline).
 */
export type OpenMuseTaskGetter = (
  ownerUserId: string,
  taskId: string,
) => Promise<{ id: string } | null>;

/**
 * Accept's answer: `accepted` (idempotent — the same or another owned Task
 * re-points the link, still exactly one), `invalid-task` (400: foreign or
 * missing Task, nothing written), `withdrawn` (409), `missing` (404).
 */
export type AcceptIdeaOutcome =
  | { outcome: "accepted"; idea: StoredOpenMuseIdea }
  | { outcome: "invalid-task" }
  | { outcome: "withdrawn"; idea: StoredOpenMuseIdea }
  | { outcome: "missing" };

export type OpenMuseIdeaStore = {
  create(input: {
    ownerUserId: string;
    title: string;
    reason: string;
    evidence: OpenMuseIdeaEvidence[];
    prompt: string;
    kind: string;
    input: string;
  }): Promise<StoredOpenMuseIdea>;
  list(ownerUserId: string): Promise<StoredOpenMuseIdea[]>;
  get(ownerUserId: string, id: string): Promise<StoredOpenMuseIdea | null>;
  /** The heart of the ticket: an accepted Idea points to one OWNED Task. */
  accept(
    ownerUserId: string,
    id: string,
    taskId: string,
  ): Promise<AcceptIdeaOutcome>;
  /** Withdraw keeps taskId for history — §9 reads Ideas back as history. */
  withdraw(ownerUserId: string, id: string): Promise<StoredOpenMuseIdea | null>;
  delete(ownerUserId: string, id: string): Promise<boolean>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteIdeas`, owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, ids: string[]): Promise<void>;
  /** §9 lifecycle hook: refuse work for a disabled owner. */
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  enumerateOwner(
    ownerUserId: string,
  ): Promise<Array<{ kind: "openmuse-idea"; id: string }>>;
};

function newId(): string {
  return `openmuse-idea-${crypto.randomUUID()}`;
}

export function createOpenMuseIdeaStore(deps: {
  rows: OpenMuseIdeaRows;
  getTask: OpenMuseTaskGetter;
}): OpenMuseIdeaStore {
  const guard = async (ownerUserId: string) => {
    if (await deps.rows.ownerDisabled(ownerUserId))
      throw new OpenMuseOwnerDisabledError(ownerUserId);
  };

  return {
    async create(input) {
      await guard(input.ownerUserId);
      const now = new Date();
      const idea: StoredOpenMuseIdea = {
        id: newId(),
        ownerUserId: input.ownerUserId,
        title: input.title,
        reason: input.reason,
        evidence: input.evidence.map((entry) => ({ ...entry })),
        prompt: input.prompt,
        kind: input.kind,
        input: input.input,
        status: "pending",
        taskId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await deps.rows.insertIdea(idea);
      return idea;
    },
    async list(ownerUserId) {
      await guard(ownerUserId);
      return deps.rows.listByOwner(ownerUserId);
    },
    get: (ownerUserId, id) => deps.rows.findIdea(ownerUserId, id),
    async accept(ownerUserId, id, taskId) {
      await guard(ownerUserId);
      const current = await deps.rows.findIdea(ownerUserId, id);
      if (!current) return { outcome: "missing" } as const;
      if (current.status === "withdrawn")
        return { outcome: "withdrawn", idea: current } as const;
      // The Task must exist AND be the owner's: the owner-scoped get makes a
      // foreign Task indistinguishable from a missing one, so no link can be
      // pointed at another user's Task.
      const task = await deps.getTask(ownerUserId, taskId);
      if (!task) return { outcome: "invalid-task" } as const;
      const idea = await deps.rows.updateIdea(ownerUserId, id, {
        status: "accepted",
        taskId,
        // Only a live pending/accepted Idea may accept: a withdraw that
        // lands between the checks above and this write wins the row, and
        // the zero-row conditional UPDATE answers "missing" instead of
        // resurrecting the withdrawn terminal state.
        whereStatusIn: ["pending", "accepted"],
      });
      return idea === null
        ? ({ outcome: "missing" } as const)
        : ({ outcome: "accepted", idea } as const);
    },
    async withdraw(ownerUserId, id) {
      await guard(ownerUserId);
      const current = await deps.rows.findIdea(ownerUserId, id);
      if (!current) return null;
      // Idempotent by construction: withdrawing twice writes the same state,
      // and the Task link, if any, stays for history.
      return deps.rows.updateIdea(ownerUserId, id, { status: "withdrawn" });
    },
    async delete(ownerUserId, id) {
      await guard(ownerUserId);
      return deps.rows.tombstoneIdea(ownerUserId, id);
    },
    disableOwner: (ownerUserId) => deps.rows.disableOwner(ownerUserId),
    restoreOwner: (ownerUserId) => deps.rows.restoreOwner(ownerUserId),
    hardDelete: (ownerUserId, ids) =>
      deps.rows.hardDeleteIdeas(ownerUserId, ids),
    async enumerateOwner(ownerUserId) {
      // §9 enumeration owes tombstones too: listIdsByOwner ignores deletedAt
      // so the manifest names every row D08 must purge, not only live ones.
      return (await deps.rows.listIdsByOwner(ownerUserId)).map((id) => ({
        kind: "openmuse-idea" as const,
        id,
      }));
    },
  };
}

/** The exact record the private Bot's tool may see — nothing more. */
export type IdeaToolRecord = {
  id: string;
  title: string;
  kind: string;
};

/**
 * The P02 tool seam: a read-only, owner-bound Idea lookup. No runtime tool
 * registry exists yet in this codebase; C07 (observable assistant
 * delegation) ports the runtime and wires this lookup in as the Bot's
 * `idea.read` tool — a foreign owner's id, or a Bot without the owner's
 * grant, simply gets null because the lookup never leaves its owner. A
 * withdrawn Idea no longer answers either: the Bot cites live Ideas only.
 */
export function ideaLookupFor(
  deps: { rows: OpenMuseIdeaRows },
  ownerUserId: string,
): (id: string) => Promise<IdeaToolRecord | null> {
  return async (id) => {
    const idea = await deps.rows.findIdea(ownerUserId, id);
    if (!idea || idea.status === "withdrawn") return null;
    return { id: idea.id, title: idea.title, kind: idea.kind };
  };
}

function rowToIdea(row: typeof openmuseIdeas.$inferSelect): StoredOpenMuseIdea {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    title: row.title,
    reason: row.reason,
    evidence: row.evidence,
    prompt: row.prompt,
    kind: row.kind,
    input: row.input,
    status: row.status,
    taskId: row.taskId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** The drizzle-backed row seam. */
export function createOpenMuseIdeaRows(database: Database): OpenMuseIdeaRows {
  const ownerDisabledRow = createOwnerDisabled(database);
  const live = (ownerUserId: string, id: string) =>
    and(
      eq(openmuseIdeas.ownerUserId, ownerUserId),
      eq(openmuseIdeas.id, id),
      isNull(openmuseIdeas.deletedAt),
    );
  return {
    async insertIdea(idea) {
      await database.insert(openmuseIdeas).values({
        id: idea.id,
        ownerUserId: idea.ownerUserId,
        title: idea.title,
        reason: idea.reason,
        evidence: idea.evidence,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        status: idea.status,
        taskId: idea.taskId,
        createdAt: idea.createdAt,
        updatedAt: idea.updatedAt,
        deletedAt: idea.deletedAt,
      });
    },
    async findIdea(ownerUserId, id) {
      const [row] = await database
        .select()
        .from(openmuseIdeas)
        .where(live(ownerUserId, id))
        .limit(1);
      return row ? rowToIdea(row) : null;
    },
    async listByOwner(ownerUserId) {
      const rows = await database
        .select()
        .from(openmuseIdeas)
        .where(
          and(
            eq(openmuseIdeas.ownerUserId, ownerUserId),
            isNull(openmuseIdeas.deletedAt),
          ),
        )
        .orderBy(desc(openmuseIdeas.createdAt), desc(openmuseIdeas.id));
      return rows.map(rowToIdea);
    },
    async listIdsByOwner(ownerUserId) {
      const rows = await database
        .select({ id: openmuseIdeas.id })
        .from(openmuseIdeas)
        .where(eq(openmuseIdeas.ownerUserId, ownerUserId));
      return rows.map((row) => row.id);
    },
    async updateIdea(ownerUserId, id, patch) {
      const { whereStatusIn, ...sets } = patch;
      const [row] = await database
        .update(openmuseIdeas)
        .set({ ...sets, updatedAt: new Date() })
        .where(
          and(
            live(ownerUserId, id),
            ...(whereStatusIn
              ? [inArray(openmuseIdeas.status, whereStatusIn)]
              : []),
          ),
        )
        .returning();
      return row ? rowToIdea(row) : null;
    },
    async tombstoneIdea(ownerUserId, id) {
      const rows = await database
        .update(openmuseIdeas)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(live(ownerUserId, id))
        .returning({ id: openmuseIdeas.id });
      return rows.length > 0;
    },
    async hardDeleteIdeas(ownerUserId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseIdeas)
        .where(
          and(
            eq(openmuseIdeas.ownerUserId, ownerUserId),
            inArray(openmuseIdeas.id, ids),
          ),
        );
    },
    /*
     * D01's marker is the deleted-owner fence — the same phase-aware read
     * the /api/mobile fence and the tasks rows make: disabled while the
     * marker is still `fenced`, lifted by D05's restore. BOUNDARY RECORDED:
     * the read paths (get / ideaLookupFor) stay unguarded — the HTTP reads
     * sit behind the /api/mobile fence, and the Bot tool seam is reached
     * only through the runner the tasks rows already fence.
     */
    ownerDisabled: ownerDisabledRow,
    async disableOwner() {},
    async restoreOwner() {},
  };
}

/** §7 DTO the client renders; explicit fields, no row internals leak. */
function ideaDto(idea: StoredOpenMuseIdea) {
  return {
    id: idea.id,
    title: idea.title,
    reason: idea.reason,
    evidence: idea.evidence,
    prompt: idea.prompt,
    kind: idea.kind,
    input: idea.input,
    status: idea.status,
    taskId: idea.taskId,
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
  };
}

const evidenceInput = z.strictObject({
  kind: z.string().trim().min(1).max(50),
  ref: z.string().trim().min(1).max(500),
});

const createInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  reason: z.string().max(4_000).default(""),
  evidence: z.array(evidenceInput).max(20).default([]),
  prompt: z.string().max(4_000).default(""),
  // Enum-free by contract, like a Goal's category.
  kind: z.string().trim().max(50).default(""),
  input: z.string().max(50).default(""),
});

const acceptInput = z.strictObject({
  taskId: z.string().trim().min(1).max(200),
});

/**
 * `/openmuse-ideas` (mounted under `/api/mobile` by the app seam): the
 * owner's private Ideas behind the session guard.
 */
export function createOpenMuseIdeasRoutes(deps: {
  store: OpenMuseIdeaStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.post("/", async (context) => {
    const input = createInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json({ error: "A title and evidence are required." }, 400);
    }
    try {
      const idea = await deps.store.create({
        ownerUserId: context.var.actor.id,
        title: input.data.title,
        reason: input.data.reason,
        evidence: input.data.evidence,
        prompt: input.data.prompt,
        kind: input.data.kind,
        input: input.data.input,
      });
      return context.json(ideaDto(idea), 201);
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/", async (context) => {
    try {
      const ideas = await deps.store.list(context.var.actor.id);
      return context.json({ ideas: ideas.map(ideaDto) });
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.get("/:id", async (context) => {
    const idea = await deps.store.get(
      context.var.actor.id,
      context.req.param("id"),
    );
    if (!idea) return context.json({ error: "There is no such Idea." }, 404);
    return context.json(ideaDto(idea));
  });

  routes.post("/:id/accept", async (context) => {
    const input = acceptInput.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) {
      return context.json(
        { error: "A taskId is required to accept an Idea." },
        400,
      );
    }
    try {
      const outcome = await deps.store.accept(
        context.var.actor.id,
        context.req.param("id"),
        input.data.taskId,
      );
      if (outcome.outcome === "missing")
        return context.json({ error: "There is no such Idea." }, 404);
      if (outcome.outcome === "invalid-task")
        return context.json(
          { error: "There is no such Task for this owner." },
          400,
        );
      if (outcome.outcome === "withdrawn")
        return context.json(
          { error: "This Idea was withdrawn and cannot be accepted." },
          409,
        );
      return context.json(ideaDto(outcome.idea));
    } catch (error) {
      if (error instanceof OpenMuseOwnerDisabledError) {
        return context.json({ error: "This account is disabled." }, 403);
      }
      throw error;
    }
  });

  routes.post("/:id/withdraw", async (context) => {
    try {
      const idea = await deps.store.withdraw(
        context.var.actor.id,
        context.req.param("id"),
      );
      if (!idea) return context.json({ error: "There is no such Idea." }, 404);
      return context.json(ideaDto(idea));
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
        return context.json({ error: "There is no such Idea." }, 404);
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
