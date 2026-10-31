import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { createBotReset } from "../src/agents/lifecycle-reset";
import type { AppVariables } from "../src/auth/public";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  memorySources,
  personalMemories,
  routines,
  users,
} from "../src/db/schema";
import type { HindsightRouteServices } from "../src/hindsight/ops-routes";
import { createHindsightRoutes } from "../src/hindsight/ops-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * #732 旧记忆路径退出。行为断言三组：
 *   1) /api/hindsight 家族只剩证据 seam（巡检可读，旧引擎写入口不存在）；
 *   2) Bot reset 不再删除旧记忆数据，非记忆生命周期职责照常；
 *   3) 旧 seam 模块不再可装载（结构性伴随断言，行为证据在同载入器/降级套件）。
 */

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  _c,
  next,
) => next();

function stubServices(): HindsightRouteServices {
  return {
    // The trusted identity: the test resolves one scope the stub ignores.
    scopes: {
      resolve: async () => ({ kind: "general" }),
    } as unknown as HindsightRouteServices["scopes"],
    evidence: {
      // The evidence seam's real contract: rows by id, availability re-decided per row.
      inspectEvidence: async (_scope, input: { ids: readonly string[] }) =>
        input.ids.map((id) => ({
          id,
          kind: "preference" as const,
          available: true,
          content: `evidence-${id}`,
        })),
    },
  };
}

function hindsightApp() {
  const app = new Hono();
  app.route(
    "/api/hindsight",
    createHindsightRoutes({ ...stubServices(), requireUser }),
  );
  return app;
}

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`https://openbot.example${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );

describe("#732 hindsight family keeps only the evidence seam", () => {
  test("evidence inspection stays: the chat answer basis keeps its read path", async () => {
    const response = await call(
      hindsightApp(),
      "POST",
      "/api/hindsight/evidence",
      { ids: ["e-1"] },
    );
    // The one read that stays answers 200; the old family's members answer 404 below.
    expect(response.status).toBe(200);
  });

  test("old engine surfaces are gone: memories, judgments, revocations, cleanup, restores, ops", async () => {
    const app = hindsightApp();
    const gone: [string, string][] = [
      ["GET", "/api/hindsight/memories"],
      ["GET", "/api/hindsight/judgments/candidates"],
      ["GET", "/api/hindsight/judgments/adopted"],
      ["POST", "/api/hindsight/revocations"],
      ["GET", "/api/hindsight/cleanup"],
      ["POST", "/api/hindsight/ops/restores"],
      ["GET", "/api/hindsight/ops/health"],
      ["POST", "/api/hindsight/evidence/e-1/correction"],
    ];
    for (const [method, path] of gone) {
      expect(await (await call(app, method, path)).status).toBe(404);
    }
  });
});

describe("#732 legacy seams are not loadable", () => {
  test("copilot has no legacy personal-memory seam, only the memory-service seam", async () => {
    const copilot = await import("../src/copilot");
    const exports = Object.keys(copilot);
    expect(exports).not.toContain("setMastraPersonalMemoryContext");
    expect(exports).toContain("setMastraMemoryContext");
  });

  test("the old local memory store module is deleted, not merely unwired", async () => {
    await expect(import("../src/memory/store")).rejects.toBeTruthy();
  });
});

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `nolegacy-${randomUUID()}`;
const owner = `${prefix}-owner`;

describe("#732 reset keeps old memory data and other lifecycle duties", () => {
  beforeAll(async () => {
    await database
      .insert(users)
      .values([{ id: owner, email: `${owner}@example.test` }]);
    await database.insert(agents).values({
      id: `${prefix}-bot`,
      name: "No-Legacy Bot",
      type: "built_in",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: `${prefix}-bot`,
      ownerUserId: owner,
      title: `${prefix}-bot`,
      roleDescription: "Test",
      avatarSeed: `${prefix}-bot`,
      visibility: "public",
    });
    await database.insert(memorySources).values({
      id: `${prefix}-source`,
      ownerUserId: owner,
      agentId: `${prefix}-bot`,
      toolRef: "gmail/list",
      title: "Fixture source",
    });
    await database.insert(personalMemories).values({
      id: `${prefix}-memory`,
      ownerUserId: owner,
      sourceId: `${prefix}-source`,
      content: "旧记忆数据在切换后必须原样保留",
      provenance: "Fixture",
      reviewState: "confirmed",
    });
    await database.insert(routines).values({
      id: `${prefix}-routine`,
      ownerUserId: owner,
      agentId: `${prefix}-bot`,
      channelId: `${prefix}-channel`,
      instruction: "test",
      cron: "0 * * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database
      .delete(personalMemories)
      .where(eq(personalMemories.ownerUserId, owner));
    await database
      .delete(memorySources)
      .where(eq(memorySources.ownerUserId, owner));
    await database.delete(routines).where(eq(routines.ownerUserId, owner));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.ownerUserId, owner));
    await database.delete(agents).where(eq(agents.id, `${prefix}-bot`));
    await database.delete(users).where(eq(users.id, owner));
    await database.$client.end();
  });

  test("reset executes and reports zero memory deletions, keeping every old row", async () => {
    const reset = createBotReset({
      database,
      softDeleteChannel: async () => {},
    });
    const plan = await reset.plan(owner, `${prefix}-bot`);
    expect(plan).toMatchObject({ memorySources: 0, memories: 0, routines: 1 });

    await reset.execute({ id: owner, role: "user" }, `${prefix}-bot`);

    const sources = await database
      .select()
      .from(memorySources)
      .where(eq(memorySources.ownerUserId, owner));
    const memories = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.ownerUserId, owner));
    expect(sources).toHaveLength(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("旧记忆数据在切换后必须原样保留");
    // 非记忆职责照常：routines 已被 reset 清掉。
    const left = await database
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.ownerUserId, owner),
          eq(routines.agentId, `${prefix}-bot`),
        ),
      );
    expect(left).toHaveLength(0);
  });
});
