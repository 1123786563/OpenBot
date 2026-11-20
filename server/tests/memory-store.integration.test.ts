import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createBotReset } from "../src/agents/lifecycle-reset";
import { createAuditReader, createAuditStore } from "../src/audit";
import { type AppVariables, createRequireUser } from "../src/auth/guards";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryRuntime } from "../src/memory/runtime";
import { createMemoryStore } from "../src/memory/store";
import { MemoryNotFoundError, MemoryRefusedError } from "../src/memory/types";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memory-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const secondBot = `${prefix}-second-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/read_documents`;
let vendorText =
  '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
let vendorError = false;
/** Thrown by the vendor instead of answering, when set: how a refused call reaches a sync. */
let vendorThrows: Error | null = null;
const calls: { actorId?: string; botId?: string }[] = [];
const plugins = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (connection) => {
    calls.push(connection);
    if (vendorThrows) throw vendorThrows;
    return { text: vendorText, isError: vendorError };
  },
});
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({
  store,
  plugins,
  // The two Bots available to the owner and the private Bot belonging to the other person.
  canUseBot: async (person, agentId) =>
    (person === owner && agentId === secondBot) ||
    (await plugins.agentOwner(agentId)) === person,
});
beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
    {
      id: secondBot,
      name: "Second Memory Bot",
      type: "built_in",
      configuration: {},
    },
    { id: bot, name: "Memory Bot", type: "built_in", configuration: {} },
    {
      id: otherBot,
      name: "Other memory Bot",
      type: "remote_ag_ui",
      configuration: {},
    },
  ]);
  await database.insert(agentProfiles).values([
    {
      agentId: bot,
      ownerUserId: owner,
      title: "Memory Bot",
      roleDescription: "Assist",
      avatarSeed: bot,
      visibility: "private",
    },
    {
      agentId: otherBot,
      ownerUserId: other,
      title: "Other Bot",
      roleDescription: "Assist",
      avatarSeed: otherBot,
      visibility: "private",
    },
  ]);
  await database.insert(mcpServers).values({
    id: server,
    title: "Memory connector",
    vendor: "Fixture",
    url: "https://memory.example.test/mcp",
    provenance: "custom",
  });
  await database.insert(mcpTools).values([
    {
      serverId: server,
      name: "read_documents",
      vendorName: "read_documents",
      effect: "read",
      inputSchema: {},
    },
    {
      serverId: server,
      name: "write_document",
      vendorName: "write_document",
      effect: "write",
      inputSchema: {},
    },
  ]);
  await plugins.grant("mcp", ref, bot, owner);
  await plugins.grant("mcp", `${server}/write_document`, bot, owner);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database
    .delete(agents)
    .where(inArray(agents.id, [bot, otherBot, secondBot]));
  await database.delete(mcpServers).where(eq(mcpServers.id, server));
  await database.$client.close();
});
async function source() {
  vendorError = false;
  vendorText =
    '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
  return (
    await ingestion.createSource(owner, {
      agentId: bot,
      toolRef: ref,
      title: "Project files",
      args: {},
    })
  ).source;
}
test("facts are owner scoped on list, edit and delete", async () => {
  const fact = await store.create(owner, { content: "Private preference" });
  expect((await store.list(other)).some((row) => row.id === fact.id)).toBe(
    false,
  );
  await expect(
    store.update(other, fact.id, { content: "stolen" }),
  ).rejects.toBeInstanceOf(MemoryNotFoundError);
  await expect(store.remove(other, fact.id)).rejects.toBeInstanceOf(
    MemoryNotFoundError,
  );
});
test("manual edit and disable change the next selected context", async () => {
  const fact = await store.create(owner, { content: "Rare first fact" });
  await store.update(owner, fact.id, { content: "Rare revised fact" });
  expect(await ingestion.contextFor(owner, bot)).toContain("Rare revised fact");
  await store.update(owner, fact.id, { enabled: false });
  expect(await ingestion.contextFor(owner, bot)).not.toContain(
    "Rare revised fact",
  );
});
test("forget removes manual facts immediately", async () => {
  const fact = await store.create(owner, { content: "Forgotten unique fact" });
  await store.remove(owner, fact.id);
  expect(await ingestion.contextFor(owner, bot)).not.toContain(
    "Forgotten unique fact",
  );
});
test("opted-in connector uses actual plugin authority and execution", async () => {
  const value = await source();
  expect(calls.at(-1)?.actorId).toBe(owner);
  expect(calls.at(-1)?.botId).toBe(bot);
  expect(value.syncStatus).toBe("succeeded");
  expect(await ingestion.contextFor(owner, bot)).toContain(
    "Project launch is Tuesday",
  );
  expect(await ingestion.contextFor(other, otherBot)).not.toContain(
    "Project launch is Tuesday",
  );
});
test("changed connector content updates the same row without duplicates", async () => {
  const value = await source();
  const before = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  vendorText =
    '[{"id":"doc1","text":"Project launch moved to Friday","title":"Roadmap"}]';
  await ingestion.sync(owner, value.id);
  const rows = (await store.list(owner)).filter(
    (row) => row.sourceId === value.id,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(before?.id);
  expect(rows[0]?.content).toContain("Friday");
});
test("disabled source is absent even while its imported facts remain stored", async () => {
  const value = await source();
  await store.setSourceEnabled(owner, value.id, false);
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
});
test("deleted imported fact cannot resurrect during the next sync", async () => {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.remove(owner, fact.id);
  vendorText = '[{"id":"doc1","text":"Updated deleted fact"}]';
  await ingestion.sync(owner, value.id);
  expect((await store.list(owner)).some((row) => row.id === fact.id)).toBe(
    false,
  );
});
test("a person's edit survives later connector changes", async () => {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.update(owner, fact.id, { content: "My corrected roadmap" });
  vendorText = '[{"id":"doc1","text":"Vendor changed roadmap"}]';
  await ingestion.sync(owner, value.id);
  expect(
    (await store.list(owner)).find((row) => row.id === fact.id)?.content,
  ).toBe("My corrected roadmap");
});
test("write tools and another person's Bot cannot become ambient sources", async () => {
  await expect(
    ingestion.createSource(owner, {
      agentId: bot,
      toolRef: `${server}/write_document`,
      title: "unsafe",
      args: {},
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
  await expect(
    ingestion.createSource(owner, {
      agentId: otherBot,
      toolRef: ref,
      title: "stolen",
      args: {},
    }),
  ).rejects.toBeInstanceOf(MemoryRefusedError);
});
test("revoked grants immediately remove retrieval and expose source error", async () => {
  const value = await source();
  await plugins.revoke("mcp", ref, bot, owner);
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
  expect((await store.getSource(owner, value.id)).syncError).toContain(
    "no longer has access",
  );
  await plugins.grant("mcp", ref, bot, owner);
});
test("vendor failure hides stale source facts and records a visible error", async () => {
  const value = await source();
  vendorError = true;
  await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
    MemoryRefusedError,
  );
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
  expect((await store.getSource(owner, value.id)).syncStatus).toBe("error");
  vendorError = false;
});
test("a refusal carrying an app card is said for the sources page, not stored raw", async () => {
  const value = await source();
  vendorThrows = new PluginRefusedError(
    connectAppRefusal({
      serverId: server,
      title: "Docs",
      message:
        "Your Docs account is no longer connected at the vendor. Reconnect it and ask again.",
      reason: "reconnect",
    }),
    null,
  );
  try {
    await expect(ingestion.sync(owner, value.id)).rejects.toBeInstanceOf(
      PluginRefusedError,
    );
    const { syncError } = await store.getSource(owner, value.id);
    expect(syncError).toBe(
      "Your Docs account needs reconnecting. Reconnect it under Connections, then sync again.",
    );
    expect(syncError).not.toContain("[connect-app]");
  } finally {
    vendorThrows = null;
  }
});
test("source leases prevent competing connector calls", async () => {
  const value = await source();
  const results = await Promise.all([
    store.claimSync(owner, value.id),
    store.claimSync(owner, value.id),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await store.failSync(owner, value.id, "Test lease released");
});
test("removing a source deletes its imported records", async () => {
  const value = await source();
  await store.removeSource(owner, value.id);
  expect(
    await database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          eq(personalMemories.sourceId, value.id),
        ),
      ),
  ).toHaveLength(0);
});
test("a resync of a healthy source keeps its facts in recall while it runs", async () => {
  const value = await source();
  expect(await store.claimSync(owner, value.id)).not.toBeNull();
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(true);
  // A source whose last sync failed stays hidden while it retries, as above.
  await store.failSync(owner, value.id, "Vendor unavailable");
  await database
    .update(memorySources)
    .set({ nextSyncAt: new Date(0) })
    .where(eq(memorySources.id, value.id));
  expect(await store.claimSync(owner, value.id)).not.toBeNull();
  expect(
    (await ingestion.recall(owner, bot)).some(
      (row) => row.sourceId === value.id,
    ),
  ).toBe(false);
  await store.failSync(owner, value.id, "Test lease released");
});
test("recall reaches this Bot's memories however many other Bots' are newer", async () => {
  const mine = randomUUID();
  await database.insert(personalMemories).values({
    id: mine,
    ownerUserId: owner,
    content: "The quarterly review is in the Lisbon office",
    provenance: "Read from Docs",
    formedBy: "bot",
    formedByAgentId: bot,
    sourceRef: ref,
  });
  // Six hundred newer memories formed by another Bot for the same person.
  await database.insert(personalMemories).values(
    Array.from({ length: 600 }, (_, index) => ({
      id: randomUUID(),
      ownerUserId: owner,
      content: `Other Bot fact ${index}`,
      provenance: "Read elsewhere",
      formedBy: "bot" as const,
      formedByAgentId: otherBot,
      updatedAt: new Date(Date.now() + 60_000 + index),
    })),
  );
  try {
    const found = await ingestion.recall(owner, bot, "lisbon");
    expect(found.map((row) => row.id)).toEqual([mine]);
  } finally {
    await database
      .delete(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, owner),
          inArray(personalMemories.formedByAgentId, [bot, otherBot]),
        ),
      );
  }
});
test("the same fact formed at once by two runs is stored once", async () => {
  const content = `Concurrent fact ${randomUUID()}`;
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      store.formMemory(owner, {
        agentId: bot,
        content,
        sourceApp: "Docs",
        sourceRef: ref,
      }),
    ),
  );
  const rows = await database
    .select({ id: personalMemories.id })
    .from(personalMemories)
    .where(
      and(
        eq(personalMemories.ownerUserId, owner),
        eq(personalMemories.content, content),
      ),
    );
  expect(rows).toHaveLength(1);
  expect(new Set(results.map((result) => result.id)).size).toBe(1);
  expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
});

