import { describe, expect, test } from "../../tests/support/e2e-compat";
import { Hono } from "hono";
import { createMarketplaceRoutes } from "../src/marketplace/routes";
import type { MarketplaceStore } from "../src/marketplace/store";
import { CATALOGUE_EXPERTS, CATALOGUE_SKILLS } from "../src/marketplace/catalogue";

/**
 * The marketplace routes, over stub stores.
 *
 * The routes take their stores as plain dependencies rather than through `createApp`'s positional
 * list, so a test hands in the handful of methods the flows use and reads the JSON back. No
 * database: the receipts are the one state these flows decide from, and a stub that remembers what
 * `insert` was told is exact enough to pin the contract — idempotence, the race, and whose slug
 * wins.
 */

const ACTOR = { id: "user-1", email: "person@example.com", role: "user" as const };

/** A requireUser that answers as {@link ACTOR}, standing in for the auth middleware. */
const requireUser = async (
  context: { set: (key: string, value: unknown) => void },
  next: () => Promise<void>,
) => {
  context.set("actor", ACTOR);
  await next();
};

/** An in-memory receipt store with the same shape the real one answers. */
function receiptStore(): MarketplaceStore & {
  rows: Map<string, string>;
  materialiseBehindWrite: string | null;
} {
  const rows = new Map<string, string>();
  const store = {
    rows,
    /** Set by a test to simulate a receipt arriving between the read and the write. */
    materialiseBehindWrite: null as string | null,
    async installFor(ownerUserId: string, expertSlug: string) {
      const key = `${ownerUserId}/${expertSlug}`;
      return rows.has(key) ? { agentId: rows.get(key)! } : null;
    },
    async installsFor(ownerUserId: string) {
      return [...rows]
        .filter(([key]) => key.startsWith(`${ownerUserId}/`))
        .map(([key, agentId]) => ({
          expertSlug: key.slice(ownerUserId.length + 1),
          agentId,
        }));
    },
    async visibleSkills() {
      return [];
    },
    async insert(input: {
      ownerUserId: string;
      expertSlug: string;
      agentId: string;
    }) {
      if (store.materialiseBehindWrite !== null) {
        const [key, agentId] = store.materialiseBehindWrite.split(":");
        rows.set(key!, agentId!);
        store.materialiseBehindWrite = null;
        return false;
      }
      const key = `${input.ownerUserId}/${input.expertSlug}`;
      if (rows.has(key)) return false;
      rows.set(key, input.agentId);
      return true;
    },
    async remove(ownerUserId: string, expertSlug: string) {
      rows.delete(`${ownerUserId}/${expertSlug}`);
    },
  };
  return store;
}

function buildApp(overrides: {
  installs?: ReturnType<typeof receiptStore>;
  agents?: Record<string, never> | object;
  grants?: object;
  skillWrites?: object;
}) {
  const installs = overrides.installs ?? receiptStore();
  const createdBots: { name: string; prompt: string }[] = [];
  const granted: { ref: string; agentId: string }[] = [];
  const deletedBots: string[] = [];
  const installedSkills: { slug: string; icon?: string }[] = [];

  const routes = createMarketplaceRoutes({
    installs,
    agents: {
      create: async (_actor, input) => {
        createdBots.push({
          name: input.name,
          prompt: input.systemPrompt ?? input.roleDescription,
        });
        return { id: `agent-${createdBots.length}` };
      },
      softDelete: async (_actor, id) => {
        deletedBots.push(id);
      },
      ...(overrides.agents ?? {}),
    } as never,
    grants: {
      grant: async (_kind, ref, agentId) => {
        granted.push({ ref, agentId });
      },
      ...(overrides.grants ?? {}),
    } as never,
    skillWrites: {
      installSkill: async (input) => {
        installedSkills.push({ slug: input.slug, icon: input.icon });
      },
      uninstallSkill: async () => {},
      skillOwner: async () => undefined,
      ...(overrides.skillWrites ?? {}),
    } as never,
    requireUser: requireUser as never,
  });

  const app = new Hono();
  app.route("/api/marketplace", routes);
  return {
    app,
    installs,
    createdBots,
    granted,
    deletedBots,
    installedSkills,
  };
}

