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
import type {
  PackageInstallFacts,
  PackageReadStore,
  PackageService,
} from "../src/enterprise/plugin-packages/contracts";
import {
  PackageServiceError,
  packageError,
} from "../src/enterprise/plugin-packages/contracts";
import { createPackageService } from "../src/enterprise/plugin-packages/install-service";
import {
  createPluginPackageRoutes,
  createUnavailablePluginPackageRoutes,
} from "../src/enterprise/plugin-packages/routes";
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
  allowedActions: [],
};

const detail: PackageInstallDetailDTO = {
  ...install,
  resources: [{ id: "summarize", kind: "skill", available: true }],
  grants: [],
};

const planDTO: PackagePlanDTO = {
  planId: "plan-1",
  operation: "install",
  packageKey: "openbot/demo-skill",
  version: "1.0.0",
  artifactDigest: digest,
  expectedRevision: null,
  expiresAt: "2026-10-20T00:10:00.000Z",
  resources: [{ id: "summarize", kind: "skill" }],
  addedTools: [],
  removedTools: [],
  blockers: [],
};

const page: PackagePage = {
  items: [
    {
      packageKey: "openbot/demo-skill",
      version: "1.0.0",
      displayName: "Demo Skill",
      summary: "Summarize text.",
      category: "productivity",
      install,
      installable: true,
      blockers: [],
    },
  ],
  nextCursor: null,
};

const planInput: PackagePlanInput = {
  operation: "install",
  packageKey: "openbot/demo-skill",
  version: "1.0.0",
  expectedRevision: null,
  config: { region: "us" },
  connectorInstalls: {},
};

interface Harness {
  readonly app: Hono;
  readonly calls: {
    list: Array<{ scope: PlatformScope; query: PackageListQuery }>;
    get: Array<{ scope: PlatformScope; installId: string }>;
    plan: Array<{
      scope: PlatformScope;
      admin: unknown;
      input: PackagePlanInput;
    }>;
    apply: Array<{
      scope: PlatformScope;
      admin: unknown;
      planId: string;
      idempotencyKey: string;
    }>;
  };
}

function fakeCatalogue(
  overrides: Partial<PackageCatalogue> = {},
): PackageCatalogue {
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
    ...overrides,
  };
}

function fakeService(overrides: Partial<PackageService> = {}): {
  service: PackageService;
  calls: Harness["calls"];
} {
  const calls: Harness["calls"] = { list: [], get: [], plan: [], apply: [] };
  const service: PackageService = {
    async list(resolved, query) {
      calls.list.push({ scope: resolved, query });
      return page;
    },
    async get(resolved, installId) {
      calls.get.push({ scope: resolved, installId });
      return detail;
    },
    async plan(resolved, adminContext, input) {
      calls.plan.push({ scope: resolved, admin: adminContext, input });
      return planDTO;
    },
    async apply(resolved, adminContext, planId, idempotencyKey) {
      calls.apply.push({
        scope: resolved,
        admin: adminContext,
        planId,
        idempotencyKey,
      });
      return { install, created: true };
    },
    // PKG03A grant seams; the dedicated grant route tests replace these via
    // overrides — the base stubs only keep the fake assignable.
    async setBotGrant() {
      throw new Error("not used");
    },
    async revokeBotGrant() {
      throw new Error("not used");
    },
    ...overrides,
  };
  return { service, calls };
}

function appWith(options: {
  service?: PackageService | null;
  catalogue?: PackageCatalogue | null;
  resolveScope?: (request: Request) => Promise<PlatformScope>;
  resolveAdmin?: (request: Request) => Promise<typeof admin>;
}): Hono {
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      catalogue:
        options.catalogue === undefined ? fakeCatalogue() : options.catalogue,
      service:
        options.service === undefined ? fakeService().service : options.service,
      resolveScope: options.resolveScope ?? (async () => scope),
      resolveAdmin: options.resolveAdmin ?? (async () => admin),
    }),
  );
  return app;
}

function jsonRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
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

