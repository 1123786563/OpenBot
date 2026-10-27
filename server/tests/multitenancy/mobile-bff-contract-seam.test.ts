import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  AgentActor,
  AgentProfile,
  AgentProfileStore,
} from "../../src/agents/public";
import type {
  AppVariables,
  AuthenticatedActor,
} from "../../src/auth/public";
import type { ChannelStore } from "../../src/channels/public";
import * as botSource from "../../src/mobile-bff/openmuse-bot";
import {
  OPENMUSE_TEMPLATE_KEY,
  OPENMUSE_TEMPLATE_VERSION,
  isUniqueViolation,
  openMuseTemplateV1,
} from "../../src/mobile-bff/public";
import { createMobileBffRoutes } from "../../src/mobile-bff/routes";
import { createMobileBffWorkspace } from "../../src/mobile-bff/workspace";
import type {
  OpenMuseTaskStep,
  OpenMuseTaskStore,
  StoredOpenMuseTask,
} from "../../src/openmuse-tasks/public";
import type * as taskSource from "../../src/openmuse-tasks/store";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseOwnerDisabledError,
  OpenMuseVendorUnavailableError,
} from "../../src/openmuse-connectors/google-oauth";
import { OpenMuseFileQuotaError } from "../../src/openmuse-files/store";
import { OpenMuseMailVendorError } from "../../src/openmuse-mail/client";

