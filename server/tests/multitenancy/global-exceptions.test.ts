// server/tests/multitenancy/global-exceptions.test.ts
// MT030（Issue #73）：全局身份、刷新锁与例外端点显式登记。
//
// 四条验收（票面）：
//   AC1 例外清单是显式登记而非默认放行；未登记端点一律要求归属上下文。
//   AC2 刷新锁在多公司用户下仍正确串行化，不会因范围不同而互相覆盖或死锁。
//   AC3 readiness 校验例外项都有理由与责任人；新增未登记的全局端点会导致启动失败。
//   AC4 全局端点不返回任何公司私有内容。
//
// 登记表（GLOBAL_EXCEPTION_ENTRIES）是 MT128 例外登记闭合要消费的登记面：
// 本票负责让它显式、有理由、有责任人，并与启动校验（readiness）闭环。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import {
  buildInventory,
  type CoverageInventory,
  type EntranceEntry,
} from "../../scripts/multitenancy/inventory";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import {
  evaluateGlobalExceptionRegistry,
  GLOBAL_EXCEPTION_ENTRIES,
  matchGlobalException,
} from "../../src/enterprise/tenancy/global-exceptions";
import {
  applyStartupVerdict,
  type MultitenancyStartupRecord,
  runMultitenancyStartupChecks,
} from "../../src/enterprise/tenancy/startup-checks";
import {
  createProviderOAuthProxy,
  type ModelOAuthRecord,
  mountProviderOAuthProxy,
} from "../../src/provider-oauth";
import { testEnvironment } from "../support/environment";

const SERVER_ROOT = resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// AC1 — 例外清单是显式登记而非默认放行
// ---------------------------------------------------------------------------

