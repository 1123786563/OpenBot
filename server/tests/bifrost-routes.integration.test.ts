import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, like, or } from "drizzle-orm";
import { createBifrostAdminRoutes } from "../src/admin/bifrost-routes";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import { fixtureTraceReport } from "./support/bifrost-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

test("admin verification imports trusted evidence and publishes durable Price Versions", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const dir = await mkdtemp(join(tmpdir(), "bifrost-evidence-test-"));
  const rows = or(
    eq(enterpriseSettings.key, "bifrost_pilot_catalog"),
    like(enterpriseSettings.key, "bifrost_pilot_release:%"),
  );
  const api = createBifrostAdminRoutes(
    async (context, next) => {
      const role = context.req.header("test-role");
      if (!role) return context.json({}, 401);
      context.set("actor", {
        id: role,
        email: "test@example.test",
        role: role === "admin" ? "admin" : "user",
      });
      await next();
    },
    database,
    dir,
  );
  const request = (path: string, method = "GET", body?: unknown) =>
    api.request(path, {
      method,
      headers: { "test-role": "admin", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const harnessImage = `agent-langgraph-agui@sha256:${"b".repeat(64)}`;
  const a = {
    provider: "openai",
    model: "fixture-a",
    gatewayRevision: "a",
    meteringRevision: "a",
    maxInputTokens: 100,
    maxOutputTokens: 10,
    tools: false,
    price: { inputPerMillion: 1_000_000, outputPerMillion: 2_000_000 },
  };
  try {
    await database.delete(enterpriseSettings).where(rows);
    expect((await api.request("/")).status).toBe(401);
    expect(
      (await api.request("/", { headers: { "test-role": "user" } })).status,
    ).toBe(403);
    const configure = await request("/configuration", "PUT", {
      harnessImage,
      routes: { a },
    });
    expect(configure.status).toBe(200);
    const { catalog } = await configure.json();
    const revision = catalog.routes.a.revision;
    const report = fixtureTraceReport(harnessImage, { ...a, revision });
    const publish = () =>
      request("/publication", "POST", { routes: ["a"], defaultRoute: "a" });
    expect((await request("/routes/a/verify", "POST", report)).status).toBe(
      400,
    );
    expect(
      (await request("/routes/a/verify", "POST", { revision })).status,
    ).toBe(409);
    expect((await publish()).status).toBe(409);
    const wrongModel = structuredClone(report);
    wrongModel.stream.upstream.model = "unapproved-model";
    const file = join(dir, `${revision}.json`);
    await Bun.write(file, JSON.stringify(wrongModel));
    expect(
      (await request("/routes/a/verify", "POST", { revision })).status,
    ).toBe(409);
    expect((await publish()).status).toBe(409);
    await Bun.write(file, JSON.stringify(report));
    expect(
      (await request("/routes/a/verify", "POST", { revision })).status,
    ).toBe(200);
    const response = await publish();
    expect(response.status).toBe(201);
    const { release, active } = await response.json();
    expect(active.defaultRoute).toBe("a");
    expect(active.options[0].maxChargeMicrocredits).toBe("120");
    expect(
      (await request("/configuration", "PUT", { harnessImage, routes: {} }))
        .status,
    ).toBe(200);
    const current = await (await request("/")).json();
    expect(current.active.defaultRoute).toBeNull();
    expect(current.active.options).toEqual([]);
    expect(
      await (await request(`/price-versions/${release.id}`)).json(),
    ).toEqual(release);
  } finally {
    await database.delete(enterpriseSettings).where(rows);
    await database.$client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
