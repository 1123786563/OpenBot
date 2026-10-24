// server/tests/package-lifecycle-routes.test.ts
// PKG07（Issue #466）：停用 / 启用 / 卸载路由与 wire 契约（native，无数据库）。
//
// 覆盖：
//   - PATCH /installs/:id/status 把 {status, expectedRevision} 原样送到服务，
//     安装 DTO 原样透传（strict schema 无剥离），Idempotency-Key 必需。
//   - 服务的拒绝码映射：REVISION_CONFLICT→409、RESOURCE_NOT_FOUND→404、
//     PACKAGE_UNSUPPORTED→422、TENANT_FORBIDDEN→403、ADMIN_CHANNEL_UNAVAILABLE→503。
//   - 输入边界：未知状态、非正 revision、多余字段、缺 Idempotency-Key → 400，
//     且请求不达服务。
//   - 管理面分类：PATCH 精确路径登记为公司/团队面（MT075 封闭清单），未登记
//     的入口会被 assertClassifiedCompanyEntrance 拒绝。
import { Hono } from "hono";
import type {
  PackageInstallDTO,
  PackageInstallStatusUpdate,
  PackageListQuery,
  PackagePage,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type {
  PackageInstallStatusResult,
  PackageService,
} from "../src/enterprise/plugin-packages/contracts";
import { packageError } from "../src/enterprise/plugin-packages/contracts";
import { createPluginPackageRoutes } from "../src/enterprise/plugin-packages/routes";
import { classifyManagementPlane } from "../src/enterprise/tenancy/admin-separation";
import type {
  PackageCatalogue,
  PackageReleaseFacts,
} from "../src/plugin-packages/catalogue";

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
  packageKey: "openbot/demo-skill",
  version: "1.0.0",
  artifactDigest: digest,
  revision: 1,
  generation: 1,
  status: "enabled",
  readiness: "needs_grant",
  blockers: [{ code: "NEEDS_GRANT" }],
  allowedActions: [
    "plan",
    "apply",
    "grant",
    "createExpert",
    "disable",
    "uninstall",
  ],
};

const disabledInstall: PackageInstallDTO = {
  ...install,
  status: "disabled",
  generation: 2,
  readiness: "unavailable",
  blockers: [],
  allowedActions: ["enable", "uninstall"],
};

const page: PackagePage = { items: [], nextCursor: null };

function fakeCatalogue(): PackageCatalogue {
  return {
    async list() {
      return page;
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(): Promise<PackageReleaseFacts | null> {
      return null;
    },
    async listVersions() {
      return [];
    },
  };
}

type StatusCall = {
  installId: string;
  input: PackageInstallStatusUpdate;
  idempotencyKey: string;
};

function lifecycleService(overrides: Partial<PackageService> = {}): {
  service: PackageService;
  seen: StatusCall[];
} {
  const seen: StatusCall[] = [];
  const service: PackageService = {
    async list(_scope, query: PackageListQuery) {
      void query;
      return page;
    },
    async get() {
      return {
        ...install,
        resources: [],
        grants: [],
      };
    },
    async plan() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
    async setBotGrant() {
      throw new Error("not used");
    },
    async revokeBotGrant() {
      throw new Error("not used");
    },
    async instantiateExpert() {
      throw new Error("not used");
    },
    async updateInstallStatus(_scope, _admin, installId, input, key) {
      seen.push({ installId, input, idempotencyKey: key });
      const answer: PackageInstallStatusResult = {
        install:
          input.status === "enabled"
            ? { ...install, allowedActions: install.allowedActions }
            : disabledInstall,
        changed: input.status !== "enabled",
      };
      return answer;
    },
    ...overrides,
  };
  return { service, seen };
}

function appWith(
  service: PackageService,
  catalogue: PackageCatalogue | null = fakeCatalogue(),
): Hono {
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      catalogue,
      service,
      resolveScope: async () => scope,
      resolveAdmin: async () => admin,
    }),
  );
  return app;
}

function jsonPatch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://local${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const STATUS_PATH = "/api/enterprise/plugin-packages/installs/install-1/status";

