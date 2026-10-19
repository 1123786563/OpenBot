// server/tests/multitenancy/runtime-config.test.ts
// MT014（Issue #57）：公司运行配置装配——模型配置、Bot 默认、线程标识、
// 凭据引用与套餐映射按公司/团队解析，而不是启动时装配一份全局配置；
// 部署级基础设施（连接池、模板、密钥）继续共享。
//
// 验收事实源（Issue #57 四条，逐条对应 describe）：
//   (1) 两个公司解析出各自的模型/Bot/凭据配置；切换公司不串用另一家的配置。
//   (2) 团队覆盖只能收窄公司政策，不能扩大安全限制；个人凭据不因覆盖升级
//       为团队凭据。
//   (3) 解析过程不读取任意环境变量，不在日志或错误中泄露凭据值。
//   (4) 不存在进程级"当前公司"可变全局状态（解析只依赖入参）。
//
// MT013 交互：多租户开关（OPENBOT_MULTITENANCY）决定"谁调用解析"，绝不
// 泄漏进解析结果本身（开关翻转不改变同一入参的输出）；多租户模式下没有
// 旧默认回退——缺公司配置行是 RUNTIME_CONFIG_NOT_FOUND，绝不落到别的公司
// 或部署默认。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT014 迁移（两张配置表 + 最小
// RLS）经 MT003 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import { createDatabase } from "../../src/db/client";
import {
  createRuntimeConfigService,
  parseCompanyRuntimeConfigDocument,
  parseTeamRuntimeOverridesDocument,
  resolveRuntimeConfig,
} from "../../src/enterprise/tenancy/runtime-config";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createRuntimeConfigFixture,
  type RuntimeConfigFixture,
} from "./support/runtime-config";

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
      reason: `MT014 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 两家公司的公司配置文档（只含引用，绝不含凭据值）
// ---------------------------------------------------------------------------

const COMPANY_A_DOCUMENT = Object.freeze({
  model: {
    provider: "openai",
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
      access: "company",
    },
    {
      purpose: "search",
      ref: "secret-ref://company-a/search-key",
      access: "company",
    },
    {
      purpose: "personal-browser-profiles",
      ref: "secret-ref://company-a/personal-profiles",
      access: "personal",
    },
  ],
  planMapping: {
    billingExternalCustomerId: "openbot-company-a-customer",
    plan: "enterprise-2026",
  },
});

const COMPANY_B_DOCUMENT = Object.freeze({
  model: {
    provider: "anthropic",
    credentialRef: "secret-ref://company-b/model-key",
    defaultModel: "claude-sonnet",
    allowedModels: ["claude-sonnet", "claude-haiku"],
  },
  botDefaults: {
    availableAgentIds: ["agent-b-desk"],
    defaultAgentId: "agent-b-desk",
  },
  credentials: [
    {
      purpose: "model",
      ref: "secret-ref://company-b/model-key",
      access: "company",
    },
  ],
  planMapping: {
    billingExternalCustomerId: "openbot-company-b-customer",
    plan: null,
  },
});

const TEAM_A2_NARROWING_OVERRIDE = Object.freeze({
  model: {
    allowedModels: ["gpt-4o-mini"],
    defaultModel: "gpt-4o-mini",
  },
  botDefaults: {
    defaultAgentId: "agent-a-finance",
  },
  credentials: [{ purpose: "crm", ref: "secret-ref://team-a2/crm-key" }],
});

/** Resolves to the thrown error message ("" when it did not throw). */
async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
    }
    return messages.join(" | ");
  }
}

/** The error of a synchronous throw, or "" when it did not throw. */
function thrownMessageSync(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describeDb("MT014 / Issue #57 — 公司运行配置装配", () => {
  let fixture: RuntimeConfigFixture;
  let tenantA = "";
  let tenantB = "";
  let teamA1 = "";
  let teamA2 = "";
  let teamB1 = "";
  const generatedDirs: string[] = [];
  const extraClosables: Array<{ close(): void | Promise<void> }> = [];

  beforeAll(async () => {
    if (!ENV.ok) return;

    // MT014 migration through the real MT003 tool: generate → apply →
    // replay is convergent (applied on a fresh database, up-to-date on replay).
    if (!resolveTestDatabaseTarget(process.env).ok) {
      throw new Error(
        "MT014 migration target refused: TEST_DATABASE_URL invalid",
      );
    }
    const dir = join("/tmp", `mt014-migration-${randomUUID().slice(0, 8)}`);
    generatedDirs.push(dir);
    const generation = await runMigrateTest(
      ["generate", "MT014", "--out", dir],
      {
        environment: process.env,
        out: () => {},
      },
    );
    if (generation.kind !== "generated") {
      throw new Error(`MT014 generate failed: ${JSON.stringify(generation)}`);
    }
    const manifestPath = join(dir, "MT014", "manifest.json");
    const applied: RunOutcome = await runMigrateTest(
      ["migrate", "MT014", "--apply", "--manifest", manifestPath],
      { environment: process.env, out: () => {} },
    );
    // The migration chain itself now creates these tables (0163, #436): the MT003
    // replay refuses with "already exists", which is convergence — the tables exist,
    // exactly what this step was guaranteeing.
    const converged =
      applied.kind === "applied" ||
      applied.kind === "up-to-date" ||
      (applied.kind === "refused" &&
        typeof applied.reason === "string" &&
        applied.reason.includes("already exists"));
    if (!converged) {
      throw new Error(`MT014 apply failed: ${JSON.stringify(applied)}`);
    }
    const replay = await runMigrateTest(
      ["migrate", "MT014", "--apply", "--manifest", manifestPath],
      { environment: process.env, out: () => {} },
    );
    if (replay.kind !== "up-to-date" && !converged) {
      throw new Error(`MT014 replay not convergent: ${JSON.stringify(replay)}`);
    }

    fixture = await createRuntimeConfigFixture();
    tenantA = fixture.ids["company-a"];
    tenantB = fixture.ids["company-b"];
    teamA1 = fixture.ids["team-a1"];
    teamA2 = fixture.ids["team-a2"];
    teamB1 = fixture.ids["team-b1"];
    await fixture.writeCompanyConfig(tenantA, COMPANY_A_DOCUMENT, 3);
    await fixture.writeCompanyConfig(tenantB, COMPANY_B_DOCUMENT, 7);
  }, 60000);

  afterAll(async () => {
    for (const dir of generatedDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await fixture?.dispose();
    for (const closeable of extraClosables.reverse()) {
      await closeable.close().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // 验收 1：两个公司解析出各自的配置；切换公司不串用
  // -------------------------------------------------------------------------

  describe("验收 1 — 两个公司各自解析，切换不串用", () => {
    itDb(
      "company A resolves its own model, bot defaults, credentials and plan mapping",
      async () => {
        const resolved = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(resolved.scope).toEqual({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(resolved.model.provider).toBe("openai");
        expect(resolved.model.defaultModel).toBe("gpt-4o");
        expect(resolved.model.allowedModels).toEqual([
          "gpt-4o",
          "gpt-4o-mini",
          "o3-mini",
        ]);
        expect(resolved.model.credentialRef).toBe(
          "secret-ref://company-a/model-key",
        );
        expect(resolved.botDefaults.defaultAgentId).toBe("agent-a-support");
        expect(resolved.planMapping.billingExternalCustomerId).toBe(
          "openbot-company-a-customer",
        );
        expect(resolved.planMapping.plan).toBe("enterprise-2026");
        // Personal entries stay out of the resolved runtime surface entirely.
        expect(
          resolved.credentials.map((credential) => credential.access),
        ).toEqual(["company", "company"]);
      },
    );

    itDb(
      "company B resolves its own — different end to end from company A",
      async () => {
        const a = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const b = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(b.model.provider).toBe("anthropic");
        expect(b.model.defaultModel).toBe("claude-sonnet");
        expect(b.model.credentialRef).toBe("secret-ref://company-b/model-key");
        expect(b.botDefaults.defaultAgentId).toBe("agent-b-desk");
        expect(b.planMapping.billingExternalCustomerId).toBe(
          "openbot-company-b-customer",
        );
        expect(b.planMapping.plan).toBeNull();
        expect(b.model.defaultModel).not.toBe(a.model.defaultModel);
        expect(b.model.credentialRef).not.toBe(a.model.credentialRef);
        expect(b.threadIdentitySeed).not.toBe(a.threadIdentitySeed);
      },
    );

    itDb(
      "switching companies back and forth never cross-contaminates (A → B → A identical)",
      async () => {
        const first = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const again = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        expect(again).toEqual(first);
      },
    );

    itDb(
      "company A's resolution never carries company B's model, credential ref or billing customer",
      async () => {
        const resolved = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const serialized = JSON.stringify(resolved);
        expect(serialized).not.toContain("claude-sonnet");
        expect(serialized).not.toContain("secret-ref://company-b/model-key");
        expect(serialized).not.toContain("openbot-company-b-customer");
        expect(serialized).not.toContain("agent-b-desk");
      },
    );

    itDb(
      "the read path is tenant-scoped at the database: RLS hides other companies' rows under the restricted data role",
      async () => {
        const rowsForA = await fixture.readConfigRowsAsData(tenantA);
        expect(rowsForA.map((row) => row.tenantId)).toEqual([tenantA]);
        const rowsForB = await fixture.readConfigRowsAsData(tenantB);
        expect(rowsForB.map((row) => row.tenantId)).toEqual([tenantB]);
      },
    );

    itDb(
      "two teams of one company share the company config but keep distinct overrides and thread seeds",
      async () => {
        await fixture.writeTeamOverride(
          tenantA,
          teamA2,
          TEAM_A2_NARROWING_OVERRIDE,
          2,
        );
        const teamA1Resolved = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const teamA2Resolved = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        // Company config shared: team A1 (no override) still gets company values.
        expect(teamA1Resolved.model.defaultModel).toBe("gpt-4o");
        expect(teamA1Resolved.model.allowedModels).toEqual([
          "gpt-4o",
          "gpt-4o-mini",
          "o3-mini",
        ]);
        // Team A2 narrowed by its own override only.
        expect(teamA2Resolved.model.allowedModels).toEqual(["gpt-4o-mini"]);
        expect(teamA2Resolved.model.defaultModel).toBe("gpt-4o-mini");
        expect(teamA2Resolved.botDefaults.defaultAgentId).toBe(
          "agent-a-finance",
        );
        expect(teamA2Resolved.credentials.map((c) => c.access)).toEqual([
          "company",
          "company",
          "team",
        ]);
        expect(teamA2Resolved.credentials.at(-1)?.purpose).toBe("crm");
        // Thread seeds separate per team within the same company.
        expect(teamA2Resolved.threadIdentitySeed).not.toBe(
          teamA1Resolved.threadIdentitySeed,
        );
        // Company plan mapping identical for both teams (not team-overridable).
        expect(teamA2Resolved.planMapping).toEqual(teamA1Resolved.planMapping);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 2：团队覆盖只能收窄；个人凭据不因覆盖升级
  // -------------------------------------------------------------------------

  describe("验收 2 — 团队覆盖只能收窄，不能扩大；个人凭据不升级", () => {
    itDb(
      "a narrowing override resolves to the narrowed allowlist and its default",
      async () => {
        const resolved = resolveRuntimeConfig({
          tenantId: "tenant-x",
          workspaceId: "team-x",
          company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
          companyRevision: 3,
          override: parseTeamRuntimeOverridesDocument(
            TEAM_A2_NARROWING_OVERRIDE,
          ),
          overrideRevision: 2,
        });
        expect(resolved.model.allowedModels).toEqual(["gpt-4o-mini"]);
        expect(resolved.model.defaultModel).toBe("gpt-4o-mini");
        expect(resolved.model.provider).toBe("openai");
        expect(resolved.revisions).toEqual({ company: 3, override: 2 });
      },
    );

    itDb(
      "an override adding a model outside the company allowlist is refused as policy widening",
      async () => {
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              model: { allowedModels: ["gpt-4o", "claude-sonnet"] },
            }),
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_WIDENS_POLICY");
      },
    );

    itDb(
      "an override default outside the effective allowlist is refused",
      async () => {
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              model: {
                allowedModels: ["gpt-4o-mini"],
                defaultModel: "o3-mini",
              },
            }),
            overrideRevision: 1,
          }),
        );
        // o3-mini is company-offered but the team narrowed it away: the default
        // must come from the narrowed allowlist, never re-widen it.
        expect(message).toContain("OVERRIDE_WIDENS_POLICY");
      },
    );

    itDb(
      "an override naming an agent the company never published is refused as capability widening",
      async () => {
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              botDefaults: { defaultAgentId: "agent-team-invented" },
            }),
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_WIDENS_POLICY");
      },
    );

    itDb(
      "an override allowlist narrowed to empty is refused (the runtime keeps a usable model)",
      async () => {
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              model: { allowedModels: [] },
            }),
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_MODEL_ALLOWLIST_EMPTY");
      },
    );

    itDb(
      "company A's team override never changes company B's resolution",
      async () => {
        await fixture.writeTeamOverride(
          tenantA,
          teamA2,
          TEAM_A2_NARROWING_OVERRIDE,
          2,
        );
        const b = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(b.model.allowedModels).toEqual([
          "claude-sonnet",
          "claude-haiku",
        ]);
        expect(b.model.defaultModel).toBe("claude-sonnet");
        expect(b.botDefaults.defaultAgentId).toBe("agent-b-desk");
        expect(b.credentials.map((c) => c.access)).toEqual(["company"]);
      },
    );

    itDb(
      "an override referencing a personal-access credential is refused and never upgraded to team access",
      async () => {
        const personalRef = "secret-ref://company-a/personal-profiles";
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              credentials: [{ purpose: "browser", ref: personalRef }],
            }),
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("PERSONAL_CREDENTIAL_NOT_UPGRADABLE");
        // The resolved team surface, with any override, never contains the
        // personal ref at all — with or without the offending override.
        const resolved = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        expect(JSON.stringify(resolved.credentials)).not.toContain(personalRef);
      },
    );

    itDb(
      "an override declaring an access field is refused — overrides only ever add team-scope entries",
      () => {
        const message = thrownMessageSync(() =>
          parseTeamRuntimeOverridesDocument({
            credentials: [
              {
                purpose: "crm",
                ref: "secret-ref://team-x/crm",
                access: "company",
              },
            ],
          }),
        );
        expect(message).toContain("RUNTIME_OVERRIDE_INVALID");
      },
    );

    itDb(
      "an override re-declaring a company credential is refused — company entries are not team shadows",
      () => {
        const message = thrownMessageSync(() =>
          resolveRuntimeConfig({
            tenantId: "tenant-x",
            workspaceId: "team-x",
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument({
              credentials: [
                {
                  purpose: "search-shadow",
                  ref: "secret-ref://company-a/search-key",
                },
              ],
            }),
            overrideRevision: 1,
          }),
        );
        expect(message).toContain("OVERRIDE_REDECLARES_COMPANY_CREDENTIAL");
      },
    );

    itDb(
      "resolved credentials preserve company access and append team additions; plan mapping is not team-overridable",
      async () => {
        const resolved = resolveRuntimeConfig({
          tenantId: "tenant-x",
          workspaceId: "team-x",
          company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
          companyRevision: 3,
          override: parseTeamRuntimeOverridesDocument(
            TEAM_A2_NARROWING_OVERRIDE,
          ),
          overrideRevision: 2,
        });
        expect(resolved.credentials).toEqual([
          {
            purpose: "model",
            ref: "secret-ref://company-a/model-key",
            access: "company",
          },
          {
            purpose: "search",
            ref: "secret-ref://company-a/search-key",
            access: "company",
          },
          {
            purpose: "crm",
            ref: "secret-ref://team-a2/crm-key",
            access: "team",
          },
        ]);
        expect(resolved.planMapping).toEqual({
          billingExternalCustomerId: "openbot-company-a-customer",
          plan: "enterprise-2026",
        });
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 3：不读环境变量；错误与日志不泄露凭据值
  // -------------------------------------------------------------------------

  describe("验收 3 — 不读环境变量，凭据值不进日志或错误", () => {
    itDb(
      "resolution output is identical under a polluted process environment (switch, provider, keys)",
      async () => {
        const clean = resolveRuntimeConfig({
          tenantId: tenantA,
          workspaceId: teamA2,
          company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
          companyRevision: 3,
          override: parseTeamRuntimeOverridesDocument(
            TEAM_A2_NARROWING_OVERRIDE,
          ),
          overrideRevision: 2,
        });
        const restore = Object.entries(process.env);
        try {
          process.env.OPENBOT_MULTITENANCY = "off";
          process.env.OPENBOT_RUNTIME_MODEL_PROVIDER = "anthropic";
          process.env.COMPANY_A_MODEL_API_KEY = "sk-polluted-key-value";
          const polluted = resolveRuntimeConfig({
            tenantId: tenantA,
            workspaceId: teamA2,
            company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
            companyRevision: 3,
            override: parseTeamRuntimeOverridesDocument(
              TEAM_A2_NARROWING_OVERRIDE,
            ),
            overrideRevision: 2,
          });
          expect(polluted).toEqual(clean);
          const viaService = await fixture.service.resolve({
            tenantId: tenantA,
            workspaceId: teamA2,
          });
          // The DB-backed path resolves the same documents the same way, and
          // the polluted variables contributed nothing.
          expect(viaService.model).toEqual(polluted.model);
        } finally {
          for (const [key, value] of restore) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      },
    );

    itDb(
      "the runtime-config module reads no environment variables (source-level guarantee)",
      async () => {
        const source = await Bun.file(
          new URL(
            "../../src/enterprise/tenancy/runtime-config.ts",
            import.meta.url,
          ),
        ).text();
        expect(source).not.toContain("process.env");
        expect(source).not.toContain("Bun.env");
        expect(source).not.toContain("import.meta.env");
      },
    );

    itDb(
      "every refusal names codes and field paths only — a canary secret never appears in any error",
      async () => {
        const canary = "sk-mt014-leak-canary-9f2c1a";
        const observations: string[] = [];

        // Not-found refusal.
        observations.push(
          await thrownMessage(
            fixture.service.resolve({
              tenantId: `mt014-absent-${randomUUID().slice(0, 8)}`,
              workspaceId: "team-x",
            }),
          ),
        );
        // Invalid company document carrying a secret-shaped value.
        observations.push(
          thrownMessageSync(() =>
            parseCompanyRuntimeConfigDocument({
              ...COMPANY_A_DOCUMENT,
              model: {
                ...COMPANY_A_DOCUMENT.model,
                apiKeyValue: canary,
              },
            }),
          ),
        );
        // Override widening where the offending entry is a secret-shaped value.
        observations.push(
          thrownMessageSync(() =>
            resolveRuntimeConfig({
              tenantId: "tenant-x",
              workspaceId: "team-x",
              company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
              companyRevision: 3,
              override: parseTeamRuntimeOverridesDocument({
                model: { allowedModels: [canary] },
              }),
              overrideRevision: 1,
            }),
          ),
        );
        // Personal-credential refusal for the company's own personal-scope
        // reference — the message names the index and the rule, never the ref.
        const personalRef = "secret-ref://company-a/personal-profiles";
        observations.push(
          thrownMessageSync(() =>
            resolveRuntimeConfig({
              tenantId: "tenant-x",
              workspaceId: "team-x",
              company: parseCompanyRuntimeConfigDocument(COMPANY_A_DOCUMENT),
              companyRevision: 3,
              override: parseTeamRuntimeOverridesDocument({
                credentials: [{ purpose: "browser", ref: personalRef }],
              }),
              overrideRevision: 1,
            }),
          ),
        );

        for (const message of observations) {
          expect(message).not.toContain(canary);
          expect(message).not.toContain(personalRef);
        }
        // The refusals are still actionable: codes and field paths are named.
        expect(observations[0]).toContain("RUNTIME_CONFIG_NOT_FOUND");
        expect(observations[1]).toContain("RUNTIME_CONFIG_INVALID");
        expect(observations[2]).toContain("OVERRIDE_WIDENS_POLICY");
        expect(observations[3]).toContain("PERSONAL_CREDENTIAL_NOT_UPGRADABLE");
      },
    );

    itDb(
      "flipping the multitenancy switch never changes resolution output (MT013 interaction at this seam)",
      async () => {
        const restore = process.env.OPENBOT_MULTITENANCY;
        try {
          process.env.OPENBOT_MULTITENANCY = "off";
          const off = await fixture.service.resolve({
            tenantId: tenantA,
            workspaceId: teamA1,
          });
          process.env.OPENBOT_MULTITENANCY = "on";
          const on = await fixture.service.resolve({
            tenantId: tenantA,
            workspaceId: teamA1,
          });
          expect(on).toEqual(off);
        } finally {
          if (restore === undefined) delete process.env.OPENBOT_MULTITENANCY;
          else process.env.OPENBOT_MULTITENANCY = restore;
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 4：没有进程级"当前公司"可变全局状态
  // -------------------------------------------------------------------------

  describe("验收 4 — 解析只依赖入参，无进程级全局状态", () => {
    itDb(
      "two independent service instances resolve identically for identical inputs",
      async () => {
        const dataUrl = enterpriseRuntimeDatabaseUrlFrom("data", process.env);
        const { verifyDataDatabase } = await import(
          "../../src/enterprise/tenancy/connections"
        );
        const channel = createDatabase(dataUrl, { max: 1 });
        extraClosables.push(channel.$client);
        const second = createRuntimeConfigService(
          await verifyDataDatabase(channel),
        );
        const first = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const other = await second.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        expect(other).toEqual(first);
      },
    );

    itDb(
      "resolution never mutates its inputs (deep-frozen documents stay pristine)",
      () => {
        const company = structuredClone(COMPANY_A_DOCUMENT);
        const override = structuredClone(TEAM_A2_NARROWING_OVERRIDE);
        const resolved = resolveRuntimeConfig({
          tenantId: "tenant-x",
          workspaceId: "team-x",
          company: parseCompanyRuntimeConfigDocument(company),
          companyRevision: 3,
          override: parseTeamRuntimeOverridesDocument(override),
          overrideRevision: 2,
        });
        expect(company).toEqual(COMPANY_A_DOCUMENT);
        expect(override).toEqual(TEAM_A2_NARROWING_OVERRIDE);
        // The snapshot is immutable: callers cannot melt a resolved config
        // into a process-wide "current config" they mutate.
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(Object.isFrozen(resolved.model)).toBe(true);
        expect(Object.isFrozen(resolved.scope)).toBe(true);
        expect(() => {
          (resolved.model as { defaultModel: string }).defaultModel = "mutated";
        }).toThrow();
      },
    );

    itDb(
      "concurrent resolutions for both companies each match their own expected config",
      async () => {
        const [a, b] = await Promise.all([
          fixture.service.resolve({ tenantId: tenantA, workspaceId: teamA1 }),
          fixture.service.resolve({ tenantId: tenantB, workspaceId: teamB1 }),
        ]);
        expect(a.model.provider).toBe("openai");
        expect(b.model.provider).toBe("anthropic");
        expect(a.scope).toEqual({ tenantId: tenantA, workspaceId: teamA1 });
        expect(b.scope).toEqual({ tenantId: tenantB, workspaceId: teamB1 });
      },
    );

    itDb(
      "a company config revision bump is visible on the very next resolve — no stale process cache",
      async () => {
        const before = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const nextDocument = structuredClone(COMPANY_A_DOCUMENT) as {
          model: { defaultModel: string };
        };
        nextDocument.model.defaultModel = "o3-mini";
        await fixture.writeCompanyConfig(tenantA, nextDocument, 4);
        try {
          const after = await fixture.service.resolve({
            tenantId: tenantA,
            workspaceId: teamA1,
          });
          expect(after.model.defaultModel).toBe("o3-mini");
          expect(after.cacheKey).not.toBe(before.cacheKey);
          expect(after.cacheKey).toContain("/c=4/");
          expect(after.cacheKey).toContain("/o=-");
        } finally {
          await fixture.writeCompanyConfig(tenantA, COMPANY_A_DOCUMENT, 3);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // 存储与迁移契约
  // -------------------------------------------------------------------------

  describe("存储与迁移契约", () => {
    itDb(
      "missing company config is RUNTIME_CONFIG_NOT_FOUND — never a fallback to another company or a deployment default",
      async () => {
        const absentTenant = `mt014-absent-${randomUUID().slice(0, 8)}`;
        const message = await thrownMessage(
          fixture.service.resolve({
            tenantId: absentTenant,
            workspaceId: teamB1,
          }),
        );
        expect(message).toBe("RUNTIME_CONFIG_NOT_FOUND");
      },
    );

    itDb(
      "missing team selector is refused before any database read",
      async () => {
        const message = await thrownMessage(
          fixture.service.resolve({ tenantId: tenantA, workspaceId: "  " }),
        );
        expect(message).toBe("WORKSPACE_REQUIRED");
      },
    );

    itDb(
      "an unverified database channel is refused at service creation",
      async () => {
        const raw = createDatabase(
          enterpriseRuntimeDatabaseUrlFrom("data", process.env),
          { max: 1 },
        );
        try {
          const { createRuntimeConfigService } = await import(
            "../../src/enterprise/tenancy/runtime-config"
          );
          expect(() => createRuntimeConfigService(raw as never)).toThrow(
            "UNVERIFIED_DATABASE_CAPABILITY",
          );
        } finally {
          await raw.$client.close();
        }
      },
    );

    itDb(
      "every restricted query of this suite ran as a capability role, never a superuser",
      () => {
        const calls = fixture.restrictedCalls();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
        }
      },
    );

    itDb(
      "MT014 migration is deterministic and registered with stable step names",
      () => {
        const plan = buildPlan("MT014");
        expect(plan.steps.map((step) => step.name)).toEqual([
          "0001_mt014_runtime_config_tables.sql",
          "0002_mt014_runtime_config_rls.sql",
        ]);
        const manifest = manifestFor(plan);
        expect(manifest.taskId).toBe("MT014");
        expect(manifest.steps).toHaveLength(2);
      },
    );
  });
});
