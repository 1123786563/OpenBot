// server/tests/multitenancy/telemetry-attribution.test.ts
// MT108（Issue #151）：trace、日志与业务事件的归属字段注入。
//
// 验收事实源（Issue #151 四条，逐条对应 describe）：
//   AC1 每条 trace/日志/事件都能追溯到公司、团队与发起主体——同一词汇、
//      同一字段集，记录种类（trace/log/event）不改变归属键。
//   AC2 归属字段在跨语言与后台执行路径中不丢失——wire 半边与 #93 的
//      RuntimeInvocationWireSchema 逐字段对照；ambient 半边穿越 await 与
//      后台续体（与 usage-origin 同一 AsyncLocalStorage 模式）。
//   AC3 归属字段不含明文凭据或可反推秘密的信息——凭据形状在入口即拒
//      （不 trim、不归一化、不截断后放行）。
//   AC4 缺失归属的记录被标记为异常（openbot.attribution=missing），绝不
//      静默归到默认范围；不带标记的记录本身被 reader 读成 unmarked 异常。
//
// 环境契约：纯函数面（§1–§4）零依赖独立运行；受信 scope 正向签发面
// （§5）只认真实 PostgreSQL 上的 resolver 签发（缺 env 显式 skip，理由写
// 在 suite 名里，skipped 不计为通过，绝不回退开发库）。

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../../src/db/client";
import { users } from "../../src/db/schema/core";
import { enterprisePrincipals } from "../../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { provisionDeployment } from "../../src/enterprise/tenancy/provision";
import {
  type AuthenticatedRequestIdentity,
  createScopeResolver,
} from "../../src/enterprise/tenancy/store";
import {
  ATTRIBUTION_MISSING,
  ATTRIBUTION_PRESENT,
  attributionStatusOf,
  currentTelemetryAttribution,
  isAttributionIdentifier,
  telemetryAttributesOf,
  telemetryAttributionFromInvocation,
  telemetryAttributionFromScope,
  telemetryRecordAttributes,
  TELEMETRY_ATTRIBUTION_IDENTIFIER_INVALID,
  withTelemetryAttribution,
  type TelemetryAttribution,
} from "../../src/enterprise/tenancy/telemetry-attribution";
import {
  type DirectoryDatabase,
  type OperatorDatabase,
  verifyDirectoryDatabase,
  verifyOperatorDatabase,
} from "../../src/enterprise/tenancy/connections";
import { RuntimeInvocationWireSchema } from "../../src/enterprise/wire-schema";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（受信签发正向面需要真实库）
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const setup =
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL ??
    process.env.TEST_DATABASE_URL;
  if (!setup?.trim()) {
    return {
      ok: false,
      reason: "ENTERPRISE_TEST_SETUP_DATABASE_URL/TEST_DATABASE_URL not set",
    };
  }
  for (const role of ["DIRECTORY", "OPERATOR"] as const) {
    if (!process.env[`ENTERPRISE_TEST_${role}_DATABASE_URL`]?.trim()) {
      return {
        ok: false,
        reason: `ENTERPRISE_TEST_${role}_DATABASE_URL not set`,
      };
    }
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 纯面共用夹具
// ---------------------------------------------------------------------------

const WIRED_EXECUTION = {
  initiatorKind: "human" as const,
  runId: "0b9f6a1e-1111-4111-8111-111111111111",
  attemptId: "1c8e7b2f-2222-4222-8222-222222222222",
  turnId: "2d9f8c3a-3333-4333-8333-333333333333",
  threadId: "mt108-native-thread",
};

const WIRED_INVOCATION = RuntimeInvocationWireSchema.parse({
  schema_version: 1,
  tenant_id: "mt108-tenant",
  workspace_id: "mt108-workspace",
  principal_id: "mt108-principal",
  actor_id: "mt108-actor",
  initiator_kind: "human",
  run_id: WIRED_EXECUTION.runId,
  attempt_id: WIRED_EXECUTION.attemptId,
  turn_id: WIRED_EXECUTION.turnId,
  thread_id: WIRED_EXECUTION.threadId,
  expert_version: "mt108-expert@1",
  input_digest: `sha256:${"a1b2c3d4".repeat(8)}`,
  model_route_ref: "mt108-route",
  budget_reservation_id: "4fbeae5c-5555-4555-8555-555555555555",
  lease_id: "3eaf9d4b-4444-4444-8444-444444444444",
  fencing_token: "7",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});

/** 手造（未签发）scope：受信门在纯面唯一的可测形态就是被拒。 */
const HAND_BUILT_SCOPE: PlatformScope = {
  tenantId: "mt108-tenant",
  workspaceId: "mt108-workspace",
  principalId: "mt108-principal",
  actorId: "mt108-actor",
  memberEpoch: 7,
  aclEpoch: 1,
  entrypoint: "web",
};

// ---------------------------------------------------------------------------
// AC1：每条记录可追溯——同一词汇、同一字段集
// ---------------------------------------------------------------------------

describe("MT108 AC1 every trace/log/event is traceable to company, team and subject", () => {
  const attribution: TelemetryAttribution = {
    tenantId: "mt108-tenant",
    workspaceId: "mt108-workspace",
    principalId: "mt108-principal",
    actorId: "mt108-actor",
    entrypoint: "mobile",
  };

  test("attributes name the company, the team and the initiating subject", () => {
    const attributes = telemetryAttributesOf(attribution);
    expect(attributes["openbot.tenant_id"]).toBe("mt108-tenant");
    expect(attributes["openbot.workspace_id"]).toBe("mt108-workspace");
    expect(attributes["openbot.principal_id"]).toBe("mt108-principal");
    expect(attributes["openbot.actor_id"]).toBe("mt108-actor");
    expect(attributes["openbot.entrypoint"]).toBe("mobile");
  });

  test("a record tied to a run carries the execution half under the wire's own names", () => {
    const attributes = telemetryAttributesOf({
      ...attribution,
      execution: WIRED_EXECUTION,
    });
    expect(attributes["openbot.initiator_kind"]).toBe("human");
    expect(attributes["openbot.run_id"]).toBe(WIRED_EXECUTION.runId);
    expect(attributes["openbot.attempt_id"]).toBe(WIRED_EXECUTION.attemptId);
    expect(attributes["openbot.turn_id"]).toBe(WIRED_EXECUTION.turnId);
    expect(attributes["openbot.thread_id"]).toBe(WIRED_EXECUTION.threadId);
  });

  test("the record kind never changes the attribution vocabulary", () => {
    const kinds = ["trace", "log", "event"] as const;
    const expected = telemetryRecordAttributes({
      attribution,
      surface: "trace",
    });
    for (const surface of kinds) {
      expect(telemetryRecordAttributes({ attribution, surface })).toEqual(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// AC2：跨语言与后台执行路径不丢失
// ---------------------------------------------------------------------------

describe("MT108 AC2 attribution survives the language boundary and background paths", () => {
  test("a wire envelope's attribution round-trips field for field — the #93 contract, same names", () => {
    const fromWire = telemetryAttributionFromInvocation(WIRED_INVOCATION);
    // 身份四元组 + 执行四元组：wire 上有的，telemetry 里一个不少、一字不差。
    expect(fromWire.tenantId).toBe(WIRED_INVOCATION.tenant_id);
    expect(fromWire.workspaceId).toBe(WIRED_INVOCATION.workspace_id);
    expect(fromWire.principalId).toBe(WIRED_INVOCATION.principal_id);
    expect(fromWire.actorId).toBe(WIRED_INVOCATION.actor_id);
    expect(fromWire.execution?.runId).toBe(WIRED_INVOCATION.run_id);
    expect(fromWire.execution?.initiatorKind).toBe(
      WIRED_INVOCATION.initiator_kind,
    );
    const attributes = telemetryAttributesOf(fromWire);
    expect(attributes["openbot.tenant_id"]).toBe("mt108-tenant");
    expect(attributes["openbot.run_id"]).toBe(WIRED_EXECUTION.runId);
    // entrypoint 如实缺席：运行侧不知道入口面，不虚构。
    expect("openbot.entrypoint" in attributes).toBe(false);
  });

  test("ambient attribution crosses awaits and detached background continuations", async () => {
    const attribution: TelemetryAttribution = {
      tenantId: "mt108-tenant",
      workspaceId: "mt108-workspace",
      principalId: "mt108-principal",
      actorId: "mt108-actor",
    };
    const acrossAwaits = await withTelemetryAttribution(
      attribution,
      async () => {
        await Promise.resolve();
        const first = currentTelemetryAttribution();
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return { first, afterTimer: currentTelemetryAttribution() };
      },
    );
    expect(acrossAwaits.first).toEqual(attribution);
    expect(acrossAwaits.afterTimer).toEqual(attribution);
    // 离开携带域后回到 null——调用方交给发射门落 missing 标记。
    expect(currentTelemetryAttribution()).toBeNull();
  });

  test("parallel carried branches read their own attribution, never each other's", async () => {
    const a: TelemetryAttribution = {
      tenantId: "tenant-a",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      actorId: "actor-a",
    };
    const b: TelemetryAttribution = {
      tenantId: "tenant-b",
      workspaceId: "workspace-b",
      principalId: "principal-b",
      actorId: "actor-b",
    };
    const read = async () => {
      await Promise.resolve();
      return currentTelemetryAttribution()?.tenantId ?? null;
    };
    const [inA, inB] = await Promise.all([
      withTelemetryAttribution(a, read),
      withTelemetryAttribution(b, read),
    ]);
    expect(inA).toBe("tenant-a");
    expect(inB).toBe("tenant-b");
  });
});

// ---------------------------------------------------------------------------
// AC3：归属字段不含明文凭据或可反推秘密的信息
// ---------------------------------------------------------------------------

describe("MT108 AC3 no credentials or secret-derivable values in attribution fields", () => {
  test("credential shapes are refused as identifiers, one and all", () => {
    const shapes = [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "sk-ant-api03-fixture-key-1234567890abcdef",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
      "glpat-abcdefghijklmnopqrst",
      "xoxb-1234567890abcdefABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
      "sk_live_16C7e42F292c6912E7710c838347Ae178B4a",
      "npm_000000000000000000000000000000000000",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "Bearer eyJhbGciOi.example.not-a-real-token",
      "https://user:hunter2@example.invalid/api",
    ];
    for (const shape of shapes) {
      expect(isAttributionIdentifier(shape)).toBe(false);
    }
  });

  test("bare identifiers pass; malformed ones (whitespace, empty, overlong) do not", () => {
    for (const bare of [
      "acme",
      "tenant-42",
      "0b9f6a1e-1111-4111-8111-111111111111",
    ]) {
      expect(isAttributionIdentifier(bare)).toBe(true);
    }
    for (const malformed of ["", " acme", "ac me", "acme\n", "a".repeat(201)]) {
      expect(isAttributionIdentifier(malformed)).toBe(false);
    }
  });

  test("a credential pasted into a wire envelope's identity field is refused at the door", () => {
    // wire schema 的 Identifier 放得过 JWT（1..200 字符串），归属门不放——
    // 两层各自独立，第二层是结构保证不是纪律重复。
    const tampered = RuntimeInvocationWireSchema.parse({
      ...WIRED_INVOCATION,
      tenant_id:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    });
    expect(() => telemetryAttributionFromInvocation(tampered)).toThrow(
      TELEMETRY_ATTRIBUTION_IDENTIFIER_INVALID,
    );
  });

  test("emitted attributes carry the identifiers verbatim and nothing else", () => {
    const attribution: TelemetryAttribution = {
      tenantId: "mt108-tenant",
      workspaceId: "mt108-workspace",
      principalId: "mt108-principal",
      actorId: "mt108-actor",
      execution: WIRED_EXECUTION,
    };
    const attributes = telemetryAttributesOf(attribution);
    // 值即所传标识：没有派生、没有摘要盐、没有任何可反推的材料。
    expect(new Set(Object.values(attributes))).toEqual(
      new Set([
        ATTRIBUTION_PRESENT,
        "mt108-tenant",
        "mt108-workspace",
        "mt108-principal",
        "mt108-actor",
        "human",
        WIRED_EXECUTION.runId,
        WIRED_EXECUTION.attemptId,
        WIRED_EXECUTION.turnId,
        WIRED_EXECUTION.threadId,
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// AC4：缺失归属被标记为异常，不静默归到默认范围
// ---------------------------------------------------------------------------

describe("MT108 AC4 missing attribution is marked, never defaulted", () => {
  test("the emission door refuses to emit nothing: null attribution yields the missing marker", () => {
    const attributes = telemetryRecordAttributes({
      attribution: null,
      surface: "log",
      missingReason: "scope_unresolved",
    });
    expect(attributes["openbot.attribution"]).toBe(ATTRIBUTION_MISSING);
    expect(attributes["openbot.surface"]).toBe("log");
    expect(attributes["openbot.attribution.missing_reason"]).toBe(
      "scope_unresolved",
    );
    // 不带任何默认范围键：按公司查不到它，按 missing 查得到它。
    expect("openbot.tenant_id" in attributes).toBe(false);
    expect("openbot.workspace_id" in attributes).toBe(false);
  });

  test("the reader classifies attributed, missing and unmarked — unmarked is itself an anomaly", () => {
    expect(
      attributionStatusOf(
        telemetryAttributesOf({
          tenantId: "t",
          workspaceId: "w",
          principalId: "p",
          actorId: "a",
        }),
      ),
    ).toBe("attributed");
    expect(
      attributionStatusOf(
        telemetryRecordAttributes({
          attribution: null,
          surface: "event",
        }),
      ),
    ).toBe("missing");
    // 一条既无 present 又无 missing 的记录（手拼/旧路径）被读成 unmarked——
    // 观测面的对账查询以此为异常清单，而不是把它数进某一边。
    expect(attributionStatusOf({ "http.status_code": 200 })).toBe("unmarked");
  });

  test("a hand-built scope cannot mint attribution — the only fallback is the missing marker", () => {
    expect(() => telemetryAttributionFromScope(HAND_BUILT_SCOPE)).toThrow(
      "UNVERIFIED_SCOPE",
    );
  });
});

// ---------------------------------------------------------------------------
// AC5（正向签发面）：真实库上 resolver 签发的受信 scope 才能铸出归属
// ---------------------------------------------------------------------------

const prefix = `mt108-${randomUUID().slice(0, 8)}`;
const actorId = `${prefix}-actor`;
const tenantId = `${prefix}-tenant`;
const workspaceId = `${prefix}-workspace`;
const principalId = `${prefix}-principal`;
let realScope: PlatformScope | undefined;
let setupDatabase: Database | undefined;
let directoryDatabase: DirectoryDatabase | undefined;
let operatorDatabase: OperatorDatabase | undefined;
const authenticated = new WeakMap<Request, AuthenticatedRequestIdentity>();

beforeAll(async () => {
  if (!ENV.ok) return;
  const setup = createDatabase(enterpriseTestDatabaseUrlFrom(), { max: 3 });
  setupDatabase = setup;
  const directory = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("directory"),
    { max: 2 },
  );
  const operator = createDatabase(
    enterpriseRuntimeDatabaseUrlFrom("operator"),
    { max: 2 },
  );
  directoryDatabase = await verifyDirectoryDatabase(directory).catch(
    async (error) => {
      await directory.$client.close();
      throw error;
    },
  );
  operatorDatabase = await verifyOperatorDatabase(operator).catch(
    async (error) => {
      await operator.$client.close();
      throw error;
    },
  );
  await setup.insert(users).values({
    id: actorId,
    email: `${actorId}@example.invalid`,
    name: "MT108 telemetry actor",
  });
  await setup
    .insert(enterprisePrincipals)
    .values({ id: principalId, userId: actorId });
  await provisionDeployment(operatorDatabase, {
    operationId: `${prefix}-provision`,
    operator: principalId,
    tenant: { id: tenantId, name: "MT108 telemetry tenant" },
    workspace: { id: workspaceId, name: "MT108 telemetry workspace" },
    members: [{ principalId, userId: actorId, role: "tenant_admin" }],
    resources: [],
  });
  await operatorDatabase.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.tenant_id', ${tenantId}, true)`,
    );
    await tx.execute(
      sql`insert into enterprise_workspace_memberships (tenant_id, workspace_id, principal_id) values (${tenantId}, ${workspaceId}, ${principalId})`,
    );
  });
  const resolver = createScopeResolver(directoryDatabase, {
    authenticate: async (request) => authenticated.get(request) ?? null,
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
  const request = new Request("https://mt108.example.invalid/scope", {
    headers: {
      "x-openbot-tenant": tenantId,
      "x-openbot-workspace": workspaceId,
    },
  });
  authenticated.set(request, { actorId, entrypoint: "web" });
  realScope = await resolver.resolve(request);
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const database of [setupDatabase, directoryDatabase, operatorDatabase]) {
    if (!database) continue;
    try {
      await database.$client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

describeDb("MT108 issuing entrance on a real trusted scope", () => {
  test("a resolver-issued scope mints the real attribution and carries it across a background continuation", async () => {
    expect(realScope).toBeDefined();
    const attribution = telemetryAttributionFromScope(
      realScope!,
      WIRED_EXECUTION,
    );
    expect(attribution.tenantId).toBe(tenantId);
    expect(attribution.workspaceId).toBe(workspaceId);
    expect(attribution.principalId).toBe(principalId);
    expect(attribution.actorId).toBe(actorId);
    const attributes = telemetryAttributesOf(attribution);
    expect(attributes["openbot.tenant_id"]).toBe(tenantId);
    expect(attributes["openbot.run_id"]).toBe(WIRED_EXECUTION.runId);
    // 后台路径：同一归属穿越 await + timer 后仍在。
    const carried = await withTelemetryAttribution(attribution, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      return currentTelemetryAttribution();
    });
    expect(carried?.tenantId).toBe(tenantId);
  });

  test("a scope the resolver never issued (a copy) still cannot mint attribution", () => {
    expect(realScope).toBeDefined();
    const copy: PlatformScope = { ...realScope! };
    expect(() => telemetryAttributionFromScope(copy)).toThrow(
      "UNVERIFIED_SCOPE",
    );
  });
});
