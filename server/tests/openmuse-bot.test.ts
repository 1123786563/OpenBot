import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import {
  createOpenMuseBotProvisioner,
  OPENMUSE_TEMPLATE_KEY,
  OPENMUSE_TEMPLATE_VERSION,
  type OpenMuseBotProvisioner,
  type OpenMuseTemplateStore,
} from "../src/mobile-bff/openmuse-bot";
import { createMobileBffRoutes } from "../src/mobile-bff/routes";
import { createMobileBffWorkspace } from "../src/mobile-bff/workspace";

const actorOne: AuthenticatedActor = {
  id: "user-1",
  email: "one@openbot.test",
  role: "user",
};

const actorTwo: AuthenticatedActor = {
  id: "user-2",
  email: "two@openbot.test",
  role: "user",
};

/*
 * The guard is switchable so one app can provision as two different people.
 */
let currentActor: AuthenticatedActor = actorOne;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "OpenMuse",
    title: "OpenMuse",
    roleDescription: "Your private OpenMuse assistant.",
    avatarSeed: "openmuse",
    visibility: "private",
    ownerUserId: "user-1",
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

/**
 * An in-memory template store: the same contract the drizzle-backed
 * `openmuse-template-store.ts` implements, including the unique-violation a
 * concurrent loser sees once one row for (owner, templateKey) exists.
 */
function fakeTemplateStore() {
  const rows: (AgentProfile & {
    templateKey: string | null;
    templateVersion: number;
  })[] = [];
  let createsAttempted = 0;
  const store: OpenMuseTemplateStore = {
    async findByTemplateKey(ownerUserId, templateKey) {
      // One microtask, so two racing provisions both read "absent" before
      // either insert lands — the window the unique index has to close.
      await Promise.resolve();
      return (
        rows.find(
          (row) =>
            row.ownerUserId === ownerUserId &&
            row.templateKey === templateKey &&
            row.deletedAt === null,
        ) ?? null
      );
    },
    async createFromTemplate(ownerUserId, template) {
      createsAttempted += 1;
      await Promise.resolve();
      const existing = rows.find(
        (row) =>
          row.ownerUserId === ownerUserId &&
          row.templateKey === template.templateKey,
      );
      if (existing) {
        if (existing.deletedAt !== null) {
          /*
           * A soft-deleted Bot keeps its (owner, key) pair, so the INSERT
           * loses the unique index to the tombstone — the store's violation
           * branch revives it: clear deletedAt, re-apply the managed fields.
           */
          existing.deletedAt = null;
          existing.name = template.name;
          existing.title = template.title;
          existing.roleDescription = template.roleDescription;
          existing.visibility = template.visibility;
          existing.templateVersion = template.version;
          return existing;
        }
        // What PostgreSQL answers the loser with: error code 23505.
        throw Object.assign(new Error("duplicate template Bot"), {
          code: "23505",
        });
      }
      const created: AgentProfile & {
        templateKey: string;
        templateVersion: number;
      } = {
        ...profile({
          id: `agent_openmuse_${rows.length + 1}`,
          ownerUserId,
          visibility: "private",
        }),
        templateKey: template.templateKey,
        templateVersion: template.version,
      };
      rows.push(created);
      return created;
    },
    list(actor) {
      // The roster seam the workspace reads: a private Bot is visible only to
      // its owner, which is what `accessFilter` enforces against the database.
      return Promise.resolve(
        rows.filter(
          (row) =>
            row.deletedAt === null &&
            (row.visibility === "public" || row.ownerUserId === actor.id),
        ) as AgentProfile[],
      );
    },
  };
  return {
    store,
    rows,
    createsAttempted: () => createsAttempted,
  };
}

function provisionerFor(store: OpenMuseTemplateStore): OpenMuseBotProvisioner {
  return createOpenMuseBotProvisioner({
    agentProfileStore: store,
    computerProfileIdFor: async (bot) => `computer-${bot.id}`,
  });
}

function appFor(
  overrides: {
    provisioner?: OpenMuseBotProvisioner;
    store?: OpenMuseTemplateStore;
  } = {},
) {
  const store = overrides.store ?? fakeTemplateStore().store;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMobileBffRoutes({
      requireUser,
      agentProfileStore: store,
      channelStore: {
        async direct(_actor, agentId) {
          return channel({ agentIds: [agentId] });
        },
        async list() {
          return { channels: [], nextCursor: null };
        },
      } as unknown as ChannelStore,
      workspace: createMobileBffWorkspace({ agentProfileStore: store }),
      ...(overrides.provisioner
        ? { openMuseProvisioner: overrides.provisioner }
        : {}),
    }),
  );
  return app;
}

function channel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "channel-1",
    name: "OpenMuse",
    agentIds: ["bot-1"],
    threadId: "thread-1",
    active: true,
    lastMessageAt: null,
    ...overrides,
  };
}

