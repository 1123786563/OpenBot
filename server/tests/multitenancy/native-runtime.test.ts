// server/tests/multitenancy/native-runtime.test.ts
// MT050（Issue #93）：Go Runtime、supervisor 与原生 agent 适配器的归属传递。
//
// 验收事实源（票面 4 条 AC，逐条对应 describe）：
//   AC1 归属字段在跨语言调用中不被丢弃或改写；缺失时拒绝执行。
//   AC2 原生组件不以本地信任为由跳过授权校验（含 supervisor 与 sandbox）。
//   AC3 日志与错误包含归属标识但不含明文秘密。
//   AC4 Go 侧测试覆盖正向与越权两类用例（Go 侧在 runtime-go 的
//     auth_test.go / context_test.go / cancel_test.go，本套件是 TS 侧镜像：
//     wire 契约两侧一致 + 三个原生边界的行为面）。
//
// 结构：跨语言契约的 TS 半边（RuntimeInvocationWireSchema 的 workspace_id
// 必填）与 Go 半边（identity.VerifiedRun.WorkspaceID + envelopeWire）在同一
// 次改动里对齐——票面备注「跨语言契约变更必须同时更新 MT049 侧」的落点，
// MT049（#92）消费的 TS wire schema 即本套件钉住的这份。三个原生边界
// （supervisor / agent-computer / agent-sandbox）共享
// shared/execution-scope.ts 的同一解析器与同一注册表语义，本套件从
// server 侧直接驱动它们（跨包导入的是纯函数模块，无 Bun 专属依赖）。

import {
  afterAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeExecutionScope,
  EXECUTION_TENANT_HEADER,
  EXECUTION_WORKSPACE_HEADER,
  executionWorkspaceSegments,
  ExecutionScopeRegistry,
  parseExecutionScope,
} from "../../../shared/execution-scope";
import { sandboxEnvFrom } from "../../../agent-sandbox/src/env";
import { createBotRuntimes } from "../../../agent-sandbox/src/bot-runtimes";
import { createProxyHandler } from "../../../agent-sandbox/src/proxy";
import { statedScope as computerStatedScope } from "../../../agent-computer/src/authorisation";
import { statedScope as supervisorStatedScope } from "../../../supervisor/src/authorisation";
import { RuntimeInvocationWireSchema } from "../../src/enterprise/wire-schema";

const TENANT = "tenant-mt050";
const WORKSPACE = "team-k";
const scopeHeaders = {
  [EXECUTION_TENANT_HEADER]: TENANT,
  [EXECUTION_WORKSPACE_HEADER]: WORKSPACE,
};
const otherScopeHeaders = {
  [EXECUTION_TENANT_HEADER]: "tenant-other",
  [EXECUTION_WORKSPACE_HEADER]: "team-x",
};

// ---------------------------------------------------------------------------
// 跨语言契约：TS 半边（AC1；与 Go envelopeWire/FromContext 同步变更）
// ---------------------------------------------------------------------------

