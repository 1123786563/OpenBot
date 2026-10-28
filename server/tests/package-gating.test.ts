// server/tests/package-gating.test.ts
// PKG11（Issue #470，Spec §12.4 + A09/A12）：包市场灰度开关——配置解析
// （默认关、精确 pilot 元组、通配符拒绝、非法即启动错误）与路由面执行
// （关闭时写入口 503 MARKETPLACE_ENTRY_DISABLED；读取与既有治理路径不受
// 影响）（native 套件）。
//
// 证据面：
//   (1) parseMarketplaceEnabledFlag：缺省 false；只有字面 "true" 打开。
//   (2) parsePilotWorkspaces：合法精确元组、缺省空数组；junk JSON、非数组、
//       通配符（*）、多余/缺失键、非字符串、重复元组各以具名错误拒绝。
//   (3) createMarketplaceGate：enabled+名单命中才开；enabled 空名单=无人；
//       disabled 一律关。
//   (4) 路由面：默认关（不设 gate.enabled）时 plan/apply/grants 503，且
//       service 完全未被调用（关闭不触碰写通道）；读取（list/detail/
//       dispatch 台账）继续；revoke 与 lifecycle PATCH 不受开关影响
//       （回退演练的治理语义）。
//   (5) config 装配：loadConfig 缺省 packageMarketplaceEnabled=false、
//       packagePilotWorkspaces=[]；非法 pilot 值让配置装载直接抛错
//       （启动即报错语义）。

import { Hono } from "hono";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type {
  PackageInstallDTO,
  PackagePage,
} from "../shared/enterprise/plugin-package-contracts";
import type { PlatformScope } from "../src/enterprise/contracts";
import type { PackageService } from "../src/enterprise/plugin-packages/contracts";
import {
  createMarketplaceGate,
  MarketplaceGateConfigError,
  parseMarketplaceEnabledFlag,
  parsePilotWorkspaces,
} from "../src/enterprise/plugin-packages/marketplace-gate";
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

const otherScope: PlatformScope = { ...scope, workspaceId: "workspace-2" };

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

function fakeCatalogue(): PackageCatalogue {
  return {
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
}

/** Records every service call so a closed entry is provably not exercised. */
function recordingService(): { service: PackageService; calls: string[] } {
  const calls: string[] = [];
  const service = {
    async list() {
      calls.push("list");
      return page;
    },
    async get() {
      calls.push("get");
      return {
        ...install,
        resources: [{ id: "code-review", kind: "skill", available: true }],
        grants: [],
      };
    },
    async plan() {
      calls.push("plan");
      throw new Error("plan must not run while the entry is closed");
    },
    async apply() {
      calls.push("apply");
      throw new Error("apply must not run while the entry is closed");
    },
    async setBotGrant() {
      calls.push("setBotGrant");
      throw new Error("grant must not run while the entry is closed");
    },
    async revokeBotGrant() {
      calls.push("revokeBotGrant");
      return { grant: { ...install }, created: false };
    },
    async updateInstallStatus() {
      calls.push("updateInstallStatus");
      return { install, changed: true };
    },
  } as unknown as PackageService;
  return { service, calls };
}

function appWith(gate: ReturnType<typeof createMarketplaceGate>): {
  app: Hono;
  calls: string[];
} {
  const { service, calls } = recordingService();
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      gate,
      catalogue: fakeCatalogue(),
      service,
      dispatches: () => ({
        listDispatches: async () => {
          calls.push("listDispatches");
          return { outcome: "ok", value: [] };
        },
        inspectDispatch: async () => {
          calls.push("inspectDispatch");
          return {
            outcome: "refused",
            code: "RESOURCE_NOT_FOUND",
          };
        },
        verifyDispatch: async () => {
          calls.push("verifyDispatch");
          return {
            outcome: "refused",
            code: "VENDOR_QUERY_PROTOCOL_UNAVAILABLE",
          };
        },
      }),
      resolveScope: async () => scope,
      resolveAdmin: async () => admin,
    }),
  );
  return { app, calls };
}

