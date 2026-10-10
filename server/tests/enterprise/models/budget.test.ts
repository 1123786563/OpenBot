import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseBudgetAccounts,
  enterpriseBudgetBindings,
  enterpriseBudgetReservations,
  enterpriseMemberships,
  enterpriseModelAttempts,
  enterpriseModelCalls,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseResources,
  enterpriseRunAttempts,
  enterpriseRunReleases,
  enterpriseRunSteps,
  enterpriseRuns,
  enterpriseTenants,
  enterpriseThreads,
  enterpriseUsageEntries,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import type { Tx } from "../../../src/enterprise/contracts";
import { EnterpriseError } from "../../../src/enterprise/errors";
import {
  allocateCallInTx,
  budgetPort,
  closeReservationInTx,
  settleCallInTx,
  type UsageReceipt,
} from "../../../src/enterprise/models/budget";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E4-B 预算算法（03 分册 §8.2 + 779–796 行测试步骤的真实库半场）。
 *
 * 双层预留：账户四层（tenant/workspace/expert/principal）在 reserve 时同加 held，
 * 任一层不足整个事务回滚；allocate 只动 reservation.allocated 且必须
 * allocated+call_cap<=held；settle 按回执分支移动金额——succeeded 记真实支出
 * （超 cap 时 otherAllocated/spendable/covered/overage 并冻结账户）、
 * not_submitted/failed 只退 allocated、unknown 什么都不释放。
 * 关闭只释放 held-allocated，unknown 余量进 reconciliation。
 *
 * 各场景用独立 period_id 换到独立的四层账户组（(tenant,scope,period,currency)
 * 唯一），并发组 s1a/s1b 共享同一 period 才会争用同一组账户。
 *
 * 纪律与 02 册一致：迁移 owner 连接只种受控 fixture（r4b- 前缀，全部硬编码），
 * 预算语句都跑在受限登录事务里——reserve 在 ob_ent_run_writer（租户+principal
 * 上下文），allocate/settle/close 在 ob_ent_runtime_writer（租户+run 上下文）。
 * 测试内没有动态 SQL：语句是编译期字面量，外部值一律经绑定参数传递。
 */

const TENANT = "r4b-tenant";
const USER = "r4b-user";
const PRINCIPAL = "r4b-principal";
const WORKSPACE = "r4b-workspace";
const RESOURCE = "r4b-resource";
const RELEASE = "r4b-release";
const ROUTE = "r4b-route";
const CURRENCY = "USD";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);

type Scenario =
  | "s1a"
  | "s1b"
  | "s2"
  | "s3"
  | "s4"
  | "s5"
  | "s6"
  | "s7"
  | "s7b"
  | "s8";

/** s1a/s1b 共享 s1 账户组（并发的两方必须争用同一组账户）。 */
const periodOf = (s: Scenario) =>
  s === "s1a" || s === "s1b" ? "2026-10-s1" : `2026-10-${s}`;
/** 账户组键：与 period 一一对应。 */
const accountGroupOf = (s: Scenario) => periodOf(s).replace("2026-10-", "");
const accountIdsOf = (s: Scenario) =>
  ["tenant", "workspace", "expert", "principal"].map(
    (kind) => `r4b-acc-${accountGroupOf(s)}-${kind}`,
  );

const runIdOf = (s: Scenario) => `r4b-run-${s}`;
const reservationIdOf = (s: Scenario) => `r4b-res-${s}`;
const attemptIdOf = (s: Scenario) => `r4b-attempt-${s}`;
const threadIdOf = (s: Scenario) => `r4b-thread-${s}`;

const ALL_SCENARIOS: Scenario[] = [
  "s1a",
  "s1b",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "s7b",
  "s8",
];
/** 独立账户组：s1 组由 s1a/s1b 共享；s7b 是 s7 Run 上的第二个 attempt，无组。 */
const ACCOUNT_GROUPS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] as const;

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