describe("MT050 cross-language ownership contract (TS half)", () => {
  const invocation = {
    schema_version: 1,
    tenant_id: "tenant-1",
    workspace_id: "workspace-1",
    principal_id: "principal-1",
    actor_id: "actor-1",
    initiator_kind: "human",
    run_id: "run-1",
    attempt_id: "attempt-1",
    turn_id: "turn-1",
    thread_id: "thread-1",
    expert_version: "expert-v1",
    input_digest: `sha256:${"a".repeat(64)}`,
    model_route_ref: "model-route-1",
    budget_reservation_id: "budget-1",
    lease_id: "lease-1",
    fencing_token: "1",
    expires_at: "2026-10-09T00:00:00.000Z",
  };

  test("an invocation carrying both ownership halves parses", () => {
    expect(RuntimeInvocationWireSchema.safeParse(invocation).success).toBe(
      true,
    );
  });

  test("an invocation missing the workspace half is refused — ownership must not drop", () => {
    const { workspace_id: _dropped, ...withoutWorkspace } = invocation;
    expect(
      RuntimeInvocationWireSchema.safeParse(withoutWorkspace).success,
    ).toBe(false);
  });

  test("an invocation with a tampered workspace half is refused — not rewritten", () => {
    expect(
      RuntimeInvocationWireSchema.safeParse({
        ...invocation,
        workspace_id: "",
      }).success,
    ).toBe(false);
    expect(
      RuntimeInvocationWireSchema.safeParse({
        ...invocation,
        workspace_id: 7,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 共享解析器与注册表：三个原生边界的同一语义（AC1/AC2）
// ---------------------------------------------------------------------------

describe("MT050 execution scope parsing and per-Bot binding", () => {
  test("both headers together are the only parseable shape", () => {
    expect(parseExecutionScope(new Headers(scopeHeaders))).toEqual({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
    });
    for (const partial of [
      {},
      { [EXECUTION_TENANT_HEADER]: TENANT },
      { [EXECUTION_WORKSPACE_HEADER]: WORKSPACE },
    ]) {
      expect(parseExecutionScope(new Headers(partial))).toBeNull();
    }
  });

  test("the three native surfaces agree on every shape: supervisor and computer answer as shared does", () => {
    // 三个边界都委托 shared/execution-scope 的同一实现；一旦某一面漂移
    // （自造解析器、放宽 id 规则），这组逐形状对照立即失效。
    const shapes = [
      scopeHeaders,
      otherScopeHeaders,
      {},
      { [EXECUTION_TENANT_HEADER]: "../etc" },
      { [EXECUTION_TENANT_HEADER]: TENANT },
      {
        [EXECUTION_TENANT_HEADER]: TENANT,
        [EXECUTION_WORKSPACE_HEADER]: "UPPER",
      },
    ];
    for (const shape of shapes) {
      const headers = new Headers(shape);
      expect(supervisorStatedScope(headers)).toEqual(
        parseExecutionScope(headers),
      );
      expect(computerStatedScope(headers)).toEqual(
        parseExecutionScope(headers),
      );
    }
  });

  test("a Bot's scope binds once; any other scope is refused however similar", () => {
    const registry = new ExecutionScopeRegistry();
    expect(
      registry.bind("bot-1", { tenantId: TENANT, workspaceId: WORKSPACE }),
    ).toBe(true);
    expect(
      registry.bind("bot-1", { tenantId: TENANT, workspaceId: WORKSPACE }),
    ).toBe(true);
    expect(
      registry.bind("bot-1", {
        tenantId: "tenant-other",
        workspaceId: "team-x",
      }),
    ).toBe(false);
    expect(
      registry.bind("bot-1", { tenantId: TENANT, workspaceId: "team-a2" }),
    ).toBe(false);
  });

  test("the workspace layout is named by ownership, with plain-id segments only", () => {
    expect(
      executionWorkspaceSegments(
        { tenantId: TENANT, workspaceId: WORKSPACE },
        "bot-1",
      ),
    ).toEqual(["tenants", TENANT, "workspaces", WORKSPACE, "bots", "bot-1"]);
  });

  test("log lines carry ownership identifiers, never a token (AC3)", () => {
    const line = describeExecutionScope({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
    });
    expect(line).toContain(TENANT);
    expect(line).toContain(WORKSPACE);
    expect(line).not.toContain("token");
    expect(line).not.toContain("secret");
  });
});

// ---------------------------------------------------------------------------
// 沙箱代理边界：归属头、命名隔离与 scope 级 reset（AC1/AC2/AC3）
// ---------------------------------------------------------------------------

describe("MT050 sandbox boundary carries and enforces the ownership", () => {
  const workspaceDir = `${tmpdir()}/native-runtime-${process.pid}`;
  const env = sandboxEnvFrom({
    SANDBOX_TOKEN: "secret-token",
    SANDBOX_PROVIDER_BASE_URL: "https://example.invalid",
    SANDBOX_PROVIDER_API_KEY: "k",
    SANDBOX_MODEL: "GLM-5.3",
    SANDBOX_WORKSPACE_DIR: workspaceDir,
    SANDBOX_UPSTREAM_PORT_BASE: "4700",
  });
  const runtimes = createBotRuntimes({
    env,
    spawnFn: ((bin: never, args: never, opts: never) => {
      void bin;
      void args;
      void opts;
      return { once: () => {}, kill: () => true };
    }) as never,
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ openapi: "3.1.0" }), {
        status: 200,
      });
    }) as never,
  });
  const handler = createProxyHandler(env, runtimes);
  const call = (path: string, init?: RequestInit) =>
    handler(new Request(`http://127.0.0.1:4300${path}`, init));

  const scopedBotHeaders = {
    "x-sandbox-token": "secret-token",
    "x-openbot-bot-id": "kilo",
    ...scopeHeaders,
  };

  afterAll(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  test("the deployment token alone no longer reaches the sandbox (AC2)", async () => {
    const response = await call("/file?path=a.txt", {
      headers: {
        "x-sandbox-token": "secret-token",
        "x-openbot-bot-id": "kilo",
      },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("ownership");
  });

  test("a correct token with the ownership stated writes inside the scope's own tree (AC1)", async () => {
    const response = await call("/file?path=notes/a.txt", {
      method: "POST",
      headers: scopedBotHeaders,
      body: "hello",
    });
    expect(response.status).toBe(201);
    // 命名即隔离：文件落在 tenants/<t>/workspaces/<w>/bots/<bot> 下。
    const written = join(
      workspaceDir,
      ...executionWorkspaceSegments(
        { tenantId: TENANT, workspaceId: WORKSPACE },
        "kilo",
      ),
      "notes/a.txt",
    );
    expect(await readFile(written, "utf8")).toBe("hello");
    // 回传同一归属（echo headers）。
    expect(response.headers.get(EXECUTION_TENANT_HEADER)).toBe(TENANT);
    expect(response.headers.get(EXECUTION_WORKSPACE_HEADER)).toBe(WORKSPACE);
  });

  test("the deployment-wide default tree is not where scoped files land", async () => {
    const legacy = join(workspaceDir, "bots", "kilo");
    const info = await stat(legacy).catch(() => null);
    expect(info).toBeNull();
  });

  test("a different scope cannot reuse the Bot's workspace: refused, no second tree (AC2)", async () => {
    const response = await call("/file?path=b.txt", {
      method: "POST",
      headers: {
        "x-sandbox-token": "secret-token",
        "x-openbot-bot-id": "kilo",
        ...otherScopeHeaders,
      },
      body: "intruder",
    });
    expect(response.status).toBe(403);
    const intruder = join(
      workspaceDir,
      ...executionWorkspaceSegments(
        { tenantId: "tenant-other", workspaceId: "team-x" },
        "kilo",
      ),
      "b.txt",
    );
    expect(await stat(intruder).catch(() => null)).toBeNull();
  });

  test("reset removes only the owning scope's workspace; a neighbouring scope keeps its files (AC4 native half)", async () => {
    // 在同一部署根下手工种一棵别的 scope 的树（模拟另一公司/团队的 Bot）。
    const foreignDir = join(
      workspaceDir,
      ...executionWorkspaceSegments(
        { tenantId: "tenant-other", workspaceId: "team-x" },
        "lima",
      ),
    );
    await writeFile(join(foreignDir, "keep.txt"), "foreign", {
      flag: "wx",
    }).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(foreignDir, { recursive: true });
      await writeFile(join(foreignDir, "keep.txt"), "foreign");
    });
    const ownDir = join(
      workspaceDir,
      ...executionWorkspaceSegments(
        { tenantId: TENANT, workspaceId: WORKSPACE },
        "kilo",
      ),
    );
    await writeFile(join(ownDir, "mine.txt"), "mine");

    const response = await call("/workspace/reset", {
      method: "POST",
      headers: scopedBotHeaders,
    });
    expect(response.status).toBe(200);
    expect(await stat(join(ownDir, "mine.txt")).catch(() => null)).toBeNull();
    expect(await readFile(join(foreignDir, "keep.txt"), "utf8")).toBe(
      "foreign",
    );
  });

  test("health stays open without ownership — the orchestrator's probe needs no scope", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
  });
});
