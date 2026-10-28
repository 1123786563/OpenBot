import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotCatalog } from "../agents/public";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/public";
import type { ToolAccess } from "../plugins/public";
import {
  CATALOGUE_EXPERTS,
  CATALOGUE_SKILLS,
  CONNECTOR_CATEGORIES,
  EXPERT_CATEGORIES,
} from "./catalogue";
import type { MarketplaceStore } from "./store";

/**
 * The marketplace API: read the catalogue, install and uninstall from it.
 *
 * Everything here is per-person. The catalogue itself is a constant compiled into the build (see
 * `./catalogue.ts`), so the only state this module owns is the receipt store: which expert each
 * person installed and which Bot that created, plus the ordinary skills rows an install writes.
 */

/** What one expert card reads. */
export type MarketExpert = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  tags: string[];
  avatar: string;
  /** Catalogue skills granted to the Bot on install, as slugs. */
  skills: string[];
  /** Whether the person asking has this one installed. Never read as anybody else's install. */
  installed: boolean;
  /** The Bot the install created. Null while not installed. */
  agentId: string | null;
};

/** What one skill card reads. */
export type MarketSkill = {
  slug: string;
  title: string;
  summary: string;
  icon: string;
  category: string;
  /**
   * Whether a skills row for this slug is visible to the person asking: their own, or the
   * deployment's. Somebody else's install claims the slug but is not shown as theirs.
   */
  installed: boolean;
  /** Whether the visible row belongs to the person asking (they may uninstall it from here). */
  mine: boolean;
};

export type MarketplacePayload = {
  experts: MarketExpert[];
  skills: MarketSkill[];
  categories: {
    experts: string[];
    skills: string[];
    connectors: string[];
  };
};

/**
 * The writes the marketplace makes, through the stores that already own the tables.
 *
 * Narrowed with `Pick` rather than re-declared, so a store cannot grow a field this module silently
 * disagrees with. Optional the way `app.ts` hands stores around: a deployment without a plugin
 * store has no skills table to write and no grants to make, so installs that need one are refused
 * rather than half-done. Reading the catalogue still works — a shop whose till is broken may still
 * be browsed.
 */
export type MarketplaceDeps = {
  installs: MarketplaceStore;
  /** Creates and soft-deletes the Bot an expert install instantiates. */
  agents?: Pick<BotCatalog, "createBot" | "softDeleteBot">;
  /** Grants the expert's skills to the Bot it created. */
  grants?: Pick<ToolAccess, "grant">;
  /** Writes and uninstalls catalogue skills, and answers who holds a slug. */
  skillWrites?: Pick<
    ToolAccess,
    "installSkill" | "uninstallSkill" | "skillOwner"
  >;
  auditStore?: AuditStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
};

