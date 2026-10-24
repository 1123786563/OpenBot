import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "../hindsight/bank-scope";
import type { HindsightPauseControlsService } from "../hindsight/pause-controls";
import type { HindsightMemoryRoutes } from "../hindsight/routes";
import { PluginRefusedError } from "../plugins/store";
import type { MemoryIngestion } from "./ingestion";
import type { MemoryStore } from "./store";
import {
  MemoryNotFoundError,
  MemoryRefusedError,
  parsePauseControlPatch,
} from "./types";

const log = getLogger("server");

/**
 * The person's own pause switches (#392 F-G1-1): the two states, behind the deployment's
 * server-issued scope. Exactly one trusted identity path — the request is resolved to a
 * `PlatformScope` by the deployment's own resolver, and `resolveHindsightBankScope` turns it
 * into the (tenant, principal) the switches are keyed by. A tenant, principal or bank id on the
 * wire is refused by the patch schema, never consulted.
 */
export type MemoryPauseControlAccess = {
  pause: HindsightPauseControlsService;
  resolveScope: (request: Request) => Promise<PlatformScope>;
};

export function createMemoryRoutes(
  store: MemoryStore,
  ingestion: MemoryIngestion,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: {
    pauseControls?: MemoryPauseControlAccess;
    /**
     * The Hindsight chain's person-scoped operations (#384/#385), mounted at `/hindsight` under
     * this same family's `requireUser` + body limit. Absent when the deployment wired no
     * Hindsight chain, and then none of those routes exists.
     */
    hindsight?: HindsightMemoryRoutes;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  routes.onError((error, context) => {
    if (error instanceof MemoryNotFoundError)
      return context.json({ error: error.message }, 404);
    // A connector's policy refusing the read is an answer to give the person, as it is on the
    // plugin routes, and the same sentence `sync` saves on the source.
    if (
      error instanceof MemoryRefusedError ||
      error instanceof PluginRefusedError
    )
      return context.json({ error: error.message }, 400);
    // The trusted-scope seams refuse with canonical codes (the MT005/#82 discipline): no
    // session is 401, a missing company/team selection is 400, and a foreign subject or a
    // scope nobody issued is 403 — never a guessed default identity.
    const code = error instanceof Error ? error.message : "";
    if (code === "AUTH_REQUIRED") return context.json({ error: code }, 401);
    if (code === "TENANT_REQUIRED" || code === "WORKSPACE_REQUIRED")
      return context.json({ error: code }, 400);
    if (code === "TENANT_FORBIDDEN" || code === "UNVERIFIED_SCOPE")
      return context.json({ error: code }, 403);
    log.error(
      {
        type: "memory-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      },
      "memory-route-error",
    );
    return context.json({ error: "Memory is unavailable. Try again." }, 503);
  });
  routes.get("/", async (context) =>
    context.json({ memories: await store.list(context.var.actor.id) }),
  );
  /*
   * Hindsight 14 (#392, F-G1-1): the person's own two pause switches — read here, written here,
   * under the same `/api/memory` family as the memories they control. Mounted only where the
   * deployment can resolve a trusted scope (enterprise capabilities wired); a deployment that
   * cannot prove who is asking mounts no such face at all rather than one that guesses an
   * identity, so the path simply does not exist there.
   */
  if (options.pauseControls) {
    const { pause, resolveScope } = options.pauseControls;
    const identityFor = (request: Request) =>
      resolveScope(request).then(resolveHindsightBankScope);
    routes.get("/pause-controls", async (context) => {
      const identity = await identityFor(context.req.raw);
      return context.json({
        pauseControls: await pause.getPauseState(
          identity.tenantId,
          identity.principalId,
        ),
      });
    });
    routes.post("/pause-controls", async (context) => {
      const identity = await identityFor(context.req.raw);
      const patch = parsePauseControlPatch(await body(context.req.raw));
      if (patch.learningPaused !== undefined)
        await pause.setLearningPaused(
          identity.tenantId,
          identity.principalId,
          patch.learningPaused,
        );
      if (patch.usagePaused !== undefined)
        await pause.setUsagePaused(
          identity.tenantId,
          identity.principalId,
          patch.usagePaused,
        );
      return context.json({
        pauseControls: await pause.getPauseState(
          identity.tenantId,
          identity.principalId,
        ),
      });
    });
  }
  routes.post("/", async (context) =>
    context.json(
      {
        memory: await store.create(
          context.var.actor.id,
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.get("/sources", async (context) =>
    context.json({ sources: await store.sources(context.var.actor.id) }),
  );
  routes.get("/sources/available/:botId", async (context) =>
    context.json({
      tools: await ingestion.availableSources(
        context.var.actor.id,
        context.req.param("botId"),
      ),
    }),
  );
  routes.post("/sources", async (context) =>
    context.json(
      await ingestion.createSource(
        context.var.actor.id,
        await body(context.req.raw),
      ),
      201,
    ),
  );
  routes.patch("/sources/:id", async (context) => {
    const input = await body(context.req.raw);
    if (
      !input ||
      typeof input !== "object" ||
      !("enabled" in input) ||
      typeof input.enabled !== "boolean"
    )
      throw new MemoryRefusedError("Choose whether this source is enabled.");
    return context.json({
      source: await store.setSourceEnabled(
        context.var.actor.id,
        context.req.param("id"),
        input.enabled,
      ),
    });
  });
  routes.post("/sources/:id/sync", async (context) =>
    context.json(
      await ingestion.sync(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.delete("/sources/:id", async (context) => {
    await store.removeSource(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  routes.patch("/:id", async (context) =>
    context.json({
      memory: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.delete("/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  // Mounted last: the family's one- and two-segment patterns above are all narrower than
  // `/hindsight/...`, and the sub-router's routes answer only their own paths.
  if (options.hindsight) routes.route("/hindsight", options.hindsight);
  return routes;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new MemoryRefusedError("Supply JSON memory settings.");
  try {
    return await request.json();
  } catch {
    throw new MemoryRefusedError("The memory settings could not be read.");
  }
}