describe("package install routes: authentication and scope", () => {
  test("answers 401 when the caller is not signed in", async () => {
    const app = appWith({
      resolveScope: async () => {
        throw new Error("AUTH_REQUIRED");
      },
    });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans",
      {
        method: "POST",
        body: JSON.stringify(planInput),
      },
    );
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("answers 400 SCOPE_REQUIRED when selection is missing", async () => {
    const app = appWith({
      resolveScope: async () => {
        throw new Error("WORKSPACE_REQUIRED");
      },
    });
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "SCOPE_REQUIRED" },
    });
  });

  test("answers 403 for a non-member and for an unverified scope", async () => {
    for (const message of [
      "TENANT_FORBIDDEN",
      "WORKSPACE_FORBIDDEN",
      "UNVERIFIED_SCOPE",
    ]) {
      const app = appWith({
        resolveScope: async () => {
          throw new Error(message);
        },
      });
      const response = await app.request("/api/enterprise/plugin-packages");
      expect(response.status).toBe(403);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "TENANT_FORBIDDEN" },
      });
    }
  });

  test("forged scope headers never replace the resolved scope", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const response = await app.request("/api/enterprise/plugin-packages", {
      headers: {
        "x-openbot-tenant": "forged-tenant",
        "x-openbot-workspace": "forged-workspace",
      },
    });
    expect(response.status).toBe(200);
    expect(calls.list[0]?.scope).toBe(scope);
    expect(JSON.stringify(await response.json())).not.toContain(
      "forged-tenant",
    );
  });
});

describe("package install routes: plan", () => {
  test("requires tenant_admin (403) for plan and apply", async () => {
    for (const path of [
      "/api/enterprise/plugin-packages/plans",
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
    ]) {
      const app = appWith({
        resolveAdmin: async () => {
          throw new Error("TENANT_ADMIN_REQUIRED");
        },
      });
      const response = await app.request(
        path,
        jsonRequest(path, path.endsWith("/apply") ? {} : planInput, {
          "idempotency-key": "key-1",
        }),
      );
      expect(response.status).toBe(403);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "TENANT_ADMIN_REQUIRED" },
      });
    }
  });

  test("a platform admin without a company context is refused", async () => {
    const app = appWith({
      resolveAdmin: async () => {
        throw new Error("TENANT_FORBIDDEN");
      },
    });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans",
      jsonRequest("/api/enterprise/plugin-packages/plans", planInput),
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TENANT_FORBIDDEN" },
    });
  });

  test("rejects unknown, scope/actor, secret and version-range fields", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const forbiddenBodies: unknown[] = [
      { ...planInput, scope: { tenantId: "evil" } },
      { ...planInput, actorId: "evil" },
      { ...planInput, principalId: "evil" },
      { ...planInput, versionRange: "^1.0.0" },
      { ...planInput, config: { apiKey: "sk-live-should-never-echo" } },
      { ...planInput, config: { nested: { deep: true } } },
      { ...planInput, operation: "install", config: { token: "canary-token" } },
      {
        ...planInput,
        config: {
          a: 1,
          b: 2,
          c: 3,
          d: 4,
          e: 5,
          f: 6,
          g: 7,
          h: 8,
          i: 9,
          j: 10,
          k: 11,
          l: 12,
          m: 13,
          n: 14,
          o: 15,
          p: 16,
          q: 17,
          r: 18,
          s: 19,
          t: 20,
          u: 21,
          v: 22,
          w: 23,
          x: 24,
          y: 25,
          z: 26,
          aa: 27,
          ab: 28,
          ac: 29,
          ad: 30,
          ae: 31,
          af: 32,
          ag: 33,
        },
      },
    ];
    for (const body of forbiddenBodies) {
      const response = await app.request(
        "/api/enterprise/plugin-packages/plans",
        jsonRequest("/api/enterprise/plugin-packages/plans", body),
      );
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("sk-live-should-never-echo");
      expect(text).not.toContain("canary-token");
      expect(JSON.parse(text)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
    expect(calls.plan.length).toBe(0);
  });

  test("rejects invalid JSON and an oversized body without echoing it", async () => {
    const app = appWith({ service: fakeService().service });
    const malformed = await app.request(
      "/api/enterprise/plugin-packages/plans",
      new Request("http://local/api/enterprise/plugin-packages/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);
    const oversized = await app.request(
      "/api/enterprise/plugin-packages/plans",
      jsonRequest("/api/enterprise/plugin-packages/plans", {
        ...planInput,
        config: { note: "x".repeat(140 * 1024) },
      }),
    );
    expect(oversized.status).toBe(400);
  });

  test("rejects a multibyte body by byte count under the UTF-16 code-unit cap", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    // 400 connector installs of 128 U+6F22 characters each: ~160k UTF-8 bytes
    // (over the 128 KiB cap) but far below 131,072 UTF-16 code units. The
    // hand-written `text.length` check this surface used before counted code
    // units, so this body slipped past it to the service; the byte-exact
    // body-limit middleware refuses it.
    const multibyte = {
      ...planInput,
      connectorInstalls: Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `tool-${String(index).padStart(6, "0")}`,
          "漢".repeat(128),
        ]),
      ),
    };
    const serialized = JSON.stringify(multibyte);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(128 * 1024);
    expect(serialized.length).toBeLessThanOrEqual(128 * 1024);

    // Streamed body with no content-length: the middleware drains the stream
    // and counts real bytes.
    const streamed = await app.request(
      "/api/enterprise/plugin-packages/plans",
      new Request("http://local/api/enterprise/plugin-packages/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(serialized));
            controller.close();
          },
        }),
        duplex: "half",
      }),
    );
    expect(streamed.status).toBe(400);
    expect(await errorBody(streamed)).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });

    // A string body declares its true byte count, so the preflight refuses it
    // before a byte is read — same closed body either way.
    const declared = await app.request(
      "/api/enterprise/plugin-packages/plans",
      jsonRequest("/api/enterprise/plugin-packages/plans", multibyte),
    );
    expect(declared.status).toBe(400);
    expect(calls.plan).toHaveLength(0);
  });

  test("maps unsupported operations, revision conflicts and unknown releases", async () => {
    const cases: Array<[unknown, string, number]> = [
      [{ ...planInput, operation: "upgrade" }, "PACKAGE_UNSUPPORTED", 422],
      [{ ...planInput, expectedRevision: 1 }, "REVISION_CONFLICT", 409],
      [
        { ...planInput, packageKey: "openbot/unknown" },
        "RESOURCE_NOT_FOUND",
        404,
      ],
    ];
    for (const [body, code, status] of cases) {
      const app = appWith({
        service: fakeService({
          async plan(_resolved, _admin, input) {
            if (input.operation !== "install")
              throw packageError("PACKAGE_UNSUPPORTED");
            if (input.expectedRevision !== null)
              throw packageError("REVISION_CONFLICT");
            throw packageError("RESOURCE_NOT_FOUND");
          },
        }).service,
      });
      const response = await app.request(
        "/api/enterprise/plugin-packages/plans",
        jsonRequest("/api/enterprise/plugin-packages/plans", body),
      );
      expect(response.status).toBe(status);
      expect(await errorBody(response)).toMatchObject({ error: { code } });
    }
  });

  test("returns the plan DTO for a valid request", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans",
      jsonRequest("/api/enterprise/plugin-packages/plans", planInput),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(planDTO);
    expect(calls.plan[0]?.scope).toBe(scope);
    expect(calls.plan[0]?.input).toEqual(planInput);
  });

  test("answers 503 when the operator channel was not assembled", async () => {
    const app = appWith({ service: null, resolveAdmin: undefined });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans",
      jsonRequest("/api/enterprise/plugin-packages/plans", planInput),
    );
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "ADMIN_CHANNEL_UNAVAILABLE" },
    });
  });
});

