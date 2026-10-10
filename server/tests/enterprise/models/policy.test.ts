import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableColumns, inArray } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseMemberships,
  enterpriseModelGrants,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseResources,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import type { Scope, Tx } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { assertModelUseInTx } from "../../../src/enterprise/models/policy";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E4-A 模型使用准入（03 分册 §8.1 / §4.3）。
 *
 * assertModelUseInTx 是每次新模型调用的准入查询：route 必须存在于调用方租户、
 * 处于 active，且当前 principal 对该 route 持有 active 的 model_grant。
 * 禁用 route（验收第 1 条）、无 grant 或已撤销 grant（验收第 3 条）、跨租户
 * route id（验收第 6 条）全部拒绝；租户内 grant 按 principal 区分，不给
 * "同租户即同权"的口子。
 *
 * 查询跑在受限登录（ob_ent_runtime_writer，租户钉死的 SELECT 授权）事务里，
 * fixture 由迁移 owner 连接种子（r4b- 前缀，硬编码字面量）。本文件没有动态
 * SQL：语句是编译期字面量，外部值一律经绑定参数传递。
 */

const TENANT_A = "r4b-tenant-a";
const TENANT_B = "r4b-tenant-b";
const USER_A = "r4b-user-a";
const USER_A2 = "r4b-user-a2";
const USER_B = "r4b-user-b";
const PRINCIPAL_A = "r4b-principal-a";
const PRINCIPAL_A2 = "r4b-principal-a2";
const PRINCIPAL_B = "r4b-principal-b";
const WORKSPACE_A = "r4b-workspace-a";
const WORKSPACE_B = "r4b-workspace-b";
const RESOURCE_A = "r4b-resource-a";
const RESOURCE_B = "r4b-resource-b";
const ROUTE_A1 = "r4b-route-a1";
const ROUTE_A2 = "r4b-route-a2";
const ROUTE_A3 = "r4b-route-a3";
const ROUTE_A4 = "r4b-route-a4";
const ROUTE_B1 = "r4b-route-b1";

const scopeA: Scope = Object.freeze({
  tenantId: TENANT_A,
  principalId: PRINCIPAL_A,
  userId: USER_A,
  role: "member",
  epoch: 1,
});
/* 同租户的第二成员：grant 按 principal 判定的对照。 */
const scopeA2: Scope = Object.freeze({
  tenantId: TENANT_A,
  principalId: PRINCIPAL_A2,
  userId: USER_A2,
  role: "member",
  epoch: 1,
});

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
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_model_grants'",
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
    `[policy.test.ts] real-database assertions skipped: ${dbProbe.reason}`,
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
    resourceId: string;
    status: string;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    alias: overrides.alias,
    revision: BigInt(1),
    resourceId: overrides.resourceId,
    targetRef: "higress/openai-main",
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
    isDefaultForAlias: true,
    status: overrides.status,
  });

  beforeAll(async () => {
    for (const table of [enterpriseModelGrants, enterpriseModelRoutes]) {
      await ownerDatabase
        .delete(table)
        .where(inArray(getTableColumns(table).tenantId, [TENANT_A, TENANT_B]));
    }
    for (const table of [
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
      .where(
        inArray(enterprisePrincipals.id, [
          PRINCIPAL_A,
          PRINCIPAL_A2,
          PRINCIPAL_B,
        ]),
      );
    await ownerDatabase
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(users)
      .where(inArray(users.id, [USER_A, USER_A2, USER_B]));

    await ownerDatabase
      .insert(users)
      .values([
        { id: USER_A, email: "r4b-a@enterprise-test.invalid" },
        { id: USER_A2, email: "r4b-a2@enterprise-test.invalid" },
        { id: USER_B, email: "r4b-b@enterprise-test.invalid" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseTenants)
      .values([
        { id: TENANT_A, name: "R4B Tenant A" },
        { id: TENANT_B, name: "R4B Tenant B" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterprisePrincipals)
      .values([
        { id: PRINCIPAL_A, userId: USER_A },
        { id: PRINCIPAL_A2, userId: USER_A2 },
        { id: PRINCIPAL_B, userId: USER_B },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseMemberships)
      .values([
        { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
        { tenantId: TENANT_A, principalId: PRINCIPAL_A2, role: "member" },
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
    await ownerDatabase.insert(enterpriseModelRoutes).values([
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A1,
        alias: "chat",
        resourceId: RESOURCE_A,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A2,
        alias: "tools",
        resourceId: RESOURCE_A,
        status: "disabled",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A3,
        alias: "audit",
        resourceId: RESOURCE_A,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A4,
        alias: "legacy",
        resourceId: RESOURCE_A,
        status: "active",
      }),
      routeRow({
        tenantId: TENANT_B,
        id: ROUTE_B1,
        alias: "chat",
        resourceId: RESOURCE_B,
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
        /* 已撤销的 grant：行还在，但不再准入。 */
        tenantId: TENANT_A,
        routeId: ROUTE_A4,
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

  describeDb("model use admission", () => {
    test("an active route with an active grant admits model use", async () => {
      await withRuntimeTx(TENANT_A, (tx) =>
        assertModelUseInTx(tx, scopeA, ROUTE_A1),
      );
    });

    test("a disabled route refuses new calls", async () => {
      /* 验收第 1 条：禁用 route 后新调用拒绝。 */
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, ROUTE_A2)),
      );
      expect(error.code).toBe("MODEL_ROUTE_DISABLED");
      expect(error.status).toBe(403);
    });

    test("a route without any model grant refuses", async () => {
      /* 验收第 3 条：无 model_grant 拒绝。 */
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, ROUTE_A3)),
      );
      expect(error.code).toBe("MODEL_GRANT_REQUIRED");
      expect(error.status).toBe(403);
    });

    test("another member of the same tenant without a grant refuses too", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA2, ROUTE_A1)),
      );
      expect(error.code).toBe("MODEL_GRANT_REQUIRED");
    });

    test("a revoked grant refuses even though the row still exists", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, ROUTE_A4)),
      );
      expect(error.code).toBe("MODEL_GRANT_REQUIRED");
      expect(error.status).toBe(403);
    });

    test("a route id from another tenant is invisible", async () => {
      /* 验收第 6 条（route id 角度）：租户谓词加 RLS，跨租户引用与
       * 不存在是同一个拒绝。 */
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, ROUTE_B1)),
      );
      expect(error.code).toBe("MODEL_ROUTE_NOT_FOUND");
      expect(error.status).toBe(404);
    });

    test("an unknown route id refuses", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, "r4b-route-none")),
      );
      expect(error.code).toBe("MODEL_ROUTE_NOT_FOUND");
    });

    test("a malformed route id is refused before the database is consulted", async () => {
      const error = await withRuntimeTx(TENANT_A, (tx) =>
        rejectionOf(() => assertModelUseInTx(tx, scopeA, "bad id!")),
      );
      expect(error.code).toBe("INVALID_MODEL_ROUTE_ID");
      expect(error.status).toBe(400);
    });
  });
}
