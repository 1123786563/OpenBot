import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AppVariables, createRequireUser } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { opikEvaluations, personalMemories, users } from "../src/db/schema";
import { sweepEvaluationCleanup } from "../src/opik/evaluation-cleanup";
import { createOpikEvaluationRoutes } from "../src/opik/evaluation-routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.close());

const operator = "eval-operator";
const owner = crypto.randomUUID();
const outsider = crypto.randomUUID();
const requireUser = createRequireUser(
  {
    handler: () => new Response(null, { status: 404 }),
    api: {
      getSession: async ({ headers }) => {
        const id = headers.get("x-test-actor");
        return id ? { user: { id, email: `${id}@example.test` } } : null;
      },
    },
  },
  {
    rolesForUser: async (id) => [
      id === owner || id === outsider ? "user" : "admin",
    ],
  },
);

function request(method: string, actor?: string, body?: unknown) {
  const headers = new Headers();
  if (actor) headers.set("x-test-actor", actor);
  if (body !== undefined) headers.set("content-type", "application/json");
  return {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function mount(
  apiUrl: URL,
  project: string,
  realApiUrl?: URL,
  dailyCaseLimit = 2,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createOpikEvaluationRoutes({
      database,
      requireUser,
      config: {
        synthetic: { apiUrl, project },
        operators: new Set([operator]),
        dailyCaseLimit,
        ...(realApiUrl
          ? { real: { apiUrl: realApiUrl, project: "private-eval" } }
          : {}),
      },
    }),
  );
  return app;
}

test("only designated operators can spend the platform budget and view synthetic evaluation results", async () => {
  const paths: string[] = [];
  const fixture = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      paths.push(new URL(req.url).pathname);
      return new Response(null, { status: 204 });
    },
  });
  const project = `openbot-eval-${crypto.randomUUID()}`;
  try {
    const app = mount(new URL("/api/", fixture.url), project);
    const path = "/admin/synthetic";
    const body = { requestId: crypto.randomUUID() };
    const competingBody = { requestId: crypto.randomUUID() };
    expect(
      (await app.request(path, request("POST", undefined, body))).status,
    ).toBe(401);
    expect(
      (await app.request(path, request("POST", "other-admin", body))).status,
    ).toBe(403);
    const results = await Promise.all([
      app.request(path, request("POST", operator, body)),
      app.request(path, request("POST", operator, competingBody)),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
    const winner = results.find((result) => result.ok);
    if (!winner) throw new Error("Expected one platform budget reservation");
    const { id } = z.object({ id: z.uuid() }).parse(await winner.json());
    const replay = await app.request(
      path,
      request("POST", operator, results[0]?.ok ? body : competingBody),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id });
    expect(
      (await app.request(`${path}/${id}`, request("GET", owner))).status,
    ).toBe(403);
    const view = await app.request(`${path}/${id}`, request("GET", operator));
    expect(view.headers.get("content-type")).toContain("text/html");
    expect(await view.text()).toContain("exact_match");
    expect(paths).toEqual([
      "/api/v1/private/datasets/items",
      "/api/v1/private/experiments/items/bulk",
      `/api/v1/private/experiments/${id}`,
    ]);
  } finally {
    fixture.stop(true);
    await database
      .delete(opikEvaluations)
      .where(eq(opikEvaluations.project, project));
  }
});

const realOpik = process.env.TEST_OPIK_API_URL;
test.skipIf(!realOpik)(
  "self-hosted Opik returns the synthetic experiment and its actual score",
  async () => {
    if (!realOpik) throw new Error("TEST_OPIK_API_URL required");
    const project = `openbot-issue49-${crypto.randomUUID()}`;
    try {
      const app = mount(new URL(realOpik), project, undefined, 100);
      const response = await app.request(
        "/admin/synthetic",
        request("POST", operator, {
          requestId: crypto.randomUUID(),
        }),
      );
      const result = await response.json();
      expect(response.status).toBe(200);
      const view = await app.request(
        `/admin/synthetic/${result.id}`,
        request("GET", operator),
      );
      expect(await view.text()).toContain(result.experiment);
      const endpoint = new URL(`v1/private/experiments/${result.id}`, realOpik);
      for (let attempt = 0; attempt < 30; attempt++) {
        const readback = await fetch(endpoint);
        if (readback.ok) {
          const experiment = await readback.json();
          if (
            experiment.feedback_scores?.some(
              (score: { name: string; value: number }) =>
                score.name === "exact_match" && score.value === 0.5,
            )
          ) {
            expect(experiment.name).toBe(result.experiment);
            const confirmedView = await app.request(
              `/admin/synthetic/${result.id}`,
              request("GET", operator),
            );
            expect(await confirmedView.text()).toContain(
              "Opik exact match: 0.5",
            );
            console.info(
              JSON.stringify({
                project,
                experiment: result.id,
                exactMatch: 0.5,
              }),
            );
            return;
          }
        }
        await Bun.sleep(1000);
      }
      throw new Error(`Opik did not return experiment score for ${result.id}`);
    } finally {
      await database
        .delete(opikEvaluations)
        .where(eq(opikEvaluations.project, project));
    }
  },
  45_000,
);

