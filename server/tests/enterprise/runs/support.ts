import { and, eq, inArray, like } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseBudgetAccounts,
  enterpriseBudgetBindings,
  enterpriseBudgetReservations,
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterpriseModelGrants,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseRunEvents,
  enterpriseRunGrants,
  enterpriseRunOutbox,
  enterpriseRunReleases,
  enterpriseRuns,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseThreads,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { createAuthz } from "../../../src/enterprise/authz/service";
import type { Scope, Tx } from "../../../src/enterprise/contracts";
import { budgetPort } from "../../../src/enterprise/models/budget";
import { createStaticTargetRegistry } from "../../../src/enterprise/models/contracts";
import type { RunService } from "../../../src/enterprise/runs/contracts";
import type { RunPolicy } from "../../../src/enterprise/runs/policy";
import { createRunPolicy } from "../../../src/enterprise/runs/policy";
import {
  applyRunProvision,
  EMPTY_TOOL_MANIFEST_DIGEST,
  type RunProvisionCommand,
} from "../../../src/enterprise/runs/provision";
import { createRunStore } from "../../../src/enterprise/runs/store";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createResource,
  createWorkspace,
  grantRead,
  provisionMember,
  revokeRead,
} from "../../../src/enterprise/tenancy/provision";
import { resolveScope } from "../../../src/enterprise/tenancy/scope";
import {
  beginOperation,
  type TxClient,
  withTenant,
} from "../../../src/enterprise/tenancy/transaction";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E1-C 测试夹具（03 分册 §4.3 测试步骤：354 行“夹具通过离线provision创建真实租户、
 * start grant、model grant、预算账户和无工具release”，367 行“通过02的provision与本册
 * provision建立fixture”）。
 *
 * h 是本册测试 helper：固定专用测试库与真实 RunService，不是永远允许的替身。
 * 身份链（principal/membership/workspace/resource/read grant）通过 02 的领域函数在
 * 受限登录上建立；03 运行域的 route/release/run grant/model grant/预算账户通过本册
 * E1-D 的 applyRunProvision（迁移 owner 连接承载事务，与 provision.test.ts 同一纪律）
 * 建立——夹具因此证明 provision 产出的状态能被 store 接受，不建第二个市场。
 * count 使用固定三条 SQL 而非请求拼表名；afterAll 关闭连接，不清除其他测试数据。
 * 清理语句全部针对本夹具的 r1c- 前缀硬编码 id，删除目标不含任何外部输入。
 */

const PREFIX = "r1c-";

const TENANT_A = `${PREFIX}tenant-a`;
const TENANT_B = `${PREFIX}tenant-b`;
const TENANT_NAME_A = "R1C Tenant A";
const TENANT_NAME_B = "R1C Tenant B";
const USER_A = `${PREFIX}user-a`;
const USER_B = `${PREFIX}user-b`;
const USER_C = `${PREFIX}user-c`;
const PRINCIPAL_A = `${PREFIX}principal-a`;
const PRINCIPAL_B = `${PREFIX}principal-b`;
const PRINCIPAL_C = `${PREFIX}principal-c`;
const WORKSPACE_A = `${PREFIX}workspace-a`;
const RESOURCE_A = `${PREFIX}resource-a`;
const THREAD_A = `${PREFIX}thread-a`;
const THREAD_C = `${PREFIX}thread-c`;
const RELEASE_A = `${PREFIX}release-a`;
const ROUTE_A = `${PREFIX}route-a`;
const ALIAS = "chat";
const PERIOD = "2026-10-r1c";
const CURRENCY = "USD";
const OPERATOR = `${PREFIX}operator`;
const DEFAULT_BUDGET_LIMIT = "10000000";
/** 预算周期窗口：Timestamptz 必须带时区（E1-D 的 union 输入契约）。 */
const PERIOD_STARTS_AT = "2026-10-01T00:00:00Z";
const PERIOD_ENDS_AT = "2026-11-01T00:00:00Z";
/** 部署映射里已批准的 upstream target key（E1-D 拒绝未映射 target，夹具同规）。 */
export const RUN_TARGET_REF = "openai/gpt-test";
const RUN_TARGETS = createStaticTargetRegistry([RUN_TARGET_REF]);

