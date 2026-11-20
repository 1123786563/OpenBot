import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  SKILL_MARKET_RESERVATION,
  skillMarketInstallations,
  skillMarketSources,
  skills,
} from "../db/schema";
import { registeredBotProfiles } from "../plugins/plugin-store/skills";
import type { MarketPreview, QualifiedMarketVersion } from "./catalog";

type Actor = AppVariables["actor"];
type Source = Pick<MarketPreview, "source" | "namespace" | "slug">;

// The same Bot boundary as managed skill grants: administrators of the deployment and Bot owners.
function manageableBy(actor: Actor) {
  return and(
    isNull(agentProfiles.deletedAt),
    actor.role === "admin"
      ? undefined
      : eq(agentProfiles.ownerUserId, actor.id),
  );
}

function matchesSource(source: Source) {
  return and(
    eq(skillMarketSources.registry, source.source),
    eq(skillMarketSources.namespace, source.namespace),
    eq(skillMarketSources.slug, source.slug),
  );
}

function matchesInstallation(
  agentId: string,
  command: string,
  expectedVersionId: number,
) {
  return and(
    eq(skillMarketInstallations.agentId, agentId),
    eq(skillMarketInstallations.command, command),
    eq(skillMarketInstallations.versionId, expectedVersionId),
  );
}

// Match the existing slash parser and the managed skill slug length limit.
export const slashCommand = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function reserveCommand(
  transaction: Transaction,
  source: Source & { title: string },
  command: string,
) {
  // Serialize assignments and installs for this source, even when they propose different commands.
  const key = JSON.stringify([
    "skill-market-command",
    source.source,
    source.namespace,
    source.slug,
  ]);
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
  const [existing] = await transaction
    .select({ command: skillMarketSources.command })
    .from(skillMarketSources)
    .where(matchesSource(source));
  if (existing) return { kind: "existing", command: existing.command } as const;

  if (command.length > 40 || !slashCommand.test(command))
    return { kind: "command-unavailable" } as const;

  // The shared slug index arbitrates with managed Skills and other market sources.
  const [reserved] = await transaction
    .insert(skills)
    .values({
      id: command,
      slug: command,
      title: source.title,
      summary: "",
      instructions: "",
      origin: SKILL_MARKET_RESERVATION,
    })
    .onConflictDoNothing()
    .returning({ slug: skills.slug });
  if (!reserved) return { kind: "command-unavailable" } as const;

  await transaction.insert(skillMarketSources).values({
    command,
    registry: source.source,
    namespace: source.namespace,
    slug: source.slug,
  });
  return { kind: "reserved", command } as const;
}

export function marketSkillMethods(database: Database) {
  return {
    async marketInstallTargets(actor: Actor, agentId?: string) {
      return registeredBotProfiles(database)
        .where(
          and(
            manageableBy(actor),
            agentId === undefined ? undefined : eq(agents.id, agentId),
          ),
        )
        .orderBy(asc(agentProfiles.title), asc(agents.id));
    },

    async marketCommand(source: Source) {
      const [assigned] = await database
        .select({ command: skillMarketSources.command })
        .from(skillMarketSources)
        .where(matchesSource(source));
      if (assigned) return assigned.command;
      if (source.slug.length > 40 || !slashCommand.test(source.slug))
        return null;
      const [taken] = await database
        .select({ slug: skills.slug })
        .from(skills)
        .where(eq(skills.slug, source.slug));
      return taken ? null : source.slug;
    },

    async listMarketInstallations(agentId: string) {
      return database
        .select({
          command: skillMarketInstallations.command,
          namespace: skillMarketSources.namespace,
          slug: skillMarketSources.slug,
          registry: skillMarketSources.registry,
          title: skillMarketInstallations.title,
          version: skillMarketInstallations.version,
          versionId: skillMarketInstallations.versionId,
        })
        .from(skillMarketInstallations)
        .innerJoin(
          skillMarketSources,
          eq(skillMarketInstallations.command, skillMarketSources.command),
        )
        .where(eq(skillMarketInstallations.agentId, agentId))
        .orderBy(asc(skillMarketInstallations.command));
    },

    async uninstallMarketSkill(
      actor: Actor,
      agentId: string,
      command: string,
      expectedVersionId: number,
    ) {
      return database.transaction(async (transaction) => {
        const [target] = await registeredBotProfiles(transaction)
          .where(and(manageableBy(actor), eq(agents.id, agentId)))
          .for("share");
        if (!target) return "forbidden";

        const [removed] = await transaction
          .delete(skillMarketInstallations)
          .where(matchesInstallation(agentId, command, expectedVersionId))
          .returning({ command: skillMarketInstallations.command });
        return removed ? "uninstalled" : "stale-installation";
      });
    },

    async assignMarketCommand(
      source: Source & { title: string },
      command: string,
    ) {
      return database.transaction((transaction) =>
        reserveCommand(transaction, source, command),
      );
    },

    async installMarketSkill(
      actor: Actor,
      agentId: string,
      { preview }: QualifiedMarketVersion,
      expectedVersionId?: number,
    ) {
      return database.transaction(async (transaction) => {
        const [target] = await registeredBotProfiles(transaction)
          .where(and(manageableBy(actor), eq(agents.id, agentId)))
          .for("share");
        if (!target) return { kind: "forbidden" } as const;

        const reservation =
          expectedVersionId === undefined
            ? await reserveCommand(transaction, preview, preview.slug)
            : undefined;
        if (reservation?.kind === "command-unavailable") return reservation;
        const command =
          reservation?.command ??
          (
            await transaction
              .select({ command: skillMarketSources.command })
              .from(skillMarketSources)
              .where(matchesSource(preview))
          )[0]?.command;
        if (!command) return { kind: "stale-installation" } as const;

        const {
          version,
          versionId,
          registrySkillId,
          fingerprint,
          title,
          summary,
          instructions,
        } = preview;
        const snapshot = {
          version,
          versionId,
          registrySkillId,
          fingerprint,
          title,
          summary,
          instructions,
          installedBy: actor.id,
        };
        // Both writes use the same qualified payload and transaction boundary.
        if (expectedVersionId !== undefined) {
          const [updated] = await transaction
            .update(skillMarketInstallations)
            .set(snapshot)
            .where(matchesInstallation(agentId, command, expectedVersionId))
            .returning({ command: skillMarketInstallations.command });
          return updated
            ? ({ kind: "switched", command, version } as const)
            : ({ kind: "stale-installation" } as const);
        }

        const [inserted] = await transaction
          .insert(skillMarketInstallations)
          .values({ agentId, command, ...snapshot })
          .onConflictDoNothing()
          .returning({ command: skillMarketInstallations.command });
        if (inserted) return { kind: "installed", command, version } as const;

        const [current] = await transaction
          .select()
          .from(skillMarketInstallations)
          .where(
            and(
              eq(skillMarketInstallations.agentId, agentId),
              eq(skillMarketInstallations.command, command),
            ),
          );
        return current?.version === version &&
          current.versionId === versionId &&
          current.registrySkillId === registrySkillId &&
          current.fingerprint === fingerprint
          ? ({ kind: "already-installed", command, version } as const)
          : ({ kind: "different-version" } as const);
      });
    },
  };
}