describe("MT030 例外登记表：显式、封闭、每条带理由与责任人", () => {
  test("登记表非空且每条形状完整：id 唯一、方法大写、模式以 / 开头、理由/责任人/内容边界非空", () => {
    expect(GLOBAL_EXCEPTION_ENTRIES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const entry of GLOBAL_EXCEPTION_ENTRIES) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.methods.length).toBeGreaterThan(0);
      for (const method of entry.methods) {
        expect(method).toBe(method.toUpperCase());
      }
      expect(entry.pattern.startsWith("/")).toBe(true);
      // 理由与责任人必须显式存在——空串/纯空白都算缺失（AC3 前半）。
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.ownerTicket.trim().length).toBeGreaterThan(0);
      expect(entry.contentBoundary.trim().length).toBeGreaterThan(0);
      expect(["none", "session", "machine"]).toContain(entry.context);
      expect(["always", "conditional"]).toContain(entry.surface);
    }
  });

  test("票面点名的三类全局面都在册：登录（auth）、健康检查（health/ready）、平台静态目录", () => {
    const ids = new Set(GLOBAL_EXCEPTION_ENTRIES.map((entry) => entry.id));
    for (const required of [
      "auth",
      "health",
      "readiness",
      "capabilities",
      "web-bot-auth-directory",
      "app-static",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  test("matchGlobalException：在册端点命中登记项，未登记端点一律 null（要求归属上下文）", () => {
    // 在册：健康检查与就绪探针（方法也必须匹配）。
    expect(matchGlobalException("GET", "/health")?.id).toBe("health");
    expect(matchGlobalException("DELETE", "/health")).toBeNull();
    // /healthz 不是登记端点；真实部署里非 /api 的 GET 由静态兜底接住
    // （SPA fallback）——匹配器如实归入 app-static，而不是谎报 health。
    expect(matchGlobalException("GET", "/healthz")?.id).toBe("app-static");
    expect(matchGlobalException("GET", "/ready")?.id).toBe("readiness");
    // 在册：登录/会话面（/api/auth/* 含 scim 子路径）。
    expect(matchGlobalException("GET", "/api/auth/get-session")?.id).toBe(
      "auth",
    );
    expect(matchGlobalException("POST", "/api/auth/sign-in/email")?.id).toBe(
      "auth",
    );
    expect(matchGlobalException("DELETE", "/api/auth/scim/v1/x")?.id).toBe(
      "auth",
    );
    // 在册：认证前投影与静态目录。
    expect(matchGlobalException("GET", "/api/capabilities")?.id).toBe(
      "capabilities",
    );
    expect(matchGlobalException("POST", "/api/capabilities")).toBeNull();
    expect(
      matchGlobalException(
        "GET",
        "/.well-known/http-message-signatures-directory",
      )?.id,
    ).toBe("web-bot-auth-directory");
    // 在册：全局身份面（会话认证，不填公司归属）。
    expect(matchGlobalException("GET", "/api/me")?.id).toBe("me");
    expect(matchGlobalException("POST", "/api/me/onboarding")?.id).toBe("me");
    expect(
      matchGlobalException("PATCH", "/api/settings/preferences/ui")?.id,
    ).toBe("settings-preferences");
    expect(matchGlobalException("GET", "/api/settings/instructions")?.id).toBe(
      "settings-instructions",
    );
    expect(matchGlobalException("GET", "/api/identity/links")?.id).toBe(
      "identity",
    );
    expect(matchGlobalException("DELETE", "/api/identity/links/abc")?.id).toBe(
      "identity",
    );
    // 在册：机器身份面（桌面宿主令牌 / 本地 bearer）。
    expect(
      matchGlobalException("GET", "/api/desktop/connection-failure")?.id,
    ).toBe("desktop-connection-failure");
    expect(
      matchGlobalException("POST", "/api/model-provider/v1/chat/completions")
        ?.id,
    ).toBe("provider-oauth-proxy");
    expect(
      matchGlobalException("GET", "/api/model-provider/v1/chat/completions"),
    ).toBeNull();
    expect(
      matchGlobalException("GET", "/api/host-access/desktop/next")?.id,
    ).toBe("host-access-desktop");
    expect(
      matchGlobalException("POST", "/api/host-access/desktop/result")?.id,
    ).toBe("host-access-desktop");
  });

  test("静态兜底不吞掉 API：/api 未匹配路径返回 null（要求归属上下文），SPA 路径返回静态项", () => {
    expect(matchGlobalException("GET", "/api/nonexistent")).toBeNull();
    expect(matchGlobalException("GET", "/api")).toBeNull();
    expect(matchGlobalException("GET", "/workspaces/some-deep-link")?.id).toBe(
      "app-static",
    );
  });

  test("特异性：具体登记项优先于静态兜底（/health 归 health，不归 app-static）", () => {
    expect(matchGlobalException("GET", "/health")?.id).toBe("health");
    expect(matchGlobalException("GET", "/api/me")?.id).toBe("me");
  });

  test("业务端点样本一律不在册——登记是显式例外，不是默认放行", () => {
    for (const [method, path] of [
      ["GET", "/api/agents"],
      ["GET", "/api/bots"],
      ["GET", "/api/channels"],
      ["POST", "/api/knowledge"],
      ["GET", "/api/memory"],
      ["GET", "/api/billing/orders"],
      ["GET", "/api/enterprise/conversations"],
      ["GET", "/api/enterprise/workspace-scope"],
      ["DELETE", "/api/attachments/x"],
    ] as const) {
      expect(matchGlobalException(method, path)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — 刷新锁在多公司用户下仍正确串行化
// ---------------------------------------------------------------------------

// provider-oauth 的刷新锁语义：合并键 = 凭据记录的全局会话身份
// （record.sessionId），与任何公司/团队选择无关；跨进程是同一凭据文件上的
// flock；持久化是 CAS（sessionId/refreshToken 变了就拒绝写）。
// 多公司用户共享同一桌面模型凭据记录：若锁键被多租户改造加上归属（scope），
// 同一会话的两个范围会各自刷新同一 refresh_token——供应商轮换后必有一方失效。

function modelRecord(
  overrides: Partial<ModelOAuthRecord> = {},
): ModelOAuthRecord {
  return {
    version: 1,
    sessionId: "model-sign-in-session",
    provider: "google",
    clientId: "desktop-client",
    clientSecret: "desktop-client-secret",
    accessToken: "provider-access-token",
    refreshToken: "provider-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    scope: "model-scope",
    quotaProject: "google-quota-project",
    proxyToken: "local-proxy-token",
    ...overrides,
  };
}

async function proxyFixture(
  current: ModelOAuthRecord,
  handler: (request: Request) => Response | Promise<Response>,
) {
  const root = await mkdtemp(join(tmpdir(), "mt030-refresh-lock-"));
  const file = join(root, "model-oauth.json");
  await writeFile(file, JSON.stringify(current), { mode: 0o600 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handler,
  });
  const app = new Hono();
  mountProviderOAuthProxy(
    app,
    createProviderOAuthProxy(file, {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return fetch(new URL(url.pathname, server.url), init);
      },
    }),
  );
  return {
    app,
    file,
    readFile: async () => JSON.parse(await readFile(file, "utf8")),
    cleanup: async () => {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
    // scope 模拟同一名多公司用户在两个公司范围下发出的请求：代理只认本地
    // bearer，范围头按设计被无视——合并键必须不因它而分叉。
    ask: (scope: string, token: string | null = current.proxyToken) =>
      app.request("/api/model-provider/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-test-scope": scope,
          cookie: `openbot-tenant-selection=${scope}`,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ model: "chosen-model", messages: [] }),
      }),
  };
}

describe("MT030 刷新锁：全局会话身份串行化，范围不分叉、陈旧写不覆盖", () => {
  test("同一凭据记录下，公司 A 与公司 B 范围的并发请求只触发一次供应商刷新（无死锁、无双轮换）", async () => {
    let refreshes = 0;
    const f = await proxyFixture(
      modelRecord({ expiresAt: 1 }),
      async (request) => {
        if (new URL(request.url).pathname === "/token") {
          refreshes += 1;
          const body = new URLSearchParams(await request.text());
          expect(body.get("refresh_token")).toBe("provider-refresh-token");
          await Bun.sleep(20);
          return Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          });
        }
        expect(request.headers.get("authorization")).toBe(
          "Bearer rotated-access",
        );
        return Response.json({ choices: [] });
      },
    );
    try {
      const [companyA, companyB] = await Promise.all([
        f.ask("company-a"),
        f.ask("company-b"),
      ]);
      expect(companyA.status).toBe(200);
      expect(companyB.status).toBe(200);
      expect(refreshes).toBe(1);
      const saved = await f.readFile();
      expect(saved.accessToken).toBe("rotated-access");
      expect(saved.refreshToken).toBe("rotated-refresh");
      expect(saved.sessionId).toBe("model-sign-in-session");
    } finally {
      await f.cleanup();
    }
  });

  test("跨范围陈旧写不覆盖：刷新在途时换成新登录，旧范围的刷新被拒且文件保持新登录；新范围随即正常", async () => {
    let began!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const f = await proxyFixture(modelRecord({ expiresAt: 1 }), async () => {
      began();
      await release;
      return Response.json({
        access_token: "stale-scope-rotated-access",
        refresh_token: "stale-scope-rotated-refresh",
        expires_in: 3600,
      });
    });
    try {
      const staleScopeRefresh = f.ask("company-a");
      await started;
      const replacement = modelRecord({
        sessionId: "new-sign-in-session",
        proxyToken: "new-local-token",
        refreshToken: "new-sign-in-refresh",
        accessToken: "new-sign-in-access",
      });
      await writeFile(f.file, JSON.stringify(replacement), { mode: 0o600 });
      finish();
      // 旧范围（company-a）的在途刷新被 CAS 拒绝：不能覆盖新登录的凭据。
      expect((await staleScopeRefresh).status).toBe(401);
      expect(await f.readFile()).toEqual(replacement);
      // 新范围（company-b）用新登录的 bearer 正常转发，不受旧范围刷新污染。
      const okResponse = await f.ask("company-b", "new-local-token");
      expect(okResponse.status).toBe(200);
    } finally {
      await f.cleanup();
    }
  });

  test("刷新锁不带多租户归属：provider-oauth 两文件零 enterprise 引用、零 tenant/workspace 词元，合并键仍是记录会话身份", () => {
    for (const relative of [
      "src/provider-oauth.ts",
      "src/provider-oauth-lock.ts",
    ]) {
      const source = readFileSync(join(SERVER_ROOT, relative), "utf8");
      expect(source.includes("enterprise/")).toBe(false);
      expect(/tenant/i.test(source)).toBe(false);
      expect(/workspace/i.test(source)).toBe(false);
    }
    const proxySource = readFileSync(
      join(SERVER_ROOT, "src/provider-oauth.ts"),
      "utf8",
    );
    // 合并键派生自凭据记录的全局会话身份，而不是请求范围。
    expect(proxySource).toContain("refreshes.get(previous.sessionId)");
    expect(proxySource).toContain("refreshes.set(previous.sessionId");
    // CAS：会话或刷新令牌变了就拒绝持久化（陈旧写者防线）。
    expect(proxySource).toContain("current.sessionId !== previous.sessionId");
    expect(
      proxySource.includes("current.refreshToken !== previous.refreshToken"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — readiness 校验例外项；新增未登记全局端点导致启动失败
// ---------------------------------------------------------------------------

// 与 inventory.test.ts 同款：只有开发库变量也绝不回退，TEST_DATABASE_URL
// 缺席即显式跳过数据库阶段——本票的登记面检查不需要数据库。
const NO_DATABASE: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
};

const realInventory = await buildInventory({ environment: NO_DATABASE });

describe("MT030 readiness：例外登记表与真实装配互相闭合", () => {
  test("登记表对真实装配成立：无幽灵项、平台/身份闭包的路由入口全部在册", () => {
    const evaluation = evaluateGlobalExceptionRegistry({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      entrances: realInventory.entrances,
    });
    expect(evaluation.findings).toEqual([]);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.registered.length).toBe(GLOBAL_EXCEPTION_ENTRIES.length);
  });

  test("登记表每条都锚定真实装配中至少一个路由入口（防幽灵/防过期，含条件装配面）", () => {
    const rows = realInventory.entrances.filter((row) => row.kind === "route");
    for (const entry of GLOBAL_EXCEPTION_ENTRIES) {
      const anchors = rows.filter(
        (row) =>
          entry.methods.includes(row.method) &&
          matchGlobalException(row.method, row.path)?.id === entry.id,
      );
      expect(anchors.length).toBeGreaterThan(0);
    }
  });

  test("新增未登记的平台/身份全局端点 → 拒绝并列出该入口", () => {
    for (const closure of ["platform", "identity"] as const) {
      const path = `/api/brand-new-global-${closure}`;
      const withNewGlobal: readonly EntranceEntry[] = [
        ...realInventory.entrances,
        {
          ...realInventory.entrances[0],
          id: `GET ${path}`,
          entrance: `GET ${path}`,
          method: "GET",
          path,
          kind: "route",
          businessClosure: closure,
        },
      ];
      const evaluation = evaluateGlobalExceptionRegistry({
        entries: GLOBAL_EXCEPTION_ENTRIES,
        entrances: withNewGlobal,
      });
      expect(evaluation.ok).toBe(false);
      const finding = evaluation.findings.find(
        (candidate) => candidate.code === "UNREGISTERED_GLOBAL",
      );
      expect(finding).toBeDefined();
      expect(finding?.detail).toContain(path);
    }
  });

  test("中间件行（catchall）不是端点，不要求登记", () => {
    const middlewareOnly = realInventory.entrances
      .filter((row) => row.kind === "catchall")
      .slice(0, 5);
    expect(middlewareOnly.length).toBeGreaterThan(0);
    const evaluation = evaluateGlobalExceptionRegistry({
      entries: GLOBAL_EXCEPTION_ENTRIES,
      entrances: middlewareOnly,
    });
    expect(evaluation.ok).toBe(true);
  });

  test("例外项缺失理由或责任人 → 拒绝（readiness 前半条验收）", () => {
    for (const broken of [
      { ...GLOBAL_EXCEPTION_ENTRIES[0], reason: "   " },
      { ...GLOBAL_EXCEPTION_ENTRIES[0], id: "broken", ownerTicket: "" },
      { ...GLOBAL_EXCEPTION_ENTRIES[0], id: "broken-2", contentBoundary: "" },
      { ...GLOBAL_EXCEPTION_ENTRIES[0], id: "broken-3", methods: [] },
    ]) {
      const evaluation = evaluateGlobalExceptionRegistry({
        entries: [broken],
        entrances: realInventory.entrances,
      });
      expect(evaluation.ok).toBe(false);
      expect(
        evaluation.findings.some(
          (candidate) => candidate.code === "ENTRY_INVALID",
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 启动校验编排：globalExceptions 是第四道启动门
// ---------------------------------------------------------------------------

function fixtureEntrance(
  overrides: Partial<EntranceEntry> = {},
): EntranceEntry {
  return {
    id: "GET /api/fixture",
    entrance: "GET /api/fixture",
    method: "GET",
    path: "/api/fixture",
    kind: "route",
    type: "http",
    businessClosure: "agents",
    ownerTicket: "MT000",
    status: "owned",
    registration: "always",
    registeredIn: ["deployment-full"],
    registrations: 1,
    ...overrides,
  };
}

function fixtureInventory(
  entrances: readonly EntranceEntry[],
): CoverageInventory {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-17T00:00:00.000Z",
    digest: "a".repeat(64),
    assemblies: [
      {
        name: "deployment-full",
        entrance: "src/index.ts",
        status: "assembled",
        routeEntries: entrances.length,
      },
    ],
    entrances,
    backgroundPrograms: [],
    serviceSurfaces: [],
    dataTables: [],
    externalDependencies: [],
    unmappedConfigKeys: [],
    stages: [],
    summary: {
      totalEntrances: entrances.length,
      routeEntrances: entrances.length,
      catchallEntrances: 0,
      unownedEntrances: 0,
      unclassifiedEntrances: 0,
      serveUpgradeBranches: 2,
      serveUpgradeEntrances: 2,
      dataTables: 0,
      backgroundPrograms: 0,
      serviceSurfaces: 0,
      externalDependencies: 0,
      byClosure: {},
    },
  } as unknown as CoverageInventory;
}

describe("MT030 启动编排：globalExceptions 是第四道启动门", () => {
  const inventoryDeps = (payload: unknown) => ({
    readTextFile: async (path: string) =>
      path.endsWith("inventory.json") ? JSON.stringify(payload) : "{}",
  });

  test("业务清单（无平台/身份全局端点）→ globalExceptions 通过且列出登记项", async () => {
    const record: MultitenancyStartupRecord =
      await runMultitenancyStartupChecks(
        { inventoryPath: "/cfg/inventory.json", singleUser: false },
        inventoryDeps(fixtureInventory([fixtureEntrance()])),
      );
    expect(record.checks.globalExceptions.ok).toBe(true);
    if (record.checks.globalExceptions.ok) {
      expect(record.checks.globalExceptions.registered).toEqual(
        GLOBAL_EXCEPTION_ENTRIES.map((entry) => entry.id),
      );
    }
  });

  test("清单含未登记平台全局端点 → globalExceptions 拒绝，coverage 照常评估", async () => {
    const record = await runMultitenancyStartupChecks(
      { inventoryPath: "/cfg/inventory.json", singleUser: false },
      inventoryDeps(
        fixtureInventory([
          fixtureEntrance({
            id: "GET /api/brand-new-global",
            entrance: "GET /api/brand-new-global",
            path: "/api/brand-new-global",
            businessClosure: "platform",
          }),
        ]),
      ),
    );
    expect(record.checks.coverage.ok).toBe(true);
    expect(record.checks.globalExceptions.ok).toBe(false);
    if (!record.checks.globalExceptions.ok) {
      expect(record.checks.globalExceptions.findings).toHaveLength(1);
      expect(record.checks.globalExceptions.findings[0].code).toBe(
        "UNREGISTERED_GLOBAL",
      );
      expect(record.checks.globalExceptions.findings[0].detail).toContain(
        "/api/brand-new-global",
      );
    }
  });

  test("清单文件缺失 → globalExceptions 与 coverage 各自带理由拒绝（不冒充通过）", async () => {
    const record = await runMultitenancyStartupChecks(
      { inventoryPath: "/cfg/inventory.json", singleUser: false },
      {
        readTextFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(record.checks.coverage.ok).toBe(false);
    expect(record.checks.globalExceptions.ok).toBe(false);
    if (!record.checks.globalExceptions.ok) {
      expect(record.checks.globalExceptions.reason).toContain("inventory");
    }
  });

  // 端到端启动语义：其余三门全绿时，仅 globalExceptions 缺口也必须 exit(1)。
  // 需要真实受限角色库探测（MT013 同款）；缺专用环境时显式跳过并说明理由。
  const hasDedicatedDatabase = Boolean(
    process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL?.trim() ||
      process.env.TEST_DATABASE_URL?.trim(),
  );
  test.skipIf(!hasDedicatedDatabase)(
    "仅 globalExceptions 缺口 → applyStartupVerdict 以非零退出拒绝启动（缺专用测试库环境时跳过：需真实受限角色库探测，skipped 不计通过）",
    async () => {
      const {
        enterpriseRuntimeDatabaseUrlFrom,
        enterpriseTestDatabaseUrlFrom,
      } = await import("../support/enterprise-database");
      const record = await runMultitenancyStartupChecks(
        {
          inventoryPath: "/cfg/inventory.json",
          directoryUrl: enterpriseRuntimeDatabaseUrlFrom(
            "directory",
            process.env,
          ),
          dataUrl: enterpriseRuntimeDatabaseUrlFrom("data", process.env),
          tenantRuntimeUrl: enterpriseTestDatabaseUrlFrom(process.env),
          singleUser: false,
        },
        inventoryDeps(
          fixtureInventory([
            fixtureEntrance({
              id: "GET /api/brand-new-global",
              entrance: "GET /api/brand-new-global",
              path: "/api/brand-new-global",
              businessClosure: "platform",
            }),
          ]),
        ),
      );
      expect(record.checks.coverage.ok).toBe(true);
      expect(record.checks.devBypass.ok).toBe(true);
      expect(record.checks.databaseRoles.ok).toBe(true);
      expect(record.checks.globalExceptions.ok).toBe(false);
      let exitCode: number | undefined;
      let logged = 0;
      applyStartupVerdict(record, {
        log: {
          info: () => {
            logged += 1;
          },
        },
        exit: (code) => {
          exitCode = code;
        },
      });
      expect(exitCode).toBe(1);
      expect(logged).toBe(1);
    },
  );
});

// ---------------------------------------------------------------------------
// AC4 — 全局端点不返回任何公司私有内容
// ---------------------------------------------------------------------------

const SESSION = {
  user: {
    id: "person",
    email: "person@openbot.test",
    name: "Person",
    image: null,
  },
};

/** 与 identity-app-wiring 同款装配缝：真实 createApp + 假 auth 会话。 */
function appFor(
  options: { session?: typeof SESSION | null; readinessOk?: boolean } = {},
) {
  const session = options.session === undefined ? SESSION : options.session;
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => session },
  };
  args[2] = { rolesForUser: async () => ["user"] };
  const OPEN_MUSE_SEAMS_ARG = 45;
  args[OPEN_MUSE_SEAMS_ARG] = {
    ...(options.readinessOk ? { readinessProbe: async () => {} } : {}),
  };
  return createApp(...(args as never[]));
}

describe("MT030 全局端点内容边界：零公司私有内容", () => {
  test("/health 只回答进程存活（{status}），无任何其他字段", async () => {
    const response = await appFor().request("http://openbot.test/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["status"]);
    expect(body.status).toBe("ok");
  });

  test("/ready 只回答部署可用性（{status, database}），无任何其他字段", async () => {
    const up = await appFor({ readinessOk: true }).request(
      "http://openbot.test/ready",
    );
    expect(up.status).toBe(200);
    const upBody = (await up.json()) as Record<string, unknown>;
    expect(Object.keys(upBody).sort()).toEqual(["database", "status"]);
    const down = await appFor().request("http://openbot.test/ready");
    expect(down.status).toBe(503);
    const downBody = (await down.json()) as Record<string, unknown>;
    expect(Object.keys(downBody).sort()).toEqual(["database", "status"]);
  });

  test("/api/capabilities 只回答部署级能力旗标（显式字段名单），无公司/用户数据", async () => {
    const response = await appFor().request(
      "http://openbot.test/api/capabilities",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "authProviders",
        "billing",
        "durableHistory",
        "generativeUi",
        "mode",
        "selfHostBanner",
        "ssoConfigured",
        "ssoRequired",
        "transcription",
        "voice",
      ].sort(),
    );
    // 认证前可见：任何公司/租户/团队形态的字段都不允许出现。
    const serialized = JSON.stringify(body).toLowerCase();
    for (const banned of ["tenant", "workspace", "company", "membership"]) {
      expect(serialized.includes(banned)).toBe(false);
    }
  });

  test("/api/me（会话内）只回答自己的全局身份行 + onboarding + singleUser，无公司内容", async () => {
    const response = await appFor().request("http://openbot.test/api/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
      singleUser: boolean;
    };
    expect(Object.keys(body).sort()).toEqual(["singleUser", "user"]);
    expect(Object.keys(body.user).sort()).toEqual(
      ["email", "id", "image", "name", "onboarding", "role"].sort(),
    );
    expect(body.user.id).toBe("person");
    const serialized = JSON.stringify(body).toLowerCase();
    for (const banned of ["tenant", "workspace", "membership"]) {
      expect(serialized.includes(banned)).toBe(false);
    }
  });

  test("全局身份端点缺会话时只回 401 错误形状——无内容、无存在性泄露", async () => {
    const anonymous = appFor({ session: null });
    for (const path of [
      "/api/me",
      "/api/identity/providers",
      "/api/settings/instructions",
    ]) {
      const response = await anonymous.request(`http://openbot.test${path}`);
      expect(response.status).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
    }
  });
});
