// server/tests/multitenancy/bot-catalog-public.test.ts
// MOD05（Issue #625，根 #620）：M03 BotCatalog 门面的委托等价与形状钉。
//
// 事实源（Issue #625 验收 + MOD05 Brief §C，逐条对应 describe）：
//   D1 委托等价：门面五能力 vs 直调内件——同参、同对象、同错误实例透传
//      （注入替身证明委托本身）+ 真内件无 DB 反例（真 ExpertVersionCatalog
//      毒化连接：ref 校验先于触库）+ 路由级双路等价（publication 两 handler
//      经门面/不经门面行为同形）。
//   D2 验收 1 形状钉：身份字段与运行配置现有分离不被破坏——createBot 输入
//      面 = CreateAgentInput（身份四字段 + 运行配置 endpoint/auth 写入面），
//      无任何模型/工具资格授予字段；AgentProfile 输出不含密钥材质（布尔面）。
//   D3 验收 2：putOrGet 幂等（on conflict do nothing + 回读同一行 → 同 ref）
//      + resolve 快照独立（冻结、逐次解析、租户边界）+ 撤回只删 publication
//      一行不触档案/版本（替身隔离计数 + 源级结构断言）。真实 PG 语义
//      （RLS/真实 on conflict）由存量 expert-version-catalog / bot-publish /
//      bots-ownership 复跑钉住（见 reports/MOD05-report.md）。
//   D4 验收 3：publish 零新增授权分支——门面源零判定/零写面；真
//      TeamBotForbiddenError 实例经门面原样透传（管理员开关合同留在内件）。
//   D5 验收 4：门面不暴露整对象——能力面恰五方法（MOD16 +softDeleteBot）、
//      模块值导出恰工厂函数、
//      import 面全部 M03 组内、构造依赖为 Pick 最小面（本文件以只含单能力
//      的替身构造成功即为编译级证明）；module-imports.json M03 分组钉死。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生
// 收集（覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库：真内件
// 部分用「按 SQL 文本应答的受信假库」驱动（expert-version-catalog.test.ts
// 同款先例）与「毒化连接」证明拒绝先于触库；其余为注入替身（门面只做委托，
// 替身证明的正是委托本身）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { AgentActor, AgentProfile } from "../../src/agents/profile-types";
import {
  type BotCatalog,
  type CreateBotInput,
  createBotCatalog,
  type PublishBotInput,
} from "../../src/agents/public";
import type { AppVariables } from "../../src/auth/guards";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  canonicalizeExpertDefinition,
  type ExpertDefinitionV1,
  ExpertVersionCatalog,
  type ExpertVersionRef,
} from "../../src/enterprise/experts/version-catalog";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import { createTeamBotRoutes } from "../../src/team-bots/routes";
import {
  TeamBotForbiddenError,
  type TeamBots,
} from "../../src/team-bots/team-bots";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

const ACTOR: AgentActor = { id: "user-a", role: "user" };
const PUBLISH_INPUT: PublishBotInput = {
  audience: "team",
  emails: ["teammate@example.invalid"],
  groups: [],
};
const CREATE_INPUT: CreateBotInput = {
  name: "Catalog Bot",
  title: "Catalog Bot",
  roleDescription: "Delegation proof.",
  visibility: "private",
};
const PROFILE_MARKER: AgentProfile = {
  id: "bot-1",
  name: "Catalog Bot",
  title: "Catalog Bot",
  roleDescription: "Delegation proof.",
  avatarSeed: "seed",
  visibility: "private",
  ownerUserId: "user-a",
  systemOwned: false,
  hidden: false,
  pinned: false,
  deletedAt: null,
  endpoint: null,
  hasAuth: false,
  hasCallbackToken: false,
};

