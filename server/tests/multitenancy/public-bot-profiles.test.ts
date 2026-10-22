// server/tests/multitenancy/public-bot-profiles.test.ts
// MT052（Issue #95）：状态化公共 Bot 为不同使用者隔离浏览器与工作区。
//
// 验收事实源（Issue #95 四条，逐条对应 describe；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：两个使用者先后使用同一公共 Bot 时看不到彼此的登录态、
//     Cookie、文件与历史（per-user 目录与 profile 绑定）。
//   验收 2：无状态复用路径有明确判定与测试；不满足则强制隔离分配。
//   验收 3：回收后状态被清理，复用到其他范围前不残留数据。
//   验收 4：使用者个人凭据不因公共 Bot 执行而暴露给创建者或其他使用者
//     （输出形状零创建者/他人材料；跨范围请求 canonical not-found 且端口
//     零调用）。
//
// 结构：MT018 夹具（真实公司/团队/发布公共 Bot/凭据依赖）+ 本票服务
// （内存端口树——与 MT046/#90 的注入纪律同例，判定面全真）。
//
// 证据可复现（票面 AC）——本套件即复现命令：
//   set +x; source /tmp/mt27-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/public-bot-profiles.test.ts

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type DataDatabase,
  verifyDataDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import {
  createPublicBotProfileService,
  determineProfilePolicy,
  type PublicBotProfileAuditEvent,
  type PublicBotProfileService,
  parsePublicBotProfilePath,
  publicBotProfileDir,
  publicBotSharedStatelessDir,
  scopeOwnsPublicBotProfilePath,
} from "../../src/enterprise/tenancy/public-bot-profiles";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createPublicBotUsageFixture,
  type PublicBotUsageFixture,
} from "./support/public-bot-usage";

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
      reason: `MT052 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    for (const role of ["directory", "data", "operator"] as const) {
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
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());
const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

// ---------------------------------------------------------------------------
// 内存端口树（执行器落登录态的物理面；判定面全真）
// ---------------------------------------------------------------------------

class MemoryTree {
  private readonly files = new Map<string, string>();

  async ensure(_dir: string): Promise<void> {}

  async remove(dir: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${dir}/`)) this.files.delete(key);
    }
  }

  async list(dir: string): Promise<readonly string[]> {
    return [...this.files.keys()]
      .filter((key) => key.startsWith(`${dir}/`))
      .map((key) => key.slice(dir.length + 1))
      .sort();
  }

  /** 模拟执行器在目录里落的登录态/文件（测试的安排面，非服务面）。 */
  write(dir: string, name: string, content = name): void {
    this.files.set(`${dir}/${name}`, content);
  }

  fileCount(): number {
    return this.files.size;
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let fixture: PublicBotUsageFixture;
let data: DataDatabase;
let service: PublicBotProfileService;
let tree: MemoryTree;
let stops = 0;
let profileClears = 0;
const auditEvents: PublicBotProfileAuditEvent[] = [];
let companyA = "";
let teamA1 = "";
let teamA2 = "";
let companyB = "";

const ROOT = "/mt052-state";

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createPublicBotUsageFixture();
  companyA = fixture.ids["company-a"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  companyB = fixture.ids["company-b"];
  data = await verifyDataDatabase(
    createDatabase(enterpriseRuntimeDatabaseUrlFrom("data", process.env), {
      max: 1,
    }),
  );
  tree = new MemoryTree();
  service = createPublicBotProfileService({
    data,
    ports: {
      stop: async () => {
        stops += 1;
        return { wasRunning: true };
      },
      resetProfile: async () => {
        profileClears += 1;
        return { cleared: true };
      },
      state: {
        ensure: (dir) => tree.ensure(dir),
        remove: (dir) => tree.remove(dir),
        list: (dir) => tree.list(dir),
      },
    },
    audit: {
      record: (event) => {
        auditEvents.push(event);
      },
    },
  });
});

afterAll(async () => {
  if (data) await data.$client.close().catch(() => {});
  if (fixture) await fixture.dispose();
});

let botCounter = 0;

async function createAndPublishBot(botKey: string): Promise<string> {
  botCounter += 1;
  const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
  const agentId = `${fixture.idPrefix}-${botKey}-${botCounter}`;
  const created = await fixture.ownership.createBot(ownerScope, {
    agentId,
    displayName: `MT052 public bot ${botKey}`,
    defaultConfig: { botKey },
  });
  expect(created.outcome).toBe("allow");
  const published = await fixture.publish.publishBot(
    ownerScope,
    agentId,
    fixture.teamAudience(companyA, teamA1),
  );
  expect(published.outcome).toBe("allow");
  return agentId;
}

