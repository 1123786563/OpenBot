// server/tests/package-upgrade-routes.test.ts
// PKG06（Issue #465）：升级/回滚路由与 wire 契约（native，无数据库）。
//
// 覆盖：
//   - POST /plans operation=upgrade|rollback 连同 expectedRevision 原样到达
//     服务；响应携带 diff 的 plan DTO 原样透传（strict schema 无剥离）。
//   - 服务的拒绝码映射：REVISION_CONFLICT→409、RESOURCE_NOT_FOUND→404、
//     PACKAGE_UNSUPPORTED→422、PLAN_EXPIRED→410、PLAN_CHANGED→409。
//   - apply 的 200/201 语义（升级不新建安装 → 200）。
//   - 安装详情 GET 透传 latestPublishedVersion/availableVersions。
//   - 输入边界：非法 operation、非正 expectedRevision、多余字段 → 400。
import { Hono } from "hono";
import type {
  PackageInstallDetailDTO,
  PackageInstallDTO,
  PackageListQuery,
  PackagePage,
  PackagePlanDTO,
  PackagePlanInput,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type { PackageService } from "../src/enterprise/plugin-packages/contracts";
import { packageError } from "../src/enterprise/plugin-packages/contracts";
import { createPluginPackageRoutes } from "../src/enterprise/plugin-packages/routes";
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
const digestV2 = "b".repeat(64);

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
  allowedActions: ["plan", "apply", "grant", "createExpert"],
};

const detail: PackageInstallDetailDTO = {
  ...install,
  resources: [{ id: "summarize", kind: "skill", available: true }],
  grants: [],
  latestPublishedVersion: "2.0.0",
  availableVersions: [
    { version: "2.0.0", artifactDigest: digestV2 },
    { version: "1.0.0", artifactDigest: digest },
  ],
};

const upgradePlan: PackagePlanDTO = {
  planId: "plan-up-1",
  operation: "upgrade",
  packageKey: "openbot/demo-skill",
  version: "2.0.0",
  artifactDigest: digestV2,
  expectedRevision: 1,
  expiresAt: "2026-10-25T00:10:00.000Z",
  resources: [{ id: "summarize", kind: "skill" }],
  addedTools: [{ ref: "crm:lookup", effect: "write", schemaDigest: digestV2 }],
  removedTools: ["crm:purge"],
  blockers: [],
  diff: {
    currentVersion: "1.0.0",
    currentRevision: 1,
    addedResources: [{ id: "fresh-guide", kind: "skill" }],
    removedResources: [{ id: "legacy-note", kind: "skill" }],
    changedTools: [
      {
        ref: "crm:lookup",
        previousEffect: "read",
        effect: "write",
        previousSchemaDigest: digest,
        schemaDigest: digestV2,
      },
    ],
    configChanges: [{ key: "region", change: "changed" }],
    connectionChanges: [{ resourceId: "crm2", change: "added" }],
  },
};

const upgradeInput: PackagePlanInput = {
  operation: "upgrade",
  packageKey: "openbot/demo-skill",
  version: "2.0.0",
  expectedRevision: 1,
  config: { region: "eu" },
  connectorInstalls: {},
};

const page: PackagePage = {
  items: [],
  nextCursor: null,
};

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

function upgradeService(overrides: Partial<PackageService> = {}): {
  service: PackageService;
  seen: PackagePlanInput[];
} {
  const seen: PackagePlanInput[] = [];
  const service: PackageService = {
    async list(resolved, query: PackageListQuery) {
      void resolved;
      void query;
      return page;
    },
    async get() {
      return detail;
    },
    async plan(resolved, adminContext, input) {
      void resolved;
      void adminContext;
      seen.push(input);
      return upgradePlan;
    },
    async apply() {
      // An upgrade never creates the install: 200, not 201.
      return { install, created: false };
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
    ...overrides,
  };
  return { service, seen };
}

function appWith(service: PackageService): Hono {
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      catalogue: fakeCatalogue(),
      service,
      resolveScope: async () => scope,
      resolveAdmin: async () => admin,
    }),
  );
  return app;
}