describe("package install routes: apply and idempotency header", () => {
  test("rejects every malformed Idempotency-Key with 400", async () => {
    const app = appWith({ service: fakeService().service });
    for (const key of [
      undefined,
      "",
      "x".repeat(129),
      "\u0001key",
      "tab\tkey",
    ]) {
      const headers: Record<string, string> = {};
      if (key !== undefined) headers["idempotency-key"] = key;
      const response = await app.request(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        jsonRequest(
          "/api/enterprise/plugin-packages/plans/plan-1/apply",
          {},
          headers,
        ),
      );
      expect({ key, status: response.status }).toEqual({ key, status: 400 });
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
  });

  test("maps 201 for a first apply and 200 for a replay", async () => {
    const created: PackageService = {
      ...fakeService().service,
      async apply() {
        return { install, created: true };
      },
    };
    const createdApp = appWith({ service: created });
    const first = await createdApp.request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual(install);

    const replayApp = appWith({
      service: {
        ...fakeService().service,
        async apply() {
          return { install, created: false };
        },
      },
    });
    const replay = await replayApp.request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(install);
  });

  test("maps every closed apply error to its status", async () => {
    const cases: Array<[Parameters<typeof packageError>[0], number]> = [
      ["RESOURCE_NOT_FOUND", 404],
      ["IDEMPOTENCY_CONFLICT", 409],
      ["REVISION_CONFLICT", 409],
      ["PLAN_CHANGED", 409],
      ["PLAN_EXPIRED", 410],
      ["PACKAGE_UNSUPPORTED", 422],
      ["TENANT_FORBIDDEN", 403],
      ["ADMIN_CHANNEL_UNAVAILABLE", 503],
      // R4-3: the server-internal code joins the shared vocabulary at the
      // status mapping only — a 4xx, never a bare FK 500.
      ["CONNECTOR_INSTALL_MISSING", 409],
    ];
    for (const [code, status] of cases) {
      const app = appWith({
        service: fakeService({
          async apply() {
            throw new PackageServiceError(code);
          },
        }).service,
      });
      const response = await app.request(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        jsonRequest(
          "/api/enterprise/plugin-packages/plans/plan-1/apply",
          {},
          { "idempotency-key": "key-1" },
        ),
      );
      expect({ code, status: response.status }).toEqual({ code, status });
    }
  });

  test("the R4-3 internal code answers with its own explainable body", async () => {
    const app = appWith({
      service: fakeService({
        async apply() {
          throw packageError("CONNECTOR_INSTALL_MISSING");
        },
      }).service,
    });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CONNECTOR_INSTALL_MISSING" },
    });
  });

  test("unknown runtime failures never echo an internal message", async () => {
    const app = appWith({
      service: fakeService({
        async apply() {
          throw new Error("connection string postgres://secret@host/db");
        },
      }).service,
    });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("postgres://");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL" } });
  });

  test("a driver/SQLSTATE failure answers 503 PACKAGE_STORAGE_UNAVAILABLE, not 500", async () => {
    const driver = Object.assign(new Error("connection terminated"), {
      name: "PostgresError",
      code: "08006",
    });
    const wrapped = new Error("Failed query: select 1", { cause: driver });
    const app = appWith({
      service: fakeService({
        async apply() {
          throw wrapped;
        },
      }).service,
    });
    const response = await app.request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
    });
    expect(text).not.toContain("connection terminated");

    // An integrity verdict (23xxx) is a product outcome, not an outage: the
    // storage classifier must not swallow it into 503.
    const violation = Object.assign(new Error("unique violation"), {
      name: "PostgresError",
      code: "23505",
    });
    const conflict = await appWith({
      service: fakeService({
        async apply() {
          throw violation;
        },
      }).service,
    }).request(
      "/api/enterprise/plugin-packages/plans/plan-1/apply",
      jsonRequest(
        "/api/enterprise/plugin-packages/plans/plan-1/apply",
        {},
        { "idempotency-key": "key-1" },
      ),
    );
    expect(conflict.status).toBe(500);
  });
});