export function createMarketplaceRoutes(deps: MarketplaceDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const record = async (
    context: { var: AppVariables },
    change: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (!deps.auditStore) return;
    try {
      await recordAuditEvent(deps.auditStore, {
        eventType: "configuration.changed",
        targetType: "marketplace",
        targetId: String(payload.slug ?? ""),
        ...(context.var.actor.email
          ? { actorUserId: context.var.actor.id }
          : {}),
        payload: {
          actor: context.var.actor.email ?? "unknown",
          change,
          ...payload,
        },
      });
    } catch {
      // The change already happened and the caller has been told; a trail that is briefly
      // unavailable is not a failure the person can act on. Same stance the agents routes take.
    }
  };

  routes.get("/", deps.requireUser, async (context) => {
    const me = context.var.actor.id;
    const [installedSkills, installedExperts] = await Promise.all([
      deps.installs.visibleSkills(
        me,
        CATALOGUE_SKILLS.map((skill) => skill.slug),
      ),
      deps.installs.installsFor(me),
    ]);

    const skillBySlug = new Map(installedSkills.map((row) => [row.slug, row]));
    const expertBySlug = new Map(
      installedExperts.map((row) => [row.expertSlug, row.agentId]),
    );

    const payload: MarketplacePayload = {
      experts: CATALOGUE_EXPERTS.map((expert) => {
        const agentId = expertBySlug.get(expert.slug) ?? null;
        return {
          ...expert,
          installed: agentId !== null,
          agentId,
        };
      }),
      skills: CATALOGUE_SKILLS.map((skill) => {
        const row = skillBySlug.get(skill.slug);
        return {
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          icon: skill.icon,
          category: skill.category,
          installed: row !== undefined,
          mine: row?.ownerUserId === me,
        };
      }),
      categories: {
        experts: [...EXPERT_CATEGORIES],
        skills: [...EXPERT_CATEGORIES],
        connectors: [...CONNECTOR_CATEGORIES],
      },
    };
    return context.json(payload);
  });

  /**
   * Install an expert: create the person's own Bot from the template and grant it the expert's
   * skills.
   *
   * Idempotent by receipt: a second press answers the first install's Bot rather than creating a
   * twin. The receipt row cascades on Bot deletion, so a person who deleted their installed Bot
   * from the roster can install again and gets a fresh one.
   */
  routes.post("/experts/:slug/install", deps.requireUser, async (context) => {
    const slug = context.req.param("slug");
    const expert = CATALOGUE_EXPERTS.find((entry) => entry.slug === slug);
    if (!expert) {
      return context.json({ error: "No such expert in the catalogue." }, 404);
    }
    if (!deps.agents) {
      return context.json(
        { error: "This deployment cannot create Bots." },
        503,
      );
    }
    // The card promises "install and it works": a deployment that cannot attach the expert's
    // skills must refuse rather than create a Bot without them.
    if (expert.skills.length > 0 && !(deps.skillWrites && deps.grants)) {
      return context.json(
        { error: "This deployment cannot install skills." },
        503,
      );
    }
    const actor = context.var.actor;
    const agentActor = { id: actor.id, role: actor.role };

    const existing = await deps.installs.installFor(actor.id, slug);
    if (existing) {
      return context.json({ agentId: existing.agentId, installed: true });
    }

    /*
     * The same shape `POST /api/agents` writes for an endpoint-less coworker: the persona runs as
     * the standing role message, and as the built-in system prompt when there is no managed Bot to
     * run on (where the create store keeps it as the only instruction the Bot gets).
     */
    const agent = await deps.agents.createBot(agentActor, {
      name: expert.name,
      title: expert.name,
      roleDescription: expert.roleDescription,
      visibility: "private",
      systemPrompt: expert.roleDescription,
    });

    /*
     * The card's promise is "install and it works", so the expert arrives with its skills, not
     * only pointing at them: each catalogue skill the expert names is installed into this
     * person's own skills (unless a row they can already see holds the slug — theirs or the
     * deployment's, which is exactly as good), and then granted to the Bot.
     *
     * A slug held by SOMEBODY ELSE is skipped rather than fatal: their private skill is invisible
     * here, the grant could never attach to anything this Bot would be offered, and one collision
     * should not keep the other skills off a Bot the person just asked for. What was and was not
     * installed is in the trail row.
     */
    const grantedSkills: string[] = [];
    const skippedSkills: string[] = [];
    try {
      if (deps.skillWrites && deps.grants) {
        for (const skillSlug of expert.skills) {
          const entry = CATALOGUE_SKILLS.find(
            (skill) => skill.slug === skillSlug,
          );
          if (!entry) continue;
          let owner = await deps.skillWrites.skillOwner(skillSlug);
          if (owner === undefined) {
            await deps.skillWrites.installSkill({
              slug: entry.slug,
              title: entry.title,
              summary: entry.summary,
              instructions: entry.instructions,
              origin: "catalogue",
              icon: entry.icon,
              category: entry.category,
              ownerUserId: actor.id,
              tools: [],
              by: actor.email,
            });
            // Recheck after the write: a concurrent install of the same slug may have won
            // the row (conflicts keep the first owner), and this loop must not grant a
            // skill this person does not hold.
            owner = await deps.skillWrites.skillOwner(skillSlug);
          }
          if (owner === undefined || owner === actor.id || owner === null) {
            await deps.grants.grant("skill", skillSlug, agent.id, actor.email);
            grantedSkills.push(skillSlug);
          } else {
            skippedSkills.push(skillSlug);
          }
        }
      }
    } catch (error) {
      // The Bot exists but the receipt never landed: retire the twin here, so a failed
      // grant or skill write cannot leave an unaccounted Bot on the roster. The person's
      // retry starts clean.
      await deps.agents.softDeleteBot(agentActor, agent.id).catch(() => undefined);
      throw error;
    }

    const inserted = await deps.installs.insert({
      ownerUserId: actor.id,
      expertSlug: slug,
      agentId: agent.id,
    });
    if (!inserted) {
      // A concurrent second press holds the receipt. Its Bot is the answer; this twin has none and
      // would sit on the roster forever unaccounted, so it is retired here.
      await deps.agents.softDeleteBot(agentActor, agent.id);
      const winner = await deps.installs.installFor(actor.id, slug);
      // The trail row the winner's answer already wrote covers the install; this records
      // that a concurrent twin was created and retired, so the Bot audit is not orphaned.
      await record(context, "expert_installed", {
        slug,
        bot: winner?.agentId ?? agent.id,
        twinRetired: agent.id,
      });
      return context.json({
        agentId: winner?.agentId ?? agent.id,
        installed: true,
      });
    }

    await record(context, "expert_installed", {
      slug,
      bot: agent.id,
      skills: grantedSkills,
      ...(skippedSkills.length > 0 ? { skippedSkills } : {}),
    });
    return context.json({ agentId: agent.id, installed: true }, 201);
  });

  routes.delete("/experts/:slug/install", deps.requireUser, async (context) => {
    const slug = context.req.param("slug");
    const actor = context.var.actor;
    const existing = await deps.installs.installFor(actor.id, slug);
    if (!existing) {
      return context.json({ error: "This expert is not installed." }, 404);
    }
    // The Bot first: its receipt is the thing that says it exists, and the card flips on the row.
    if (deps.agents) {
      await deps.agents.softDeleteBot(
        { id: actor.id, role: actor.role },
        existing.agentId,
      );
    }
    await deps.installs.remove(actor.id, slug);
    await record(context, "expert_uninstalled", {
      slug,
      bot: existing.agentId,
    });
    return context.json({ installed: false });
  });

  /**
   * Install a catalogue skill: write the person's own skills row from the entry, catalogue
   * metadata included.
   *
   * The body is empty ON PURPOSE. What lands in the skills table is what the catalogue published,
   * read here rather than trusted from the client — a card that could post arbitrary instructions
   * under a reviewed slug would make the tree review decorative.
   */
  routes.post("/skills/:slug/install", deps.requireUser, async (context) => {
    const slug = context.req.param("slug");
    const entry = CATALOGUE_SKILLS.find((skill) => skill.slug === slug);
    if (!entry) {
      return context.json({ error: "No such skill in the catalogue." }, 404);
    }
    if (!deps.skillWrites) {
      return context.json(
        { error: "This deployment cannot install skills." },
        503,
      );
    }
    const actor = context.var.actor;
    const owner = await deps.skillWrites.skillOwner(slug);
    if (owner !== undefined) {
      // Somebody holds the slug. Their own (or the deployment's) reads as already installed;
      // a stranger's is a conflict the marketplace card cannot resolve from here.
      if (owner === actor.id || owner === null) {
        return context.json({ installed: true });
      }
      return context.json(
        {
          error:
            "该技能标识已被其他成员占用。可以让管理员将其设为工作区技能，或换一个标识。",
        },
        409,
      );
    }
    await deps.skillWrites.installSkill({
      slug: entry.slug,
      title: entry.title,
      summary: entry.summary,
      instructions: entry.instructions,
      origin: "catalogue",
      icon: entry.icon,
      category: entry.category,
      ownerUserId: actor.id,
      tools: [],
      by: actor.email,
    });
    // Recheck after the write: a concurrent install of the same slug wins the row's
    // ownership (conflicts keep the first owner), and a 201 here would promise a row this
    // person does not hold. Only a real third-party owner conflicts — a missing row (a
    // concurrent uninstall won) simply reads as not installed, the same as before the write.
    const landedOwner = await deps.skillWrites.skillOwner(slug);
    if (typeof landedOwner === "string" && landedOwner !== actor.id) {
      return context.json(
        {
          error:
            "该技能标识已被其他成员占用。可以让管理员将其设为工作区技能，或换一个标识。",
        },
        409,
      );
    }
    await record(context, "skill_installed", { slug });
    return context.json({ installed: true }, 201);
  });

  routes.delete("/skills/:slug/install", deps.requireUser, async (context) => {
    const slug = context.req.param("slug");
    if (!CATALOGUE_SKILLS.some((skill) => skill.slug === slug)) {
      return context.json({ error: "No such skill in the catalogue." }, 404);
    }
    if (!deps.skillWrites) {
      return context.json(
        { error: "This deployment cannot uninstall skills." },
        503,
      );
    }
    const actor = context.var.actor;
    const owner = await deps.skillWrites.skillOwner(slug);
    if (owner === undefined) {
      return context.json({ error: "This skill is not installed." }, 404);
    }
    if (owner === null) {
      return context.json(
        { error: "这是工作区技能，请由管理员在技能页管理。" },
        403,
      );
    }
    if (owner !== actor.id) {
      return context.json({ error: "这不是你安装的技能。" }, 403);
    }
    await deps.skillWrites.uninstallSkill(slug, actor.email);
    await record(context, "skill_uninstalled", { slug });
    return context.json({ installed: false });
  });

  return routes;
}
