import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import type { Database } from "../../db/client";
import {
  corsairAccounts,
  corsairIntegrations,
} from "../../db/schema/corsair-storage";
import {
  corsairCatalog,
  corsairIntegrationStatus,
  findCorsairIntegration,
} from "./integrations";

const integrationId = z.string().regex(/^[a-z0-9]+$/);

export function createCorsairIntegrationsRoutes({
  requireUser,
  database,
  workspaceId,
  environment = process.env,
  clock = () => new Date(),
}: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  database: Database;
  workspaceId: string;
  environment?: Record<string, string | undefined>;
  clock?: () => Date;
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

  // App-level connections ride the upstream account table as kind "registration": one row per
  // workspace per catalog app, its `registration` column holding the catalog id.
  async function connectedIds() {
    const rows = await database
      .select({ appId: corsairAccounts.registration })
      .from(corsairAccounts)
      .where(
        and(
          eq(corsairAccounts.kind, "registration"),
          eq(corsairAccounts.workspaceId, workspaceId),
        ),
      );
    return new Set(rows.map((row) => row.appId));
  }

  routes.get("/", async (context) => {
    const search = context.req.query("search")?.trim().toLowerCase();
    const connected = await connectedIds();
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
      integrations: matches.map((integration) => ({
        ...corsairIntegrationStatus(integration, environment),
        connected: connected.has(integration.id),
      })),
    });
  });

  routes.get("/:integrationId", async (context) => {
    const parsed = integrationId.safeParse(context.req.param("integrationId"));
    const integration = parsed.success
      ? findCorsairIntegration(parsed.data)
      : undefined;
    if (!integration)
      return context.json({ error: "Unknown Corsair integration." }, 404);
    const connected = await connectedIds();
    return context.json({
      ...corsairIntegrationStatus(integration, environment),
      connected: connected.has(integration.id),
    });
  });

  routes.post("/:integrationId/connect", async (context) => {
    const parsed = integrationId.safeParse(context.req.param("integrationId"));
    const integration = parsed.success
      ? findCorsairIntegration(parsed.data)
      : undefined;
    if (!integration)
      return context.json({ error: "Unknown Corsair integration." }, 404);
    // App-first integration: the row is recorded without any client credential check. An app's
    // own tokens arrive later, with the per-provider pilots (github, slack).
    const name = `catalog-app:${integration.id}`;
    let [app] = await database
      .select({ id: corsairIntegrations.id })
      .from(corsairIntegrations)
      .where(eq(corsairIntegrations.name, name));
    if (!app) {
      await database
        .insert(corsairIntegrations)
        .values({ name, config: { catalogApp: true } });
      [app] = await database
        .select({ id: corsairIntegrations.id })
        .from(corsairIntegrations)
        .where(eq(corsairIntegrations.name, name));
    }
    const [existing] = await database
      .select({ id: corsairAccounts.id })
      .from(corsairAccounts)
      .where(
        and(
          eq(corsairAccounts.kind, "registration"),
          eq(corsairAccounts.workspaceId, workspaceId),
          eq(corsairAccounts.registration, integration.id),
        ),
      );
    if (!existing)
      await database.insert(corsairAccounts).values({
        tenantId: workspaceId,
        integrationId: app.id,
        workspaceId,
        registration: integration.id,
        personId: context.var.actor.id,
        kind: "registration",
        config: { connectedBy: context.var.actor.id, connectedAt: clock() },
      });
    return context.json(
      {
        ...corsairIntegrationStatus(integration, environment),
        connected: true,
        status: "connected",
      },
      201,
    );
  });

  return routes;
}