/** 全真能力行：让 verify* 通过校验并把该连接对象计入受信 WeakSet。 */
function capabilityRows() {
  return [
    {
      current_user_matches: true,
      capability_attributes_ok: true,
      login_attributes_ok: true,
      login_has_expected_capability: true,
      capability_has_no_escalation_membership: true,
      login_has_no_other_memberships: true,
      no_protected_ownership: true,
      login_has_no_enterprise_privileges: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// 夹具 B：注入替身（证明委托本身——同对象进出、同错误透传、调用隔离）
// ---------------------------------------------------------------------------

type InternalsCall = { capability: string; args: unknown[] };

function recordingInternals(options?: {
  publishError?: Error;
  createError?: Error;
}) {
  const calls: InternalsCall[] = [];
  const versionMarker: ExpertDefinitionV1 = {
    schemaVersion: 1,
    agentId: "bot-1",
    source: "team_bot",
    agentType: "built_in",
    systemPrompt: "Pinned by the catalog.",
    behaviorVersion: "openbot-builtin-v1",
  };
  const internals = {
    profileStore: {
      async create(actor: AgentActor, input: CreateBotInput) {
        calls.push({ capability: "profileStore.create", args: [actor, input] });
        if (options?.createError) throw options.createError;
        return PROFILE_MARKER;
      },
      async softDelete(actor: AgentActor, id: string): Promise<void> {
        calls.push({
          capability: "profileStore.softDelete",
          args: [actor, id],
        });
      },
    },
    teamBots: {
      async publish(
        actor: AgentActor,
        botId: string,
        input: PublishBotInput,
      ): Promise<void> {
        calls.push({
          capability: "teamBots.publish",
          args: [actor, botId, input],
        });
        if (options?.publishError) throw options.publishError;
      },
      async unpublish(actor: AgentActor, botId: string): Promise<void> {
        calls.push({ capability: "teamBots.unpublish", args: [actor, botId] });
      },
    },
    expertVersions: {
      async resolve(scope: PlatformScope, ref: ExpertVersionRef) {
        calls.push({
          capability: "expertVersions.resolve",
          args: [scope, ref],
        });
        return ref === "expert:v1:ref-marker" ? versionMarker : null;
      },
    },
    calls,
    versionMarker,
  };
  return internals;
}

// ---------------------------------------------------------------------------
// 夹具 R：真内件 + 受信假库（expert-version-catalog.test.ts 同款先例）
// ---------------------------------------------------------------------------

function compiled(statement: SQL) {
  return new PgDialect().sqlToQuery(statement);
}

type CatalogRow = {
  tenant_id: string;
  expert_version_ref: string;
  schema_version: number;
  agent_id: string;
  snapshot: unknown;
};

function expertDefinition(): ExpertDefinitionV1 {
  return {
    schemaVersion: 1,
    agentId: "bot-a",
    source: "user_profile",
    agentType: "built_in",
    systemPrompt: "Follow the registered Bot instructions.",
    behaviorVersion: "openbot-builtin-v1",
  };
}

function storedRow(tenantId: string): CatalogRow {
  const canonical = canonicalizeExpertDefinition(tenantId, expertDefinition());
  return {
    tenant_id: tenantId,
    expert_version_ref: canonical.expertVersionRef,
    schema_version: 1,
    agent_id: canonical.agentId,
    snapshot: JSON.stringify(canonical.definition),
  };
}

/**
 * 受信假 DataDatabase：能力校验恒真；事务内按编译后 SQL 文本应答——
 * insert 命中与否由脚本决定（模拟 `on conflict (…) do nothing` 后有无
 * returning 行），select 按租户参数应答（tenant-b 无行）。
 */
function catalogDatabaseFixture(script: {
  insertReturnsRow: boolean;
  row: CatalogRow;
}) {
  let transactions = 0;
  const fixture = {
    setInsertReturns(value: boolean) {
      script.insertReturnsRow = value;
    },
    touches: () => transactions,
  };
  const database = {
    execute: async () => capabilityRows(),
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      return operation({
        execute: async (statement: SQL) => {
          const query = compiled(statement);
          const text = query.sql.toLowerCase();
          if (text.includes("set_config")) return [];
          if (text.includes("insert into enterprise_expert_versions"))
            return script.insertReturnsRow ? [script.row] : [];
          if (text.includes("from enterprise_expert_versions"))
            return query.params.includes("tenant-b") ? [] : [script.row];
          return [];
        },
      });
    },
  } as unknown as Parameters<typeof verifyDataDatabase>[0];
  return {
    database,
    setInsertReturns: fixture.setInsertReturns,
    touches: fixture.touches,
  };
}

/** 真 PlatformScope：createScopeResolver（受信假目录库）签发（store.ts 同款链路）；租可选择。 */
async function trustedScope(tenantId = "tenant-a"): Promise<PlatformScope> {
  const database = {
    execute: async () => capabilityRows(),
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => {
          // store.ts 两个 select：成员三表联查（带 innerJoin）与工作区成员资格
          // （无 innerJoin）。同一链条按是否联查应答对应行形——存量
          // expert-version-catalog.test.ts 的假库只应答了第一个，第二个
          // select 拿不到 status 而在 BASE 上 4/13 红（WORKSPACE_FORBIDDEN，
          // 存量，见报告）；本夹具补齐两形。
          let joined = false;
          const query = {
            from: () => query,
            innerJoin: () => {
              joined = true;
              return query;
            },
            where: () => query,
            limit: async () =>
              joined
                ? [
                    {
                      principalId: "principal-a",
                      tenantId,
                      tenantStatus: "active",
                      principalStatus: "active",
                      memberStatus: "active",
                      memberEpoch: 1,
                    },
                  ]
                : [{ status: "active" }],
          };
          return query;
        },
      }),
  } as unknown as Parameters<typeof verifyDirectoryDatabase>[0];
  const directory = await verifyDirectoryDatabase(database);
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: "actor-a", entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => "workspace-a",
  });
  return resolver.resolve(new Request("https://example.invalid"));
}

