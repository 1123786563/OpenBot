// server/tests/package-gating-matrix.test.ts
// PKG11（Issue #470，Spec §12.4 + A09）：开关矩阵套件——三种部署姿态
// （默认关 / 开+在试点 / 开+不在试点）× 全部路由面，一张表钉死"哪个入口
// 受开关管、哪个不受"。这张表就是 operations-notes 回退一节的执行依据：
// 关闭开关只关"安装/升级/授权"三个写入口，读取、台账、核对、撤权、
// 生命周期与专家实例化全部照常——既有包 Run 的治理不随开关暂停。
//
// native 套件；与 package-gating.test.ts 的分工：那边是配置解析与单点
// 语义，这边是"姿态 × 面"的全矩阵回归，任何后续新增路由落到这张表上
// 时必须先声明它归哪一类。

import { Hono } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type {
  PackageInstallDTO,
  PackagePage,
  PackagePlanDTO,
} from "../shared/enterprise/plugin-package-contracts";
import type { PlatformScope } from "../src/enterprise/contracts";
import type { PackageService } from "../src/enterprise/plugin-packages/contracts";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
import { createPluginPackageRoutes } from "../src/enterprise/plugin-packages/routes";
import type { PackageCatalogue } from "../src/plugin-packages/catalogue";

const scope: PlatformScope = {
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  principalId: "principal-1",
  actorId: "actor-1",
  memberEpoch: 3,
  aclEpoch: 1,
  entrypoint: "web",
};

const admin = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  actorId: "actor-1",
  memberEpoch: 3,
};

const digest = "a".repeat(64);

const install: PackageInstallDTO = {
  installId: "install-1",
  packageKey: "openbot/legacy-catalogue",
  version: "1.0.0",
  artifactDigest: digest,
  revision: 1,
  generation: 1,
  status: "enabled",
  readiness: "ready",
  blockers: [],
  allowedActions: [],
};

const page: PackagePage = {
  items: [
    {
      packageKey: "openbot/legacy-catalogue",
      version: "1.0.0",
      displayName: "OpenBot 内置目录",
      summary: "s",
      category: "builtin",
      install,
      installable: true,
      blockers: [],
    },
  ],
  nextCursor: null,
};

const planDTO: PackagePlanDTO = {
  planId: "plan-1",
  operation: "install",
  packageKey: "openbot/legacy-catalogue",
  version: "1.0.0",
  artifactDigest: digest,
  expectedRevision: null,
  expiresAt: "2026-10-25T00:10:00.000Z",
  resources: [{ id: "code-review", kind: "skill" }],
  addedTools: [],
  removedTools: [],
  blockers: [],
};

/** Every service method succeeds, so "served" is distinguishable from 503. */
function allGoodService(): { service: PackageService; calls: Set<string> } {
  const calls = new Set<string>();
  const detail = {
    ...install,
    resources: [{ id: "code-review", kind: "skill", available: true }],
    grants: [],
  };
  const service = {
    async list() {
      calls.add("list");
      return page;
    },
    async get() {
      calls.add("get");
      return detail;
    },
    async plan() {
      calls.add("plan");
      return planDTO;
    },
    async apply() {
      calls.add("apply");
      return { install, created: true };
    },
    async setBotGrant() {
      calls.add("setBotGrant");
      return { grant: { ...install, botId: "bot-1" }, created: true };
    },
    async revokeBotGrant() {
      calls.add("revokeBotGrant");
      return { grant: { ...install, botId: "bot-1" }, created: false };
    },
    async instantiateExpert() {
      calls.add("instantiateExpert");
      return {
        expert: {
          agentId: "agent-new",
          installId: "install-1",
          packageKey: "openbot/legacy-catalogue",
          version: "1.0.0",
          resourceId: "fullstack-engineer",
          expertTemplateRef: "openbot/legacy-catalogue/fullstack-engineer",
          displayName: "全栈开发专家",
          grantRevision: 1,
          resources: [{ resourceId: "code-review", kind: "skill" }],
        },
        created: true,
      };
    },
    async updateInstallStatus() {
      calls.add("updateInstallStatus");
      return { install, changed: true };
    },
  } as unknown as PackageService;
  return { service, calls };
}

function appFor(gate: ReturnType<typeof createMarketplaceGate>): {
  app: Hono;
  calls: Set<string>;
} {
  const { service, calls } = allGoodService();
  const catalogue = {
    async list() {
      return page;
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease() {
      return null;
    },
  } as unknown as PackageCatalogue;
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      gate,
      catalogue,
      service,
      dispatches: () =>
        ({
          listDispatches: async () => {
            calls.add("listDispatches");
            return { outcome: "ok", value: [] };
          },
          inspectDispatch: async () => {
            calls.add("inspectDispatch");
            return { outcome: "refused", code: "RESOURCE_NOT_FOUND" };
          },
          verifyDispatch: async () => {
            calls.add("verifyDispatch");
            return {
              outcome: "refused",
              code: "VENDOR_QUERY_PROTOCOL_UNAVAILABLE",
            };
          },
        }) as never,
      resolveScope: async () => scope,
      resolveAdmin: async () => admin,
    }),
  );
  return { app, calls };
}

type Surface = {
  readonly name: string;
  readonly call: (app: Hono) => Promise<Response>;
  /** Which service seam proves the request was served. */
  readonly servedSeam: string;
  /** Install/upgrade entries + new grants are the gated family. */
  readonly gated: boolean;
};

