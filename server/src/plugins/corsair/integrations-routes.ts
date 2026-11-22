import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import {
  corsairCatalog,
  corsairIntegrationStatus,
  findCorsairIntegration,
} from "./integrations";

const integrationId = z.string().regex(/^[a-z0-9]+$/);

export function createCorsairIntegrationsRoutes({
  requireUser,
  environment = process.env,
}: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  environment?: Record<string, string | undefined>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    if (
      context.req.method !== "GET" &&
      context.req.header("X-OpenBot-Pilot") !== "integrations"
    )
      return context.json(
        { error: "The Corsair integrations request header is required." },
        403,
      );
    await next();
  });

  routes.get("/", (context) => {
    const search = context.req.query("search")?.trim().toLowerCase();
    const matches = corsairCatalog().plugins.filter((integration) =>
      search
        ? integration.id.includes(search) ||
          integration.displayName.toLowerCase().includes(search)
        : true,
    );
    return context.json({
      catalogVersion: corsairCatalog().catalogVersion,
      corsairVersion: corsairCatalog().corsairVersion,
      total: corsairCatalog().plugins.length,
      integrations: matches.map((integration) =>
        corsairIntegrationStatus(integration, environment),
      ),
    });
  });

  routes.get("/:integrationId", (context) => {
    const parsed = integrationId.safeParse(context.req.param("integrationId"));
    const integration = parsed.success
      ? findCorsairIntegration(parsed.data)
      : undefined;
    if (!integration)
      return context.json({ error: "Unknown Corsair integration." }, 404);
    return context.json(
      corsairIntegrationStatus(integration, environment),
    );
  });

  routes.post("/:integrationId/connect", (context) => {
    const parsed = integrationId.safeParse(context.req.param("integrationId"));
    const integration = parsed.success
      ? findCorsairIntegration(parsed.data)
      : undefined;
    if (!integration)
      return context.json({ error: "Unknown Corsair integration." }, 404);
    // App-first integration: every catalog entry connects without client
    // credentials. Real token exchange stays with the per-provider pilots
    // (github, slack) once credentials are provisioned.
    return context.json(
      {
        ...corsairIntegrationStatus(integration, environment),
        status: "connected",
      },
      201,
    );
  });

  return routes;
}
