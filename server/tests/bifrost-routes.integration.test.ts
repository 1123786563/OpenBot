import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, like, or } from "drizzle-orm";
import { createBifrostAdminRoutes } from "../src/admin/bifrost-routes";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema";
import {
  fixtureEmbeddingReport,
  fixtureTraceReport,
} from "./support/bifrost-evidence";
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
    const terminalRecord = JSON.stringify({
      requestId: report.cancellation.upstream.requestId,
      outcome: "cancelled",
      terminatedAt: report.cancellation.upstream.terminal.terminatedAt,
    });
    report.cancellation.upstream.terminal.recordDigest = `sha256:${Bun.CryptoHasher.hash("sha256", terminalRecord, "hex")}`;
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
    ).toBe(409);
    const terminalFile = join(dir, `${revision}.cancel.json`);
    await Bun.write(terminalFile, "{}");
    expect(
      (await request("/routes/a/verify", "POST", { revision })).status,
    ).toBe(409);
    const wrongRecord = terminalRecord.replace(
      report.cancellation.upstream.requestId,
      "different-request",
    );
    const wrongRecordReport = structuredClone(report);
    wrongRecordReport.cancellation.upstream.terminal.recordDigest = `sha256:${Bun.CryptoHasher.hash("sha256", wrongRecord, "hex")}`;
    await Bun.write(file, JSON.stringify(wrongRecordReport));
    await Bun.write(terminalFile, wrongRecord);
    expect(
      (await request("/routes/a/verify", "POST", { revision })).status,
    ).toBe(409);
    await Bun.write(file, JSON.stringify(report));
    await Bun.write(terminalFile, terminalRecord);
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

    const embed = {
      ...a,
      purpose: "embedding" as const,
      maxOutputTokens: 0,
      price: { inputPerMillion: 500_000, outputPerMillion: 0 },
    };
    const configured = await request("/configuration", "PUT", {
      harnessImage,
      routes: { embed },
    });
    expect(configured.status).toBe(200);
    const embedding = await configured.json();
    const embeddingRevision = embedding.catalog.routes.embed.revision;
    const embeddingReport = fixtureEmbeddingReport(harnessImage, {
      ...embed,
      revision: embeddingRevision,
    });
    await Bun.write(
      join(dir, `${embeddingRevision}.json`),
      JSON.stringify(embeddingReport),
    );
    expect(
      (
        await request("/routes/embed/verify", "POST", {
          revision: embeddingRevision,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/publication", "POST", {
          routes: ["embed"],
          defaultRoute: "embed",
        })
      ).status,
    ).toBe(409);
    const embeddingPublication = await request("/publication", "POST", {
      routes: ["embed"],
      defaultRoute: null,
    });
    expect(embeddingPublication.status).toBe(201);
    expect(await embeddingPublication.json()).toMatchObject({
      active: {
        defaultRoute: null,
        options: [{ purpose: "embedding", maxChargeMicrocredits: "50" }],
      },
    });
  } finally {
    await database.delete(enterpriseSettings).where(rows);
    await database.$client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two verified provider routes publish together and an unverified route cannot join the release", async () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const dir = await mkdtemp(join(tmpdir(), "bifrost-two-routes-"));
  const rows = or(
    eq(enterpriseSettings.key, "bifrost_pilot_catalog"),
    like(enterpriseSettings.key, "bifrost_pilot_release:%"),
  );
  const api = createBifrostAdminRoutes(
    async (context, next) => {
      context.set("actor", {
        id: "admin",
        email: "admin@example.test",
        role: "admin",
      });
      await next();
    },
    database,
    dir,
  );
  const request = (path: string, method = "GET", body?: unknown) =>
    api.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const harnessImage = `agent-langgraph-agui@sha256:${"c".repeat(64)}`;
  const primary = {
    provider: "openai",
    model: "fixture-primary",
    gatewayRevision: "primary-gateway",
    meteringRevision: "primary-meter",
    maxInputTokens: 100,
    maxOutputTokens: 20,
    tools: true,
    price: { inputPerMillion: 1_000_001, outputPerMillion: 2_000_000 },
  };
  const alternate = {
    provider: "anthropic",
    model: "fixture-alternate",
    gatewayRevision: "alternate-gateway",
    meteringRevision: "alternate-meter",
    maxInputTokens: 200,
    maxOutputTokens: 10,
    tools: false,
    price: { inputPerMillion: 250_000, outputPerMillion: 1_000_000 },
  };
  try {
    await database.delete(enterpriseSettings).where(rows);
    const configured = await request("/configuration", "PUT", {
      harnessImage,
      routes: { primary, alternate },
    });
    expect(configured.status).toBe(200);
    const { catalog } = await configured.json();
    const revisions = {
      primary: catalog.routes.primary.revision as string,
      alternate: catalog.routes.alternate.revision as string,
    };
    expect(revisions.primary).not.toBe(revisions.alternate);

    // Publishing before any evidence exists is refused and stores no release.
    expect(
      (
        await request("/publication", "POST", {
          routes: ["primary", "alternate"],
          defaultRoute: "primary",
        })
      ).status,
    ).toBe(409);
    expect((await (await request("/")).json()).active.options).toEqual([]);

    const evidence = {
      primary: fixtureTraceReport(harnessImage, {
        ...primary,
        revision: revisions.primary,
      }),
      alternate: fixtureTraceReport(harnessImage, {
        ...alternate,
        revision: revisions.alternate,
      }),
    };
    for (const id of ["primary", "alternate"] as const) {
      const report = evidence[id];
      const terminalRecord = JSON.stringify({
        requestId: report.cancellation.upstream.requestId,
        outcome: "cancelled",
        terminatedAt: report.cancellation.upstream.terminal.terminatedAt,
      });
      report.cancellation.upstream.terminal.recordDigest = `sha256:${Bun.CryptoHasher.hash("sha256", terminalRecord, "hex")}`;
      await Bun.write(
        join(dir, `${revisions[id]}.json`),
        JSON.stringify(report),
      );
      await Bun.write(
        join(dir, `${revisions[id]}.cancel.json`),
        terminalRecord,
      );
    }
    // Evidence for both routes is on disk, but only the primary is verified.
    const verify = (id: "primary" | "alternate") =>
      request(`/routes/${id}/verify`, "POST", { revision: revisions[id] });
    expect((await verify("primary")).status).toBe(200);
    expect(
      (
        await request("/publication", "POST", {
          routes: ["primary", "alternate"],
          defaultRoute: "primary",
        })
      ).status,
    ).toBe(409);
    const partial = await request("/publication", "POST", {
      routes: ["primary"],
      defaultRoute: "primary",
    });
    expect(partial.status).toBe(201);
    const { release: partialRelease } = await partial.json();
    expect(
      partialRelease.routes.map((route: { id: string }) => route.id),
    ).toEqual(["primary"]);
    // The durable Price Version must not carry an unverified route either.
    expect(
      (
        await (await request(`/price-versions/${partialRelease.id}`)).json()
      ).routes.map((route: { id: string }) => route.id),
    ).toEqual(["primary"]);

    expect((await verify("alternate")).status).toBe(200);
    for (const id of ["primary", "alternate"] as const) {
      const { catalog: snapshot } = await (await request("/")).json();
      const report = snapshot.routes[id].verification.report;
      // Streaming, cancellation, creditable usage and tool proof survive verification.
      expect(report.version).toBe(3);
      expect(report.stream.gateway.usage).toEqual(report.stream.upstream.usage);
      expect(report.stream.upstream.usage).toEqual({
        inputTokens: 1,
        outputTokens: 2,
      });
      expect(report.cancellation.upstream.terminal.outcome).toBe("cancelled");
      expect(report.cancellation.upstream.terminal.requestId).toBe(
        report.cancellation.upstream.requestId,
      );
      expect(report.stream.meter.inputTokenUpperBound).toBe(
        (id === "primary" ? primary : alternate).maxInputTokens,
      );
      expect(Boolean(report.tool)).toBe(
        (id === "primary" ? primary : alternate).tools,
      );
    }

    const released = await request("/publication", "POST", {
      routes: ["primary", "alternate"],
      defaultRoute: "alternate",
    });
    expect(released.status).toBe(201);
    const { release, active } = await released.json();
    expect(release.routes.map((route: { id: string }) => route.id)).toEqual([
      "primary",
      "alternate",
    ]);
    expect(release.defaultRoute).toBe("alternate");
    expect(active.defaultRoute).toBe("alternate");
    expect(active.priceVersion).toBe(release.id);
    // Cost bounds are rounded up per route: 140.0001 → 141, 60 exactly → 60.
    expect(
      active.options.map(
        (option: { id: string; maxChargeMicrocredits: string }) => [
          option.id,
          option.maxChargeMicrocredits,
        ],
      ),
    ).toEqual([
      ["primary", "141"],
      ["alternate", "60"],
    ]);
    // The stored Price Version is durable and still readable through the admin API.
    expect(
      await (await request(`/price-versions/${release.id}`)).json(),
    ).toEqual(release);
  } finally {
    await database.delete(enterpriseSettings).where(rows);
    await database.$client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