const planBody = {
  operation: "install",
  packageKey: "openbot/legacy-catalogue",
  version: "1.0.0",
  expectedRevision: null,
  config: {},
  connectorInstalls: {},
};

const upgradeBody = {
  ...planBody,
  operation: "upgrade" as const,
  expectedRevision: 1,
};

const SURFACES: readonly Surface[] = [
  {
    name: "GET / (browse)",
    call: (app) => app.request("/api/enterprise/plugin-packages"),
    servedSeam: "list",
    gated: false,
  },
  {
    name: "GET /installs/:id (install detail)",
    call: (app) =>
      app.request("/api/enterprise/plugin-packages/installs/install-1"),
    servedSeam: "get",
    gated: false,
  },
  {
    name: "GET /installs/:id/dispatches (ledger)",
    call: (app) =>
      app.request(
        "/api/enterprise/plugin-packages/installs/install-1/dispatches",
      ),
    servedSeam: "listDispatches",
    gated: false,
  },
  {
    name: "POST …/dispatches/:op/verify (unknown verification)",
    call: (app) =>
      app.request(
        "/api/enterprise/plugin-packages/installs/install-1/dispatches/op-1/verify",
        { method: "POST" },
      ),
    servedSeam: "verifyDispatch",
    gated: false,
  },
  {
    name: "POST /plans (install)",
    call: (app) =>
      app.request("/api/enterprise/plugin-packages/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(planBody),
      }),
    servedSeam: "plan",
    gated: true,
  },
  {
    name: "POST /plans (upgrade)",
    call: (app) =>
      app.request("/api/enterprise/plugin-packages/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(upgradeBody),
      }),
    servedSeam: "plan",
    gated: true,
  },
  {
    name: "POST /plans/:id/apply",
    call: (app) =>
      app.request("/api/enterprise/plugin-packages/plans/plan-1/apply", {
        method: "POST",
        headers: { "idempotency-key": "matrix-key-1" },
      }),
    servedSeam: "apply",
    gated: true,
  },
  {
    name: "PUT …/bots/:botId/grants (new grant)",
    call: (app) =>
      app.request(
        "/api/enterprise/plugin-packages/installs/install-1/bots/bot-1/grants",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "matrix-key-1",
          },
          body: JSON.stringify({
            installId: "install-1",
            botId: "bot-1",
            expectedGrantRevision: null,
            resources: [{ resourceId: "code-review", kind: "skill" }],
          }),
        },
      ),
    servedSeam: "setBotGrant",
    gated: true,
  },
  {
    name: "DELETE …/bots/:botId/grants (revoke)",
    call: (app) =>
      app.request(
        "/api/enterprise/plugin-packages/installs/install-1/bots/bot-1/grants",
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "matrix-key-1",
          },
          body: "{}",
        },
      ),
    servedSeam: "revokeBotGrant",
    gated: false,
  },
  {
    name: "PATCH /installs/:id/status (disable/uninstall)",
    call: (app) =>
      app.request("/api/enterprise/plugin-packages/installs/install-1/status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "matrix-key-1",
        },
        body: JSON.stringify({ status: "disabled", expectedRevision: 1 }),
      }),
    servedSeam: "updateInstallStatus",
    gated: false,
  },
  {
    name: "POST …/experts/:resourceId (instantiate from installed)",
    call: (app) =>
      app.request(
        "/api/enterprise/plugin-packages/installs/install-1/experts/fullstack-engineer",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "matrix-key-1",
          },
          body: JSON.stringify({
            installId: "install-1",
            resourceId: "fullstack-engineer",
            expectedRevision: 1,
            name: "全栈开发专家",
          }),
        },
      ),
    servedSeam: "instantiateExpert",
    gated: false,
  },
];

const POSTURES = [
  {
    name: "default off (enabled=false)",
    gate: createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
  },
  {
    name: "enabled, scope in pilot",
    gate: createMarketplaceGate({
      enabled: true,
      pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
    }),
  },
  {
    name: "enabled, scope NOT in pilot",
    gate: createMarketplaceGate({
      enabled: true,
      pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "elsewhere" }],
    }),
  },
] as const;

describe("PKG11: gate × surface matrix", () => {
  for (const posture of POSTURES) {
    for (const surface of SURFACES) {
      test(`${posture.name} — ${surface.name}`, async () => {
        const { app, calls } = appFor(posture.gate);
        const response = await surface.call(app);
        const body = (await response.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        if (posture.gate.entryOpenFor(scope) || !surface.gated) {
          // Served: the seam ran and nothing said MARKETPLACE_ENTRY_DISABLED.
          expect(response.status).not.toBe(503);
          expect(calls.has(surface.servedSeam)).toBe(true);
        } else {
          expect(response.status).toBe(503);
          expect(body.error?.code).toBe("MARKETPLACE_ENTRY_DISABLED");
          expect(calls.has(surface.servedSeam)).toBe(false);
        }
      });
    }
  }

  test("the matrix itself: exactly the install/upgrade/grant family is gated", () => {
    const gated = SURFACES.filter((surface) => surface.gated).map(
      (s) => s.name,
    );
    expect(gated).toEqual([
      "POST /plans (install)",
      "POST /plans (upgrade)",
      "POST /plans/:id/apply",
      "PUT …/bots/:botId/grants (new grant)",
    ]);
  });
});
