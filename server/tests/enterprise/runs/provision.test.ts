import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import {
  enterpriseBudgetAccounts,
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterpriseModelGrants,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseRunDelegations,
  enterpriseRunGrants,
  enterpriseRunReleases,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { EnterpriseError } from "../../../src/enterprise/errors";
import { createStaticTargetRegistry } from "../../../src/enterprise/models/contracts";
import {
  applyRunProvision,
  EMPTY_TOOL_MANIFEST_DIGEST,
  RunProvisionCommandSchema,
  type RunProvisionCommand,
  type RunProvisionHooks,
} from "../../../src/enterprise/runs/provision";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createResource,
  createWorkspace,
  provisionMember,
} from "../../../src/enterprise/tenancy/provision";
import { beginOperation } from "../../../src/enterprise/tenancy/transaction";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E1-D 离线开通（03 分册 §4.4 测试步骤）。
 *
 * 十一种 mode（六注册＋五撤销）走同一个严格 Zod union 与 `applyRunProvision(tx, command)`：
 * 幂等锚点是 02 的 security_events（事件 id＝operation_id，payload_digest 覆盖全部业务字段），
 * 同 operation_id 内容不同 409；审计失败（既有事件损坏或审计前注入故障）必须整事务回滚、
 * 不留半行；未知 target_ref、未批准专家（不存在的 resource）、未知 route 全部拒绝；
 * 有工具的 release 属于 04 工具面，本 CLI 只接受 tool_count=0 且摘要等于空 manifest；
 * budget-open 固定 spent/held/overage=0 且绝不改写既有账户；五种撤销在 resource/tenant
 * 锁内改状态并提升 revision（或按受限动作删除/置 revoked）。
 *
 * 连接说明（与 E1-C 夹具同一纪律）：现行迁移矩阵里没有任何一个受限角色同时持有运行域
 * 写授权与 security_events INSERT（ob_ent_run_operator 有前者无后者，ob_ent_operator 相反），
 * 因此本包按计划"生产开通仍需单独授权"，测试环境的开通事务在迁移 owner 连接上执行——
 * 与 enterprise-runtime-seed.ts / E1-C 直接 fixture 的既定方式一致；生产接线（专用开通角色
 * 或补授权迁移）不在本包范围内。身份链仍走 02 领域函数与受限登录，绝不手写 SQL 绕过。
 */

const PREFIX = "r1d-";
const TENANT = `${PREFIX}tenant-a`;
const TENANT_NAME = "R1D Tenant A";
const USER_A = `${PREFIX}user-a`;
const USER_OUT = `${PREFIX}user-out`;
const PRINCIPAL_A = `${PREFIX}principal-a`;
const PRINCIPAL_OUT = `${PREFIX}principal-out`;
const WORKSPACE = `${PREFIX}workspace-a`;
const RESOURCE = `${PREFIX}resource-a`;
const OPERATOR = `${PREFIX}operator`;
const CURRENCY = "USD";

/* 测试把申请的 target 注册进部署映射；不在映射里的 target_ref 必须被拒绝。 */
const KNOWN_TARGET = "openai/gpt-test";
const TARGETS = createStaticTargetRegistry([KNOWN_TARGET]);

type RouteRegisterCommand = Extract<RunProvisionCommand, { mode: "route-register" }>;
type ReleaseRegisterCommand = Extract<RunProvisionCommand, { mode: "release-register" }>;
type RunGrantCommand = Extract<RunProvisionCommand, { mode: "run-grant" }>;
type ModelGrantCommand = Extract<RunProvisionCommand, { mode: "model-grant" }>;
type BudgetOpenCommand = Extract<RunProvisionCommand, { mode: "budget-open" }>;
type DelegationRegisterCommand = Extract<
  RunProvisionCommand,
  { mode: "delegation-register" }
>;
type DisableReleaseCommand = Extract<RunProvisionCommand, { mode: "disable-release" }>;
type RevokeRunGrantCommand = Extract<RunProvisionCommand, { mode: "revoke-run-grant" }>;
type DisableRouteCommand = Extract<RunProvisionCommand, { mode: "disable-route" }>;
type RevokeModelGrantCommand = Extract<
  RunProvisionCommand,
  { mode: "revoke-model-grant" }
>;
type RevokeDelegationCommand = Extract<
  RunProvisionCommand,
  { mode: "revoke-delegation" }
>;

/* ---------------------------------------------------------------------------
 * 数据库探针：环境或角色缺失时按本套件纪律 fail-closed 跳过真实库断言，绝不换替身。
 * ------------------------------------------------------------------------ */

