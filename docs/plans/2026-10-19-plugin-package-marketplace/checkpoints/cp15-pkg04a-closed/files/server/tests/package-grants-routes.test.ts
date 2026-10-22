import { Hono } from "hono";
import type {
  PackageGrantDTO,
  PackageGrantInput,
  PackageInstallDetailDTO,
  PackageInstallDTO,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type {
  PackageGrantMutationResult,
  PackageService,
} from "../src/enterprise/plugin-packages/contracts";
import {
  PackageServiceError,
  packageError,
} from "../src/enterprise/plugin-packages/contracts";
import {
  createPluginPackageRoutes,
  createUnavailablePluginPackageRoutes,
} from "../src/enterprise/plugin-packages/routes";
import { classifyManagementPlane } from "../src/enterprise/tenancy/admin-separation";
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

const GRANTS_PATH =
  "/api/enterprise/plugin-packages/installs/install-1/bots/bot-1/grants";

const grantInput: PackageGrantInput = {
  installId: "install-1",
  botId: "bot-1",
  expectedGrantRevision: null,
  resources: [{ resourceId: "summarize", kind: "skill" }],
};

const grantDTO: PackageGrantDTO = {
  installId: "install-1",
  botId: "bot-1",
  revision: 1,
  resources: [{ resourceId: "summarize", kind: "skill" }],
};

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
  grants: [grantDTO],
};

function fakeCatalogue(): PackageCatalogue {
  return {
    async list() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
    },
    async resolveRelease() {
      return null;
    },
  };
}

interface GrantCalls {
  set: Array<{
    scope: PlatformScope;
    admin: unknown;
    input: PackageGrantInput;
    idempotencyKey: string;
  }>;
  revoke: Array<{
    scope: PlatformScope;
    admin: unknown;
    input: unknown;
    idempotencyKey: string;
  }>;
}

function fakeService(overrides: Partial<PackageService> = {}): {
  service: PackageService;
  calls: GrantCalls;
} {
  const calls: GrantCalls = { set: [], revoke: [] };
  const service: PackageService = {
    async list() {
      throw new Error("not used");
    },
    async get() {
      return detail;
    },
    async plan() {
      throw new Error("not used");
    },
    async apply() {
      throw new Error("not used");
    },
    async setBotGrant(resolved, adminContext, input, idempotencyKey) {
      calls.set.push({
        scope: resolved,
        admin: adminContext,
        input,
        idempotencyKey,
      });
      const result: PackageGrantMutationResult = {
        grant: grantDTO,
        created: true,
      };
      return result;
    },
    async revokeBotGrant(resolved, adminContext, input, idempotencyKey) {
      calls.revoke.push({
        scope: resolved,
        admin: adminContext,
        input,
        idempotencyKey,
      });
      return {
        grant: { ...grantDTO, revision: 2 },
        created: true,
      };
    },
    ...overrides,
  };
  return { service, calls };
}

function appWith(options: {
  service?: PackageService | null;
  resolveScope?: (request: Request) => Promise<PlatformScope>;
  resolveAdmin?: (request: Request) => Promise<typeof admin>;
}): Hono {
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      catalogue: fakeCatalogue(),
      service:
        options.service === undefined ? fakeService().service : options.service,
      resolveScope: options.resolveScope ?? (async () => scope),
      resolveAdmin: options.resolveAdmin ?? (async () => admin),
    }),
  );
  return app;
}

function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://local${GRANTS_PATH}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function deleteRequest(body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://local${GRANTS_PATH}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function errorBody(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("package grant routes: classification", () => {
  test("PUT and DELETE grants are company management entrances", () => {
    expect(classifyManagementPlane({ method: "PUT", path: GRANTS_PATH })).toBe(
      "company",
    );
    expect(
      classifyManagementPlane({ method: "DELETE", path: GRANTS_PATH }),
    ).toBe("company");
    // Reads stay business entrances.
    expect(classifyManagementPlane({ method: "GET", path: GRANTS_PATH })).toBe(
      null,
    );
  });
});

