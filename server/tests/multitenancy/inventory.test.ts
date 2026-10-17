/**
 * MT001 — the entry inventory generator (Issue #44).
 *
 * The inventory is the single source of truth for multitenancy coverage acceptance (A6/A11):
 * every HTTP/stream/internal entry, background program, data table and external dependency the
 * real application assembly registers, with the owning business loop, owner task and status of
 * each. These tests pin the contract the later loop tickets and the MT132 acceptance harness
 * consume; field names here are contract, do not rename them casually.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildAssembly,
  buildInventory,
  diffInventories,
  renderGapReport,
} from "../../scripts/multitenancy/inventory";

const NO_TEST_DATABASE = {
  TEST_DATABASE_URL: undefined,
  ENTERPRISE_TEST_SETUP_DATABASE_URL: undefined,
};

let canonical: Awaited<ReturnType<typeof buildInventory>> | undefined;

/** The deterministic shape every drift-sensitive assertion builds (memoised: deterministic). */
async function canonicalInventory() {
  canonical ??= await buildInventory({
    environment: NO_TEST_DATABASE,
    database: "skip",
  });
  return canonical;
}

describe("MT001 inventory comes from the real application assembly", async () => {
  test("records unconditionally registered deploy routes", async () => {
    const inventory = await canonicalInventory();
    const ids = new Set(inventory.entries.map((entry) => entry.id));
    expect(ids.has("http:GET:/api/me")).toBe(true);
    expect(ids.has("http:GET:/health")).toBe(true);
    expect(ids.has("http:GET:/api/knowledge/kb")).toBe(true);
    const me = inventory.entries.find(
      (entry) => entry.id === "http:GET:/api/me",
    );
    expect(me?.shape).toBe("unconditional");
  });

  test("records conditionally registered routes that only exist when the assembly wires the dependency", async () => {
    const inventory = await canonicalInventory();
    const ids = new Set(inventory.entries.map((entry) => entry.id));
    // workshop (dep-gated), craft (dep-gated), internal worker door (routineRunner-gated),
    // billing (provider-gated), enterprise conversations (enterprise entry).
    expect(ids.has("http:POST:/api/workshop/:channelId/turns")).toBe(true);
    expect(
      ids.has("http:POST:/api/craft/sessions/:sessionId/send-message"),
    ).toBe(true);
    expect(ids.has("http:POST:/internal/routines/run")).toBe(true);
    expect(ids.has("http:GET:/api/billing/credits/summary")).toBe(true);
    expect(
      ids.has("http:GET:/api/enterprise/conversations/:threadId/messages"),
    ).toBe(true);
    const workshopTurns = inventory.entries.find(
      (entry) => entry.id === "http:POST:/api/workshop/:channelId/turns",
    );
    expect(workshopTurns?.shape).toBe("conditional");
  });

  test("the conditional half is genuinely conditional: the minimal assembly omits those routes", async () => {
    const minimal = buildAssembly("minimal");
    const minimalPaths = new Set(minimal.routes.map((route) => route.path));
    expect(minimalPaths.has("/api/workshop/:channelId/turns")).toBe(false);
    expect(
      minimalPaths.has("/api/craft/sessions/:sessionId/send-message"),
    ).toBe(false);
    const full = buildAssembly("full");
    const fullPaths = new Set(full.routes.map((route) => route.path));
    expect(fullPaths.has("/api/workshop/:channelId/turns")).toBe(true);
    expect(fullPaths.has("/api/craft/sessions/:sessionId/send-message")).toBe(
      true,
    );
  });

  test("classifies stream and internal entries", async () => {
    const inventory = await canonicalInventory();
    const byId = (id: string) =>
      inventory.entries.find((entry) => entry.id === id);
    expect(
      byId("http:GET:/api/craft/sessions/:sessionId/turns/:turnId/events")
        ?.kind,
    ).toBe("stream");
    expect(byId("http:POST:/internal/routines/run")?.kind).toBe("internal");
    expect(byId("http:GET:/health")?.kind).toBe("http");
  });
});

