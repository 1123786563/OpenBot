import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseBudgetReservations,
  enterpriseMemberships,
  enterpriseModelGrants,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseResources,
  enterpriseRunReleases,
  enterpriseRuns,
  enterpriseTenants,
  enterpriseThreads,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import type { Scope, Tx } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { resolveRouteInTx } from "../../../src/enterprise/models/catalog";
import {
  createStaticTargetRegistry,
  ModelRouteSchema,
} from "../../../src/enterprise/models/contracts";
import { assertModelUseInTx } from "../../../src/enterprise/models/policy";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E4-A 路由目录（03 分册 §8.1 验收清单的真实库半场）。
 *
 * resolveRouteInTx 在创建 Run 的事务内把业务 model_alias 解析为唯一批准的
 * route revision：每租户每别名只有一个 active 默认版本（0060 的部分唯一索引），
 * 解析结果经部署 registry 核对目标引用后返回严格 ModelRoute。Run 保存固定
 * route_id——默认切换只影响新解析，历史 Run 不跟随（§4.1）。
 *
 * 查询运行在受限登录（ob_ent_runtime_writer，租户钉死的 SELECT 授权）的事务里，
 * 与 02 册 rls/schema 测试同一纪律：迁移 owner 连接只负责种受控 fixture，
 * 断言都在受限登录上取证。所有 fixture id 硬编码（r4a- 前缀），本文件没有
 * 任何动态 SQL：语句是编译期字面量，外部值一律经绑定参数传递。
 */

const TENANT_A = "r4a-tenant-a";
const TENANT_B = "r4a-tenant-b";
const USER_A = "r4a-user-a";
const USER_B = "r4a-user-b";
const PRINCIPAL_A = "r4a-principal-a";
const PRINCIPAL_B = "r4a-principal-b";
const WORKSPACE_A = "r4a-workspace-a";
const WORKSPACE_B = "r4a-workspace-b";
const RESOURCE_A = "r4a-resource-a";
const RESOURCE_B = "r4a-resource-b";
const THREAD_A = "r4a-thread-a";
const RELEASE_A = "r4a-release-a";
const ROUTE_A1 = "r4a-route-a1";
const ROUTE_A2 = "r4a-route-a2";
const ROUTE_A3 = "r4a-route-a3";
const ROUTE_A4 = "r4a-route-a4";
const ROUTE_A6 = "r4a-route-a6";
const ROUTE_B1 = "r4a-route-b1";
const RUN_A = "r4a-run-a";
const RESERVATION_A = "r4a-reservation-a";

const scopeA: Scope = Object.freeze({
  tenantId: TENANT_A,
  principalId: PRINCIPAL_A,
  userId: USER_A,
  role: "member",
  epoch: 1,
});
const scopeB: Scope = Object.freeze({
  tenantId: TENANT_B,
  principalId: PRINCIPAL_B,
  userId: USER_B,
  role: "member",
  epoch: 1,
});

const registry = createStaticTargetRegistry([
  "higress/openai-main",
  "higress/openai-alt",
]);

const SET_TENANT_CONTEXT_TEXT = "select set_config('app.tenant_id', $1, true)";

type PgError = { code: string; status: number };

async function rejectionOf(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return { code: error.code, status: error.status };
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

type Probe = { ready: boolean; reason: string };

async function probeModelsDatabase(): Promise<Probe> {
  let client:
    | {
        unsafe: (query: string) => Promise<unknown[]>;
        close: () => Promise<void>;
      }
    | undefined;
  try {
    const { SQL } = await import("bun");
    const url = testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const opened = new SQL(url, { max: 1, connectionTimeout: 5 });
    client = opened;
    const tables = await opened.unsafe(
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_model_routes'",
    );
    if (tables.length === 0) {
      return { ready: false, reason: "migrations not applied" };
    }
    const missing = ["ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL"].filter(
      (variable) => !process.env[variable],
    );
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `restricted login env vars missing: ${missing.join(", ")}`,
      };
    }
    return { ready: true, reason: "" };
  } catch (error) {
    return { ready: false, reason: String((error as Error)?.message ?? error) };
  } finally {
    await client?.close();
  }
}

