import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { codeRuns } from "../src/db/schema/code-runs";
import { createCodeRunStore, newCodeRunId } from "../src/codesandbox/store";

describe("newCodeRunId", () => {
  test("ids are prefixed, fixed-length hex", () => {
    const id = newCodeRunId();
    expect(id).toMatch(/^cr-[0-9a-f]{24}$/);
    expect(newCodeRunId()).not.toBe(id);
  });
});

/*
 * code_runs against a real PostgreSQL, gated on TEST_DATABASE_URL the way the payment and billing
 * integration suites are. The table is created by applying the generated 0062 migration to the
 * test database out of band — exactly the assumption those suites make about their own tables.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("code run store", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const store = createCodeRunStore(database);
  const prefix = `cr-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await database.delete(codeRuns).where(like(codeRuns.id, `${prefix}%`));
    await database.$client.close();
  });

  test("create, finish, and read back one run", async () => {
    const id = `${prefix}-${randomUUID().slice(0, 8)}`;
    await store.create({
      id,
      botId: "bot-x",
      ownerUserId: "user-x",
      task: "把 out.csv 汇总成一段结论",
      model: "GLM-5.3",
    });
    await store.finish(id, {
      status: "completed",
      sessionId: "ses_1",
      inputTokens: 100,
      outputTokens: 20,
      artifactPaths: JSON.stringify(["out.csv"]),
    });
    const row = await store.get(id);
    expect(row?.status).toBe("completed");
    expect(row?.inputTokens).toBe(100);
    expect(row?.finishedAt).not.toBeNull();
  });

  test("finish with a failure records the error text", async () => {
    const id = `${prefix}-${randomUUID().slice(0, 8)}`;
    await store.create({ id, botId: "bot-x", ownerUserId: "user-x", task: "t", model: "GLM-5.3" });
    await store.finish(id, { status: "timeout", error: "exceeded 120000ms" });
    const row = await store.get(id);
    expect(row?.status).toBe("timeout");
    expect(row?.error).toBe("exceeded 120000ms");
  });
});
