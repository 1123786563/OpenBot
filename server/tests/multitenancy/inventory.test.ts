import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  BACKGROUND_CANDIDATES,
  buildInventory,
  collectRoutes,
  gapReport,
  type InventoryRoute,
  type OwnerRule,
  routeKey,
} from "../../scripts/multitenancy/inventory";

/**
 * MT001 — the entry inventory is the fact source for multitenancy coverage, so the tests prove three
 * things about it: it flattens the real assembly (mounts included, not hand-written constants), it
 * needs no test database, and it can tell assigned from unassigned entries (the gap report).
 */

describe("collectRoutes (drift seam)", () => {
  test("flattens mounted sub-apps into full paths and sees routes added later", () => {
    const app = new Hono();
    const sub = new Hono();
    sub.get("/x/:id", (c) => c.text("ok"));
    sub.post("/", (c) => c.text("ok"));
    app.route("/pre", sub);

    const before = collectRoutes(app);
    expect(before).toContainEqual({ method: "GET", path: "/pre/x/:id" });
    expect(before).toContainEqual({ method: "POST", path: "/pre" });

    // The drift contract: a newly registered route must appear in the next extraction. This is the
    // property later tickets rely on to detect routes that were never classified.
    app.get("/added", (c) => c.text("ok"));
    const after = collectRoutes(app);
    expect(after.map(routeKey)).toContain("GET /added");
    expect(after).toHaveLength(before.length + 1);
  });

  test("deduplicates repeated registrations and sorts for a stable baseline", () => {
    const app = new Hono();
    app.get("/b", (c) => c.text("ok"));
    app.get("/a", (c) => c.text("ok"));
    app.get("/a", (c) => c.text("ok"));
    const keys = collectRoutes(app).map(routeKey);
    expect(keys).toEqual(["GET /a", "GET /b"]);
  });
});

describe("buildInventory (real assembly, no test database)", () => {
  let savedTestDatabaseUrl: string | undefined;

  beforeAll(() => {
    savedTestDatabaseUrl = process.env.TEST_DATABASE_URL;
    // The static part of the inventory must never require a test database; prove it by removing the
    // variable entirely instead of leaving a stale value behind.
    delete process.env.TEST_DATABASE_URL;
  });

  afterAll(() => {
    if (savedTestDatabaseUrl !== undefined) {
      process.env.TEST_DATABASE_URL = savedTestDatabaseUrl;
    }
  });

  test("extracts routes from the real deployment app, mounts included", () => {
    const inventory = buildInventory();
    expect(inventory.routes.length).toBeGreaterThan(300);

    const paths = new Set(inventory.routes.map((r) => r.path));
    // Deployment surface across the major groups the spec's §8 matrix calls out: workbench,
    // enterprise admin, mobile aggregation, public (previously anonymous) entry points, and craft.
    for (const prefix of [
      "/api/channels",
      "/api/admin/enterprise",
      "/api/mobile/openmuse-files",
      "/api/public/workshop",
      "/api/craft",
    ]) {
      expect(
        [...paths].filter((p) => p === prefix || p.startsWith(`${prefix}/`))
          .length,
      ).toBeGreaterThan(0);
    }
  });

  test("lists tables from both databases, including the tenancy domain", () => {
    const inventory = buildInventory();
    for (const table of [
      "channels",
      "enterprise_tenants",
      "enterprise_memberships",
      "enterprise_resources",
    ]) {
      expect(inventory.tables.main).toContain(table);
    }
    expect(inventory.tables.main.length).toBeGreaterThan(100);
    expect(inventory.tables.kb.length).toBeGreaterThan(0);
    expect(inventory.tables.kb).toContain("chunks");
  });

  test("carries the background candidate registry with existence status", () => {
    const inventory = buildInventory();
    expect(inventory.background.length).toBeGreaterThanOrEqual(
      BACKGROUND_CANDIDATES.length,
    );
    const worker = inventory.background.find((e) => e.name === "worker");
    expect(worker?.status).toBe("present");
  });
});

describe("gapReport (coverage accounting)", () => {
  const routes: InventoryRoute[] = [
    { method: "GET", path: "/api/channels" },
    { method: "GET", path: "/api/channels/:id" },
    { method: "POST", path: "/api/craft" },
  ];
  const owners: OwnerRule[] = [{ prefix: "/api/channels", ticket: "MT021" }];

  test("counts assigned and unassigned routes by prefix ownership", () => {
    const report = gapReport(
      { routes, tables: { main: [], kb: [] }, background: [] },
      owners,
    );
    expect(report.assigned).toBe(2);
    expect(report.unassigned).toBe(1);
    expect(report.unassignedSample).toEqual(["POST /api/craft"]);
  });

  test("with no owners everything is a gap", () => {
    const report = gapReport(
      { routes, tables: { main: [], kb: [] }, background: [] },
      [],
    );
    expect(report.assigned).toBe(0);
    expect(report.unassigned).toBe(routes.length);
  });
});