test("the same fact formed by two Bots is kept for each, and each recalls only its own", async () => {
  const content = `Two-Bot fact ${randomUUID()}`;
  await plugins.grant("mcp", ref, secondBot, owner);
  try {
    const first = await store.formMemory(owner, {
      agentId: bot,
      content,
      sourceApp: "Docs",
      sourceRef: ref,
    });
    const second = await store.formMemory(owner, {
      agentId: secondBot,
      content,
      sourceApp: "Docs",
      sourceRef: ref,
    });
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: false, forgotten: false });
    expect(second.id).not.toBe(first.id);
    // The same Bot forming it again is still a duplicate of its own row.
    expect(
      await store.formMemory(owner, {
        agentId: secondBot,
        content,
        sourceApp: "Docs",
        sourceRef: ref,
      }),
    ).toEqual({ id: second.id, duplicate: true, forgotten: false });
    const term = content.slice(-12);
    expect(
      (await ingestion.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([first.id]);
    expect(
      (await ingestion.recall(owner, secondBot, term)).map((row) => row.id),
    ).toEqual([second.id]);
  } finally {
    await plugins.revoke("mcp", ref, secondBot, owner);
    await database
      .delete(personalMemories)
      .where(eq(personalMemories.content, content));
  }
});

test("a fact the person forgot from one Bot is not formed again by another", async () => {
  const content = `Forgotten fact ${randomUUID()}`;
  const later = `Forgotten later ${randomUUID()}`;
  const formed: string[] = [];
  const form = async (agentId: string, text: string) => {
    const result = await store.formMemory(owner, {
      agentId,
      content: text,
      sourceApp: "Docs",
    });
    formed.push(result.id);
    return result;
  };
  try {
    const first = await form(bot, content);
    await store.remove(owner, first.id);
    expect(await form(otherBot, content)).toEqual({
      id: first.id,
      duplicate: true,
      forgotten: true,
    });
    // Also when the other Bot had already formed it before the person forgot the first copy.
    const mine = await form(bot, later);
    await form(otherBot, later);
    await store.remove(owner, mine.id);
    expect(await form(otherBot, later)).toEqual({
      id: mine.id,
      duplicate: true,
      forgotten: true,
    });
  } finally {
    // A forgotten row keeps no content, so it is found by id.
    await database
      .delete(personalMemories)
      .where(inArray(personalMemories.id, formed));
  }
});