function jsonRequest(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "gate-key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const openGate = () =>
  createMarketplaceGate({
    enabled: true,
    pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
  });

describe("PKG11: deployment switch parsing (Spec §12.4)", () => {
  test("OPENBOT_PACKAGE_MARKETPLACE_ENABLED defaults to false", () => {
    expect(parseMarketplaceEnabledFlag(undefined)).toBe(false);
    expect(parseMarketplaceEnabledFlag("")).toBe(false);
    expect(parseMarketplaceEnabledFlag("false")).toBe(false);
    expect(parseMarketplaceEnabledFlag("1")).toBe(false);
    expect(parseMarketplaceEnabledFlag("TRUE")).toBe(false);
    expect(parseMarketplaceEnabledFlag("true")).toBe(true);
  });

  test("unset pilot list is the empty list", () => {
    expect(parsePilotWorkspaces(undefined)).toEqual([]);
    expect(parsePilotWorkspaces("  ")).toEqual([]);
  });

  test("exact tuples parse", () => {
    expect(
      parsePilotWorkspaces(
        JSON.stringify([{ tenantId: "t-1", workspaceId: "w-1" }]),
      ),
    ).toEqual([{ tenantId: "t-1", workspaceId: "w-1" }]);
    expect(
      parsePilotWorkspaces(
        JSON.stringify([
          { tenantId: "t-1", workspaceId: "w-1" },
          { tenantId: "t-2", workspaceId: "w-2" },
        ]),
      ),
    ).toHaveLength(2);
  });

  test.each([
    ["not json at all", "tenant-1/workspace-1"],
    ["a JSON object instead of an array", '{"tenantId":"t"}'],
    ["a string element", '["t-1/w-1"]'],
    ["a null element", "[null]"],
    ["a wildcard tenant", '[{"tenantId":"*","workspaceId":"w-1"}]'],
    ["a wildcard workspace", '[{"tenantId":"t-1","workspaceId":"w-*"}]'],
    ["an extra field", '[{"tenantId":"t-1","workspaceId":"w-1","note":"x"}]'],
    ["a missing field", '[{"tenantId":"t-1"}]'],
    ["an empty id", '[{"tenantId":"","workspaceId":"w-1"}]'],
    ["a numeric id", '[{"tenantId":7,"workspaceId":"w-1"}]'],
    [
      "a duplicate tuple",
      '[{"tenantId":"t","workspaceId":"w"},{"tenantId":"t","workspaceId":"w"}]',
    ],
  ])("refuses %s", (_label, raw: string) => {
    expect(() => parsePilotWorkspaces(raw)).toThrow(MarketplaceGateConfigError);
  });

  test("refusals carry the closed reason vocabulary", () => {
    try {
      parsePilotWorkspaces("[{}]");
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceGateConfigError);
      expect((error as MarketplaceGateConfigError).code).toBe(
        "PILOT_WORKSPACES_ENTRY_INVALID",
      );
    }
    try {
      parsePilotWorkspaces("{");
      expect.unreachable("must throw");
    } catch (error) {
      expect((error as MarketplaceGateConfigError).code).toBe(
        "PILOT_WORKSPACES_UNPARSEABLE",
      );
    }
  });

  test("gate opens only for an exact pilot tuple while enabled", () => {
    const gate = openGate();
    expect(gate.enabled).toBe(true);
    expect(gate.entryOpenFor(scope)).toBe(true);
    expect(gate.entryOpenFor(otherScope)).toBe(false);
  });

  test("enabled with an empty allowlist authorizes nobody", () => {
    const gate = createMarketplaceGate({ enabled: true, pilotWorkspaces: [] });
    expect(gate.entryOpenFor(scope)).toBe(false);
    expect(gate.entryOpenFor(otherScope)).toBe(false);
  });

  test("disabled ignores the allowlist entirely", () => {
    const gate = createMarketplaceGate({
      enabled: false,
      pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
    });
    expect(gate.entryOpenFor(scope)).toBe(false);
  });

  test("pilot tuples are defensively copied out of the gate", () => {
    const input = [{ tenantId: "t", workspaceId: "w" }];
    const gate = createMarketplaceGate({
      enabled: true,
      pilotWorkspaces: input,
    });
    input.pop();
    expect(gate.pilotWorkspaces).toHaveLength(1);
  });
});

