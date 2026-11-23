import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  SKILL_MARKET_RESERVATION,
  skillMarketEquivalences,
  skillMarketInstallations,
  skillMarketSources,
  skills,
} from "../db/schema";
import { registeredBotProfiles } from "../plugins/plugin-store/skills";
import type { BifrostPackageIdentity } from "./bifrost";
import type { MarketPreview } from "./catalog";
import { bifrostNamespace } from "./config";
import {
  marketVersionMethods,
  qualifyMarketVersionForWrite,
} from "./disablements";
import { commandSource, lockMarketEquivalences } from "./equivalences";
import { bifrostReviewMethods, lockActiveBifrostReview } from "./reviews";

type InstallablePreview = Pick<
  MarketPreview,
  | "source"
  | "namespace"
  | "slug"
  | "title"
  | "summary"
  | "version"
  | "versionId"
  | "registrySkillId"
  | "fingerprint"
  | "instructions"
>;
type InstallQualification = {
  kind: "qualified";
  preview: InstallablePreview;
} & ({ packageIdentity: BifrostPackageIdentity } | { packageIdentity?: never });

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
  expectedRegistry?: string,
) {
  return and(
    eq(skillMarketInstallations.agentId, agentId),
    eq(skillMarketInstallations.command, command),
    eq(skillMarketInstallations.versionId, expectedVersionId),
    expectedRegistry === undefined
      ? undefined
      : eq(skillMarketInstallations.registry, expectedRegistry),
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
    ...marketVersionMethods(database),
    ...bifrostReviewMethods(database),

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

    async marketCommand(
      preview: Source & { packageIdentity?: BifrostPackageIdentity },
    ) {
      const source = await commandSource(
        database,
        preview,
        preview.packageIdentity?.skillId,
      );
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
      const alias = database
        .select({ slug: skillMarketEquivalences.targetSlug })
        .from(skillMarketEquivalences)
        .where(
          and(
            eq(
              skillMarketEquivalences.source,
              skillMarketInstallations.registry,
            ),
            eq(
              skillMarketEquivalences.namespace,
              skillMarketInstallations.namespace,
            ),
            eq(skillMarketEquivalences.slug, skillMarketInstallations.slug),
            eq(
              skillMarketEquivalences.registrySkillId,
              skillMarketInstallations.registrySkillId,
            ),
          ),
        )
        .limit(1)
        .as("market_catalog_alias");
      return database
        .select({
          command: skillMarketInstallations.command,
          namespace: skillMarketInstallations.namespace,
          slug: skillMarketInstallations.slug,
          registry: skillMarketInstallations.registry,
          catalogSlug: alias.slug,
          title: skillMarketInstallations.title,
          version: skillMarketInstallations.version,
          versionId: skillMarketInstallations.versionId,
        })
        .from(skillMarketInstallations)
        .leftJoinLateral(alias, sql`true`)
        .where(eq(skillMarketInstallations.agentId, agentId))
        .orderBy(asc(skillMarketInstallations.command));
    },

    async uninstallMarketSkill(
      actor: Actor,
      agentId: string,
      command: string,
      expectedVersionId: number,
      expectedRegistry?: string,
    ) {
      return database.transaction(async (transaction) => {
        const [target] = await registeredBotProfiles(transaction)
          .where(and(manageableBy(actor), eq(agents.id, agentId)))
          .for("share");
        if (!target) return "forbidden";

        const [removed] = await transaction
          .delete(skillMarketInstallations)
          .where(
            matchesInstallation(
              agentId,
              command,
              expectedVersionId,
              expectedRegistry,
            ),
          )
          .returning({ command: skillMarketInstallations.command });
        return removed ? "uninstalled" : "stale-installation";
      });
    },

    async assignMarketCommand(
      source: Source & { title: string; skillId?: string },
      command: string,
    ) {
      return database.transaction(async (transaction) => {
        await lockMarketEquivalences(transaction, "read");
        const canonical = await commandSource(
          transaction,
          source,
          source.skillId,
        );
        return reserveCommand(
          transaction,
          { ...canonical, title: source.title },
          command,
        );
      });
    },

    async installMarketSkill(
      actor: Actor,
      agentId: string,
      { preview, packageIdentity }: InstallQualification,
      expectedVersionId?: number,
      expectedRegistry?: string,
    ) {
      return database.transaction(async (transaction) => {
        const [target] = await registeredBotProfiles(transaction)
          .where(and(manageableBy(actor), eq(agents.id, agentId)))
          .for("share");
        if (!target) return { kind: "forbidden" } as const;

        const reason = await qualifyMarketVersionForWrite(transaction, preview);
        if (reason !== null)
          return { kind: "version-disabled", reason } as const;

        if (preview.source === bifrostNamespace) {
          const review =
            packageIdentity &&
            (await lockActiveBifrostReview(transaction, packageIdentity));
          if (
            review?.id !== preview.versionId ||
            review.skillId !== preview.registrySkillId ||
            review.slug !== preview.slug ||
            review.version !== preview.version ||
            review.fingerprint !== preview.fingerprint
          )
            return { kind: "review-unavailable" } as const;
        }

        const canonical = await commandSource(
          transaction,
          preview,
          packageIdentity?.skillId,
        );
        const reservation =
          expectedVersionId === undefined
            ? await reserveCommand(
                transaction,
                { ...canonical, title: preview.title },
                canonical.slug,
              )
            : undefined;
        if (reservation?.kind === "command-unavailable") return reservation;
        const command =
          reservation?.command ??
          (
            await transaction
              .select({ command: skillMarketSources.command })
              .from(skillMarketSources)
              .where(matchesSource(canonical))
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
          registry: preview.source,
          namespace: preview.namespace,
          slug: preview.slug,
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
            .where(
              matchesInstallation(
                agentId,
                command,
                expectedVersionId,
                expectedRegistry,
              ),
            )
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
        return current?.registry === preview.source &&
          current.version === version &&
          current.versionId === versionId &&
          current.registrySkillId === registrySkillId &&
          current.fingerprint === fingerprint
          ? ({ kind: "already-installed", command, version } as const)
          : ({ kind: "different-version" } as const);
      });
    },
  };
}
