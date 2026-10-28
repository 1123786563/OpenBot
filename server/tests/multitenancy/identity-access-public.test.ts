// server/tests/multitenancy/identity-access-public.test.ts
// MOD04（Issue #624，根 #620）：M01/M02 公开门面的委托等价与形状钉。
//
// 事实源（Issue #624 验收 + MOD04 Brief §D，逐条对应 describe）：
//   D1 委托等价：门面方法 vs 直调内件结果逐项相等（M01 事实、M02
//      resolve/authorize/runInScope 各正例+反例）。
//   D2 验收 1 形状钉：门面返回不含授权语义字段；选择器不赋权（结构断言）。
//   D3 验收 2 反例：同团队私有对象、伪造 scope 拒绝——全部**无 DB 路径**
//      （真实内件在触库之前拒绝/纯函数判定）；DB 交错类（撤权后新动作、
//      scope 切换迟到）复用存量套件（scope-gate / revocation /
//      resource-policy / openmuse-private-bot 复跑绿，本文件不造新库）。
//   D4 验收 3：runInScope = 原 createWorkspaceGate(...).transaction 路径
//      （委托等价 + 存量 scope-gate 套件引用）。
//   D5 验收 4：门面零写入面（结构 + grep 级断言：无 insert/update/delete
//      写调用、无写方法导出）。
//   D6 openmuse-tasks 存量套件复跑绿（服务已改经门面 runInScope 装配，
//      见 support/openmuse-tasks.ts；复跑证据在 reports/MOD04-report.md）。
//
// 运行层（ADR 0008）：import 自 e2e-compat——本文件由根 e2e 入口在 Node
// target 原生收集执行（覆盖审计 native 桶），不依赖 Bun 运行时，也**不触
// 数据库**：真实内件的部分用「触库即响亮失败」的毒化连接证明拒绝发生在
// 触库之前；需要协作内件的正例用结构等价的注入替身（门面只做委托，替身
// 证明的正是委托本身）。真实 DB 行为归存量套件（见 D3/D6 引用）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  type ActorMembershipFacts,
  type CompanyMembershipFact,
  type CurrentIdentityFact,
  createIdentityDirectory,
} from "../../src/auth/public";
import type { Database } from "../../src/db/client";
import { type Access, createAccess } from "../../src/enterprise/authz/public";
import { createAuthz } from "../../src/enterprise/authz/service";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  verifyDataDatabase,
  verifyDirectoryDatabase,
} from "../../src/enterprise/tenancy/connections";
import {
  createResourcePolicyService,
  createShippedResourcePolicyRegistry,
  type ResourcePolicyFacts,
  TENANCY_V1_POLICY_ID,
  WORKSPACE_V1_POLICY_ID,
} from "../../src/enterprise/tenancy/resource-policy";
import { createWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import { createScopeResolver } from "../../src/enterprise/tenancy/store";
import type { Person } from "../../src/people/store";

// ---------------------------------------------------------------------------
// 工具：错误码提取（scope-gate.test.ts 同款语义，Node 断言面）
// ---------------------------------------------------------------------------

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全真目录能力行：让 verify* 通过校验并把该连接对象计入受信 WeakSet。 */
function capabilityRowAllTrue() {
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

/**
 * 毒化连接：只应答能力校验查询（execute），任何事务/写入尝试都
 * DATABASE_TOUCHED 响亮失败——用来证明拒绝发生在触库之前。
 */
function poisonedDatabase(): Database & { touches: () => number } {
  let touches = 0;
  const db = {
    execute: async () => capabilityRowAllTrue(),
    transaction: async () => {
      touches += 1;
      throw new Error("DATABASE_TOUCHED");
    },
    touches: () => touches,
  };
  return db as unknown as Database & { touches: () => number };
}

// ---------------------------------------------------------------------------
// 夹具 A：真实内件（resolver/gate/policy 全部真实构造，连接毒化）
// ---------------------------------------------------------------------------

async function realInternalsFixture(): Promise<{
  access: Access;
  directoryTouches: () => number;
  dataTouches: () => number;
}> {
  const directoryRaw = poisonedDatabase();
  const dataRaw = poisonedDatabase();
  const directory = await verifyDirectoryDatabase(directoryRaw);
  const data = await verifyDataDatabase(dataRaw);
  const resolver = createScopeResolver(directory, {
    authenticate: async (request) => {
      const actorId = request.headers.get("x-test-actor");
      return actorId ? { actorId, entrypoint: "web" } : null;
    },
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  const access = createAccess({
    resolver,
    gate: createWorkspaceGate(data),
    resourcePolicy: createResourcePolicyService(data),
  });
  return {
    access,
    directoryTouches: () => directoryRaw.touches(),
    dataTouches: () => dataRaw.touches(),
  };
}

// ---------------------------------------------------------------------------
// 夹具 B：注入替身（证明委托本身——同对象进出、同错误透传）
// ---------------------------------------------------------------------------

const STUB_SCOPE: PlatformScope = Object.freeze({
  tenantId: "tenant-x",
  workspaceId: "workspace-x",
  principalId: "principal-x",
  actorId: "actor-x",
  memberEpoch: 3,
  aclEpoch: 1,
  entrypoint: "web",
});

function stubInternalsFixture(): Promise<{
  access: Access;
  counts: { read: () => number; gate: () => number; policy: () => number };
}> {
  let gateCalls = 0;
  let policyCalls = 0;
  let resolverCalls = 0;
  const access = createAccess({
    resolver: {
      async resolve(request: Request) {
        resolverCalls += 1;
        if (request.headers.get("x-test-refuse") === "tenant") {
          throw new Error("TENANT_FORBIDDEN");
        }
        return STUB_SCOPE;
      },
      async resolveForThread() {
        throw new Error("NOT_USED_BY_FACADE");
      },
    },
    gate: {
      async transaction(scope, operation) {
        gateCalls += 1;
        expect(scope).toBe(STUB_SCOPE);
        // 门面把内件的事务句柄原样递给 operation——替身句柄只验证透传。
        return operation("stub-tx" as never);
      },
    },
    resourcePolicy: {
      async decide(scope) {
        policyCalls += 1;
        expect(scope).toBe(STUB_SCOPE);
        return { outcome: "deny", code: "RESOURCE_NOT_FOUND" };
      },
    },
  });
  return Promise.resolve({
    access,
    counts: {
      read: () => resolverCalls,
      gate: () => gateCalls,
      policy: () => policyCalls,
    },
  });
}

// ---------------------------------------------------------------------------
// M01 替身数据（与 Person/IdentityLink/成员事实结构等价的只读事实）
// ---------------------------------------------------------------------------

const PERSON_A: Person = {
  id: "user-a",
  email: "a@example.invalid",
  name: "Person A",
  image: null,
  role: "user",
  providers: ["slack"],
  lastSignedInAt: null,
  revoked: false,
  configuredAdmin: false,
};

const MEMBERSHIPS_A: readonly CompanyMembershipFact[] = [
  {
    tenantId: "tenant-a",
    principalId: "principal-a",
    memberStatus: "active",
    teams: [
      { workspaceId: "workspace-a1", status: "active" },
      { workspaceId: "workspace-a2", status: "suspended" },
    ],
  },
];

function m01Directory() {
  return createIdentityDirectory({
    people: {
      async find(userId: string) {
        return userId === "user-a" ? PERSON_A : undefined;
      },
    },
    identity: {
      async identitiesFor(userId: string) {
        return userId === "user-a"
          ? [
              {
                id: "link-1",
                userId: "user-a",
                provider: "slack",
                realm: "T123",
                subject: "U123",
                handle: "@a",
                verifiedBy: "oauth",
                credentialId: null,
                status: "active",
                createdAt: new Date("2026-01-01T00:00:00Z"),
                updatedAt: new Date("2026-01-01T00:00:00Z"),
              },
            ]
          : [];
      },
    },
    directory: {
      async readMemberships(actorId: string) {
        return actorId === "user-a" ? MEMBERSHIPS_A : [];
      },
    },
  });
}

// ---------------------------------------------------------------------------
// D1：委托等价
// ---------------------------------------------------------------------------

describe("MOD04 D1: facade delegates to internals with identical results", () => {
  test("M01 currentIdentity equals the two existing reads field by field (positive)", async () => {
    const directory = m01Directory();
    const fact: CurrentIdentityFact = await directory.currentIdentity({
      actorId: "user-a",
    });
    expect(fact.actorId).toBe("user-a");
    expect(fact.person).toEqual(PERSON_A);
    expect(fact.person).toBe(PERSON_A); // 逐项相等且同引用：纯透传
    expect(fact.identityLinks).toHaveLength(1);
    expect(fact.identityLinks[0]?.provider).toBe("slack");
    expect(fact.identityLinks[0]?.status).toBe("active");
  });

  test("M01 currentIdentity keeps the unknown-actor fact shape (negative)", async () => {
    const directory = m01Directory();
    const fact = await directory.currentIdentity({ actorId: "user-unknown" });
    expect(fact.person).toBeUndefined();
    expect(fact.identityLinks).toEqual([]);
  });

  test("M01 discoverMemberships equals the injected directory facts read (positive + negative)", async () => {
    const directory = m01Directory();
    const facts: ActorMembershipFacts = await directory.discoverMemberships({
      actorId: "user-a",
    });
    expect(facts.companies).toEqual(MEMBERSHIPS_A);
    expect(facts.companies).toBe(MEMBERSHIPS_A); // 纯透传同一数组
    const empty = await directory.discoverMemberships({ actorId: "nobody" });
    expect(empty.companies).toEqual([]);
  });

  test("M02 resolveContext returns the resolver's very scope object and propagates its refusal (stub delegation)", async () => {
    const { access, counts } = await stubInternalsFixture();
    const request = new Request("https://facade.invalid/resolve");
    const scope = await access.resolveContext(request);
    expect(scope).toBe(STUB_SCOPE);
    expect(counts.read()).toBe(1);
    const refused = await codeOf(
      access.resolveContext(
        new Request("https://facade.invalid/resolve", {
          headers: { "x-test-refuse": "tenant" },
        }),
      ),
    );
    expect(refused).toBe("TENANT_FORBIDDEN");
  });

  test("M02 authorizeAction(check) equals createAuthz().check on the same facts (positive + negatives)", async () => {
    const { access } = await stubInternalsFixture();
    const direct = createAuthz();
    const good = {
      scope: STUB_SCOPE,
      resource: {
        id: "resource-1",
        tenantId: STUB_SCOPE.tenantId,
        workspaceId: STUB_SCOPE.workspaceId,
        principalId: STUB_SCOPE.principalId,
        revision: 1,
        aclEpoch: 1,
        policyRevision: TENANCY_V1_POLICY_ID,
        active: true,
        locallyAllowed: true,
      },
      action: "read" as const,
    };
    await expect(
      access.authorizeAction({ kind: "check", ...good }),
    ).resolves.toBe(true);
    expect(await direct.check(good)).toBe(true);
    // 反例 1：跨团队资源（事实不匹配）→ false，同内件。
    const crossWorkspace = {
      ...good,
      resource: { ...good.resource, workspaceId: "workspace-other" },
    };
    await expect(
      access.authorizeAction({ kind: "check", ...crossWorkspace }),
    ).resolves.toBe(false);
    expect(await direct.check(crossWorkspace)).toBe(false);
    // 反例 2：非活跃资源 → false，同内件。
    const inactive = {
      ...good,
      resource: { ...good.resource, active: false },
    };
    await expect(
      access.authorizeAction({ kind: "check", ...inactive }),
    ).resolves.toBe(false);
    // 反例 3：不支持的策略版本 → 响亮拒绝，同内件。
    const unsupported = {
      ...good,
      resource: { ...good.resource, policyRevision: "future-v9" },
    };
    expect(
      await codeOf(access.authorizeAction({ kind: "check", ...unsupported })),
    ).toBe("POLICY_REVISION_UNSUPPORTED");
    expect(await codeOf(direct.check(unsupported))).toBe(
      "POLICY_REVISION_UNSUPPORTED",
    );
  });

  test("M02 authorizeAction(evaluate) equals the shipped registry's evaluate verdict (positive + negatives)", async () => {
    const { access } = await stubInternalsFixture();
    const registry = createShippedResourcePolicyRegistry();
    const facts: ResourcePolicyFacts = {
      scope: {
        tenantId: "tenant-a",
        workspaceId: "workspace-a1",
        principalId: "principal-a",
        actorId: "user-a",
      },
      resource: {
        tenantId: "tenant-a",
        workspaceId: "workspace-a1",
        id: "resource-1",
        visibility: "private",
        status: "active",
        revision: 1,
        aclEpoch: 1,
        policyRevision: WORKSPACE_V1_POLICY_ID,
      },
      grant: { read: true },
      workspaceMembership: { status: "active" },
    };
    await expect(
      access.authorizeAction({
        kind: "evaluate",
        facts,
        policyVersion: WORKSPACE_V1_POLICY_ID,
      }),
    ).resolves.toEqual({ outcome: "allow" });
    expect(registry.evaluate(WORKSPACE_V1_POLICY_ID, facts)).toEqual({
      outcome: "allow",
    });
    // 反例：撤回显式授权后（事实变化）→ deny，同内件。
    const ungranted = { ...facts, grant: { read: false } };
    await expect(
      access.authorizeAction({
        kind: "evaluate",
        facts: ungranted,
        policyVersion: WORKSPACE_V1_POLICY_ID,
      }),
    ).resolves.toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    // 反例：未注册版本 → 响亮拒绝，同内件。
    expect(
      await codeOf(
        access.authorizeAction({
          kind: "evaluate",
          facts,
          policyVersion: "unregistered-v0",
        }),
      ),
    ).toBe("POLICY_REVISION_UNSUPPORTED");
  });

  test("M02 authorizeAction(decide) returns the decision service's verdict verbatim (stub delegation)", async () => {
    const { access, counts } = await stubInternalsFixture();
    const verdict = await access.authorizeAction({
      kind: "decide",
      scope: STUB_SCOPE,
      resourceId: "resource-1",
    });
    expect(verdict).toEqual({
      outcome: "deny",
      code: "RESOURCE_NOT_FOUND",
    });
    expect(counts.policy()).toBe(1);
  });

  test("M02 runInScope delegates to the gate's transaction with the same scope, tx handle and result (D4)", async () => {
    const { access, counts } = await stubInternalsFixture();
    let seenTx: unknown;
    const result = await access.runInScope(STUB_SCOPE, async (tx) => {
      seenTx = tx;
      return "executed-42";
    });
    expect(result).toBe("executed-42");
    expect(seenTx).toBe("stub-tx");
    expect(counts.gate()).toBe(1);
    // operation 内抛错按原路径透传（openmuse-task-tenancy 的释放-租约分支依赖此语义）。
    const propagated = await codeOf(
      access.runInScope(STUB_SCOPE, async () => {
        throw new Error("OPERATION_FAILED");
      }),
    );
    expect(propagated).toBe("OPERATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// D3：验收 2 反例——真实内件的无 DB 路径
// ---------------------------------------------------------------------------

describe("MOD04 D3: real internals reject before touching the database (acceptance 2 negatives)", () => {
  test("resolveContext on the REAL resolver: missing identity / tenant / workspace are refused before any transaction", async () => {
    const { access, directoryTouches } = await realInternalsFixture();
    const base = "https://real.invalid/resolve";
    expect(await codeOf(access.resolveContext(new Request(base)))).toBe(
      "AUTH_REQUIRED",
    );
    expect(
      await codeOf(
        access.resolveContext(
          new Request(base, { headers: { "x-test-actor": "user-a" } }),
        ),
      ),
    ).toBe("TENANT_REQUIRED");
    expect(
      await codeOf(
        access.resolveContext(
          new Request(base, {
            headers: {
              "x-test-actor": "user-a",
              "x-openbot-tenant": "tenant-a",
            },
          }),
        ),
      ),
    ).toBe("WORKSPACE_REQUIRED");
    expect(directoryTouches()).toBe(0);
  });

  test("runInScope on the REAL gate: a forged scope is refused (UNVERIFIED_SCOPE) before any transaction", async () => {
    const { access, dataTouches } = await realInternalsFixture();
    const forged = {
      tenantId: "tenant-a",
      workspaceId: "workspace-a1",
      principalId: "principal-a",
      actorId: "user-a",
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } satisfies PlatformScope;
    let operationRan = false;
    expect(
      await codeOf(
        access.runInScope(forged, async () => {
          operationRan = true;
        }),
      ),
    ).toBe("UNVERIFIED_SCOPE");
    expect(operationRan).toBe(false);
    expect(dataTouches()).toBe(0);
  });

  test("authorizeAction(decide) on the REAL decision service: a forged scope is refused before any transaction", async () => {
    const { access, dataTouches } = await realInternalsFixture();
    const forged = {
      tenantId: "tenant-a",
      workspaceId: "workspace-a1",
      principalId: "principal-a",
      actorId: "user-a",
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    } satisfies PlatformScope;
    expect(
      await codeOf(
        access.authorizeAction({
          kind: "decide",
          scope: forged,
          resourceId: "resource-1",
        }),
      ),
    ).toBe("UNVERIFIED_SCOPE");
    expect(dataTouches()).toBe(0);
  });

  test("acceptance 2: a same-team PRIVATE object without an explicit grant stays denied under workspace-v1 (pure facts, no DB)", async () => {
    const { access } = await realInternalsFixture();
    const privateFacts: ResourcePolicyFacts = {
      scope: {
        tenantId: "tenant-a",
        workspaceId: "workspace-a1",
        principalId: "principal-a",
        actorId: "user-a",
      },
      resource: {
        tenantId: "tenant-a",
        workspaceId: "workspace-a1",
        id: "resource-private",
        visibility: "private",
        status: "active",
        revision: 1,
        aclEpoch: 1,
        policyRevision: WORKSPACE_V1_POLICY_ID,
      },
      // 同团队、成员有效——但对象是私有的且无显式授权：团队公共放行不适用。
      grant: { read: false },
      workspaceMembership: { status: "active" },
    };
    await expect(
      access.authorizeAction({
        kind: "evaluate",
        facts: privateFacts,
        policyVersion: WORKSPACE_V1_POLICY_ID,
      }),
    ).resolves.toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    // 对照：同一对象在 tenancy-v1（在位语义）下同样拒绝。
    await expect(
      access.authorizeAction({
        kind: "evaluate",
        facts: privateFacts,
        policyVersion: TENANCY_V1_POLICY_ID,
      }),
    ).resolves.toEqual({ outcome: "deny", code: "RESOURCE_NOT_FOUND" });
    // 对照：显式授权在位时（授权事实成立）tenancy-v1 放行——判定只随事实变。
    await expect(
      access.authorizeAction({
        kind: "evaluate",
        facts: { ...privateFacts, grant: { read: true } },
        policyVersion: TENANCY_V1_POLICY_ID,
      }),
    ).resolves.toEqual({ outcome: "allow" });
  });
});

// ---------------------------------------------------------------------------
// D2：验收 1 形状钉——只输出事实、选择器不赋权（结构断言）
// ---------------------------------------------------------------------------

/** 授权语义字段黑名单：任何以「资格/授权」而不是「成员事实」出现的键。 */
const FORBIDDEN_AUTHORIZATION_KEYS = [
  "scope",
  "aclEpoch",
  "grant",
  "grants",
  "read",
  "allowed",
  "canRead",
  "mayRead",
  "permissions",
  "entitlements",
  "capability",
  "capabilities",
  "token",
] as const;

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
}

describe("MOD04 D2: facts-only shape and selectors-don't-authorize (acceptance 1)", () => {
  test("M01 returns carry membership FACTS only — no authorization-semantics keys anywhere in the result", async () => {
    const directory = m01Directory();
    const identity = await directory.currentIdentity({ actorId: "user-a" });
    const memberships = await directory.discoverMemberships({
      actorId: "user-a",
    });
    const keys = new Set<string>();
    collectKeys(identity, keys);
    collectKeys(memberships, keys);
    for (const forbidden of FORBIDDEN_AUTHORIZATION_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    // 成员事实白名单钉死：公司/团队事实 = ID + 状态（+person/identity 既有字段）。
    expect(keys.has("tenantId")).toBe(true);
    expect(keys.has("memberStatus")).toBe(true);
    expect(keys.has("workspaceId")).toBe(true);
  });

  test("M01 discoverMemberships input has no company/team selector and ignores selector-shaped extras", async () => {
    const directory = m01Directory();
    // 选择器形状的多余字段不改变结果：门面只消费 actorId（结构上不存在选择器）。
    const extras = {
      tenantId: "tenant-forged",
      workspaceId: "workspace-forged",
      aclEpoch: 99,
    };
    const plain = await directory.discoverMemberships({ actorId: "user-a" });
    const withForgedSelectors = await directory.discoverMemberships({
      actorId: "user-a",
      ...extras,
    });
    expect(withForgedSelectors).toEqual(plain);
    // 响应面同样不含伪造来的选择器回显。
    expect(JSON.stringify(withForgedSelectors).includes("tenant-forged")).toBe(
      false,
    );
  });

  test("M02 resolveContext output is the resolver's PlatformScope — unchanged in shape, still trust-marked only by issuance", async () => {
    const { access } = await stubInternalsFixture();
    const scope = await access.resolveContext(
      new Request("https://facade.invalid/resolve"),
    );
    // 门面不构造、不复签、不改写 Scope：拿到的是签发半边的同一对象。
    expect(scope).toBe(STUB_SCOPE);
    // PlatformScope 字段面原样（aclEpoch 是既有 Scope 合同的一部分，由签发半边拥有）。
    expect(Object.keys(scope).sort()).toEqual(
      [
        "actorId",
        "aclEpoch",
        "entrypoint",
        "memberEpoch",
        "principalId",
        "tenantId",
        "workspaceId",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// D5：验收 4——门面零写入面（结构 + grep 级断言）
// ---------------------------------------------------------------------------

describe("MOD04 D5: facades expose a read-only surface (acceptance 4)", () => {
  test("M01 facade object surface is exactly the two read capabilities", async () => {
    const directory = m01Directory();
    expect(Object.keys(directory).sort()).toEqual([
      "currentIdentity",
      "discoverMemberships",
    ]);
  });

  test("M02 facade object surface is exactly the three access capabilities", async () => {
    const { access } = await stubInternalsFixture();
    expect(Object.keys(access).sort()).toEqual([
      "authorizeAction",
      "resolveContext",
      "runInScope",
    ]);
  });

  test("facade sources contain no write calls and exactly one factory export each (grep-level)", async () => {
    const files = [
      "../../src/auth/public.ts",
      "../../src/enterprise/authz/public.ts",
    ];
    for (const rel of files) {
      const source = readFileSync(
        fileURLToPath(new URL(rel, import.meta.url)),
        "utf8",
      );
      expect(/\.(insert|update|delete|truncate)\s*\(/.test(source)).toBe(false);
      expect(/\bpg_advisory\b/.test(source)).toBe(false);
      const exportedFunctions = source.match(/export function (\w+)/g) ?? [];
      expect(exportedFunctions).toHaveLength(1);
    }
  });

  test("M01 facade source statically imports only the M01 group (no enterprise/M02 file)", async () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/auth/public.ts", import.meta.url)),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(/^\.\.\/(auth|identity|people)(\/|$)/.test(spec)).toBe(true);
    }
  });

  test("M02 facade source statically imports only the M02 group", async () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../src/enterprise/authz/public.ts", import.meta.url),
      ),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(
        spec === "../contracts" || /^(\.\.\/tenancy\/|\.\/service)/.test(spec),
      ).toBe(true);
    }
  });
});