test("only the owner can authorize an exact memory snapshot and revocation records an attempted sample for cleanup", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let failUpload = false;
  const traces = new Map<string, unknown>();
  const fetchFixture = async (req: Request) => {
    const path = new URL(req.url).pathname;
    const id = path.split("/").at(-1) ?? "";
    if (req.method === "DELETE") {
      traces.delete(id);
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET") {
      return traces.has(id)
        ? Response.json(traces.get(id))
        : new Response(null, { status: 404 });
    }
    const body = await req.json();
    calls.push({ path, body });
    if (path.endsWith("/traces/batch")) {
      for (const trace of z
        .object({
          traces: z.array(z.object({ id: z.uuid(), input: z.unknown() })),
        })
        .parse(body).traces) {
        traces.set(trace.id, trace.input);
      }
    }
    return new Response(null, { status: failUpload ? 503 : 204 });
  };
  const start = (port: number) =>
    Bun.serve({ port, hostname: "127.0.0.1", fetch: fetchFixture });
  let fixture = start(0);
  try {
    await database.insert(users).values(
      [owner, outsider].map((id) => ({
        id,
        email: `${id}@example.test`,
        name: id,
      })),
    );
    const memoryId = crypto.randomUUID();
    const otherMemoryId = crypto.randomUUID();
    const content = "  synthetic   memory ";
    await database.insert(personalMemories).values(
      [memoryId, otherMemoryId].map(
        (id): typeof personalMemories.$inferInsert => ({
          id,
          ownerUserId: owner,
          content,
          provenance: "synthetic test",
          reviewState: "confirmed",
        }),
      ),
    );
    const grant = {
      memoryId,
      contentSha256: new Bun.CryptoHasher("sha256")
        .update(content)
        .digest("hex"),
      purpose: "normalization-fidelity",
    };
    const app = mount(
      new URL("http://synthetic.example.test/api/"),
      "synthetic",
      new URL("/api/", fixture.url),
      100,
    );
    expect(
      (await app.request("/grants", request("POST", outsider, grant))).status,
    ).toBe(404);
    const issued = await app.request("/grants", request("POST", owner, grant));
    expect(issued.status).toBe(201);
    const { id } = await issued.json();
    const run = { ...grant, grantId: id };
    const submit = (body: unknown) =>
      app.request("/admin/real", request("POST", operator, body));
    expect(
      (await submit({ ...run, grantId: crypto.randomUUID() })).status,
    ).toBe(404);
    expect((await submit({ ...run, purpose: "model-training" })).status).toBe(
      400,
    );
    expect((await submit({ ...run, memoryId: otherMemoryId })).status).toBe(
      404,
    );
    expect(calls).toHaveLength(0);
    const result = await submit(run);
    expect(result.status).toBe(200);
    const { traceId } = await result.json();
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]?.body)).toContain(content);
    expect(
      (await app.request(`/grants/${id}`, request("DELETE", outsider))).status,
    ).toBe(404);
    expect(
      (await app.request(`/grants/${id}`, request("DELETE", owner))).status,
    ).toBe(200);
    expect((await submit(run)).status).toBe(404);
    expect(calls).toHaveLength(2);
    const secondGrant = { ...grant, memoryId: otherMemoryId };
    const secondIssue = await app.request(
      "/grants",
      request("POST", owner, secondGrant),
    );
    expect(secondIssue.status).toBe(201);
    const secondId = z
      .object({ id: z.uuid() })
      .parse(await secondIssue.json()).id;
    const secondRun = { ...secondGrant, grantId: secondId };
    failUpload = true;
    const failed = await submit(secondRun);
    expect(failed.status).toBe(502);
    const failedTraceId = z
      .object({ traceId: z.uuid() })
      .parse(await failed.json()).traceId;
    expect(calls).toHaveLength(3);
    await database
      .update(personalMemories)
      .set({ content: "edited synthetic memory" })
      .where(eq(personalMemories.id, otherMemoryId));
    expect((await submit(secondRun)).status).toBe(404);
    expect(calls).toHaveLength(3);
    const restarted = mount(
      new URL("http://synthetic.example.test/api/"),
      "synthetic",
      new URL("/api/", fixture.url),
      100,
    );
    const cleanup = await restarted.request(
      "/admin/cleanup",
      request("GET", operator),
    );
    expect(cleanup.status).toBe(200);
    expect(await cleanup.json()).toEqual(
      expect.objectContaining({
        samples: expect.arrayContaining([
          expect.objectContaining({ traceId, project: "private-eval" }),
          expect.objectContaining({
            traceId: failedTraceId,
            project: "private-eval",
          }),
        ]),
      }),
    );
    const destination = {
      apiUrl: new URL("/api/", fixture.url),
      project: "private-eval",
    };
    const port = fixture.port;
    if (!port) throw new Error("Missing test Opik port");
    fixture.stop(true);
    const at = Date.now();
    await sweepEvaluationCleanup(database, destination, () => at);
    expect(traces.has(traceId)).toBe(true);
    expect(traces.has(failedTraceId)).toBe(true);
    fixture = start(port);
    await sweepEvaluationCleanup(database, destination, () => at + 60_000);
    expect(traces.size).toBe(0);
    // Simulate a late write from the acknowledged-lost upload.
    traces.set(failedTraceId, { text: content });
    await sweepEvaluationCleanup(database, destination, () => at + 660_000);
    expect(traces.size).toBe(0);
    const verified = await restarted.request(
      "/admin/cleanup",
      request("GET", operator),
    );
    expect(await verified.json()).toMatchObject({
      samples: expect.arrayContaining([
        expect.objectContaining({ traceId, completedAt: expect.any(String) }),
        expect.objectContaining({
          traceId: failedTraceId,
          completedAt: expect.any(String),
        }),
      ]),
    });
  } finally {
    fixture.stop(true);
    await database
      .delete(opikEvaluations)
      .where(eq(opikEvaluations.project, "private-eval"));
    await database.delete(users).where(eq(users.id, owner));
    await database.delete(users).where(eq(users.id, outsider));
  }
});
