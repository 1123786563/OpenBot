import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { openmuseReviewedActions, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * R04's "never send the same thing twice" is durable only at the row level:
 * the service's gate is a read, the insert is the write, and no lock spans
 * both, so the partial unique index on openmuse_reviewed_actions is what
 * actually serializes two racing proposes. Against a real database because
 * an index's key shape — target_id included or not — is invisible to the
 * in-memory fake the unit suite runs on.
 *
 * The gate keys on (owner, kind, payloadHash, targetId) since the
 * target-bound kinds: a delete's payload is only {calendarId}, so every
 * delete on one calendar hashes alike and two DIFFERENT events' deletes are
 * two logical sends. The index must agree with that key, or the second
 * delete's proposal dies on the database after the service already said yes.
 */

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

const OWNER = "reviewed-actions-idx-test-owner";
const HASH = "a".repeat(64);

async function seed(): Promise<void> {
  await database
    .insert(users)
    .values({ id: OWNER, email: "reviewed-actions-idx@example.test" })
    .onConflictDoNothing();
}

async function insert(
  id: string,
  overrides: { targetId?: string | null; status?: string },
): Promise<unknown> {
  return database
    .insert(openmuseReviewedActions)
    .values({
      id,
      ownerUserId: OWNER,
      kind: "gcalendar.delete",
      canonicalPayload: { calendarId: "calendar-1" },
      payloadHash: HASH,
      accountEmail: "owner@example.test",
      connectionGeneration: 1,
      targetId: overrides.targetId ?? null,
      status: overrides.status ?? "awaiting_review",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: openmuseReviewedActions.id });
}

async function cleanup(): Promise<void> {
  await database
    .delete(openmuseReviewedActions)
    .where(eq(openmuseReviewedActions.ownerUserId, OWNER));
  await database.delete(users).where(eq(users.id, OWNER));
}

/**
 * Drizzle wraps the driver's refusal in a DrizzleQueryError whose message is
 * only "Failed query: ...", so the duplicate-key sentence lives in the cause
 * chain — walk it, the way the service's own catch does.
 */
async function refusesOnUniqueIndex(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    for (
      let cause: unknown = error;
      cause !== undefined && cause !== null;
      cause = (cause as { cause?: unknown }).cause
    ) {
      const text = `${(cause as Error).message ?? ""} ${(cause as { constraint?: string }).constraint ?? ""}`;
      if (/openmuse_reviewed_actions_active_send_uq/.test(text)) return;
    }
    throw new Error(`refused, but not by the active-send index: ${error}`);
  }
  throw new Error("the insert landed, so the index did not refuse it");
}

describe("openmuse_reviewed_actions_active_send_uq", () => {
  test("two live rows with the same hash and DIFFERENT targets coexist", async () => {
    await cleanup();
    await seed();
    try {
      // Two events' deletes on one calendar: the payload (and so the hash) is
      // identical, the targets are not — the index must key the target in.
      await insert("idx-live-a", { targetId: "event-1" });
      const second = await insert("idx-live-b", { targetId: "event-2" });
      expect((second as Array<{ id: string }>).length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("two live rows with the same hash and target are refused (23505)", async () => {
    await cleanup();
    await seed();
    try {
      await insert("idx-same-a", { targetId: "event-1" });
      await refusesOnUniqueIndex(insert("idx-same-b", { targetId: "event-1" }));
    } finally {
      await cleanup();
    }
  });

  test("two live payload-bound rows (null target) with the same hash are refused", async () => {
    await cleanup();
    await seed();
    try {
      // coalesce(target_id, '') keeps the mail kinds protected: a null target
      // must not exempt a duplicate from the index.
      await insert("idx-null-a", { targetId: null });
      await refusesOnUniqueIndex(insert("idx-null-b", { targetId: null }));
    } finally {
      await cleanup();
    }
  });

  test("a settled row falls out of the index, so the same key may propose again", async () => {
    await cleanup();
    await seed();
    try {
      await insert("idx-settled", { targetId: "event-1", status: "denied" });
      const again = await insert("idx-fresh", { targetId: "event-1" });
      expect((again as Array<{ id: string }>).length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