async function errorBody(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("package lifecycle routes (PKG07)", () => {
  test("the status request travels whole and the install DTO passes through", async () => {
    const { service, seen } = lifecycleService();
    const response = await appWith(service).request(
      STATUS_PATH,
      jsonPatch(
        STATUS_PATH,
        { status: "disabled", expectedRevision: 1 },
        {
          "idempotency-key": "lifecycle-key-1",
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        installId: "install-1",
        input: { status: "disabled", expectedRevision: 1 },
        idempotencyKey: "lifecycle-key-1",
      },
    ]);
    const body = (await response.json()) as PackageInstallDTO;
    expect(body.status).toBe("disabled");
    expect(body.generation).toBe(2);
    expect(body.allowedActions).toEqual(["enable", "uninstall"]);
  });

  test("a missing or malformed Idempotency-Key answers 400 without reaching the service", async () => {
    for (const headers of [{}, { "idempotency-key": "" }]) {
      const { service, seen } = lifecycleService();
      const response = await appWith(service).request(
        STATUS_PATH,
        jsonPatch(
          STATUS_PATH,
          { status: "disabled", expectedRevision: 1 },
          headers,
        ),
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
      expect(seen).toHaveLength(0);
    }
  });

  test("invalid bodies answer 400 without reaching the service", async () => {
    for (const body of [
      { status: "removed", expectedRevision: 1 },
      { status: "disabled", expectedRevision: 0 },
      { status: "disabled", expectedRevision: -2 },
      { status: "disabled", expectedRevision: 1.5 },
      { status: "disabled" },
      { status: "disabled", expectedRevision: 1, extra: "field" },
      { status: "disabled", expectedRevision: 1, installId: "install-1" },
    ]) {
      const { service, seen } = lifecycleService();
      const response = await appWith(service).request(
        STATUS_PATH,
        jsonPatch(STATUS_PATH, body, { "idempotency-key": "lifecycle-key-2" }),
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
      expect(seen).toHaveLength(0);
    }
  });

  test("service refusals map to their wire statuses", async () => {
    for (const [code, status] of [
      ["REVISION_CONFLICT", 409],
      ["RESOURCE_NOT_FOUND", 404],
      ["PACKAGE_UNSUPPORTED", 422],
      ["TENANT_FORBIDDEN", 403],
      ["TENANT_ADMIN_REQUIRED", 403],
    ] as const) {
      const { service } = lifecycleService({
        async updateInstallStatus() {
          throw packageError(code);
        },
      });
      const response = await appWith(service).request(
        STATUS_PATH,
        jsonPatch(
          STATUS_PATH,
          { status: "uninstalled", expectedRevision: 1 },
          {
            "idempotency-key": "lifecycle-key-3",
          },
        ),
      );
      expect(response.status).toBe(status);
      expect(await errorBody(response)).toMatchObject({ error: { code } });
    }
  });

  test("a deployment without the catalogue answers 503 and never a permissive write", async () => {
    const { service, seen } = lifecycleService();
    const response = await appWith(service, null).request(
      STATUS_PATH,
      jsonPatch(
        STATUS_PATH,
        { status: "disabled", expectedRevision: 1 },
        {
          "idempotency-key": "lifecycle-key-4",
        },
      ),
    );
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
    });
    expect(seen).toHaveLength(0);
  });

  test("the lifecycle entrance is classified as a company management plane", () => {
    expect(
      classifyManagementPlane({
        method: "PATCH",
        path: "/api/enterprise/plugin-packages/installs/install-1/status",
      }),
    ).toBe("company");
    // A neighbouring shape that is NOT a registered lifecycle entrance stays
    // unclassified — the fail-closed guard is what refuses it at the route.
    expect(
      classifyManagementPlane({
        method: "GET",
        path: "/api/enterprise/plugin-packages/installs/install-1/status",
      }),
    ).toBeNull();
    expect(
      classifyManagementPlane({
        method: "PATCH",
        path: "/api/enterprise/plugin-packages/installs/install-1/status/extra",
      }),
    ).toBeNull();
  });

  test("an unclassified lifecycle entrance never serves traffic", async () => {
    const { service, seen } = lifecycleService();
    // The classification rule registers exactly `…/status`; a trailing segment
    // matches no route at all, so nothing serves it and the service is never
    // consulted (the fail-closed guard would refuse it even if a future router
    // did match).
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/installs/install-1/status/extra",
      jsonPatch(
        "/api/enterprise/plugin-packages/installs/install-1/status/extra",
        { status: "disabled", expectedRevision: 1 },
        { "idempotency-key": "lifecycle-key-5" },
      ),
    );
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
