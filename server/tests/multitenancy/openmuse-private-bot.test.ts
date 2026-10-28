// server/tests/multitenancy/openmuse-private-bot.test.ts
// MT059（Issue #102）：每位用户在每个公司团队范围内拥有自己的私有 OpenMuse
// Bot——重复创建幂等，模板应用不会抹掉用户已有字段，两个公司的同一账号不会
// 共用一个 Bot。
//
// 验收事实源（Issue #102 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   AC1 同一(公司,团队,用户)重复请求得到同一个私有 Bot，不产生重复记录
//     ——幂等键 = 三元组，由 enterprise_personal_bots 复合主键结构性实现。
//   AC2 同一用户在两个公司分别获得独立私有 Bot，数据互不可见——跨公司
//     deny = MT011 canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }
//     逐字节同形（不存在/跨公司对外不可区分）。
//   AC3 模板升级只更新模板管理的字段，用户自定义字段保留——对照测试：升级
//     前后用户字段逐位不变；字段所有权是显式清单表（managed_by），不是约定。
//   AC4 私有 Bot 不出现在团队列表或团队搜索中——MT016 团队面（列表/计数/
//     详情）结构性不含私有 Bot（不同存储），测试以真实数据钉死。
//
// 结构（新文件优先；既有文件只动三处授权点：migrate-test.ts 追加任务 /
// migration-tool.test.ts 断言行+裁决 / schema barrel 追加 1 行）。
// 冻结面：bots-ownership.ts 与 runtime-config.ts 只消费、零改动（MT016
// 团队面服务仅用于 AC4 的对照断言）。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlan,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createPersonalBotFixture,
  type PersonalBotFixture,
  type PersonalBotIdentity,
} from "./support/personal-bot";

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
      reason: `MT059 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());

const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

const thrownMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

/** AC3 对照测试用：用户字段快照的确定性序列化（逐位比较的基准形态）。 */
const frozenSnapshot = (value: unknown): string => JSON.stringify(value);

/** 深拷贝（结构化克隆）后序列化——证明比较不受引用共享影响。 */
const clonedSnapshot = (value: unknown): string =>
  JSON.stringify(structuredClone(value));

// MT077 平台目录中的模板（fixture 经真实 install 拷贝到团队范围）。
const TEMPLATE_REF = "platform/research-daily";
// 模拟平台目录前进后的安装副本 v2（fixture 经真实 updateInstall 写入）：
// version/schedule 变值、digestAt 新增、sections 被模板移除。
const INSTALL_V2_DOCUMENT = Object.freeze({
  version: 2,
  schedule: "weekly",
  digestAt: "09:00",
});

// 创建时的用户字段（与模板字段无名字冲突）。
const INITIAL_USER_FIELDS = Object.freeze({
  style: "compact",
  myPrompt: "Keep answers short and cite sources.",
});

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: PersonalBotFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";

const principalOf = (identity: PersonalBotIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: PersonalBotIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT059 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT059 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt059-migration-${randomSuiteToken()}`);
  suiteGeneratedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT059", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT059 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT059", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT059", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT059 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT059", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT059 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createPersonalBotFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];

  // AC3 前置：team-a1 的模板安装副本 v1（经真实 MT077 install 拷贝目录条目）。
  await fixture.installs.writer.install({
    tenantId: companyA,
    workspaceId: teamA1,
    templateRef: TEMPLATE_REF,
  });
}, 60000);

const suiteGeneratedDirs: string[] = [];
const randomSuiteToken = () => Math.random().toString(36).slice(2, 10);

