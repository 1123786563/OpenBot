/* Hindsight 18 (#395): the Intelligence personal-memory path exits. The mirroring link columns
 * existed only for the store's mirror passes; nothing reads them once those passes are gone, and
 * a rollback to the mirroring code backfills every row again on its own (a row without an
 * Intelligence id is exactly what its next pass picks up), so the link is dropped, not archived. */
ALTER TABLE "personal_memories" DROP COLUMN "intelligence_memory_id";--> statement-breakpoint
ALTER TABLE "personal_memories" DROP COLUMN "intelligence_digest";
