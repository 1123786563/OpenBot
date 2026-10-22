// server/tests/multitenancy/observability-authz.test.ts
// MT110（Issue #153）：共享观测后端的查询、导出与 trace 链接授权。
//
// 验收事实源（Issue #153 四条，逐条对应 describe；真实 PostgreSQL +
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   AC1 普通租户无法通过观测入口读取其他公司 trace 或日志（公司查询门；
//      跨公司/跨团队/不存在/已撤销四态 canonical not-found 逐字节同形）。
//   AC2 导出遵守范围与脱敏规则，且导出动作留审计（范围门 + 脱敏策略版本
//      声明门 + MT078 business 域审计三闸；拒绝态零审计副作用）。
//   AC3 trace 链接访问在打开时校验权限，不因链接不可猜而放行（本地权威
//      绑定行 → 公司归属 → 个人同一性整链重验；任何一环不成立与
//      「链接指向的 trace 不存在」不可区分）。
//   AC4 部署级 dashboard 只对平台操作身份开放（公司上下文内的任何身份
//      ——含 tenant_admin、含角色名恰为 admin——结构性拒绝）。
//
// 结构：真实 provisioning 复用 MT016 fixture（两公司三团队多身份 +
// 受信 scope 真实签发 + 真实撤权/恢复），观测绑定行经应用主库连接
// （ai_observation_bindings 的权威存储连接类）真实落库。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/e2e-compat";
import {
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase, type Database } from "../../src/db/client";
import { aiObservationBindings } from "../../src/db/schema/ai-observability-bindings";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { queryTenantAuditEvents } from "../../src/enterprise/tenancy/audit-domains";
import {
  type DataDatabase,
  type OperatorDatabase,
  verifyDataDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  auditTraceLinkOpen,
  authorizeCompanyObservationExport,
  authorizeCompanyObservationSubject,
  authorizeTraceLinkOpen,
  OBSERVABILITY_EXPORT_AUDIT_TYPE,
  OBSERVABILITY_EXPORT_REDACTION_POLICY,
  OBSERVABILITY_EXPORT_REFUSED,
  qualifiesForDeploymentObservation,
  type TraceBindingReader,
} from "../../src/enterprise/tenancy/observability-authz";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  type BotsIdentity,
  type BotsOwnershipFixture,
  createBotsOwnershipFixture,
} from "./support/bots-ownership";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT110 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());
const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

// ---------------------------------------------------------------------------
// AC4（纯函数面，零依赖先行）：部署级 dashboard 只对平台操作身份开放
// ---------------------------------------------------------------------------

describe("MT110 AC4：部署级 dashboard 只对平台操作身份开放", () => {
  test("平台操作身份（无公司选择的部署主体）合格", () => {
    expect(
      qualifiesForDeploymentObservation({ kind: "platform", subject: "ops-1" }),
    ).toBe(true);
  });

  test("公司上下文内的 tenant_admin 结构性拒绝", () => {
    expect(
      qualifiesForDeploymentObservation({
        kind: "company",
        subject: "principal-x",
        role: "tenant_admin",
      }),
    ).toBe(false);
  });

  test("公司身份角色名恰为 admin 也不继承整实例访问（角色名不是通道）", () => {
    expect(
      qualifiesForDeploymentObservation({
        kind: "company",
        subject: "principal-y",
        role: "admin",
      }),
    ).toBe(false);
  });

  test("缺失/畸形主体 fail-closed", () => {
    expect(qualifiesForDeploymentObservation(null)).toBe(false);
    expect(qualifiesForDeploymentObservation(undefined)).toBe(false);
    expect(
      qualifiesForDeploymentObservation({ kind: "platform", subject: "  " }),
    ).toBe(false);
    expect(
      qualifiesForDeploymentObservation({
        kind: "company" as const,
        subject: "z",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 套件状态（DB 面）
// ---------------------------------------------------------------------------

const generatedDirs: string[] = [];
let fixture: BotsOwnershipFixture;
let data: DataDatabase;
let operator: OperatorDatabase;
/** 应用主库连接类（观测绑定行的权威存储连接；表无 RLS，属部署自有面）。 */
let appDatabase: Database;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
/** company A 的 tenant_admin 主体（审计查询授权面）。 */
let companyAdminPrincipal = "";
let a1MemberUser = "";
let botCounter = 0;

const principalOf = (identity: BotsIdentity) =>
  fixture.ids[`principal-${identity}`];
const userOf = (identity: BotsIdentity) => fixture.ids[`user-${identity}`];
const scopeAs = (
  identity: BotsIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

/** 真实绑定行读取器（生产 wiring 注入 RunBindingStore 同源读取）。 */
const bindingReader: TraceBindingReader = {
  async byUpstreamTrace(opikTraceId) {
    const rows = await appDatabase
      .select({
        botId: aiObservationBindings.botId,
        actorId: aiObservationBindings.actorId,
        scopeKey: aiObservationBindings.scopeKey,
      })
      .from(aiObservationBindings)
      .where(sql`${aiObservationBindings.opikTraceId} = ${opikTraceId}`);
    return rows;
  },
};

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT078 audit tables through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay) — the
  // same migration-before-fixture discipline as bots-ownership.test.ts.
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT110 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt110-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT078", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT078 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT078", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT078", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT078 apply failed: ${JSON.stringify(applied)}`);
  }

  fixture = await createBotsOwnershipFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];
  companyAdminPrincipal = principalOf("company-admin");
  a1MemberUser = userOf("a1-member");
  data = (await verifyDataDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
      max: 1,
    }),
  )) as DataDatabase;
  operator = (await verifyOperatorDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("operator", process.env), {
      max: 1,
    }),
  )) as OperatorDatabase;
  appDatabase = createDatabase(enterpriseTestDatabaseUrlFrom(process.env), {
    max: 1,
  });
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) await fixture.dispose();
  if (data) data.$client.close();
  if (operator) operator.$client.close();
  if (appDatabase) appDatabase.$client.close();
}, 60000);