afterAll(async () => {
  for (const dir of suiteGeneratedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60000);

// ---------------------------------------------------------------------------
// AC1：同一(公司,团队,用户)重复请求得到同一个私有 Bot，不产生重复记录
// ---------------------------------------------------------------------------

describeDb("MT059 AC1：三元组幂等创建", () => {
  let agentId = "";

  itDb(
    "首建落一行：服务端 pbot- 身份 + 模板字段与用户字段同文档、所有权显式清单",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const outcome = await fixture.service.ensurePersonalBot(scope, {
        displayName: "My Private Research Bot",
        templateRef: TEMPLATE_REF,
        userFields: INITIAL_USER_FIELDS,
      });
      expect(outcome.outcome).toBe("allow");
      if (outcome.outcome !== "allow") throw new Error("unreachable");
      const bot = outcome.bot;
      agentId = bot.agentId;
      // 身份由服务端生成（专属命名空间），客户端无输入面。
      expect(bot.agentId.startsWith("pbot-")).toBe(true);
      expect(bot.tenantId).toBe(companyA);
      expect(bot.workspaceId).toBe(teamA1);
      expect(bot.ownerPrincipalId).toBe(principalOf("a1-member"));
      expect(bot.templateRef).toBe(TEMPLATE_REF);
      expect(bot.templateSourceRevision).toBe(1);
      // 文档 = 模板字段（来自安装副本 v1）+ 用户字段。
      expect(bot.fields.version).toBe(1);
      expect(bot.fields.sections).toEqual(["scan", "digest"]);
      expect(bot.fields.schedule).toBe("daily");
      expect(bot.fields.style).toBe("compact");
      expect(bot.fields.myPrompt).toBe("Keep answers short and cite sources.");
      // 字段所有权是显式清单（来自所有权表），不是约定推导。
      expect([...bot.templateFields].sort()).toEqual([
        "schedule",
        "sections",
        "version",
      ]);
      expect([...bot.userFields].sort()).toEqual(["myPrompt", "style"]);
      expect(bot.revision).toBe(1);
      // 输出深冻结：调用方拿到的是不可变快照。
      expect(Object.isFrozen(bot)).toBe(true);
      expect(Object.isFrozen(bot.fields)).toBe(true);
    },
  );

  itDb(
    "归属行真实落库：受限 data 角色在本公司 + 本主体上下文读到该行",
    async () => {
      const rows = await fixture.readPersonalBotRowsAsData(
        companyA,
        principalOf("a1-member"),
      );
      const row = rows.find((candidate) => candidate.agentId === agentId);
      expect(row).toBeDefined();
      expect(row?.workspaceId).toBe(teamA1);
    },
  );

  itDb(
    "字段所有权行真实落库：managed_by 显式区分 template 与 user",
    async () => {
      const rows = await fixture.readFieldOwnershipRowsAsData(
        companyA,
        principalOf("a1-member"),
      );
      const byField = new Map(
        rows.map((row) => [row.fieldName, row.managedBy]),
      );
      expect(byField.get("version")).toBe("template");
      expect(byField.get("sections")).toBe("template");
      expect(byField.get("schedule")).toBe("template");
      expect(byField.get("style")).toBe("user");
      expect(byField.get("myPrompt")).toBe("user");
      expect(byField.size).toBe(5);
    },
  );

  itDb(
    "重复请求返回同一 Bot：agentId/revision/字段全同，不产生第二行",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const first = await fixture.service.ensurePersonalBot(scope, {
        displayName: "My Private Research Bot",
        templateRef: TEMPLATE_REF,
      });
      const second = await fixture.service.ensurePersonalBot(scope, {
        displayName: "My Private Research Bot",
        templateRef: TEMPLATE_REF,
        // 重复请求携带不同 userFields 也不改写既有行（首建输入只在首建消费）。
        userFields: { style: "changed-after-create" },
      });
      expect(second.outcome).toBe("allow");
      if (second.outcome !== "allow" || first.outcome !== "allow") {
        throw new Error("unreachable");
      }
      expect(second.bot.agentId).toBe(first.bot.agentId);
      expect(second.bot.revision).toBe(first.bot.revision);
      expect(frozenSnapshot(second.bot.fields)).toBe(
        frozenSnapshot(first.bot.fields),
      );
      expect(second.bot.fields.style).toBe("compact");
      const counts = await fixture.rawCounts();
      expect(counts.personalBots).toBe(1);
    },
  );

  itDb(
    "重复请求带不同模板 ref：PERSONAL_BOT_TEMPLATE_CONFLICT 响亮拒绝且行数不变",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const message = await thrownMessage(() =>
        fixture.service.ensurePersonalBot(scope, {
          displayName: "My Private Research Bot",
          templateRef: "platform/welcome-playbook",
        }),
      );
      expect(message).toBe("PERSONAL_BOT_TEMPLATE_CONFLICT");
      const counts = await fixture.rawCounts();
      expect(counts.personalBots).toBe(1);
    },
  );

  itDb(
    "输入校验：坏名字/非对象字段/归属键/超大文档/坏字段名 响亮拒绝",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(scope, {
            displayName: "   ",
            templateRef: TEMPLATE_REF,
          }),
        ),
      ).toBe("PERSONAL_BOT_INPUT_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(scope, {
            displayName: "x",
            templateRef: TEMPLATE_REF,
            userFields: "not-an-object" as unknown as Record<string, unknown>,
          }),
        ),
      ).toBe("PERSONAL_BOT_DOCUMENT_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(scope, {
            displayName: "x",
            templateRef: TEMPLATE_REF,
            userFields: { tenantId: "forged" },
          }),
        ),
      ).toBe("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(scope, {
            displayName: "x",
            templateRef: TEMPLATE_REF,
            userFields: { big: "y".repeat(70_000) },
          }),
        ),
      ).toBe("PERSONAL_BOT_DOCUMENT_TOO_LARGE");
      expect(
        await thrownMessage(() =>
          fixture.service.updateUserFields(scope, { fields: { "": 1 } }),
        ),
      ).toBe("PERSONAL_BOT_FIELD_NAME_INVALID");
    },
  );

  itDb(
    "上下文与信任判定：缺团队上下文与 forged scope 各得明确拒绝码",
    async () => {
      // 形状先于信任：缺上下文的 scope 得 TENANT/WORKSPACE_REQUIRED。
      const noWorkspace = {
        tenantId: companyA,
        workspaceId: "",
        principalId: principalOf("a1-member"),
        actorId: fixture.ids["user-a1-member"],
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(noWorkspace, {
            displayName: "x",
          }),
        ),
      ).toBe("WORKSPACE_REQUIRED");
      // 结构完好但从未签发的 scope（WeakSet 信任门）→ UNVERIFIED_SCOPE。
      const forged = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: principalOf("a1-member"),
        actorId: fixture.ids["user-a1-member"],
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.service.ensurePersonalBot(forged, {
            displayName: "x",
            templateRef: TEMPLATE_REF,
          }),
        ),
      ).toBe("UNVERIFIED_SCOPE");
    },
  );
});

