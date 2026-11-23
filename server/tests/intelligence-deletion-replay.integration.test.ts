import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  hindsightMemoryProjections,
  opikEvaluationGrants,
  opikEvaluations,
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

test.skipIf(!restoredUrl)(
  "a restored authority remembers revoked Opik traces newer than its backup",
  async () => {
    const authorityUrl = testDatabaseUrl();
    const targetUrl = testDatabaseUrlFrom({ TEST_DATABASE_URL: restoredUrl });
    if (new URL(authorityUrl).href === new URL(targetUrl).href)
      throw new Error(
        "Recovery verification requires two distinct test databases",
      );

    const authority = createDatabase(authorityUrl, TEST_POOL);
    const restored = createDatabase(targetUrl, TEST_POOL);
    const grantId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    let tracePresent = true;
    const opikServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== `/v1/private/traces/${traceId}`)
          return new Response(null, { status: 400 });
        if (request.method === "DELETE") {
          tracePresent = false;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: tracePresent ? 200 : 404 });
      },
    });
    const opik = { apiUrl: opikServer.url, project: "restore-real" };
    const traceUrl = new URL(`v1/private/traces/${traceId}`, opik.apiUrl);
    try {
      await authority.insert(opikEvaluationGrants).values({
        id: grantId,
        memoryId: crypto.randomUUID(),
        ownerId: crypto.randomUUID(),
        contentSha256: "a".repeat(64),
        purpose: "normalization-fidelity",
        revokedAt: new Date(),
      });
      await authority.insert(opikEvaluations).values({
        id: traceId,
        requestId: grantId,
        operatorId: "restore-test-operator",
        project: opik.project,
        kind: "real",
        target: opik.apiUrl.href,
        cases: 1,
        status: "completed",
        cleanupCompletedAt: new Date(),
      });

      expect((await fetch(traceUrl)).status).toBe(200);
      await replayIntelligenceDeletions({ authority, restored, opik });
      expect((await fetch(traceUrl)).status).toBe(404);

      // An Opik backup can contain the sample even after an earlier replay cleared it.
      tracePresent = true;
      expect((await fetch(traceUrl)).status).toBe(200);
      await replayIntelligenceDeletions({
        authority: restored,
        restored: authority,
        opik,
      });
      expect((await fetch(traceUrl)).status).toBe(404);
    } finally {
      opikServer.stop(true);
      for (const database of [authority, restored]) {
        await database
          .delete(opikEvaluations)
          .where(eq(opikEvaluations.id, traceId));
        await database
          .delete(opikEvaluationGrants)
          .where(eq(opikEvaluationGrants.id, grantId));
        await database.$client.close();
      }
    }
  },
);