async function probeBudgetDatabase(): Promise<Probe> {
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
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_budget_accounts'",
    );
    if (tables.length === 0) {
      return { ready: false, reason: "migrations not applied" };
    }
    const missing = [
      "ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL",
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

const dbProbe: Probe = await probeBudgetDatabase();
if (!dbProbe.ready) {
  console.warn(
    `[budget.test.ts] real-database assertions skipped: ${dbProbe.reason}`,
  );
}
const describeDb = dbProbe.ready ? describe : describe.skip;

if (dbProbe.ready) {
  const ownerDatabase = createDatabase(
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
    { max: 2 },
  );
  /* 并发半场需要同时挂起两个事务：run_writer 池给 4 个连接。 */
  const runWriterDatabase = createDatabase(
    testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL,
    }),
    { max: 4 },
  );
  const runtimeDatabase = createDatabase(
    testDatabaseUrlFrom({
      TEST_DATABASE_URL:
        process.env.ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL,
    }),
    { max: 2 },
  );

  const RUN_WRITER_CONTEXT_TEXT =
    "select set_config('app.tenant_id', $1, true), set_config('app.principal_id', $2, true)";
  const RUNTIME_CONTEXT_TEXT =
    "select set_config('app.tenant_id', $1, true), set_config('app.run_id', $2, true)";

  /** reserve 半场：与 E1-C 同一形态——Run 行和预留同一事务提交。 */
  const INSERT_RUN_TEXT = `
    insert into enterprise_runs (tenant_id, id, owner_principal_id, actor_user_id,
      workspace_id, thread_id, release_id, initiator_kind, request_key, request_digest,
      input_text, model_route_ref, model_grant_revision, release_digest, policy_revision,
      budget_reservation_id, status, revision, latest_seq, current_fence)
    values ($1, $2, $3, $4, $5, $6, $7, 'user', $8, $9, $10, $11,
      $12::bigint, $13, $14, $15, 'running', $16::bigint, $17::bigint, $18::bigint)
    returning id`;

  /** allocate/settle/close 半场：租户 + 绑定 run 的受限运行时上下文。 */
  function withRuntimeTx<T>(
    runId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return runtimeDatabase.$client.begin(async (tx) => {
      await tx.unsafe(RUNTIME_CONTEXT_TEXT, [TENANT, runId]);
      return fn(tx);
    });
  }

  const windowDates = (expired: boolean) => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    return expired
      ? { startsAt: new Date(now - 2 * day), endsAt: new Date(now - 1 * day) }
      : { startsAt: new Date(now - 1 * day), endsAt: new Date(now + 30 * day) };
  };

  function accountRows(group: string, period: string) {
    const expired = group === "s6";
    const limit = group === "s1" ? BigInt(100) : group === "s2" ? null : BigInt(1000);
    const held = group === "s6" || group === "s4" || group === "s5" || group === "s7" || group === "s8" ? BigInt(80) : BigInt(0);
    const { startsAt, endsAt } = windowDates(expired);
    const scopes: Array<
      ["tenant" | "workspace" | "expert" | "principal", string, bigint]
    > = [
      ["tenant", TENANT, limit ?? BigInt(50)],
      ["workspace", WORKSPACE, limit ?? BigInt(100)],
      ["expert", RELEASE, limit ?? BigInt(100)],
      ["principal", PRINCIPAL, limit ?? BigInt(100)],
    ];
    return scopes.map(([scopeKind, scopeRef, limitMicros], index) => ({
      tenantId: TENANT,
      id: ["tenant", "workspace", "expert", "principal"].map(
        (kind) => `r4b-acc-${group}-${kind}`,
      )[index],
      scopeKind,
      scopeRef,
      periodId: period,
      startsAt,
      endsAt,
      currency: CURRENCY,
      limitMicros,
      spentMicros: BigInt(0),
      heldMicros: held,
      overageMicros: BigInt(0),
      status: "active",
      revision: BigInt(1),
    }));
  }

  /** owner 种 Run＋预留（互为延迟 FK，必须同事务提交），等价 reserve 的落库形态。 */
  async function seedRunWithReservation(
    s: Scenario,
    heldMicros: bigint,
    allocatedMicros = BigInt(0),
  ) {
    await ownerDatabase.transaction(async (tx) => {
      await tx.insert(enterpriseRuns).values({
        tenantId: TENANT,
        id: runIdOf(s),
        ownerPrincipalId: PRINCIPAL,
        actorUserId: USER,
        workspaceId: WORKSPACE,
        threadId: threadIdOf(s),
        releaseId: RELEASE,
        initiatorKind: "user",
        requestKey: `req-${s}`,
        requestDigest: DIGEST_A,
        inputText: "hello budget",
        modelRouteRef: ROUTE,
        modelGrantRevision: BigInt(1),
        releaseDigest: DIGEST_B,
        policyRevision: "tenancy-v1",
        budgetReservationId: reservationIdOf(s),
        status: "running",
        revision: BigInt(1),
        latestSeq: BigInt(1),
        currentFence: BigInt(1),
        reconciliationRequired: false,
        inputRevision: BigInt(0),
        eventLowWatermark: BigInt(0),
      });
      await tx.insert(enterpriseBudgetReservations).values({
        tenantId: TENANT,
        id: reservationIdOf(s),
        runId: runIdOf(s),
        capMicros: BigInt(80),
        spentMicros: BigInt(0),
        heldMicros: heldMicros,
        allocatedMicros: allocatedMicros,
        overageMicros: BigInt(0),
        currency: CURRENCY,
        periodId: periodOf(s),
        status: "open",
      });
    });
  }

  /** owner 种一次模型调用的完整 FK 链；默认挂在场景自己的 Run 上。 */
  async function seedAttemptChain(
    attemptSuffix: Scenario,
    run: Scenario,
    capMicros = BigInt(30),
  ) {
    const runId = runIdOf(run);
    await ownerDatabase.insert(enterpriseRunAttempts).values({
      tenantId: TENANT,
      runId,
      id: `r4b-rat-${attemptSuffix}`,
      turnId: `r4b-turn-${attemptSuffix}`,
      attemptNo: BigInt(1),
      leaseId: `r4b-lease-${attemptSuffix}`,
      leaseUntil: new Date(Date.now() + 60 * 60 * 1000),
      serviceId: "svc-e4b",
      fencingToken: BigInt(1),
      status: "active",
      contextDigest: DIGEST_C,
    });
    await ownerDatabase.insert(enterpriseRunSteps).values({
      tenantId: TENANT,
      runId,
      id: `r4b-step-${attemptSuffix}`,
      attemptId: `r4b-rat-${attemptSuffix}`,
      stepNo: BigInt(1),
      kind: "model",
      status: "allocated",
      nextCallOrdinal: BigInt(1),
      revision: BigInt(1),
    });
    await ownerDatabase.insert(enterpriseModelCalls).values({
      tenantId: TENANT,
      runId,
      logicalCallId: `r4b-call-${attemptSuffix}`,
      attemptId: `r4b-rat-${attemptSuffix}`,
      stepId: `r4b-step-${attemptSuffix}`,
      callOrdinal: BigInt(1),
      routeId: ROUTE,
      status: "allocated",
    });
    await ownerDatabase.insert(enterpriseModelAttempts).values({
      tenantId: TENANT,
      id: attemptIdOf(attemptSuffix),
      runId,
      attemptId: `r4b-rat-${attemptSuffix}`,
      logicalCallId: `r4b-call-${attemptSuffix}`,
      requestDigest: DIGEST_D,
      routeId: ROUTE,
      priceRevision: BigInt(1),
      reservationId: reservationIdOf(run),
      capMicros,
      status: "reserved",
      leaseId: `r4b-lease-${attemptSuffix}`,
      fencingToken: BigInt(1),
      receiptRevision: BigInt(0),
    });
  }

  const succeededReceipt = (
    s: Scenario,
    revision: string,
    digest: string,
    costMicros: string,
  ): UsageReceipt => ({
    model_attempt_id: attemptIdOf(s),
    receipt_revision: revision,
    evidence_digest: digest,
    status: "succeeded",
    input_tokens: "100",
    output_tokens: "20",
    cost_micros: costMicros,
    provider_request_id: `prov-${s}-${revision}`,
    source: "proxy_response",
  });

  beforeAll(async () => {
    /* owner 按 FK 拓扑清理本 suite 的 fixture；runs↔reservations 延迟互引，
     * 必须同一事务删除。 */
    await ownerDatabase
      .delete(enterpriseUsageEntries)
      .where(eq(enterpriseUsageEntries.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseModelAttempts)
      .where(eq(enterpriseModelAttempts.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseModelCalls)
      .where(eq(enterpriseModelCalls.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseRunSteps)
      .where(eq(enterpriseRunSteps.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseRunAttempts)
      .where(eq(enterpriseRunAttempts.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseModelRoutes)
      .where(eq(enterpriseModelRoutes.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseBudgetBindings)
      .where(eq(enterpriseBudgetBindings.tenantId, TENANT));
    await ownerDatabase.transaction(async (tx) => {
      await tx
        .delete(enterpriseRuns)
        .where(eq(enterpriseRuns.tenantId, TENANT));
      await tx
        .delete(enterpriseBudgetReservations)
        .where(eq(enterpriseBudgetReservations.tenantId, TENANT));
    });
    await ownerDatabase
      .delete(enterpriseBudgetAccounts)
      .where(eq(enterpriseBudgetAccounts.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseThreads)
      .where(eq(enterpriseThreads.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseRunReleases)
      .where(eq(enterpriseRunReleases.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseResources)
      .where(eq(enterpriseResources.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseWorkspaces)
      .where(eq(enterpriseWorkspaces.tenantId, TENANT));
    await ownerDatabase
      .delete(enterpriseMemberships)
      .where(eq(enterpriseMemberships.tenantId, TENANT));
    await ownerDatabase
      .delete(enterprisePrincipals)
      .where(eq(enterprisePrincipals.id, PRINCIPAL));
    await ownerDatabase
      .delete(enterpriseTenants)
      .where(eq(enterpriseTenants.id, TENANT));
    await ownerDatabase.delete(users).where(eq(users.id, USER));

    await ownerDatabase
      .insert(users)
      .values({ id: USER, email: "r4b@enterprise-test.invalid" })
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseTenants)
      .values({ id: TENANT, name: "R4B Tenant" })
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterprisePrincipals)
      .values({ id: PRINCIPAL, userId: USER })
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseMemberships)
      .values({ tenantId: TENANT, principalId: PRINCIPAL, role: "member" })
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseWorkspaces)
      .values({ tenantId: TENANT, id: WORKSPACE, name: "B" })
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseResources)
      .values({
        tenantId: TENANT,
        id: RESOURCE,
        workspaceId: WORKSPACE,
        kind: "expert",
      })
      .onConflictDoNothing();
    await ownerDatabase.insert(enterpriseThreads).values(
      ALL_SCENARIOS.map((s) => ({
        tenantId: TENANT,
        id: threadIdOf(s),
        ownerPrincipalId: PRINCIPAL,
        workspaceId: WORKSPACE,
      })),
    );
    await ownerDatabase.insert(enterpriseRunReleases).values({
      tenantId: TENANT,
      id: RELEASE,
      resourceId: RESOURCE,
      versionDigest: "f".repeat(64),
      runtimeCompatibility: "go-v1",
      expertVersion: "1.0.0",
      modelRouteRef: ROUTE,
      inputLimitBytes: BigInt(32768),
      maxModelCalls: BigInt(8),
      maxRunMicros: BigInt(1000000),
      currency: CURRENCY,
      toolManifestDigest: "7".repeat(64),
      toolCount: BigInt(0),
      status: "published",
    });
    await ownerDatabase.insert(enterpriseModelRoutes).values({
      tenantId: TENANT,
      id: ROUTE,
      alias: "chat",
      revision: BigInt(1),
      resourceId: RESOURCE,
      targetRef: "higress/openai-main",
      priceRevision: BigInt(1),
      currency: CURRENCY,
      inputUnitMicros: BigInt(3),
      outputUnitMicros: BigInt(12),
      perRequestMicros: BigInt(250),
      maxInputTokens: BigInt(8192),
      maxOutputTokens: BigInt(2048),
      maxRequestBytes: BigInt(262144),
      protocolProfile: "openai-chat",
      usageProfile: "tokens",
      isDefaultForAlias: true,
      status: "active",
    });

    /* 每个账户组独立的四层账户：s1 上限 100（计划并发 fixture，s1a/s1b 共享），
     * s2 租户层只有 50（任一层不足→全部回滚），s6 周期已过期，
     * s4–s8 预置 held=80（等价 reserve 已发生）。 */
    for (const group of ACCOUNT_GROUPS) {
      const representative = (
        group === "s1" ? "s1a" : group
      ) as Scenario;
      await ownerDatabase
        .insert(enterpriseBudgetAccounts)
        .values(accountRows(group, periodOf(representative)));
    }

    /* s1a/s1b/s2/s3 的 Run＋预留由被测 reserveInTx 在测试事务里创建；
     * s4–s8 由 owner 预种（allocate/settle/close 不经过 reserve 路径）。
     * s6 的 allocated=30 模拟"周期内已分配并提交、结算在到期之后到达"。 */
    for (const s of ["s4", "s5", "s7", "s8"] as const) {
      await seedRunWithReservation(s, BigInt(80));
    }
    await seedRunWithReservation("s6", BigInt(80), BigInt(30));
    await seedAttemptChain("s4", "s4");
    await seedAttemptChain("s5", "s5");
    await seedAttemptChain("s6", "s6");
    await seedAttemptChain("s7", "s7");
    /* s7b 是 s7 Run 上的第二个逻辑调用：冻结后的新分配在 s7 账户组上被拒。 */
    await seedAttemptChain("s7b", "s7");
    await seedAttemptChain("s8", "s8");
  });

  afterAll(async () => {
    await Promise.allSettled([
      ownerDatabase.$client.close(),
      runWriterDatabase.$client.close(),
      runtimeDatabase.$client.close(),
    ]);
  });

  /** 读某个账户组的四层 (spent, held, overage, status)，按 id 稳定排序。 */
  async function accountState(s: Scenario) {
    const rows = await ownerDatabase
      .select({
        id: enterpriseBudgetAccounts.id,
        scopeKind: enterpriseBudgetAccounts.scopeKind,
        spent: enterpriseBudgetAccounts.spentMicros,
        held: enterpriseBudgetAccounts.heldMicros,
        overage: enterpriseBudgetAccounts.overageMicros,
        status: enterpriseBudgetAccounts.status,
      })
      .from(enterpriseBudgetAccounts)
      .where(eq(enterpriseBudgetAccounts.tenantId, TENANT));
    const wanted = accountIdsOf(s);
    return rows
      .filter((row) => wanted.includes(row.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function reservationState(s: Scenario) {
    const rows = await ownerDatabase
      .select()
      .from(enterpriseBudgetReservations)
      .where(eq(enterpriseBudgetReservations.id, reservationIdOf(s)));
    return rows[0];
  }

  describeDb("reserveInTx", () => {
    test("two concurrent 80-micros reserves against a 100-micros budget admit exactly one", async () => {
      /* 计划 fixture：预算 100 微单位、两个并发 Run 各预留 80——只允许一个
       * 成功，spent=0、held=80；失败方整个事务回滚（Run 行也不存在）。 */
      const reserveOnce = (s: Scenario) =>
        runWriterDatabase.$client.begin(async (tx) => {
          await tx.unsafe(RUN_WRITER_CONTEXT_TEXT, [TENANT, PRINCIPAL]);
          await tx.unsafe(INSERT_RUN_TEXT, [
            TENANT,
            runIdOf(s),
            PRINCIPAL,
            USER,
            WORKSPACE,
            threadIdOf(s),
            RELEASE,
            `req-${s}`,
            DIGEST_A,
            "hello budget",
            ROUTE,
            "1",
            DIGEST_B,
            "tenancy-v1",
            reservationIdOf(s),
            "1",
            "1",
            "1",
          ]);
          return budgetPort.reserveInTx(tx, {
            tenantId: TENANT,
            runId: runIdOf(s),
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            expertReleaseId: RELEASE,
            reservationId: reservationIdOf(s),
            capMicros: "80",
            currency: CURRENCY,
            periodId: periodOf(s),
          });
        });

      const results = await Promise.allSettled([
        reserveOnce("s1a"),
        reserveOnce("s1b"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as EnterpriseError).code).toBe(
        "BUDGET_EXCEEDED",
      );

      const accounts = await accountState("s1a");
      expect(accounts).toHaveLength(4);
      for (const account of accounts) {
        expect(account.spent).toBe(BigInt(0));
        expect(account.held).toBe(BigInt(80));
      }
      const s1Reservations = await ownerDatabase
        .select({ id: enterpriseBudgetReservations.id })
        .from(enterpriseBudgetReservations)
        .where(eq(enterpriseBudgetReservations.tenantId, TENANT));
      expect(
        s1Reservations.filter((row) =>
          [reservationIdOf("s1a"), reservationIdOf("s1b")].includes(row.id),
        ),
      ).toHaveLength(1);
      const runs = await ownerDatabase
        .select({ id: enterpriseRuns.id })
        .from(enterpriseRuns)
        .where(eq(enterpriseRuns.tenantId, TENANT));
      expect(
        runs.filter((row) =>
          [runIdOf("s1a"), runIdOf("s1b")].includes(row.id),
        ),
      ).toHaveLength(1);
    });

    test("an insufficient layer rolls the whole reservation back", async () => {
      /* s2 的租户层限额 50：任一层不足 → BUDGET_EXCEEDED，四层全部不落 held，
       * 同事务里的 Run 行一并回滚。 */
      const error = await rejectionOf(() =>
        runWriterDatabase.$client.begin(async (tx) => {
          await tx.unsafe(RUN_WRITER_CONTEXT_TEXT, [TENANT, PRINCIPAL]);
          await tx.unsafe(INSERT_RUN_TEXT, [
            TENANT,
            runIdOf("s2"),
            PRINCIPAL,
            USER,
            WORKSPACE,
            threadIdOf("s2"),
            RELEASE,
            "req-s2",
            DIGEST_A,
            "hello budget",
            ROUTE,
            "1",
            DIGEST_B,
            "tenancy-v1",
            reservationIdOf("s2"),
            "1",
            "1",
            "1",
          ]);
          return budgetPort.reserveInTx(tx, {
            tenantId: TENANT,
            runId: runIdOf("s2"),
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            expertReleaseId: RELEASE,
            reservationId: reservationIdOf("s2"),
            capMicros: "80",
            currency: CURRENCY,
            periodId: periodOf("s2"),
          });
        }),
      );
      expect(error.code).toBe("BUDGET_EXCEEDED");
      /* 计划 03 §9.2：明确的配额拒绝是 429（409 保留给幂等/版本冲突）。 */
      expect(error.status).toBe(429);

      for (const account of await accountState("s2")) {
        expect(account.held).toBe(BigInt(0));
      }
      const leftovers = await ownerDatabase
        .select({ id: enterpriseBudgetReservations.id })
        .from(enterpriseBudgetReservations)
        .where(eq(enterpriseBudgetReservations.id, reservationIdOf("s2")));
      expect(leftovers).toHaveLength(0);
      const runRows = await ownerDatabase
        .select({ id: enterpriseRuns.id })
        .from(enterpriseRuns)
        .where(eq(enterpriseRuns.id, runIdOf("s2")));
      expect(runRows).toHaveLength(0);
    });
  });

  describeDb("allocateCallInTx and settleCallInTx", () => {
    test("reserve, allocate and settle keep all four layers consistent without double charge", async () => {
      /* s3 全流程：reserve 100 → allocate 30 → settle succeeded 20。
       * 四层账户计数一致；重复回执（同 revision 同 digest）不再扣。 */
      const reservationId = await runWriterDatabase.$client.begin(
        async (tx) => {
          await tx.unsafe(RUN_WRITER_CONTEXT_TEXT, [TENANT, PRINCIPAL]);
          await tx.unsafe(INSERT_RUN_TEXT, [
            TENANT,
            runIdOf("s3"),
            PRINCIPAL,
            USER,
            WORKSPACE,
            threadIdOf("s3"),
            RELEASE,
            "req-s3",
            DIGEST_A,
            "hello budget",
            ROUTE,
            "1",
            DIGEST_B,
            "tenancy-v1",
            reservationIdOf("s3"),
            "1",
            "1",
            "1",
          ]);
          return budgetPort.reserveInTx(tx, {
            tenantId: TENANT,
            runId: runIdOf("s3"),
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            expertReleaseId: RELEASE,
            reservationId: reservationIdOf("s3"),
            capMicros: "100",
            currency: CURRENCY,
            periodId: periodOf("s3"),
          });
        },
      );
      expect(reservationId).toBe(reservationIdOf("s3"));

      /* Run＋预留已由 reserve 落库，此刻才种得上 s3 的 attempt 链（FK）。 */
      await seedAttemptChain("s3", "s3");

      await withRuntimeTx(runIdOf("s3"), (tx) =>
        allocateCallInTx(tx, attemptIdOf("s3"), "30"),
      );
      let state = await reservationState("s3");
      expect(state?.allocatedMicros).toBe(BigInt(30));
      expect(state?.heldMicros).toBe(BigInt(100));

      await withRuntimeTx(runIdOf("s3"), (tx) =>
        settleCallInTx(tx, succeededReceipt("s3", "1", DIGEST_E, "20")),
      );
      state = await reservationState("s3");
      expect(state?.spentMicros).toBe(BigInt(20));
      expect(state?.heldMicros).toBe(BigInt(80));
      expect(state?.allocatedMicros).toBe(BigInt(0));

      /* 四层一致：每个账户 spent=20、held=80。 */
      for (const account of await accountState("s3")) {
        expect(account.spent).toBe(BigInt(20));
        expect(account.held).toBe(BigInt(80));
      }

      /* 同 revision 同 digest 的重复结算：不重复扣、不多记 entry。 */
      await withRuntimeTx(runIdOf("s3"), (tx) =>
        settleCallInTx(tx, succeededReceipt("s3", "1", DIGEST_E, "20")),
      );
      const stateAfterReplay = await reservationState("s3");
      expect(stateAfterReplay?.spentMicros).toBe(BigInt(20));
      const entries = await ownerDatabase
        .select({ id: enterpriseUsageEntries.id })
        .from(enterpriseUsageEntries)
        .where(eq(enterpriseUsageEntries.modelAttemptId, attemptIdOf("s3")));
      expect(entries).toHaveLength(1);

      /* 同 revision 不同 digest：409，且不产生任何扣减。 */
      const conflict = await rejectionOf(() =>
        withRuntimeTx(runIdOf("s3"), (tx) =>
          settleCallInTx(tx, succeededReceipt("s3", "1", DIGEST_D, "999")),
        ),
      );
      expect(conflict.code).toBe("SETTLEMENT_REVISION_CONFLICT");
      expect(conflict.status).toBe(409);
      const stateAfterConflict = await reservationState("s3");
      expect(stateAfterConflict?.spentMicros).toBe(BigInt(20));
    });

    test("an unknown receipt releases nothing and close keeps the remainder in reconciliation", async () => {
      /* s4：allocate 30 → settle unknown（allocated/held 都不动）→ close 只
       * 释放 held-allocated=50，状态进 reconciliation、closed_at 为空。 */
      await withRuntimeTx(runIdOf("s4"), (tx) =>
        allocateCallInTx(tx, attemptIdOf("s4"), "30"),
      );
      await withRuntimeTx(runIdOf("s4"), (tx) =>
        settleCallInTx(tx, {
          model_attempt_id: attemptIdOf("s4"),
          receipt_revision: "1",
          evidence_digest: DIGEST_E,
          status: "unknown",
          input_tokens: null,
          output_tokens: null,
          cost_micros: null,
          provider_request_id: "prov-s4",
          source: "proxy_response",
        }),
      );
      let state = await reservationState("s4");
      expect(state?.allocatedMicros).toBe(BigInt(30));
      expect(state?.heldMicros).toBe(BigInt(80));
      expect(state?.spentMicros).toBe(BigInt(0));
      for (const account of await accountState("s4")) {
        expect(account.spent).toBe(BigInt(0));
        expect(account.held).toBe(BigInt(80));
      }
      const attempt = await ownerDatabase
        .select()
        .from(enterpriseModelAttempts)
        .where(eq(enterpriseModelAttempts.id, attemptIdOf("s4")));
      expect(attempt[0]?.usageStatus).toBe("unknown");
      expect(attempt[0]?.chargedMicros).toBeNull();

      await withRuntimeTx(runIdOf("s4"), (tx) =>
        closeReservationInTx(tx, reservationIdOf("s4")),
      );
      state = await reservationState("s4");
      expect(state?.status).toBe("reconciliation");
      expect(state?.closedAt).toBeNull();
      expect(state?.heldMicros).toBe(BigInt(30));
      expect(state?.allocatedMicros).toBe(BigInt(30));
      for (const account of await accountState("s4")) {
        expect(account.held).toBe(BigInt(30));
      }
    });

    test("a not-submitted receipt only returns the allocation and records no charge", async () => {
      /* s5：未提交只减 allocated；不记费用、不动账户。 */
      await withRuntimeTx(runIdOf("s5"), (tx) =>
        allocateCallInTx(tx, attemptIdOf("s5"), "30"),
      );
      await withRuntimeTx(runIdOf("s5"), (tx) =>
        settleCallInTx(tx, {
          model_attempt_id: attemptIdOf("s5"),
          receipt_revision: "1",
          evidence_digest: DIGEST_E,
          status: "not_submitted",
          input_tokens: null,
          output_tokens: null,
          cost_micros: null,
          provider_request_id: null,
          source: "proxy_response",
        }),
      );
      const state = await reservationState("s5");
      expect(state?.allocatedMicros).toBe(BigInt(0));
      expect(state?.heldMicros).toBe(BigInt(80));
      expect(state?.spentMicros).toBe(BigInt(0));
      for (const account of await accountState("s5")) {
        expect(account.spent).toBe(BigInt(0));
        expect(account.held).toBe(BigInt(80));
      }
      const attempt = await ownerDatabase
        .select()
        .from(enterpriseModelAttempts)
        .where(eq(enterpriseModelAttempts.id, attemptIdOf("s5")));
      expect(attempt[0]?.status).toBe("failed");
      expect(attempt[0]?.usageStatus).toBe("confirmed");
      const entries = await ownerDatabase
        .select({ id: enterpriseUsageEntries.id })
        .from(enterpriseUsageEntries)
        .where(eq(enterpriseUsageEntries.modelAttemptId, attemptIdOf("s5")));
      expect(entries).toHaveLength(0);
    });

    test("an expired period refuses new allocation but still collects a submitted fee", async () => {
      /* s6：账户周期已过——新分配拒绝（BUDGET_EXCEEDED），但已提交调用的
       * 费用照收（settle 不看窗口），收完才允许关闭。 */
      const allocation = await rejectionOf(() =>
        withRuntimeTx(runIdOf("s6"), (tx) =>
          allocateCallInTx(tx, attemptIdOf("s6"), "30"),
        ),
      );
      expect(allocation.code).toBe("BUDGET_EXCEEDED");

      await withRuntimeTx(runIdOf("s6"), (tx) =>
        settleCallInTx(tx, succeededReceipt("s6", "1", DIGEST_E, "30")),
      );
      const state = await reservationState("s6");
      expect(state?.spentMicros).toBe(BigInt(30));
      expect(state?.heldMicros).toBe(BigInt(50));
      for (const account of await accountState("s6")) {
        expect(account.spent).toBe(BigInt(30));
        expect(account.held).toBe(BigInt(50));
      }
      /* 收完已提交费用后可以关闭。 */
      await withRuntimeTx(runIdOf("s6"), (tx) =>
        closeReservationInTx(tx, reservationIdOf("s6")),
      );
      const closed = await reservationState("s6");
      expect(closed?.status).toBe("closed");
      expect(closed?.closedAt).not.toBeNull();
    });

    test("an actual above the call cap records true spend, books overage and freezes the account", async () => {
      /* s7：held 80、本调用 cap 30、actual 90 → otherAllocated=0、
       * spendable=80、covered=80、overage=10；真实支出全额入账（不截断），
       * 账户冻结，之后的分配与预留都被拒。 */
      await withRuntimeTx(runIdOf("s7"), (tx) =>
        allocateCallInTx(tx, attemptIdOf("s7"), "30"),
      );
      await withRuntimeTx(runIdOf("s7"), (tx) =>
        settleCallInTx(tx, succeededReceipt("s7", "1", DIGEST_E, "90")),
      );
      const state = await reservationState("s7");
      expect(state?.spentMicros).toBe(BigInt(90));
      expect(state?.heldMicros).toBe(BigInt(0));
      expect(state?.allocatedMicros).toBe(BigInt(0));
      expect(state?.overageMicros).toBe(BigInt(10));
      for (const account of await accountState("s7")) {
        expect(account.spent).toBe(BigInt(90));
        expect(account.held).toBe(BigInt(0));
        expect(account.overage).toBe(BigInt(10));
        expect(account.status).toBe("frozen");
      }
      const attempt = await ownerDatabase
        .select()
        .from(enterpriseModelAttempts)
        .where(eq(enterpriseModelAttempts.id, attemptIdOf("s7")));
      expect(attempt[0]?.chargedMicros).toBe(BigInt(90));
      const entries = await ownerDatabase
        .select({ cost: enterpriseUsageEntries.costMicros })
        .from(enterpriseUsageEntries)
        .where(eq(enterpriseUsageEntries.modelAttemptId, attemptIdOf("s7")));
      expect(entries.map((row) => row.cost)).toEqual([BigInt(90)]);

      /* 超支信号落在 Run 上：对账必需位与原因码，供维护/E4-E 冻结 route。 */
      const flaggedRun = await ownerDatabase
        .select({
          reconciliationRequired: enterpriseRuns.reconciliationRequired,
          reasonCode: enterpriseRuns.reasonCode,
        })
        .from(enterpriseRuns)
        .where(eq(enterpriseRuns.id, runIdOf("s7")));
      expect(flaggedRun[0]?.reconciliationRequired).toBe(true);
      expect(flaggedRun[0]?.reasonCode).toBe("MODEL_BILLING_OVERAGE");

      /* 冻结后：同 Run 的新分配拒绝（s7b 链），同周期的预留也拒绝。 */
      const allocateAfterFreeze = await rejectionOf(() =>
        withRuntimeTx(runIdOf("s7"), (tx) =>
          allocateCallInTx(tx, attemptIdOf("s7b"), "10"),
        ),
      );
      expect(allocateAfterFreeze.code).toBe("BUDGET_EXCEEDED");
      const reserveAfterFreeze = await rejectionOf(() =>
        runWriterDatabase.$client.begin(async (tx) => {
          await tx.unsafe(RUN_WRITER_CONTEXT_TEXT, [TENANT, PRINCIPAL]);
          return budgetPort.reserveInTx(tx, {
            tenantId: TENANT,
            runId: "r4b-run-s7c",
            principalId: PRINCIPAL,
            workspaceId: WORKSPACE,
            expertReleaseId: RELEASE,
            reservationId: "r4b-res-s7c",
            capMicros: "10",
            currency: CURRENCY,
            periodId: periodOf("s7"),
          });
        }),
      );
      expect(reserveAfterFreeze.code).toBe("BUDGET_EXCEEDED");
      const ghost = await ownerDatabase
        .select({ id: enterpriseBudgetReservations.id })
        .from(enterpriseBudgetReservations)
        .where(eq(enterpriseBudgetReservations.id, "r4b-res-s7c"));
      expect(ghost).toHaveLength(0);
    });

    test("a refused allocation never lets the run dial upstream", async () => {
      /* s8：held 80 里申请 90 → BUDGET_EXCEEDED；attempt 停留在 reserved
       * （从未 submitted）、预留与账户原样、无任何账务 entry——余额不足时
       * 上游一次都不拨。 */
      const error = await rejectionOf(() =>
        withRuntimeTx(runIdOf("s8"), (tx) =>
          allocateCallInTx(tx, attemptIdOf("s8"), "90"),
        ),
      );
      expect(error.code).toBe("BUDGET_EXCEEDED");
      const attempt = await ownerDatabase
        .select()
        .from(enterpriseModelAttempts)
        .where(eq(enterpriseModelAttempts.id, attemptIdOf("s8")));
      expect(attempt[0]?.status).toBe("reserved");
      expect(attempt[0]?.submittedAt).toBeNull();
      const state = await reservationState("s8");
      expect(state?.allocatedMicros).toBe(BigInt(0));
      expect(state?.heldMicros).toBe(BigInt(80));
      for (const account of await accountState("s8")) {
        expect(account.held).toBe(BigInt(80));
        expect(account.spent).toBe(BigInt(0));
      }
      const entries = await ownerDatabase
        .select({ id: enterpriseUsageEntries.id })
        .from(enterpriseUsageEntries)
        .where(eq(enterpriseUsageEntries.modelAttemptId, attemptIdOf("s8")));
      expect(entries).toHaveLength(0);
    });
  });
}