// ---------------------------------------------------------------------------
// 夹具 H：路由级（publication 两 handler，team-bot-routes-shared 同款挂载）
// ---------------------------------------------------------------------------

function asSignedIn(role: "admin" | "user", id: string) {
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return signedIn;
}

function mountedApp(
  teamBots: TeamBots,
  botCatalog?: Pick<BotCatalog, "publish" | "withdraw">,
) {
  return new Hono().route(
    "/api/team-bots",
    createTeamBotRoutes(
      teamBots,
      asSignedIn("user", "owner"),
      undefined,
      botCatalog,
    ),
  );
}

const ROUTE_TEAM_BOTS = {
  publish: async () => {},
  unpublish: async () => {},
} as unknown as TeamBots;

// ---------------------------------------------------------------------------
// D1：委托等价
// ---------------------------------------------------------------------------

describe("MOD05 D1: facade delegates to internals verbatim", () => {
  test("createBot delegates to profileStore.create with the same actor and input object", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    const created = await catalog.createBot(ACTOR, CREATE_INPUT);
    expect(created).toBe(PROFILE_MARKER); // 同一对象：纯透传
    expect(internals.calls).toEqual([
      { capability: "profileStore.create", args: [ACTOR, CREATE_INPUT] },
    ]); // 参数原样（同引用）
    expect(internals.calls[0]?.args[0]).toBe(ACTOR);
    expect(internals.calls[0]?.args[1]).toBe(CREATE_INPUT);
  });

  test("createBot propagates the internal error instance untouched", async () => {
    const refusal = new Error("AGENT_CREATE_REFUSED_MARKER");
    const catalog = createBotCatalog(
      recordingInternals({ createError: refusal }),
    );
    let caught: unknown;
    try {
      await catalog.createBot(ACTOR, CREATE_INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(refusal); // 同一实例：门面不包装、不改写
  });

  test("publish delegates to teamBots.publish with identical arguments", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    await catalog.publish(ACTOR, "bot-1", PUBLISH_INPUT);
    expect(internals.calls).toEqual([
      {
        capability: "teamBots.publish",
        args: [ACTOR, "bot-1", PUBLISH_INPUT],
      },
    ]);
    expect(internals.calls[0]?.args[2]).toBe(PUBLISH_INPUT);
  });

  test("withdraw delegates to teamBots.unpublish (member name proven by the stub)", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    await catalog.withdraw(ACTOR, "bot-1");
    expect(internals.calls).toEqual([
      { capability: "teamBots.unpublish", args: [ACTOR, "bot-1"] },
    ]);
  });

  test("getVersion delegates to expertVersions.resolve and returns its very object", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    const scope = await trustedScope();
    const resolved = await catalog.getVersion(scope, "expert:v1:ref-marker");
    expect(resolved).toBe(internals.versionMarker); // 同一对象：纯透传
    expect(internals.calls).toEqual([
      {
        capability: "expertVersions.resolve",
        args: [scope, "expert:v1:ref-marker"],
      },
    ]);
    expect(internals.calls[0]?.args[0]).toBe(scope);
  });

  test("route-level: PUT/DELETE publication through the facade hit publish/withdraw and keep wire shapes", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    const app = mountedApp(ROUTE_TEAM_BOTS, catalog);
    const put = await app.request("/api/team-bots/bot-1/publication", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "team", emails: [], groups: [] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      sharedApps: { approved: [], needsApproval: [] },
    });
    expect(internals.calls.map((call) => call.capability)).toEqual([
      "teamBots.publish",
    ]);
    internals.calls.length = 0;
    const removed = await app.request("/api/team-bots/bot-1/publication", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(internals.calls.map((call) => call.capability)).toEqual([
      "teamBots.unpublish",
    ]);
  });

  test("route-level: without the facade the same requests take the direct teamBots path (byte-equivalent old route)", async () => {
    const internals = recordingInternals();
    // 不注入门面（第 4 参缺省）：存量直挂路径。替身以最小面顶替 TeamBots。
    const app = mountedApp(internals.teamBots as unknown as TeamBots);
    const put = await app.request("/api/team-bots/bot-1/publication", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "team", emails: [], groups: [] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      sharedApps: { approved: [], needsApproval: [] },
    });
    const removed = await app.request("/api/team-bots/bot-1/publication", {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(internals.calls.map((call) => call.capability)).toEqual([
      "teamBots.publish",
      "teamBots.unpublish",
    ]);
  });
});

