// server/tests/package-unknown-routes.test.ts
// PKG10（Issue #469）：unknown 核对面路由与 wire 契约（native，无数据库）。
//
// 覆盖：
//   - GET /installs/:id/dispatches 与 GET …/dispatches/:operationId 把服务结果
//     原样透传（拒绝码映射 NOT_AVAILABLE→404 RESOURCE_NOT_FOUND）。
//   - POST …/dispatches/:operationId/verify：verified/unresolved→200；
//     VENDOR_QUERY_PROTOCOL_UNAVAILABLE→422、DISPATCH_NOT_UNKNOWN→409、
//     DISPATCH_ACCOUNT_UNAVAILABLE→409、NOT_AVAILABLE→404——封闭词表正文。
//   - dispatches 面未接线（装配降级）→ 503 PACKAGE_STORAGE_UNAVAILABLE，
//     绝不以空成功列表作答。
//   - scope 每请求经 resolveScope 解析（失权者在此处已被拒绝）。
import { Hono } from "hono";
import type {
  PackageDispatchInspectionDTO,
  PackageDispatchSummaryDTO,
  PackageDispatchVerifyDTO,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type { PackageDispatchService } from "../src/enterprise/plugin-packages/dispatch";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
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

const digest = "b".repeat(64);
const now = "2026-10-25T00:00:00.000Z";

const unknownRow: PackageDispatchSummaryDTO = {
  operationId: "01234567-89ab-4cde-8f01-234567890abc",
  runId: "01234567-89ab-4cde-8f01-234567890abd",
  attemptGeneration: 1,
  toolCallId: "call-1",
  installId: "install-1",
  resourceId: "notes",
  toolRef: "notes:write_note",
  effect: "write",
  state: "unknown",
  receiptRef: { effectStatus: "unknown" },
  errorCode: "DISPATCH_TRANSPORT_ERROR",
  createdAt: now,
  completedAt: now,
};

const inspection: PackageDispatchInspectionDTO = {
  dispatch: unknownRow,
  evidence: {
    connectionId: "conn-1",
    accountHandle: "acct-1",
    connectorInstallId: "connector-1",
    argsDigest: digest,
    connectionGeneration: 1,
  },
  verification: {
    kind: "unknown",
    canQueryVendor: false,
    noAutoResendReason: "NO_VENDOR_QUERY_PROTOCOL",
    relatedReceipts: [],
  },
  recovery: { ready: true },
};

function fakeCatalogue(): PackageCatalogue {
  return {
    async list() {
      return { items: [], nextCursor: null };
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(): Promise<PackageReleaseFacts | null> {
      return null;
    },
  };
}

type SurfaceCall = { installId: string; operationId?: string };

function dispatchSurface(
  behaviour: (
    method: string,
    input: { installId: string; operationId: string },
  ) =>
    | { outcome: "found"; value: unknown }
    | { outcome: "refused"; code: string },
): { dispatches: PackageDispatchService; seen: SurfaceCall[] } {
  const seen: SurfaceCall[] = [];
  const dispatches = {
    async listDispatches(_scope: PlatformScope, input: { installId: string }) {
      seen.push({ installId: input.installId });
      const result = behaviour("list", {
        installId: input.installId,
        operationId: "",
      });
      return result as Awaited<
        ReturnType<PackageDispatchService["listDispatches"]>
      >;
    },
    async inspectDispatch(
      _scope: PlatformScope,
      input: { installId: string; operationId: string },
    ) {
      seen.push(input);
      const result = behaviour("inspect", input);
      return result as Awaited<
        ReturnType<PackageDispatchService["inspectDispatch"]>
      >;
    },
    async verifyDispatch(
      _scope: PlatformScope,
      input: { installId: string; operationId: string },
    ) {
      seen.push(input);
      const result = behaviour("verify", input);
      return result as Awaited<
        ReturnType<PackageDispatchService["verifyDispatch"]>
      >;
    },
  } as unknown as PackageDispatchService;
  return { dispatches, seen };
}

function routes(dispatches: PackageDispatchService | null): {
  app: Hono;
  scopes: PlatformScope[];
} {
  const scopes: PlatformScope[] = [];
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      gate: createMarketplaceGate({
        enabled: true,
        pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
      }),
      catalogue: fakeCatalogue(),
      service: null,
      dispatches: () => dispatches,
      resolveScope: async () => {
        scopes.push(scope);
        return scope;
      },
    }),
  );
  return { app, scopes };
}