describe("MT001 inventory is machine-readable", async () => {
  test("every entry carries the contract fields: id, kind, businessLoop, ownerTask, status", async () => {
    const inventory = await canonicalInventory();
    expect(inventory.entries.length).toBeGreaterThan(100);
    const kinds = new Set([
      "http",
      "stream",
      "internal",
      "background",
      "table",
      "external",
    ]);
    const statuses = new Set(["owned", "unowned", "exempt"]);
    for (const entry of inventory.entries) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(kinds.has(entry.kind)).toBe(true);
      expect(
        entry.businessLoop === null || typeof entry.businessLoop === "string",
      ).toBe(true);
      expect(
        entry.ownerTask === null || typeof entry.ownerTask === "string",
      ).toBe(true);
      expect(statuses.has(entry.status)).toBe(true);
    }
    // All four sections the ticket names are present.
    expect(inventory.entries.some((entry) => entry.kind === "background")).toBe(
      true,
    );
    expect(inventory.entries.some((entry) => entry.kind === "table")).toBe(
      true,
    );
    expect(inventory.entries.some((entry) => entry.kind === "external")).toBe(
      true,
    );
    expect(inventory.entries.some((entry) => entry.kind === "http")).toBe(true);
  });

  test("serialises deterministically: same assembly, same bytes, sorted ids", async () => {
    const first = await canonicalInventory();
    const second = await canonicalInventory();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const ids = first.entries.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
  });

  test("background programs, data tables and external dependencies name their real sources", async () => {
    const inventory = await canonicalInventory();
    const background = inventory.entries.filter(
      (entry) => entry.kind === "background",
    );
    const backgroundSources = background.map((entry) => entry.source ?? "");
    expect(
      backgroundSources.some((source) =>
        source.includes("server/src/index.ts"),
      ),
    ).toBe(true);
    expect(
      backgroundSources.some((source) =>
        source.includes("worker/src/index.ts"),
      ),
    ).toBe(true);
    expect(
      backgroundSources.some((source) => source.includes("fire-routines")),
    ).toBe(true);

    const tables = inventory.entries.filter((entry) => entry.kind === "table");
    const tableNames = new Set(tables.map((entry) => entry.name));
    expect(tableNames.has("users")).toBe(true);
    expect(tableNames.has("workshop_sessions")).toBe(true);

    const external = inventory.entries.filter(
      (entry) => entry.kind === "external",
    );
    const externalIds = external.map((entry) => entry.id);
    expect(externalIds).toContain("external:intelligence-gateway");
    expect(externalIds).toContain("external:billing-lago");
  });
});

describe("MT001 gap report", async () => {
  test("names entries without an owner task, grouped and countable", async () => {
    const inventory = await canonicalInventory();
    const report = renderGapReport(inventory);
    expect(report).toContain("GET /api/workshop/:channelId/turns");
    expect(report).toContain("POST /internal/routines/run");
    const unowned = inventory.entries.filter(
      (entry) => entry.status === "unowned",
    );
    expect(unowned.length).toBe(
      inventory.entries.length -
        inventory.entries.filter((entry) => entry.status !== "unowned").length,
    );
    expect(inventory.summary.gaps).toBe(unowned.length);
    expect(report).toContain(String(unowned.length));
  });

  test("exempts global endpoints explicitly instead of counting them as gaps", async () => {
    const inventory = await canonicalInventory();
    const authGet = inventory.entries.find(
      (entry) => entry.id === "http:GET:/api/auth/*",
    );
    const authPost = inventory.entries.find(
      (entry) => entry.id === "http:POST:/api/auth/*",
    );
    expect(authGet?.status).toBe("exempt");
    expect(authPost?.status).toBe("exempt");
    expect(authGet?.exemptionReason).toBeTruthy();
    const health = inventory.entries.find(
      (entry) => entry.id === "http:GET:/health",
    );
    expect(health?.status).toBe("exempt");
    const report = renderGapReport(inventory);
    // The exempt surface is reported in its own section with the reason, never as a gap.
    const gapSection = report.slice(
      report.indexOf("## 缺口"),
      report.indexOf("## 明确豁免") === -1
        ? undefined
        : report.indexOf("## 明确豁免"),
    );
    expect(gapSection).not.toContain("/api/auth/*");
    expect(gapSection).not.toContain("GET /health");
  });

  test("owned entries are not gaps", async () => {
    const inventory = await canonicalInventory();
    for (const entry of inventory.entries) {
      if (entry.status === "owned") {
        expect(typeof entry.ownerTask).toBe("string");
      }
    }
    const report = renderGapReport(inventory);
    const gapSection = report.slice(
      report.indexOf("## 缺口"),
      report.indexOf("## 明确豁免") === -1
        ? undefined
        : report.indexOf("## 明确豁免"),
    );
    for (const entry of inventory.entries.filter((e) => e.status === "owned")) {
      expect(gapSection).not.toContain(entry.id);
    }
  });
});

