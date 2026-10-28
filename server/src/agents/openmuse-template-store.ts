import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentPreferences,
  agentProfiles,
  agents,
  deploymentPackages,
} from "../db/schema";
import {
  isUniqueViolation,
  OPENMUSE_TEMPLATE_KEY,
  OPENMUSE_TEMPLATE_VERSION,
  type OpenMuseTemplateStore,
  type OpenMuseTemplateV1,
  openMuseTemplateV1,
  type StoredTemplateProfile,
} from "../mobile-bff/openmuse-bot";
import { authFromConfiguration } from "./auth-header";
import { joinedProjection } from "./profile-store";
import type { AgentProfile } from "./profile-types";

/** The marker the provisioner resolves a lost race by. */
export class UniqueTemplateViolationError extends Error {
  constructor() {
    super("A Bot for this template already exists for this owner.");
    this.name = "UNIQUE_TEMPLATE";
  }
}

/** The two template methods this module adds to an assembled profile store. */
export type OpenMuseTemplateMethods = Pick<
  OpenMuseTemplateStore,
  "findByTemplateKey" | "createFromTemplate"
>;

type DatabaseExecutor =
  | Pick<Database, "select">
  | Pick<Parameters<Parameters<Database["transaction"]>[0]>[0], "select">;

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: "public" | "private";
  ownerUserId: string | null;
  packageId: string | null;
  hiddenAt: Date | null;
  pinnedAt: Date | null;
  deletedAt: Date | null;
  callbackTokenHash: string | null;
  configuration: unknown;
};

/**
 * The revision marker `createFromTemplate` writes into the configuration JSON.
 * A row without one predates this seam, so it answers the shipped version.
 */
function storedTemplateVersion(configuration: unknown): number {
  const openMuse =
    configuration && typeof configuration === "object"
      ? (configuration as { openMuse?: unknown }).openMuse
      : null;
  const version =
    openMuse && typeof openMuse === "object"
      ? (openMuse as { templateVersion?: unknown }).templateVersion
      : null;
  return typeof version === "number" ? version : OPENMUSE_TEMPLATE_VERSION;
}

function toProfile(row: TemplateRow): StoredTemplateProfile {
  const configuration =
    row.configuration && typeof row.configuration === "object"
      ? (row.configuration as Record<string, unknown>)
      : {};
  const endpoint = configuration.endpoint;
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    roleDescription: row.roleDescription,
    avatarSeed: row.avatarSeed,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    systemOwned: row.packageId !== null,
    hidden: row.hiddenAt !== null,
    pinned: row.pinnedAt !== null,
    deletedAt: row.deletedAt,
    endpoint: typeof endpoint === "string" ? endpoint : null,
    hasAuth: authFromConfiguration(configuration) !== null,
    hasCallbackToken: row.callbackTokenHash !== null,
    templateVersion: storedTemplateVersion(row.configuration),
  };
}

/**
 * The one row a (owner, templateKey) pair names, with every column the
 * {@link AgentProfile} projection needs: profile-store's own projection, shared
 * so the two readers of the same row cannot drift apart column by column.
 */
function templateProfileRows(database: DatabaseExecutor) {
  return database
    .select(joinedProjection)
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .leftJoin(
      agentPreferences,
      and(
        eq(agentPreferences.agentId, agents.id),
        eq(agentPreferences.userId, agentProfiles.ownerUserId),
      ),
    )
    .leftJoin(deploymentPackages, eq(deploymentPackages.id, agents.packageId));
}

/**
 * The template half of provisioning: inserts that carry `template_key` so the
 * unique index on (owner_user_id, template_key) — not a read-then-write — is
 * what makes two concurrent provisions agree on one Bot. A create-then-update
 * around `AgentProfileStore.create` would leave the race loser's profile row
 * behind as a second private Bot in the roster.
 *
 * A unique violation whose holder is a tombstone (a soft-deleted Bot kept its
 * (owner, key) pair) is not a race: it is the same owner re-provisioning after
 * a delete, and the violation branch revives the row instead of failing.
 */