describe("package install routes: reads", () => {
  test("lists with the scope's install merged in", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(calls.list[0]?.scope).toBe(scope);
  });

  test("falls back to the catalogue when no install service exists", async () => {
    const app = appWith({
      service: null,
      catalogue: fakeCatalogue({
        async list() {
          return {
            ...page,
            items: page.items.map((item) => ({ ...item, install: null })),
          };
        },
      }),
    });
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(200);
    expect((await response.json()) as PackagePage).toMatchObject({
      items: [{ install: null }],
    });
  });

  test("returns install detail and one identical 404 for unknown/cross-scope ids", async () => {
    const app = appWith({ service: fakeService().service });
    const found = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(detail);

    const notFound = appWith({
      service: fakeService({
        async get() {
          throw packageError("RESOURCE_NOT_FOUND");
        },
      }).service,
    });
    const unknown = await notFound.request(
      "/api/enterprise/plugin-packages/installs/does-not-exist",
    );
    const otherTeam = await notFound.request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(unknown.status).toBe(404);
    expect(otherTeam.status).toBe(404);
    expect(await unknown.text()).toBe(await otherTeam.text());
  });

  test("answers 503 for install reads when no service is assembled", async () => {
    const app = appWith({ service: null });
    const response = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "ADMIN_CHANNEL_UNAVAILABLE" },
    });
  });
});

describe("unavailable plugin package router", () => {
  test("answers 503 for every method including the install paths", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createUnavailablePluginPackageRoutes(),
    );
    for (const [method, path] of [
      ["GET", "/api/enterprise/plugin-packages"],
      ["GET", "/api/enterprise/plugin-packages/installs/install-1"],
      ["POST", "/api/enterprise/plugin-packages/plans"],
      ["POST", "/api/enterprise/plugin-packages/plans/plan-1/apply"],
    ] as const) {
      const response = await app.request(path, { method });
      expect({ method, status: response.status }).toEqual({
        method,
        status: 503,
      });
    }
  });
});

// F-C1: the route suites above stub the service, so they cannot see the
// readiness derivation. These tests drive the real `createPackageService`
// over PackageInstallFacts doubles: readiness follows
// unavailable → needs_connection → needs_grant → ready, where the final hop
// is live exactly while the facts carry at least one ACTIVE grant.