describe("PKG10 dispatch ledger routes (native)", () => {
  test("list and inspection pass the service answer through", async () => {
    const { dispatches, seen } = dispatchSurface((method) =>
      method === "list"
        ? { outcome: "found", value: [unknownRow] }
        : { outcome: "found", value: inspection },
    );
    const { app, scopes } = routes(dispatches);
    const listed = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches",
      { headers: { "x-openbot-tenant": "tenant-1" } },
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ dispatches: [unknownRow] });
    expect(seen).toEqual([{ installId: "install-1" }]);
    expect(scopes).toHaveLength(1);

    const inspected = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc",
      { headers: { "x-openbot-tenant": "tenant-1" } },
    );
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toEqual(inspection);
  });

  test("cross-scope refusals answer the closed 404 body", async () => {
    const { dispatches } = dispatchSurface(() => ({
      outcome: "refused",
      code: "NOT_AVAILABLE",
    }));
    const { app } = routes(dispatches);
    for (const path of [
      "/api/enterprise/plugin-packages/installs/install-1/dispatches",
      "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc",
      "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc/verify",
    ]) {
      const response = await app.request(path, {
        method: path.endsWith("/verify") ? "POST" : "GET",
        headers: { "x-openbot-tenant": "tenant-1" },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Package resource not found.",
        },
      });
    }
  });

  test("verify maps each closed refusal to its own status and body", async () => {
    const cases: Array<[string, number, string]> = [
      [
        "VENDOR_QUERY_PROTOCOL_UNAVAILABLE",
        422,
        "No verified vendor query protocol exists for this dispatch; it cannot be auto-verified or resent.",
      ],
      [
        "DISPATCH_NOT_UNKNOWN",
        409,
        "Only a dispatch with an undetermined effect can be verified.",
      ],
      [
        "DISPATCH_ACCOUNT_UNAVAILABLE",
        409,
        "The original account connection is no longer available; verification cannot reach the vendor on it.",
      ],
    ];
    for (const [code, status, message] of cases) {
      const { dispatches } = dispatchSurface(() => ({
        outcome: "refused",
        code,
      }));
      const { app } = routes(dispatches);
      const response = await app.request(
        "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc/verify",
        { method: "POST", headers: { "x-openbot-tenant": "tenant-1" } },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { code, message },
      });
    }
  });

  test("verify passes a settled result through without a body or key", async () => {
    const settled: PackageDispatchVerifyDTO = {
      outcome: "verified",
      dispatch: { ...unknownRow, state: "succeeded" },
    };
    const { dispatches, seen } = dispatchSurface(() => ({
      outcome: "found",
      value: settled,
    }));
    const { app } = routes(dispatches);
    const response = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc/verify",
      { method: "POST", headers: { "x-openbot-tenant": "tenant-1" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(settled);
    expect(seen).toEqual([
      {
        installId: "install-1",
        operationId: "01234567-89ab-4cde-8f01-234567890abc",
      },
    ]);
  });

  test("an unwired dispatch surface answers 503, never an empty list", async () => {
    const { app } = routes(null);
    const listed = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches",
      { headers: { "x-openbot-tenant": "tenant-1" } },
    );
    expect(listed.status).toBe(503);
    expect(await listed.json()).toEqual({
      error: {
        code: "PACKAGE_STORAGE_UNAVAILABLE",
        message: "Package storage is unavailable.",
      },
    });
    const verified = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches/01234567-89ab-4cde-8f01-234567890abc/verify",
      { method: "POST", headers: { "x-openbot-tenant": "tenant-1" } },
    );
    expect(verified.status).toBe(503);
  });
});
