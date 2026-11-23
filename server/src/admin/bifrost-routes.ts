import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";
import {
  CatalogConflict,
  catalogSchema,
  configuration,
  configure,
  emptyCatalog,
  pilotCatalogKey,
  providerCancellationRecord,
  publication,
  publish,
  qualificationReport,
  releaseSchema,
  verify,
  view,
} from "./bifrost-catalog";

const releaseKey = (id: string) => `bifrost_pilot_release:${id}`;

export function createBifrostAdminRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  database: Database,
  evidenceDirectory: string | undefined,
) {
  const api = new Hono<{ Variables: AppVariables }>();
  api.use(
    "*",
    requireUser,
    async (context, next) => requireAdmin(context) ?? next(),
  );
  api.use("*", bodyLimit({ maxSize: 32_768 }));
  api.onError((error, context) => {
    if (error instanceof CatalogConflict)
      return context.json({ error: error.message }, 409);
    // Database or file errors may include infrastructure paths or submitted values.
    return context.json({ error: "Bifrost catalog is unavailable." }, 503);
  });

  const catalogFilter = eq(enterpriseSettings.key, pilotCatalogKey);
  async function update<T>(
    by: string,
    change: (catalog: typeof emptyCatalog) => Promise<{
      catalog: typeof emptyCatalog;
      result: T;
      release?: z.infer<typeof releaseSchema>;
    }>,
  ) {
    return database.transaction(async (tx) => {
      await tx
        .insert(enterpriseSettings)
        .values({ key: pilotCatalogKey, value: emptyCatalog })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(enterpriseSettings)
        .where(catalogFilter)
        .for("update");
      const { catalog, result, release } = await change(
        catalogSchema.parse(row?.value),
      );
      await tx
        .update(enterpriseSettings)
        .set({ value: catalog, updatedBy: by, updatedAt: new Date() })
        .where(catalogFilter);
      if (release) {
        await tx.insert(enterpriseSettings).values({
          key: releaseKey(release.id),
          value: release,
          updatedBy: by,
        });
      }
      return result;
    });
  }

  api.get("/", async (context) => {
    const [row] = await database
      .select()
      .from(enterpriseSettings)
      .where(catalogFilter);
    const catalog = row ? catalogSchema.parse(row.value) : emptyCatalog;
    return context.json({ catalog, active: view(catalog) });
  });

  api.put("/configuration", async (context) => {
    const input = configuration.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json(
        { error: "Invalid Bifrost pilot configuration." },
        400,
      );
    const result = await update(context.var.actor.id, async (current) => {
      const catalog = configure(current, input.data);
      return { catalog, result: { catalog, active: view(catalog) } };
    });
    return context.json(result);
  });

  api.post("/routes/:id/verify", async (context) => {
    if (!evidenceDirectory)
      return context.json(
        { error: "Bifrost evidence source is unavailable." },
        503,
      );
    const id = context.req.param("id");
    const input = z
      .strictObject({ revision: z.uuid() })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success)
      return context.json({ error: "Supply the current route revision." }, 400);
    const file = Bun.file(
      join(evidenceDirectory, `${input.data.revision}.json`),
    );
    const report = qualificationReport.safeParse(
      file.size <= 32_768
        ? await file.json().catch(() => undefined)
        : undefined,
    );
    if (!report.success)
      throw new CatalogConflict("Missing valid live-provider evidence.");

    const terminalFile = Bun.file(
      join(evidenceDirectory, `${input.data.revision}.cancel.json`),
    );
    const terminalRecord =
      terminalFile.size > 0 && terminalFile.size <= 32_768
        ? await terminalFile.arrayBuffer().catch(() => undefined)
        : undefined;
    const terminal = report.data.cancellation.upstream.terminal;
    const record = providerCancellationRecord.safeParse(
      terminalRecord
        ? await new Response(terminalRecord).json().catch(() => undefined)
        : undefined,
    );
    if (
      !terminalRecord ||
      !record.success ||
      record.data.requestId !== terminal.requestId ||
      record.data.terminatedAt !== terminal.terminatedAt ||
      `sha256:${Bun.CryptoHasher.hash("sha256", terminalRecord, "hex")}` !==
        terminal.recordDigest
    ) {
      throw new CatalogConflict(
        "Missing matching provider cancellation record.",
      );
    }
    const by = context.var.actor.id;
    const result = await update(by, async (current) => {
      if (
        !Object.hasOwn(current.routes, id) ||
        current.routes[id]?.revision !== input.data.revision
      ) {
        throw new CatalogConflict("Bifrost route revision changed.");
      }
      const catalog = verify(current, id, report.data, by);
      return { catalog, result: { catalog, active: view(catalog) } };
    });
    return context.json(result);
  });

  api.post("/publication", async (context) => {
    const input = publication.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success)
      return context.json(
        { error: "Select verified routes and a default." },
        400,
      );
    const by = context.var.actor.id;
    const result = await update(by, async (current) => {
      const { catalog, release } = publish(
        current,
        input.data.routes,
        input.data.defaultRoute,
        by,
      );
      return { catalog, release, result: { release, active: view(catalog) } };
    });
    return context.json(result, 201);
  });

  api.get("/price-versions/:id", async (context) => {
    const id = z.uuid().safeParse(context.req.param("id"));
    if (!id.success)
      return context.json({ error: "Invalid Price Version." }, 400);
    const [row] = await database
      .select()
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, releaseKey(id.data)));
    if (!row) return context.json({ error: "Unknown Price Version." }, 404);
    return context.json(releaseSchema.parse(row.value));
  });

  return api;
}
