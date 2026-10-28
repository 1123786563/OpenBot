import { Hono } from "hono";
import type {
  PackageExpertCreatedDTO,
  PackageExpertCreateInput,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import type {
  PackageExpertMutationResult,
  PackageService,
} from "../src/enterprise/plugin-packages/contracts";
import {
  PackageServiceError,
  packageError,
} from "../src/enterprise/plugin-packages/contracts";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
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

const EXPERT_PATH =
  "/api/enterprise/plugin-packages/installs/install-1/experts/assistant";

const expertInput: PackageExpertCreateInput = {
  installId: "install-1",
  resourceId: "assistant",
  expectedRevision: 1,
  name: "Meeting Assistant",
};

const expertDTO: PackageExpertCreatedDTO = {
  agentId: "pkg-expert-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  installId: "install-1",
  packageKey: "openbot/demo-package",
  version: "1.0.0",
  resourceId: "assistant",
  expertTemplateRef: "openbot/demo-package/assistant",
  displayName: "Meeting Assistant",
  grantRevision: 1,
  resources: [{ resourceId: "summarize", kind: "skill" }],
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

interface ExpertCalls {
  instantiate: Array<{
    scope: PlatformScope;
    admin: unknown;
    input: PackageExpertCreateInput;
    idempotencyKey: string;
  }>;
}

function fakeService(overrides: Partial<PackageService> = {}): {
  service: PackageService;
  calls: ExpertCalls;
} {
  const calls: ExpertCalls = { instantiate: [] };
  const service: PackageService = {
    async list() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
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
    async instantiateExpert(resolved, adminContext, input, idempotencyKey) {
      calls.instantiate.push({
        scope: resolved,
        admin: adminContext,
        input,
        idempotencyKey,
      });
      const result: PackageExpertMutationResult = {
        expert: expertDTO,
        created: true,
      };
      return result;
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
      gate: createMarketplaceGate({
        enabled: true,
        pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
      }),
      catalogue: fakeCatalogue(),
      service:
        options.service === undefined ? fakeService().service : options.service,
      resolveScope: options.resolveScope ?? (async () => scope),
      resolveAdmin: options.resolveAdmin ?? (async () => admin),
    }),
  );
  return app;
}

function expertRequest(
  body: unknown,
  headers: Record<string, string> = {},
  path = EXPERT_PATH,
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

describe("package expert routes: classification", () => {
  test("POST experts is a company management entrance; GET is not", () => {
    expect(classifyManagementPlane({ method: "POST", path: EXPERT_PATH })).toBe(
      "company",
    );
    // Literal mount patterns classify too (the fail-closed guard calls them).
    expect(
      classifyManagementPlane({
        method: "POST",
        path: "/api/enterprise/plugin-packages/installs/:id/experts/:resourceId",
      }),
    ).toBe("company");
    expect(classifyManagementPlane({ method: "GET", path: EXPERT_PATH })).toBe(
      null,
    );
    // A different install or resource id stays classified (path parameters).
    expect(
      classifyManagementPlane({
        method: "POST",
        path: "/api/enterprise/plugin-packages/installs/i2/experts/other",
      }),
    ).toBe("company");
    // A deeper or malformed path does not.
    expect(
      classifyManagementPlane({
        method: "POST",
        path: "/api/enterprise/plugin-packages/installs/i2/experts/other/more",
      }),
    ).toBe(null);
  });
});

describe("package expert routes: authentication and authorization", () => {
  test("answers 401 when the caller is not signed in", async () => {
    const app = appWith({
      resolveScope: async () => {
        throw new Error("AUTH_REQUIRED");
      },
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
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
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "SCOPE_REQUIRED" },
    });
  });

  test("requires tenant_admin (403) for instantiation", async () => {
    const app = appWith({
      resolveAdmin: async () => {
        throw new Error("TENANT_ADMIN_REQUIRED");
      },
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TENANT_ADMIN_REQUIRED" },
    });
  });

  test("a platform admin without a company context is refused", async () => {
    const app = appWith({
      resolveAdmin: async () => {
        throw new Error("TENANT_FORBIDDEN");
      },
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TENANT_FORBIDDEN" },
    });
  });

  test("answers 503 when no service/admin channel is assembled", async () => {
    const app = appWith({ service: null, resolveAdmin: undefined });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "ADMIN_CHANNEL_UNAVAILABLE" },
    });
  });

  test("the unavailable router answers 503 for the expert path too", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createUnavailablePluginPackageRoutes(),
    );
    const response = await app.request(EXPERT_PATH, { method: "POST" });
    expect(response.status).toBe(503);
  });
});

