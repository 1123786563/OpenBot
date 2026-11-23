import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { createBifrostMarket, IncompleteBifrostPackage } from "./bifrost";
import {
  CatalogEntryUnavailable,
  createSkillMarket,
  type RegistryFetch,
} from "./catalog";
import type { BifrostMarketConfig, SkillMarketConfig } from "./config";
import {
  disableMarketVersion,
  marketVersionDisabledMessage,
  marketVersionIdentity,
} from "./disablements";
import { type marketSkillMethods, slashCommand } from "./installations";

const installBody = z.strictObject({ agentId: z.string().trim().min(1) });
const expectedVersion = z.strictObject({
  expectedVersionId: z.number().int().positive(),
});
const switchBody = installBody.extend(expectedVersion.shape);
const forbidden = "You cannot manage skills on this Bot.";
const stale =
  "The installed version has changed. Review the current installation and try again.";
const unavailable = "Skill installation is unavailable.";
const commandBody = z.strictObject({
  command: z.string().trim().min(1).max(40).regex(slashCommand),
});
const commandUnavailable =
  "This market skill needs an unused slash command assigned by an administrator.";

export function createSkillMarketRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  config: SkillMarketConfig | BifrostMarketConfig,
  fetchRegistry?: RegistryFetch,
  installations?: ReturnType<typeof marketSkillMethods>,
) {
  const bifrost = "kind" in config ? createBifrostMarket(config) : undefined;
  const legacy = "kind" in config ? config.legacy : config;
  const market = legacy && createSkillMarket(legacy, fetchRegistry);
  const catalogFor = (namespace: string) => {
    const catalog = namespace === bifrost?.namespace ? bifrost : market;
    if (!catalog) throw new CatalogEntryUnavailable();
    return catalog;
  };
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });

  routes.onError((error, context) => {
    if (error instanceof CatalogEntryUnavailable)
      return context.json(
        { error: "Skill or version not found in the catalog." },
        404,
      );
    if (error instanceof IncompleteBifrostPackage)
      return context.json({ error: error.message }, 502);
    return context.json({ error: "Couldn't read the skill catalog." }, 502);
  });

  routes.get("/", async (context) => {
    const q = context.req.query("q")?.trim() ?? "";
    const page = readPage(context.req.query("page"));
    if (q.length > 200 || page === null) return context.body(null, 400);
    const catalog = bifrost ?? market;
    if (!catalog) throw new CatalogEntryUnavailable();
    return context.json(await catalog.search(q, page));
  });

  routes.get("/install-targets", async (context) => {
    const bots = installations
      ? await installations.marketInstallTargets(context.var.actor)
      : [];
    return context.json({ bots });
  });

  routes.get("/bots/:agentId/installations", async (context) => {
    if (!installations) return context.json({ error: unavailable }, 503);
    const { agentId } = context.req.param();
    if (
      !(await installations.marketInstallTargets(context.var.actor, agentId))
        .length
    )
      return context.json({ error: forbidden }, 403);
    return context.json({
      installations: await installations.listMarketInstallations(agentId),
    });
  });

  routes.delete("/bots/:agentId/installations/:command", async (context) => {
    if (!installations) return context.json({ error: unavailable }, 503);
    const body = expectedVersion.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success)
      return context.json({ error: "Choose an installed version." }, 400);
    const { agentId, command } = context.req.param();
    const result = await installations.uninstallMarketSkill(
      context.var.actor,
      agentId,
      command,
      body.data.expectedVersionId,
    );
    switch (result) {
      case "forbidden":
        return context.json({ error: forbidden }, 403);
      case "stale-installation":
        return context.json({ error: stale }, 409);
      case "uninstalled":
        return context.body(null, 204);
    }
  });

  routes.get("/version-disablements", async (context) => {
    const refused = requireAdmin(context);
    if (refused) return refused;
    const versions =
      (await installations?.marketVersionsForAdministration()) ?? [];
    return context.json({ versions });
  });

  routes.on(["PUT", "DELETE"], "/version-disablements", async (context) => {
    const refused = requireAdmin(context);
    if (refused) return refused;
    if (!installations)
      return context.json(
        { error: "Skill administration is unavailable." },
        503,
      );

    const schema =
      context.req.method === "PUT"
        ? disableMarketVersion
        : marketVersionIdentity.transform((version) => ({
            ...version,
            reason: null,
          }));
    const version = schema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!version.success) {
      return context.json(
        {
          error:
            "Choose an exact version and provide a disable reason of up to 500 characters when disabling it.",
        },
        400,
      );
    }

    const { reason, ...identity } = version.data;
    await installations.setMarketVersionDisablement(identity, reason);
    return context.body(null, 204);
  });

  routes.post(
    "/:namespace/:slug/versions/:version/:operation{install|switch}",
    async (context) => {
      if (!installations) return context.json({ error: unavailable }, 503);
      const { namespace, slug, version, operation } = context.req.param();
      const input = await context.req.json().catch(() => null);
      const body =
        operation === "switch"
          ? switchBody.safeParse(input)
          : installBody
              .transform((data) => ({ ...data, expectedVersionId: undefined }))
              .safeParse(input);
      if (!body.success)
        return context.json(
          {
            error:
              operation === "switch"
                ? "Choose the Bot and installed version."
                : "Choose a Bot.",
          },
          400,
        );
      const { agentId, expectedVersionId } = body.data;
      const { actor } = context.var;
      if (!(await installations.marketInstallTargets(actor, agentId)).length) {
        return context.json({ error: forbidden }, 403);
      }

      if (namespace === bifrost?.namespace)
        return context.json({ error: bifrost.installationReason }, 422);
      if (!market) throw new CatalogEntryUnavailable();

      const qualified = await market.qualifyInstallation(
        namespace,
        slug,
        version,
        installations.marketVersionDisableReason,
      );
      if (qualified.kind === "ineligible") {
        return context.json({ error: qualified.reasons.join(" ") }, 422);
      }
      const result = await installations.installMarketSkill(
        actor,
        agentId,
        qualified,
        expectedVersionId,
      );
      switch (result.kind) {
        case "forbidden":
          return context.json({ error: forbidden }, 403);
        case "stale-installation":
          return context.json({ error: stale }, 409);
        case "version-disabled":
          return context.json(
            { error: marketVersionDisabledMessage(version, result.reason) },
            422,
          );
        case "command-unavailable":
          return context.json({ error: commandUnavailable }, 409);
        case "different-version":
          return context.json(
            { error: "This Bot already has a different version installed." },
            409,
          );
        case "installed":
        case "already-installed":
        case "switched":
          return context.json(
            { command: result.command, version: result.version },
            result.kind === "installed" ? 201 : 200,
          );
      }
    },
  );

  routes.post("/:namespace/:slug/command", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    if (!installations)
      return context.json(
        { error: "Skill command assignment is unavailable." },
        503,
      );

    const body = commandBody.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success)
      return context.json(
        {
          error:
            "Enter up to 40 lowercase letters or digits, with single hyphens between groups.",
        },
        400,
      );

    const { namespace, slug } = context.req.param();
    if (!market || namespace === bifrost?.namespace)
      throw new CatalogEntryUnavailable();
    const source = await market.commandSource(namespace, slug);
    const result = await installations.assignMarketCommand(
      source,
      body.data.command,
    );
    if (result.kind === "command-unavailable")
      return context.json(
        { error: "That slash command is already in use." },
        409,
      );
    if (result.kind === "existing" && result.command !== body.data.command)
      return context.json(
        { error: `This market skill already uses /${result.command}.` },
        409,
      );
    return context.json(
      { command: result.command },
      result.kind === "reserved" ? 201 : 200,
    );
  });

  routes.get("/:namespace/:slug", async (context) => {
    const { namespace, slug } = context.req.param();
    const page = readPage(context.req.query("page"));
    if (page === null) return context.body(null, 400);
    return context.json(
      await catalogFor(namespace).detail(namespace, slug, page),
    );
  });

  routes.get("/:namespace/:slug/versions/:version", async (context) => {
    const { namespace, slug, version } = context.req.param();
    if (namespace === bifrost?.namespace)
      return context.json(await bifrost.preview(namespace, slug, version));
    if (!market) throw new CatalogEntryUnavailable();
    const preview = await market.preview(namespace, slug, version);
    if (!installations) return context.json(preview);
    const reason = await installations.marketVersionDisableReason(preview);
    if (reason !== null)
      return context.json({
        ...preview,
        installable: false,
        reasons: [
          ...preview.reasons,
          marketVersionDisabledMessage(version, reason),
        ],
        disableReason: reason,
      });
    if (!preview.installable) return context.json(preview);
    const command = await installations.marketCommand(preview);
    return context.json(
      command
        ? { ...preview, command }
        : {
            ...preview,
            installable: false,
            reasons: [commandUnavailable],
            canAssignCommand: context.var.actor.role === "admin",
          },
    );
  });

  routes.get(
    "/:namespace/:slug/versions/:version/download",
    async (context) => {
      const { namespace, slug, version } = context.req.param();
      const response = await catalogFor(namespace).download(
        namespace,
        slug,
        version,
      );
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