// ---------------------------------------------------------------------------
// AC2：同一用户在两个公司分别获得独立私有 Bot，数据互不可见
// ---------------------------------------------------------------------------

describeDb("MT059 AC2：双公司独立私有 Bot 与 canonical 不可见", () => {
  let agentA = "";
  let agentB = "";

  itDb("同一人在 A1 与 B1 各得独立 Bot：两行、两个身份、互不共享", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const inA = await fixture.service.ensurePersonalBot(scopeA, {
      displayName: "Same Person A",
      templateRef: TEMPLATE_REF,
    });
    // team-b1 无模板安装：B 侧私有 Bot 以无模板形态独立存在（模板安装是
    // 团队范围事实，不随人跨公司漂移）。
    const inB = await fixture.service.ensurePersonalBot(scopeB, {
      displayName: "Same Person B",
      userFields: { own: "B-side" },
    });
    if (inA.outcome !== "allow" || inB.outcome !== "allow") {
      throw new Error("unreachable");
    }
    agentA = inA.bot.agentId;
    agentB = inB.bot.agentId;
    expect(agentA).not.toBe(agentB);
    expect(inA.bot.workspaceId).toBe(teamA1);
    expect(inB.bot.workspaceId).toBe(teamB1);
    const counts = await fixture.rawCounts();
    // a1-member 的首建 Bot + multi-company 的两行 = 3 行（无合并无重复）。
    expect(counts.personalBots).toBe(3);
  });

  itDb(
    "跨公司按 id 读 = canonical not-found（与不存在 id 逐字节同形）",
    async () => {
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      const crossCompany = await fixture.service.getPersonalBotById(
        scopeA,
        agentB,
      );
      const missing = await fixture.service.getPersonalBotById(
        scopeA,
        "pbot-00000000-0000-4000-8000-000000000000",
      );
      expect(isCanonicalNotFound(crossCompany)).toBe(true);
      expect(isCanonicalNotFound(missing)).toBe(true);
      // 不存在与跨公司对外不可区分：判定字节逐位相同。
      expect(frozenSnapshot(crossCompany)).toBe(frozenSnapshot(missing));
      expect(frozenSnapshot(crossCompany)).toBe(canonicalNotFoundJson);
    },
  );

  itDb(
    "跨公司上下文取本人私有 Bot = canonical not-found（scope 钉住三元组）",
    async () => {
      // B1 里已有 multi-company 的 Bot；同一人换到 A1 上下文只能看到 A1 的
      // 那一行——B 的行在 A 上下文不可见。
      const scopeA = await scopeAs("multi-company", companyA, teamA1);
      const own = await fixture.service.getPersonalBot(scopeA);
      expect(own.outcome).toBe("allow");
      if (own.outcome !== "allow") throw new Error("unreachable");
      expect(own.bot.agentId).toBe(agentA);
      // B 公司的行对 A 的 data 角色不可见（RLS 租户过滤）。
      const rowsAsA = await fixture.readPersonalBotRowsAsData(
        companyA,
        principalOf("multi-company"),
      );
      expect(rowsAsA.some((row) => row.agentId === agentB)).toBe(false);
      expect(rowsAsA.some((row) => row.agentId === agentA)).toBe(true);
    },
  );

  itDb("更新 A 的用户字段不影响 B：字段逐位 + revision 独立", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const beforeB = await fixture.service.getPersonalBot(scopeB);
    if (beforeB.outcome !== "allow") throw new Error("unreachable");
    const beforeBSnapshot = clonedSnapshot(beforeB.bot.fields);

    const updatedA = await fixture.service.updateUserFields(scopeA, {
      fields: { noteA: "only-A" },
    });
    expect(updatedA.outcome).toBe("allow");
    if (updatedA.outcome !== "allow") throw new Error("unreachable");
    expect(updatedA.bot.fields.noteA).toBe("only-A");

    const afterB = await fixture.service.getPersonalBot(scopeB);
    if (afterB.outcome !== "allow") throw new Error("unreachable");
    expect(frozenSnapshot(afterB.bot.fields)).toBe(beforeBSnapshot);
    expect(afterB.bot.revision).toBe(beforeB.bot.revision);
  });

  itDb("私有即逐主体：同团队其他用户读不到我的私有 Bot", async () => {
    const otherScope = await scopeAs("a1-other", companyA, teamA1);
    const otherView = await fixture.service.getPersonalBot(otherScope);
    expect(isCanonicalNotFound(otherView)).toBe(true);
    // a1-other 也不能用 a1-member 的 agentId 读（restrictive 主体自读）。
    const byId = await fixture.service.getPersonalBotById(otherScope, agentA);
    expect(isCanonicalNotFound(byId)).toBe(true);
    // RLS 结构性证明：data 角色在 a1-other 上下文看不到 a1-member 的行。
    const rows = await fixture.readPersonalBotRowsAsData(
      companyA,
      principalOf("a1-other"),
    );
    expect(rows.some((row) => row.agentId === agentA)).toBe(false);
  });

  itDb(
    "同公司跨团队上下文不可见（三元组钉住团队，归属者本人也一样）",
    async () => {
      // a1a2-member 在 team-a1 创建私有 Bot；同一人切到 team-a2 上下文：
      // 三元组 (A, a2, 本人) 无行 → not-found；按 a1 的 agentId 读同样
      // not-found——三元组钉住团队，私有 Bot 不随人跨团队漂移。
      const a1Scope = await scopeAs("a1a2-member", companyA, teamA1);
      const created = await fixture.service.ensurePersonalBot(a1Scope, {
        displayName: "Dual Team Bot",
        userFields: { dual: true },
      });
      expect(created.outcome).toBe("allow");
      if (created.outcome !== "allow") throw new Error("unreachable");
      const a2Scope = await scopeAs("a1a2-member", companyA, teamA2);
      const view = await fixture.service.getPersonalBot(a2Scope);
      expect(isCanonicalNotFound(view)).toBe(true);
      const byId = await fixture.service.getPersonalBotById(
        a2Scope,
        created.bot.agentId,
      );
      expect(isCanonicalNotFound(byId)).toBe(true);
      // 切回 a1 上下文原样可见（团队选择决定看到哪一个三元组行）。
      const back = await fixture.service.getPersonalBot(a1Scope);
      expect(back.outcome).toBe("allow");
      if (back.outcome !== "allow") throw new Error("unreachable");
      expect(back.bot.agentId).toBe(created.bot.agentId);
    },
  );
});

