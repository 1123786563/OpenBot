import { type SQLWrapper, sql } from "drizzle-orm";
import { skillMarketInstallations, skillMarketSources } from "../db/schema";

// Replicas from before the cutover omit these columns. Their command reservation
// is authoritative for the legacy snapshot, including rows written during rollout.
function withLegacySource(snapshot: SQLWrapper, reserved: SQLWrapper) {
  return sql<string>`coalesce(${snapshot}, (
    select ${reserved} from ${skillMarketSources}
    where ${skillMarketSources.command} = ${skillMarketInstallations.command}
  ))`;
}

export const installedMarketSource = {
  source: withLegacySource(
    skillMarketInstallations.registry,
    skillMarketSources.registry,
  ),
  namespace: withLegacySource(
    skillMarketInstallations.namespace,
    skillMarketSources.namespace,
  ),
  slug: withLegacySource(
    skillMarketInstallations.slug,
    skillMarketSources.slug,
  ),
};