describe("package expert routes: POST", () => {
  test("returns 201 with the created DTO and passes scope/admin/input/key", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(expertDTO);
    expect(calls.instantiate[0]?.scope).toBe(scope);
    expect(calls.instantiate[0]?.admin).toBe(admin);
    expect(calls.instantiate[0]?.input).toEqual(expertInput);
    expect(calls.instantiate[0]?.idempotencyKey).toBe("key-1");
  });

  test("replays answer 200 with the SAME stored agentId", async () => {
    const app = appWith({
      service: fakeService({
        async instantiateExpert() {
          return { expert: expertDTO, created: false };
        },
      }).service,
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expertDTO);
  });

  test("rejects malformed bodies and mismatched path identity with 400", async () => {
    const { service, calls } = fakeService();
    const app = appWith({ service });
    const bodies: unknown[] = [
      { ...expertInput, installId: "other-install" },
      { ...expertInput, resourceId: "other-resource" },
      { ...expertInput, expectedRevision: 0 },
      { ...expertInput, expectedRevision: null },
      { ...expertInput, name: "" },
      { ...expertInput, name: "x".repeat(121) },
      // Probing fields the creation contract never carries.
      { ...expertInput, agentId: "pkg-expert-forged" },
      { ...expertInput, template: { systemPrompt: "evil" } },
      { ...expertInput, scope: { tenantId: "evil" } },
      {},
    ];
    for (const body of bodies) {
      const response = await app.request(
        expertRequest(body, { "idempotency-key": "key-1" }),
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
      const response = await app.request(expertRequest(expertInput, headers));
      expect(response.status).toBe(400);
    }
    expect(calls.instantiate.length).toBe(0);
  });

  test("maps unknown install and cross-scope resource to one identical 404", async () => {
    const app = appWith({
      service: fakeService({
        async instantiateExpert() {
          throw packageError("RESOURCE_NOT_FOUND");
        },
      }).service,
    });
    const unknownInstall = await app.request(
      expertRequest(
        { ...expertInput, installId: "nope" },
        { "idempotency-key": "k" },
        "/api/enterprise/plugin-packages/installs/nope/experts/assistant",
      ),
    );
    const foreignResource = await app.request(
      expertRequest(
        { ...expertInput, resourceId: "foreign" },
        { "idempotency-key": "k" },
        "/api/enterprise/plugin-packages/installs/install-1/experts/foreign",
      ),
    );
    expect(unknownInstall.status).toBe(404);
    expect(foreignResource.status).toBe(404);
    expect(await unknownInstall.text()).toBe(await foreignResource.text());
  });

  test("maps template-field rejections to 400 TEMPLATE_FIELD_REJECTED", async () => {
    const app = appWith({
      service: fakeService({
        async instantiateExpert() {
          throw packageError("TEMPLATE_FIELD_REJECTED");
        },
      }).service,
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TEMPLATE_FIELD_REJECTED" },
    });
  });

  test("maps stale CAS input and idempotency conflicts to their statuses", async () => {
    const cases: Array<[Parameters<typeof packageError>[0], number]> = [
      ["REVISION_CONFLICT", 409],
      ["IDEMPOTENCY_CONFLICT", 409],
      ["PLAN_CHANGED", 409],
      ["PACKAGE_UNSUPPORTED", 422],
    ];
    for (const [code, status] of cases) {
      const app = appWith({
        service: fakeService({
          async instantiateExpert() {
            throw new PackageServiceError(code);
          },
        }).service,
      });
      const response = await app.request(
        expertRequest(expertInput, { "idempotency-key": "key-1" }),
      );
      expect({ code, status: response.status }).toEqual({ code, status });
    }
  });

  test("unknown runtime failures never echo an internal message", async () => {
    const app = appWith({
      service: fakeService({
        async instantiateExpert() {
          throw new Error("postgres://secret@host/db");
        },
      }).service,
    });
    const response = await app.request(
      expertRequest(expertInput, { "idempotency-key": "key-1" }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("postgres://");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "INTERNAL" } });
  });

  test("digest covers exactly the canonical request fields", async () => {
    // Import lazily so the route suites above stay dependency-plain.
    const { expertRequestDigest } = await import(
      "../src/enterprise/plugin-packages/experts"
    );
    const base = {
      installId: "i-1",
      resourceId: "assistant",
      expectedRevision: 2,
      name: "Bot",
    };
    expect(expertRequestDigest(base)).toBe(expertRequestDigest({ ...base }));
    expect(expertRequestDigest(base)).not.toBe(
      expertRequestDigest({ ...base, name: "Different" }),
    );
    expect(expertRequestDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
