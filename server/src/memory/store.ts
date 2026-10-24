import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import { memorySources, personalMemories } from "../db/schema/memory";
import { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
import {
  CREDENTIAL_REFUSAL,
  classifyMemorySensitivity,
  SENSITIVE_OBSERVATION_REFUSAL,
} from "./sensitivity";
import {
  type FormedMemoryInput,
  formedMemorySchema,
  type ImportedMemory,
  LEARNING_PAUSED_REFUSAL,
  MemoryNotFoundError,
  type MemoryRecord,
  MemoryRefusedError,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

const log = getLogger("server");

/** How long an unhandled candidate waits for its person before it is expired. */
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A person's memory: OpenBot's own tables, and nothing else.
 *
 * The CopilotKit Intelligence personal-memory path is gone (Hindsight 18 / #395): the tables are
 * the whole store, and the indexed, cross-session recall that path fed now runs over the
 * Hindsight chain (../hindsight/preference-recall.ts, ../hindsight/scoped-recall.ts) with
 * OpenBot rows as the only content authority — confirmed content reached it through the #394
 * migration. A memory only Intelligence ever held is not read, listed, migrated or exported
 * here: the person accepted dropping it when the exit was decided, and this store no longer
 * has a way to ask for it.
 *
 * Every rule a Bot's recall obeys still lives in the rows themselves — where a memory came
 * from, whether it is reviewed or paused, which Bot formed it and which source it was imported
 * from — so the exit changes only whose copy is read, never who may see what.
 */
export function createMemoryStore(
  database: Database,
  options: {
    /**
     * Hindsight 14 (#392): the person's pause-learning switch, read live at the two
     * candidate-generation entries this store owns — a Bot's observation (`formMemory`) and a
     * connector import (`completeSync`). Paused means neither produces a new candidate; nothing
     * already stored is deleted, hidden or confirmed, and the person's own explicit remember
     * (`create`) is not this switch's business.
     */
    learningPaused?: (ownerUserId: string) => Promise<boolean>;
  } = {},
) {
  const getSource = async (ownerUserId: string, id: string) => {
    const [row] = await database
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.id, id),
          eq(memorySources.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new MemoryNotFoundError();
    return row;
  };

  /**
   * The rows a Bot may recall, every filter in the query. Bot-formed memories go only to the Bot that
   * formed them, and only while it still holds their source app; imported ones only through a source
   * this Bot may use; the person's own to every Bot of theirs.
   */
  function eligibleRows(
    ownerUserId: string,
    eligibleSourceIds: string[],
    formed: { botId: string; heldServerIds: ReadonlySet<string> } | undefined,
    narrow: { term?: string },
  ) {
    const held = [...(formed?.heldServerIds ?? [])];
    const formedByThisBot = formed
      ? and(
          eq(personalMemories.formedBy, "bot"),
          eq(personalMemories.formedByAgentId, formed.botId),
          or(
            isNull(personalMemories.sourceRef),
            held.length > 0
              ? inArray(
                  sql<string>`split_part(${personalMemories.sourceRef}, '/', 1)`,
                  held,
                )
              : sql`false`,
          ),
        )
      : undefined;
    const personOrSource = and(
      sql`${personalMemories.formedBy} <> 'bot'`,
      or(
        isNull(personalMemories.sourceId),
        eligibleSourceIds.length > 0
          ? inArray(personalMemories.sourceId, eligibleSourceIds)
          : sql`false`,
      ),
    );
    return database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, ownerUserId),
          eq(personalMemories.enabled, true),
          isNull(personalMemories.deletedAt),
          // A candidate waits for the person's review on every Bot-side path: only a confirmed or
          // edited memory may cross into a Bot's context. The person's own list reads the rows
          // without this filter.
          inArray(personalMemories.reviewState, ["confirmed", "edited"]),
          formedByThisBot
            ? or(formedByThisBot, personOrSource)
            : personOrSource,
          narrow.term
            ? sql`strpos(lower(${personalMemories.content}), lower(${narrow.term})) > 0`
            : undefined,
        ),
      )
      .orderBy(desc(personalMemories.updatedAt))
      .limit(40);
  }

  return {
    async list(ownerUserId: string): Promise<MemoryRecord[]> {
      const rows = await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
      return rows;
    },
    async create(ownerUserId: string, input: unknown) {
      const parsed = parseMemoryInput(input);
      // A credential is refused even when the person asks for it outright. A sensitive fact the
      // person did ask for is stored — as a candidate, shown to them with its content and source
      // for one more confirmation, not as a memory Bots may already recall.
      const sensitivity = classifyMemorySensitivity(parsed.content);
      if (sensitivity === "credential")
        throw new MemoryRefusedError(CREDENTIAL_REFUSAL);
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parsed,
          reviewState: sensitivity === "normal" ? "confirmed" : "unreviewed",
        })
        .returning();
      if (!row) throw new Error("Memory insert returned no row.");
      return row;
    },
    /**
     * A memory a Bot formed from something it observed, awaiting the person's review.
     *
     * Deduplicated on content, deleted rows included: a memory the person forgot stays forgotten
     * even when the Bot reads the same record again tomorrow. It reaches a Bot only once the
     * person accepts it.
     */
    async formMemory(ownerUserId: string, input: FormedMemoryInput) {
      const parsed = formedMemorySchema.safeParse({
        content: input.content,
        sourceApp: input.sourceApp,
        ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      });
      if (!parsed.success)
        throw new MemoryRefusedError(
          parsed.error.issues[0]?.message ?? "Invalid memory.",
        );
      // Pause-learning (#392): the switch stops the automatic candidate here, before anything
      // of the observation is read further — the refusal is the person's own decision, said
      // plainly, and it changes nothing that already exists.
      if (options.learningPaused && (await options.learningPaused(ownerUserId)))
        throw new MemoryRefusedError(LEARNING_PAUSED_REFUSAL);
      // Nothing a Bot observed becomes sensitive material, whatever it read: the person never
      // asked for this, and a candidate is already more exposure than a refusal. Credentials go
      // the same way, so none of it is written, even as a candidate awaiting review.
      const sensitivity = classifyMemorySensitivity(parsed.data.content);
      if (sensitivity !== "normal")
        throw new MemoryRefusedError(
          sensitivity === "credential"
            ? CREDENTIAL_REFUSAL
            : SENSITIVE_OBSERVATION_REFUSAL,
        );
      const digest = createHash("sha256")
        .update(parsed.data.content.toLocaleLowerCase())
        .digest("hex");
      const [existing] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.importDigest, digest),
          ),
        )
        .limit(1);
      if (existing)
        return {
          id: existing.id,
          duplicate: true,
          forgotten: !!existing.deletedAt,
        };
      const observedAt = parsed.data.observedAt ?? new Date();
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          content: parsed.data.content,
          provenance:
            `${parsed.data.sourceApp}${parsed.data.sourceLink ? ` (${parsed.data.sourceLink})` : ""}, observed ${observedAt.toISOString()}`.slice(
              0,
              500,
            ),
          reviewState: "unreviewed",
          formedBy: "bot",
          formedByAgentId: input.agentId,
          sourceApp: parsed.data.sourceApp,
          sourceRef: input.sourceRef ?? null,
          sourceLink: parsed.data.sourceLink ?? null,
          observedAt,
          importDigest: digest,
        })
        .onConflictDoNothing({
          target: [personalMemories.ownerUserId, personalMemories.importDigest],
          where: sql`${personalMemories.formedBy} = 'bot'`,
        })
        .returning({ id: personalMemories.id });
      if (row) return { id: row.id, duplicate: false, forgotten: false };
      // Formed by a concurrent run between the check above and this insert.
      const [raced] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.importDigest, digest),
          ),
        )
        .limit(1);
      if (!raced) throw new Error("Memory insert returned no row.");
      return { id: raced.id, duplicate: true, forgotten: !!raced.deletedAt };
    },
    async update(
      ownerUserId: string,
      id: string,
      input: unknown,
    ): Promise<MemoryRecord> {
      const patch = parseMemoryPatch(input);
      // An edit may not walk a credential in through the back door; the memory keeps its content.
      // Content edited into a sensitive class re-enters review exactly as create() would have
      // stored it: the person confirms once more before any Bot may recall it again.
      const sensitivity = patch.content
        ? classifyMemorySensitivity(patch.content)
        : "normal";
      if (sensitivity === "credential")
        throw new MemoryRefusedError(CREDENTIAL_REFUSAL);
      const [row] = await database
        .update(personalMemories)
        .set({
          ...patch,
          // A sensitive edit returns the row to the candidate pool, so recall loses it until the
          // person confirms once more; any other edit is already reviewed by having made it.
          ...(patch.content
            ? {
                reviewState:
                  sensitivity === "normal"
                    ? ("edited" as const)
                    : ("unreviewed" as const),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async remove(ownerUserId: string, id: string) {
      // Imported tombstones prevent the next sync from resurrecting a fact the person deleted.
      const [row] = await database
        .update(personalMemories)
        .set({
          deletedAt: new Date(),
          enabled: false,
          content: "",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning({ id: personalMemories.id });
      if (!row) throw new MemoryNotFoundError();
    },
    /**
     * Expire candidates nobody handled for 30 days: tombstoned the way a forgotten memory is
     * (content cleared, disabled, invisible), so the person's list stops offering them and a
     * later read of the same record cannot resurrect them. A confirmed or edited memory is never
     * touched however long it sits; a deleted row is already gone. Idempotent: an expired row has
     * a `deletedAt`, which no later run matches, so scheduling this as often as desired is safe.
     */
    async expireStaleCandidates(now = new Date()) {
      const expired = await database
        .update(personalMemories)
        .set({
          deletedAt: now,
          enabled: false,
          content: "",
          updatedAt: now,
        })
        .where(
          and(
            eq(personalMemories.reviewState, "unreviewed"),
            isNull(personalMemories.deletedAt),
            lt(
              personalMemories.updatedAt,
              new Date(now.getTime() - CANDIDATE_TTL_MS),
            ),
          ),
        )
        .returning({ id: personalMemories.id });
      return expired.length;
    },
    async sources(ownerUserId: string) {
      return database
        .select()
        .from(memorySources)
        .where(eq(memorySources.ownerUserId, ownerUserId))
        .orderBy(desc(memorySources.createdAt));
    },
    getSource,
    async createSource(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(memorySources)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemorySourceInput(input),
        })
        .returning();
      if (!row) throw new Error("Memory source insert returned no row.");
      return row;
    },
    async setSourceEnabled(ownerUserId: string, id: string, enabled: boolean) {
      const [row] = await database
        .update(memorySources)
        .set({ enabled, nextSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async removeSource(ownerUserId: string, id: string) {
      // The source's memories cascade with it.
      const [source] = await database
        .select({ agentId: memorySources.agentId })
        .from(memorySources)
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .limit(1);
      if (!source) throw new MemoryNotFoundError();
      // Removing a source is turning that app down for this Bot: OpenBot never adds it back.
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, ownerUserId, source.agentId);
        const [row] = await transaction
          .delete(memorySources)
          .where(
            and(
              eq(memorySources.id, id),
              eq(memorySources.ownerUserId, ownerUserId),
            ),
          )
          .returning({ toolRef: memorySources.toolRef });
        if (!row) throw new MemoryNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId,
          agentId: source.agentId,
          feature: "memory_source",
          scope: sourceServerId(row.toolRef),
        });
      });
    },
    async dueSources(limit = 5) {
      return database
        .select()
        .from(memorySources)
        .where(
          and(
            eq(memorySources.enabled, true),
            lte(memorySources.nextSyncAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
    },
    async claimSync(ownerUserId: string, id: string) {
      const now = new Date();
      const [row] = await database
        .update(memorySources)
        .set({
          syncStatus: "running",
          nextSyncAt: new Date(now.getTime() + 120_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
            eq(memorySources.enabled, true),
            or(
              sql`${memorySources.syncStatus} <> 'running'`,
              lte(memorySources.nextSyncAt, now),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },
    async failSync(ownerUserId: string, id: string, error: string) {
      await database
        .update(memorySources)
        .set({
          syncStatus: "error",
          syncError: error.slice(0, 500),
          nextSyncAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        );
    },
    async completeSync(
      ownerUserId: string,
      sourceId: string,
      records: ImportedMemory[],
    ) {
      // Pause-learning (#392): read before the transaction, so the gate never asks for a
      // second connection while the row lock is held. Paused means the import produces no
      // candidate — the sync still completes (the connector was read, and the source's health
      // is bookkeeping), but no row is written and nothing already imported changes.
      const learningPaused = options.learningPaused
        ? await options.learningPaused(ownerUserId)
        : false;
      await database.transaction(async (transaction) => {
        const [source] = await transaction
          .select()
          .from(memorySources)
          .where(
            and(
              eq(memorySources.id, sourceId),
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.enabled, true),
            ),
          )
          .for("update");
        if (!source) throw new MemoryNotFoundError();
        // Inner layer of the two-layer sensitivity defense. The normal flow never gets here
        // with sensitive material: ingestion filters before calling, and its
        // memory-sync-sensitive-dropped count is the ONLY signal a healthy flow should ever
        // produce. completeSync is still a public store method a caller can reach without that
        // pre-filter (tests do), so the gate is repeated here — and because an inner hit means
        // the upstream defense was bypassed, it says so at error level, with a count only,
        // never content.
        let droppedSensitiveInner = 0;
        for (const record of learningPaused ? [] : records) {
          // A sync may not write sensitive material even as a candidate: it was read, not asked
          // for. Dropped whole, so nothing of it reaches the person's candidates or any index.
          if (classifyMemorySensitivity(record.content) !== "normal") {
            droppedSensitiveInner += 1;
            continue;
          }
          await transaction
            .insert(personalMemories)
            .values({
              id: randomUUID(),
              ownerUserId,
              sourceId,
              externalId: record.externalId,
              importDigest: record.digest,
              content: record.content,
              provenance: `${source.title}: ${record.provenance}`,
              formedBy: "import",
              sourceApp: source.title,
              sourceRef: source.toolRef,
              observedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [personalMemories.sourceId, personalMemories.externalId],
              set: {
                content: sql`CASE WHEN ${personalMemories.reviewState} = 'edited' OR ${personalMemories.deletedAt} IS NOT NULL THEN ${personalMemories.content} ELSE ${record.content} END`,
                provenance: `${source.title}: ${record.provenance}`,
                importDigest: record.digest,
                updatedAt: new Date(),
              },
              setWhere: sql`${personalMemories.importDigest} IS DISTINCT FROM ${record.digest}`,
            });
        }
        if (droppedSensitiveInner > 0)
          log.error(
            {
              type: "memory-sync-sensitive-dropped-inner",
              context: { sourceId, droppedSensitiveInner },
              timestamp: new Date().toISOString(),
            },
            "memory-sync-sensitive-dropped-inner",
          );
        if (learningPaused && records.length > 0)
          log.info(
            {
              type: "memory-sync-learning-paused",
              context: { sourceId, skipped: records.length },
              timestamp: new Date().toISOString(),
            },
            "memory-sync-learning-paused",
          );
        await transaction
          .update(memorySources)
          .set({
            syncStatus: "succeeded",
            syncError: null,
            lastSyncAt: new Date(),
            nextSyncAt: new Date(Date.now() + 900_000),
            updatedAt: new Date(),
          })
          .where(eq(memorySources.id, sourceId));
      });
    },
    async retrieve(
      ownerUserId: string,
      eligibleSourceIds: string[],
      search = "",
      /**
       * The Bot asking and the app servers it currently holds. Bot-formed memories are returned
       * only to the Bot that formed them, and only while it still holds their source app; without
       * this argument none are returned.
       */
      formed?: { botId: string; heldServerIds: ReadonlySet<string> },
    ): Promise<MemoryRecord[]> {
      /*
       * The rows, filtered by every rule recall obeys, with a substring match standing in for
       * ranking: the same honest text-match the Hindsight chain's degraded path uses (#385),
       * because there is no semantic index behind this store anymore. The indexed, cross-session
       * recall now runs over the Hindsight chain (preference-recall.ts, scoped-recall.ts), where
       * OpenBot rows stay the only content authority.
       */
      return eligibleRows(ownerUserId, eligibleSourceIds, formed, {
        term: search.trim(),
      });
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