// ---------------------------------------------------------------------------
// AC3：模板升级只更新模板管理的字段，用户自定义字段保留（对照测试）
// ---------------------------------------------------------------------------

describeDb("MT059 AC3：模板升级与用户字段保护", () => {
  let userFieldsBeforeUpgrade = "";

  beforeAll(async () => {
    if (!ENV.ok) return;
    // 独立的升级对照 Bot（a2-member，A 公司 team-a2，同样安装模板 v1）。
    await fixture.installs.writer.install({
      tenantId: companyA,
      workspaceId: teamA2,
      templateRef: TEMPLATE_REF,
    });
    const scope = await scopeAs("a2-member", companyA, teamA2);
    const created = await fixture.service.ensurePersonalBot(scope, {
      displayName: "Upgrade Comparison Bot",
      templateRef: TEMPLATE_REF,
      userFields: INITIAL_USER_FIELDS,
    });
    if (created.outcome !== "allow") throw new Error("unreachable");
    // 创建后追加一个用户字段。
    const withMore = await fixture.service.updateUserFields(scope, {
      fields: { sticky: "user-owned-value" },
    });
    if (withMore.outcome !== "allow") throw new Error("unreachable");
    // 对照基准：升级前的用户字段快照（深拷贝后序列化）。
    userFieldsBeforeUpgrade = clonedSnapshot({
      style: withMore.bot.fields.style,
      myPrompt: withMore.bot.fields.myPrompt,
      sticky: withMore.bot.fields.sticky,
    });
  }, 30000);

  itDb(
    "对照测试：升级后用户字段逐位不变，模板字段按新副本更新/新增/移除",
    async () => {
      // 平台目录前进 → fixture 经真实 MT077 updateInstall 把安装副本刷到
      // v2（version/schedule 变值、digestAt 新增、sections 被移除）。
      const install = await fixture.installs.reader.read(
        companyA,
        teamA2,
        TEMPLATE_REF,
      );
      if (!install) throw new Error("unreachable: install must exist");
      const updatedInstall = await fixture.installs.writer.updateInstall({
        tenantId: companyA,
        workspaceId: teamA2,
        templateRef: TEMPLATE_REF,
        document: INSTALL_V2_DOCUMENT,
        expectedRevision: install.revision,
      });
      expect(updatedInstall.document).toEqual(INSTALL_V2_DOCUMENT);

      const scope = await scopeAs("a2-member", companyA, teamA2);
      const upgraded = await fixture.service.applyTemplateUpgrade(scope, {});
      expect(upgraded.outcome).toBe("allow");
      if (upgraded.outcome !== "allow") throw new Error("unreachable");
      const bot = upgraded.bot;

      // 模板管理字段：随新副本更新（值变化）、新增、移除。
      expect(bot.fields.version).toBe(2);
      expect(bot.fields.schedule).toBe("weekly");
      expect(bot.fields.digestAt).toBe("09:00");
      expect("sections" in bot.fields).toBe(false);
      // 对照断言：用户字段逐位不变（AC3 的核心）。
      expect(
        clonedSnapshot({
          style: bot.fields.style,
          myPrompt: bot.fields.myPrompt,
          sticky: bot.fields.sticky,
        }),
      ).toBe(userFieldsBeforeUpgrade);
      expect(bot.fields.style).toBe("compact");
      expect(bot.fields.myPrompt).toBe("Keep answers short and cite sources.");
      expect(bot.fields.sticky).toBe("user-owned-value");
      // 所有权清单反映升级后的显式事实。
      expect([...bot.templateFields].sort()).toEqual([
        "digestAt",
        "schedule",
        "version",
      ]);
      expect([...bot.userFields].sort()).toEqual([
        "myPrompt",
        "sticky",
        "style",
      ]);
      // 版本号前进 + 模板来源修订推进。
      expect(bot.revision).toBeGreaterThan(1);
      expect(bot.templateSourceRevision).toBe(1);
    },
  );

  itDb(
    "升级后所有权表真实状态：sections 行消失、digestAt 行 template、用户行原样",
    async () => {
      const rows = await fixture.readFieldOwnershipRowsAsData(
        companyA,
        principalOf("a2-member"),
      );
      const byField = new Map(
        rows.map((row) => [row.fieldName, row.managedBy]),
      );
      expect(byField.has("sections")).toBe(false);
      expect(byField.get("digestAt")).toBe("template");
      expect(byField.get("style")).toBe("user");
      expect(byField.get("sticky")).toBe("user");
      expect(byField.get("myPrompt")).toBe("user");
      expect(byField.get("version")).toBe("template");
      expect(byField.get("schedule")).toBe("template");
    },
  );

  itDb(
    "升级前用户字段不可被模板字段名侵占：写入模板管理字段响亮拒绝",
    async () => {
      const scope = await scopeAs("a2-member", companyA, teamA2);
      const message = await thrownMessage(() =>
        fixture.service.updateUserFields(scope, { fields: { version: 99 } }),
      );
      expect(message).toBe("PERSONAL_BOT_FIELD_MANAGED_BY_TEMPLATE");
      const view = await fixture.service.getPersonalBot(scope);
      if (view.outcome !== "allow") throw new Error("unreachable");
      // 拒绝后文档值不变。
      expect(view.bot.fields.version).toBe(2);
    },
  );

  itDb(
    "升级时模板 ref 不匹配 = PERSONAL_BOT_TEMPLATE_CONFLICT（模板身份不可换）",
    async () => {
      const scope = await scopeAs("a2-member", companyA, teamA2);
      const message = await thrownMessage(() =>
        fixture.service.applyTemplateUpgrade(scope, {
          templateRef: "platform/welcome-playbook",
        }),
      );
      expect(message).toBe("PERSONAL_BOT_TEMPLATE_CONFLICT");
    },
  );

  itDb(
    "无模板 Bot 升级 = PERSONAL_BOT_TEMPLATE_REQUIRED 响亮拒绝",
    async () => {
      // team-b1 无模板安装；b1-member 创建无模板私有 Bot 后请求升级。
      const scope = await scopeAs("b1-member", companyB, teamB1);
      const created = await fixture.service.ensurePersonalBot(scope, {
        displayName: "No Template Bot",
        userFields: { own: true },
      });
      expect(created.outcome).toBe("allow");
      if (created.outcome !== "allow") throw new Error("unreachable");
      expect(created.bot.templateRef).toBeNull();
      expect(created.bot.templateFields).toEqual([]);
      const message = await thrownMessage(() =>
        fixture.service.applyTemplateUpgrade(scope, {}),
      );
      expect(message).toBe("PERSONAL_BOT_TEMPLATE_REQUIRED");
    },
  );

  itDb(
    "团队无该模板安装副本时按模板创建 = PERSONAL_BOT_TEMPLATE_NOT_FOUND",
    async () => {
      // a1-other 在 team-a1 从未创建过 Bot；team-a1 只安装了 research-daily，
      // 按未安装的 support-triage 创建 = 安装副本缺失，响亮拒绝。
      const scope = await scopeAs("a1-other", companyA, teamA1);
      const message = await thrownMessage(() =>
        fixture.service.ensurePersonalBot(scope, {
          displayName: "Ghost Template Bot",
          templateRef: "platform/support-triage",
        }),
      );
      expect(message).toBe("PERSONAL_BOT_TEMPLATE_NOT_FOUND");
    },
  );
});