function jsonPost(path: string, body: unknown, headers = {}) {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function errorBody(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("package upgrade routes (PKG06)", () => {
  test("an upgrade plan travels whole: operation, revision, diff body", async () => {
    const { service, seen } = upgradeService();
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/plans",
      jsonPost("/api/enterprise/plugin-packages/plans", upgradeInput),
    );
    expect(response.status).toBe(200);
    expect(seen[0]).toEqual(upgradeInput);
    const body = (await response.json()) as PackagePlanDTO;
    expect(body.operation).toBe("upgrade");
    expect(body.expectedRevision).toBe(1);
    expect(body.diff?.changedTools[0]).toMatchObject({
      ref: "crm:lookup",
      previousEffect: "read",
      effect: "write",
    });
    expect(body.diff?.configChanges).toEqual([
      { key: "region", change: "changed" },
    ]);
  });

  test("a rollback plan reaches the service and its DTO passes through", async () => {
    const { service, seen } = upgradeService();
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/plans",
      jsonPost("/api/enterprise/plugin-packages/plans", {
        ...upgradeInput,
        operation: "rollback",
        version: "1.0.0",
      }),
    );
    expect(response.status).toBe(200);
    expect(seen[0]?.operation).toBe("rollback");
    expect(seen[0]?.expectedRevision).toBe(1);
  });

  test("invalid plan inputs answer 400 without reaching the service", async () => {
    for (const body of [
      { ...upgradeInput, operation: "reinstall" },
      { ...upgradeInput, expectedRevision: 0 },
      { ...upgradeInput, expectedRevision: -1 },
      { ...upgradeInput, extra: "field" },
      { ...upgradeInput, version: "latest" },
    ]) {
      const { service, seen } = upgradeService();
      const response = await appWith(service).request(
        "/api/enterprise/plugin-packages/plans",
        jsonPost("/api/enterprise/plugin-packages/plans", body),
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
      ["PLAN_CHANGED", 409],
    ] as const) {
      const { service } = upgradeService({
        async plan() {
          throw packageError(code);
        },
      });
      const response = await appWith(service).request(
        "/api/enterprise/plugin-packages/plans",
        jsonPost("/api/enterprise/plugin-packages/plans", upgradeInput),
      );
      expect(response.status).toBe(status);
      expect(await errorBody(response)).toMatchObject({
        error: { code },
      });
    }
  });

  test("apply answers 200 for an upgrade (the install already exists)", async () => {
    const { service } = upgradeService();
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/plans/plan-up-1/apply",
      jsonPost(
        "/api/enterprise/plugin-packages/plans/plan-up-1/apply",
        {},
        { "idempotency-key": "upgrade-key-1" },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PackageInstallDTO;
    expect(body.version).toBe("1.0.0");
  });

  test("an expired upgrade plan answers 410 at apply", async () => {
    const { service } = upgradeService({
      async apply() {
        throw packageError("PLAN_EXPIRED");
      },
    });
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/plans/plan-up-1/apply",
      jsonPost(
        "/api/enterprise/plugin-packages/plans/plan-up-1/apply",
        {},
        { "idempotency-key": "upgrade-key-2" },
      ),
    );
    expect(response.status).toBe(410);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "PLAN_EXPIRED" },
    });
  });

  test("the install detail carries the published-version facts", async () => {
    const { service } = upgradeService();
    const response = await appWith(service).request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PackageInstallDetailDTO;
    expect(body.latestPublishedVersion).toBe("2.0.0");
    expect(body.availableVersions).toEqual([
      { version: "2.0.0", artifactDigest: digestV2 },
      { version: "1.0.0", artifactDigest: digest },
    ]);
    expect(body.allowedActions).toEqual([
      "plan",
      "apply",
      "grant",
      "createExpert",
    ]);
  });
});