/** 状态化公共 Bot：声明一条活跃凭据依赖（登录态载体）。 */
async function statefulBot(): Promise<string> {
  const agentId = await createAndPublishBot("stateful");
  await fixture.addDependency({
    tenantId: companyA,
    resourceId: agentId,
    kind: "credential",
    ref: "corp-sso",
    status: "active",
  });
  return agentId;
}

/** 无状态公共 Bot：零依赖（服务端事实上的无状态判据）。 */
async function statelessBot(): Promise<string> {
  return createAndPublishBot("stateless");
}

const allocate = (
  scope: PlatformScope,
  botId: string,
  credentials: readonly { ref: string }[] = [],
) =>
  service.allocateProfile(scope, {
    botId,
    root: ROOT,
    loginStateCredentials: credentials,
  });

// ---------------------------------------------------------------------------
// 纯函数：判定与命名（验收 2 的判定半边 + #90 命名纪律）
// ---------------------------------------------------------------------------

describeDb("MT052 profile policy determination (pure, AC2)", () => {
  test("credential dependencies force per-user isolation", () => {
    expect(
      determineProfilePolicy({
        credentialDependencyCount: 1,
        requiresLoginState: false,
      }),
    ).toEqual({
      mode: "isolated-per-user",
      basis: "credential-dependency-present",
    });
  });

  test("admission login-state needs force isolation even with zero declared deps", () => {
    expect(
      determineProfilePolicy({
        credentialDependencyCount: 0,
        requiresLoginState: true,
      }),
    ).toEqual({
      mode: "isolated-per-user",
      basis: "login-state-required",
    });
  });

  test("zero deps and no login need is the only shared-recycled path", () => {
    expect(
      determineProfilePolicy({
        credentialDependencyCount: 0,
        requiresLoginState: false,
      }),
    ).toEqual({ mode: "shared-recycled", basis: "no-stateful-dependencies" });
  });
});

describeDb("MT052 per-user dir naming extends the #90 discipline", () => {
  itDb(
    "names a per-user segment under the bot state dir; parses back exactly",
    () => {
      const dir = publicBotProfileDir(
        ROOT,
        { tenantId: "acme", workspaceId: "fin" },
        "bot-1",
        "prin-1",
      );
      expect(dir).toBe(
        `${ROOT}/tenants/acme/workspaces/fin/bots/bot-1/users/prin-1`,
      );
      expect(parsePublicBotProfilePath(ROOT, dir)).toEqual({
        tenantId: "acme",
        workspaceId: "fin",
        botId: "bot-1",
        principalId: "prin-1",
      });
    },
  );

  itDb("a crafted path cannot claim another scope's tree", () => {
    const parsed = parsePublicBotProfilePath(
      ROOT,
      `${ROOT}/tenants/acme/workspaces/other/bots/bot-1/users/prin-1`,
    );
    expect(
      scopeOwnsPublicBotProfilePath(
        { tenantId: "acme", workspaceId: "fin", principalId: "prin-1" },
        parsed,
      ),
    ).toBe(false);
    expect(
      parsePublicBotProfilePath(
        ROOT,
        `${ROOT}/tenants/../escape/x/y/z/w/users/p`,
      ),
    ).toBeNull();
    expect(
      publicBotSharedStatelessDir(
        ROOT,
        { tenantId: "acme", workspaceId: "fin" },
        "bot-1",
      ),
    ).toBe(`${ROOT}/tenants/acme/workspaces/fin/bots/bot-1/shared-stateless`);
  });
});

// ---------------------------------------------------------------------------
// 验收 1：两个使用者先后使用同一公共 Bot
// ---------------------------------------------------------------------------