// ---------------------------------------------------------------------------
// D2：验收 1——身份字段与运行配置现有分离（结构断言）
// ---------------------------------------------------------------------------

describe("MOD05 D2: identity fields stay separate from runtime configuration", () => {
  test("CreateAgentInput surface is identity fields + run configuration only, with no grant-bearing key", () => {
    const source = sourceOf("../../src/agents/profile-types.ts").replace(
      /\s+/g,
      " ",
    );
    // 身份四字段 = Pick 面，一字不差（现有分离的输入侧）。
    expect(source).toMatch(
      /export type CreateAgentInput = Pick< AgentProfile, "name" \| "title" \| "roleDescription" \| "visibility" >/,
    );
    // 运行配置仅 endpoint/auth 两可选项（auth 为只写凭据，绝不回读）。
    const block = source.slice(
      source.indexOf("export type CreateAgentInput"),
      source.indexOf("export type CreateAgentInput") + 2000,
    );
    expect(block).toContain("endpoint?: string");
    expect(block).toContain("auth?: { header: string; value: string }");
    const optionalKeys = [...block.matchAll(/(\w+)\?:/g)].map(
      (match) => match[1],
    );
    expect(optionalKeys.sort()).toEqual(["auth", "endpoint"]);
    // 创建不自动授予模型或工具资格（Interface 合同 BotCatalog 行）。
    for (const forbidden of [
      "model",
      "models",
      "tools",
      "capabilities",
      "grants",
      "apiKey",
      "scopes",
      "connections",
      "permissions",
    ]) {
      expect(block).not.toContain(`${forbidden}?:`);
    }
  });

  test("CreateBotInput adds only the creation-path systemPrompt; the facade invents no field", () => {
    const source = sourceOf("../../src/agents/public.ts").replace(/\s+/g, " ");
    expect(source).toMatch(
      /export type CreateBotInput = CreateAgentInput & \{ readonly systemPrompt\?: string; \}/,
    );
  });

  test("AgentProfile output never carries secret material: credentials surface as booleans", () => {
    // 结构钉：身份事实（id/owner/可见性）与运行配置（endpoint、hasAuth、
    // hasCallbackToken）同形不同层——密钥材质（auth 值、token 值）不在输出面。
    expect(PROFILE_MARKER).toHaveProperty("ownerUserId");
    expect(PROFILE_MARKER).toHaveProperty("endpoint");
    expect(typeof PROFILE_MARKER.hasAuth).toBe("boolean");
    expect(typeof PROFILE_MARKER.hasCallbackToken).toBe("boolean");
    expect("auth" in PROFILE_MARKER).toBe(false);
    const secretish = Object.entries(PROFILE_MARKER).filter(
      ([key, value]) =>
        /token|secret|credential|key|auth/i.test(key) &&
        (typeof value === "string" || (value && typeof value === "object")),
    );
    expect(secretish).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D3：验收 2——版本幂等/快照独立/撤回只删 publication
// ---------------------------------------------------------------------------

describe("MOD05 D3: version idempotency, snapshot independence, withdrawal scope", () => {
  test("real ExpertVersionCatalog.putOrGet is idempotent across the conflict path (insert then re-read: same ref)", async () => {
    const row = storedRow("tenant-a");
    const fixture = catalogDatabaseFixture({ insertReturnsRow: true, row });
    const verified = await verifyDataDatabase(fixture.database);
    const catalog = new ExpertVersionCatalog(verified);
    const scope = await trustedScope();
    const first = await catalog.putOrGet(scope, expertDefinition());
    expect(first).toBe(row.expert_version_ref);
    // 第二次：insert 无 returning 行（on conflict do nothing）→ 回读既有行 → 同一 ref。
    fixture.setInsertReturns(false);
    const second = await catalog.putOrGet(scope, expertDefinition());
    expect(second).toBe(first);
    expect(fixture.touches()).toBe(2); // 每次一个事务，无重试/无额外路径
  });

  test("real ExpertVersionCatalog.resolve re-parses the stored snapshot per call and keeps it frozen", async () => {
    const row = storedRow("tenant-a");
    const fixture = catalogDatabaseFixture({ insertReturnsRow: false, row });
    const verified = await verifyDataDatabase(fixture.database);
    const catalog = new ExpertVersionCatalog(verified);
    const scope = await trustedScope();
    const first = await catalog.resolve(scope, row.expert_version_ref);
    expect(first).toEqual(
      canonicalizeExpertDefinition("tenant-a", expertDefinition()).definition,
    );
    expect(Object.isFrozen(first)).toBe(true); // 快照不可被调用方改写
    const second = await catalog.resolve(scope, row.expert_version_ref);
    expect(second).toEqual(first); // 逐次独立解析：同内容、非同对象
    expect(second).not.toBe(first);
    expect(row.snapshot).toBe(storedRow("tenant-a").snapshot); // 存储行未被触碰
  });

  test("tenant boundary: a tenant-a ref resolves to null under a genuinely trusted tenant-b scope (no leak)", async () => {
    const row = storedRow("tenant-a");
    const fixture = catalogDatabaseFixture({ insertReturnsRow: false, row });
    const verified = await verifyDataDatabase(fixture.database);
    const catalog = new ExpertVersionCatalog(verified);
    const scopeA = await trustedScope("tenant-a");
    expect(
      await catalog.resolve(scopeA, row.expert_version_ref),
    ).not.toBeNull(); // 对照：本租户可解析
    const scopeB = await trustedScope("tenant-b"); // 真签发的另一租户 Scope，非伪造
    expect(await catalog.resolve(scopeB, row.expert_version_ref)).toBeNull(); // 按租户参数无行 → null
    // 伪造（非签发）scope 连 SQL 都到不了：选择器不赋权。
    const forged: PlatformScope = Object.freeze({
      ...scopeA,
      tenantId: "tenant-b",
    });
    await expect(
      catalog.resolve(forged, row.expert_version_ref),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
  });

  test("facade withdraw touches ONLY teamBots.unpublish: profiles and expert versions stay untouched", async () => {
    const internals = recordingInternals();
    const catalog = createBotCatalog(internals);
    await catalog.withdraw(ACTOR, "bot-1");
    expect(internals.calls.map((call) => call.capability)).toEqual([
      "teamBots.unpublish",
    ]); // profileStore.create / expertVersions.resolve 零调用（隔离计数）
  });

  test("source pin: team-bots unpublish deletes exactly the publication row and nothing else", () => {
    const source = sourceOf("../../src/team-bots/team-bots.ts");
    const start = source.indexOf("async unpublish(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("async assign(", start));
    expect(body).toContain("owned(actor, botId, true)"); // 撤回权限合同：owner 或管理员，逐字节不动
    const deletes = [
      ...body.matchAll(/database\s*\.\s*delete\(\s*(\w+)\s*\)/g),
    ].map((match) => match[1]);
    expect(deletes).toEqual(["teamBotPublications"]); // 恰一行删除，且只删发布关系
  });

  test("source pin: the expert version catalog has no delete statement at all", () => {
    const source = sourceOf(
      "../../src/enterprise/experts/version-catalog.ts",
    ).toLowerCase();
    expect(source).not.toContain("delete from");
    expect(source).not.toMatch(/\.delete\(/);
    expect(source).toContain(
      "on conflict (tenant_id, expert_version_ref) do nothing",
    );
  });
});

// ---------------------------------------------------------------------------
// D4：验收 3——publish 零新增授权分支、TeamBotPublishForbidden 照旧
// ---------------------------------------------------------------------------

describe("MOD05 D4: no new authorization branch in the facade", () => {
  test("a real TeamBotForbiddenError thrown by the internal publish propagates as the SAME instance", async () => {
    const forbidden = new TeamBotForbiddenError(
      "Team Bots are turned off for this workspace.",
    );
    const catalog = createBotCatalog(
      recordingInternals({ publishError: forbidden }),
    );
    let caught: unknown;
    try {
      await catalog.publish(ACTOR, "bot-1", PUBLISH_INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(forbidden);
    expect(caught instanceof TeamBotForbiddenError).toBe(true); // 类型面照旧（路由 onError 403 判据不变）
  });

  test("facade source holds zero authorization logic and zero write surface", () => {
    // 剥离注释后只看代码面（头注释里的内件描述不算实现）。
    const code = sourceOf("../../src/agents/public.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "enterpriseControls",
      "capabilityFor",
      "requireAdmin",
      '=== "admin"',
      "insert(",
      "update(",
      ".delete(",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // 管理员开关与发布前置校验留在内件（team-bots.ts publish 本体）。
    const teamBots = sourceOf("../../src/team-bots/team-bots.ts");
    expect(teamBots).toContain('capabilityFor(actor.id, "teamBots")');
    expect(teamBots).toContain("throw new TeamBotForbiddenError");
  });

  test("real internal negative without a database: malformed ref is refused before any transaction", async () => {
    const row = storedRow("tenant-a");
    const fixture = catalogDatabaseFixture({ insertReturnsRow: false, row });
    const verified = await verifyDataDatabase(fixture.database);
    const catalog = createBotCatalog({
      profileStore: recordingInternals().profileStore,
      teamBots: recordingInternals().teamBots,
      expertVersions: new ExpertVersionCatalog(verified),
    });
    const scope = await trustedScope();
    const code = await codeOf(
      catalog.getVersion(scope, "expert:v1:NOT-HEX" as ExpertVersionRef),
    );
    expect(code).toBe("EXPERT_VERSION_REF_INVALID"); // 真 resolve 的 ref 校验
    expect(fixture.touches()).toBe(0); // 拒绝先于触库（毒化计数）
  });

  test("getVersion without an assembled catalog fails loudly rather than permissively", async () => {
    const internals = recordingInternals();
    const { expertVersions: _absent, ...minimal } = internals;
    const catalog = createBotCatalog(minimal);
    const scope = await trustedScope();
    const code = await codeOf(
      catalog.getVersion(scope, "expert:v1:ref-marker"),
    );
    expect(code).toBe("BOT_CATALOG_EXPERT_VERSIONS_UNAVAILABLE"); // 缺席不是空结果
    expect(internals.calls).toEqual([]); // 其余内件零触碰
  });
});

// ---------------------------------------------------------------------------
// D5：验收 4——门面不暴露整对象、import 面组内、分组钉死
// ---------------------------------------------------------------------------

describe("MOD05 D5: the facade exposes exactly five capabilities and no whole internals", () => {
  test("the facade object surface is exactly the five contract capabilities", async () => {
    const catalog = createBotCatalog(recordingInternals());
    expect(Object.keys(catalog).sort()).toEqual([
      "createBot",
      "getVersion",
      "publish",
      "softDeleteBot",
      "withdraw",
    ]);
  });

  test("the module's value exports are exactly the factory (no object re-exports)", async () => {
    const module = await import("../../src/agents/public");
    expect(Object.keys(module).sort()).toEqual(["createBotCatalog"]);
    const source = sourceOf("../../src/agents/public.ts");
    expect(source).not.toContain("export *");
    expect(source).not.toMatch(/export \{[^}]*TeamBots/);
    expect(source).not.toMatch(/export \{[^}]*AgentProfileStore/);
    expect(source).not.toMatch(/export \{[^}]*ExpertVersionCatalog/);
  });

  test("the facade imports only M03-group internals (no M02 contracts edge, checker zero-delta precondition)", () => {
    const source = sourceOf("../../src/agents/public.ts");
    const specifiers = [...source.matchAll(/from "([^"]+)";/g)].map(
      (match) => match[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(
        specifier === "./profile-types" ||
          specifier === "./profile-store" ||
          specifier === "../team-bots/team-bots" ||
          specifier === "../enterprise/experts/version-catalog",
      ).toBe(true);
    }
    expect(specifiers).not.toContain("../enterprise/contracts"); // M03→M02 零新边
  });

  test("module-imports.json keeps the M03 grouping this facade relies on", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../tests/config/module-imports.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      moduleRoots: Array<{ path: string; module: string; kind: string }>;
    };
    const byPath = new Map(config.moduleRoots.map((root) => [root.path, root]));
    expect(byPath.get("server/src/agents")?.module).toBe("M03");
    expect(byPath.get("server/src/team-bots")?.module).toBe("M03");
    expect(byPath.get("server/src/enterprise/experts")?.module).toBe("M03");
  });

  test("construction accepts minimal-capability stubs: deps are Pick-level minimal faces (compile-level proof)", () => {
    // 若门面依赖的是整内件对象面，本函数体无法通过 typecheck——替身只带
    // Pick 面能力（profileStore = create+softDelete，MOD16 扩面后）。
    const createAndSoftDelete = {
      async create() {
        return PROFILE_MARKER;
      },
      async softDelete() {},
    };
    const onlyPublishWithdraw = {
      async publish() {},
      async unpublish() {},
    };
    const catalog = createBotCatalog({
      profileStore: createAndSoftDelete,
      teamBots: onlyPublishWithdraw,
    });
    expect(typeof catalog.createBot).toBe("function");
    expect(typeof catalog.softDeleteBot).toBe("function");
    expect(typeof catalog.publish).toBe("function");
  });
});