// ---------------------------------------------------------------------------
// AC4：私有 Bot 不出现在团队列表或团队搜索中
// ---------------------------------------------------------------------------

describeDb("MT059 AC4：私有 Bot 不进 MT016 团队列表/计数/详情", () => {
  let personalAgentId = "";
  let controlBotId = "";

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const personal = await fixture.service.ensurePersonalBot(scope, {
      displayName: "List Invisibility Probe",
      templateRef: TEMPLATE_REF,
    });
    if (personal.outcome !== "allow") throw new Error("unreachable");
    personalAgentId = personal.bot.agentId;
    // 对照组：同一团队里经 MT016 面创建的团队 Bot——证明列表/计数工作正常，
    // 私有 Bot 的缺席是结构性的，不是列表坏了。
    const control = await fixture.teamBots.createBot(scope, {
      agentId: `mt059-control-${personalAgentId.slice(5, 13)}`,
      displayName: "MT059 Control Team Bot",
      defaultConfig: { model: "gpt-4o" },
    });
    expect(control.outcome).toBe("allow");
    if (control.outcome !== "allow") throw new Error("unreachable");
    controlBotId = control.bot.agentId;
  }, 30000);

  itDb("MT016 团队列表含对照组团队 Bot、绝不含私有 Bot", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const page = await fixture.teamBots.listBots(scope, { limit: 200 });
    expect(page.items.some((item) => item.agentId === controlBotId)).toBe(true);
    expect(page.items.some((item) => item.agentId === personalAgentId)).toBe(
      false,
    );
  });

  itDb("MT016 团队计数不含私有 Bot", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const { total } = await fixture.teamBots.countBots(scope);
    // 同套件在 team-a1 留下的 MT016 团队归属行只有对照组这一行；私有 Bot
    //（含 multi-company 在 A1 的行）一概不计。
    expect(total).toBe(1);
  });

  itDb(
    "MT016 详情按私有 Bot id 读 = canonical not-found（逐字节同形）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const verdict = await fixture.teamBots.getBot(scope, personalAgentId);
      expect(isCanonicalNotFound(verdict)).toBe(true);
      expect(frozenSnapshot(verdict)).toBe(canonicalNotFoundJson);
    },
  );

  itDb(
    "结构性证明：私有 Bot 从未写入 enterprise_bot_ownership 与团队发布注册表",
    async () => {
      const counts = await fixture.rawCounts();
      // 本套件全部租户前缀内：MT016 归属行只有对照组 1 行，发布注册表 0 行
      // （私有 Bot 不经 MT016 归属存储、不经 MT008/MT009 团队公共注册表）。
      expect(counts.teamOwnershipRows).toBe(1);
      expect(counts.resourceRegistryRows).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 撤权 fail-closed + 存储与迁移契约
// ---------------------------------------------------------------------------

describeDb("MT059 存储契约：成员重验、受限角色、迁移确定性", () => {
  itDb(
    "公司成员资格暂停后：ensure 响亮拒绝、读取 fail-closed not-found",
    async () => {
      const scopeBefore = await scopeAs("a1-member", companyA, teamA1);
      await fixture.suspendCompanyMembership(
        companyA,
        principalOf("a1-member"),
      );
      try {
        const message = await thrownMessage(() =>
          fixture.service.ensurePersonalBot(scopeBefore, {
            displayName: "Suspended Bot",
            templateRef: TEMPLATE_REF,
          }),
        );
        expect(message).toBe("WORKSPACE_MEMBERSHIP_REQUIRED");
        const view = await fixture.service.getPersonalBot(scopeBefore);
        expect(isCanonicalNotFound(view)).toBe(true);
      } finally {
        await fixture.reinstateCompanyMembership(
          companyA,
          principalOf("a1-member"),
        );
      }
      // 恢复后旧 scope（暂停前签发）因 epoch 前进而仍被拒：新 scope 正常。
      const staleScopeView = await fixture.service.getPersonalBot(scopeBefore);
      expect(isCanonicalNotFound(staleScopeView)).toBe(true);
      const freshScope = await scopeAs("a1-member", companyA, teamA1);
      const freshView = await fixture.service.getPersonalBot(freshScope);
      expect(freshView.outcome).toBe("allow");
    },
  );

  itDb("未验证通道装配拒绝：UNVERIFIED_DATABASE_CAPABILITY", async () => {
    const { createPersonalBotService } = await import(
      "../../src/enterprise/tenancy/personal-bot"
    );
    const fake = {} as never;
    expect(() =>
      createPersonalBotService({ data: fake, operator: fake }),
    ).toThrow("UNVERIFIED_DATABASE_CAPABILITY");
  });

  itDb(
    "套件全部受限查询以 ob_ent_* 能力角色执行（current_user 断言）",
    async () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          call.currentUser === "ob_ent_data" ||
            call.currentUser === "ob_ent_operator" ||
            call.currentUser === "ob_ent_directory",
        ).toBe(true);
      }
    },
  );

  itDb("MT059 迁移计划确定性：两次 buildPlan 全等、步骤名固定", async () => {
    const first = buildPlan("MT059");
    const second = buildPlan("MT059");
    expect(first.steps.map((step) => step.name)).toEqual([
      "0001_mt059_personal_bot_tables.sql",
      "0002_mt059_personal_bot_rls.sql",
    ]);
    expect(first).toEqual(second);
    expect(first.planDigest).toBe(second.planDigest);
  });

  itDb(
    "无租户上下文 RLS fail-closed：data 角色读不到任何私有 Bot 行",
    async () => {
      const rows = await fixture.readPersonalBotRowsAsData("", "");
      expect(rows).toEqual([]);
    },
  );
});
