import type { AgentProfile, AgentProfileStore } from "../agents/public";
import type { AuthenticatedActor } from "../auth/public";

/** The one template key this deployment provisions per person. */
export const OPENMUSE_TEMPLATE_KEY = "openmuse-private";

/** The template revision this build ships. I09 owns applying later revisions. */
export const OPENMUSE_TEMPLATE_VERSION = 1;

/**
 * What the v1 template manages, per contracts §2: everything here is owned by
 * the template and never offered as user-editable.
 */
export type OpenMuseTemplateV1 = {
  templateKey: string;
  version: number;
  name: string;
  title: string;
  roleDescription: string;
  visibility: "private";
  /** The tool grants the template v1 fixture records. */
  grants: string[];
  systemPromptRevision: string;
};

/**
 * A stored template Bot: the roster projection plus the template revision it
 * carries in its configuration, which is what the provision answer and the
 * revision service (I09) both read back.
 */
export type StoredTemplateProfile = AgentProfile & { templateVersion: number };

/** The agent-profile store as the provisioner needs it: the roster methods plus the template seam. */
export type OpenMuseTemplateStore = AgentProfileStore & {
  findByTemplateKey(
    ownerUserId: string,
    templateKey: string,
  ): Promise<StoredTemplateProfile | null>;
  createFromTemplate(
    ownerUserId: string,
    template: OpenMuseTemplateV1,
  ): Promise<StoredTemplateProfile>;
};

export type OpenMuseBotProvisionResult = {
  botId: string;
  templateVersion: number;
  computerProfileId: string | null;
};

export type OpenMuseBotProvisioner = {
  provision(actor: AuthenticatedActor): Promise<OpenMuseBotProvisionResult>;
};

/** The v1 template this build provisions; the revision table in the template store starts from it. */
export const openMuseTemplateV1: OpenMuseTemplateV1 = {
  templateKey: OPENMUSE_TEMPLATE_KEY,
  version: OPENMUSE_TEMPLATE_VERSION,
  name: "OpenMuse",
  title: "OpenMuse",
  roleDescription: "Your private OpenMuse assistant.",
  visibility: "private",
  grants: ["mail.read"],
  systemPromptRevision: "openmuse-v1",
};

/**
 * The unique violation the template store raises — or the PostgreSQL error
 * code a driver surfaces — when a concurrent provisioner already inserted this
 * (owner, templateKey) row. A tombstone holding the pair never surfaces here:
 * the store's violation branch revives it first.
 */
export function isUniqueViolation(error: unknown): boolean {
  let candidate = error as { code?: string; name?: string; cause?: unknown };
  while (candidate) {
    if (candidate.name === "UNIQUE_TEMPLATE" || candidate.code === "23505") {
      return true;
    }
    candidate = candidate.cause as typeof candidate;
  }
  return false;
}

/**
 * Provision exactly one private OpenMuse Bot per person, idempotently and
 * safely under concurrency.
 *
 * Ownership is never taken from the request: the actor is the authenticated
 * session the guard resolved, and the store keys the template row by that
 * owner. The unique index on (owner_user_id, template_key) is the arbiter —
 * the loser of a race sees the winner's row on its re-read, and both callers
 * walk away holding the same Bot. The index is partial among live rows (0096)
 * and the store revives a tombstone on violation, so a soft-deleted Bot's
 * tombstone never turns this re-read into a permanent failure.
 */
export function createOpenMuseBotProvisioner(deps: {
  agentProfileStore: OpenMuseTemplateStore;
  computerProfileIdFor(profile: AgentProfile): Promise<string | null>;
}): OpenMuseBotProvisioner {
  const answer = async (
    profile: StoredTemplateProfile,
  ): Promise<OpenMuseBotProvisionResult> => ({
    botId: profile.id,
    // The revision a stored Bot carries, which may be newer than the shipped
    // one once an administrator has applied a revision (I09).
    templateVersion: profile.templateVersion,
    computerProfileId: await deps.computerProfileIdFor(profile),
  });

  return {
    async provision(actor) {
      const existing = await deps.agentProfileStore.findByTemplateKey(
        actor.id,
        OPENMUSE_TEMPLATE_KEY,
      );
      if (existing) return answer(existing);

      try {
        return answer(
          await deps.agentProfileStore.createFromTemplate(
            actor.id,
            openMuseTemplateV1,
          ),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const winner = await deps.agentProfileStore.findByTemplateKey(
          actor.id,
          OPENMUSE_TEMPLATE_KEY,
        );
        if (!winner) throw error;
        return answer(winner);
      }
    },
  };
}
