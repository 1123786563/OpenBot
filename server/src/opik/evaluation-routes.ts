import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html } from "hono/html";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { opikEvaluationGrants, opikEvaluations } from "../db/schema";
import {
  type OpikEvaluationConfig,
  readSyntheticScore,
  runSynthetic,
  syntheticCases,
} from "./evaluation";
import {
  grantEvaluation,
  realRunInput,
  revokeEvaluation,
  runRealEvaluation,
  scopeInput,
} from "./evaluation-grants";

type Env = { Variables: AppVariables };
const requestInput = z.strictObject({
  requestId: z.uuid().transform((id) => id.toLowerCase()),
});

export function createOpikEvaluationRoutes({
  database,
  requireUser,
  config,
}: {
  database: Database;
  requireUser: MiddlewareHandler<Env>;
  config?: OpikEvaluationConfig;
}) {
  const routes = new Hono<Env>();
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  routes.use("*", requireUser);
  routes.use("/admin/*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!config?.operators.has(context.var.actor.id))
      return context.json(
        { error: "Evaluation operator access required." },
        403,
      );
    await next();
  });

  const limit = bodyLimit({ maxSize: 2048 });
  const json = async (context: Context<Env>) =>
    context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ===
    "application/json"
      ? context.req.json().catch(() => undefined)
      : undefined;

  routes.post("/grants", limit, async (context) => {
    if (!config?.real)
      return context.json({ error: "Real evaluation is disabled." }, 503);
    const scope = scopeInput.safeParse(await json(context));
    if (!scope.success)
      return context.json(
        {
          error: "Provide a memory ID, content digest, and supported purpose.",
        },
        400,
      );
    const grant = await grantEvaluation(
      database,
      context.var.actor.id,
      scope.data,
    );
    if (!grant) return context.notFound();
    return context.json(grant, 201);
  });

  routes.delete("/grants/:id", async (context) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.notFound();
    const grant = await revokeEvaluation(
      database,
      context.var.actor.id,
      id.data,
    );
    if (!grant) return context.notFound();
    return context.json(grant);
  });

  routes.post("/admin/real", limit, async (context) => {
    if (!config?.real)
      return context.json({ error: "Real evaluation is disabled." }, 503);
    const input = realRunInput.safeParse(await json(context));
    if (!input.success)
      return context.json(
        { error: "Provide an authorized evaluation scope and purpose." },
        400,
      );
    const result = await runRealEvaluation({
      database,
      config: config.real,
      dailyCaseLimit: config.dailyCaseLimit,
      operatorId: context.var.actor.id,
      run: input.data,
    });
    if (result === "unavailable") return context.notFound();
    if (result === "exhausted")
      return context.json(
        { error: "Platform evaluation budget exhausted." },
        429,
      );
    return context.json(
      result,
      result.status === "completed"
        ? 200
        : result.status === "pending"
          ? 202
          : 502,
    );
  });

  routes.get("/admin/cleanup", async (context) => {
    const cursor = z.uuid().optional().safeParse(context.req.query("after"));
    if (!cursor.success)
      return context.json({ error: "Invalid cleanup cursor." }, 400);
    const samples = await database
      .select({
        traceId: opikEvaluations.id,
        project: opikEvaluations.project,
        apiUrl: opikEvaluations.target,
        workspace: opikEvaluations.workspace,
        requestedAt: opikEvaluationGrants.revokedAt,
        completedAt: opikEvaluations.cleanupCompletedAt,
      })
      .from(opikEvaluationGrants)
      .innerJoin(
        opikEvaluations,
        eq(opikEvaluations.requestId, opikEvaluationGrants.id),
      )
      .where(
        and(
          eq(opikEvaluations.kind, "real"),
          isNotNull(opikEvaluationGrants.revokedAt),
          cursor.data ? gt(opikEvaluations.id, cursor.data) : undefined,
        ),
      )
      .orderBy(asc(opikEvaluations.id))
      .limit(100);
    return context.json({
      samples,
      next: samples.length === 100 ? samples.at(-1)?.traceId : undefined,
    });
  });

  routes.post("/admin/synthetic", limit, async (context) => {
    if (!config) return context.json({ error: "Evaluation is disabled." }, 503);
    const input = requestInput.safeParse(await json(context));
    if (!input.success)
      return context.json({ error: "Provide a valid requestId." }, 400);
    const result = await runSynthetic(
      database,
      config,
      context.var.actor.id,
      input.data.requestId,
    );
    if (result.kind === "exhausted")
      return context.json(
        { error: "Platform evaluation budget exhausted." },
        429,
      );
    if (result.kind === "conflict")
      return context.json({ error: "Request ID already reserved." }, 409);
    const { id, status, project } = result.evaluation;
    return context.json(
      { id, status, project, experiment: `openbot-synthetic-${id}` },
      status === "completed" ? 200 : status === "pending" ? 202 : 502,
    );
  });

  routes.get("/admin/synthetic/:id", async (context: Context<Env>) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success) return context.notFound();
    const [evaluation] = await database
      .select()
      .from(opikEvaluations)
      .where(
        and(
          eq(opikEvaluations.id, id.data),
          eq(opikEvaluations.kind, "synthetic"),
        ),
      );
    if (!evaluation) return context.notFound();
    const opikScore =
      evaluation.status === "completed" &&
      config?.synthetic.project === evaluation.project
        ? await readSyntheticScore(config.synthetic, evaluation.id)
        : undefined;
    context.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    return context.html(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Synthetic evaluation</title></head>
<body><main><h1>Synthetic evaluation</h1>
<p>Opik project: ${evaluation.project}</p>
<p>Experiment: openbot-synthetic-${evaluation.id}</p>
<p>Status: ${evaluation.status}</p>
${evaluation.status === "completed" ? html`<p>Opik exact match: ${opikScore ?? "awaiting readback"}</p>` : ""}
${
  evaluation.status === "completed"
    ? html`<table>
<caption>Synthetic evaluation results</caption>
<thead><tr><th>Input</th><th>Expected</th><th>Output</th><th>exact_match</th></tr></thead>
<tbody>${syntheticCases.map(({ input, expected, output, score }) => html`<tr><td>${input}</td><td>${expected}</td><td>${output}</td><td>${score}</td></tr>`)}</tbody>
</table>`
    : ""
}
</main></body></html>`);
  });

  return routes;
}