describeDb("MT052 AC1 two sequential users of one stateful public bot", () => {
  itDb(
    "each user gets their own dir and profile; no shared login or files",
    async () => {
      const botId = await statefulBot();
      const user1 = await fixture.scopeAs("a1-member", companyA, teamA1);
      const user2 = await fixture.scopeAs("a1-member2", companyA, teamA1);

      const first = await allocate(user1, botId, [{ ref: "corp-sso" }]);
      expect(first).toMatchObject({
        outcome: "allocated",
        mode: "isolated-per-user",
        ownerPrincipalId: user1.principalId,
      });
      if (first.outcome !== "allocated") return;
      // 用户 1 的执行器落了登录态与历史。
      tree.write(first.stateDir, "cookies.txt", "user1-session-cookie");
      tree.write(first.stateDir, "history.json", "[user1]");
      expect(
        await service.listProfileState(user1, { botId, root: ROOT }),
      ).toEqual(["cookies.txt", "history.json"]);

      const second = await allocate(user2, botId, [{ ref: "corp-sso" }]);
      expect(second).toMatchObject({
        outcome: "allocated",
        mode: "isolated-per-user",
      });
      if (second.outcome !== "allocated") return;
      expect(second.stateDir).not.toBe(first.stateDir);
      expect(second.profileKey).not.toBe(first.profileKey);
      expect(second.ownerPrincipalId).toBe(user2.principalId);
      // 用户 2 的目录是空的：看不到用户 1 的 Cookie/文件/历史。
      expect(
        await service.listProfileState(user2, { botId, root: ROOT }),
      ).toEqual([]);
      // 用户 1 的状态原样还在（隔离，不是互相清除）。
      expect(
        await service.listProfileState(user1, { botId, root: ROOT }),
      ).toEqual(["cookies.txt", "history.json"]);
    },
  );

  itDb(
    "the same user re-entering gets their own binding back (idempotent)",
    async () => {
      const botId = await statefulBot();
      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      const first = await allocate(user, botId, [{ ref: "corp-sso" }]);
      const again = await allocate(user, botId, [{ ref: "corp-sso" }]);
      if (first.outcome !== "allocated" || again.outcome !== "allocated") {
        throw new Error("expected allocations");
      }
      expect(again.stateDir).toBe(first.stateDir);
      expect(again.profileKey).toBe(first.profileKey);
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：无状态复用路径有明确判定；不满足则强制隔离
// ---------------------------------------------------------------------------

describeDb("MT052 AC2 stateless reuse is determined, not claimed", () => {
  itDb("a dependency-free bot rides the shared-recycled path", async () => {
    const botId = await statelessBot();
    const user = await fixture.scopeAs("a1-member", companyA, teamA1);
    const facts = await service.readProfileFacts(user, botId);
    expect(facts).toMatchObject({
      outcome: "allow",
      facts: { credentialDependencyCount: 0 },
    });
    const allocation = await allocate(user, botId, []);
    expect(allocation).toMatchObject({
      outcome: "allocated",
      mode: "shared-recycled",
    });
    if (allocation.outcome === "allocated") {
      expect(allocation.stateDir).toBe(
        publicBotSharedStatelessDir(ROOT, user, botId),
      );
    }
  });

  itDb(
    "a stateful bot (credential dependency) is forced into isolation",
    async () => {
      const botId = await statefulBot();
      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      const facts = await service.readProfileFacts(user, botId);
      expect(facts).toMatchObject({
        outcome: "allow",
        facts: { credentialDependencyCount: 1 },
      });
      const allocation = await allocate(user, botId, []);
      expect(allocation).toMatchObject({
        outcome: "allocated",
        mode: "isolated-per-user",
      });
    },
  );

  itDb("a client-declared stateless flag is loudly refused", async () => {
    const botId = await statelessBot();
    const user = await fixture.scopeAs("a1-member", companyA, teamA1);
    await expect(
      service.allocateProfile(user, {
        botId,
        root: ROOT,
        loginStateCredentials: [],
        // 客户端不可声明无状态——那不是客户端的事实。
        stateless: true,
      } as never),
    ).rejects.toThrow("PROFILE_POLICY_NOT_CLIENT_DECLARABLE");
  });
});

// ---------------------------------------------------------------------------
// 验收 3：回收后状态被清理，复用前不残留
// ---------------------------------------------------------------------------

describeDb("MT052 AC3 recycle cleans state before any reuse", () => {
  itDb(
    "recycling removes the holder's dir and clears the profile",
    async () => {
      const botId = await statefulBot();
      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      const allocation = await allocate(user, botId, [{ ref: "corp-sso" }]);
      if (allocation.outcome !== "allocated")
        throw new Error("expected allocation");
      tree.write(allocation.stateDir, "cookies.txt", "to-be-cleaned");
      const stopsBefore = stops;
      const clearsBefore = profileClears;
      const recycled = await service.recycleProfile(user, { botId });
      expect(recycled).toEqual({ outcome: "recycled" });
      expect(stops).toBe(stopsBefore + 1);
      expect(profileClears).toBe(clearsBefore + 1);
      // 目录已清：列举为空，物理树里该目录零残留。
      expect(
        await service.listProfileState(user, { botId, root: ROOT }),
      ).toEqual([]);
      expect(await tree.list(allocation.stateDir)).toEqual([]);
      // 下一次分配从空目录起步，generation 递增（不残留、不复用旧号）。
      const next = await allocate(user, botId, [{ ref: "corp-sso" }]);
      if (next.outcome !== "allocated") throw new Error("expected allocation");
      expect(next.generation).toBeGreaterThan(allocation.generation);
      expect(await tree.list(next.stateDir)).toEqual([]);
    },
  );

  itDb(
    "shared-recycled reuse across holders forces a recycle first",
    async () => {
      const botId = await statelessBot();
      const user1 = await fixture.scopeAs("a1-member", companyA, teamA1);
      const user2 = await fixture.scopeAs("a1-member2", companyA, teamA1);
      const first = await allocate(user1, botId, []);
      if (first.outcome !== "allocated") throw new Error("expected allocation");
      tree.write(first.stateDir, "scratch.txt", "user1-leftover");
      const second = await allocate(user2, botId, []);
      expect(second).toMatchObject({
        outcome: "allocated",
        mode: "shared-recycled",
      });
      if (second.outcome !== "allocated") return;
      // 换持有人 = 先回收：旧持有者的残留被物理清除，新持有者拿到空目录。
      expect(await tree.list(second.stateDir)).toEqual([]);
      expect(
        auditEvents.some(
          (event) =>
            event.action === "public-bot-profile.recycle" &&
            event.outcome === "recycled-before-reuse" &&
            event.principalId === user1.principalId,
        ),
      ).toBe(true);
    },
  );

  itDb("recycling something not held is an honest not-held", async () => {
    const botId = await statelessBot();
    const user = await fixture.scopeAs("a1-member2", companyA, teamA1);
    expect(await service.recycleProfile(user, { botId })).toEqual({
      outcome: "not-held",
    });
  });
});

// ---------------------------------------------------------------------------
// 验收 4：个人凭据不暴露；跨范围请求不可见
// ---------------------------------------------------------------------------

describeDb("MT052 AC4 no exposure and no cross-scope effects", () => {
  itDb(
    "cross-team and cross-company allocation is canonical not-found, ports idle",
    async () => {
      const botId = await statefulBot();
      const crossTeam = await fixture.scopeAs("a2-member", companyA, teamA2);
      const crossCompany = await fixture.scopeAs(
        "b1-member",
        companyB,
        fixture.ids["team-b1"],
      );
      const filesBefore = tree.fileCount();
      const stopsBefore = stops;
      for (const scope of [crossTeam, crossCompany]) {
        expect(
          isCanonicalNotFound(
            await allocate(scope, botId, [{ ref: "corp-sso" }]),
          ),
        ).toBe(true);
        expect(
          isCanonicalNotFound(await service.recycleProfile(scope, { botId })),
        ).toBe(true);
        expect(
          await service.listProfileState(scope, { botId, root: ROOT }),
        ).toEqual([]);
      }
      expect(tree.fileCount()).toBe(filesBefore);
      expect(stops).toBe(stopsBefore);
    },
  );

  itDb(
    "a cross-scope recycle cannot touch another user's binding",
    async () => {
      const botId = await statefulBot();
      const owner1 = await fixture.scopeAs("a1-member", companyA, teamA1);
      const intruder = await fixture.scopeAs("a2-member", companyA, teamA2);
      const allocation = await allocate(owner1, botId, [{ ref: "corp-sso" }]);
      if (allocation.outcome !== "allocated")
        throw new Error("expected allocation");
      tree.write(allocation.stateDir, "cookies.txt", "owner1-cookie");
      // The intruder is not a member of the bot's team: canonical not-found.
      expect(
        isCanonicalNotFound(await service.recycleProfile(intruder, { botId })),
      ).toBe(true);
      // The holder's state is intact.
      expect(
        await service.listProfileState(owner1, { botId, root: ROOT }),
      ).toEqual(["cookies.txt"]);
    },
  );

  itDb(
    "allocation output carries zero creator or other-user material",
    async () => {
      const botId = await statefulBot();
      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      const allocation = await allocate(user, botId, [{ ref: "corp-sso" }]);
      if (allocation.outcome !== "allocated")
        throw new Error("expected allocation");
      const serialized = JSON.stringify(allocation);
      expect(serialized).not.toContain("a1-owner");
      expect(serialized).not.toContain(
        fixture.ids["principal-a1-owner"] ?? "principal-a1-owner",
      );
      expect(serialized).toContain(user.principalId);
    },
  );

  itDb(
    "readProfileFacts refuses a non-public (private) bot loudly as not-found",
    async () => {
      // A bot that was created but never published: the binding slice requires
      // visibility='workspace' — invisible to the profile lane.
      const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const agentId = `${fixture.idPrefix}-never-published`;
      const created = await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT052 private bot",
        defaultConfig: {},
      });
      expect(created.outcome).toBe("allow");
      const user = await fixture.scopeAs("a1-member", companyA, teamA1);
      expect(
        isCanonicalNotFound(await service.readProfileFacts(user, agentId)),
      ).toBe(true);
    },
  );
});