export type RunsProbe = { ready: boolean; reason: string };

/** 与 02/04 册同一纪律：环境或角色缺失时 fail-closed 跳过真实库断言，绝不换替身。 */
export async function probeRunsDatabase(): Promise<RunsProbe> {
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
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_runs'",
    );
    if (tables.length === 0) {
      return {
        ready: false,
        reason: "migrations not applied to the test database",
      };
    }
    const roles = await opened.unsafe(
      "select rolname from pg_roles where rolname in ('ob_ent_run_writer','ob_ent_runtime_writer','ob_ent_operator','ob_ent_identity_operator','ob_ent_directory')",
    );
    if (roles.length < 5) {
      return {
        ready: false,
        reason: `only ${roles.length}/5 capability roles exist; run enterprise-test-db.ts roles`,
      };
    }
    const missing = [
      "ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
      "ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL",
      "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    ].filter((variable) => !process.env[variable]);
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

/** 真实 Run 创建服务可注入的三个故障点（§4.3 测试步骤），生产方从不传入。 */
export type CreateFaultHooks = {
  afterRunInsert?: () => Promise<void>;
  afterReserve?: () => Promise<void>;
  afterOutboxInsert?: () => Promise<void>;
};

export type RunHarness = {
  scope: Scope;
  scopeB: Scope;
  /** 同租户第二成员：他人 thread 与他人 run 的反例用它，不掺跨租户噪声。 */
  scopeC: Scope;
  workspaceId: string;
  releaseId: string;
  threadId: string;
  /** 他人（principal C）名下的 thread：同租户、另一位 owner。 */
  threadIdC: string;
  routeId: string;
  alias: string;
  /** release 与 route 共同挂载的专家资源：资源锁家族与撤权竞窗用例用它。 */
  resourceId: string;
  runs: RunService;
  policy: RunPolicy;
  /** 追加一条 E1-D 开通命令（迁移 owner 连接事务 + 夹具的静止 target registry）。 */
  provision(command: RunProvisionCommand): Promise<void>;
  /** 在迁移 owner 连接的打开事务里执行 fn：撤权竞窗用例先持资源咨询锁再用它。 */
  ownerBegin<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  /** 同一依赖、可注入故障点的第二实例：故障注入走真实预算端口，不得换替身。 */
  storeWithHooks(hooks: CreateFaultHooks): RunService;
  /** 在 scope 的事务里跑一段断言（RunPolicy 直接测试用）。 */
  inTenantTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  inTenantTxFor<T>(alt: Scope, fn: (tx: Tx) => Promise<T>): Promise<T>;
  count(kind: "runs" | "reservations" | "start_outbox"): Promise<number>;
  /** 固定 SQL 探针：某 run 的平台事件（RUN_QUEUED 追加取证用）。 */
  queuedEvent(runId: string): Promise<
    | {
        seq: string;
        event_type: string;
        attempt_id: string | null;
        source_event_id: string;
        payload: Record<string, unknown>;
        latest_seq: string;
      }
    | undefined
  >;
  setRunGrant(action: "start" | "resume_own", present: boolean): Promise<void>;
  setModelGrant(status: "active" | "revoked"): Promise<void>;
  setReleaseStatus(status: "published" | "disabled"): Promise<void>;
  setRouteStatus(status: "active" | "disabled"): Promise<void>;
  setBudgetLimitMicros(limit: string): Promise<void>;
  revokeResourceRead(): Promise<void>;
  grantResourceRead(): Promise<void>;
  /** 只清理本夹具的 r1c- 行（不碰其他测试数据）；afterAll 里先 cleanup 再 close。 */
  cleanup(): Promise<void>;
  close(): Promise<void>;
};

/**
 * 固定三条 count SQL：表名是编译期字面量，绝不由请求拼出。计数按租户圈定，
 * 同库其他 fixture 不受影响。
 */
const COUNT_RUNS =
  "select count(*)::int as n from enterprise_runs where tenant_id = $1";
const COUNT_RESERVATIONS =
  "select count(*)::int as n from enterprise_budget_reservations where tenant_id = $1";
const COUNT_START_OUTBOX =
  "select count(*)::int as n from enterprise_run_outbox where tenant_id = $1 and kind = 'start_workflow'";

export async function createRunHarness(): Promise<RunHarness> {
  const restrictedUrl = (variable: string) =>
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });

  const ownerDatabase = createDatabase(
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
    { max: 1 },
  );
  const operatorDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
    { max: 1 },
  );
  const identityOperatorDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
    { max: 1 },
  );
  const directoryDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
    { max: 1 },
  );
  const runWriterDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL"),
    { max: 2 },
  );
  const runtimeWriterDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL"),
    { max: 1 },
  );

  const cleanup = async (): Promise<void> => {
    /* 按 FK 拓扑（子表在前）清理本夹具的 r1c- 行；runs/reservations 延迟互引同事务删，
     * 且必须先于 releases/threads（runs 的复合 FK 指向它们）。 */
    for (const table of [
      enterpriseRunEvents,
      enterpriseRunOutbox,
      enterpriseRunGrants,
      enterpriseModelGrants,
      enterpriseBudgetBindings,
      enterpriseModelRoutes,
      enterpriseBudgetAccounts,
    ] as const) {
      await ownerDatabase.delete(table).where(eq(table.tenantId, TENANT_A));
    }
    await ownerDatabase.transaction(async (tx) => {
      await tx
        .delete(enterpriseRuns)
        .where(eq(enterpriseRuns.tenantId, TENANT_A));
      await tx
        .delete(enterpriseBudgetReservations)
        .where(eq(enterpriseBudgetReservations.tenantId, TENANT_A));
    });
    for (const table of [
      enterpriseRunReleases,
      enterpriseThreads,
      enterpriseResourceGrants,
      enterpriseResources,
      enterpriseWorkspaces,
    ] as const) {
      await ownerDatabase.delete(table).where(eq(table.tenantId, TENANT_A));
    }
    await ownerDatabase
      .delete(enterpriseSecurityEvents)
      .where(inArray(enterpriseSecurityEvents.tenantId, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(enterpriseIdentityEvents)
      .where(like(enterpriseIdentityEvents.id, `${PREFIX}%`));
    await ownerDatabase
      .delete(enterpriseMemberships)
      .where(inArray(enterpriseMemberships.tenantId, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(enterprisePrincipals)
      .where(
        inArray(enterprisePrincipals.id, [
          PRINCIPAL_A,
          PRINCIPAL_B,
          PRINCIPAL_C,
        ]),
      );
    await ownerDatabase
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(users)
      .where(inArray(users.id, [USER_A, USER_B, USER_C]));
  };

  await cleanup();

  /* 身份链走 02 领域函数（受限登录），不手写 SQL 绕过锁与审计。 */
  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_A, email: `${PREFIX}a@enterprise-test.invalid` },
      { id: USER_B, email: `${PREFIX}b@enterprise-test.invalid` },
      { id: USER_C, email: `${PREFIX}c@enterprise-test.invalid` },
    ])
    .onConflictDoNothing();
  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL_A,
    userId: USER_A,
    operator: OPERATOR,
    operationId: `${PREFIX}op-principal-a`,
  });
  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL_B,
    userId: USER_B,
    operator: OPERATOR,
    operationId: `${PREFIX}op-principal-b`,
  });
  await createPrincipal(identityOperatorDatabase, {
    principalId: PRINCIPAL_C,
    userId: USER_C,
    operator: OPERATOR,
    operationId: `${PREFIX}op-principal-c`,
  });
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_A,
    tenantName: TENANT_NAME_A,
    principalId: PRINCIPAL_A,
    userId: USER_A,
    role: "member",
    operator: OPERATOR,
    operationId: `${PREFIX}op-member-a`,
  });
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_B,
    tenantName: TENANT_NAME_B,
    principalId: PRINCIPAL_B,
    userId: USER_B,
    role: "member",
    operator: OPERATOR,
    operationId: `${PREFIX}op-member-b`,
  });
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_A,
    tenantName: TENANT_NAME_A,
    principalId: PRINCIPAL_C,
    userId: USER_C,
    role: "member",
    operator: OPERATOR,
    operationId: `${PREFIX}op-member-c`,
  });
  await createWorkspace(operatorDatabase, {
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    name: `${PREFIX}workspace`,
    operator: OPERATOR,
    operationId: `${PREFIX}op-workspace-a`,
  });
  await createResource(operatorDatabase, {
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    resourceId: RESOURCE_A,
    kind: "document",
    operator: OPERATOR,
    operationId: `${PREFIX}op-resource-a`,
  });
  await grantRead(operatorDatabase, {
    tenantId: TENANT_A,
    resourceId: RESOURCE_A,
    principalId: PRINCIPAL_A,
    operator: OPERATOR,
    operationId: `${PREFIX}op-grant-read-a`,
  });

  /* 会话域 thread 行（旧 thread 必须预存在，归属 02/会话域，非 E1-D 对象）：
   * 他人 thread 与归档 thread 反例用。 */
  await ownerDatabase.insert(enterpriseThreads).values([
    {
      tenantId: TENANT_A,
      id: THREAD_A,
      ownerPrincipalId: PRINCIPAL_A,
      workspaceId: WORKSPACE_A,
    },
    {
      tenantId: TENANT_A,
      id: THREAD_C,
      ownerPrincipalId: PRINCIPAL_C,
      workspaceId: WORKSPACE_A,
    },
  ]);

  /* 03 运行域 fixture（计划 §4.3 354/367 行）：通过本册 E1-D 的 applyRunProvision
   * 建立 route/release/start grant/model grant/四层预算账户——provision 产出的状态
   * 必须就是 store 接受的状态，同一事务按锁序落库并各留一条安全事件。 */
  await beginOperation(ownerDatabase, async (tx) => {
    const apply = (command: RunProvisionCommand) =>
      applyRunProvision(tx, command, { targets: RUN_TARGETS });
    await apply({
      mode: "route-register",
      tenant_id: TENANT_A,
      operator: OPERATOR,
      operation_id: `${PREFIX}op-route-register`,
      id: ROUTE_A,
      resource_id: RESOURCE_A,
      alias: ALIAS,
      revision: "1",
      target_ref: RUN_TARGET_REF,
      price_revision: "1",
      currency: CURRENCY,
      input_unit_micros: "10",
      output_unit_micros: "30",
      per_request_micros: "0",
      max_input_tokens: 8192,
      max_output_tokens: 2048,
      max_request_bytes: 262144,
      protocol_profile: "openai-chat",
      usage_profile: "tokens",
      is_default_for_alias: true,
    });
    await apply({
      mode: "release-register",
      tenant_id: TENANT_A,
      operator: OPERATOR,
      operation_id: `${PREFIX}op-release-register`,
      id: RELEASE_A,
      resource_id: RESOURCE_A,
      version_digest: "c".repeat(64),
      runtime_compatibility: "go-v1",
      expert_version: "1.0.0",
      model_route_ref: ROUTE_A,
      input_limit_bytes: 32768,
      max_model_calls: 8,
      max_run_micros: "1000000",
      currency: CURRENCY,
      tool_manifest_digest: EMPTY_TOOL_MANIFEST_DIGEST,
      tool_count: 0,
    });
    for (const principal of [PRINCIPAL_A, PRINCIPAL_C]) {
      await apply({
        mode: "run-grant",
        tenant_id: TENANT_A,
        operator: OPERATOR,
        operation_id: `${PREFIX}op-run-grant-${principal}`,
        release_id: RELEASE_A,
        principal_id: principal,
        action: "start",
      });
      await apply({
        mode: "model-grant",
        tenant_id: TENANT_A,
        operator: OPERATOR,
        operation_id: `${PREFIX}op-model-grant-${principal}`,
        route_id: ROUTE_A,
        principal_id: principal,
      });
    }
    const budgetScopes = (
      [
        ["tenant", TENANT_A],
        ["workspace", WORKSPACE_A],
        ["expert", RELEASE_A],
        ["principal", PRINCIPAL_A],
      ] as const
    ).map(([kind, ref]) => ({ kind, ref }));
    for (const [index, { kind, ref }] of budgetScopes.entries()) {
      await apply({
        mode: "budget-open",
        tenant_id: TENANT_A,
        operator: OPERATOR,
        operation_id: `${PREFIX}op-budget-open-${kind}`,
        id: `${PREFIX}acc-${["tenant", "workspace", "expert", "principal"][index]}`,
        scope_kind: kind,
        scope_ref: ref,
        period_id: PERIOD,
        starts_at: PERIOD_STARTS_AT,
        ends_at: PERIOD_ENDS_AT,
        currency: CURRENCY,
        limit_micros: DEFAULT_BUDGET_LIMIT,
      });
    }
  });

  const directory = createDirectory(directoryDatabase);
  const scope = await resolveScope(directory, USER_A, TENANT_A);
  const scopeB = await resolveScope(directory, USER_B, TENANT_B);
  const scopeC = await resolveScope(directory, USER_C, TENANT_A);

  /* 0064 补齐 run_writer 只读目录后，RunPolicy 的全部判定回到调用方同一事务：
   * 注入 02 的真 Authz（read 判定经 assertResourceReadInTx 用它），无跨池替身。 */
  const policy = createRunPolicy({ authz: createAuthz() });
  const runs = createRunStore({
    db: runWriterDatabase,
    policy,
    budget: budgetPort,
    eventsDatabase: runtimeWriterDatabase,
    targets: RUN_TARGETS,
  });

  const QUEUED_EVENT_SQL = `
    select e.seq::text as seq, e.event_type, e.attempt_id, e.source_event_id,
           e.payload, r.latest_seq::text as latest_seq
    from enterprise_run_events e
    join enterprise_runs r on r.tenant_id = e.tenant_id and r.id = e.run_id
    where e.tenant_id = $1 and e.run_id = $2 and e.event_type = 'RUN_QUEUED'
    order by e.seq desc limit 1`;

  async function queuedEvent(runId: string) {
    const rows = await ownerDatabase.$client.unsafe(QUEUED_EVENT_SQL, [
      TENANT_A,
      runId,
    ]);
    const row = rows[0];
    if (row === undefined) return undefined;
    const rawPayload: unknown = row.payload;
    const payload =
      typeof rawPayload === "string"
        ? (JSON.parse(rawPayload) as Record<string, unknown>)
        : ((rawPayload ?? {}) as Record<string, unknown>);
    return {
      seq: String(row.seq),
      event_type: String(row.event_type),
      attempt_id: (row.attempt_id as string | null) ?? null,
      source_event_id: String(row.source_event_id),
      payload,
      latest_seq: String(row.latest_seq),
    };
  }

  async function count(kind: "runs" | "reservations" | "start_outbox") {
    const text =
      kind === "runs"
        ? COUNT_RUNS
        : kind === "reservations"
          ? COUNT_RESERVATIONS
          : COUNT_START_OUTBOX;
    const rows = await ownerDatabase.$client.unsafe<{ n: number }[]>(text, [
      TENANT_A,
    ]);
    return rows[0].n;
  }

  return {
    scope,
    scopeB,
    scopeC,
    workspaceId: WORKSPACE_A,
    releaseId: RELEASE_A,
    threadId: THREAD_A,
    threadIdC: THREAD_C,
    routeId: ROUTE_A,
    alias: ALIAS,
    resourceId: RESOURCE_A,
    runs,
    policy,
    provision(command) {
      return beginOperation(ownerDatabase, (tx) =>
        applyRunProvision(tx, command, { targets: RUN_TARGETS }),
      );
    },
    ownerBegin(fn) {
      return beginOperation(ownerDatabase, fn);
    },
    storeWithHooks(hooks) {
      return createRunStore({
        db: runWriterDatabase,
        policy,
        budget: budgetPort,
        eventsDatabase: runtimeWriterDatabase,
        targets: RUN_TARGETS,
        hooks,
      });
    },
    inTenantTx(fn) {
      return withTenant(runWriterDatabase, scope, fn);
    },
    inTenantTxFor(alt, fn) {
      return withTenant(runWriterDatabase, alt, fn);
    },
    count,
    queuedEvent,
    async setRunGrant(action, present) {
      const key = and(
        eq(enterpriseRunGrants.tenantId, TENANT_A),
        eq(enterpriseRunGrants.releaseId, RELEASE_A),
        eq(enterpriseRunGrants.principalId, PRINCIPAL_A),
        eq(enterpriseRunGrants.action, action),
      );
      if (present) {
        await ownerDatabase
          .insert(enterpriseRunGrants)
          .values({
            tenantId: TENANT_A,
            releaseId: RELEASE_A,
            principalId: PRINCIPAL_A,
            action,
            revision: 1n,
          })
          .onConflictDoNothing();
        return;
      }
      await ownerDatabase.delete(enterpriseRunGrants).where(key);
    },
    async setModelGrant(status) {
      await ownerDatabase
        .update(enterpriseModelGrants)
        .set({ status })
        .where(
          and(
            eq(enterpriseModelGrants.tenantId, TENANT_A),
            eq(enterpriseModelGrants.routeId, ROUTE_A),
            eq(enterpriseModelGrants.principalId, PRINCIPAL_A),
          ),
        );
    },
    async setReleaseStatus(status) {
      await ownerDatabase
        .update(enterpriseRunReleases)
        .set({ status })
        .where(
          and(
            eq(enterpriseRunReleases.tenantId, TENANT_A),
            eq(enterpriseRunReleases.id, RELEASE_A),
          ),
        );
    },
    async setRouteStatus(status) {
      await ownerDatabase
        .update(enterpriseModelRoutes)
        .set({ status })
        .where(
          and(
            eq(enterpriseModelRoutes.tenantId, TENANT_A),
            eq(enterpriseModelRoutes.id, ROUTE_A),
          ),
        );
    },
    async setBudgetLimitMicros(limit) {
      await ownerDatabase
        .update(enterpriseBudgetAccounts)
        .set({ limitMicros: BigInt(limit) })
        .where(
          and(
            eq(enterpriseBudgetAccounts.tenantId, TENANT_A),
            eq(enterpriseBudgetAccounts.periodId, PERIOD),
          ),
        );
    },
    async revokeResourceRead() {
      await revokeRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: RESOURCE_A,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: `${PREFIX}op-revoke-read`,
      });
    },
    async grantResourceRead() {
      await grantRead(operatorDatabase, {
        tenantId: TENANT_A,
        resourceId: RESOURCE_A,
        principalId: PRINCIPAL_A,
        operator: OPERATOR,
        operationId: `${PREFIX}op-regrant-read`,
      });
    },
    cleanup,
    async close() {
      await Promise.allSettled([
        ownerDatabase.$client.close(),
        operatorDatabase.$client.close(),
        identityOperatorDatabase.$client.close(),
        directoryDatabase.$client.close(),
        runWriterDatabase.$client.close(),
        runtimeWriterDatabase.$client.close(),
      ]);
    },
  };
}
