// server/tests/multitenancy/cache-keys.test.ts
// MT015（Issue #58）：归属感知缓存/通道/前缀键 + 配置版本。
//
// 缓存、事件通道、对象存储前缀、向量命名空间等键都包含真实归属（公司/团队）
// 与配置版本（公司配置 revision + 团队覆盖 revision，来源 = MT014
// runtime-config 的解析产物），因此切换公司/团队或更新配置后不会读到旧范围
// 的数据；共享基础设施（连接池、模板、静态目录）继续全局复用，键里不带归属。
//
// 验收事实源（票面四条，逐条对应 describe）：
//   (1) 同一逻辑键在不同公司/团队下互不命中（跨范围污染测试）。
//   (2) 配置版本变化后旧缓存条目不再被使用。
//   (3) 键中不包含明文凭据或可反推秘密的信息。
//   (4) 共享基础设施仍可全局复用，不被误加归属。
//
// 设计要点（与 runtime-config / tenant-storage / thread-identity 同族）：
//   - 键只做寻址（Spec §6「路径前缀/ID 编码只用于寻址」）：归属 ID 原样入键，
//     调用方提供的逻辑键段单向摘要（SHA-256 截断 40 hex），任何意外经过逻辑
//     键段的机密都不可能出现在键里，也无法从键反推。
//   - 键必须对身份单射：不做静默 trim/归一化——会把不同身份折叠进同一个键。
//   - 推导是纯函数：只依赖入参，绝不读进程环境（与 runtime-config 同一纪律）。
//   - 向量命名空间用受限字符集摘要形（vn-<40hex>，与 tenantStorageSchemaName
//     同款），读形键供缓存/通道/对象前缀使用。
//
// 环境契约：数据库面用例只认显式 TEST_DATABASE_URL（或
// ENTERPRISE_TEST_SETUP_DATABASE_URL）加三个受限角色 URL；缺配置时显式
// skip（跳过原因写在用例名里，skipped 不计为通过），绝不回退开发库。迁移
// 链（base + MT004→MT008→MT112→MT012→MT014→MT010→MT009 依赖序）经 MT003
// 工具（migrate-test.ts）真实执行，本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import {
  buildPlan,
  manifestFor,
  type RunOutcome,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  type CompanyRuntimeConfigDocument,
  parseCompanyRuntimeConfigDocument,
  parseTeamRuntimeOverridesDocument,
  resolveRuntimeConfig,
} from "../../src/enterprise/tenancy/runtime-config";
import {
  scopedCacheKey,
  scopedEventChannel,
  scopedKeyOwnership,
  scopedObjectPrefix,
  scopedVectorNamespace,
  sharedInfrastructureKey,
} from "../../src/enterprise/tenancy/scoped-keys";
import {
  createKeyedMemoryCache,
  syntheticOwnership,
} from "./support/cache-keys";
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
      reason: `MT015 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    resolveTestDatabaseTarget(process.env);
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
// 键形语法（整键精确形状：归属原样寻址 + 摘要段，除此之外什么都没有）
// ---------------------------------------------------------------------------

const ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const VERSION = "[1-9][0-9]*";
const DOMAIN = "[a-z][a-z0-9-]{0,63}";
const DIGEST = "[0-9a-f]{40}";
const OWNERSHIP = `t=${ID}/w=${ID}/c=${VERSION}/o=(-|${VERSION})`;

const CACHE_KEY_PATTERN = new RegExp(
  `^scoped-cache/v1/${OWNERSHIP}/${DOMAIN}/${DIGEST}$`,
);
const CHANNEL_PATTERN = new RegExp(
  `^event-channel/v1/${OWNERSHIP}/${DOMAIN}/${DIGEST}$`,
);
const PREFIX_PATTERN = new RegExp(`^object-prefix/v1/${OWNERSHIP}/${DOMAIN}/$`);
const NAMESPACE_PATTERN = new RegExp(`^vn-${DIGEST}$`);

// 三个作用域：同公司两团队 + 另一家公司（uuid 形状的真实归属 ID）。
const A1 = syntheticOwnership(
  "11111111-1111-4111-8111-111111111111",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  3,
  null,
);
const A2 = syntheticOwnership(
  "11111111-1111-4111-8111-111111111111",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  3,
  null,
);
const B1 = syntheticOwnership(
  "22222222-2222-4222-8222-222222222222",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  7,
  2,
);

const DOMAIN_NAME = "model-responses";
const LOGICAL = "thread-42:summary";

/** All four scoped kinds derived for one scope (kind separation is pinned). */
function allKinds(
  ownership: ReturnType<typeof syntheticOwnership>,
  domain = DOMAIN_NAME,
  logical = LOGICAL,
) {
  return {
    cache: scopedCacheKey(ownership, domain, logical),
    channel: scopedEventChannel(ownership, domain, logical),
    prefix: scopedObjectPrefix(ownership, domain),
    namespace: scopedVectorNamespace(ownership, domain),
  };
}

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
// 验收 1 — 同一逻辑键跨公司/团队互不命中（跨范围污染）
// ---------------------------------------------------------------------------

describe("MT015 验收 1 — 同一逻辑键跨公司/团队互不命中", () => {
  it("same domain and logical key under three scopes: every kind is pairwise distinct", () => {
    const [a1, a2, b1] = [allKinds(A1), allKinds(A2), allKinds(B1)];
    for (const kind of ["cache", "channel", "prefix", "namespace"] as const) {
      const distinct = new Set([a1[kind], a2[kind], b1[kind]]);
      expect(distinct.size).toBe(3);
    }
  });

  it("a keyed cache never serves an entry across scopes: A1's entry is invisible to A2 and B1", () => {
    const cache = createKeyedMemoryCache();
    const a1 = scopedCacheKey(A1, DOMAIN_NAME, LOGICAL);
    const a2 = scopedCacheKey(A2, DOMAIN_NAME, LOGICAL);
    const b1 = scopedCacheKey(B1, DOMAIN_NAME, LOGICAL);
    cache.put(a1, "company-A-team-1 summary");
    expect(cache.get(a1)).toBe("company-A-team-1 summary");
    expect(cache.get(a2)).toBeUndefined();
    expect(cache.get(b1)).toBeUndefined();
    expect(cache.has(a2)).toBe(false);
    expect(cache.has(b1)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("object prefixes partition storage: a path under A1's prefix is outside A2's and B1's", () => {
    const [a1, a2, b1] = [
      scopedObjectPrefix(A1, "attachments"),
      scopedObjectPrefix(A2, "attachments"),
      scopedObjectPrefix(B1, "attachments"),
    ];
    const objectPath = `${a1}report.pdf`;
    expect(objectPath.startsWith(a1)).toBe(true);
    expect(objectPath.startsWith(a2)).toBe(false);
    expect(objectPath.startsWith(b1)).toBe(false);
  });

  it("event channel names for the same logical feed never collide across scopes", () => {
    const [a1, a2, b1] = [
      scopedEventChannel(A1, "run-events", "run-9"),
      scopedEventChannel(A2, "run-events", "run-9"),
      scopedEventChannel(B1, "run-events", "run-9"),
    ];
    expect(new Set([a1, a2, b1]).size).toBe(3);
  });

  it("derivation is deterministic: identical inputs give byte-identical keys", () => {
    expect(allKinds(A1)).toStrictEqual(allKinds(A1));
    expect(sharedInfrastructureKey("connection-pool")).toBe(
      sharedInfrastructureKey("connection-pool"),
    );
  });

  it("kinds never collide: same scope+domain+logical yields five distinct strings", () => {
    const kinds = allKinds(A1);
    const distinct = new Set([
      kinds.cache,
      kinds.channel,
      kinds.prefix,
      kinds.namespace,
      sharedInfrastructureKey(DOMAIN_NAME),
    ]);
    expect(distinct.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 验收 2 — 配置版本变化后旧缓存条目不再被使用
// ---------------------------------------------------------------------------

describe("MT015 验收 2 — 配置版本变化后旧缓存条目不再被使用", () => {
  it("bumping the company revision changes every kind of key", () => {
    const before = syntheticOwnership(A1.tenantId, A1.workspaceId, 3, null);
    const after = syntheticOwnership(A1.tenantId, A1.workspaceId, 4, null);
    const [kBefore, kAfter] = [allKinds(before), allKinds(after)];
    for (const kind of ["cache", "channel", "prefix", "namespace"] as const) {
      expect(kBefore[kind]).not.toBe(kAfter[kind]);
    }
  });

  it("introducing and then bumping the override revision changes every kind of key", () => {
    const none = syntheticOwnership(A1.tenantId, A1.workspaceId, 3, null);
    const first = syntheticOwnership(A1.tenantId, A1.workspaceId, 3, 2);
    const second = syntheticOwnership(A1.tenantId, A1.workspaceId, 3, 3);
    const [kNone, kFirst, kSecond] = [
      allKinds(none),
      allKinds(first),
      allKinds(second),
    ];
    for (const kind of ["cache", "channel", "prefix", "namespace"] as const) {
      expect(new Set([kNone[kind], kFirst[kind], kSecond[kind]]).size).toBe(3);
    }
  });

  it("an entry stored under the old revision's key is unreachable under the new revision's key", () => {
    const cache = createKeyedMemoryCache();
    const oldKey = scopedCacheKey(
      syntheticOwnership(A1.tenantId, A1.workspaceId, 3, null),
      DOMAIN_NAME,
      LOGICAL,
    );
    const newKey = scopedCacheKey(
      syntheticOwnership(A1.tenantId, A1.workspaceId, 4, null),
      DOMAIN_NAME,
      LOGICAL,
    );
    cache.put(oldKey, "stale under revision 3");
    expect(cache.get(newKey)).toBeUndefined();
    // The old entry still sits at its own address, but a current-version
    // lookup can never land on it — stale reads are structurally impossible.
    expect(cache.get(oldKey)).toBe("stale under revision 3");
    expect(cache.size).toBe(1);
  });

  it("the ownership adapter carries runtime-config revisions, so a re-resolved config lands on a new key", () => {
    const resolved3 = resolveRuntimeConfig({
      tenantId: "tenant-adapter",
      workspaceId: "team-adapter",
      company: ADAPTER_COMPANY_DOCUMENT,
      companyRevision: 3,
      override: null,
      overrideRevision: null,
    });
    const resolved4 = resolveRuntimeConfig({
      tenantId: "tenant-adapter",
      workspaceId: "team-adapter",
      company: ADAPTER_COMPANY_DOCUMENT,
      companyRevision: 4,
      override: null,
      overrideRevision: null,
    });
    const override = parseTeamRuntimeOverridesDocument({
      model: { allowedModels: ["gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
    });
    const resolvedOverride = resolveRuntimeConfig({
      tenantId: "tenant-adapter",
      workspaceId: "team-adapter",
      company: ADAPTER_COMPANY_DOCUMENT,
      companyRevision: 3,
      override,
      overrideRevision: 1,
    });
    const keyOf = (resolved: ReturnType<typeof resolveRuntimeConfig>) =>
      scopedCacheKey(scopedKeyOwnership(resolved), DOMAIN_NAME, LOGICAL);
    expect(keyOf(resolved3)).not.toBe(keyOf(resolved4));
    expect(keyOf(resolved3)).not.toBe(keyOf(resolvedOverride));
  });
});

// ---------------------------------------------------------------------------
// 验收 3 — 键中不包含明文凭据或可反推秘密的信息
// ---------------------------------------------------------------------------

describe("MT015 验收 3 — 键中不包含明文凭据或可反推秘密", () => {
  const CANARY = "sk-mt015-leak-canary-deadbeefc0ffee";
  const PEM_CANARY = "-----BEGIN PRIVATE KEY-----";

  it("a canary secret passed as the logical key never appears in any derived key", () => {
    const kinds = allKinds(A1, DOMAIN_NAME, `token:${CANARY}`);
    expect(kinds.cache.includes(CANARY)).toBe(false);
    expect(kinds.channel.includes(CANARY)).toBe(false);
    expect(kinds.prefix.includes(CANARY)).toBe(false);
    expect(kinds.namespace.includes(CANARY)).toBe(false);
    const pem = allKinds(A1, DOMAIN_NAME, PEM_CANARY);
    expect(pem.cache.includes(PEM_CANARY)).toBe(false);
  });

  it("the logical segments are one-way digests: opaque fixed-length hex, no reversible encoding", () => {
    const kinds = allKinds(A1);
    expect(kinds.cache.slice(-40)).toMatch(new RegExp(`^${DIGEST}$`));
    expect(kinds.channel.slice(-40)).toMatch(new RegExp(`^${DIGEST}$`));
    expect(kinds.namespace).toMatch(NAMESPACE_PATTERN);
    // The digest never carries a readable projection of the logical key,
    // not even for a pure-ASCII input.
    const digest = scopedCacheKey(A1, DOMAIN_NAME, "completely-readable");
    expect(digest.includes("completely-readable")).toBe(false);
  });

  it("keys carry exactly the ownership grammar and nothing else (full-key shape)", () => {
    const kinds = allKinds(A1);
    expect(kinds.cache).toMatch(CACHE_KEY_PATTERN);
    expect(kinds.channel).toMatch(CHANNEL_PATTERN);
    expect(kinds.prefix).toMatch(PREFIX_PATTERN);
    expect(kinds.namespace).toMatch(NAMESPACE_PATTERN);
  });

  it("rejection messages never echo the rejected value", () => {
    const messages = [
      thrownMessage(() =>
        scopedCacheKey(
          syntheticOwnership(`tenant/${CANARY}`, "team-x", 1, null),
          "domain-x",
          "logical-x",
        ),
      ),
      thrownMessage(() => scopedCacheKey(A1, `DOMAIN/${CANARY}`, "logical-x")),
      thrownMessage(() =>
        scopedCacheKey(A1, "domain-x", `${"x".repeat(4097)}-${CANARY}`),
      ),
      thrownMessage(() => sharedInfrastructureKey(`Pool_${CANARY}`)),
    ];
    for (const message of messages) {
      expect(message).not.toBe("");
      expect(message.includes(CANARY)).toBe(false);
    }
  });

  it("the module reads no process environment (source-level assertion)", async () => {
    const source = await readFile(
      new URL("../../src/enterprise/tenancy/scoped-keys.ts", import.meta.url),
      "utf8",
    );
    expect(source.includes("process.env")).toBe(false);
    expect(source.includes("Bun.env")).toBe(false);
    expect(source.includes("import.meta.env")).toBe(false);
  });

  it("derivation ignores ambient environment: polluted env changes nothing", () => {
    const clean = allKinds(A1);
    const previous = new Map<string, string | undefined>([
      ["OPENBOT_SCOPED_KEY_SALT", process.env.OPENBOT_SCOPED_KEY_SALT],
      ["OPENBOT_MULTITENANCY", process.env.OPENBOT_MULTITENANCY],
      ["MT015_CANARY_ENV", process.env.MT015_CANARY_ENV],
    ]);
    try {
      process.env.OPENBOT_SCOPED_KEY_SALT = CANARY;
      process.env.OPENBOT_MULTITENANCY = "off";
      process.env.MT015_CANARY_ENV = CANARY;
      expect(allKinds(A1)).toStrictEqual(clean);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 4 — 共享基础设施保持全局复用，不被误加归属
// ---------------------------------------------------------------------------

describe("MT015 验收 4 — 共享基础设施保持全局复用", () => {
  it("shared keys are global and deterministic with no ownership segments", () => {
    expect(sharedInfrastructureKey("connection-pool")).toBe(
      "shared/v1/connection-pool",
    );
    const key = sharedInfrastructureKey("connection-pool");
    expect(key.includes("/t=")).toBe(false);
    expect(key.includes("/w=")).toBe(false);
    expect(key.includes("/c=")).toBe(false);
    expect(key.includes("/o=")).toBe(false);
  });

  it("the deployment-level forms stay distinct per domain: pools, templates, static assets", () => {
    const [pool, template, assets] = [
      sharedInfrastructureKey("connection-pool"),
      sharedInfrastructureKey("prompt-template"),
      sharedInfrastructureKey("static-assets"),
    ];
    expect(new Set([pool, template, assets]).size).toBe(3);
  });

  it("a shared key never collides with a scoped key even for the same domain", () => {
    const shared = sharedInfrastructureKey(DOMAIN_NAME);
    const kinds = allKinds(A1);
    expect(
      new Set([
        shared,
        kinds.cache,
        kinds.channel,
        kinds.prefix,
        kinds.namespace,
      ]).size,
    ).toBe(5);
  });

  it("shared domains follow the same label rules as scoped domains", () => {
    expect(thrownMessage(() => sharedInfrastructureKey(""))).toContain(
      "SCOPED_KEY_INVALID_DOMAIN",
    );
    expect(
      thrownMessage(() => sharedInfrastructureKey("Bad_Domain")),
    ).toContain("SCOPED_KEY_INVALID_DOMAIN");
  });
});

// ---------------------------------------------------------------------------
// 输入卫生 — 拒绝形状与代码（身份单射：不 trim、不归一化）
// ---------------------------------------------------------------------------

describe("MT015 输入卫生 — 拒绝形状与代码", () => {
  it("missing or blank tenant/workspace selectors are refused like everywhere else", () => {
    const blankTenant = syntheticOwnership("   ", "team-x", 1, null);
    expect(
      thrownMessage(() => scopedCacheKey(blankTenant, "d", "l")),
    ).toContain("TENANT_REQUIRED");
    const emptyTenant = syntheticOwnership("", "team-x", 1, null);
    expect(
      thrownMessage(() => scopedCacheKey(emptyTenant, "d", "l")),
    ).toContain("TENANT_REQUIRED");
    const blankWorkspace = syntheticOwnership("tenant-x", "  ", 1, null);
    expect(
      thrownMessage(() => scopedCacheKey(blankWorkspace, "d", "l")),
    ).toContain("WORKSPACE_REQUIRED");
  });

  it("tenant ids that could break the key grammar or path safety are refused", () => {
    for (const bad of [
      "tenant/a",
      "..",
      ".",
      "tenant\nx",
      "tenant x",
      " tenant-x",
      "tenant-x ",
      "tenant=header",
      `t${"x".repeat(128)}`,
      "tenant-ünicode",
    ]) {
      const message = thrownMessage(() =>
        scopedCacheKey(syntheticOwnership(bad, "team-x", 1, null), "d", "l"),
      );
      expect(message).toContain("SCOPED_KEY_INVALID_TENANT_ID");
    }
  });

  it("workspace ids follow the same refusal rules", () => {
    for (const bad of ["team/a", "..", "team x", " team", "team=1"]) {
      const message = thrownMessage(() =>
        scopedCacheKey(syntheticOwnership("tenant-x", bad, 1, null), "d", "l"),
      );
      expect(message).toContain("SCOPED_KEY_INVALID_WORKSPACE_ID");
    }
  });

  it("config versions must be positive integers; override may be null", () => {
    for (const badCompany of [0, -1, 2.5, Number.NaN, "3"]) {
      const message = thrownMessage(() =>
        scopedCacheKey(
          syntheticOwnership("tenant-x", "team-x", badCompany as number, null),
          "d",
          "l",
        ),
      );
      expect(message).toContain("SCOPED_KEY_INVALID_CONFIG_VERSION");
    }
    for (const badOverride of [0, -1, 1.5]) {
      const message = thrownMessage(() =>
        scopedCacheKey(
          syntheticOwnership("tenant-x", "team-x", 1, badOverride),
          "d",
          "l",
        ),
      );
      expect(message).toContain("SCOPED_KEY_INVALID_CONFIG_VERSION");
    }
    // null override is the normal "no team override" shape.
    expect(
      scopedCacheKey(
        syntheticOwnership("tenant-x", "team-x", 1, null),
        "d",
        "l",
      ),
    ).toMatch(CACHE_KEY_PATTERN);
  });

  it("domains are strict lowercase labels; logical keys must be bounded non-empty strings", () => {
    for (const badDomain of [
      "",
      "UPPER",
      "under_score",
      "a/b",
      "-lead",
      "9start",
      `d${"x".repeat(64)}`,
    ]) {
      const message = thrownMessage(() => scopedCacheKey(A1, badDomain, "l"));
      expect(message).toContain("SCOPED_KEY_INVALID_DOMAIN");
    }
    expect(thrownMessage(() => scopedCacheKey(A1, "d", ""))).toContain(
      "SCOPED_KEY_INVALID_LOGICAL_KEY",
    );
    expect(
      thrownMessage(() => scopedCacheKey(A1, "d", "x".repeat(4097))),
    ).toContain("SCOPED_KEY_INVALID_LOGICAL_KEY");
  });

  it("the ownership adapter validates like the direct builders", () => {
    expect(
      thrownMessage(() =>
        scopedKeyOwnership({
          scope: { tenantId: "", workspaceId: "team-x" },
          revisions: { company: 1, override: null },
        }),
      ),
    ).toContain("TENANT_REQUIRED");
    expect(
      thrownMessage(() =>
        scopedKeyOwnership({
          scope: { tenantId: "tenant-x", workspaceId: "team-x" },
          revisions: { company: 0, override: null },
        }),
      ),
    ).toContain("SCOPED_KEY_INVALID_CONFIG_VERSION");
  });
});

// ---------------------------------------------------------------------------
// 数据库面：真实解析产物（受限角色 + RLS）→ 键随真实版本移动
// ---------------------------------------------------------------------------

/** 迁移链（brief 指定依赖序）：base 由 enterprise-test-db.ts migrate 建好。 */
const MIGRATION_CHAIN = [
  "MT004",
  "MT008",
  "MT112",
  "MT012",
  "MT014",
  "MT010",
  "MT009",
] as const;

describeDb("MT015 — 数据库面：键随真实解析产物与真实版本移动", () => {
  let fixture: RuntimeConfigFixture;
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
      throw new Error(`MT015 migration target refused: ${resolved.reason}`);
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
      const manifestPath = `/tmp/mt015-manifest-${task}-${randomUUID()}.json`;
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
    await fixture?.dispose();
  });

  // 验收 1（数据库面）：真实解析产物的跨范围隔离
  describe("验收 1（数据库面） — 真实解析产物跨范围互不命中", () => {
    itDb(
      "the real resolved runtime configs of two companies and two teams derive mutually-missing cache entries",
      async () => {
        const resolvedA1 = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const resolvedA2 = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        const resolvedB1 = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const keyOf = (
          resolved: Awaited<
            ReturnType<RuntimeConfigFixture["service"]["resolve"]>
          >,
        ) => scopedCacheKey(scopedKeyOwnership(resolved), DOMAIN_NAME, LOGICAL);
        const keyA1 = keyOf(resolvedA1);
        const keyA2 = keyOf(resolvedA2);
        const keyB1 = keyOf(resolvedB1);
        expect(new Set([keyA1, keyA2, keyB1]).size).toBe(3);
        const cache = createKeyedMemoryCache();
        cache.put(keyA1, "A1 payload");
        expect(cache.get(keyA2)).toBeUndefined();
        expect(cache.get(keyB1)).toBeUndefined();
        expect(cache.get(keyA1)).toBe("A1 payload");
      },
    );
  });

  // 验收 2（数据库面）：真实版本变化移动真实键
  describe("验收 2（数据库面） — 真实配置版本变化后旧条目不可达", () => {
    itDb(
      "a real company config revision bump moves the derived key; the other company's key is byte-stable",
      async () => {
        const before = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const b1Before = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const keyOf = (
          resolved: Awaited<
            ReturnType<RuntimeConfigFixture["service"]["resolve"]>
          >,
        ) => scopedCacheKey(scopedKeyOwnership(resolved), DOMAIN_NAME, LOGICAL);
        const keyBefore = keyOf(before);
        const b1KeyBefore = keyOf(b1Before);
        await fixture.writeCompanyConfig(tenantA, COMPANY_A_DOCUMENT, 4);
        const after = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const b1After = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const keyAfter = keyOf(after);
        expect(keyAfter).not.toBe(keyBefore);
        expect(keyOf(b1After)).toBe(b1KeyBefore);
        // End-to-end: the entry cached before the bump is unreachable after.
        const cache = createKeyedMemoryCache();
        cache.put(keyBefore, "stale company config view");
        expect(cache.get(keyAfter)).toBeUndefined();
      },
    );

    itDb(
      "a real team override write moves only that team's derived key",
      async () => {
        const a1Before = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const a2Before = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        const b1Before = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        await fixture.writeTeamOverride(tenantA, teamA1, TEAM_A1_OVERRIDE, 1);
        const a1After = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA1,
        });
        const a2After = await fixture.service.resolve({
          tenantId: tenantA,
          workspaceId: teamA2,
        });
        const b1After = await fixture.service.resolve({
          tenantId: tenantB,
          workspaceId: teamB1,
        });
        const keyOf = (
          resolved: Awaited<
            ReturnType<RuntimeConfigFixture["service"]["resolve"]>
          >,
        ) =>
          scopedEventChannel(
            scopedKeyOwnership(resolved),
            "run-events",
            "run-9",
          );
        expect(keyOf(a1After)).not.toBe(keyOf(a1Before));
        expect(keyOf(a2After)).toBe(keyOf(a2Before));
        expect(keyOf(b1After)).toBe(keyOf(b1Before));
      },
    );
  });

  itDb(
    "every restricted call in this suite ran as a capability role, never a superuser",
    () => {
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser.startsWith("ob_ent_")).toBe(true);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 测试夹具文档（与 runtime-config 套件同族：只含引用，绝不含凭据值）
// ---------------------------------------------------------------------------

const COMPANY_A_DOCUMENT: CompanyRuntimeConfigDocument =
  parseCompanyRuntimeConfigDocument({
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
    ],
    planMapping: {
      billingExternalCustomerId: "openbot-company-a-customer",
      plan: "enterprise-2026",
    },
  });

const COMPANY_B_DOCUMENT: CompanyRuntimeConfigDocument =
  parseCompanyRuntimeConfigDocument({
    model: {
      provider: "anthropic",
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
        access: "company",
      },
    ],
    planMapping: {
      billingExternalCustomerId: "openbot-company-b-customer",
      plan: null,
    },
  });

const TEAM_A1_OVERRIDE = parseTeamRuntimeOverridesDocument({
  model: { allowedModels: ["gpt-4o-mini"], defaultModel: "gpt-4o-mini" },
});

/** 纯函数适配器测试用的最小公司文档。 */
const ADAPTER_COMPANY_DOCUMENT: CompanyRuntimeConfigDocument =
  parseCompanyRuntimeConfigDocument({
    model: {
      provider: "openai",
      credentialRef: "secret-ref://adapter/model",
      defaultModel: "gpt-4o",
      allowedModels: ["gpt-4o", "gpt-4o-mini"],
    },
    botDefaults: {
      availableAgentIds: ["bot-adapter"],
      defaultAgentId: "bot-adapter",
    },
    credentials: [
      {
        purpose: "model",
        ref: "secret-ref://adapter/model",
        access: "company",
      },
    ],
    planMapping: {
      billingExternalCustomerId: "openbot-adapter-customer",
      plan: null,
    },
  });