describe("POST /openmuse-bot", () => {
  test("first call provisions one private Bot owned by the caller", async () => {
    const fake = fakeTemplateStore();
    const response = await appFor({
      provisioner: provisionerFor(fake.store),
    }).request("/openmuse-bot", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templateVersion).toBe(OPENMUSE_TEMPLATE_VERSION);
    expect(body.computerProfileId).toBe(`computer-${body.botId}`);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      id: body.botId,
      visibility: "private",
      ownerUserId: actorOne.id,
      templateKey: OPENMUSE_TEMPLATE_KEY,
    });
  });

  test("second call returns the same Bot and creates nothing", async () => {
    const fake = fakeTemplateStore();
    const app = appFor({ provisioner: provisionerFor(fake.store) });
    const first = await (
      await app.request("/openmuse-bot", { method: "POST" })
    ).json();
    const second = await (
      await app.request("/openmuse-bot", { method: "POST", body: "{}" })
    ).json();
    expect(second.botId).toBe(first.botId);
    expect(fake.rows).toHaveLength(1);
    expect(fake.createsAttempted()).toBe(1);
  });

  test("concurrent provisions both resolve the one winner's Bot", async () => {
    const fake = fakeTemplateStore();
    const provisioner = provisionerFor(fake.store);
    const [a, b] = await Promise.all([
      provisioner.provision(actorOne),
      provisioner.provision(actorOne),
    ]);
    expect(a.botId).toBe(b.botId);
    expect(a.templateVersion).toBe(1);
    expect(fake.rows).toHaveLength(1);
    // Both inserts were attempted; the unique index let exactly one through.
    expect(fake.createsAttempted()).toBe(2);
  });

  test("refuses a body carrying a user id with 400, accepts an empty one", async () => {
    const fake = fakeTemplateStore();
    const app = appFor({ provisioner: provisionerFor(fake.store) });
    const refused = await app.request("/openmuse-bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "someone-else" }),
    });
    expect(refused.status).toBe(400);
    expect(fake.rows).toHaveLength(0);
    const accepted = await app.request("/openmuse-bot", { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(fake.rows).toHaveLength(1);
  });

  test("is unreachable without an authenticated session", async () => {
    const fake = fakeTemplateStore();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createMobileBffRoutes({
        // The guard the real mount installs: refuse before any handler runs.
        requireUser: async (context) =>
          context.json({ error: "Sign in first." }, 401),
        workspace: createMobileBffWorkspace({ agentProfileStore: fake.store }),
        openMuseProvisioner: provisionerFor(fake.store),
      }),
    );
    const response = await app.request("/openmuse-bot", { method: "POST" });
    expect(response.status).toBe(401);
    expect(fake.rows).toHaveLength(0);
  });

  test("two different actors get two different Bots", async () => {
    const fake = fakeTemplateStore();
    const provisioner = provisionerFor(fake.store);
    const [forOne, forTwo] = await Promise.all([
      provisioner.provision(actorOne),
      provisioner.provision(actorTwo),
    ]);
    expect(forOne.botId).not.toBe(forTwo.botId);
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows.map((row) => row.ownerUserId).sort()).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  test("answers 503 when the deployment has no provisioner", async () => {
    const response = await appFor().request("/openmuse-bot", {
      method: "POST",
    });
    expect(response.status).toBe(503);
  });

  test("re-provisions after a soft delete revives the tombstoned Bot", async () => {
    const fake = fakeTemplateStore();
    const app = appFor({ provisioner: provisionerFor(fake.store) });
    const first = await (
      await app.request("/openmuse-bot", { method: "POST" })
    ).json();
    // The roster's delete: soft, the row stays as a tombstone holding the
    // (owner, templateKey) pair.
    fake.rows[0].deletedAt = new Date("2026-10-12T00:00:00Z");
    const response = await app.request("/openmuse-bot", { method: "POST" });
    // Not a 500: the store's unique-violation branch revives the tombstone
    // rather than surfacing a conflict the re-read cannot resolve.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.botId).toBe(first.botId);
    expect(body.templateVersion).toBe(OPENMUSE_TEMPLATE_VERSION);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].deletedAt).toBeNull();
  });
});

describe("GET /workspace isolation", () => {
  test("one actor's workspace never lists another actor's private Bot", async () => {
    const fake = fakeTemplateStore();
    const provisioner = provisionerFor(fake.store);
    await provisioner.provision(actorTwo);
    currentActor = actorOne;
    try {
      const response = await appFor({
        store: fake.store,
        provisioner,
      }).request("/workspace");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(
        body.agents.some(
          (agent: { id: string }) => agent.id === fake.rows[0].id,
        ),
      ).toBe(false);
      expect(body.agents).toEqual([]);
    } finally {
      currentActor = actorOne;
    }
  });
});
