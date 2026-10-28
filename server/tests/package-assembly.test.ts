import type {
  PackageCatalogueDetail,
  PackagePage,
} from "../../shared/enterprise/plugin-package-contracts";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { PackageService } from "../src/enterprise/plugin-packages/contracts";
import { createMarketplaceGate } from "../src/enterprise/plugin-packages/marketplace-gate";
import {
  createPluginPackageRoutes,
  createUnavailablePluginPackageRoutes,
} from "../src/enterprise/plugin-packages/routes";
import type { PackageCatalogue } from "../src/plugin-packages/catalogue";
import { testEnvironment } from "./support/environment";

/**
 * The plugin-package marketplace exists on the production HTTP surface only if
 * `server/src/index.ts` hands `createApp` a `coworker.pluginPackages` router.
 *
 * That wiring was lost in the ae8f9c374 merge wave: the assembly block and the
 * `pluginPackages` key both disappeared, leaving the two route factories as
 * dead imports while `createApp` kept mounting `/api/enterprise/plugin-packages`
 * only when the key exists. Every package request then answered 404 — the
 * whole V1 vertical was unreachable — with no type error to notice, because
 * the key is optional. These tests drive the real `createApp` and pin the
 * mount seam from both sides: a wired router must reach the route (401, never
 * 404), and an unwired one must still answer 503 rather than vanish.
 *
 * The requests are unauthenticated, which is exactly what the routes'
 * enterprise scope resolver rejects with AUTH_REQUIRED (401). A 404 here can
 * only mean the router was never mounted.
 */

const page: PackagePage = { items: [], nextCursor: null };

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

/**
 * Same shape as `package-read-routes.test.ts`: a catalogue that answers, so a
 * 404 can only come from the surface not existing rather than from a missing
 * catalogue. The service is present too, matching production, where reads go
 * through it.
 */
function fakeCatalogue(): PackageCatalogue {
  return {
    async list() {
      return page;
    },
    async get() {
      return detail;
    },
  } as unknown as PackageCatalogue;
}

function fakeService(): PackageService {
  return {
    async list() {
      return page;
    },
  } as unknown as PackageService;
}

/**
 * `createApp` takes positional parameters and `coworker` is the 35th (index
 * 34). Built by index on purpose, like `admin-people-credentials-validation`
 * does, so a future appended parameter cannot silently shift the object into
 * another slot.
 */
const CREATE_APP_PARAMETER_COUNT = 50;
const COWORKER_PARAMETER_INDEX = 34;

function appWithCrew(coworker: {
  pluginPackages?: ReturnType<typeof createPluginPackageRoutes>;
}) {
  const args: never[] = Array.from({
    length: CREATE_APP_PARAMETER_COUNT,
  }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[COWORKER_PARAMETER_INDEX] = coworker as never;
  return createApp(...args);
}

/** A wired deployment, named exactly the way `index.ts` wires it. */
function wiredRoutes() {
  return createPluginPackageRoutes({
    gate: createMarketplaceGate({
      enabled: true,
      pilotWorkspaces: [{ tenantId: "tenant-1", workspaceId: "workspace-1" }],
    }),
    catalogue: fakeCatalogue(),
    service: fakeService(),
    // Production resolves through the enterprise scope registry, which
    // answers an unauthenticated request with AUTH_REQUIRED (401).
    async resolveScope() {
      throw new Error("AUTH_REQUIRED");
    },
  });
}

describe("the plugin-package surface in the real app", () => {
  test("a wired deployment reaches the route instead of 404", async () => {
    const app = appWithCrew({ pluginPackages: wiredRoutes() });
    const response = await app.request(
      "http://openbot.local/api/enterprise/plugin-packages",
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("the root read is the same surface, not a special case", async () => {
    const app = appWithCrew({ pluginPackages: wiredRoutes() });
    const response = await app.request(
      "http://openbot.local/api/enterprise/plugin-packages/catalogue/openbot/demo-skill",
    );
    expect(response.status).toBe(401);
  });

  test("an unavailable assembly answers 503 rather than disappearing", async () => {
    const app = appWithCrew({
      pluginPackages: createUnavailablePluginPackageRoutes(),
    });
    for (const path of [
      "/api/enterprise/plugin-packages",
      "/api/enterprise/plugin-packages/catalogue/openbot/demo-skill",
      "/api/enterprise/plugin-packages/plans",
    ]) {
      const response = await app.request(`http://openbot.local${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "PACKAGE_STORAGE_UNAVAILABLE" },
      });
    }
  });

  test("an app without the key mounts nothing (the regression itself)", async () => {
    const app = appWithCrew({});
    const response = await app.request(
      "http://openbot.local/api/enterprise/plugin-packages",
    );
    expect(response.status).toBe(404);
  });
});
