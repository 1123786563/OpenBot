// server/tests/multitenancy/preferences.test.ts
// MT079（Issue #122）：偏好分类——全局个人偏好 vs 范围业务配置。
//
// 语言、主题等纯 UI 偏好继续是全局个人偏好（按用户保存，跨公司/团队切换
// 保持）；业务模型选择、提示词、默认资源、策略、凭据引用与套餐映射必须按
// 归属保存（权威存储 = MT014 runtime-config / MT077 governance-policy /
// Bot 配置业务对象），绝不因偏好机制跨范围泄露或覆盖。
//
// 验收事实源（票面 + brief 四条，逐条对应 describe）：
//   (1) 偏好项被明确分类为全局个人偏好或范围业务配置（清单可核对：穷举 +
//       结构同步 + 摘要钉死）。
//   (2) 全局个人偏好跨公司切换保持；范围业务配置不跨范围（数据库面：真实
//       用户偏好行 + 真实 runtime-config 解析）。
//   (3) 写入分类外的偏好项被拒绝（fail-closed，拒绝消息零回显）。
//   (4) 读取只返回请求范围内合法条目，无跨范围合并泄漏（投毒文档读回零泄露）。
//
// 环境契约：数据库面用例只认显式 TEST_DATABASE_URL（或
// ENTERPRISE_TEST_SETUP_DATABASE_URL）加受限角色 URL；缺配置时显式 skip
// （理由写在用例名里，skipped 不计为通过），绝不回退开发库。迁移链（base +
// MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026 依赖序）经 MT003
// 工具真实执行（幂等 applied|up-to-date），本文件不自己 DDL。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  test,
} from "../../../tests/support/bun-test-compat";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_USER_PREFERENCES } from "../../../shared/user-preferences";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  classifyPreferenceKey,
  GLOBAL_PERSONAL_PREFERENCES,
  PREFERENCE_CLASSIFICATION_DIGEST,
  parseGlobalPreferencePatch,
  readGlobalPreferences,
  SCOPED_BUSINESS_PREFERENCES,
} from "../../src/enterprise/tenancy/preferences";
import {
  createPreferencesFixture,
  POISONED_PREFERENCES,
  type PreferencesFixture,
} from "./support/preferences";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT079 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? it(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof it;
const describeDb = ENV.ok ? describe : describe.skip;

/** 迁移链（brief 依赖序）；套件 beforeAll 幂等 apply。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
  "MT077",
  "MT026",
] as const;

/** The thrown message of a synchronous throw, or "" when it did not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// 验收 1 — 清单可核对：穷举、结构同步、摘要钉死
// ---------------------------------------------------------------------------

describe("MT079 验收 1 — 偏好项分类清单完整、可核对、带摘要", () => {
  test("global classification keys are exactly the DEFAULT_USER_PREFERENCES keys", () => {
    const classified = GLOBAL_PERSONAL_PREFERENCES.map((item) => item.key);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(
      Object.keys(DEFAULT_USER_PREFERENCES).sort(),
    );
  });

  test("every global item carries a closed value shape (exact enum members or boolean)", () => {
    expect(GLOBAL_PERSONAL_PREFERENCES.length).toBeGreaterThan(0);
    for (const item of GLOBAL_PERSONAL_PREFERENCES) {
      expect(["enum", "boolean"]).toContain(item.kind);
      expect(new Set(item.enumValues).size).toBe(item.enumValues.length);
      if (item.kind === "boolean") {
        expect(item.enumValues).toEqual([]);
      } else {
        expect(item.enumValues.length).toBeGreaterThan(0);
      }
    }
    // 现存两个全局项的形状逐项钉死（与 shared 类型一致）。
    const byKey = new Map(
      GLOBAL_PERSONAL_PREFERENCES.map((item) => [item.key, item]),
    );
    expect(byKey.get("messageListEmphasis")?.enumValues).toEqual([
      "agent",
      "thread",
    ]);
    expect(byKey.get("selfHostBannerDismissed")?.kind).toBe("boolean");
  });

  test("the issue-named business categories are present with real authoritative storage bindings", () => {
    const categories = SCOPED_BUSINESS_PREFERENCES.map(
      (category) => category.category,
    );
    // Issue #122 点名的四类 + 凭据引用与套餐映射（票面验收 3 点名凭据引用）。
    expect(categories).toEqual([
      "model-selection",
      "prompts",
      "default-resources",
      "policy",
      "credential-references",
      "billing-plan-mapping",
    ]);
    expect(new Set(categories).size).toBe(categories.length);
    const byCategory = new Map(
      SCOPED_BUSINESS_PREFERENCES.map((category) => [
        category.category,
        category,
      ]),
    );
    for (const category of SCOPED_BUSINESS_PREFERENCES) {
      expect([
        "runtime-config",
        "governance-policy",
        "bot-configuration",
      ]).toContain(category.authoritativeStorage);
      expect(category.title.length).toBeGreaterThan(0);
      expect(category.documentPaths.length).toBeGreaterThan(0);
      expect(new Set(category.documentPaths).size).toBe(
        category.documentPaths.length,
      );
    }
    // 每类的权威存储绑定逐项钉死（与 MT014 / MT077 / Bot 业务对象对号）。
    expect(byCategory.get("model-selection")?.authoritativeStorage).toBe(
      "runtime-config",
    );
    expect(
      byCategory
        .get("model-selection")
        ?.documentPaths.some((path) =>
          path.endsWith("company.model.defaultModel"),
        ),
    ).toBe(true);
    expect(byCategory.get("prompts")?.authoritativeStorage).toBe(
      "bot-configuration",
    );
    expect(byCategory.get("default-resources")?.authoritativeStorage).toBe(
      "runtime-config",
    );
    expect(
      byCategory
        .get("default-resources")
        ?.documentPaths.some((path) =>
          path.endsWith("company.botDefaults.defaultAgentId"),
        ),
    ).toBe(true);
    expect(byCategory.get("policy")?.authoritativeStorage).toBe(
      "governance-policy",
    );
    expect(byCategory.get("credential-references")?.authoritativeStorage).toBe(
      "runtime-config",
    );
    expect(byCategory.get("billing-plan-mapping")?.authoritativeStorage).toBe(
      "runtime-config",
    );
  });

  test("classifyPreferenceKey answers for every classified item and refuses everything else", () => {
    for (const item of GLOBAL_PERSONAL_PREFERENCES) {
      expect(classifyPreferenceKey(item.key)).toBe("global-personal");
    }
    for (const category of SCOPED_BUSINESS_PREFERENCES) {
      for (const path of category.documentPaths) {
        expect(classifyPreferenceKey(path)).toBe("scoped-business");
        // 去掉存储前缀的裸文档路径同样可分类（清单的两种读形）。
        const colon = path.indexOf(":");
        expect(colon).toBeGreaterThan(0);
        expect(classifyPreferenceKey(path.slice(colon + 1))).toBe(
          "scoped-business",
        );
      }
    }
    // 分类外：未知键、空、非字符串一律 null（fail-closed，新偏好必须先入清单）。
    expect(classifyPreferenceKey("theme")).toBeNull();
    expect(classifyPreferenceKey("language")).toBeNull();
    expect(classifyPreferenceKey("defaultModel")).toBeNull();
    expect(classifyPreferenceKey("")).toBeNull();
    expect(classifyPreferenceKey(42)).toBeNull();
    expect(classifyPreferenceKey(null)).toBeNull();
    expect(classifyPreferenceKey(undefined)).toBeNull();
  });

  test("digest is deterministic, 64-hex, and matches the documented canonical derivation", () => {
    expect(PREFERENCE_CLASSIFICATION_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    // 独立按文档化的规范形式重算：两段清单、排序无关（清单本身就是顺序稳定
    // 的封闭表）、枚举与路径展开为数组。
    const canonical = JSON.stringify([
      [
        "global-personal",
        GLOBAL_PERSONAL_PREFERENCES.map((item) => [
          item.key,
          item.kind,
          [...item.enumValues],
        ]),
      ],
      [
        "scoped-business",
        SCOPED_BUSINESS_PREFERENCES.map((category) => [
          category.category,
          category.authoritativeStorage,
          [...category.documentPaths],
        ]),
      ],
    ]);
    const recomputed = createHash("sha256").update(canonical).digest("hex");
    expect(PREFERENCE_CLASSIFICATION_DIGEST).toBe(recomputed);
    // 清单漂移报警（模块头注承诺的有意摩擦）：任何一项增删改都会让钉死的
    // 精确 hex 失配——改清单必须同时改这里，清单改动永远是有意识的动作。
    expect(PREFERENCE_CLASSIFICATION_DIGEST).toBe(
      "0f5d77abed56c850cd5cb9f8cfcfbdb0431e44ee4402b90aa58cb9da0a153ed0",
    );
    // 覆盖面自证：任何一段缺席都会改变摘要（清单可核对性的数学前提）。
    const onlyGlobal = createHash("sha256")
      .update(JSON.stringify(canonicalData().slice(0, 1)))
      .digest("hex");
    const onlyScoped = createHash("sha256")
      .update(JSON.stringify(canonicalData().slice(1)))
      .digest("hex");
    expect(onlyGlobal).not.toBe(recomputed);
    expect(onlyScoped).not.toBe(recomputed);
  });

  function canonicalData(): unknown[] {
    return [
      [
        "global-personal",
        GLOBAL_PERSONAL_PREFERENCES.map((item) => [
          item.key,
          item.kind,
          [...item.enumValues],
        ]),
      ],
      [
        "scoped-business",
        SCOPED_BUSINESS_PREFERENCES.map((category) => [
          category.category,
          category.authoritativeStorage,
          [...category.documentPaths],
        ]),
      ],
    ];
  }

  test("module source never reads the process environment (pure seam)", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(
      resolve(here, "../../src/enterprise/tenancy/preferences.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/Bun\.env/);
    expect(source).not.toMatch(/import\.meta\.env/);
  });

  test("legacy route schema keys stay inside the classified global keys (source-level sync)", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(
      resolve(here, "../../src/user-preferences-routes.ts"),
      "utf8",
    );
    const schemaStart = source.indexOf("strictObject({");
    expect(schemaStart).toBeGreaterThan(0);
    const schemaEnd = source.indexOf("})", schemaStart);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    const schemaBody = source.slice(schemaStart, schemaEnd);
    const routeKeys = [...schemaBody.matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map(
      (match) => match[1],
    );
    expect(routeKeys.length).toBeGreaterThan(0);
    const classified = new Set(
      GLOBAL_PERSONAL_PREFERENCES.map((item) => item.key),
    );
    for (const key of routeKeys) {
      expect(classified.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 3 — 写入 fail-closed：分类外拒绝，零回显
// ---------------------------------------------------------------------------

describe("MT079 验收 3 — 写入分类外的偏好项被拒绝（fail-closed，零回显）", () => {
  test("empty and non-object patches are refused", () => {
    expect(thrownMessage(() => parseGlobalPreferencePatch({}))).toContain(
      "PREFERENCE_PATCH_INVALID",
    );
    for (const bad of [null, undefined, "patch", 42, [], true]) {
      expect(thrownMessage(() => parseGlobalPreferencePatch(bad))).toContain(
        "PREFERENCE_PATCH_INVALID",
      );
    }
  });

  test("unclassified keys are refused — pure UI additions and business-shaped keys alike", () => {
    // issue 例：语言、主题——在入清单之前同样是分类外（fail-closed 优先于猜测）。
    expect(
      thrownMessage(() => parseGlobalPreferencePatch({ theme: "dark" })),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
    expect(
      thrownMessage(() => parseGlobalPreferencePatch({ language: "zh-CN" })),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
    // 业务形键：模型选择 / 提示词 / 策略 / 凭据引用在偏好入口一律分类外。
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ defaultModel: "gpt-4o" }),
      ),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ systemPrompt: "you are a bot" }),
      ),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ networkPolicy: { mode: "off" } }),
      ),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({
          "runtime.model.credentialRef": "secret-ref://company-a/model-key",
        }),
      ),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
  });

  test("a mixed patch with one unclassified key is refused whole (all-or-nothing)", () => {
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({
          messageListEmphasis: "agent",
          theme: "dark",
        }),
      ),
    ).toContain("PREFERENCE_KEY_UNCLASSIFIED");
  });

  test("values outside the closed shape are refused", () => {
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ messageListEmphasis: "bogus" }),
      ),
    ).toContain("PREFERENCE_VALUE_INVALID");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ messageListEmphasis: 42 }),
      ),
    ).toContain("PREFERENCE_VALUE_INVALID");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ selfHostBannerDismissed: "yes" }),
      ),
    ).toContain("PREFERENCE_VALUE_INVALID");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ selfHostBannerDismissed: 1 }),
      ),
    ).toContain("PREFERENCE_VALUE_INVALID");
    expect(
      thrownMessage(() =>
        parseGlobalPreferencePatch({ selfHostBannerDismissed: null }),
      ),
    ).toContain("PREFERENCE_VALUE_INVALID");
  });

  test("rejection messages never echo the rejected key or value (canary)", () => {
    const canary = "sk-mt079-echo-canary-31337";
    const messages = [
      thrownMessage(() => parseGlobalPreferencePatch({ theme: "dark" })),
      thrownMessage(() =>
        parseGlobalPreferencePatch({ messageListEmphasis: canary }),
      ),
      thrownMessage(() => parseGlobalPreferencePatch({ apiKey: canary })),
      thrownMessage(() =>
        parseGlobalPreferencePatch({ selfHostBannerDismissed: canary }),
      ),
      thrownMessage(() =>
        parseGlobalPreferencePatch({ "runtime.model.credentialRef": canary }),
      ),
    ];
    for (const message of messages) {
      expect(message).not.toContain("sk-mt079");
      expect(message).not.toContain("canary");
      expect(message).not.toContain("theme");
      expect(message).not.toContain("apiKey");
      expect(message).not.toContain("credentialRef");
      // 零回显纪律覆盖键：错误里连被拒键名都不出现（调用方知道自己发了什么）。
    }
  });

  test("a valid patch passes exactly its classified keys, frozen, without mutating the input", () => {
    const input = {
      messageListEmphasis: "agent",
      selfHostBannerDismissed: true,
    };
    const snapshot = structuredClone(input);
    const parsed = parseGlobalPreferencePatch(input);
    expect(parsed).toEqual(snapshot);
    expect(Object.keys(parsed).sort()).toEqual([
      "messageListEmphasis",
      "selfHostBannerDismissed",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(input).toEqual(snapshot);
    // 单键最小补丁保持单键（每控件各存各的语义）。
    const single = parseGlobalPreferencePatch({
      selfHostBannerDismissed: false,
    });
    expect(single).toEqual({ selfHostBannerDismissed: false });
  });
});

// ---------------------------------------------------------------------------
// 验收 4（纯函数面）— 读取只返回请求范围合法条目
// ---------------------------------------------------------------------------

describe("MT079 验收 4（纯函数面） — 读取只返回分类为全局个人偏好的合法条目", () => {
  test("a poisoned stored document reads back as exactly the legal global items", () => {
    const gated = readGlobalPreferences(POISONED_PREFERENCES);
    expect(gated).toEqual({
      messageListEmphasis: "agent",
      selfHostBannerDismissed: true,
    });
    const serialized = JSON.stringify(gated);
    for (const marker of [
      "sk-mt079",
      "gpt-4o",
      "networkPolicy",
      "systemPrompt",
      "credentialRef",
      "theme",
      "language",
      "legacyJunk",
      "billingExternalCustomerId",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  });

  test("invalid-valued legal keys fall back to the default; the read always returns a complete shape", () => {
    expect(
      readGlobalPreferences({
        messageListEmphasis: 42,
        selfHostBannerDismissed: true,
      }),
    ).toEqual({ messageListEmphasis: "thread", selfHostBannerDismissed: true });
    expect(readGlobalPreferences({})).toEqual(DEFAULT_USER_PREFERENCES);
    expect(readGlobalPreferences({ selfHostBannerDismissed: false })).toEqual({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: false,
    });
  });

  test("non-object stored documents read back as pure defaults", () => {
    for (const bad of [null, undefined, "doc", 42, [], true]) {
      expect(readGlobalPreferences(bad)).toEqual(DEFAULT_USER_PREFERENCES);
    }
  });

  test("a hostile __proto__ key in the stored document is ignored safely", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "messageListEmphasis": "agent"}',
    ) as Record<string, unknown>;
    const gated = readGlobalPreferences(hostile);
    expect(gated).toEqual({
      messageListEmphasis: "agent",
      selfHostBannerDismissed: false,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("the read output is a fresh frozen object and deterministic", () => {
    const stored = { messageListEmphasis: "agent" };
    const first = readGlobalPreferences(stored);
    const second = readGlobalPreferences(stored);
    expect(first).toEqual(second);
    expect(first).not.toBe(stored);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 验收 2 — 数据库面：全局偏好跨范围保持，业务配置按归属立即变化
// ---------------------------------------------------------------------------

// 两个真实公司文档（与 MT015 同款形状，经真实解析器钉住合法性）与 A1 团队收窄覆盖。
const COMPANY_A_DOCUMENT = {
  model: {
    provider: "openai" as const,
    credentialRef: "secret-ref://company-a/model-key",
    defaultModel: "gpt-4o",
    allowedModels: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  },
  botDefaults: {
    availableAgentIds: ["agent-a-support", "agent-a-finance"],
    defaultAgentId: "agent-a-support",
  },
  credentials: [
    {
      purpose: "model",
      ref: "secret-ref://company-a/model-key",
      access: "company" as const,
    },
  ],
  planMapping: {
    billingExternalCustomerId: "openbot-company-a-customer",
    plan: "enterprise-2026",
  },
};

const COMPANY_B_DOCUMENT = {
  model: {
    provider: "anthropic" as const,
    credentialRef: "secret-ref://company-b/model-key",
    defaultModel: "claude-sonnet",
    allowedModels: ["claude-sonnet", "claude-haiku"],
  },
  botDefaults: {
    availableAgentIds: ["agent-b-support"],
    defaultAgentId: "agent-b-support",
  },
  credentials: [
    {
      purpose: "model",
      ref: "secret-ref://company-b/model-key",
      access: "company" as const,
    },
  ],
  planMapping: {
    billingExternalCustomerId: "openbot-company-b-customer",
    plan: null,
  },
};

const TEAM_A1_OVERRIDE = {
  model: { allowedModels: ["gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
};

describeDb(
  "MT079 — 数据库面：全局偏好跨公司切换保持，业务配置按归属立即变化",
  () => {
    let fixture: PreferencesFixture;
    let tenantA = "";
    let tenantB = "";
    let teamA1 = "";
    let teamA2 = "";
    let teamB1 = "";

    beforeAll(async () => {
      if (!ENV.ok) return;

      // 迁移链按 brief 依赖序经 MT003 工具真实执行（幂等：applied | up-to-date）。
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT079 migration target refused: ${resolved.reason}`);
      }
      const migrationEnv = { TEST_DATABASE_URL: resolved.target.url };
      for (const task of MIGRATION_CHAIN) {
        const dryRun: RunOutcome = await runMigrateTest(["migrate", task], {
          environment: migrationEnv,
          out: () => {},
        });
        if (dryRun.kind !== "dry-run") {
          throw new Error(`${task} dry-run failed: ${JSON.stringify(dryRun)}`);
        }
        const manifestPath = `/tmp/mt079-manifest-${task}-${randomUUID()}.json`;
        await Bun.write(
          manifestPath,
          `${JSON.stringify(manifestFor(buildPlan(task)), null, 2)}\n`,
        );
        try {
          const applied: RunOutcome = await runMigrateTest(
            ["migrate", task, "--apply", "--manifest", manifestPath],
            { environment: migrationEnv, out: () => {} },
          );
          if (!["applied", "up-to-date"].includes(applied.kind)) {
            throw new Error(`${task} apply failed: ${JSON.stringify(applied)}`);
          }
        } finally {
          await rm(manifestPath, { force: true });
        }
      }

      fixture = await createPreferencesFixture();
      tenantA = fixture.runtime.ids["company-a"];
      tenantB = fixture.runtime.ids["company-b"];
      teamA1 = fixture.runtime.ids["team-a1"];
      teamA2 = fixture.runtime.ids["team-a2"];
      teamB1 = fixture.runtime.ids["team-b1"];
      await fixture.runtime.writeCompanyConfig(tenantA, COMPANY_A_DOCUMENT, 3);
      await fixture.runtime.writeCompanyConfig(tenantB, COMPANY_B_DOCUMENT, 7);
      await fixture.store.patch(fixture.ids["user-clean"], {
        messageListEmphasis: "agent",
      });
    }, 60000);

    afterAll(async () => {
      await fixture?.dispose();
    });

    itDb(
      "the users table carries no scope column — global preferences cannot be scope-partitioned",
      async () => {
        const columns = await fixture.usersTableColumns();
        expect(columns).toContain("preferences");
        for (const scopeColumn of [
          "tenant_id",
          "workspace_id",
          "company_id",
          "organization_id",
        ]) {
          expect(columns).not.toContain(scopeColumn);
        }
      },
    );

    itDb(
      "global preferences survive the company A -> company B switch while business config differs per company",
      async () => {
        // 「公司 A 会话」：读全局偏好 + 解析公司 A 业务配置。
        const storedInA = await fixture.store.read(fixture.ids["user-clean"]);
        const globalInA = readGlobalPreferences(storedInA);
        const resolvedA1 = await fixture.runtime.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(globalInA).toEqual({
          messageListEmphasis: "agent",
          selfHostBannerDismissed: false,
        });
        expect(resolvedA1.model.provider).toBe("openai");
        expect(resolvedA1.planMapping.billingExternalCustomerId).toBe(
          "openbot-company-a-customer",
        );

        // 「切到公司 B」：业务配置立即变为 B 的；全局偏好逐字节不变。
        const storedInB = await fixture.store.read(fixture.ids["user-clean"]);
        const globalInB = readGlobalPreferences(storedInB);
        const resolvedB1 = await fixture.runtime.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(resolvedB1.model.provider).toBe("anthropic");
        expect(resolvedB1.model.defaultModel).toBe("claude-sonnet");
        expect(resolvedB1.planMapping.billingExternalCustomerId).toBe(
          "openbot-company-b-customer",
        );
        expect(JSON.stringify(globalInB)).toBe(JSON.stringify(globalInA));

        // 无合并泄漏：业务配置解析产物里没有任何全局偏好键，反之亦然。
        const resolvedA1Text = JSON.stringify(resolvedA1);
        expect(resolvedA1Text).not.toContain("messageListEmphasis");
        expect(resolvedA1Text).not.toContain("selfHostBannerDismissed");
      },
    );

    itDb(
      "a team override changes business config immediately; global preferences stay byte-identical",
      async () => {
        const prefsBefore = await fixture.store.read(fixture.ids["user-clean"]);
        const resolvedA2Before = await fixture.runtime.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        const resolvedB1Before = await fixture.runtime.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });

        await fixture.runtime.writeTeamOverride(
          tenantA,
          teamA1,
          TEAM_A1_OVERRIDE,
          1,
        );

        const resolvedA1After = await fixture.runtime.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(resolvedA1After.model.defaultModel).toBe("gpt-4o-mini");
        expect(resolvedA1After.revisions.override).toBe(1);
        // 同公司其他团队与另一家公司不受影响。
        const resolvedA2After = await fixture.runtime.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        expect(resolvedA2After.model.defaultModel).toBe(
          resolvedA2Before.model.defaultModel,
        );
        const resolvedB1After = await fixture.runtime.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(JSON.stringify(resolvedB1After)).toBe(
          JSON.stringify(resolvedB1Before),
        );
        // 全局偏好跨这次业务配置变化逐字节稳定。
        const prefsAfter = await fixture.store.read(fixture.ids["user-clean"]);
        expect(JSON.stringify(prefsAfter)).toBe(JSON.stringify(prefsBefore));
      },
    );

    itDb(
      "a poisoned stored preferences document reads back through the gate with zero business leakage",
      async () => {
        const raw = await fixture.readStoredPreferences(
          fixture.ids["user-poisoned"],
        );
        // 投毒文档确实原样在库里（前置成立，断言才有意义）。
        expect(raw).toEqual(POISONED_PREFERENCES);
        const gated = readGlobalPreferences(raw);
        expect(gated).toEqual({
          messageListEmphasis: "agent",
          selfHostBannerDismissed: true,
        });
        const serialized = JSON.stringify(gated);
        expect(serialized).not.toContain("sk-mt079");
        expect(serialized).not.toContain("gpt-4o");
        expect(serialized).not.toContain("networkPolicy");
        expect(serialized).not.toContain("credentialRef");
      },
    );

    itDb(
      "every restricted query in this suite ran under an ob_ent_* capability role",
      async () => {
        const calls = fixture.runtime.restrictedCalls();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
        }
      },
    );
  },
);
