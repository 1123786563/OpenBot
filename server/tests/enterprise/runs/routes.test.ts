import { describe, expect, test } from "bun:test";
import type { EnterpriseDependencies } from "../../../src/enterprise/app";
import { createEnterpriseApp } from "../../../src/enterprise/app";
import type { Database, } from "../../../src/db/client";
import type { Membership, Scope } from "../../../src/enterprise/contracts";
import type { EnterpriseRuntimeConfig } from "../../../src/enterprise/runtime/config";
import type { GatewayDeps } from "../../../src/enterprise/runs/gateway";
import type { RunServiceE1 } from "../../../src/enterprise/runs/service";
import type { RunCommand, RunService } from "../../../src/enterprise/runs/contracts";
import type {
  CreateRun,
  RunEventView,
  RunView,
} from "../../../../shared/enterprise/run-contracts";

/*
 * E1-C 公共路由装配（03 分册 §9.2/§9.3）。
 *
 * 纯 HTTP 合同半场，不落库（真实创建语义由 create.test.ts 在真实库上取证）：
 * POST /runs 返回 202+RunView 且 DTO 不含 input_digest/服务地址/capability；
 * Idempotency-Key 用 ID Schema 校验；读取 JSON 前流式字节限制 64KiB→413、非法
 * JSON 400；runServices 未启用时不注册创建实现——POST /runs 明确 503，不是空成功。
 */

const RUN_VIEW: RunView = {
  run_id: "run_http_contract",
  thread_id: "thr_http_contract",
  status: "queued",
  revision: "0",
  latest_seq: "0",
  reconciliation_required: false,
  reason_code: null,
};

const ACTIVE_MEMBER: Membership = {
  tenantId: "http-tenant",
  principalId: "http-principal",
  tenantName: "HTTP Tenant",
  role: "member",
  epoch: 1,
  tenantStatus: "active",
  principalStatus: "active",
  memberStatus: "active",
};

const SESSION_USER = { id: "http-user", email: "http@test-only" };

type CreateCall = { scope: Scope; key: string; request: CreateRun };

/** 记录入参的脚本化 RunService：HTTP 合同测试，不伪造预算或授权语义。 */
function scriptedRunService(
  handlers: {
    create?: (call: CreateCall) => Promise<RunView>;
    get?: (scope: Scope, id: string) => Promise<RunView>;
  } = {},
): RunService {
  const calls: { creates: CreateCall[]; gets: Array<{ scope: Scope; id: string }> } = {
    creates: [],
    gets: [],
  };
  return {
    async create(scope, key, request) {
      calls.creates.push({ scope, key, request });
      return handlers.create
        ? handlers.create({ scope, key, request })
        : RUN_VIEW;
    },
    async get(scope, id) {
      calls.gets.push({ scope, id });
      return handlers.get ? handlers.get(scope, id) : RUN_VIEW;
    },
    async command(_scope: Scope, _id: string, _command: RunCommand): Promise<RunView> {
      throw new Error("not reached in the HTTP contract test");
    },
    async readEvents(
      _scope: Scope,
      _id: string,
      _after: string,
      _limit: number,
    ): Promise<RunEventView[]> {
      throw new Error("not reached in the HTTP contract test");
    },
  };
}

function unitDeps(
  overrides: Partial<EnterpriseDependencies> = {},
): EnterpriseDependencies {
  return {
    auth: {
      handler: async () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    },
    directory: { listForUser: async () => [] },
    resources: {
      readAuthorizedResource: async () => {
        throw new Error("not reached");
      },
    },
    authz: { check: async () => false },
    conversationsDatabase: null as unknown as Database,
    allowedOrigins: new Set<string>(),
    authRoutes: new Set<string>(),
    logRedactedSecurityError: () => {},
    isDraining: () => false,
    ready: async () => true,
    ...overrides,
  };
}

function appWithRuns(
  overrides: Partial<EnterpriseDependencies> = {},
  runs?: RunService,
) {
  return createEnterpriseApp(
    unitDeps({
      auth: {
        handler: async () => new Response(null, { status: 204 }),
        api: { getSession: async () => ({ user: SESSION_USER }) },
      },
      directory: { listForUser: async () => [ACTIVE_MEMBER] },
      allowedOrigins: new Set(["https://app.test"]),
      ...(runs === undefined ? {} : { runServices: { runs } }),
      ...overrides,
    }),
  );
}

const POST = {
  method: "POST" as const,
  headers: {
    origin: "https://app.test",
    "content-type": "application/json",
    "x-openbot-tenant": "http-tenant",
    "idempotency-key": "key-1",
  },
};