describe("package grant routes: authentication and authorization", () => {
  test("answers 401 when the caller is not signed in", async () => {
    const app = appWith({
      resolveScope: async () => {
        throw new Error("AUTH_REQUIRED");
      },
    });
    for (const request of [
      putRequest(grantInput, { "idempotency-key": "key-1" }),
      deleteRequest(undefined, { "idempotency-key": "key-1" }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(401);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "AUTH_REQUIRED" },
      });
    }
  });

  test("answers 400 SCOPE_REQUIRED when selection is missing", async () => {
    const app = appWith({
      resolveScope: async () => {
        throw new Error("WORKSPACE_REQUIRED");
      },
    });
    const response = await app.request(
      putRequest(grantInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "SCOPE_REQUIRED" },
    });
  });

  test("requires tenant_admin (403) for grant and revoke", async () => {
    for (const request of [
      putRequest(grantInput, { "idempotency-key": "key-1" }),
      deleteRequest(undefined, { "idempotency-key": "key-1" }),
    ]) {
      const app = appWith({
        resolveAdmin: async () => {
          throw new Error("TENANT_ADMIN_REQUIRED");
        },
      });
      const response = await app.request(request);
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
      putRequest(grantInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TENANT_FORBIDDEN" },
    });
  });

  test("answers 503 when no service/admin channel is assembled", async () => {
    const app = appWith({ service: null, resolveAdmin: undefined });
    for (const request of [
      putRequest(grantInput, { "idempotency-key": "key-1" }),
      deleteRequest(undefined, { "idempotency-key": "key-1" }),
    ]) {
      const response = await app.request(request);
      expect(response.status).toBe(503);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "ADMIN_CHANNEL_UNAVAILABLE" },
      });
    }
  });
});

describe("package grant routes: PUT", () => {
  test("returns 201 with the grant DTO and passes scope/admin/input/key", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const response = await app.request(
      putRequest(grantInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(grantDTO);
    expect(calls.set[0]?.scope).toBe(scope);
    expect(calls.set[0]?.admin).toBe(admin);
    expect(calls.set[0]?.input).toEqual(grantInput);
    expect(calls.set[0]?.idempotencyKey).toBe("key-1");
  });

  test("replays answer 200 with the stored grant", async () => {
    const app = appWith({
      service: fakeService({
        async setBotGrant() {
          return { grant: grantDTO, created: false };
        },
      }).service,
    });
    const response = await app.request(
      putRequest(grantInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(grantDTO);
  });

  test("rejects malformed bodies and mismatched path identity with 400", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const bodies: unknown[] = [
      { ...grantInput, installId: "other-install" },
      { ...grantInput, botId: "other-bot" },
      { ...grantInput, scope: { tenantId: "evil" } },
      { ...grantInput, expectedGrantRevision: 0 },
      { ...grantInput, resources: [] },
      { ...grantInput, resources: [{ resourceId: "x" }] },
      { ...grantInput, resources: "summarize" },
      {},
    ];
    for (const body of bodies) {
      const response = await app.request(
        putRequest(body, { "idempotency-key": "key-1" }),
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
    // Missing or malformed Idempotency-Key.
    for (const headers of [
      {},
      { "idempotency-key": "" },
      { "idempotency-key": "tab\tkey" },
    ]) {
      const response = await app.request(putRequest(grantInput, headers));
      expect(response.status).toBe(400);
    }
    expect(calls.set.length).toBe(0);
  });

  test("maps unknown install and cross-scope bot to one identical 404", async () => {
    const app = appWith({
      service: fakeService({
        async setBotGrant() {
          throw packageError("RESOURCE_NOT_FOUND");
        },
      }).service,
    });
    const unknownInstall = await app.request(
      new Request(
        "http://local/api/enterprise/plugin-packages/installs/nope/bots/bot-1/grants",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "k",
          },
          body: JSON.stringify({ ...grantInput, installId: "nope" }),
        },
      ),
    );
    const foreignBot = await app.request(
      new Request(
        "http://local/api/enterprise/plugin-packages/installs/install-1/bots/foreign-bot/grants",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "k",
          },
          body: JSON.stringify({ ...grantInput, botId: "foreign-bot" }),
        },
      ),
    );
    expect(unknownInstall.status).toBe(404);
    expect(foreignBot.status).toBe(404);
    expect(await unknownInstall.text()).toBe(await foreignBot.text());
  });

  test("refuses connector resources with 422 RESOURCE_KIND_UNSUPPORTED", async () => {
    const app = appWith({
      service: fakeService({
        async setBotGrant(_scope, _admin, input) {
          if (input.resources.some((resource) => resource.kind !== "skill")) {
            throw packageError("RESOURCE_KIND_UNSUPPORTED");
          }
          return { grant: grantDTO, created: true };
        },
      }).service,
    });
    const response = await app.request(
      putRequest(
        {
          ...grantInput,
          resources: [{ resourceId: "tracker", kind: "managedConnector" }],
        },
        { "idempotency-key": "key-1" },
      ),
    );
    expect(response.status).toBe(422);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "RESOURCE_KIND_UNSUPPORTED" },
    });
  });

  test("maps stale CAS input and idempotency conflicts to their statuses", async () => {
    const cases: Array<[Parameters<typeof packageError>[0], number]> = [
      ["REVISION_CONFLICT", 409],
      ["IDEMPOTENCY_CONFLICT", 409],
      ["PACKAGE_UNSUPPORTED", 422],
    ];
    for (const [code, status] of cases) {
      const app = appWith({
        service: fakeService({
          async setBotGrant() {
            throw new PackageServiceError(code);
          },
        }).service,
      });
      const response = await app.request(
        putRequest(grantInput, { "idempotency-key": "key-1" }),
      );
      expect({ code, status: response.status }).toEqual({ code, status });
    }
  });

  test("unknown runtime failures never echo an internal message", async () => {
    const app = appWith({
      service: fakeService({
        async setBotGrant() {
          throw new Error("postgres://secret@host/db");
        },
      }).service,
    });
    const response = await app.request(
      putRequest(grantInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("postgres://");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL" } });
  });
});