test("resetting one Bot leaves another Bot's copy of the same fact", async () => {
  const content = `Reset fact ${randomUUID()}`;
  const reset = createBotReset({ database, softDeleteChannel: async () => {} });
  try {
    await store.formMemory(owner, { agentId: bot, content, sourceApp: "Docs" });
    const kept = await store.formMemory(owner, {
      agentId: otherBot,
      content,
      sourceApp: "Docs",
    });
    await reset.execute({ id: owner, role: "user" }, bot);
    const rows = await database
      .select({
        id: personalMemories.id,
        agentId: personalMemories.formedByAgentId,
      })
      .from(personalMemories)
      .where(eq(personalMemories.content, content));
    expect(rows).toEqual([{ id: kept.id, agentId: otherBot }]);
  } finally {
    await database
      .delete(personalMemories)
      .where(eq(personalMemories.content, content));
  }
});

test("a pending Bot memory disappears when its exact read grant is revoked, even with another grant to the app", async () => {
  const content = "Stored exact-grant review fixture";
  const formed = await store.formMemory(owner, {
    agentId: bot,
    content,
    sourceApp: "Memory connector",
    sourceRef: ref,
  });
  await plugins.grant("mcp", ref, bot, owner);
  await plugins.grant("mcp", `${server}/write_document`, bot, owner);
  try {
    expect(await ingestion.contextFor(owner, bot)).toContain(content);
    await plugins.revoke("mcp", ref, bot, owner);
    expect(await ingestion.contextFor(owner, bot)).not.toContain(content);
    expect(await ingestion.recall(owner, bot, "exact-grant")).toEqual([]);
  } finally {
    await plugins.grant("mcp", ref, bot, owner);
    await store.remove(owner, formed.id);
  }
});