const readinessRelease: PackageReleaseFacts = {
  packageKey: "openbot/demo-skill",
  version: "1.0.0",
  artifactDigest: digest,
  category: "productivity",
  listed: true,
  verified: true,
  displayName: "Demo Skill",
  summary: "Summarize text.",
  blockers: [],
  manifest: {
    schemaVersion: 1,
    platformApi: 1,
    publisher: "openbot",
    name: "demo-skill",
    version: "1.0.0",
    display: { name: "Demo Skill", summary: "Summarize text." },
    resources: [
      { kind: "skill", id: "summarize", path: "skills/summarize/SKILL.md" },
      {
        kind: "managedConnector",
        id: "calendar",
        catalogKey: "calendar",
        required: true,
        tools: [{ name: "list-events", effect: "read" }],
      },
    ],
    dependencies: [],
  },
};

function factsWith(
  overrides: Partial<PackageInstallFacts> = {},
): PackageInstallFacts {
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    installId: "install-1",
    packageKey: "openbot/demo-skill",
    version: "1.0.0",
    artifactDigest: digest,
    revision: 1,
    generation: 1,
    status: "enabled",
    links: [
      {
        resourceId: "calendar",
        kind: "managedConnector",
        connectorInstallId: "connector-1",
        existingSkillId: null,
        expertTemplateRef: null,
      },
    ],
    grants: [
      {
        botId: "bot-1",
        revision: 1,
        resources: [{ resourceId: "summarize", kind: "skill" }],
      },
    ],
    ...overrides,
  };
}

function readinessService(options: {
  facts: PackageInstallFacts | null;
  releaseOverrides?: Partial<PackageReleaseFacts>;
}): PackageService {
  const release: PackageReleaseFacts = {
    ...readinessRelease,
    ...options.releaseOverrides,
  };
  const catalogue: PackageCatalogue = {
    async list() {
      return {
        items: [
          {
            packageKey: release.packageKey,
            version: release.version,
            displayName: release.displayName,
            summary: release.summary,
            category: release.category,
            install: null,
            installable: true,
            blockers: [],
          },
        ],
        nextCursor: null,
      };
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease(packageKey, version) {
      return packageKey === release.packageKey && version === release.version
        ? release
        : null;
    },
  };
  const readStore: PackageReadStore = {
    async listInstalls() {
      return options.facts === null ? [] : [options.facts];
    },
    async getInstall(_resolved, installId) {
      return options.facts?.installId === installId ? options.facts : null;
    },
  };
  return createPackageService({ catalogue, readStore, mutation: null });
}

describe("package install service readiness: grants decide the final hop", () => {
  test("an active grant makes list and detail reads ready without NEEDS_GRANT", async () => {
    const service = readinessService({ facts: factsWith() });
    const page = await service.list(scope, {});
    expect(page.items[0]?.install?.readiness).toBe("ready");
    expect(page.items[0]?.install?.blockers).toEqual([]);

    const detail = await service.get(scope, "install-1");
    expect(detail.readiness).toBe("ready");
    expect(detail.blockers).toEqual([]);
    expect(detail.grants).toEqual([
      {
        installId: "install-1",
        botId: "bot-1",
        revision: 1,
        resources: [{ resourceId: "summarize", kind: "skill" }],
      },
    ]);
  });

  test("revoking the last grant returns the install to needs_grant", async () => {
    const service = readinessService({ facts: factsWith({ grants: [] }) });
    const page = await service.list(scope, {});
    expect(page.items[0]?.install?.readiness).toBe("needs_grant");
    expect(page.items[0]?.install?.blockers).toEqual([{ code: "NEEDS_GRANT" }]);

    const detail = await service.get(scope, "install-1");
    expect(detail.readiness).toBe("needs_grant");
    expect(detail.blockers).toEqual([{ code: "NEEDS_GRANT" }]);
    expect(detail.grants).toEqual([]);
  });

  test("unavailable and needs_connection keep precedence over grants", async () => {
    const disabled = readinessService({
      facts: factsWith({ status: "disabled" }),
    });
    expect((await disabled.get(scope, "install-1")).readiness).toBe(
      "unavailable",
    );

    const unverified = readinessService({
      facts: factsWith(),
      releaseOverrides: { verified: false },
    });
    const stale = await unverified.get(scope, "install-1");
    expect(stale.readiness).toBe("unavailable");
    expect(stale.blockers).toEqual([{ code: "ARTIFACT_INVALID" }]);

    const unlinked = readinessService({ facts: factsWith({ links: [] }) });
    const disconnected = await unlinked.get(scope, "install-1");
    expect(disconnected.readiness).toBe("needs_connection");
    expect(disconnected.blockers).toEqual([
      { code: "NEEDS_CONNECTION", resourceId: "calendar" },
    ]);
  });
});
