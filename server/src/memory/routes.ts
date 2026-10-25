import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "../hindsight/bank-scope";
import type { HindsightPauseControlsService } from "../hindsight/pause-controls";
import type { HindsightMemoryRoutes } from "../hindsight/routes";
import type { MemoryCompany } from "./company";
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
    /**
     * FIX-F1 (#376, FR-1): the whole old face's company pin. Present only in an enterprise
     * deployment, where every route below resolves the request's trusted scope — the same
     * `resolveHindsightBankScope` seam the pause switches use — and the memory rows a request
     * may read, review, write or forget are that company's alone. A deployment without the
     * enterprise layer wires nothing here and keeps the single-user behaviour unchanged.
     */
    companyScope?: {
      resolveScope: (request: Request) => Promise<PlatformScope>;
    };
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  /*
   * FIX-F1 (FR-1): one resolution per request, one company for the whole visit. The scope is
   * the deployment's own resolver's answer (missing session/company/selection and unissued
   * scopes throw the canonical codes `onError` below maps); the pin is the scope's tenant —
   * never a value from the body — and the same `assertTrustedScope`-backed derivation the
   * pause switches and the Hindsight chain's seams read.
   */
  const companyFor = async (
    request: Request,
  ): Promise<MemoryCompany | undefined> => {
    if (!options.companyScope) return undefined;
    const scope = await options.companyScope.resolveScope(request);
    const identity = resolveHindsightBankScope(scope);
    return { tenantId: identity.tenantId };
  };
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
    context.json({
      memories: await store.list(
        context.var.actor.id,
        await companyFor(context.req.raw),
      ),
    }),
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
    // The stored identity includes the person's user id: the resolver selected the principal
    // BY the session actor's id, so it is the same server-side fact, never a wire value
    // (FIX-W8/RFW1-1 — the legacy user gate reads this attribution instead of joining the
    // FORCE-RLS directory tables, which fail open under restricted application logins).
    const identityFor = async (request: Request) => {
      const scope = await resolveScope(request);
      const identity = resolveHindsightBankScope(scope);
      return { ...identity, userId: scope.actorId };
    };
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
          identity.userId,
          patch.learningPaused,
        );
      if (patch.usagePaused !== undefined)
        await pause.setUsagePaused(
          identity.tenantId,
          identity.principalId,
          identity.userId,
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
          await companyFor(context.req.raw),
        ),
      },
      201,
    ),
  );
  /*
   * The sources are the person's own connector settings, not memory rows — but each one
   * belongs to the company its Bot proved at binding (FIX-W13 / FR2-2): the trusted scope
   * this family resolves decides which sources a request may see, operate or sync, and a
   * source of another company, or one nobody could attribute, is not this scope's to touch
   * (the same not-found the owner-keyed paths give). The gate still resolves the trusted
   * scope first in an enterprise deployment, so an unresolvable identity refuses here too,
   * fail closed; a deployment without the enterprise layer wires no company through and the
   * rows stay owner-keyed exactly as they always were.
   */
  routes.get("/sources", async (context) => {
    return context.json({
      sources: await store.sources(
        context.var.actor.id,
        await companyFor(context.req.raw),
      ),
    });
  });
  routes.get("/sources/available/:botId", async (context) => {
    await companyFor(context.req.raw);
    return context.json({
      tools: await ingestion.availableSources(
        context.var.actor.id,
        context.req.param("botId"),
      ),
    });
  });
  routes.post("/sources", async (context) => {
    return context.json(
      await ingestion.createSource(
        context.var.actor.id,
        await body(context.req.raw),
        await companyFor(context.req.raw),
      ),
      201,
    );
  });
  routes.patch("/sources/:id", async (context) => {
    const company = await companyFor(context.req.raw);
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
        company,
      ),
    });
  });
  routes.post("/sources/:id/sync", async (context) => {
    // FIX-W13 (FR2-2): the request's company only authorizes the sync; the source's own
    // persisted company — never the selection — stamps the import (ingestion.sync).
    const company = await companyFor(context.req.raw);
    return context.json(
      await ingestion.sync(
        context.var.actor.id,
        context.req.param("id"),
        company,
      ),
    );
  });
  routes.delete("/sources/:id", async (context) => {
    await store.removeSource(
      context.var.actor.id,
      context.req.param("id"),
      await companyFor(context.req.raw),
    );
    return context.body(null, 204);
  });
  routes.patch("/:id", async (context) =>
    context.json({
      memory: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
        await companyFor(context.req.raw),
      ),
    }),
  );
  routes.delete("/:id", async (context) => {
    await store.remove(
      context.var.actor.id,
      context.req.param("id"),
      await companyFor(context.req.raw),
    );
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