describe("marketplace routes", () => {
  test("GET / publishes the catalogue with nobody installed", async () => {
    const { app } = buildApp({});
    const response = await app.request("/api/marketplace");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      experts: { installed: boolean; agentId: string | null }[];
      skills: { installed: boolean }[];
      categories: { experts: string[] };
    };
    expect(body.experts.length).toBe(CATALOGUE_EXPERTS.length);
    expect(body.experts.every((expert) => !expert.installed)).toBe(true);
    expect(body.skills.length).toBe(CATALOGUE_SKILLS.length);
    expect(body.categories.experts.length).toBeGreaterThan(0);
  });

  test("installing an expert creates one Bot, ships its skills, and answers the same Bot twice", async () => {
    const { app, installs, createdBots, granted, installedSkills } = buildApp({});
    const slug = CATALOGUE_EXPERTS[0]!.slug;
    const expectedSkills = CATALOGUE_EXPERTS[0]!.skills;

    const first = await app.request(`/api/marketplace/experts/${slug}/install`, {
      method: "POST",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { agentId: string };
    expect(createdBots).toHaveLength(1);
    // The Bot carries the card's skills, and the skills EXIST: an install ships the catalogue
    // rows into the person's own list, because a grant naming no row offers the Bot nothing.
    expect(granted.map((g) => g.ref)).toEqual(expectedSkills);
    expect(installedSkills.map((s) => s.slug)).toEqual(expectedSkills);

    const second = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      { method: "POST" },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { agentId: string };
    expect(secondBody.agentId).toBe(firstBody.agentId);
    expect(createdBots).toHaveLength(1);
    expect(installs.rows.size).toBe(1);
  });

  test("an expert skill whose slug a stranger holds is skipped, and the rest still ships", async () => {
    const held = CATALOGUE_EXPERTS[0]!.skills[0]!;
    let owner: string | null | undefined =
      held === CATALOGUE_EXPERTS[0]!.skills[0] ? "user-2" : undefined;
    const { app, granted, installedSkills } = buildApp({
      skillWrites: {
        installSkill: async (input) => {
          installedSkills.push({ slug: input.slug, icon: input.icon });
        },
        uninstallSkill: async () => {},
        skillOwner: async (slug) => (slug === held ? owner : undefined),
      },
    });
    const slug = CATALOGUE_EXPERTS[0]!.slug;
    owner = "user-2";

    const response = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      { method: "POST" },
    );
    expect(response.status).toBe(201);
    // The stranger-held slug is neither installed nor granted; its siblings both are.
    expect(granted.map((g) => g.ref)).not.toContain(held);
    expect(installedSkills.map((s) => s.slug)).not.toContain(held);
    expect(granted.length).toBe(CATALOGUE_EXPERTS[0]!.skills.length - 1);
  });

  test("a lost receipt race retires the twin Bot and answers the winner", async () => {
    const { app, installs, deletedBots } = buildApp({});
    const slug = CATALOGUE_EXPERTS[0]!.slug;
    // Nothing installed yet, so the early idempotence read passes; the receipt then materialises
    // behind the write, which is what a concurrent second press is.
    installs.materialiseBehindWrite = `${ACTOR.id}/${slug}:agent-winner`;

    const response = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      { method: "POST" },
    );
    // 200, not 201: the Bot this press answers was made by the concurrent press, so nothing was
    // created for this caller — the receipt they raced for already named the winner.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agentId: string };
    expect(body.agentId).toBe("agent-winner");
    expect(deletedBots).toHaveLength(1);
    expect(deletedBots[0]).not.toBe("agent-winner");
  });

  test("installing an unknown expert is a 404", async () => {
    const { app } = buildApp({});
    const response = await app.request(
      "/api/marketplace/experts/no-such-expert/install",
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  test("uninstalling an expert removes the receipt", async () => {
    const { app, installs, deletedBots } = buildApp({});
    const slug = CATALOGUE_EXPERTS[0]!.slug;
    installs.rows.set(`${ACTOR.id}/${slug}`, "agent-1");

    const response = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(installs.rows.size).toBe(0);
    expect(deletedBots).toEqual(["agent-1"]);

    const again = await app.request(
      `/api/marketplace/experts/${slug}/install`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(404);
  });

  test("installing a catalogue skill writes it with its icon, and repeats answer installed", async () => {
    const { app, installedSkills } = buildApp({});
    const skill = CATALOGUE_SKILLS[0]!;
    const first = await app.request(
      `/api/marketplace/skills/${skill.slug}/install`,
      { method: "POST" },
    );
    expect(first.status).toBe(201);
    expect(installedSkills).toHaveLength(1);
    expect(installedSkills[0]!.icon).toBe(skill.icon);

    // The owner stub still answers undefined, so a repeat walks the write again. 201 both times —
    // the store's upsert is what makes a repeat safe, not the status code.
    const second = await app.request(
      `/api/marketplace/skills/${skill.slug}/install`,
      { method: "POST" },
    );
    expect(second.status).toBe(201);
  });

  test("a slug held by somebody else is a conflict, and the deployment's own reads as installed", async () => {
    let owner: string | null | undefined = "user-2";
    const { app } = buildApp({
      skillWrites: {
        installSkill: async () => {},
        uninstallSkill: async () => {},
        skillOwner: async () => owner,
      },
    });
    const slug = CATALOGUE_SKILLS[0]!.slug;
    const held = await app.request(`/api/marketplace/skills/${slug}/install`, {
      method: "POST",
    });
    expect(held.status).toBe(409);

    owner = ACTOR.id;
    const mine = await app.request(`/api/marketplace/skills/${slug}/install`, {
      method: "POST",
    });
    expect(mine.status).toBe(200);

    owner = null;
    const deployment = await app.request(
      `/api/marketplace/skills/${slug}/install`,
      { method: "POST" },
    );
    expect(deployment.status).toBe(200);
  });

  test("uninstalling a skill refuses the deployment's row and a stranger's", async () => {
    let owner: string | null | undefined = null;
    const { app } = buildApp({
      skillWrites: {
        installSkill: async () => {},
        uninstallSkill: async () => {},
        skillOwner: async () => owner,
      },
    });
    const slug = CATALOGUE_SKILLS[0]!.slug;

    const deployment = await app.request(
      `/api/marketplace/skills/${slug}/install`,
      { method: "DELETE" },
    );
    expect(deployment.status).toBe(403);

    owner = "user-2";
    const stranger = await app.request(
      `/api/marketplace/skills/${slug}/install`,
      { method: "DELETE" },
    );
    expect(stranger.status).toBe(403);

    owner = ACTOR.id;
    const mine = await app.request(`/api/marketplace/skills/${slug}/install`, {
      method: "DELETE",
    });
    expect(mine.status).toBe(200);
  });
});