export function createOpenMuseTemplateStore(deps: {
  database: Database;
  managedAgentAgUiUrl?: URL;
}): OpenMuseTemplateMethods {
  /*
   * What a template Bot runs on and carries, mirroring profile-store's create
   * branches: the managed Bot in the box when the deployment has one, otherwise
   * the template's standing instruction. Grants and the prompt revision are the
   * template's to revise (I09), never the user's — the same write a fresh
   * provision and a tombstone revive both make.
   */
  const templateConfiguration = (template: OpenMuseTemplateV1) => ({
    ...(deps.managedAgentAgUiUrl
      ? { endpoint: deps.managedAgentAgUiUrl.toString() }
      : { systemPrompt: template.roleDescription }),
    openMuse: {
      templateKey: template.templateKey,
      templateVersion: template.version,
      grants: template.grants,
      systemPromptRevision: template.systemPromptRevision,
    },
  });

  /**
   * The belt to 0096's braces: with the index still whole (a deployment yet to
   * apply the partial recreation), a tombstone wins the INSERT race and this
   * clears its `deleted_at` and re-applies the managed fields, so the owner
   * walks away holding their working Bot. A live conflicting row answers null —
   * that is a real race, and the caller reports the violation.
   */
  const reviveTombstonedTemplate = async (
    ownerUserId: string,
    template: OpenMuseTemplateV1,
  ): Promise<StoredTemplateProfile | null> =>
    deps.database.transaction(async (transaction) => {
      const [tombstone] = await transaction
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, ownerUserId),
            eq(agentProfiles.templateKey, template.templateKey),
            isNotNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!tombstone) return null;
      const revivedAt = new Date();
      await transaction
        .update(agentProfiles)
        .set({
          deletedAt: null,
          updatedAt: revivedAt,
          title: template.title,
          roleDescription: template.roleDescription,
          visibility: template.visibility,
        })
        .where(eq(agentProfiles.agentId, tombstone.agentId));
      await transaction
        .update(agents)
        .set({
          name: template.name,
          type: deps.managedAgentAgUiUrl ? "remote_ag_ui" : "built_in",
          configuration: templateConfiguration(template),
        })
        .where(eq(agents.id, tombstone.agentId));
      const [row] = await templateProfileRows(transaction)
        .where(eq(agentProfiles.agentId, tombstone.agentId))
        .limit(1);
      return row ? toProfile(row) : null;
    });

  return {
    async findByTemplateKey(ownerUserId, templateKey) {
      const [row] = await templateProfileRows(deps.database)
        .where(
          and(
            eq(agentProfiles.ownerUserId, ownerUserId),
            eq(agentProfiles.templateKey, templateKey),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1);
      return row ? toProfile(row) : null;
    },

    async createFromTemplate(ownerUserId, template) {
      try {
        return await deps.database.transaction(async (transaction) => {
          const id = `agent_${crypto.randomUUID()}`;
          await transaction.insert(agents).values({
            id,
            name: template.name,
            type: deps.managedAgentAgUiUrl ? "remote_ag_ui" : "built_in",
            configuration: templateConfiguration(template),
          });
          await transaction.insert(agentProfiles).values({
            agentId: id,
            ownerUserId,
            title: template.title,
            roleDescription: template.roleDescription,
            avatarSeed: id,
            visibility: template.visibility,
            templateKey: template.templateKey,
          });
          const [row] = await templateProfileRows(transaction)
            .where(eq(agentProfiles.agentId, id))
            .limit(1);
          if (!row) throw new Error(`Template Bot ${id} vanished on creation.`);
          return toProfile(row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const revived = await reviveTombstonedTemplate(ownerUserId, template);
          if (revived) return revived;
          throw new UniqueTemplateViolationError();
        }
        throw error;
      }
    },
  };
}

/*
 * Managed template revisions (I09, contracts §2): an administrator previews the
 * per-field diff of a target revision against one stored Bot and applies it
 * under compare-and-swap. Only the managed keys inside the configuration JSON
 * (templateVersion, grants, systemPromptRevision) ever change; the
 * user-editable columns the profile row carries are listed in a preview but
 * never proposed or written.
 */

/** What a template revision may change: the managed half of the template. */
export type OpenMuseTemplateRevision = {
  version: number;
  grants: string[];
  systemPromptRevision: string;
};

/**
 * The revisions this build knows. v2 is the v1 fixture plus `calendar.read`
 * (contracts §2); everything else the template manages is unchanged, which is
 * why a v1→v2 preview lists exactly the grants and version rows.
 */
export const OPENMUSE_TEMPLATE_REVISIONS: Record<
  number,
  OpenMuseTemplateRevision
> = {
  1: {
    version: openMuseTemplateV1.version,
    grants: openMuseTemplateV1.grants,
    systemPromptRevision: openMuseTemplateV1.systemPromptRevision,
  },
  2: {
    version: 2,
    grants: [...openMuseTemplateV1.grants, "calendar.read"],
    systemPromptRevision: openMuseTemplateV1.systemPromptRevision,
  },
};

export type TemplateRevisionFieldDiff = {
  field: string;
  old: unknown;
  new?: unknown;
  ownership: "managed" | "user";
};

export type TemplateRevisionPreview = {
  ownerUserId: string;
  storedVersion: number;
  targetVersion: number;
  fields: TemplateRevisionFieldDiff[];
};

export type TemplateRevisionApplyResult = {
  status: "updated" | "noop";
  storedVersion: number;
};

/** The stored revision is newer than the one an administrator tried to apply. */
export class StaleTemplateRevisionError extends Error {
  constructor(
    storedVersion: number,
    targetVersion: number,
    message = `The stored template revision ${storedVersion} is newer than ${targetVersion}.`,
  ) {
    super(message);
    this.name = "STALE_TEMPLATE_REVISION";
  }
}

/** No template Bot exists for that owner, so there is nothing to revise. */
export class TemplateBotNotFoundError extends Error {
  constructor(ownerUserId: string) {
    super(`No template Bot exists for ${ownerUserId}.`);
    this.name = "TEMPLATE_BOT_NOT_FOUND";
  }
}

/** One stored template Bot: the managed keys plus the user-editable fields a preview reports. */
export type StoredTemplateRevisionState = {
  agentId: string;
  ownerUserId: string;
  templateVersion: number;
  grants: string[];
  systemPromptRevision: string;
  profile: {
    name: string;
    title: string;
    roleDescription: string;
    avatarSeed: string;
  };
};

export type OpenMuseTemplateRevisionService = {
  previewRevision(
    ownerUserId: string,
    targetVersion: number,
  ): Promise<TemplateRevisionPreview>;
  applyRevision(
    ownerUserId: string,
    targetVersion: number,
  ): Promise<TemplateRevisionApplyResult>;
};

function grantsDiffer(stored: string[], target: string[]): boolean {
  return (
    stored.length !== target.length ||
    stored.some((grant, index) => grant !== target[index])
  );
}

/**
 * Preview is a pure diff: every managed key that differs carries `{old, new}`,
 * every user-editable field is listed user-owned with no proposed `new`, so an
 * administrator sees exactly what apply will and will not touch.
 */
export function createOpenMuseTemplateRevisionService(deps: {
  load(ownerUserId: string): Promise<StoredTemplateRevisionState | null>;
  /** A guarded managed write: succeeds only while the expected version is still stored. */
  applyManaged(
    agentId: string,
    expectedVersion: number,
    target: OpenMuseTemplateRevision,
  ): Promise<number>;
}): OpenMuseTemplateRevisionService {
  const targetRevision = (targetVersion: number) => {
    const revision = OPENMUSE_TEMPLATE_REVISIONS[targetVersion];
    if (!revision) {
      throw new RangeError(`Unknown template revision ${targetVersion}.`);
    }
    return revision;
  };

  return {
    async previewRevision(ownerUserId, targetVersion) {
      const stored = await deps.load(ownerUserId);
      if (!stored) throw new TemplateBotNotFoundError(ownerUserId);
      const revision = targetRevision(targetVersion);
      const fields: TemplateRevisionFieldDiff[] = [];
      if (stored.templateVersion !== revision.version) {
        fields.push({
          field: "templateVersion",
          old: stored.templateVersion,
          new: revision.version,
          ownership: "managed",
        });
      }
      if (grantsDiffer(stored.grants, revision.grants)) {
        fields.push({
          field: "grants",
          old: [...stored.grants],
          new: [...revision.grants],
          ownership: "managed",
        });
      }
      if (stored.systemPromptRevision !== revision.systemPromptRevision) {
        fields.push({
          field: "systemPromptRevision",
          old: stored.systemPromptRevision,
          new: revision.systemPromptRevision,
          ownership: "managed",
        });
      }
      for (const [field, value] of Object.entries(stored.profile)) {
        fields.push({ field, old: value, ownership: "user" });
      }
      return {
        ownerUserId,
        storedVersion: stored.templateVersion,
        targetVersion: revision.version,
        fields,
      };
    },

    async applyRevision(ownerUserId, targetVersion) {
      const stored = await deps.load(ownerUserId);
      if (!stored) throw new TemplateBotNotFoundError(ownerUserId);
      const revision = targetRevision(targetVersion);
      if (stored.templateVersion > revision.version) {
        throw new StaleTemplateRevisionError(
          stored.templateVersion,
          revision.version,
        );
      }
      /*
       * Equal versions and nothing drifted: a genuine noop. Equal versions with drifted
       * managed values (an out-of-band write, or a future writer that bumps the version
       * without touching grants) keeps going — preview promised the administrator exactly
       * what apply will touch, and it listed those drifts as managed changes to write. The
       * CAS predicate below matches expectedVersion, which this row still holds, so the
       * converge-on-the-revision write goes through rather than answering a noop preview
       * contradict.
       */
      const managedDrifted =
        grantsDiffer(stored.grants, revision.grants) ||
        stored.systemPromptRevision !== revision.systemPromptRevision;
      if (stored.templateVersion === revision.version && !managedDrifted) {
        return { status: "noop", storedVersion: stored.templateVersion };
      }
      const written = await deps.applyManaged(
        stored.agentId,
        stored.templateVersion,
        revision,
      );
      if (written === 0) {
        // Lost the race to another applier: converge on the winner's version.
        const winner = await deps.load(ownerUserId);
        if (!winner) throw new TemplateBotNotFoundError(ownerUserId);
        if (winner.templateVersion >= revision.version) {
          return { status: "noop", storedVersion: winner.templateVersion };
        }
        // The row moved to a lower revision mid-flight: the route's 409 arm,
        // not a bodyless 500, is the answer a concurrent apply deserves.
        throw new StaleTemplateRevisionError(
          winner.templateVersion,
          revision.version,
          `Another apply moved Template Bot ${stored.agentId} to revision ${winner.templateVersion} while ${revision.version} was being applied; try again.`,
        );
      }
      return { status: "updated", storedVersion: revision.version };
    },
  };
}

/**
 * The drizzle-backed revision service: reads the stored template Bot for an
 * owner, and applies a revision with one guarded UPDATE on the configuration
 * JSON — the version marker inside the JSON is the compare-and-swap, so two
 * concurrent applies agree on one final version the way two concurrent
 * provisions do.
 */
export function createOpenMuseTemplateRevisionStore(deps: {
  database: Database;
}): OpenMuseTemplateRevisionService {
  return createOpenMuseTemplateRevisionService({
    async load(ownerUserId) {
      const [row] = await deps.database
        .select({
          agentId: agents.id,
          name: agents.name,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
          avatarSeed: agentProfiles.avatarSeed,
          configuration: agents.configuration,
        })
        .from(agents)
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            eq(agentProfiles.ownerUserId, ownerUserId),
            eq(agentProfiles.templateKey, OPENMUSE_TEMPLATE_KEY),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return null;
      const configuration =
        row.configuration && typeof row.configuration === "object"
          ? (row.configuration as { openMuse?: Record<string, unknown> })
          : {};
      const openMuse = configuration.openMuse ?? {};
      const grants = Array.isArray(openMuse.grants)
        ? (openMuse.grants.filter(
            (grant) => typeof grant === "string",
          ) as string[])
        : [];
      return {
        agentId: row.agentId,
        ownerUserId,
        templateVersion: storedTemplateVersion(row.configuration),
        grants,
        systemPromptRevision:
          typeof openMuse.systemPromptRevision === "string"
            ? openMuse.systemPromptRevision
            : "",
        profile: {
          name: row.name,
          title: row.title,
          roleDescription: row.roleDescription,
          avatarSeed: row.avatarSeed,
        },
      };
    },

    async applyManaged(agentId, expectedVersion, revision) {
      // A top-level merge: replaces the openMuse keys, leaves the run
      // configuration (endpoint, systemPrompt) beside them untouched.
      const managed = JSON.stringify({
        openMuse: {
          templateKey: OPENMUSE_TEMPLATE_KEY,
          templateVersion: revision.version,
          grants: revision.grants,
          systemPromptRevision: revision.systemPromptRevision,
        },
      });
      const updated = await deps.database
        .update(agents)
        .set({
          configuration: sql`${agents.configuration} || ${managed}::jsonb`,
        })
        .where(
          and(
            eq(agents.id, agentId),
            // A row written without the version marker is the factory revision — the same
            // fallback `load` applies when it reads one, so the CAS a preview was computed
            // against and the write it authorised cannot disagree over what a markerless row
            // holds (a preview that sees v1 must not lose every race against a NULL).
            sql`coalesce((${agents.configuration} -> 'openMuse' ->> 'templateVersion')::int, ${OPENMUSE_TEMPLATE_VERSION}) = ${expectedVersion}`,
          ),
        )
        .returning({ id: agents.id });
      return updated.length;
    },
  });
}
