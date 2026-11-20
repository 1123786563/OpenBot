import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  CatalogEntryUnavailable,
  createSkillMarket,
  type RegistryFetch,
} from "./catalog";
import type { SkillMarketConfig } from "./config";

export function createSkillMarketRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  config: SkillMarketConfig,
  fetchRegistry?: RegistryFetch,
) {
  const market = createSkillMarket(config, fetchRegistry);
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });

  routes.onError((error, context) =>
    error instanceof CatalogEntryUnavailable
      ? context.json(
          { error: "Skill or version not found in the catalog." },
          404,
        )
      : context.json(
          { error: "Couldn't read the skill catalog from SkillHub." },
          502,
        ),
  );

  routes.get("/", async (context) => {
    const q = context.req.query("q")?.trim() ?? "";
    const page = readPage(context.req.query("page"));
    if (q.length > 200 || page === null) return context.body(null, 400);
    return context.json(await market.search(q, page));
  });

  routes.get("/:namespace/:slug", async (context) => {
    const { namespace, slug } = context.req.param();
    const page = readPage(context.req.query("page"));
    if (page === null) return context.body(null, 400);
    return context.json(await market.detail(namespace, slug, page));
  });

  routes.get("/:namespace/:slug/versions/:version", async (context) => {
    const { namespace, slug, version } = context.req.param();
    return context.json(await market.preview(namespace, slug, version));
  });

  routes.get(
    "/:namespace/:slug/versions/:version/download",
    async (context) => {
      const { namespace, slug, version } = context.req.param();
      const response = await market.download(namespace, slug, version);
      const filename = encodeURIComponent(`${slug}-${version}.zip`);
      return new Response(response.body, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="skill.zip"; filename*=UTF-8''${filename}`,
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );

  return routes;
}

function readPage(raw = "0") {
  return /^\d{1,5}$/.test(raw) ? Number(raw) : null;
}
