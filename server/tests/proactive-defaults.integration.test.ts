import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { defaultOptOuts } from "../src/db/schema/defaults";
import { proactiveSettings } from "../src/db/schema/proactive";
import {
  createResearchDefaults,
  DEFAULT_RESEARCH_INTERVAL_MINUTES,
  lockResearchDefaults,
} from "../src/proactive/defaults";
import { createProactiveStore } from "../src/proactive/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Background research, on by default (proactive/defaults.ts; the default's memory-source half
 * left with the old memory engine in #732). Behaviour, against the real schema:
 * adoption, the person's no (a turned-off row, a removal's opt-out), the delivery and
 * deployment gates, and the personSpoke hook a solo conversation rides.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `rdefaults-owner-${suite}`;
const other = `rdefaults-other-${suite}`;
const bot = `rdefaults-bot-${suite}`;
const secondBot = `rdefaults-second-bot-${suite}`;
const channel = `rdefaults-channel-${suite}`;
const proactive = createProactiveStore(database);

function defaults(
  overrides: Partial<Parameters<typeof createResearchDefaults>[0]> = {},
) {
  return createResearchDefaults({
    database,
    research: true,
    channelBots: async () => [bot],
    canDeliver: async (person) => person === owner,
    mintThreadId: () => `thread-${randomUUID()}`,
    minIntervalMs: 0,
    log: () => {},
    ...overrides,
  });
}

const researchOf = (person: string, agentId: string) =>
  database
    .select()
    .from(proactiveSettings)
    .where(
      and(
        eq(proactiveSettings.ownerUserId, person),
        eq(proactiveSettings.agentId, agentId),
      ),
    );

async function reset() {
  await database
    .delete(proactiveSettings)
    .where(inArray(proactiveSettings.ownerUserId, [owner, other]));
  await database
    .delete(defaultOptOuts)
    .where(inArray(defaultOptOuts.ownerUserId, [owner, other]));
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values(
    [bot, secondBot].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  await database.insert(agentProfiles).values(
    [bot, secondBot].map((agentId) => ({
      agentId,
      ownerUserId: owner,
      title: agentId,
      roleDescription: "Assist",
      avatarSeed: agentId,
      visibility: "private" as const,
    })),
  );
});

afterAll(async () => {
  await reset();
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, [bot, secondBot]));
  await database.delete(agents).where(inArray(agents.id, [bot, secondBot]));
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.end();
});

describe("background research, on by default", () => {
  test("a fresh person gets research from the Bot they talk to, read-only and a full interval out", async () => {
    await reset();
    const before = Date.now();
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(true);
    const [setting] = await researchOf(owner, bot);
    expect(setting).toMatchObject({
      channelId: channel,
      enabled: true,
      intervalMinutes: DEFAULT_RESEARCH_INTERVAL_MINUTES,
      lastStatus: "idle",
    });
    expect(setting?.nextRunAt.getTime()).toBeGreaterThanOrEqual(
      before + DEFAULT_RESEARCH_INTERVAL_MINUTES * 60_000 - 1_000,
    );
    // Not due, so the sweep does not take it.
    expect(
      (await proactive.claimDue(10)).some((row) => row.id === setting?.id),
    ).toBe(false);
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toHaveLength(1);
  });

  test("research the person turned off stays off", async () => {
    await reset();
    await defaults().adoptResearch(owner, bot, channel);
    const [setting] = await researchOf(owner, bot);
    await proactive.update(owner, setting?.id as string, { enabled: false });
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toMatchObject([{ enabled: false }]);
  });

  test("research the person removed is never switched back on", async () => {
    await reset();
    await defaults().adoptResearch(owner, bot, channel);
    const [setting] = await researchOf(owner, bot);
    await proactive.remove(owner, setting?.id as string);
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    expect(await researchOf(owner, bot)).toEqual([]);
    // The removal's opt-out is the fact adoption reads, scoped to this Bot alone.
    const optedOut = await database
      .select({ agentId: defaultOptOuts.agentId })
      .from(defaultOptOuts)
      .where(eq(defaultOptOuts.ownerUserId, owner));
    expect(optedOut).toEqual([{ agentId: bot }]);
  });

  test("while a removal holds the person's lock for that Bot, adoption steps aside rather than wait", async () => {
    await reset();
    await database.transaction(async (transaction) => {
      await lockResearchDefaults(transaction, owner, bot);
      // Held: adoption must not create the row and must not block on the lock.
      expect(await defaults().adoptResearch(owner, bot, channel)).toBe(false);
    });
    // Released: the next pass adopts.
    expect(await defaults().adoptResearch(owner, bot, channel)).toBe(true);
  });

  test("the deployment switch stops personSpoke from creating anything", async () => {
    await reset();
    defaults({ research: false }).personSpoke(owner, channel);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await researchOf(owner, bot)).length) break;
      await Bun.sleep(50);
    }
    expect(await researchOf(owner, bot)).toEqual([]);
  });

  test("a removal's opt-out binds this Bot alone: another Bot still adopts", async () => {
    await reset();
    await defaults({ channelBots: async () => [bot] }).adoptResearch(
      owner,
      bot,
      channel,
    );
    const [setting] = await researchOf(owner, bot);
    await proactive.remove(owner, setting?.id as string);
    // The person said no to THIS Bot's research; secondBot is a different question.
    expect(
      await defaults({ channelBots: async () => [secondBot] }).adoptResearch(
        owner,
        secondBot,
        channel,
      ),
    ).toBe(true);
    expect(
      await defaults({ channelBots: async () => [bot] }).adoptResearch(
        owner,
        bot,
        channel,
      ),
    ).toBe(false);
  });

  test("never into a conversation the Bot cannot deliver to, and not when switched off", async () => {
    await reset();
    expect(await defaults().adoptResearch(other, bot, channel)).toBe(false);
    expect(
      await defaults({ research: false }).adoptResearch(owner, bot, channel),
    ).toBe(false);
    expect(await researchOf(owner, bot)).toEqual([]);
  });

  test("speaking in a conversation with one Bot switches research on; a group conversation does not", async () => {
    await reset();
    defaults({ channelBots: async () => [bot, secondBot] }).personSpoke(
      owner,
      channel,
    );
    await Bun.sleep(200);
    expect(await researchOf(owner, bot)).toEqual([]);
    defaults().personSpoke(owner, channel);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await researchOf(owner, bot)).length) break;
      await Bun.sleep(50);
    }
    expect(await researchOf(owner, bot)).toHaveLength(1);
  });
});