/**
 * MOD21（#641）mobile-bff 合同缝套件：把验收①–⑤的既有事实钉在测试里。
 * 每组的对象是“合同不变”，不是重新实现：行为钉走 Hono request()，事实钉
 * 走源码扫描（源扫描与文本耦合是刻意的——合同锚就是那些行）。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

/** 从模块源文本提取全部 `export [type] { … } from "…"` 的导出名单（排序）。 */
function reExportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:type\s+)?\{([^}]+)\}\s+from/g,
  )) {
    for (let name of match[1].split(",")) {
      name = name.trim().replace(/^type\s+/, "");
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** 按花括号配对截取 marker 起的函数体（源扫描钉的范围限定）。 */
function functionBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

/** 类型同一性（双向可赋值）——public 出口的类型 re-export 与源同绑定的编译期钉。 */
type Identical<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ---------------------------------------------------------------------------
// D1 出口等价：恰符号 re-export，与源同绑定
// ---------------------------------------------------------------------------

describe("D1 public exits re-export exactly the consumed symbols", () => {
  test("openmuse-tasks/public.ts exports exactly the three task types", () => {
    expect(reExportedNames(read("server/src/openmuse-tasks/public.ts"))).toEqual(
      ["OpenMuseTaskStep", "OpenMuseTaskStore", "StoredOpenMuseTask"],
    );
  });

  test("mobile-bff/public.ts exports exactly the seven provisioner symbols", () => {
    expect(reExportedNames(read("server/src/mobile-bff/public.ts"))).toEqual([
      "OPENMUSE_TEMPLATE_KEY",
      "OPENMUSE_TEMPLATE_VERSION",
      "OpenMuseTemplateStore",
      "OpenMuseTemplateV1",
      "StoredTemplateProfile",
      "isUniqueViolation",
      "openMuseTemplateV1",
    ]);
  });

  test("channels/routines public.ts export exactly their consumed types", () => {
    expect(reExportedNames(read("server/src/channels/public.ts"))).toEqual([
      "AgentChannel",
      "ChannelStore",
    ]);
    expect(reExportedNames(read("server/src/routines/public.ts"))).toEqual([
      "RoutineStore",
    ]);
  });

  test("value re-exports bind to the source module's own bindings", () => {
    expect(OPENMUSE_TEMPLATE_KEY).toBe(botSource.OPENMUSE_TEMPLATE_KEY);
    expect(OPENMUSE_TEMPLATE_VERSION).toBe(botSource.OPENMUSE_TEMPLATE_VERSION);
    expect(openMuseTemplateV1).toBe(botSource.openMuseTemplateV1);
    expect(isUniqueViolation).toBe(botSource.isUniqueViolation);
  });

  test("type re-exports are identical to the source types (compile-time)", () => {
    const taskStore: Identical<OpenMuseTaskStore, taskSource.OpenMuseTaskStore> =
      true;
    const taskStep: Identical<OpenMuseTaskStep, taskSource.OpenMuseTaskStep> =
      true;
    const stored: Identical<
      StoredOpenMuseTask,
      taskSource.StoredOpenMuseTask
    > = true;
    expect([taskStore, taskStep, stored]).toEqual([true, true, true]);
  });

  test("the three owner facades expose the consumed types", () => {
    const agents = reExportedNames(read("server/src/agents/public.ts"));
    for (const name of ["AgentActor", "AgentProfile", "AgentProfileStore"]) {
      expect(agents).toContain(name);
    }
    const auth = reExportedNames(read("server/src/auth/public.ts"));
    for (const name of ["AppVariables", "AuthenticatedActor"]) {
      expect(auth).toContain(name);
    }
    expect(
      reExportedNames(read("server/src/approvals/public.ts")),
    ).toContain("ApprovalService");
  });
});

// ---------------------------------------------------------------------------
// D2 验收①：BFF workspace 投影面 = roster + channels，聚合子查询独立 scope
// ---------------------------------------------------------------------------

const actor: AuthenticatedActor = {
  id: "user-1",
  email: "mobile@openbot.test",
  role: "user",
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "Knowledge",
    title: "Research",
    roleDescription: "Finds answers.",
    avatarSeed: "knowledge",
    visibility: "public",
    ownerUserId: null,
    systemOwned: true,
    hidden: false,
    pinned: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("D2 acceptance ① the workspace projection stays roster+channels", () => {
  test("read() answers the mobile subsets, never the full store rows", async () => {
    const agentsStore = {
      async list() {
        return [
          profile(),
          profile({ id: "bot-hidden", name: "Hidden", hidden: true }),
          profile({
            id: "bot-gone",
            name: "Gone",
            deletedAt: new Date("2026-01-01T00:00:00Z"),
          }),
        ];
      },
    } as unknown as AgentProfileStore;
    const channelStore = {
      async list(_actor: AgentActor) {
        return {
          channels: [
            {
              id: "channel-1",
              name: "Knowledge",
              agentIds: ["bot-1"],
              threadId: "thread-1",
              lastMessageAt: new Date("2026-02-01T00:00:00Z"),
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as ChannelStore;
    const answer = await createMobileBffWorkspace({
      agentProfileStore: agentsStore,
      channelStore,
    }).read({ id: "user-1", role: "user" });

    expect(Object.keys(answer).sort()).toEqual([
      "agents",
      "archivedNextCursor",
      "channels",
      "user",
    ]);
    expect(answer.user).toEqual({ id: "user-1", role: "user" });
    // 只见 roster 五字段：hasAuth/ownerUserId 等管理面不出手机屏。
    expect(answer.agents).toHaveLength(1);
    expect(Object.keys(answer.agents[0]).sort()).toEqual([
      "avatarSeed",
      "id",
      "name",
      "title",
      "visibility",
    ]);
    expect(Object.keys(answer.channels[0]).sort()).toEqual([
      "agentIds",
      "archivedAt",
      "id",
      "lastMessageAt",
      "name",
      "threadId",
    ]);
    expect(answer.channels[0].lastMessageAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("the workspace seam never touches enterprise workspace types", () => {
    expect(
      /enterprise|PlatformScope|workspaceMembership/i.test(
        read("server/src/mobile-bff/workspace.ts"),
      ),
    ).toBe(false);
  });

  test("readMobileAggregate re-verifies per call: trusted scope, fresh transaction, scoped subqueries", () => {
    const body = functionBody(
      read("server/src/enterprise/tenancy/openmuse-voice-mobile-tenancy.ts"),
      "async readMobileAggregate",
    );
    expect(body).not.toBe("");
    expect(body).toContain("assertTrustedScope(scope)");
    expect(body).toContain("data.transaction(");
    expect(body).toContain("if (!facts.companyActive)");
    // 三个子查询各自按 scope 三元组过滤——租户/工作区/主体一次不缺。
    for (const field of ["tenantId", "workspaceId", "principalId"]) {
      const hits = body.split(`scope.${field}`).length - 1;
      expect(hits).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// D3 验收②：scope 信任锚 = 服务端 WeakSet 签发 + assertTrustedScope，零 token 自证
// ---------------------------------------------------------------------------

describe("D3 acceptance ② the scope trust anchor stays server-issued", () => {
  test("a scope nobody issued is refused before any query runs", () => {
    expect(() =>
      assertTrustedScope({ tenantId: "t" } as never),
    ).toThrow("UNVERIFIED_SCOPE");
  });

  test("the anchor is a WeakSet signer, not a token check", () => {
    const store = read("server/src/enterprise/tenancy/store.ts");
    expect(store).toContain("const issuedScopes = new WeakSet<object>();");
    expect(store).toContain("issuedScopes.has(scope)");
    expect(store).toContain('"UNVERIFIED_SCOPE"');
  });

  test("no token self-attestation anywhere in the BFF family", () => {
    const files = [
      "server/src/mobile-bff/public.ts",
      "server/src/mobile-bff/routes.ts",
      "server/src/mobile-bff/workspace.ts",
      "server/src/mobile-bff/activity.ts",
      "server/src/mobile-bff/openmuse-bot.ts",
      "server/src/enterprise/tenancy/openmuse-voice-mobile-tenancy.ts",
    ];
    const selfAttestation =
      /bearer|jwt|access[_-]?token|id[_-]?token|header\(\s*["']authorization/i;
    for (const file of files) {
      expect(selfAttestation.test(read(file))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// D4 验收③：onError 语义锚 413/409/403/502/503 + code 保留；G01 回调合同
// ---------------------------------------------------------------------------

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function bffWithThrowingRoute(makeError: () => Error) {
  const files = new Hono<{ Variables: AppVariables }>();
  files.get("/boom", () => {
    throw makeError();
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMobileBffRoutes({
      requireUser,
      workspace: createMobileBffWorkspace({}),
      openMuseFiles: files,
    }),
  );
  return app;
}

describe("D4 acceptance ③ the onError semantic anchors survive the mount", () => {
  test("409 + code connection_required", async () => {
    const response = await bffWithThrowingRoute(
      () => new OpenMuseConnectionRefusedError("Connect Gmail first."),
    ).request("/openmuse-files/boom");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Connect Gmail first.",
      code: "connection_required",
    });
  });

  test("403 for a disabled owner, including a foreign class with the same name", async () => {
    const own = await bffWithThrowingRoute(
      () => new OpenMuseOwnerDisabledError("user-1"),
    ).request("/openmuse-files/boom");
    expect(own.status).toBe(403);
    const foreign = new Error("disabled elsewhere");
    foreign.name = "OpenMuseOwnerDisabledError";
    const other = await bffWithThrowingRoute(() => foreign).request(
      "/openmuse-files/boom",
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({
      error: "This owner's files are unavailable.",
    });
  });

  test("413 keeps the store's stable code; 502/503 keep their vendor answers", async () => {
    const quota = await bffWithThrowingRoute(
      () => new OpenMuseFileQuotaError(1024),
    ).request("/openmuse-files/boom");
    expect(quota.status).toBe(413);
    expect(await quota.json()).toEqual({
      error:
        "That upload would pass this owner's 1024-byte Files quota. Delete some files first.",
      code: "openmuse_file_quota_exceeded",
    });
    const mail = await bffWithThrowingRoute(
      () => new OpenMuseMailVendorError("Gmail exploded."),
    ).request("/openmuse-files/boom");
    expect(mail.status).toBe(502);
    const vendor = await bffWithThrowingRoute(
      () => new OpenMuseVendorUnavailableError(),
    ).request("/openmuse-files/boom");
    expect(vendor.status).toBe(503);
  });

  test("a sub-app's own HTTPException passes through; zod answers 400; the rest 503", async () => {
    const passthrough = await bffWithThrowingRoute(
      () => new HTTPException(429),
    ).request("/openmuse-files/boom");
    expect(passthrough.status).toBe(429);
    const invalid = await bffWithThrowingRoute(
      () => new SyntaxError("{"),
    ).request("/openmuse-files/boom");
    expect(invalid.status).toBe(400);
    const unknown = await bffWithThrowingRoute(
      () => new Error("boom"),
    ).request("/openmuse-files/boom");
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toEqual({
      error: "The mobile workspace is unavailable. Try again.",
    });
  });

  test("G01: the Google callback mounts publicly only where the assembly built it", () => {
    const http = read("server/src/assembly/http.ts");
    expect(
      /if \(openMuseGoogleOAuth\) \{\s*app\.route\("\/api\/mobile\/openmuse-google", openMuseGoogleOAuth\.app\);\s*app\.route\("\/api\/public\/openmuse-google", openMuseGoogleOAuth\.callback\);\s*\}/.test(
        http,
      ),
    ).toBe(true);
    expect(http).toContain("deliberately NOT behind requireUser");
  });
});

// ---------------------------------------------------------------------------
// D5 验收④⑤：BA 企业 PKCE/handle 零补做；apps/openmuse 空子模块现状
// ---------------------------------------------------------------------------

describe("D5 acceptance ④⑤ no BA PKCE/handle work; the submodule stays un-cloned", () => {
  test("zero enterprise PKCE / org-handle surface in the BFF family", () => {
    const baSurface =
      /pkce|code[-_]?challenge|code[-_]?verifier|enterprise[-_]?handle|org[-_]?handle/i;
    for (const file of readdirSync(join(REPO_ROOT, "server/src/mobile-bff"))) {
      if (!file.endsWith(".ts")) continue;
      expect(baSurface.test(read(`server/src/mobile-bff/${file}`))).toBe(false);
    }
  });

  test("apps/openmuse stays a registered-but-uncloned submodule", () => {
    const gitmodules = read(".gitmodules");
    expect(gitmodules).toContain('[submodule "apps/openmuse"]');
    const listing = execFileSync("git", ["ls-files", "-s", "apps/openmuse"], {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim();
    // 160000 = gitlink：登记在库、内容未克隆（空目录）。
    expect(listing.startsWith("160000 ")).toBe(true);
    expect(readdirSync(join(REPO_ROOT, "apps/openmuse"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D6 改道等价：mobile-bff 四文件零内件直取
// ---------------------------------------------------------------------------

describe("D6 the four mobile-bff files import cross-module only via public exits", () => {
  const FILES = [
    "server/src/mobile-bff/routes.ts",
    "server/src/mobile-bff/workspace.ts",
    "server/src/mobile-bff/activity.ts",
    "server/src/mobile-bff/openmuse-bot.ts",
  ];

  test("no import names an owner module's internals", () => {
    const internalImport =
      /from "\.\.\/(?:agents\/profile-store|agents\/profile-types|auth\/guards|channels\/routes|approvals\/service|routines\/store|openmuse-tasks\/store|mobile-bff\/openmuse-bot)"/;
    for (const file of FILES) {
      expect(internalImport.test(read(file))).toBe(false);
    }
  });

  test("each redirected consumer names its public exits", () => {
    const expectImports: Record<string, string[]> = {
      "server/src/mobile-bff/routes.ts": [
        '../agents/public',
        '../auth/public',
        '../channels/public',
      ],
      "server/src/mobile-bff/workspace.ts": [
        '../agents/public',
        '../channels/public',
      ],
      "server/src/mobile-bff/activity.ts": [
        '../agents/public',
        '../approvals/public',
        '../routines/public',
      ],
      "server/src/mobile-bff/openmuse-bot.ts": [
        '../agents/public',
        '../auth/public',
      ],
    };
    for (const [file, exits] of Object.entries(expectImports)) {
      const source = read(file);
      for (const exit of exits) {
        expect(source).toContain(`from "${exit}"`);
      }
    }
  });

  test("the B consumers also go through the OPENMUSE public exits", () => {
    expect(read("server/src/agents/openmuse-template-store.ts")).toContain(
      'from "../mobile-bff/public"',
    );
    expect(
      read("server/src/enterprise/tenancy/openmuse-task-tenancy.ts"),
    ).toContain('from "../../openmuse-tasks/public"');
    expect(read("server/src/mastra/openmuse-task-entry.ts")).toContain(
      'from "../openmuse-tasks/public"',
    );
  });
});
