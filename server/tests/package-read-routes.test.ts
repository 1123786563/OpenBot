import { Hono } from "hono";
import type {
  PackageCatalogueDetail,
  PackagePage,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { PlatformScope } from "../src/enterprise/contracts";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
import {
  createPluginPackageRoutes,
  createUnavailablePluginPackageRoutes,
} from "../src/enterprise/plugin-packages/routes";
import type { PackageCatalogue } from "../src/plugin-packages/catalogue";

const scope: PlatformScope = {
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  principalId: "principal-1",
  actorId: "actor-1",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

const page: PackagePage = {
  items: [
    {
      packageKey: "openbot/demo-skill",
      version: "1.0.0",
      displayName: "Demo Skill",
      summary: "Summarize text.",
      category: "productivity",
      install: null,
      installable: true,
      blockers: [],
    },
  ],
  nextCursor: null,
};

const detail: PackageCatalogueDetail = {
  packageKey: "openbot/demo-skill",
  version: "1.0.0",
  artifactDigest: "a".repeat(64),
  displayName: "Demo Skill",
  summary: "Summarize text.",
  category: "productivity",
  publisher: "openbot",
  name: "demo-skill",
  resources: [{ id: "summarize", kind: "skill", available: true }],
  installable: true,
  blockers: [],
};

function fakeCatalogue(
  overrides: Partial<PackageCatalogue> = {},
): PackageCatalogue {
  return {
    async list() {
      return page;
    },
    async get() {
      return detail;
    },
    ...overrides,
  };
}

function appWith(catalogue: PackageCatalogue | null) {
  const app = new Hono();
  app.route(
    "/api/enterprise/plugin-packages",
    createPluginPackageRoutes({
      gate: createMarketplaceGate({
        enabled: true,
        pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
      }),
      catalogue,
      resolveScope: async () => scope,
    }),
  );
  return app;
}

async function errorBody(
  response: Response,
): Promise<{ error: { code: string; message: string } }> {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("plugin package read routes", () => {
  test("lists packages for the resolved scope", async () => {
    let receivedScope: PlatformScope | null = null;
    const app = appWith(
      fakeCatalogue({
        async list(resolved) {
          receivedScope = resolved;
          return page;
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages", {
      headers: {
        "x-openbot-tenant": "tenant-1",
        "x-openbot-workspace": "workspace-1",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(receivedScope).toBe(scope);
  });

  test("forwards search, category, cursor and limit", async () => {
    let received: unknown = null;
    const app = appWith(
      fakeCatalogue({
        async list(_resolved, query) {
          received = query;
          return page;
        },
      }),
    );
    const response = await app.request(
      "/api/enterprise/plugin-packages?search=demo&category=productivity&cursor=abc&limit=5",
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      search: "demo",
      category: "productivity",
      cursor: "abc",
      limit: 5,
    });
  });

  test("rejects unknown query keys", async () => {
    const app = appWith(fakeCatalogue());
    for (const query of ["foo=bar", "search=demo&foo=bar", "limit=5&x=1"]) {
      const response = await app.request(
        `/api/enterprise/plugin-packages?${query}`,
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
  });

  test("rejects a category that is not a package id", async () => {
    const app = appWith(fakeCatalogue());
    for (const category of [
      "Not_A_Category",
      "MeetingS",
      "-leading",
      "trailing-",
      "two--hyphens",
      "x".repeat(65),
    ]) {
      const response = await app.request(
        `/api/enterprise/plugin-packages?category=${encodeURIComponent(category)}`,
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
  });

  test("accepts a valid search, category, cursor and limit", async () => {
    let received: unknown = null;
    const app = appWith(
      fakeCatalogue({
        async list(_resolved, query) {
          received = query;
          return page;
        },
      }),
    );
    const response = await app.request(
      "/api/enterprise/plugin-packages?search=demo&category=productivity&limit=1",
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      search: "demo",
      category: "productivity",
      limit: 1,
    });
  });

  test("returns package detail", async () => {
    const app = appWith(fakeCatalogue());
    const response = await app.request(
      "/api/enterprise/plugin-packages/catalogue/openbot/demo-skill",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail);
  });

  test("answers 401 for an unauthenticated request", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createPluginPackageRoutes({
        gate: createMarketplaceGate({
          enabled: true,
          pilotWorkspaces: [
            { tenantId: "tenant-1", workspaceId: "workspace-1" },
          ],
        }),
        catalogue: fakeCatalogue(),
        resolveScope: async () => {
          throw new Error("AUTH_REQUIRED");
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(401);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("answers 403 when the scope is not a member", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createPluginPackageRoutes({
        gate: createMarketplaceGate({
          enabled: true,
          pilotWorkspaces: [
            { tenantId: "tenant-1", workspaceId: "workspace-1" },
          ],
        }),
        catalogue: fakeCatalogue(),
        resolveScope: async () => {
          throw new Error("TENANT_FORBIDDEN");
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(403);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "TENANT_FORBIDDEN" },
    });
  });

  test("answers 400 SCOPE_REQUIRED when selection headers are missing", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createPluginPackageRoutes({
        gate: createMarketplaceGate({
          enabled: true,
          pilotWorkspaces: [
            { tenantId: "tenant-1", workspaceId: "workspace-1" },
          ],
        }),
        catalogue: fakeCatalogue(),
        resolveScope: async () => {
          throw new Error("WORKSPACE_REQUIRED");
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "SCOPE_REQUIRED" },
    });
  });

  test("answers 400 INPUT_INVALID for a malformed limit", async () => {
    const app = appWith(fakeCatalogue());
    for (const limit of ["abc", "0", "101", "2.5"]) {
      const response = await app.request(
        `/api/enterprise/plugin-packages?limit=${limit}`,
      );
      expect(response.status).toBe(400);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "INPUT_INVALID" },
      });
    }
  });

  test("surfaces catalogue INPUT_INVALID as 400", async () => {
    const app = appWith(
      fakeCatalogue({
        async list() {
          throw new Error("INPUT_INVALID");
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
  });

  test("answers 404 for an unknown package", async () => {
    const app = appWith(
      fakeCatalogue({
        async get() {
          throw new Error("RESOURCE_NOT_FOUND");
        },
      }),
    );
    const response = await app.request(
      "/api/enterprise/plugin-packages/catalogue/openbot/unknown",
    );
    expect(response.status).toBe(404);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "RESOURCE_NOT_FOUND" },
    });
  });

  test("answers 503 when the catalogue was not assembled", async () => {
    const app = appWith(null);
    for (const path of [
      "/api/enterprise/plugin-packages",
      "/api/enterprise/plugin-packages/catalogue/openbot/demo-skill",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(503);
      expect(await errorBody(response)).toMatchObject({
        error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
      });
    }
  });

  test("answers 503 when the catalogue reports storage unavailable", async () => {
    const app = appWith(
      fakeCatalogue({
        async list() {
          throw new Error("PACKAGE_STORAGE_UNAVAILABLE");
        },
      }),
    );
    const response = await app.request("/api/enterprise/plugin-packages");
    expect(response.status).toBe(503);
    expect(await errorBody(response)).toMatchObject({
      error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
    });
  });

  test("never includes paths or secrets in the JSON", async () => {
    const app = appWith(fakeCatalogue());
    const body = await (
      await app.request("/api/enterprise/plugin-packages")
    ).text();
    expect(body).not.toContain("openbot.plugin.json");
    expect(body).not.toContain("sha256");
    expect(body).not.toContain("artifactRoot");
    expect(body).not.toContain("tenantId");
    expect(body).not.toContain("workspaceId");
    expect(body).not.toContain("apiKey");
  });
});

describe("unavailable plugin package router", () => {
  test("answers 503 for every method", async () => {
    const app = new Hono();
    app.route(
      "/api/enterprise/plugin-packages",
      createUnavailablePluginPackageRoutes(),
    );
    const list = await app.request("/api/enterprise/plugin-packages");
    const detail = await app.request(
      "/api/enterprise/plugin-packages/catalogue/openbot/demo-skill",
    );
    expect(list.status).toBe(503);
    expect(detail.status).toBe(503);
    expect(await errorBody(list)).toMatchObject({
      error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
    });
  });
});
