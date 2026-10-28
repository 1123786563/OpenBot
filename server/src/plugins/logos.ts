import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mcpServers } from "../db/schema";
import type { ComposioBroker } from "./broker";
import { toolkitOf } from "./composio";

/** Fill older app records without changing their connections, schemes, or grants. */
export async function backfillComposioLogos(
  database: Database,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const missing = await database
    .select({ id: mcpServers.id, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.provenance, "composio"), isNull(mcpServers.logo)));
  if (missing.length === 0) return;

  const logos = new Map<string, string | null>();
  for (const app of await broker.listApps()) {
    // First wins: a later duplicate (a vendor listing the same app twice)
    // must not blank a logo an earlier entry already provided.
    if (!logos.has(app.slug)) logos.set(app.slug, app.logo);
  }
  // The rows are independent and each statement guards itself with
  // `isNull(logo)`, so one round-trip per row in parallel beats a serial loop
  // at Composio's directory scale.
  await Promise.all(
    missing.map(async (row) => {
      const slug = toolkitOf(row.url);
      const logo = slug ? logos.get(slug) : null;
      if (!logo) return;
      await database
        .update(mcpServers)
        .set({ logo })
        .where(
          and(
            eq(mcpServers.id, row.id),
            eq(mcpServers.url, row.url),
            eq(mcpServers.provenance, "composio"),
            isNull(mcpServers.logo),
          ),
        );
    }),
  );
}