/** 经真实 MT016 服务在 company A / team A1 落一个观测主体 Bot。 */
async function seedBotInTeamA1(tag: string): Promise<string> {
  botCounter += 1;
  // 每轮唯一（fixture idPrefix 带 uuid）：同一测试库跨轮重跑不与既有
  // 归属行碰撞（agent_id 全局唯一索引），夹具纪律与 legacy-anchor 同款。
  const agentId = `${fixture.idPrefix}-bot-${String(botCounter).padStart(3, "0")}-${tag}`;
  const scope = await scopeAs("a1-member", companyA, teamA1);
  const outcome = await fixture.service.createBot(scope, {
    agentId,
    displayName: `MT110 Bot ${tag}`,
    defaultConfig: { model: "gpt-4o" },
  });
  if (outcome.outcome !== "allow") {
    throw new Error(`seedBot failed: ${JSON.stringify(outcome)}`);
  }
  return agentId;
}

/** 经应用主库连接落一条真实观测绑定行（生产写入路径的存储形状）。 */
async function seedBinding(input: {
  opikTraceId: string;
  botId: string;
  actorId: string;
}): Promise<void> {
  await appDatabase
    .insert(aiObservationBindings)
    .values({
      id: `mt110-bind-${input.opikTraceId}`,
      scopeKey: `wb|${input.actorId.length}:${input.actorId}|${input.botId.length}:${input.botId}|1:0`,
      actorId: input.actorId,
      botId: input.botId,
      runId: `mt110-run-${input.opikTraceId}`,
      attemptId: `mt110-attempt-${input.opikTraceId}`,
      traceId: `mt110-otel-${input.opikTraceId}`,
      opikTraceId: input.opikTraceId,
      locatorWorkspace: "mt110-locator-ws",
      locatorProject: "mt110-locator-proj",
      capability: "detailed",
      state: "completed",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// AC1：公司观测查询门
// ---------------------------------------------------------------------------

describeDb("MT110 AC1：普通租户读不到其他公司的 trace/日志主体", () => {
  let ownBot = "";
  let otherCompanyBot = "";
  let teamA2Bot = "";

  beforeAll(async () => {
    ownBot = await seedBotInTeamA1("own");
    otherCompanyBot = await seedBotInTeamA1("cross-company");
    teamA2Bot = await seedBotInTeamA1("cross-team");
  });

  itDb("本团队主体放行，且只携带归属元数据", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const outcome = await authorizeCompanyObservationSubject(
      data,
      scope,
      ownBot,
    );
    expect(outcome.outcome).toBe("allowed");
    if (outcome.outcome !== "allowed") throw new Error("unreachable");
    expect(outcome.subject.botId).toBe(ownBot);
    expect(outcome.subject.workspaceId).toBe(teamA1);
    expect(outcome.subject.status).toBe("active");
  });

  itDb("跨公司读取 = canonical not-found（与真不存在逐字节同形）", async () => {
    const scope = await scopeAs("b1-member", companyB, teamB1);
    const cross = await authorizeCompanyObservationSubject(
      data,
      scope,
      otherCompanyBot,
    );
    const missing = await authorizeCompanyObservationSubject(
      data,
      scope,
      "mt110-bot-does-not-exist",
    );
    expect(cross.outcome).toBe("deny");
    expect(missing.outcome).toBe("deny");
    expect(JSON.stringify(cross)).toBe(JSON.stringify(missing));
    expect(
      isCanonicalNotFound(cross.outcome === "deny" ? cross.verdict : null),
    ).toBe(true);
  });

  itDb("同公司跨团队读取同样不可见（团队是作用域半边）", async () => {
    const scope = await scopeAs("a2-member", companyA, teamA2);
    const outcome = await authorizeCompanyObservationSubject(
      data,
      scope,
      teamA2Bot,
    );
    expect(outcome.outcome).toBe("deny");
  });

  itDb(
    "公司成员资格被暂停后的下一个事务立即 not-found（撤权即失效）",
    async () => {
      const scope = await scopeAs("a1-doomed", companyA, teamA1);
      const bot = await seedBotInTeamA1("doomed");
      const before = await authorizeCompanyObservationSubject(data, scope, bot);
      expect(before.outcome).toBe("allowed");
      await fixture.suspendCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
      const after = await authorizeCompanyObservationSubject(data, scope, bot);
      expect(after.outcome).toBe("deny");
      expect(
        isCanonicalNotFound(after.outcome === "deny" ? after.verdict : null),
      ).toBe(true);
      // 恢复成员资格（epoch 递增，旧 scope 仍拒）：同一测试库跨轮重跑时
      // a1-doomed 下一轮能重新签发 scope。
      await fixture.reinstateCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：导出三闸（范围 + 脱敏声明 + 审计）
// ---------------------------------------------------------------------------

describeDb("MT110 AC2：导出遵守范围与脱敏规则并留审计", () => {
  let exportBot = "";

  beforeAll(async () => {
    exportBot = await seedBotInTeamA1("export");
  });

  async function auditRows(tenantId: string, eventType: string) {
    return queryTenantAuditEvents(
      operator,
      { kind: "company", principalId: companyAdminPrincipal },
      { tenantId, domain: "business", eventType, limit: 50 },
    );
  }

  itDb("三闸全过：放行 + business 域审计事件落库（payload 闭形）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const outcome = await authorizeCompanyObservationExport(
      data,
      operator,
      scope,
      {
        botId: exportBot,
        redactionPolicyVersion: OBSERVABILITY_EXPORT_REDACTION_POLICY,
      },
    );
    expect(outcome.outcome).toBe("allowed");
    if (outcome.outcome !== "allowed") throw new Error("unreachable");
    expect(outcome.auditEventId).toBeTruthy();
    const rows = await auditRows(companyA, OBSERVABILITY_EXPORT_AUDIT_TYPE);
    const mine = rows.find((row) => row.id === outcome.auditEventId);
    expect(mine).toBeDefined();
    expect(mine?.actorId).toBe(principalOf("a1-member"));
    expect(mine?.targetId).toBe(exportBot);
    // payload 闭形：只有 workspaceId 与脱敏策略版本，无任何内容载体。
    expect(Object.keys(mine?.payload ?? {}).sort()).toEqual([
      "redactionPolicyVersion",
      "workspaceId",
    ]);
  });

  itDb(
    "脱敏策略版本缺失/漂移：拒绝且零审计副作用（闸 ② 先于读取）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const before = (
        await auditRows(companyA, OBSERVABILITY_EXPORT_AUDIT_TYPE)
      ).length;
      const missingVersion = await authorizeCompanyObservationExport(
        data,
        operator,
        scope,
        { botId: exportBot },
      );
      const driftedVersion = await authorizeCompanyObservationExport(
        data,
        operator,
        scope,
        { botId: exportBot, redactionPolicyVersion: "opik-redaction/0-stale" },
      );
      expect(missingVersion).toEqual({
        outcome: "refused",
        code: OBSERVABILITY_EXPORT_REFUSED,
      });
      expect(driftedVersion.outcome).toBe("refused");
      const after = (await auditRows(companyA, OBSERVABILITY_EXPORT_AUDIT_TYPE))
        .length;
      expect(after).toBe(before);
    },
  );

  itDb("范围门失败（跨公司主体）：拒绝且零审计副作用", async () => {
    const scope = await scopeAs("b1-member", companyB, teamB1);
    // 公司主体只能读本公司审计（MT078 封闭矩阵），company B 的计数经
    // setup 通道直读（计数对照不经过授权面，只对照副作用）。
    const countOf = async (): Promise<number> => {
      const result = (await appDatabase.execute(
        sql`select count(*)::int as count from enterprise_audit_events
            where tenant_id = ${companyB}
              and event_type = ${OBSERVABILITY_EXPORT_AUDIT_TYPE}`,
      )) as unknown as { count?: number }[];
      return Number(result[0]?.count ?? 0);
    };
    const before = await countOf();
    const outcome = await authorizeCompanyObservationExport(
      data,
      operator,
      scope,
      {
        botId: exportBot,
        redactionPolicyVersion: OBSERVABILITY_EXPORT_REDACTION_POLICY,
      },
    );
    expect(outcome.outcome).toBe("refused");
    const after = await countOf();
    expect(after).toBe(before);
  });

  itDb(
    "观测导出审计与身份审计分域：business 域查询看不到 identity 域之外混入",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const outcome = await authorizeCompanyObservationExport(
        data,
        operator,
        scope,
        {
          botId: exportBot,
          redactionPolicyVersion: OBSERVABILITY_EXPORT_REDACTION_POLICY,
        },
      );
      expect(outcome.outcome).toBe("allowed");
      // 公司主体只能查 business 域（MT078 封闭矩阵）：观测事件全部落在
      // business 域，两套查询不互相绕过。
      const rows = await auditRows(companyA, OBSERVABILITY_EXPORT_AUDIT_TYPE);
      expect(rows.every((row) => row.domain === "business")).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    },
  );
});

// ---------------------------------------------------------------------------
// AC3：trace 链接打开时校验权限
// ---------------------------------------------------------------------------

describeDb("MT110 AC3：trace 链接不可猜 ≠ 已授权（打开时整链重验）", () => {
  let TRACE = "";
  const UNKNOWN_TRACE = "mt110-trace-unknown";
  let linkedBot = "";

  beforeAll(async () => {
    TRACE = `${fixture.idPrefix}-trace-alpha`;
    linkedBot = await seedBotInTeamA1("linked");
    await seedBinding({
      opikTraceId: TRACE,
      botId: linkedBot,
      actorId: a1MemberUser,
    });
  });

  itDb("绑定 actor 本人打开：公司归属 + 个人同一性成立 → 放行", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const outcome = await authorizeTraceLinkOpen(data, bindingReader, scope, {
      opikTraceId: TRACE,
    });
    expect(outcome.outcome).toBe("allowed");
    if (outcome.outcome !== "allowed") throw new Error("unreachable");
    expect(outcome.botId).toBe(linkedBot);
    expect(outcome.bindingActorId).toBe(a1MemberUser);
    // 打开动作留审计（business 域）。
    const audit = await auditTraceLinkOpen(operator, scope, {
      botId: linkedBot,
      allowed: true,
    });
    expect(audit.eventId).toBeTruthy();
  });

  itDb(
    "同公司同团队的他人（非绑定 actor）打开：个人数据同一性不成立 → not-found",
    async () => {
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const outcome = await authorizeTraceLinkOpen(data, bindingReader, scope, {
        opikTraceId: TRACE,
      });
      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome !== "refused") throw new Error("unreachable");
      expect(isCanonicalNotFound(outcome.verdict)).toBe(true);
    },
  );

  itDb(
    "他公司成员持完整 trace id 打开：公司归属不成立 → 与「链接无效」不可区分",
    async () => {
      const scope = await scopeAs("b1-member", companyB, teamB1);
      const cross = await authorizeTraceLinkOpen(data, bindingReader, scope, {
        opikTraceId: TRACE,
      });
      const unknown = await authorizeTraceLinkOpen(data, bindingReader, scope, {
        opikTraceId: UNKNOWN_TRACE,
      });
      expect(cross.outcome).toBe("refused");
      expect(unknown.outcome).toBe("refused");
      expect(JSON.stringify(cross)).toBe(JSON.stringify(unknown));
    },
  );

  itDb(
    "绑定 actor 被暂停公司成员资格后打开：撤权即失效（旧链接不豁免）",
    async () => {
      // 用 a1-member（本套件最后一条用例，撤权后即恢复）：a1-doomed 的
      // 撤权 operationId 是确定值，同轮第二次撤权是 no-op，不能复用。
      const doomedTrace = `${fixture.idPrefix}-trace-doomed`;
      const bot = await seedBotInTeamA1("link-doomed");
      await seedBinding({
        opikTraceId: doomedTrace,
        botId: bot,
        actorId: a1MemberUser,
      });
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const before = await authorizeTraceLinkOpen(data, bindingReader, scope, {
        opikTraceId: doomedTrace,
      });
      expect(before.outcome).toBe("allowed");
      await fixture.suspendCompanyMembership(
        companyA,
        principalOf("a1-member"),
      );
      const after = await authorizeTraceLinkOpen(data, bindingReader, scope, {
        opikTraceId: doomedTrace,
      });
      expect(after.outcome).toBe("refused");
      if (after.outcome !== "refused") throw new Error("unreachable");
      expect(isCanonicalNotFound(after.verdict)).toBe(true);
      // 恢复成员资格（epoch 递增，旧 scope 仍拒）：跨轮重跑时 a1-member
      // 下一轮能重新签发 scope。
      await fixture.reinstateCompanyMembership(
        companyA,
        principalOf("a1-member"),
      );
    },
  );
});