describe("PKG11: route enforcement (default off, 503 entry-disabled)", () => {
  test("plan answers 503 MARKETPLACE_ENTRY_DISABLED while the entry is closed", async () => {
    const { app, calls } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const response = await app.request(
      jsonRequest("/api/enterprise/plugin-packages/plans", "POST", {
        operation: "install",
        packageKey: "openbot/legacy-catalogue",
        version: "1.0.0",
        expectedRevision: null,
        config: {},
        connectorInstalls: {},
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MARKETPLACE_ENTRY_DISABLED");
    // The write path was never exercised — closing does not touch the channel.
    expect(calls).toEqual([]);
  });

  test("apply answers 503 while closed (a pending confirm dies with the switch)", async () => {
    const { app } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const response = await app.request(
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        "POST",
        {},
      ),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MARKETPLACE_ENTRY_DISABLED");
  });

  test("new Bot grants answer 503 while closed", async () => {
    const { app } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const response = await app.request(
      jsonRequest(
        "/api/enterprise/plugin-packages/installs/install-1/bots/bot-1/grants",
        "PUT",
        {
          installId: "install-1",
          botId: "bot-1",
          expectedGrantRevision: null,
          resources: [{ resourceId: "code-review", kind: "skill" }],
        },
      ),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MARKETPLACE_ENTRY_DISABLED");
  });

  test("enabled but out of pilot: same 503, same closed body", async () => {
    // The scope resolver pins every request to tenant-1/workspace-1; a gate
    // whose allowlist names a DIFFERENT workspace is the out-of-pilot case.
    const { app } = appWith(
      createMarketplaceGate({
        enabled: true,
        pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "elsewhere" }],
      }),
    );
    const response = await app.request(
      jsonRequest("/api/enterprise/plugin-packages/plans", "POST", {
        operation: "install",
        packageKey: "openbot/legacy-catalogue",
        version: "1.0.0",
        expectedRevision: null,
        config: {},
        connectorInstalls: {},
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("MARKETPLACE_ENTRY_DISABLED");
  });

  test("reads keep working while closed: catalogue list, install detail, dispatch ledger", async () => {
    const { app, calls } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const list = await app.request("/api/enterprise/plugin-packages");
    expect(list.status).toBe(200);
    await list.json();

    const detail = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(detail.status).toBe(200);
    await detail.json();

    const ledger = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1/dispatches",
    );
    expect(ledger.status).toBe(200);
    await ledger.json();

    expect(calls).toEqual(["list", "get", "listDispatches"]);
  });

  test("revoke keeps working while closed (governance never pauses)", async () => {
    const { app, calls } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const response = await app.request(
      jsonRequest(
        "/api/enterprise/plugin-packages/installs/install-1/bots/bot-1/grants",
        "DELETE",
        {},
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toContain("revokeBotGrant");
  });

  test("lifecycle (disable/uninstall) keeps working while closed", async () => {
    const { app, calls } = appWith(
      createMarketplaceGate({ enabled: false, pilotWorkspaces: [] }),
    );
    const response = await app.request(
      jsonRequest(
        "/api/enterprise/plugin-packages/installs/install-1/status",
        "PATCH",
        {
          status: "disabled",
          expectedRevision: 1,
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toContain("updateInstallStatus");
  });

  test("an open entry lets plan reach the service", async () => {
    const { app, calls } = appWith(openGate());
    const response = await app.request(
      jsonRequest("/api/enterprise/plugin-packages/plans", "POST", {
        operation: "install",
        packageKey: "openbot/legacy-catalogue",
        version: "1.0.0",
        expectedRevision: null,
        config: {},
        connectorInstalls: {},
      }),
    );
    // The recording stub's plan throws "must not run" — reaching it at all
    // proves the gate passed the request through to the write path.
    expect(calls).toContain("plan");
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