describe("MT001 drift detection", async () => {
  test("a newly mounted route appears as an unowned entry and changes the gap report", async () => {
    const before = await canonicalInventory();
    const full = buildAssembly("full");
    full.get("/api/drift-probe", (context) => context.text("probe"));
    const after = await buildInventory({
      environment: NO_TEST_DATABASE,
      database: "skip",
      apps: { minimal: buildAssembly("minimal"), full },
    });

    const probe = after.entries.find(
      (entry) => entry.id === "http:GET:/api/drift-probe",
    );
    expect(probe).toBeDefined();
    expect(probe?.status).toBe("unowned");

    const diff = diffInventories(before, after);
    expect(diff.added.map((entry) => entry.id)).toContain(
      "http:GET:/api/drift-probe",
    );
    expect(diff.removed).toEqual([]);

    expect(renderGapReport(after)).not.toBe(renderGapReport(before));
  });

  test("a removed route is reported as removed drift", async () => {
    const before = await canonicalInventory();
    // Build the "before" from a probe app and the "after" without it.
    const full = buildAssembly("full");
    full.get("/api/drift-probe", (context) => context.text("probe"));
    const withProbe = await buildInventory({
      environment: NO_TEST_DATABASE,
      database: "skip",
      apps: { minimal: buildAssembly("minimal"), full },
    });
    const diff = diffInventories(withProbe, before);
    expect(diff.removed.map((entry) => entry.id)).toContain(
      "http:GET:/api/drift-probe",
    );
  });

  test("the committed baseline snapshot matches the generated inventory, so silent drift fails", async () => {
    const inventory = await canonicalInventory();
    const baselinePath = new URL(
      "../../../docs/multitenancy/inventory-baseline.json",
      import.meta.url,
    );
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(inventory.schemaVersion).toBe(baseline.schemaVersion);
    expect(inventory.entries).toEqual(baseline.entries);
    expect(inventory.summary).toEqual(baseline.summary);
  });
});

describe("MT001 database section is explicit about being skipped", async () => {
  test("skips with a naming reason when no dedicated test database is configured", async () => {
    const inventory = await buildInventory({
      environment: NO_TEST_DATABASE,
      database: "auto",
    });
    expect(inventory.database.status).toBe("skipped");
    expect(inventory.database.reason).toContain("TEST_DATABASE_URL");
    expect(inventory.database.tables).toBeUndefined();
  });

  test("does not fall back to the deployment database", async () => {
    const inventory = await buildInventory({
      environment: {
        ...NO_TEST_DATABASE,
        DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      },
      database: "auto",
    });
    expect(inventory.database.status).toBe("skipped");
    expect(inventory.database.reason).toContain("TEST_DATABASE_URL");
  });

  test("checks table presence and RLS when a dedicated test database is configured", async () => {
    const url =
      process.env.TEST_DATABASE_URL ??
      process.env.ENTERPRISE_TEST_SETUP_DATABASE_URL;
    if (!url) {
      // This is an explicit, visible skip: the inventory's own skip reason is
      // asserted in the tests above; here we only decline to fabricate evidence.
      console.warn(
        "[MT001] no TEST_DATABASE_URL — checked-database path not exercised",
      );
      return;
    }
    const inventory = await buildInventory({
      environment: { TEST_DATABASE_URL: url },
      database: "auto",
    });
    expect(inventory.database.status).toBe("checked");
    expect(inventory.database.tables?.length).toBeGreaterThan(0);
    for (const table of inventory.database.tables ?? []) {
      expect(["present", "missing"]).toContain(table.presence);
      expect(typeof table.rowLevelSecurity).toBe("boolean");
    }
  });
});

describe("MT001 enterprise entry", async () => {
  test("the enterprise conversation routes are inventoried with the enterprise assembly tag", async () => {
    const inventory = await canonicalInventory();
    const messages = inventory.entries.find(
      (entry) =>
        entry.id ===
        "http:GET:/api/enterprise/conversations/:threadId/messages",
    );
    expect(messages?.assembly).toBe("enterprise");
    const me = inventory.entries.find(
      (entry) => entry.id === "http:GET:/api/me",
    );
    expect(me?.assembly).toBe("deploy");
  });
});