test("a foreign Bot cannot assemble even the person's own manual memory", async () => {
  await store.create(owner, { content: "Private cross-Bot fixture" });
  expect(await ingestion.contextFor(owner, otherBot)).toBe("");
});

test("signed-in people manage separate local Memory settings and revocation reaches the next Bot context with an audit record", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:39091",
    secret: "memory-acceptance-local-fixture-signing-secret",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
  });
  async function signIn(person: string) {
    const response = await auth.api.signUpEmail({
      body: {
        email: `${person}@example.test`,
        password: "local-fixture-password",
        name: person,
      },
      asResponse: true,
    });
    expect(response.ok).toBe(true);
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }
  const [ownerCookie, otherCookie] = await Promise.all([
    signIn(owner),
    signIn(other),
  ]);
  const requireUser = createRequireUser(
    {
      handler: auth.handler,
      api: {
        async getSession(input) {
          const session = await auth.api.getSession(input);
          if (!session) return null;
          const person = [owner, other].find(
            (id) => session.user.email === `${id}@example.test`,
          );
          if (!person) return null;
          return { user: { ...session.user, id: person } };
        },
      },
    },
    { rolesForUser: async () => ["user"] },
  );
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/memory", createMemoryRoutes(store, ingestion, requireUser));
  const runtime = createMemoryRuntime({
    edition: "team",
    defaults: { botTurn() {} },
    ingestion,
    store,
  });
  const load = runtime.loadForActor;
  if (!load) throw new Error("Cloud Memory must be enabled.");
  const settings = (cookie: string, method: string, id = "", body?: unknown) =>
    app.request(`/api/memory${id ? `/${id}` : ""}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  expect((await settings("", "GET")).status).toBe(401);
  const startCalls = calls.length;
  const importedSource = await store.createSource(owner, {
    agentId: bot,
    toolRef: ref,
    title: "Local imported fixture",
  });
  await store.completeSync(owner, importedSource.id, [
    {
      externalId: "acceptance-39",
      digest: "fixture-v1",
      content: "Paper crane imported fixture",
      provenance: "Read-only records",
    },
  ]);
  const pending = await store.formMemory(owner, {
    agentId: bot,
    content: "Paper crane pending Bot fixture",
    sourceApp: "Memory connector",
    sourceRef: ref,
  });
  const unattributed = await store.formMemory(owner, {
    agentId: bot,
    content: "Unverified app provenance fixture",
    sourceApp: "Memory connector",
  });
  const content = "Private signed-in Memory fixture";
  const created = await settings(otherCookie, "POST", "", { content });
  expect(created.status).toBe(201);
  const second = await created.json();
  expect(await load(other)(otherBot)).toContain(content);
  expect(await load(owner)(bot)).not.toContain(content);
  expect(await load(owner)(bot)).not.toContain(
    "Unverified app provenance fixture",
  );
  expect(await load(owner)(bot)).toContain("Paper crane pending Bot fixture");
  expect(await load(owner)(bot)).toContain("Paper crane imported fixture");
  expect(await load(owner)(secondBot)).not.toContain("Paper crane");
  expect(await load(other)(otherBot)).not.toContain("Paper crane");
  expect(
    (await ingestion.recall(owner, bot, "PAPER CRANE"))
      .map((row) => row.formedBy)
      .sort(),
  ).toEqual(["bot", "import"]);
  expect(await (await settings(ownerCookie, "GET")).text()).toContain(
    pending.id,
  );
  expect(await (await settings(otherCookie, "GET")).text()).not.toContain(
    pending.id,
  );
  expect(
    (await settings(otherCookie, "PATCH", pending.id, { enabled: false }))
      .status,
  ).toBe(404);
  expect((await settings(otherCookie, "DELETE", pending.id)).status).toBe(404);
  const confirm = await (
    await settings(ownerCookie, "PATCH", pending.id, {
      reviewState: "confirmed",
    })
  ).json();
  expect(confirm.memory.reviewState).toBe("confirmed");
  const edit = await (
    await settings(ownerCookie, "PATCH", pending.id, {
      content: "Edited crane fixture",
    })
  ).json();
  expect(edit.memory.reviewState).toBe("edited");
  expect(await load(owner)(bot)).toContain("Edited crane fixture");
  expect(await load(owner)(bot)).not.toContain(
    "Paper crane pending Bot fixture",
  );
  expect(
    (await settings(ownerCookie, "PATCH", pending.id, { enabled: false }))
      .status,
  ).toBe(200);
  expect(await load(owner)(bot)).not.toContain("Edited crane fixture");
  expect(
    (await settings(ownerCookie, "PATCH", pending.id, { enabled: true }))
      .status,
  ).toBe(200);
  expect(await load(owner)(bot)).toContain("Edited crane fixture");
  expect((await settings(ownerCookie, "DELETE", pending.id)).status).toBe(204);
  expect(await load(owner)(bot)).not.toContain("Edited crane fixture");
  expect(await (await settings(ownerCookie, "GET")).text()).not.toContain(
    pending.id,
  );
  expect(
    (await settings(ownerCookie, "PATCH", pending.id, { enabled: true }))
      .status,
  ).toBe(404);
  expect((await settings(otherCookie, "DELETE", second.memory.id)).status).toBe(
    204,
  );
  expect(await load(other)(otherBot)).not.toContain(content);
  const { events } = await createAuditReader(database).list({
    limit: 20,
    targetType: "personal_memory",
    targetId: pending.id,
  });
  expect(events.map((event) => event.payload.change).sort()).toEqual([
    "memory_deleted",
    "memory_disabled",
    "memory_edited",
    "memory_enabled",
    "memory_reviewed",
  ]);
  expect(events.every((event) => event.actorUserId === owner)).toBe(true);
  expect(JSON.stringify(events)).not.toContain("crane fixture");
  expect(calls).toHaveLength(startCalls);
  await store.remove(owner, unattributed.id);
  await store.removeSource(owner, importedSource.id);
});