describe("package grant routes: DELETE", () => {
  test("returns 201 for a revocation and passes the merged input", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const bare = await app.request(deleteRequest(undefined), {
      headers: { "idempotency-key": "key-2" },
    });
    expect(bare.status).toBe(201);
    expect(await bare.json()).toEqual({ ...grantDTO, revision: 2 });
    expect(calls.revoke[0]?.input).toEqual({
      installId: "install-1",
      botId: "bot-1",
      expectedGrantRevision: null,
    });
    expect(calls.revoke[0]?.idempotencyKey).toBe("key-2");

    const withCas = await app.request(
      deleteRequest(
        { expectedGrantRevision: 1 },
        { "idempotency-key": "key-3" },
      ),
    );
    expect(withCas.status).toBe(201);
    expect(calls.revoke[1]?.input).toEqual({
      installId: "install-1",
      botId: "bot-1",
      expectedGrantRevision: 1,
    });
  });

  test("replays and no-ops answer 200", async () => {
    const app = appWith({
      service: fakeService({
        async revokeBotGrant() {
          return { grant: grantDTO, created: false };
        },
      }).service,
    });
    const response = await app.request(
      deleteRequest(
        { expectedGrantRevision: null },
        { "idempotency-key": "k" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(grantDTO);
  });

  test("rejects malformed bodies with 400 and requires the key", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    for (const body of [{ unexpected: 1 }, { expectedGrantRevision: 0 }, "x"]) {
      const response = await app.request(
        deleteRequest(body, { "idempotency-key": "k" }),
      );
      expect(response.status).toBe(400);
    }
    const noKey = await app.request(deleteRequest(undefined));
    expect(noKey.status).toBe(400);
    expect(calls.revoke.length).toBe(0);
  });

  test("maps closed errors identically to PUT", async () => {
    const app = appWith({
      service: fakeService({
        async revokeBotGrant() {
          throw packageError("RESOURCE_NOT_FOUND");
        },
      }).service,
    });
    const response = await app.request(
      deleteRequest(undefined, { "idempotency-key": "k" }),
    );
    expect(response.status).toBe(404);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "RESOURCE_NOT_FOUND" },
    });
  });
});

describe("package grant routes: install detail surface", () => {
  test("install detail carries the active grants", async () => {
    const app = appWith({ service: fakeService().service });
    const response = await app.request(
      "/api/enterprise/plugin-packages/installs/install-1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
  });
});

describe("unavailable plugin package router", () => {
  test("answers 503 for the grant paths too", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createUnavailablePluginPackageRoutes(),
    );
    for (const method of ["PUT", "DELETE"] as const) {
      const response = await app.request(GRANTS_PATH, { method });
      expect({ method, status: response.status }).toEqual({
        method,
        status: 503,
      });
    }
  });
});
