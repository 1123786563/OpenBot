import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  hindsightMemoryProjections,
  personalMemories,
  users,
} from "../src/db/schema";
import { createMemoryStore } from "../src/memory/store";
import { replayIntelligenceDeletions } from "../src/recovery/replay-intelligence-deletions";
import {
  TEST_POOL,
  testDatabaseUrl,
  testDatabaseUrlFrom,
} from "./support/database";

const restoredUrl = process.env.TEST_INTELLIGENCE_RESTORED_DATABASE_URL;

test.skipIf(!restoredUrl)(
  "restore withdraws a Memory whose projection locator survived its source cascade",
  async () => {
    const authorityUrl = testDatabaseUrl();
    const targetUrl = testDatabaseUrlFrom({ TEST_DATABASE_URL: restoredUrl });
    if (new URL(authorityUrl).href === new URL(targetUrl).href)
      throw new Error(
        "Recovery verification requires two distinct test databases",
      );

    const authority = createDatabase(authorityUrl, TEST_POOL);
    const restored = createDatabase(targetUrl, TEST_POOL);
    const owner = crypto.randomUUID();
    const neighbor = crypto.randomUUID();
    const id = crypto.randomUUID();
    const content = "A restored synthetic Memory from a removed source.";
    const deletedDocuments = new Set<string>();
    const hindsight = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method !== "DELETE")
          return new Response(null, { status: 405 });
        const path = new URL(request.url).pathname;
        deletedDocuments.add(path.slice(path.lastIndexOf("/") + 1));
        return Response.json({ success: true });
      },
    });
    try {
      await restored.insert(users).values([
        { id: owner, email: `${owner}@example.test` },
        { id: neighbor, email: `${neighbor}@example.test` },
      ]);
      const store = createMemoryStore(restored);
      await restored.insert(personalMemories).values({
        id,
        ownerUserId: owner,
        content,
        provenance: "Synthetic source",
        reviewState: "confirmed",
      });
      const kept = await store.create(neighbor, { content });
      expect(await store.list(owner)).toContainEqual(
        expect.objectContaining({ id, content }),
      );

      // A source, Bot, or owner cascade removes the Memory and leaves its projection locator.
      await authority.insert(hindsightMemoryProjections).values({
        memoryId: id,
        ownerUserId: owner,
        cleanupCompletedAt: new Date(),
      });
      const target = { authority, restored, hindsight: { url: hindsight.url } };
      for (let attempt = 0; attempt < 2; attempt++) {
        await replayIntelligenceDeletions(target);
        expect(await store.list(owner)).toEqual([]);
        expect(await store.list(neighbor)).toContainEqual(
          expect.objectContaining({ id: kept.id, content }),
        );
      }
      expect(deletedDocuments.has(id)).toBe(true);
    } finally {
      hindsight.stop(true);
      await authority
        .delete(hindsightMemoryProjections)
        .where(eq(hindsightMemoryProjections.memoryId, id));
      await restored
        .delete(hindsightMemoryProjections)
        .where(eq(hindsightMemoryProjections.memoryId, id));
      await restored.delete(users).where(inArray(users.id, [owner, neighbor]));
      await Promise.all([authority.$client.close(), restored.$client.close()]);
    }
  },
);