function postBody(body: unknown, headers: Record<string, string> = POST.headers) {
  return {
    method: "POST" as const,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const VALID_BODY = {
  workspace_id: "ws-1",
  expert_release_id: "release-1",
  model_alias: "chat",
  input: { text: "hello" },
};

describe("POST /runs is 503 when run services are disabled", () => {
  test("creating a run is an explicit refusal, never an empty success", async () => {
    const app = appWithRuns();
    const response = await app.request("/api/enterprise/v1/runs", postBody(VALID_BODY));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RUNS_DISABLED");
  });

  test("reading a run is refused with the same 503", async () => {
    const app = appWithRuns();
    const response = await app.request("/api/enterprise/v1/runs/run_1", {
      headers: { "x-openbot-tenant": "http-tenant" },
    });
    expect(response.status).toBe(503);
  });
});

describe("POST /runs has exactly one owner (review: no double registration)", () => {
  const gatewayConfig: EnterpriseRuntimeConfig = {
    serviceCredential: "test-only",
    serviceId: "test-gateway",
    executionUrl: "http://127.0.0.1:9/execute",
    cancelUrl: "http://127.0.0.1:9/cancel",
    runWriterDatabaseUrl: "postgres://stub:stub@127.0.0.1:1/none",
    runtimeWriterDatabaseUrl: "postgres://stub:stub@127.0.0.1:1/none",
    modelBaseUrl: "http://127.0.0.1:9",
    modelAlias: "chat",
    modelRouteRef: "route-test",
    expertVersion: "1.0.0",
    expertInstructionPath: "test-only",
    governedTools: [],
    budgetCapMicros: 1_000_000,
    budgetCurrency: "USD",
    leaseTtlMs: 45_000,
    capabilityTtlMs: 300_000,
  };
  /** 互斥规则下网关路由永不匹配，其依赖只表达“在位”这一事实，绝不触达。 */
  const gatewayDeps: GatewayDeps = {
    service: null as unknown as RunServiceE1,
    runtime: gatewayConfig,
    keyEncryptionKey: "test-only",
  };

  test("with both configured, the ledger owns POST /runs and GET /runs/:id", async () => {
    const runs = scriptedRunService({
      create: async () => ({ ...RUN_VIEW, run_id: "run_ledger_owner" }),
      get: async () => ({ ...RUN_VIEW, run_id: "run_ledger_owner" }),
    });
    const app = appWithRuns(
      {
        runtime: {
          verify: async () => {
            throw new Error("not reached");
          },
          gateway: gatewayDeps,
        },
      },
      runs,
    );
    const created = await app.request(
      "/api/enterprise/v1/runs",
      postBody(VALID_BODY),
    );
    expect(created.status).toBe(202);
    expect(((await created.json()) as RunView).run_id).toBe("run_ledger_owner");
    const read = await app.request("/api/enterprise/v1/runs/run_ledger_owner", {
      headers: { "x-openbot-tenant": "http-tenant" },
    });
    expect(read.status).toBe(200);
    expect(((await read.json()) as RunView).run_id).toBe("run_ledger_owner");
  });

  test("without run services the gateway's entry stays the fallback owner (no 503 stub)", async () => {
    const app = appWithRuns({
      runtime: {
        verify: async () => {
          throw new Error("not reached");
        },
        gateway: gatewayDeps,
      },
    });
    /* 网关路由已注册：其 handler 在桩依赖上失败为 500，而不是 503 的“未启用”桩，也不是 404。 */
    const response = await app.request(
      "/api/enterprise/v1/runs",
      postBody(VALID_BODY),
    );
    expect(response.status).toBe(500);
  });
});

describe("the mounted run routes", () => {
  test("POST /runs returns 202 with a bare RunView and passes the idempotency key", async () => {
    let seen: CreateCall | undefined;
    const runs = scriptedRunService({
      create: async (call) => {
        seen = call;
        return RUN_VIEW;
      },
    });
    const app = appWithRuns({}, runs);
    const response = await app.request("/api/enterprise/v1/runs", postBody(VALID_BODY));
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ...RUN_VIEW });
    for (const forbidden of ["input_digest", "service", "capability", "input", "tenant_id"]) {
      expect(Object.keys(body), forbidden).not.toContain(forbidden);
    }
    expect(seen?.key).toBe("key-1");
    expect(seen?.request).toEqual(VALID_BODY);
    expect(seen?.scope.tenantId).toBe("http-tenant");
    expect(seen?.scope.principalId).toBe("http-principal");
  });

  test("a missing or malformed Idempotency-Key is 400", async () => {
    const app = appWithRuns({}, scriptedRunService());
    const missing = { ...POST.headers };
    delete (missing as Record<string, unknown>)["idempotency-key"];
    const noKey = await app.request("/api/enterprise/v1/runs", postBody(VALID_BODY, missing));
    expect(noKey.status).toBe(400);
    const badKey = await app.request(
      "/api/enterprise/v1/runs",
      postBody(VALID_BODY, { ...POST.headers, "idempotency-key": "bad key!" }),
    );
    expect(badKey.status).toBe(400);
  });

  test("illegal JSON is 400, never 500", async () => {
    const app = appWithRuns({}, scriptedRunService());
    const response = await app.request(
      "/api/enterprise/v1/runs",
      postBody("{not json"),
    );
    expect(response.status).toBe(400);
  });

  test("a body over 64KiB is refused 413 before parsing", async () => {
    const app = appWithRuns({}, scriptedRunService());
    const big = JSON.stringify({
      ...VALID_BODY,
      input: { text: "x".repeat(70_000) },
    });
    const response = await app.request("/api/enterprise/v1/runs", postBody(big));
    expect(response.status).toBe(413);
  });

  test("a schema-invalid body is 400", async () => {
    const app = appWithRuns({}, scriptedRunService());
    const response = await app.request(
      "/api/enterprise/v1/runs",
      postBody({ ...VALID_BODY, tenant_id: "smuggled" }),
    );
    expect(response.status).toBe(400);
  });

  test("GET /runs/:id returns the RunView; a malformed id is 404", async () => {
    let seenId: string | undefined;
    const runs = scriptedRunService({
      get: async (_scope, id) => {
        seenId = id;
        return RUN_VIEW;
      },
    });
    const app = appWithRuns({}, runs);
    const ok = await app.request("/api/enterprise/v1/runs/run_http_contract", {
      headers: { "x-openbot-tenant": "http-tenant" },
    });
    expect(ok.status).toBe(200);
    expect(seenId).toBe("run_http_contract");
    expect(await ok.json()).toEqual({ ...RUN_VIEW });

    const bad = await app.request("/api/enterprise/v1/runs/not%20a%20run%20id", {
      headers: { "x-openbot-tenant": "http-tenant" },
    });
    expect(bad.status).toBe(404);
  });
});
