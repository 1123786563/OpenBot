// server/tests/multitenancy/bots-ownership.test.ts
// MT016（Issue #59）：Bot 归属固定——Bot、其偏好与默认配置都固定在当前
// 公司与团队；另一家公司或非团队成员看不到也改不了它。
//
// 验收事实源（brief 票面 4 条 + Issue #59 五条，逐条对应 describe；真实
// PostgreSQL，全程受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env
// 显式 skip）：
//   验收 1（brief/issue）：创建的 Bot 记录公司与团队归属；列表只返回当前
//     范围内可见的 Bot。
//   验收 2（brief/issue）：跨公司或非团队成员访问详情/配置返回不可见语义
//     ——MT011 canonical { outcome: "deny", code: "RESOURCE_NOT_FOUND" }，
//     逐字节同形，不泄露存在性（不存在/跨公司/跨团队对外不可区分）。
//   验收 3（issue）：非团队成员看不到该团队的 Bot，也不能通过搜索或计数
//     发现它（列表/计数/游标全零）。
//   验收 4（issue）：同一用户在两个公司分别创建的 Bot 互不干扰（含同名）。
//   验收 5（issue）：删除或账号清理使用公司作用域，不会仅凭用户 ID 删掉
//     他在其他公司的 Bot。
//   brief 验收 3：编辑仅限归属范围内的授权成员（owner）；越权编辑被拒
//     （同团队非 owner = BOT_EDIT_FORBIDDEN；不可见者 = canonical
//     not-found；公司管理员无团队上下文，连 scope 都无法铸造）。
//   brief 验收 4：Bot 偏好与默认配置与 Bot 同归属（默认配置在归属行内；
//     偏好行复合 FK → 归属行 + 公司成员，结构上不可跨公司存在）。
//
// 结构（新文件优先；既有文件只动三处授权点：migrate-test.ts 追加任务 /
// migration-tool.test.ts 断言行+裁决 / schema barrel 追加 1 行）。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlan,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createBotOwnershipService } from "../../src/enterprise/tenancy/bots-ownership";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
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
      reason: `MT016 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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

const thrownMessageSync = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

/** 非归属键的合法默认配置文档（同归属断言用它做逐字节往返比较）。 */
const BASE_CONFIG = Object.freeze({
  model: "gpt-4o",
  systemPrompt: "You are the research assistant of this team.",
  temperature: 0.2,
});

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: BotsOwnershipFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
/** 验收 4 双公司同名 Bot 的句柄，提升到套件层供验收 5 的枚举全集断言复用。 */
let dualA = { agentId: "", displayName: "" };
let dualB = { agentId: "", displayName: "" };
const generatedDirs: string[] = [];
let botCounter = 0;

/** 确定性的测试 Bot id/displayName 生成（避免用例间相互依赖具体值）。 */
const nextBot = (tag: string) => {
  botCounter += 1;
  return {
    agentId: `mt016-bot-${String(botCounter).padStart(3, "0")}-${tag}`,
    displayName: `MT016 Bot ${String(botCounter).padStart(3, "0")} ${tag}`,
  };
};

const principalOf = (identity: BotsIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: BotsIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

beforeAll(async () => {
  if (!ENV.ok) return;

  // MT016 migration through the real MT003 tool: generate → apply → replay
  // is convergent (applied on a fresh database, up-to-date on replay).
  if (!resolveTestDatabaseTarget(process.env).ok) {
    throw new Error(
      "MT016 migration target refused: TEST_DATABASE_URL invalid",
    );
  }
  const dir = join("/tmp", `mt016-migration-${randomUUID().slice(0, 8)}`);
  generatedDirs.push(dir);
  const generation = await runMigrateTest(["generate", "MT016", "--out", dir], {
    environment: process.env,
    out: () => {},
  });
  if (generation.kind !== "generated") {
    throw new Error(`MT016 generate failed: ${JSON.stringify(generation)}`);
  }
  const manifestPath = join(dir, "MT016", "manifest.json");
  const applied: RunOutcome = await runMigrateTest(
    ["migrate", "MT016", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (!["applied", "up-to-date"].includes(applied.kind)) {
    throw new Error(`MT016 apply failed: ${JSON.stringify(applied)}`);
  }
  const replay = await runMigrateTest(
    ["migrate", "MT016", "--apply", "--manifest", manifestPath],
    { environment: process.env, out: () => {} },
  );
  if (replay.kind !== "up-to-date") {
    throw new Error(`MT016 replay not convergent: ${JSON.stringify(replay)}`);
  }

  fixture = await createBotsOwnershipFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];
}, 60000);

afterAll(async () => {
  for (const dir of generatedDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  if (fixture) {
    await fixture.dispose();
  }
}, 60000);

// ---------------------------------------------------------------------------
// 验收 1：创建的 Bot 记录公司与团队归属；列表只返回当前范围内可见的 Bot
// ---------------------------------------------------------------------------

describeDb("MT016 验收 1：创建记录归属，列表只返回当前范围", () => {
  let owned = { agentId: "", displayName: "" };

  itDb(
    "create 在受信 scope 内落归属行：公司 + 团队 + owner + 默认配置（深冻结）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      owned = nextBot("owned");
      const outcome = await fixture.service.createBot(scope, {
        agentId: owned.agentId,
        displayName: owned.displayName,
        defaultConfig: BASE_CONFIG,
      });
      expect(outcome.outcome).toBe("allow");
      if (outcome.outcome !== "allow") throw new Error("unreachable");
      expect(outcome.bot.agentId).toBe(owned.agentId);
      expect(outcome.bot.workspaceId).toBe(teamA1);
      expect(outcome.bot.ownerPrincipalId).toBe(principalOf("a1-member"));
      expect(outcome.bot.revision).toBe(1);
      expect(outcome.bot.aclEpoch).toBe(1);
      expect(outcome.bot.defaultConfig).toEqual(BASE_CONFIG);
      // 输出深冻结：调用方拿到的是不可变快照（缓存/复用安全）。
      expect(Object.isFrozen(outcome.bot)).toBe(true);
      expect(Object.isFrozen(outcome.bot.defaultConfig)).toBe(true);
    },
  );

  itDb("归属行真实落库：受限 data 角色在 A 公司上下文读到该行", async () => {
    const rows = await fixture.readOwnershipRowsAsData(companyA);
    const row = rows.find((candidate) => candidate.agentId === owned.agentId);
    expect(row).toBeDefined();
    expect(row?.workspaceId).toBe(teamA1);
  });

  itDb("owner 与同团队另一成员的列表都含该 Bot（团队内可见）", async () => {
    const ownerScope = await scopeAs("a1-member", companyA, teamA1);
    const otherScope = await scopeAs("a1-other", companyA, teamA1);
    for (const scope of [ownerScope, otherScope]) {
      const page = await fixture.service.listBots(scope, { limit: 200 });
      expect(page.items.some((item) => item.agentId === owned.agentId)).toBe(
        true,
      );
    }
  });

  itDb(
    "同公司其他团队与另一家公司的列表都不含该 Bot（列表即作用域）",
    async () => {
      const a2Scope = await scopeAs("a2-member", companyA, teamA2);
      const b1Scope = await scopeAs("b1-member", companyB, teamB1);
      for (const scope of [a2Scope, b1Scope]) {
        const page = await fixture.service.listBots(scope, { limit: 200 });
        expect(page.items.some((item) => item.agentId === owned.agentId)).toBe(
          false,
        );
      }
    },
  );

  itDb("create 拒绝未经签发的 scope（信任边界不放宽）", async () => {
    const forged = {
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-member"),
      actorId: fixture.ids["user-a1-member"],
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } as PlatformScope;
    const bot = nextBot("forged");
    const message = await thrownMessage(() =>
      fixture.service.createBot(forged, {
        agentId: bot.agentId,
        displayName: bot.displayName,
        defaultConfig: BASE_CONFIG,
      }),
    );
    expect(message).toContain("UNVERIFIED_SCOPE");
  });

  itDb(
    "create 在缺公司/团队上下文时明确拒绝（TENANT/WORKSPACE_REQUIRED）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const bot = nextBot("noctx");
      const withoutTenant = await thrownMessage(() =>
        fixture.service.createBot(
          { ...scope, tenantId: "   " } as PlatformScope,
          {
            agentId: bot.agentId,
            displayName: bot.displayName,
            defaultConfig: BASE_CONFIG,
          },
        ),
      );
      expect(withoutTenant).toContain("TENANT_REQUIRED");
      const withoutWorkspace = await thrownMessage(() =>
        fixture.service.createBot(
          { ...scope, workspaceId: "" } as PlatformScope,
          {
            agentId: bot.agentId,
            displayName: bot.displayName,
            defaultConfig: BASE_CONFIG,
          },
        ),
      );
      expect(withoutWorkspace).toContain("WORKSPACE_REQUIRED");
    },
  );

  itDb(
    "create 输入校验：空 id/名称、非对象配置、超大文档一律响亮拒绝",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const bot = nextBot("invalid");
      expect(
        await thrownMessage(() =>
          fixture.service.createBot(scope, {
            agentId: "   ",
            displayName: bot.displayName,
            defaultConfig: BASE_CONFIG,
          }),
        ),
      ).toContain("BOT_INPUT_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.service.createBot(scope, {
            agentId: bot.agentId,
            displayName: "",
            defaultConfig: BASE_CONFIG,
          }),
        ),
      ).toContain("BOT_INPUT_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.service.createBot(scope, {
            agentId: bot.agentId,
            displayName: bot.displayName,
            defaultConfig: [1, 2, 3] as unknown as Record<string, unknown>,
          }),
        ),
      ).toContain("BOT_DOCUMENT_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.service.createBot(scope, {
            agentId: bot.agentId,
            displayName: bot.displayName,
            defaultConfig: { payload: "x".repeat(70_000) },
          }),
        ),
      ).toContain("BOT_DOCUMENT_TOO_LARGE");
    },
  );

  itDb(
    "客户端不能声明归属：配置顶层携带归属键被拒（ATTRIBUTION_NOT_CLIENT_DECLARABLE）",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const bot = nextBot("attrib");
      for (const key of [
        "tenantId",
        "workspaceId",
        "ownerPrincipalId",
        "tenant_id",
        "workspace_id",
        "owner_principal_id",
      ]) {
        const message = await thrownMessage(() =>
          fixture.service.createBot(scope, {
            agentId: bot.agentId,
            displayName: bot.displayName,
            defaultConfig: { [key]: companyB },
          }),
        );
        expect(message).toContain("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
      }
      // 归属只能来自受信 scope：即使指向「正确」的公司也拒绝——形状不存在。
      const message = await thrownMessage(() =>
        fixture.service.createBot(scope, {
          agentId: bot.agentId,
          displayName: bot.displayName,
          defaultConfig: { tenantId: companyA },
        }),
      );
      expect(message).toContain("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    },
  );

  itDb(
    "同 id 重复创建被拒（BOT_ID_UNAVAILABLE），且跨公司已占用与同公司已占用不可区分",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const clash = nextBot("clash");
      const first = await fixture.service.createBot(scope, {
        agentId: clash.agentId,
        displayName: clash.displayName,
        defaultConfig: BASE_CONFIG,
      });
      expect(first.outcome).toBe("allow");
      // 同公司重复。
      const sameCompany = await thrownMessage(() =>
        fixture.service.createBot(scope, {
          agentId: clash.agentId,
          displayName: clash.displayName,
          defaultConfig: BASE_CONFIG,
        }),
      );
      expect(sameCompany).toContain("BOT_ID_UNAVAILABLE");
      // 另一家公司拿同一 id：同样拒绝、同一代码——不泄露占用发生在哪家。
      const b1Scope = await scopeAs("b1-member", companyB, teamB1);
      const crossCompany = await thrownMessage(() =>
        fixture.service.createBot(b1Scope, {
          agentId: clash.agentId,
          displayName: clash.displayName,
          defaultConfig: BASE_CONFIG,
        }),
      );
      expect(crossCompany).toContain("BOT_ID_UNAVAILABLE");
      expect(crossCompany).not.toContain(companyA);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：跨公司或非团队成员访问返回不可见语义（canonical not-found）
// ---------------------------------------------------------------------------

describeDb("MT016 验收 2：跨公司/跨团队访问 = canonical not-found", () => {
  let hidden = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-member", companyA, teamA1);
    hidden = nextBot("hidden");
    const outcome = await fixture.service.createBot(scope, {
      agentId: hidden.agentId,
      displayName: hidden.displayName,
      defaultConfig: BASE_CONFIG,
    });
    if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
  });

  itDb(
    "另一家公司成员 getBot → canonical RESOURCE_NOT_FOUND（逐字节同形）",
    async () => {
      const b1Scope = await scopeAs("b1-member", companyB, teamB1);
      const verdict = await fixture.service.getBot(b1Scope, hidden.agentId);
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb("不存在的 id 与跨公司 id 的拒绝逐字节相同（不泄露存在性）", async () => {
    const b1Scope = await scopeAs("b1-member", companyB, teamB1);
    const missing = await fixture.service.getBot(
      b1Scope,
      "mt016-bot-never-created",
    );
    const crossCompany = await fixture.service.getBot(b1Scope, hidden.agentId);
    expect(JSON.stringify(missing)).toBe(JSON.stringify(crossCompany));
    expect(JSON.stringify(missing)).toBe(canonicalNotFoundJson);
  });

  itDb(
    "同公司非团队成员 getBot → 同一 canonical 形状（跨团队不可见）",
    async () => {
      const a2Scope = await scopeAs("a2-member", companyA, teamA2);
      const verdict = await fixture.service.getBot(a2Scope, hidden.agentId);
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb(
    "同公司双团队成员：scope 钉在哪个团队就只见哪个团队的 Bot（a1 Bot 对 a2 scope 不可见）",
    async () => {
      // 同一人在同公司两个团队都持有 active 成员关系：可见性门钉的是
      // 「受信 scope 的团队」，不是「调用者在任意团队的成员资格」——从
      // team-a2 scope 读 team-a1 的 Bot = canonical not-found；切回 team-a1
      // scope 则可见。归属固定在当前公司与团队，不随跨团队成员资格扩大。
      const asA2 = await scopeAs("a1a2-member", companyA, teamA2);
      const fromA2 = await fixture.service.getBot(asA2, hidden.agentId);
      expect(isCanonicalNotFound(fromA2)).toBe(true);
      const asA1 = await scopeAs("a1a2-member", companyA, teamA1);
      const fromA1 = await fixture.service.getBot(asA1, hidden.agentId);
      expect(fromA1.outcome).toBe("allow");
      // 列表同样钉在 scope 团队：a2 scope 的列表不含 a1 团队的 Bot。
      const listFromA2 = await fixture.service.listBots(asA2, { limit: 200 });
      expect(
        listFromA2.items.some((item) => item.agentId === hidden.agentId),
      ).toBe(false);
    },
  );

  itDb(
    "跨公司成员的更新/删除/偏好写入全部是 canonical not-found（不是 forbidden）",
    async () => {
      const b1Scope = await scopeAs("b1-member", companyB, teamB1);
      const updated = await fixture.service.updateBot(b1Scope, hidden.agentId, {
        displayName: "hijacked",
        defaultConfig: { model: "stolen" },
      });
      expect(isCanonicalNotFound(updated)).toBe(true);
      const deleted = await fixture.service.deleteBot(b1Scope, hidden.agentId);
      expect(isCanonicalNotFound(deleted)).toBe(true);
      const preference = await fixture.service.setBotPreference(
        b1Scope,
        hidden.agentId,
        { pinned: true },
      );
      expect(isCanonicalNotFound(preference)).toBe(true);
      const read = await fixture.service.getBotPreference(
        b1Scope,
        hidden.agentId,
      );
      expect(isCanonicalNotFound(read)).toBe(true);
    },
  );

  itDb(" Bot 删除后（软删）对同团队也回到 canonical not-found", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const doomed = nextBot("doomed");
    await fixture.service.createBot(scope, {
      agentId: doomed.agentId,
      displayName: doomed.displayName,
      defaultConfig: BASE_CONFIG,
    });
    const deleted = await fixture.service.deleteBot(scope, doomed.agentId);
    expect(deleted.outcome).toBe("allow");
    const gone = await fixture.service.getBot(scope, doomed.agentId);
    expect(isCanonicalNotFound(gone)).toBe(true);
    const updated = await fixture.service.updateBot(scope, doomed.agentId, {
      displayName: "zombie",
      defaultConfig: BASE_CONFIG,
    });
    expect(isCanonicalNotFound(updated)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 3（issue）：非团队成员不能通过搜索或计数发现团队 Bot
// ---------------------------------------------------------------------------

describeDb("MT016 验收 3：列表/计数/游标对非成员全零，不泄露存在性", () => {
  let first = { agentId: "", displayName: "" };
  let second = { agentId: "", displayName: "" };
  let third = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-member", companyA, teamA1);
    first = nextBot("page-1");
    second = nextBot("page-2");
    third = nextBot("page-3");
    for (const bot of [first, second, third]) {
      const outcome = await fixture.service.createBot(scope, {
        agentId: bot.agentId,
        displayName: bot.displayName,
        defaultConfig: BASE_CONFIG,
      });
      if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
    }
  });

  itDb(
    "A1 持有 3 个 Bot 时，a2-member 的计数为 0、列表为空、游标为 null",
    async () => {
      const a2Scope = await scopeAs("a2-member", companyA, teamA2);
      expect(await fixture.service.countBots(a2Scope)).toEqual({ total: 0 });
      const page = await fixture.service.listBots(a2Scope, { limit: 200 });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    },
  );

  itDb("另一家公司成员的计数同样为 0（跨公司不泄露计数）", async () => {
    const b1Scope = await scopeAs("b1-member", companyB, teamB1);
    expect(await fixture.service.countBots(b1Scope)).toEqual({ total: 0 });
  });

  itDb("成员侧分页：keyset 游标只从可见项派生，翻页完整且收敛", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    // 全量可见集 = 分页的收敛目标。前序用例在同一团队留下了其他活跃 Bot：
    // 列表即作用域，它们必须出现在页流并集里；本 describe 的 3 个 Bot 也
    // 不可缺席。
    const full = await fixture.service.listBots(scope, { limit: 200 });
    expect(full.nextCursor).toBeNull();
    const allIds = full.items.map((item) => item.agentId);
    for (const bot of [first, second, third]) {
      expect(allIds).toContain(bot.agentId);
    }
    // keyset 翻页：limit=2 走完整条流，页并集 == 全量集（无重复无遗漏），
    // 流末尾 nextCursor 为 null。
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await fixture.service.listBots(scope, {
        limit: 2,
        cursor: cursor ?? undefined,
      });
      seen.push(...page.items.map((item) => item.agentId));
      expect(seen.length).toBeLessThanOrEqual(allIds.length);
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set(allIds));
    expect(seen.length).toBe(allIds.length);
  });

  itDb("游标/limit 输入校验响亮拒绝（输入错误不是存在性信号）", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    expect(
      await thrownMessage(() => fixture.service.listBots(scope, { limit: 0 })),
    ).toContain("BOTS_LIMIT_INVALID");
    expect(
      await thrownMessage(() =>
        fixture.service.listBots(scope, { cursor: "not-a-cursor" }),
      ),
    ).toContain("BOTS_CURSOR_INVALID");
  });
});

// ---------------------------------------------------------------------------
// 验收 4（issue）：同一用户在两个公司分别创建的 Bot 互不干扰（含同名）
// ---------------------------------------------------------------------------

describeDb("MT016 验收 4：双公司同名 Bot 互不干扰", () => {
  const sameName = "同名研究助手";
  let botA = { agentId: "", displayName: "" };
  let botB = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    botA = nextBot("dual-a");
    botB = nextBot("dual-b");
    dualA = botA;
    dualB = botB;
    for (const [scope, bot] of [
      [scopeA, botA],
      [scopeB, botB],
    ] as const) {
      const outcome = await fixture.service.createBot(scope, {
        agentId: bot.agentId,
        displayName: sameName,
        defaultConfig: { model: "gpt-4o", company: scope.tenantId },
      });
      if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
    }
  });

  itDb("同名 Bot 各自存在、各自归属，列表按公司/团队分开", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const listA = await fixture.service.listBots(scopeA, { limit: 200 });
    const listB = await fixture.service.listBots(scopeB, { limit: 200 });
    expect(listA.items.some((item) => item.agentId === botA.agentId)).toBe(
      true,
    );
    expect(listA.items.some((item) => item.agentId === botB.agentId)).toBe(
      false,
    );
    expect(listB.items.some((item) => item.agentId === botB.agentId)).toBe(
      true,
    );
    expect(listB.items.some((item) => item.agentId === botA.agentId)).toBe(
      false,
    );
  });

  itDb("更新 A 的默认配置不影响 B 的同名 Bot（配置逐字节比较）", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const beforeB = await fixture.service.getBot(scopeB, botB.agentId);
    if (beforeB.outcome !== "allow") throw new Error("unreachable");
    const updatedA = await fixture.service.updateBot(scopeA, botA.agentId, {
      displayName: sameName,
      defaultConfig: { model: "claude-sonnet", company: companyA },
    });
    expect(updatedA.outcome).toBe("allow");
    if (updatedA.outcome !== "allow") throw new Error("unreachable");
    expect(updatedA.bot.revision).toBe(2);
    const afterB = await fixture.service.getBot(scopeB, botB.agentId);
    if (afterB.outcome !== "allow") throw new Error("unreachable");
    expect(afterB.bot.defaultConfig).toEqual(beforeB.bot.defaultConfig);
    expect(afterB.bot.revision).toBe(1);
  });

  itDb(
    "跨公司读对方的 Bot 仍不可见：B 上下文读 A 的 id = canonical not-found",
    async () => {
      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const verdict = await fixture.service.getBot(scopeB, botA.agentId);
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb("偏好互不串扰：A/B 各自的偏好行独立存在与读取", async () => {
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    const prefA = await fixture.service.setBotPreference(scopeA, botA.agentId, {
      pinned: true,
      note: "company A",
    });
    expect(prefA.outcome).toBe("allow");
    const prefB = await fixture.service.setBotPreference(scopeB, botB.agentId, {
      pinned: false,
      note: "company B",
    });
    expect(prefB.outcome).toBe("allow");
    const readA = await fixture.service.getBotPreference(scopeA, botA.agentId);
    if (readA.outcome !== "allow") throw new Error("unreachable");
    expect(readA.preference).toEqual({ pinned: true, note: "company A" });
    const readB = await fixture.service.getBotPreference(scopeB, botB.agentId);
    if (readB.outcome !== "allow") throw new Error("unreachable");
    expect(readB.preference).toEqual({ pinned: false, note: "company B" });
    // A 上下文读 B 的 Bot 偏好 = canonical not-found。
    const cross = await fixture.service.getBotPreference(scopeA, botB.agentId);
    expect(isCanonicalNotFound(cross)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 5（issue）：删除或账号清理使用公司作用域
// ---------------------------------------------------------------------------

describeDb("MT016 验收 5：删除/账号清理按公司作用域", () => {
  let keepA = { agentId: "", displayName: "" };
  let dropA = { agentId: "", displayName: "" };
  let keepB = { agentId: "", displayName: "" };
  let strangers = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scopeMultiA = await scopeAs("multi-company", companyA, teamA1);
    const scopeMultiB = await scopeAs("multi-company", companyB, teamB1);
    const scopeOwner = await scopeAs("a1-member", companyA, teamA1);
    keepA = nextBot("cleanup-keep-a");
    dropA = nextBot("cleanup-drop-a");
    keepB = nextBot("cleanup-keep-b");
    strangers = nextBot("cleanup-stranger");
    for (const [scope, bot] of [
      [scopeMultiA, keepA],
      [scopeMultiA, dropA],
      [scopeMultiB, keepB],
      [scopeOwner, strangers],
    ] as const) {
      const outcome = await fixture.service.createBot(scope, {
        agentId: bot.agentId,
        displayName: bot.displayName,
        defaultConfig: BASE_CONFIG,
      });
      if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
    }
    // 给 dropA 留一条偏好行，硬删后应级联消失。
    const preference = await fixture.service.setBotPreference(
      scopeMultiA,
      dropA.agentId,
      { pinned: true },
    );
    if (preference.outcome !== "allow") throw new Error("fixture pref missing");
  });

  itDb(
    "枚举按公司作用域：A 公司只返回 A 的全部归属，B 公司只返回 B 的",
    async () => {
      const multi = principalOf("multi-company");
      // 验收 4 的双公司同名 Bot（dualA/dualB）也是 multi 的真实归属——
      // 枚举的是事实全集，跨 describe 累积同样在作用域内。
      const inA = await fixture.service.enumeratePrincipalBots(companyA, multi);
      expect(inA.map((item) => item.agentId).sort()).toEqual(
        [keepA.agentId, dropA.agentId, dualA.agentId].sort(),
      );
      const inB = await fixture.service.enumeratePrincipalBots(companyB, multi);
      expect(inB.map((item) => item.agentId).sort()).toEqual(
        [keepB.agentId, dualB.agentId].sort(),
      );
    },
  );

  itDb(
    "硬删除按 (公司, owner, id) 三重钉死：清理 A 时不碰同一用户在 B 的 Bot，也不碰同公司其他人的 Bot",
    async () => {
      const multi = principalOf("multi-company");
      // 输入故意混入 B 公司的 id 与同公司其他成员的 id：只有 (companyA, multi,
      // dropA) 精确命中。
      const deleted = await fixture.service.hardDeleteOwnedBots(
        companyA,
        multi,
        [dropA.agentId, keepB.agentId, strangers.agentId],
      );
      expect(deleted).toEqual([dropA.agentId]);

      const scopeB = await scopeAs("multi-company", companyB, teamB1);
      const bStillThere = await fixture.service.getBot(scopeB, keepB.agentId);
      expect(bStillThere.outcome).toBe("allow");

      const ownerScope = await scopeAs("a1-member", companyA, teamA1);
      const strangerStillThere = await fixture.service.getBot(
        ownerScope,
        strangers.agentId,
      );
      expect(strangerStillThere.outcome).toBe("allow");

      const gone = await fixture.service.getBot(
        await scopeAs("multi-company", companyA, teamA1),
        dropA.agentId,
      );
      expect(isCanonicalNotFound(gone)).toBe(true);
    },
  );

  itDb("级联：被硬删 Bot 的偏好行同时消失（不留可访问悬挂引用）", async () => {
    const counts = await fixture.rawCounts();
    expect(counts.preferences).toBeGreaterThanOrEqual(0);
    const multi = principalOf("multi-company");
    const rows = await fixture.readPreferenceRowsAsData(companyA, multi);
    expect(rows.some((row) => row.agentId === dropA.agentId)).toBe(false);
  });

  itDb("幂等重放：再次清理同一批 id 删除 0 行", async () => {
    const multi = principalOf("multi-company");
    const replay = await fixture.service.hardDeleteOwnedBots(companyA, multi, [
      dropA.agentId,
    ]);
    expect(replay).toEqual([]);
  });

  itDb("仅凭用户 id（错公司上下文）删不掉他在其他公司的 Bot", async () => {
    const multi = principalOf("multi-company");
    const wrongTenant = await fixture.service.hardDeleteOwnedBots(
      companyB === companyA ? companyA : "mt016-company-that-does-not-exist",
      multi,
      [keepB.agentId, keepA.agentId],
    );
    expect(wrongTenant).toEqual([]);
    const scopeB = await scopeAs("multi-company", companyB, teamB1);
    expect((await fixture.service.getBot(scopeB, keepB.agentId)).outcome).toBe(
      "allow",
    );
    const scopeA = await scopeAs("multi-company", companyA, teamA1);
    expect((await fixture.service.getBot(scopeA, keepA.agentId)).outcome).toBe(
      "allow",
    );
  });
});

// ---------------------------------------------------------------------------
// brief 验收 3：编辑仅限归属范围内的授权成员；越权编辑被拒
// ---------------------------------------------------------------------------

describeDb("MT016 brief 验收 3：编辑授权（owner-only，无隐式管理继承）", () => {
  let editable = { agentId: "", displayName: "" };
  /** 暂停前签发的 scope：跨用例复用，验证撤权/恢复后的实时事实重验。 */
  let doomedScope: PlatformScope | null = null;

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-member", companyA, teamA1);
    editable = nextBot("editable");
    const outcome = await fixture.service.createBot(scope, {
      agentId: editable.agentId,
      displayName: editable.displayName,
      defaultConfig: BASE_CONFIG,
    });
    if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
  });

  itDb(
    "同团队非 owner 成员能读（团队可见性门通过）但不能改/删：BOT_EDIT_FORBIDDEN",
    async () => {
      const otherScope = await scopeAs("a1-other", companyA, teamA1);
      const visible = await fixture.service.getBot(
        otherScope,
        editable.agentId,
      );
      expect(visible.outcome).toBe("allow");
      const updated = await fixture.service.updateBot(
        otherScope,
        editable.agentId,
        { displayName: "hijacked", defaultConfig: { model: "hijack" } },
      );
      expect(updated).toEqual({
        outcome: "deny",
        code: "BOT_EDIT_FORBIDDEN",
      });
      const deleted = await fixture.service.deleteBot(
        otherScope,
        editable.agentId,
      );
      expect(deleted).toEqual({ outcome: "deny", code: "BOT_EDIT_FORBIDDEN" });
    },
  );

  itDb(
    "owner 更新成功：revision 前进，配置/名称生效，aclEpoch 不动",
    async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      const updated = await fixture.service.updateBot(scope, editable.agentId, {
        displayName: "MT016 renamed bot",
        defaultConfig: { model: "claude-sonnet", notes: "renamed" },
      });
      expect(updated.outcome).toBe("allow");
      if (updated.outcome !== "allow") throw new Error("unreachable");
      expect(updated.bot.revision).toBe(2);
      expect(updated.bot.aclEpoch).toBe(1);
      expect(updated.bot.displayName).toBe("MT016 renamed bot");
      expect(updated.bot.defaultConfig).toEqual({
        model: "claude-sonnet",
        notes: "renamed",
      });
    },
  );

  itDb("更新路径同样拒绝客户端声明归属", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const message = await thrownMessage(() =>
      fixture.service.updateBot(scope, editable.agentId, {
        displayName: "x",
        defaultConfig: { workspaceId: teamA2 },
      }),
    );
    expect(message).toContain("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
  });

  itDb(
    "公司管理员没有隐式内容访问：非团队成员上下文连受信 scope 都无法铸造（WORKSPACE_FORBIDDEN）",
    async () => {
      const message = await thrownMessage(() =>
        scopeAs("company-admin", companyA, teamA1),
      );
      expect(message).toContain("WORKSPACE_FORBIDDEN");
    },
  );

  itDb(
    "成员资格撤销后（公司成员资格暂停）：已签发 scope 在事务内重验被拒——创建响亮拒绝，读取 fail-closed 到 not-found",
    async () => {
      // 真实撤权路径：a1-doomed 是真实的 team-a1 成员；先签发 scope，再经
      // provision.suspendMembership 真实暂停公司成员资格，然后验证服务在
      // 同一业务事务内的成员重验拒绝后续动作（Spec §5.2：撤权后失效）。
      const scope = await scopeAs("a1-doomed", companyA, teamA1);
      doomedScope = scope;
      await fixture.suspendCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
      const bot = nextBot("revoked");
      const message = await thrownMessage(() =>
        fixture.service.createBot(scope, {
          agentId: bot.agentId,
          displayName: bot.displayName,
          defaultConfig: BASE_CONFIG,
        }),
      );
      expect(message).toContain("WORKSPACE_MEMBERSHIP_REQUIRED");
      // 读取对被撤权者 fail-closed 到 canonical not-found（不泄露存在性）。
      const ownerScope = await scopeAs("a1-member", companyA, teamA1);
      const seeded = nextBot("revoked-visible");
      const seededOutcome = await fixture.service.createBot(ownerScope, {
        agentId: seeded.agentId,
        displayName: seeded.displayName,
        defaultConfig: BASE_CONFIG,
      });
      expect(seededOutcome.outcome).toBe("allow");
      const read = await fixture.service.getBot(doomedScope, seeded.agentId);
      expect(isCanonicalNotFound(read)).toBe(true);
      const listed = await fixture.service.listBots(doomedScope, {
        limit: 200,
      });
      expect(listed.items).toEqual([]);
    },
  );

  itDb(
    "epoch 策略：暂停→恢复（MT007 restore，epoch+1）后旧 scope 仍被拒——拒绝来自实时 epoch 事实",
    async () => {
      if (!doomedScope) throw new Error("doomed scope missing");
      // 真实 MT007 恢复路径：status 回 active 且 epoch 再 +1。暂停前签发
      // 的 scope 的 memberEpoch 已落后两拍——拒绝必须来自 epoch 不匹配
      // （实时事实），而不是 status 缓存（status-only 门在此处会误放行）。
      const restored = await fixture.reinstateCompanyMembership(
        companyA,
        principalOf("a1-doomed"),
      );
      expect(
        (restored as { membership: { status: string; epoch: number } })
          .membership.status,
      ).toBe("active");
      const bot = nextBot("reinstated");
      const message = await thrownMessage(() =>
        fixture.service.createBot(doomedScope, {
          agentId: bot.agentId,
          displayName: bot.displayName,
          defaultConfig: BASE_CONFIG,
        }),
      );
      expect(message).toContain("WORKSPACE_MEMBERSHIP_REQUIRED");
      // 恢复后的成员签发新 scope：一切恢复正常（epoch 对齐，新事实生效）。
      const freshScope = await scopeAs("a1-doomed", companyA, teamA1);
      const freshOutcome = await fixture.service.createBot(freshScope, {
        agentId: bot.agentId,
        displayName: bot.displayName,
        defaultConfig: BASE_CONFIG,
      });
      expect(freshOutcome.outcome).toBe("allow");
    },
  );
});

// ---------------------------------------------------------------------------
// brief 验收 4：Bot 偏好与默认配置与 Bot 同归属
// ---------------------------------------------------------------------------

describeDb("MT016 brief 验收 4：偏好与默认配置同归属", () => {
  let bot = { agentId: "", displayName: "" };

  beforeAll(async () => {
    if (!ENV.ok) return;
    const scope = await scopeAs("a1-member", companyA, teamA1);
    bot = nextBot("prefs");
    const outcome = await fixture.service.createBot(scope, {
      agentId: bot.agentId,
      displayName: bot.displayName,
      defaultConfig: BASE_CONFIG,
    });
    if (outcome.outcome !== "allow") throw new Error("fixture bot missing");
  });

  itDb("偏好是逐主体事实：成员写自己的偏好，读到的也只是自己的", async () => {
    const ownerScope = await scopeAs("a1-member", companyA, teamA1);
    const otherScope = await scopeAs("a1-other", companyA, teamA1);
    const ownerPref = await fixture.service.setBotPreference(
      ownerScope,
      bot.agentId,
      { pinned: true },
    );
    expect(ownerPref.outcome).toBe("allow");
    const otherPref = await fixture.service.setBotPreference(
      otherScope,
      bot.agentId,
      { pinned: false },
    );
    expect(otherPref.outcome).toBe("allow");
    const ownerRead = await fixture.service.getBotPreference(
      ownerScope,
      bot.agentId,
    );
    if (ownerRead.outcome !== "allow") throw new Error("unreachable");
    expect(ownerRead.preference).toEqual({ pinned: true });
    const otherRead = await fixture.service.getBotPreference(
      otherScope,
      bot.agentId,
    );
    if (otherRead.outcome !== "allow") throw new Error("unreachable");
    expect(otherRead.preference).toEqual({ pinned: false });
  });

  itDb(
    "未见过的 Bot 读偏好 = canonical not-found（不是 null，不泄露存在性）",
    async () => {
      const a2Scope = await scopeAs("a2-member", companyA, teamA2);
      const verdict = await fixture.service.getBotPreference(
        a2Scope,
        bot.agentId,
      );
      expect(isCanonicalNotFound(verdict)).toBe(true);
    },
  );

  itDb(
    "可见但尚未设置偏好 = allow + null（与不可见语义严格分开）",
    async () => {
      const ownerScope = await scopeAs("a1-member", companyA, teamA1);
      const fresh = nextBot("prefless");
      await fixture.service.createBot(ownerScope, {
        agentId: fresh.agentId,
        displayName: fresh.displayName,
        defaultConfig: BASE_CONFIG,
      });
      const read = await fixture.service.getBotPreference(
        ownerScope,
        fresh.agentId,
      );
      expect(read).toEqual({ outcome: "allow", preference: null });
    },
  );

  itDb("偏好文档校验：非对象/归属键/超大文档一律响亮拒绝", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    expect(
      await thrownMessage(() =>
        fixture.service.setBotPreference(scope, bot.agentId, [
          1,
        ] as unknown as Record<string, unknown>),
      ),
    ).toContain("BOT_DOCUMENT_INVALID");
    expect(
      await thrownMessage(() =>
        fixture.service.setBotPreference(scope, bot.agentId, {
          ownerPrincipalId: principalOf("a1-member"),
        }),
      ),
    ).toContain("ATTRIBUTION_NOT_CLIENT_DECLARABLE");
    expect(
      await thrownMessage(() =>
        fixture.service.setBotPreference(scope, bot.agentId, {
          blob: "x".repeat(70_000),
        }),
      ),
    ).toContain("BOT_DOCUMENT_TOO_LARGE");
  });

  itDb("清除偏好幂等：allow + 行消失；重复清除仍 allow", async () => {
    const scope = await scopeAs("a1-member", companyA, teamA1);
    const cleared = await fixture.service.clearBotPreference(
      scope,
      bot.agentId,
    );
    expect(cleared.outcome).toBe("allow");
    const read = await fixture.service.getBotPreference(scope, bot.agentId);
    expect(read).toEqual({ outcome: "allow", preference: null });
    const again = await fixture.service.clearBotPreference(scope, bot.agentId);
    expect(again.outcome).toBe("allow");
  });

  itDb("RLS 结构钉死：偏好行只在本公司 + 本主体上下文可见", async () => {
    const multi = principalOf("multi-company");
    const other = principalOf("a1-other");
    // multi 在 A 公司（自己是 a1 成员）只看到自己的偏好行，看不到 a1-other 的。
    const asMulti = await fixture.readPreferenceRowsAsData(companyA, multi);
    expect(asMulti.some((row) => row.principalId === other)).toBe(false);
    // a2-member 的上下文里看不到 a1 团队 Bot 的任何偏好行存在性之外的行——
    // RLS 限制在租户 + 主体，行对其他主体不可见。
    const asA2 = await fixture.readPreferenceRowsAsData(
      companyA,
      principalOf("a2-member"),
    );
    expect(asA2.some((row) => row.agentId === bot.agentId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 存储与迁移契约（RLS / 受限角色 / 工具确定性）
// ---------------------------------------------------------------------------

describeDb("MT016 存储与迁移契约", () => {
  itDb(
    "未验证通道在服务装配时拒绝（UNVERIFIED_DATABASE_CAPABILITY）",
    async () => {
      const rawSetup = createDatabase(
        "postgres://postgres@127.0.0.1:55491/openbot_enterprise_mt016",
        { max: 1 },
      );
      try {
        const message = thrownMessageSync(() =>
          createBotOwnershipService({
            data: rawSetup as never,
            operator: rawSetup as never,
          }),
        );
        expect(message).toContain("UNVERIFIED_DATABASE_CAPABILITY");
      } finally {
        await rawSetup.$client.close();
      }
    },
  );

  itDb("RLS fail-closed：无租户上下文时 data 角色读归属行为 0 行", async () => {
    // 直接用已验证 data 通道开事务但不设置 app.tenant_id——FORCE RLS 应把
    // 全部行藏起来（0 行），即使表里已有本前缀的归属行。
    const rows = await fixture.readOwnershipRowsAsData("");
    expect(rows).toEqual([]);
  });

  itDb("本套件每一次受限查询都以 ob_ent_* 能力角色执行", async () => {
    const calls = fixture.restrictedCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
    }
  });

  itDb("MT016 迁移计划确定性：2 步、固定名、digest 稳定", async () => {
    const first = buildPlan("MT016");
    const second = buildPlan("MT016");
    expect(first.steps.map((step) => step.name)).toEqual([
      "0001_mt016_bot_ownership_tables.sql",
      "0002_mt016_bot_ownership_rls.sql",
    ]);
    expect(first).toEqual(second);
    expect(first.planDigest).toBe(second.planDigest);
    for (const step of first.steps) {
      expect(step.statements.length).toBeGreaterThan(0);
    }
  });
});