async function probeProvisionDatabase(): Promise<{ ready: boolean; reason: string }> {
  let client:
    | { unsafe: (query: string) => Promise<unknown[]>; close: () => Promise<void> }
    | undefined;
  try {
    const { SQL } = await import("bun");
    const url = testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const opened = new SQL(url, { max: 1, connectionTimeout: 5 });
    client = opened;
    const tables = await opened.unsafe(
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_run_releases'",
    );
    if (tables.length === 0) {
      return { ready: false, reason: "migrations not applied to the test database" };
    }
    const roles = await opened.unsafe(
      "select rolname from pg_roles where rolname in ('ob_ent_operator','ob_ent_identity_operator')",
    );
    if (roles.length < 2) {
      return { ready: false, reason: "02 operator roles missing; run enterprise-test-db.ts roles" };
    }
    const missing = [
      "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
      "ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL",
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

const probe = await probeProvisionDatabase();
const describeDb = probe.ready ? describe : describe.skip;
if (!probe.ready) {
  console.warn(`[provision.test.ts] real-database assertions skipped: ${probe.reason}`);
}

/* ---------------------------------------------------------------------------
 * 命令构造器：每个注册/撤销 mode 一个合法基线，测试只覆写关注字段。
 * ------------------------------------------------------------------------ */

const base = { tenant_id: TENANT, operator: OPERATOR };

const routeCommand = (
  overrides: Partial<Omit<RouteRegisterCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-route-1`,
): RouteRegisterCommand => ({
  mode: "route-register",
  ...base,
  id: `${PREFIX}route-1`,
  resource_id: RESOURCE,
  alias: "chat",
  revision: "1",
  target_ref: KNOWN_TARGET,
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
  ...overrides,
  operation_id: operationId,
});

const releaseCommand = (
  overrides: Partial<Omit<ReleaseRegisterCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-release-1`,
): ReleaseRegisterCommand => ({
  mode: "release-register",
  ...base,
  id: `${PREFIX}release-1`,
  resource_id: RESOURCE,
  version_digest: "a".repeat(64),
  runtime_compatibility: "go-v1",
  expert_version: "1.0.0",
  model_route_ref: `${PREFIX}route-1`,
  input_limit_bytes: 32768,
  max_model_calls: 8,
  max_run_micros: "1000000",
  currency: CURRENCY,
  tool_manifest_digest: EMPTY_TOOL_MANIFEST_DIGEST,
  tool_count: 0,
  ...overrides,
  operation_id: operationId,
});

const runGrantCommand = (
  overrides: Partial<Omit<RunGrantCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-run-grant-1`,
): RunGrantCommand => ({
  mode: "run-grant",
  ...base,
  release_id: `${PREFIX}release-1`,
  principal_id: PRINCIPAL_A,
  action: "start",
  ...overrides,
  operation_id: operationId,
});

const modelGrantCommand = (
  overrides: Partial<Omit<ModelGrantCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-model-grant-1`,
): ModelGrantCommand => ({
  mode: "model-grant",
  ...base,
  route_id: `${PREFIX}route-1`,
  principal_id: PRINCIPAL_A,
  ...overrides,
  operation_id: operationId,
});

const budgetCommand = (
  overrides: Partial<Omit<BudgetOpenCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-budget-1`,
): BudgetOpenCommand => ({
  mode: "budget-open",
  ...base,
  id: `${PREFIX}acc-tenant`,
  scope_kind: "tenant",
  scope_ref: TENANT,
  period_id: "2026-10-r1d",
  starts_at: "2026-10-01T00:00:00Z",
  ends_at: "2026-11-01T00:00:00Z",
  currency: CURRENCY,
  limit_micros: "10000000",
  ...overrides,
  operation_id: operationId,
});

const delegationCommand = (
  overrides: Partial<Omit<DelegationRegisterCommand, "mode" | "tenant_id">> = {},
  operationId = `${PREFIX}op-delegation-1`,
): DelegationRegisterCommand => ({
  mode: "delegation-register",
  ...base,
  id: `${PREFIX}delegation-1`,
  principal_id: PRINCIPAL_A,
  release_id: `${PREFIX}release-1`,
  route_id: `${PREFIX}route-1`,
  max_run_micros: "500000",
  max_runs: 20,
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  ...overrides,
  operation_id: operationId,
});

/* ---------------------------------------------------------------------------
 * 纯 Zod union 负向 case（不触库）：严格 union、每种 mode 只允许对应字段。
 * ------------------------------------------------------------------------ */

describe("E1-D provision strict union", () => {
  test("the eleven planned modes are the exact union", () => {
    const commands: RunProvisionCommand[] = [
      routeCommand(),
      releaseCommand(),
      runGrantCommand(),
      modelGrantCommand(),
      budgetCommand(),
      delegationCommand(),
      {
        mode: "disable-release",
        ...base,
        operation_id: `${PREFIX}op-x1`,
        id: `${PREFIX}release-1`,
        reason: "sunset",
      } satisfies DisableReleaseCommand,
      {
        mode: "revoke-run-grant",
        ...base,
        operation_id: `${PREFIX}op-x2`,
        release_id: `${PREFIX}release-1`,
        principal_id: PRINCIPAL_A,
        action: "start",
        reason: "offboarding",
      } satisfies RevokeRunGrantCommand,
      {
        mode: "disable-route",
        ...base,
        operation_id: `${PREFIX}op-x3`,
        id: `${PREFIX}route-1`,
        reason: "price rotate",
      } satisfies DisableRouteCommand,
      {
        mode: "revoke-model-grant",
        ...base,
        operation_id: `${PREFIX}op-x4`,
        route_id: `${PREFIX}route-1`,
        principal_id: PRINCIPAL_A,
        reason: "offboarding",
      } satisfies RevokeModelGrantCommand,
      {
        mode: "revoke-delegation",
        ...base,
        operation_id: `${PREFIX}op-x5`,
        id: `${PREFIX}delegation-1`,
        reason: "pilot ended",
      } satisfies RevokeDelegationCommand,
    ];
    for (const command of commands) {
      expect(RunProvisionCommandSchema.safeParse(command).success).toBe(true);
    }
  });

  test("unknown modes and cross-mode fields are refused", () => {
    expect(
      RunProvisionCommandSchema.safeParse({
        ...routeCommand(),
        mode: "route-delete",
      }).success,
    ).toBe(false);
    /* run-grant 想携带 release-register 的 id 字段：拒绝。 */
    expect(
      RunProvisionCommandSchema.safeParse({
        ...runGrantCommand(),
        id: `${PREFIX}release-1`,
      }).success,
    ).toBe(false);
    /* route-register 想携带 model-grant 的 principal_id：拒绝。 */
    expect(
      RunProvisionCommandSchema.safeParse({
        ...routeCommand(),
        principal_id: PRINCIPAL_A,
      }).success,
    ).toBe(false);
    /* budget-open 想替服务端预置 spent：拒绝——初始发生值由服务端固定为 0。 */
    expect(
      RunProvisionCommandSchema.safeParse({
        ...budgetCommand(),
        spent_micros: "1",
      }).success,
    ).toBe(false);
  });

  test("amounts are decimal strings, dates carry a timezone, ids use the ID schema", () => {
    expect(
      RunProvisionCommandSchema.safeParse({
        ...releaseCommand(),
        max_run_micros: 1000,
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...budgetCommand(),
        starts_at: "2026-10-01T00:00:00",
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...budgetCommand(),
        ends_at: "2026-10-32T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...delegationCommand(),
        max_runs: 0,
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...delegationCommand(),
        max_runs: 1.5,
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...releaseCommand(),
        tool_count: -1,
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...releaseCommand(),
        id: "bad id with spaces",
      }).success,
    ).toBe(false);
  });

  test("revocations carry a reason and nothing beyond their own ids", () => {
    expect(
      RunProvisionCommandSchema.safeParse({
        mode: "disable-route",
        ...base,
        operation_id: `${PREFIX}op-noreason`,
        id: `${PREFIX}route-1`,
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        mode: "revoke-delegation",
        ...base,
        operation_id: `${PREFIX}op-x6`,
        id: `${PREFIX}delegation-1`,
        reason: "pilot ended",
        release_id: `${PREFIX}release-1`,
      }).success,
    ).toBe(false);
  });

  test("the target is a registry key, never a URL or free-form text", () => {
    /* 形状层：带空白/无法成为 registry key 的输入直接拒绝。 */
    expect(
      RunProvisionCommandSchema.safeParse({
        ...routeCommand(),
        target_ref: "openai gpt test",
      }).success,
    ).toBe(false);
    expect(
      RunProvisionCommandSchema.safeParse({
        ...routeCommand(),
        target_ref: "",
      }).success,
    ).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * 真实库验收。
 * ------------------------------------------------------------------------ */

let db: Database;
let operatorDb: Database;
let identityDb: Database;

async function applyRun(
  command: RunProvisionCommand,
  hooks: RunProvisionHooks = {},
): Promise<void> {
  return beginOperation(db, (tx) =>
    applyRunProvision(tx, command, { targets: TARGETS, hooks }),
  );
}

async function errorOf(
  run: () => Promise<unknown>,
): Promise<EnterpriseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnterpriseError) {
      return error;
    }
    throw new Error(`expected an EnterpriseError, got: ${String(error)}`);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}

async function auditCount(operationId: string): Promise<number> {
  const rows = await db
    .select({ id: enterpriseSecurityEvents.id })
    .from(enterpriseSecurityEvents)
    .where(
      and(
        eq(enterpriseSecurityEvents.tenantId, TENANT),
        eq(enterpriseSecurityEvents.id, operationId),
      ),
    );
  return rows.length;
}

async function routeRow(id: string) {
  const rows = await db
    .select()
    .from(enterpriseModelRoutes)
    .where(
      and(
        eq(enterpriseModelRoutes.tenantId, TENANT),
        eq(enterpriseModelRoutes.id, id),
      ),
    )
    .limit(1);
  return rows[0];
}

async function releaseRow(id: string) {
  const rows = await db
    .select()
    .from(enterpriseRunReleases)
    .where(
      and(
        eq(enterpriseRunReleases.tenantId, TENANT),
        eq(enterpriseRunReleases.id, id),
      ),
    )
    .limit(1);
  return rows[0];
}

/* ---------------------------------------------------------------------------
 * CLI 子进程辅助：spawn 即重试的空输出纪律与 02 册 provision.test.ts 相同。
 * ------------------------------------------------------------------------ */

const SERVER_ROOT = new URL("../../../", import.meta.url).pathname;

type CliRun = { code: number; out: string; err: string };

async function runCli(
  args: ReadonlyArray<string>,
  environment: Record<string, string | undefined> = {},
): Promise<CliRun> {
  /* 与 02 册 provision.test.ts 同一纪律：空 stdout+stderr 不是任何 CLI 能产出的行为，
   * 是 spawn 层故障；指数退避重试，重试耗尽把观测编码进 err，绝不伪装成功。 */
  for (let attempt = 1; ; attempt += 1) {
    let code: number;
    let out = "";
    let err = "";
    try {
      const { stdout, stderr, exitCode } = Bun.spawnSync(
        ["bun", "--no-env-file", "scripts/enterprise-run-provision.ts", ...args],
        {
          cwd: SERVER_ROOT,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      code = exitCode;
      out = stdout.toString();
      err = stderr.toString();
    } catch (spawnError) {
      code = -1;
      err = `[spawn] ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`;
    }
    if (out.length > 0 || err.length > 0) {
      return { code, out, err };
    }
    if (attempt >= 4) {
      return { code, out, err: `[spawn-observability] attempts exhausted (${attempt})` };
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
}

const runGrantInput = JSON.stringify({
  release_id: `${PREFIX}release-1`,
  principal_id: PRINCIPAL_A,
  action: "start",
});

describeDb("E1-D offline provisioning", () => {
  beforeAll(async () => {
    db = createDatabase(
      testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
      { max: 2 },
    );
    operatorDb = createDatabase(
      testDatabaseUrlFrom({
        TEST_DATABASE_URL: process.env.ENTERPRISE_TEST_OPERATOR_DATABASE_URL,
      }),
      { max: 1 },
    );
    identityDb = createDatabase(
      testDatabaseUrlFrom({
        TEST_DATABASE_URL:
          process.env.ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL,
      }),
      { max: 1 },
    );

    /* 清理本夹具上一次运行的 r1d- 行（FK 拓扑子表在前），再经 02 领域函数重建身份链。 */
    for (const table of [
      enterpriseRunDelegations,
      enterpriseModelGrants,
      enterpriseRunGrants,
      enterpriseBudgetAccounts,
      enterpriseModelRoutes,
      enterpriseRunReleases,
    ] as const) {
      await db.delete(table).where(eq(table.tenantId, TENANT));
    }
    for (const table of [
      enterpriseResources,
      enterpriseWorkspaces,
      enterpriseMemberships,
    ] as const) {
      await db.delete(table).where(eq(table.tenantId, TENANT));
    }
    await db
      .delete(enterpriseSecurityEvents)
      .where(like(enterpriseSecurityEvents.id, `${PREFIX}%`));
    await db
      .delete(enterpriseIdentityEvents)
      .where(like(enterpriseIdentityEvents.id, `${PREFIX}%`));
    await db
      .delete(enterprisePrincipals)
      .where(inArray(enterprisePrincipals.id, [PRINCIPAL_A, PRINCIPAL_OUT]));
    await db
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [TENANT]));
    await db
      .delete(users)
      .where(inArray(users.id, [USER_A, USER_OUT]));

    await db.insert(users).values([
      { id: USER_A, email: `${PREFIX}a@enterprise-test.invalid` },
      { id: USER_OUT, email: `${PREFIX}out@enterprise-test.invalid` },
    ]);
    await createPrincipal(identityDb, {
      principalId: PRINCIPAL_A,
      userId: USER_A,
      operator: OPERATOR,
      operationId: `${PREFIX}op-principal-a`,
    });
    await createPrincipal(identityDb, {
      principalId: PRINCIPAL_OUT,
      userId: USER_OUT,
      operator: OPERATOR,
      operationId: `${PREFIX}op-principal-out`,
    });
    await provisionMember(operatorDb, {
      tenantId: TENANT,
      tenantName: TENANT_NAME,
      principalId: PRINCIPAL_A,
      userId: USER_A,
      role: "member",
      operator: OPERATOR,
      operationId: `${PREFIX}op-member-a`,
    });
    await createWorkspace(operatorDb, {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      name: `${PREFIX}workspace`,
      operator: OPERATOR,
      operationId: `${PREFIX}op-workspace-a`,
    });
    await createResource(operatorDb, {
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      resourceId: RESOURCE,
      kind: "document",
      operator: OPERATOR,
      operationId: `${PREFIX}op-resource-a`,
    });
  });

  afterAll(async () => {
    /* 只清理本夹具的 r1d- 行，不碰其他测试数据；先 cleanup 再关连接。 */
    if (db !== undefined) {
      for (const table of [
        enterpriseRunDelegations,
        enterpriseModelGrants,
        enterpriseRunGrants,
        enterpriseBudgetAccounts,
        enterpriseModelRoutes,
        enterpriseRunReleases,
      ] as const) {
        await db.delete(table).where(eq(table.tenantId, TENANT));
      }
      for (const table of [
        enterpriseResources,
        enterpriseWorkspaces,
        enterpriseMemberships,
      ] as const) {
        await db.delete(table).where(eq(table.tenantId, TENANT));
      }
      await db
        .delete(enterpriseSecurityEvents)
        .where(like(enterpriseSecurityEvents.id, `${PREFIX}%`));
      await db
        .delete(enterpriseIdentityEvents)
        .where(like(enterpriseIdentityEvents.id, `${PREFIX}%`));
      await db
        .delete(enterprisePrincipals)
        .where(inArray(enterprisePrincipals.id, [PRINCIPAL_A, PRINCIPAL_OUT]));
      await db
        .delete(enterpriseTenants)
        .where(inArray(enterpriseTenants.id, [TENANT]));
      await db.delete(users).where(inArray(users.id, [USER_A, USER_OUT]));
      await db.$client.close();
    }
    await operatorDb?.$client.close();
    await identityDb?.$client.close();
  });

  test("route-register inserts the server-owned active row and audits once; replay writes nothing", async () => {
    await applyRun(routeCommand());
    const row = await routeRow(`${PREFIX}route-1`);
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
    expect(row?.revision).toBe(1n);
    expect(row?.targetRef).toBe(KNOWN_TARGET);
    expect(row?.isDefaultForAlias).toBe(true);
    expect(await auditCount(`${PREFIX}op-route-1`)).toBe(1);

    await applyRun(routeCommand());
    expect(await auditCount(`${PREFIX}op-route-1`)).toBe(1);
    const after = await routeRow(`${PREFIX}route-1`);
    expect(after?.createdAt?.getTime()).toBe(row?.createdAt?.getTime());
  });

  test("the same operation_id with different content is a 409", async () => {
    const error = await errorOf(() =>
      applyRun(routeCommand({ price_revision: "2" })),
    );
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(error.status).toBe(409);
    const row = await routeRow(`${PREFIX}route-1`);
    expect(row?.priceRevision).toBe(1n);
  });

  test("route conflicts: same alias+revision or second default for the alias", async () => {
    const revisionClash = await errorOf(() =>
      applyRun(
        routeCommand({ id: `${PREFIX}route-clash` }, `${PREFIX}op-route-clash`),
      ),
    );
    expect(revisionClash.code).toBe("ROUTE_REVISION_CONFLICT");

    const defaultClash = await errorOf(() =>
      applyRun(
        routeCommand(
          { id: `${PREFIX}route-second-default`, revision: "2" },
          `${PREFIX}op-route-second-default`,
        ),
      ),
    );
    expect(defaultClash.code).toBe("ROUTE_DEFAULT_CONFLICT");
  });

  test("an unknown target_ref is refused closed with no row and no audit", async () => {
    const unknown = await errorOf(() =>
      applyRun(
        routeCommand(
          {
            id: `${PREFIX}route-unknown-target`,
            alias: "chat-unknown-target",
            revision: "3",
            is_default_for_alias: false,
            target_ref: "nobody/never",
          },
          `${PREFIX}op-route-unknown-target`,
        ),
      ),
    );
    expect(unknown.code).toBe("MODEL_TARGET_UNKNOWN");
    expect(await routeRow(`${PREFIX}route-unknown-target`)).toBeUndefined();
    expect(await auditCount(`${PREFIX}op-route-unknown-target`)).toBe(0);

    /* 用户输入的 URI 不是 registry key：部署映射里没有它，绝不能变成 target。 */
    const uri = await errorOf(() =>
      applyRun(
        routeCommand(
          {
            id: `${PREFIX}route-uri`,
            alias: "chat-uri",
            revision: "4",
            is_default_for_alias: false,
            target_ref: "https://evil.example.com/v1",
          },
          `${PREFIX}op-route-uri`,
        ),
      ),
    );
    expect(uri.code).toBe("MODEL_TARGET_UNKNOWN");
    expect(await routeRow(`${PREFIX}route-uri`)).toBeUndefined();
  });

  test("release-register inserts the published row; replay writes nothing", async () => {
    await applyRun(releaseCommand());
    const row = await releaseRow(`${PREFIX}release-1`);
    expect(row).toBeDefined();
    expect(row?.status).toBe("published");
    expect(row?.toolCount).toBe(0n);
    expect(await auditCount(`${PREFIX}op-release-1`)).toBe(1);

    await applyRun(releaseCommand());
    expect(await auditCount(`${PREFIX}op-release-1`)).toBe(1);
  });

  test("an unapproved expert (unknown resource) is refused", async () => {
    const error = await errorOf(() =>
      applyRun(
        releaseCommand(
          { resource_id: `${PREFIX}resource-none` },
          `${PREFIX}op-release-unapproved`,
        ),
      ),
    );
    expect(error.code).toBe("RESOURCE_NOT_FOUND");
    expect(await releaseRow(`${PREFIX}release-unapproved`)).toBeUndefined();
  });

  test("a release naming an unregistered route is refused", async () => {
    const error = await errorOf(() =>
      applyRun(
        releaseCommand(
          { id: `${PREFIX}release-badroute`, model_route_ref: `${PREFIX}route-none` },
          `${PREFIX}op-release-badroute`,
        ),
      ),
    );
    expect(error.code).toBe("RELEASE_MODEL_ROUTE_NOT_FOUND");
  });

  test("tool-carrying manifests belong to the tool plane, not this CLI", async () => {
    const withTools = await errorOf(() =>
      applyRun(
        releaseCommand({ tool_count: 2 }, `${PREFIX}op-release-tools`),
      ),
    );
    expect(withTools.code).toBe("RELEASE_TOOLS_REQUIRE_TOOL_PLANE");

    const zeroWithManifest = await errorOf(() =>
      applyRun(
        releaseCommand(
          { tool_manifest_digest: "b".repeat(64) },
          `${PREFIX}op-release-zero-manifest`,
        ),
      ),
    );
    expect(zeroWithManifest.code).toBe("RELEASE_TOOL_MANIFEST_MISMATCH");
  });

  test("the same release id with different content under a new operation is a 409", async () => {
    const error = await errorOf(() =>
      applyRun(
        releaseCommand(
          { max_run_micros: "2000000" },
          `${PREFIX}op-release-diff`,
        ),
      ),
    );
    expect(error.code).toBe("RELEASE_CONFLICT");
    const row = await releaseRow(`${PREFIX}release-1`);
    expect(row?.maxRunMicros).toBe(1000000n);
  });

  test("run-grant inserts revision 1; replay adds nothing; non-members are refused", async () => {
    await applyRun(runGrantCommand());
    const rows = await db
      .select()
      .from(enterpriseRunGrants)
      .where(
        and(
          eq(enterpriseRunGrants.tenantId, TENANT),
          eq(enterpriseRunGrants.releaseId, `${PREFIX}release-1`),
          eq(enterpriseRunGrants.principalId, PRINCIPAL_A),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe(1n);
    expect(await auditCount(`${PREFIX}op-run-grant-1`)).toBe(1);

    await applyRun(runGrantCommand());
    expect(await auditCount(`${PREFIX}op-run-grant-1`)).toBe(1);

    const unknownRelease = await errorOf(() =>
      applyRun(
        runGrantCommand(
          { release_id: `${PREFIX}release-none` },
          `${PREFIX}op-run-grant-none`,
        ),
      ),
    );
    expect(unknownRelease.code).toBe("RELEASE_NOT_FOUND");

    const outsider = await errorOf(() =>
      applyRun(
        runGrantCommand(
          { principal_id: PRINCIPAL_OUT },
          `${PREFIX}op-run-grant-out`,
        ),
      ),
    );
    expect(outsider.code).toBe("MEMBERSHIP_NOT_FOUND");
  });

  test("model-grant inserts active revision 1; replay writes nothing; unknown route refused", async () => {
    await applyRun(modelGrantCommand());
    const rows = await db
      .select()
      .from(enterpriseModelGrants)
      .where(
        and(
          eq(enterpriseModelGrants.tenantId, TENANT),
          eq(enterpriseModelGrants.routeId, `${PREFIX}route-1`),
          eq(enterpriseModelGrants.principalId, PRINCIPAL_A),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.revision).toBe(1n);

    await applyRun(modelGrantCommand());
    expect(await auditCount(`${PREFIX}op-model-grant-1`)).toBe(1);

    const unknown = await errorOf(() =>
      applyRun(
        modelGrantCommand(
          { route_id: `${PREFIX}route-none` },
          `${PREFIX}op-model-grant-none`,
        ),
      ),
    );
    expect(unknown.code).toBe("ROUTE_NOT_FOUND");
  });

  test("budget-open fixes spent/held/overage to zero and never rewrites an existing account", async () => {
    await applyRun(budgetCommand());
    const rows = await db
      .select()
      .from(enterpriseBudgetAccounts)
      .where(
        and(
          eq(enterpriseBudgetAccounts.tenantId, TENANT),
          eq(enterpriseBudgetAccounts.id, `${PREFIX}acc-tenant`),
        ),
      );
    expect(rows).toHaveLength(1);
    const account = rows[0];
    expect(account?.spentMicros).toBe(0n);
    expect(account?.heldMicros).toBe(0n);
    expect(account?.overageMicros).toBe(0n);
    expect(account?.status).toBe("active");
    expect(account?.revision).toBe(1n);

    /* 同一身份不同限额＝冲突，且既有账户的限额与已发生值原样保留。 */
    const clash = await errorOf(() =>
      applyRun(budgetCommand({ limit_micros: "777" }, `${PREFIX}op-budget-clash`)),
    );
    expect(clash.code).toBe("BUDGET_CONFLICT");
    const after = await db
      .select()
      .from(enterpriseBudgetAccounts)
      .where(
        and(
          eq(enterpriseBudgetAccounts.tenantId, TENANT),
          eq(enterpriseBudgetAccounts.id, `${PREFIX}acc-tenant`),
        ),
      );
    expect(after[0]?.limitMicros).toBe(10000000n);
    expect(after[0]?.spentMicros).toBe(0n);

    /* 倒置的周期窗口在写库前拒绝。 */
    const inverted = await errorOf(() =>
      applyRun(
        budgetCommand(
          { id: `${PREFIX}acc-bad`, starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" },
          `${PREFIX}op-budget-inverted`,
        ),
      ),
    );
    expect(inverted.code).toBe("PERIOD_INVALID");
  });

  test("delegation-register pins the pilot terms; expired terms and unknown anchors are refused", async () => {
    await applyRun(delegationCommand());
    const rows = await db
      .select()
      .from(enterpriseRunDelegations)
      .where(
        and(
          eq(enterpriseRunDelegations.tenantId, TENANT),
          eq(enterpriseRunDelegations.id, `${PREFIX}delegation-1`),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedRuns).toBe(0n);
    expect(rows[0]?.revision).toBe(1n);
    expect(rows[0]?.revokedAt).toBeNull();

    const expired = await errorOf(() =>
      applyRun(
        delegationCommand(
          { id: `${PREFIX}delegation-expired`, expires_at: "2020-01-01T00:00:00Z" },
          `${PREFIX}op-delegation-expired`,
        ),
      ),
    );
    expect(expired.code).toBe("DELEGATION_EXPIRED");

    const unknownRelease = await errorOf(() =>
      applyRun(
        delegationCommand(
          { id: `${PREFIX}delegation-norelease`, release_id: `${PREFIX}release-none` },
          `${PREFIX}op-delegation-norelease`,
        ),
      ),
    );
    expect(unknownRelease.code).toBe("RELEASE_NOT_FOUND");
  });

  test("disable-release flips the status once and audits further no-ops", async () => {
    await applyRun(releaseCommand({ id: `${PREFIX}release-2` }, `${PREFIX}op-release-2`));
    const disable: DisableReleaseCommand = {
      mode: "disable-release",
      ...base,
      operation_id: `${PREFIX}op-disable-release-1`,
      id: `${PREFIX}release-2`,
      reason: "sunset",
    };
    await applyRun(disable);
    expect((await releaseRow(`${PREFIX}release-2`))?.status).toBe("disabled");

    await applyRun({
      ...disable,
      operation_id: `${PREFIX}op-disable-release-2`,
    });
    expect((await releaseRow(`${PREFIX}release-2`))?.status).toBe("disabled");
    expect(await auditCount(`${PREFIX}op-disable-release-2`)).toBe(1);

    const unknown = await errorOf(() =>
      applyRun({
        mode: "disable-release",
        ...base,
        operation_id: `${PREFIX}op-disable-release-none`,
        id: `${PREFIX}release-none`,
        reason: "typo",
      }),
    );
    expect(unknown.code).toBe("RELEASE_NOT_FOUND");
  });

  test("revoke-run-grant deletes the grant; replay is an audited no-op", async () => {
    await applyRun(runGrantCommand({}, `${PREFIX}op-run-grant-2`));
    const revoke: RevokeRunGrantCommand = {
      mode: "revoke-run-grant",
      ...base,
      operation_id: `${PREFIX}op-revoke-run-grant-1`,
      release_id: `${PREFIX}release-1`,
      principal_id: PRINCIPAL_A,
      action: "start",
      reason: "offboarding",
    };
    await applyRun(revoke);
    const rows = await db
      .select()
      .from(enterpriseRunGrants)
      .where(
        and(
          eq(enterpriseRunGrants.tenantId, TENANT),
          eq(enterpriseRunGrants.releaseId, `${PREFIX}release-1`),
          eq(enterpriseRunGrants.principalId, PRINCIPAL_A),
          eq(enterpriseRunGrants.action, "start"),
        ),
      );
    expect(rows).toHaveLength(0);

    await applyRun({ ...revoke, operation_id: `${PREFIX}op-revoke-run-grant-2` });
    expect(await auditCount(`${PREFIX}op-revoke-run-grant-2`)).toBe(1);
    expect(rows).toHaveLength(0);

    /* 已删除过的 grant 再撤＝审计过的 no-change；父 release 不存在＝404（拼写保护）。 */
    await applyRun({
      ...revoke,
      operation_id: `${PREFIX}op-revoke-run-grant-3`,
    });
    expect(await auditCount(`${PREFIX}op-revoke-run-grant-3`)).toBe(1);

    const unknown = await errorOf(() =>
      applyRun({
        ...revoke,
        release_id: `${PREFIX}release-none`,
        operation_id: `${PREFIX}op-revoke-run-grant-none`,
      }),
    );
    expect(unknown.code).toBe("RELEASE_NOT_FOUND");
  });

  test("disable-route bumps the revision only on the actual flip", async () => {
    await applyRun(
      routeCommand(
        { id: `${PREFIX}route-2`, alias: "chat2", revision: "1", is_default_for_alias: false },
        `${PREFIX}op-route-2`,
      ),
    );
    const disable: DisableRouteCommand = {
      mode: "disable-route",
      ...base,
      operation_id: `${PREFIX}op-disable-route-1`,
      id: `${PREFIX}route-2`,
      reason: "price rotate",
    };
    await applyRun(disable);
    let row = await routeRow(`${PREFIX}route-2`);
    expect(row?.status).toBe("disabled");
    expect(row?.revision).toBe(2n);

    await applyRun({ ...disable, operation_id: `${PREFIX}op-disable-route-2` });
    row = await routeRow(`${PREFIX}route-2`);
    expect(row?.status).toBe("disabled");
    expect(row?.revision).toBe(2n);

    const unknown = await errorOf(() =>
      applyRun({
        mode: "disable-route",
        ...base,
        operation_id: `${PREFIX}op-disable-route-none`,
        id: `${PREFIX}route-none`,
        reason: "typo",
      }),
    );
    expect(unknown.code).toBe("ROUTE_NOT_FOUND");
  });

  test("revoke-model-grant marks revoked and bumps the revision once", async () => {
    /* (route, principal) 是主键：撤销的就是 model-grant 用例里建的那一行（revision 1）。 */
    const revoke: RevokeModelGrantCommand = {
      mode: "revoke-model-grant",
      ...base,
      operation_id: `${PREFIX}op-revoke-model-grant-1`,
      route_id: `${PREFIX}route-1`,
      principal_id: PRINCIPAL_A,
      reason: "offboarding",
    };
    await applyRun(revoke);
    let rows = await db
      .select()
      .from(enterpriseModelGrants)
      .where(
        and(
          eq(enterpriseModelGrants.tenantId, TENANT),
          eq(enterpriseModelGrants.routeId, `${PREFIX}route-1`),
          eq(enterpriseModelGrants.principalId, PRINCIPAL_A),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.revision).toBe(2n);

    await applyRun({ ...revoke, operation_id: `${PREFIX}op-revoke-model-grant-2` });
    rows = await db
      .select()
      .from(enterpriseModelGrants)
      .where(
        and(
          eq(enterpriseModelGrants.tenantId, TENANT),
          eq(enterpriseModelGrants.routeId, `${PREFIX}route-1`),
          eq(enterpriseModelGrants.principalId, PRINCIPAL_A),
        ),
      );
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.revision).toBe(2n);

    /* 已 revoked 再撤＝审计过的 no-change；route 不存在＝404（拼写保护）。 */
    await applyRun({
      ...revoke,
      operation_id: `${PREFIX}op-revoke-model-grant-3`,
    });
    expect(await auditCount(`${PREFIX}op-revoke-model-grant-3`)).toBe(1);

    const unknown = await errorOf(() =>
      applyRun({
        ...revoke,
        route_id: `${PREFIX}route-none`,
        operation_id: `${PREFIX}op-revoke-model-grant-none`,
      }),
    );
    expect(unknown.code).toBe("ROUTE_NOT_FOUND");
  });

  test("revoke-delegation stamps revoked_at and bumps the revision", async () => {
    await applyRun(
      delegationCommand({ id: `${PREFIX}delegation-2` }, `${PREFIX}op-delegation-2`),
    );
    const revoke: RevokeDelegationCommand = {
      mode: "revoke-delegation",
      ...base,
      operation_id: `${PREFIX}op-revoke-delegation-1`,
      id: `${PREFIX}delegation-2`,
      reason: "pilot ended",
    };
    await applyRun(revoke);
    const rows = await db
      .select()
      .from(enterpriseRunDelegations)
      .where(
        and(
          eq(enterpriseRunDelegations.tenantId, TENANT),
          eq(enterpriseRunDelegations.id, `${PREFIX}delegation-2`),
        ),
      );
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.revision).toBe(2n);

    const unknown = await errorOf(() =>
      applyRun({
        mode: "revoke-delegation",
        ...base,
        operation_id: `${PREFIX}op-revoke-delegation-none`,
        id: `${PREFIX}delegation-none`,
        reason: "typo",
      }),
    );
    expect(unknown.code).toBe("DELEGATION_NOT_FOUND");
  });

  test("a corrupt stored audit event fails the operation closed and rolls the write back", async () => {
    await db.insert(enterpriseSecurityEvents).values({
      tenantId: TENANT,
      id: `${PREFIX}op-corrupt`,
      operationId: `${PREFIX}op-corrupt`,
      actor: OPERATOR,
      kind: "run.route.registered",
      details: { garbage: true },
    });
    const error = await errorOf(() =>
      applyRun(
        routeCommand(
          { id: `${PREFIX}route-corrupt`, alias: "chat-corrupt", revision: "9", is_default_for_alias: false },
          `${PREFIX}op-corrupt`,
        ),
      ),
    );
    expect(error.code).toBe("SECURITY_EVENT_UNREADABLE");
    expect(await routeRow(`${PREFIX}route-corrupt`)).toBeUndefined();
    /* 计划中的损坏事件原样保留，供人工取证；本操作没有写下任何新行。 */
    expect(await auditCount(`${PREFIX}op-corrupt`)).toBe(1);
  });

  test("a failure after the domain write rolls the whole transaction back", async () => {
    let message = "";
    try {
      await applyRun(
        routeCommand(
          { id: `${PREFIX}route-hookfail`, alias: "chat-hook", revision: "9", is_default_for_alias: false },
          `${PREFIX}op-hookfail`,
        ),
        { beforeAudit: async () => { throw new Error("injected audit failure"); } },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("injected audit failure");
    expect(await routeRow(`${PREFIX}route-hookfail`)).toBeUndefined();
    expect(await auditCount(`${PREFIX}op-hookfail`)).toBe(0);
  });

  /* ---------------------------------------------------------------------------
   * CLI 子进程：默认 dry-run 且绝不连库；--apply 缺 operation_id 拒绝；全链路 apply。
   * 嵌套在本 describe 内，与领域用例共享同一连接池生命周期（afterAll 在其后才执行）。
   * ------------------------------------------------------------------------ */

  describe("E1-D provision CLI", () => {
  test("dry-run is the default and never opens a database", async () => {
    const before = await db
      .select({ id: enterpriseRunGrants.releaseId })
      .from(enterpriseRunGrants)
      .where(eq(enterpriseRunGrants.tenantId, TENANT));
    const run = await runCli(
      [
        "run-grant",
        "--input",
        runGrantInput,
        "--tenant",
        TENANT,
        "--operator",
        OPERATOR,
        "--operation-id",
        `${PREFIX}op-cli-dryrun`,
      ],
      /* 不给任何数据库 URL：dry-run 连库即失败——而它必须成功。 */
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain("dry-run");
    expect(run.out).toContain("run-grant");
    const after = await db
      .select({ id: enterpriseRunGrants.releaseId })
      .from(enterpriseRunGrants)
      .where(eq(enterpriseRunGrants.tenantId, TENANT));
    expect(after).toEqual(before);
  });

  test("--apply without an operation id is a usage refusal", async () => {
    const run = await runCli(
      ["run-grant", "--input", runGrantInput, "--tenant", TENANT, "--operator", OPERATOR, "--apply"],
      {
        ENTERPRISE_RUN_PROVISION_DATABASE_URL:
          process.env.TEST_DATABASE_URL,
      },
    );
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("operation-id");
  });

  test("an invalid union payload is refused before any database work", async () => {
    const run = await runCli(
      [
        "run-grant",
        "--input",
        JSON.stringify({
          release_id: `${PREFIX}release-1`,
          principal_id: PRINCIPAL_A,
          action: "start",
          id: "smuggled",
        }),
        "--tenant",
        TENANT,
        "--operator",
        OPERATOR,
        "--operation-id",
        `${PREFIX}op-cli-invalid`,
        "--apply",
      ],
      { ENTERPRISE_RUN_PROVISION_DATABASE_URL: process.env.TEST_DATABASE_URL },
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain("INVALID_PROVISION_INPUT");
    expect(await auditCount(`${PREFIX}op-cli-invalid`)).toBe(0);
  });

  test("--apply lands the grant and the audit event in one transaction", async () => {
    const run = await runCli(
      [
        "run-grant",
        "--input",
        runGrantInput,
        "--tenant",
        TENANT,
        "--operator",
        OPERATOR,
        "--operation-id",
        `${PREFIX}op-cli-apply`,
        "--apply",
      ],
      {
        ENTERPRISE_RUN_PROVISION_DATABASE_URL:
          process.env.TEST_DATABASE_URL,
      },
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain("applied");
    const rows = await db
      .select()
      .from(enterpriseRunGrants)
      .where(
        and(
          eq(enterpriseRunGrants.tenantId, TENANT),
          eq(enterpriseRunGrants.releaseId, `${PREFIX}release-1`),
          eq(enterpriseRunGrants.principalId, PRINCIPAL_A),
          eq(enterpriseRunGrants.action, "start"),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(await auditCount(`${PREFIX}op-cli-apply`)).toBe(1);
  });
  });
});
