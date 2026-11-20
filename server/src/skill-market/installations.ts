import { and, asc, eq, isNull } from "drizzle-orm";
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

// Match the existing slash parser and the managed skill slug length limit.
const slashCommand = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

    async installMarketSkill(
      actor: Actor,
      agentId: string,
      { preview }: QualifiedMarketVersion,
    ) {
      return database.transaction(async (transaction) => {
        const [target] = await registeredBotProfiles(transaction)
          .where(and(manageableBy(actor), eq(agents.id, agentId)))
          .for("share");
        if (!target) return { kind: "forbidden" } as const;

        let [source] = await transaction
          .select()
          .from(skillMarketSources)
          .where(matchesSource(preview));
        if (!source) {
          if (preview.slug.length > 40 || !slashCommand.test(preview.slug))
            return { kind: "command-unavailable" } as const;
          // The managed skill slug index arbitrates between both kinds of Skill, including
          // concurrent creates. Keep this reservation even after all Bot installations go away.
          const [reserved] = await transaction
            .insert(skills)
            .values({
              id: preview.slug,
              slug: preview.slug,
              title: preview.title,
              summary: "",
              instructions: "",
              origin: SKILL_MARKET_RESERVATION,
            })
            .onConflictDoNothing()
            .returning({ slug: skills.slug });
          if (reserved) {
            [source] = await transaction
              .insert(skillMarketSources)
              .values({
                command: reserved.slug,
                registry: preview.source,
                namespace: preview.namespace,
                slug: preview.slug,
              })
              .returning();
          } else {
            // A concurrent install of this same source can have reserved the command first.
            [source] = await transaction
              .select()
              .from(skillMarketSources)
              .where(matchesSource(preview));
          }
          if (!source) return { kind: "command-unavailable" } as const;
        }

        const { command } = source;
        const {
          version,
          versionId,
          registrySkillId,
          fingerprint,
          title,
          summary,
          instructions,
        } = preview;
        const [inserted] = await transaction
          .insert(skillMarketInstallations)
          .values({
            agentId,
            command,
            version,
            versionId,
            registrySkillId,
            fingerprint,
            title,
            summary,
            instructions,
            installedBy: actor.id,
          })
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