const dbProbe: Probe = await probeModelsDatabase();
if (!dbProbe.ready) {
  console.warn(
    `[catalog.test.ts] real-database assertions skipped: ${dbProbe.reason}`,
  );
}
const describeDb = dbProbe.ready ? describe : describe.skip;

if (dbProbe.ready) {
  const ownerDatabase = createDatabase(
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
    { max: 1 },
  );
  const runtimeDatabase = createDatabase(
    testDatabaseUrlFrom({
      TEST_DATABASE_URL:
        process.env.ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL,
    }),
    { max: 1 },
  );

  /** 解析与准入查询都跑在租户上下文里的受限登录事务上。 */
  async function withRuntimeTx<T>(
    tenantId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return runtimeDatabase.$client.begin(async (tx) => {
      await tx.unsafe(SET_TENANT_CONTEXT_TEXT, [tenantId]);
      return fn(tx);
    });
  }

  const routeRow = (overrides: {
    tenantId: string;
    id: string;
    alias: string;
    revision: bigint;
    resourceId: string;
    targetRef: string;
    isDefaultForAlias: boolean;
    status: string;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    alias: overrides.alias,
    revision: overrides.revision,
    resourceId: overrides.resourceId,
    targetRef: overrides.targetRef,
    priceRevision: BigInt(1),
    currency: "USD",
    inputUnitMicros: BigInt(10),
    outputUnitMicros: BigInt(30),
    perRequestMicros: BigInt(0),
    maxInputTokens: BigInt(8192),
    maxOutputTokens: BigInt(2048),
    maxRequestBytes: BigInt(262144),
    protocolProfile: "openai-chat",
    usageProfile: "tokens",
    isDefaultForAlias: overrides.isDefaultForAlias,
    status: overrides.status,
  });

  beforeAll(async () => {
    /* 迁移 owner 按 FK 拓扑（子表在前）清理本 suite 的 fixture；runs 与
     * reservations 互为延迟 FK，必须同一事务删除。 */
    for (const table of [enterpriseModelGrants, enterpriseModelRoutes]) {
      await ownerDatabase
        .delete(table)
        .where(inArray(getTableColumns(table).tenantId, [TENANT_A, TENANT_B]));
    }
    await ownerDatabase.transaction(async (tx) => {
      await tx
        .delete(enterpriseRuns)
        .where(inArray(enterpriseRuns.tenantId, [TENANT_A, TENANT_B]));
      await tx
        .delete(enterpriseBudgetReservations)
        .where(
          inArray(enterpriseBudgetReservations.tenantId, [TENANT_A, TENANT_B]),
        );
    });
    for (const table of [
      enterpriseRunReleases,
      enterpriseThreads,
      enterpriseResources,
      enterpriseWorkspaces,
      enterpriseMemberships,
    ] as const) {
      await ownerDatabase
        .delete(table)
        .where(inArray(getTableColumns(table).tenantId, [TENANT_A, TENANT_B]));
    }
    await ownerDatabase
      .delete(enterprisePrincipals)
      .where(inArray(enterprisePrincipals.id, [PRINCIPAL_A, PRINCIPAL_B]));
    await ownerDatabase
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(users)
      .where(inArray(users.id, [USER_A, USER_B]));

    await ownerDatabase
      .insert(users)
      .values([
        { id: USER_A, email: "r4a-a@enterprise-test.invalid" },
        { id: USER_B, email: "r4a-b@enterprise-test.invalid" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseTenants)
      .values([
        { id: TENANT_A, name: "R4A Tenant A" },
        { id: TENANT_B, name: "R4A Tenant B" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterprisePrincipals)
      .values([
        { id: PRINCIPAL_A, userId: USER_A },
        { id: PRINCIPAL_B, userId: USER_B },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseMemberships)
      .values([
        { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
        { tenantId: TENANT_B, principalId: PRINCIPAL_B, role: "member" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseWorkspaces)
      .values([
        { tenantId: TENANT_A, id: WORKSPACE_A, name: "A" },
        { tenantId: TENANT_B, id: WORKSPACE_B, name: "B" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseResources)
      .values([
        {
          tenantId: TENANT_A,
          id: RESOURCE_A,
          workspaceId: WORKSPACE_A,
          kind: "expert",
        },
        {
          tenantId: TENANT_B,
          id: RESOURCE_B,
          workspaceId: WORKSPACE_B,
          kind: "expert",
        },
      ])
      .onConflictDoNothing();
    await ownerDatabase.insert(enterpriseThreads).values({
      tenantId: TENANT_A,
      id: THREAD_A,
      ownerPrincipalId: PRINCIPAL_A,
      workspaceId: WORKSPACE_A,
    });
    await ownerDatabase.insert(enterpriseRunReleases).values({
      tenantId: TENANT_A,
      id: RELEASE_A,
      resourceId: RESOURCE_A,
      versionDigest: "f".repeat(64),
      runtimeCompatibility: "go-v1",
      expertVersion: "1.0.0",
      modelRouteRef: ROUTE_A1,
      inputLimitBytes: BigInt(32768),
      maxModelCalls: BigInt(8),
      maxRunMicros: BigInt(1000000),
      currency: "USD",
      toolManifestDigest: "7".repeat(64),
      toolCount: BigInt(0),
      status: "published",
    });
    /* Run↔reservation 的创建循环在同事务内互相引用：延迟 FK 提交时结算。 */
    await ownerDatabase.transaction(async (tx) => {
      await tx.insert(enterpriseRuns).values({
        tenantId: TENANT_A,
        id: RUN_A,
        ownerPrincipalId: PRINCIPAL_A,
        actorUserId: USER_A,
        workspaceId: WORKSPACE_A,
        threadId: THREAD_A,
        releaseId: RELEASE_A,
        initiatorKind: "user",
        requestKey: "req-a",
        requestDigest: "d".repeat(64),
        inputText: "hello route",
        modelRouteRef: ROUTE_A1,
        modelGrantRevision: BigInt(1),
        releaseDigest: "e".repeat(64),
        policyRevision: "tenancy-v1",
        budgetReservationId: RESERVATION_A,
        status: "running",
        revision: BigInt(1),
        latestSeq: BigInt(1),
        currentFence: BigInt(1),
        reconciliationRequired: false,
        inputRevision: BigInt(0),
        eventLowWatermark: BigInt(0),
      });
      await tx.insert(enterpriseBudgetReservations).values({
        tenantId: TENANT_A,
        id: RESERVATION_A,
        runId: RUN_A,
        capMicros: BigInt(1000000),
        spentMicros: BigInt(0),
        heldMicros: BigInt(1000),
        allocatedMicros: BigInt(0),
        overageMicros: BigInt(0),
        currency: "USD",
        periodId: "2026-10",
        status: "open",
      });
    });
    await ownerDatabase.insert(enterpriseModelRoutes).values([
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A1,
        alias: "chat",
        revision: BigInt(1),
        resourceId: RESOURCE_A,
        targetRef: "higress/openai-main",
        isDefaultForAlias: true,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A2,
        alias: "chat",
        revision: BigInt(2),
        resourceId: RESOURCE_A,
        targetRef: "higress/openai-main",
        isDefaultForAlias: false,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A3,
        alias: "tools",
        revision: BigInt(1),
        resourceId: RESOURCE_A,
        targetRef: "higress/openai-main",
        isDefaultForAlias: true,
        status: "disabled",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A4,
        alias: "future",
        revision: BigInt(1),
        resourceId: RESOURCE_A,
        targetRef: "higress/unregistered-target",
        isDefaultForAlias: true,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_B,
        id: ROUTE_B1,
        alias: "chat",
        revision: BigInt(1),
        resourceId: RESOURCE_B,
        targetRef: "higress/openai-alt",
        isDefaultForAlias: true,
        status: "active",
      }),
    ]);
    await ownerDatabase.insert(enterpriseModelGrants).values([
      {
        tenantId: TENANT_A,
        routeId: ROUTE_A1,
        principalId: PRINCIPAL_A,
        revision: BigInt(1),
        status: "active",
      },
      {
        tenantId: TENANT_A,
        routeId: ROUTE_A2,
        principalId: PRINCIPAL_A,
        revision: BigInt(2),
        status: "revoked",
      },
      {
        tenantId: TENANT_B,
        routeId: ROUTE_B1,
        principalId: PRINCIPAL_B,
        revision: BigInt(1),
        status: "active",
      },
    ]);
  });

  afterAll(async () => {
    await Promise.allSettled([
      ownerDatabase.$client.close(),
      runtimeDatabase.$client.close(),
    ]);
  });

  describeDb("the alias resolves to the one approved route revision", () => {
    test("the default active revision wins for a new resolution", async () => {
      const route = await withRuntimeTx(TENANT_A, (tx) =>
        resolveRouteInTx(tx, scopeA, "chat", registry),
      );
      expect(route.id).toBe(ROUTE_A1);
      expect(route.tenant_id).toBe(TENANT_A);
      expect(route.alias).toBe("chat");
      expect(route.revision).toBe("1");
      expect(route.status).toBe("active");
      expect(route.is_default_for_alias).toBe(true);
      /* 解析结果符合严格 ModelRoute 合同。 */
      expect(ModelRouteSchema.parse(route)).toEqual(route);
    });

    test("a non-default revision never wins the resolution", async () => {
      const route = await withRuntimeTx(TENANT_A, (tx) =>
        resolveRouteInTx(tx, scopeA, "chat", registry),
      );
      expect(route.id).not.toBe(ROUTE_A2);
    });

    test("the resolved route carries the registry reference and no endpoint", async () => {
      const route = await withRuntimeTx(TENANT_A, (tx) =>
        resolveRouteInTx(tx, scopeA, "chat", registry),
      );
      expect(route.target_ref).toBe("higress/openai-main");
      /* 验收第 5 条（动态半场）：序列化结果里没有密钥或端点。 */
      const serialized = JSON.stringify(route);
      expect(serialized).not.toMatch(
        /"(endpoint|base_url|upstream_url|headers?|credential_ref|api_key|secret|token|authorization)"/i,
      );
    });
  });

  describeDb("the deployment registry gates resolution", () => {
    test("an unknown target reference refuses resolution", async () => {
      /* 验收第 4 条：registry 不认识的 target_ref 拒绝——目标地址只在
       * 部署 registry 里，未知引用不是可拨号目标。 */
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => resolveRouteInTx(tx, scopeA, "future", registry)),
      );
      expect(error.code).toBe("MODEL_TARGET_UNKNOWN");
      expect(error.status).toBe(503);
    });

    test("the same route resolves once the registry knows its target", async () => {
      const wide = createStaticTargetRegistry([
        "higress/openai-main",
        "higress/unregistered-target",
      ]);
      const route = await withRuntimeTx(TENANT_A, (tx) =>
        resolveRouteInTx(tx, scopeA, "future", wide),
      );
      expect(route.id).toBe(ROUTE_A4);
      expect(route.target_ref).toBe("higress/unregistered-target");
    });
  });

  describeDb("disabled and missing routes refuse new calls", () => {
    test("an alias whose only route is disabled resolves to nothing", async () => {
      /* 验收第 1 条（解析侧）：禁用 route 之后不再解析出新调用目标。 */
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => resolveRouteInTx(tx, scopeA, "tools", registry)),
      );
      expect(error.code).toBe("MODEL_ROUTE_NOT_FOUND");
      expect(error.status).toBe(404);
    });

    test("an alias that exists nowhere is refused the same way", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => resolveRouteInTx(tx, scopeA, "nope", registry)),
      );
      expect(error.code).toBe("MODEL_ROUTE_NOT_FOUND");
    });

    test("a malformed alias is refused before the database is consulted", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => resolveRouteInTx(tx, scopeA, "bad alias!", registry)),
      );
      expect(error.code).toBe("INVALID_MODEL_ALIAS");
      expect(error.status).toBe(400);
    });
  });

  describeDb("the same alias stays independent across tenants", () => {
    test("tenant B resolves its own route for the same alias", async () => {
      /* 验收第 6 条：相同别名跨租户独立——不同 route、不同目标。 */
      const route = await withRuntimeTx(TENANT_B, (tx) =>
        resolveRouteInTx(tx, scopeB, "chat", registry),
      );
      expect(route.id).toBe(ROUTE_B1);
      expect(route.tenant_id).toBe(TENANT_B);
      expect(route.target_ref).toBe("higress/openai-alt");
      expect(route.id).not.toBe(ROUTE_A1);
    });
  });

  describeDb(
    "an existing run keeps its pinned route across default switches",
    () => {
      test("switching the default never moves the run onto the new target", async () => {
        /* 验收第 2 条：Run 创建时保存固定 route_id；alias 默认切换只影响
         * 新解析，历史 Run 不改 alias 跳到新目标。 */
        const pinnedBefore = await ownerDatabase
          .select({ ref: enterpriseRuns.modelRouteRef })
          .from(enterpriseRuns)
          .where(eq(enterpriseRuns.id, RUN_A));
        expect(pinnedBefore.map((row) => row.ref)).toEqual([ROUTE_A1]);

        /* 运维动作（E1-D 的 disable-route/route-register 落库形态）：先禁用
         * 旧默认释放默认槽位，再注册新默认版本。 */
        await ownerDatabase
          .update(enterpriseModelRoutes)
          .set({ status: "disabled" })
          .where(eq(enterpriseModelRoutes.id, ROUTE_A1));
        await ownerDatabase.insert(enterpriseModelRoutes).values(
          routeRow({
            tenantId: TENANT_A,
            id: ROUTE_A6,
            alias: "chat",
            revision: BigInt(3),
            resourceId: RESOURCE_A,
            targetRef: "higress/openai-alt",
            isDefaultForAlias: true,
            status: "active",
          }),
        );

        /* 新解析拿到新默认——新 Run 会钉住新目标。 */
        const fresh = await withRuntimeTx(TENANT_A, (tx) =>
          resolveRouteInTx(tx, scopeA, "chat", registry),
        );
        expect(fresh.id).toBe(ROUTE_A6);

        /* 已有 Run 的存储引用不变：没有任何路径把它改写为新目标。 */
        const pinnedAfter = await ownerDatabase
          .select({ ref: enterpriseRuns.modelRouteRef })
          .from(enterpriseRuns)
          .where(eq(enterpriseRuns.id, RUN_A));
        expect(pinnedAfter.map((row) => row.ref)).toEqual([ROUTE_A1]);

        /* 且被钉住的旧 route 每次新调用仍检查 disabled：Run 无法借旧引用
         * 继续发起新模型调用，也不能凭 alias 跳到 A6——准入按 route_id 核对。 */
        const error = await withRuntimeTx(TENANT_A, (tx) =>
          rejectionOf(() => assertModelUseInTx(tx, scopeA, ROUTE_A1)),
        );
        expect(error.code).toBe("MODEL_ROUTE_DISABLED");
      });
    },
  );
}
