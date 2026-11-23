import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
import { createManagedModel } from "../src/managed-model";
import { createHindsight } from "../src/memory/hindsight";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createReflectModelGateway } from "../src/memory/reflect-model";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryRuntime } from "../src/memory/runtime";
import { createMemoryStore } from "../src/memory/store";
import { memoryTools } from "../src/memory/tools";
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

test("Hindsight Recall ranks approved current memories and falls back after withdrawal", async () => {
  const requests: unknown[] = [];
  let hit: { document_id: string; metadata: unknown; type: string } | undefined;
  let recallBody: unknown;
  let beforeRecallResponse: (() => Promise<unknown>) | undefined;
  let available = true;
  let clock = Date.now();
  const deleted: string[] = [];
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (!available) return new Response(null, { status: 503 });
      if (request.method === "DELETE") {
        deleted.push(new URL(request.url).pathname.split("/").at(-1) ?? "");
        return Response.json({ success: true });
      }
      const body = await request.json();
      if (request.url.endsWith("/recall")) {
        recallBody = body;
        await beforeRecallResponse?.();
        return Response.json({ results: hit ? [hit] : [] });
      }
      requests.push(...body.items);
      return Response.json({ success: true });
    },
  });
  try {
    const hindsight = createHindsight({
      database,
      url: fixture.url,
      recallTimeoutMs: 100,
      now: () => clock,
    });
    const memory = createMemoryIngestion({
      store,
      plugins,
      hindsight: { client: hindsight, canUseMemory: async () => true },
    });
    const content = "The synthetic observatory uses amber lanterns.";
    const term = "lighting gear";
    const local = await store.create(owner, { content: `Local ${term}` });
    const formed = await store.formMemory(owner, {
      agentId: bot,
      sourceRef: ref,
      sourceApp: "Fixture",
      content,
    });
    await memory.syncHindsight();
    expect(requests).not.toContainEqual(expect.objectContaining({ content }));
    await store.update(owner, formed.id, { reviewState: "confirmed" });
    await memory.syncHindsight();
    const projection = requests.find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "content" in item &&
        item.content === content,
    );
    expect(projection).toEqual({
      content,
      document_id: formed.id,
      metadata: { openbot_version: expect.any(String) },
      tags: [expect.any(String)],
    });
    if (
      !projection ||
      typeof projection !== "object" ||
      !("metadata" in projection)
    ) {
      throw new Error("Missing projected version metadata");
    }
    hit = {
      document_id: formed.id,
      metadata: projection.metadata,
      type: "world",
    };
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([formed.id, local.id]);
    expect(recallBody).toMatchObject({
      tags_match: "any_strict",
      types: ["world", "experience"],
    });
    expect(await memory.recall(other, bot, term)).toEqual([]);
    const originalHit = hit;
    hit = { ...originalHit, metadata: null };
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    hit = originalHit;
    beforeRecallResponse = () => Bun.sleep(300);
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    beforeRecallResponse = () =>
      store.update(owner, formed.id, {
        content: "The synthetic observatory uses blue lanterns.",
      });
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    beforeRecallResponse = undefined;
    await memory.syncHindsight();
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    await store.update(owner, formed.id, { enabled: false });
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    available = false;
    await expect(memory.syncHindsight()).rejects.toThrow(
      "Hindsight projection reconciliation failed",
    );
    expect(deleted).not.toContain(formed.id);
    available = true;
    // A later sweep retries retirement even after the local record is withdrawn.
    await store.remove(owner, formed.id);
    recallBody = undefined;
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    expect(recallBody).toBeUndefined();

    clock += 60_000;
    await memory.syncHindsight();
    expect(deleted).toContain(formed.id);
    clock += 600_000;
    await memory.syncHindsight();
    expect(deleted.filter((id) => id === formed.id)).toHaveLength(2);
    expect(
      (await memory.recall(owner, bot, term)).map((row) => row.id),
    ).toEqual([local.id]);
    expect(recallBody).toBeDefined();
  } finally {
    fixture.stop(true);
  }
});

const hindsightTestUrl = process.env.TEST_HINDSIGHT_API_URL;
test.skipIf(!hindsightTestUrl)(
  "self-hosted Hindsight indexes only the current approved Personal Memory",
  async () => {
    if (!hindsightTestUrl)
      throw new Error("TEST_HINDSIGHT_API_URL is required");
    const url = new URL(hindsightTestUrl);
    let clock = Date.now();
    const client = createHindsight({
      database,
      url,
      recallTimeoutMs: 5000,
      now: () => clock,
    });
    const memory = createMemoryIngestion({
      store,
      plugins,
      hindsight: { client, canUseMemory: async () => true },
    });
    const approved = await store.formMemory(owner, {
      agentId: bot,
      sourceApp: "Synthetic catalog",
      sourceRef: ref,
      content: "Mars observatory's telescope uses amber lanterns.",
    });
    const digest = createHash("sha256").update(owner).digest("hex");
    const bankUrl = new URL(`/v1/default/banks/openbot-memory-${digest}/`, url);
    const document = new URL(`documents/${approved.id}`, bankUrl);
    const source = await store.createSource(owner, {
      agentId: bot,
      toolRef: ref,
      title: "Synthetic import",
    });
    const importedContent = "A synthetic library catalog uses a ruby sticker.";
    await store.completeSync(owner, source.id, [
      {
        externalId: "catalog",
        digest: "v1",
        content: importedContent,
        provenance: "Sample",
      },
    ]);
    const imported = (await store.list(owner)).find(
      (row) => row.sourceId === source.id,
    );
    if (!imported) throw new Error("Missing synthetic import");
    const importedDocument = new URL(`documents/${imported.id}`, bankUrl);
    await memory.syncHindsight();
    expect((await fetch(document)).status).toBe(404);
    expect((await fetch(importedDocument)).status).toBe(404);
    const reviewed = await store.update(owner, approved.id, {
      reviewState: "confirmed",
    });
    await store.update(owner, imported.id, { reviewState: "confirmed" });
    await memory.syncHindsight();
    const response = await fetch(document);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: approved.id,
      original_text: reviewed.content,
      tags: [
        expect.stringMatching(
          new RegExp(`^openbot:${approved.id}:[0-9a-f-]{36}$`),
        ),
      ],
    });
    expect((await fetch(importedDocument)).status).toBe(200);
    // A term that the local substring path cannot find proves Hindsight supplied the ranking.
    const search = "Mars telescope with lanterns";
    const recall = memoryTools({
      store,
      ingestion: memory,
      ownerUserId: owner,
      agentId: bot,
    }).find((tool) => tool.name === "recall_personal_memory");
    if (!recall) throw new Error("Missing Recall tool");
    expect(await ingestion.recall(owner, bot, search)).toEqual([]);
    expect(await recall.execute({ search })).toContain(approved.id);
    // The bytes can stay the same even though the review revision changes.
    await store.update(owner, approved.id, { content: reviewed.content });
    expect(await recall.execute({ search })).not.toContain(approved.id);
    await memory.syncHindsight();
    expect(await recall.execute({ search })).toContain(approved.id);
    expect(await memory.recall(owner, secondBot, search)).toEqual([]);
    await store.create(other, {
      content: "A synthetic Earth observatory uses flashlights.",
    });
    await memory.syncHindsight();
    expect(
      (await memory.recall(other, otherBot, search)).map((row) => row.id),
    ).not.toContain(approved.id);

    await store.completeSync(owner, source.id, [
      {
        externalId: "catalog",
        digest: "v2",
        content: "A synthetic library catalog uses a blue sticker.",
        provenance: "New sample",
      },
    ]);
    expect(
      (await store.list(owner)).find((row) => row.id === imported.id)
        ?.reviewState,
    ).toBe("unreviewed");
    await memory.syncHindsight();
    expect((await fetch(importedDocument)).status).toBe(404);
    await store.remove(owner, approved.id);
    expect(await memory.recall(owner, bot, search)).toEqual([]);
    await memory.syncHindsight();
    expect((await fetch(document)).status).toBe(404);
    clock += 600_000;
    await memory.syncHindsight();
    expect((await fetch(document)).status).toBe(404);
  },
  30_000,
);

test("Reflect tool returns synthesis only while all Hindsight sources are current and accessible", async () => {
  let retained: { document_id: string; metadata: unknown } | undefined;
  let reflectBody: unknown;
  let beforeAnswer: (() => Promise<unknown>) | undefined;
  let foreignId: string | undefined;
  let foreignEvidence = false;
  let wrongContent = false;
  let available = true;
  const answer = "Use the amber lanterns for the synthetic observatory.";
  const fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") return Response.json({ success: true });
      const body = await request.json();
      if (request.url.endsWith("/reflect")) {
        if (!available) return new Response(null, { status: 503 });
        reflectBody = body;
        await beforeAnswer?.();
        const memory = {
          ...retained,
          type: "world",
          text: wrongContent
            ? "Unrelated private text under an allowed identifier."
            : "Synthetic observatory has amber lanterns.",
        };
        return Response.json({
          text: answer,
          based_on: {
            memories: foreignEvidence
              ? [memory, { ...memory, document_id: foreignId }]
              : [memory],
            mental_models: [],
            directives: [],
          },
        });
      }
      retained =
        body.items.find(
          (item: { content: string }) =>
            item.content === "Synthetic observatory has amber lanterns.",
        ) ?? retained;
      return Response.json({ success: true });
    },
  });
  try {
    const memory = createMemoryIngestion({
      store,
      plugins,
      hindsight: {
        client: createHindsight({ database, url: fixture.url, reflect: true }),
        canUseMemory: async () => true,
      },
    });
    foreignId = (
      await store.create(other, {
        content: "Other workspace observatory memory.",
      })
    ).id;
    const local = await store.create(owner, {
      content: "Local observatory lighting note",
    });
    const source = await store.formMemory(owner, {
      agentId: bot,
      sourceRef: ref,
      sourceApp: "Fixture",
      content: "Synthetic observatory has amber lanterns.",
    });
    await store.update(owner, source.id, { reviewState: "confirmed" });
    await memory.syncHindsight();
    const reflect = (actor: string) =>
      memoryTools({
        store,
        ingestion: memory,
        ownerUserId: actor,
        agentId: bot,
      }).find((tool) => tool.name === "reflect_personal_memory");
    const query = "observatory lighting";
    expect(
      JSON.parse((await reflect(owner)?.execute({ query })) ?? "null"),
    ).toMatchObject({
      kind: "reflection",
      text: answer,
      sources: [{ id: source.id, version: expect.any(String) }],
    });
    expect(reflectBody).toMatchObject({
      fact_types: ["world", "experience"],
      tags_match: "any_strict",
      exclude_mental_models: true,
      include: { facts: {} },
    });
    foreignEvidence = true;
    expect(
      JSON.parse((await reflect(owner)?.execute({ query })) ?? "null"),
    ).toMatchObject({ kind: "local", memories: [{ id: local.id }] });
    foreignEvidence = false;
    const expectLocal = async () =>
      expect(
        JSON.parse((await reflect(owner)?.execute({ query })) ?? "null"),
      ).toMatchObject({ kind: "local", memories: [{ id: local.id }] });
    wrongContent = true;
    await expectLocal();
    wrongContent = false;
    available = false;
    await expectLocal();
    available = true;
    beforeAnswer = () => plugins.revoke("mcp", ref, bot, owner);
    await expectLocal();
    await plugins.grant("mcp", ref, bot, owner);
    beforeAnswer = () =>
      store.update(owner, source.id, {
        content: "Synthetic observatory now uses blue lanterns.",
      });
    await expectLocal();
    beforeAnswer = undefined;
    await memory.syncHindsight();
    await expectLocal();
    await store.update(owner, source.id, { enabled: false });
    await expectLocal();
    reflectBody = undefined;
    expect(
      JSON.parse((await reflect(other)?.execute({ query })) ?? "null"),
    ).toEqual({ kind: "local", memories: [] });
    expect(reflectBody).toBeUndefined();
  } finally {
    fixture.stop(true);
    await plugins.grant("mcp", ref, bot, owner);
  }
});

const nativeReflectUrl = process.env.TEST_HINDSIGHT_REFLECT_API_URL;
test.skipIf(!nativeReflectUrl)(
  "self-hosted Hindsight Reflect returns a current OpenBot Memory version",
  async () => {
    if (!nativeReflectUrl)
      throw new Error("TEST_HINDSIGHT_REFLECT_API_URL is required");
    const memory = createMemoryIngestion({
      store,
      plugins,
      hindsight: {
        client: createHindsight({
          database,
          url: new URL(nativeReflectUrl),
          reflect: true,
        }),
        canUseMemory: async () => true,
      },
    });
    const source = await store.create(owner, {
      content: "Synthetic observatory has amber lanterns.",
    });
    await memory.syncHindsight();
    const reflect = memoryTools({
      store,
      ingestion: memory,
      ownerUserId: owner,
      agentId: bot,
    }).find((tool) => tool.name === "reflect_personal_memory");
    if (!reflect) throw new Error("Missing Reflect tool");
    const args = {
      query: "Which lanterns are available at the synthetic observatory?",
    };
    expect(JSON.parse(await reflect.execute(args))).toMatchObject({
      kind: "reflection",
      text: expect.stringContaining("amber lanterns"),
      sources: expect.arrayContaining([
        { id: source.id, version: expect.any(String) },
      ]),
    });
    await store.remove(owner, source.id);
    expect(await reflect.execute(args)).not.toContain(source.id);
    await memory.syncHindsight();
  },
  30_000,
);

const managedReflectUrl = process.env.TEST_HINDSIGHT_MANAGED_REFLECT_API_URL;
const managedReflectPort = Number(
  process.env.TEST_HINDSIGHT_MANAGED_REFLECT_CALLBACK_PORT,
);
const syntheticModelUrl = process.env.TEST_HINDSIGHT_SYNTHETIC_MODEL_URL;

test.skipIf(!managedReflectUrl || !managedReflectPort || !syntheticModelUrl)(
  "self-hosted Hindsight Reflect admits every model callback through the managed model contract",
  async () => {
    if (!managedReflectUrl || !syntheticModelUrl)
      throw new Error("Missing managed Reflect fixture URL");
    const priceVersion = "a6000000-0000-4000-8000-000000000001";
    const operations = new Map<string, "reserved" | "dispatched" | "settled">();
    const scope = {
      personId: owner,
      botId: bot,
      conversationId: randomUUID(),
      runId: randomUUID(),
    };
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/quote")
          return Response.json({ route: "fixture-approved-v1", priceVersion });
        const body = await request.json();
        if (path === "/v1/reserve") {
          expect(body).toEqual({
            operationId: expect.any(String),
            applicationId: "openbot",
            creditType: "test",
            route: "fixture-approved-v1",
            priceVersion,
            resumable: false,
          });
          expect(operations.has(body.operationId)).toBe(false);
          operations.set(body.operationId, "reserved");
          return Response.json({ state: "reserved", permit: body.operationId });
        }
        if (path === "/v1/dispatch") {
          expect(operations.get(body.operationId)).toBe("reserved");
          expect(body.permit).toBe(body.operationId);
          const [schemaMessage, ...messages] = body.messages;
          const schema = JSON.parse(schemaMessage.content.split("\n")[1]);
          const provider = await fetch(syntheticModelUrl, {
            method: "POST",
            body: JSON.stringify({
              messages,
              response_format: { type: "json_schema", json_schema: { schema } },
            }),
          });
          expect(provider.ok).toBe(true);
          operations.set(body.operationId, "dispatched");
          const completion = await provider.json();
          return Response.json({
            state: "completed",
            text: completion.choices[0].message.content,
          });
        }
        expect(path).toBe("/v1/reconcile");
        expect(operations.get(body.operationId)).toBe("dispatched");
        operations.set(body.operationId, "settled");
        return Response.json({ state: "settled" });
      },
    });
    const gateway = createReflectModelGateway({
      model: createManagedModel({
        url: control.url,
        credentials: new Map([[owner, "ledger-fixture"]]),
      }),
      route: "fixture-approved-v1",
      token: "hindsight-fixture",
    });
    const callback = Bun.serve({
      hostname: "0.0.0.0",
      port: managedReflectPort,
      fetch: (request) => gateway.complete(request),
    });
    try {
      const memory = createMemoryIngestion({
        store,
        plugins,
        hindsight: {
          client: createHindsight({
            database,
            url: new URL(managedReflectUrl),
            reflect: true,
          }),
          exposeNativeReflect: false,
          canUseMemory: async () => true,
        },
      });
      const source = await store.create(owner, {
        content: "Synthetic observatory has amber lanterns.",
      });
      await memory.syncHindsight();
      const query =
        "Which lanterns are available at the synthetic observatory?";
      expect(
        await memory.reflect(owner, bot, query, (request, canDispatch) =>
          gateway.reflect({ scope, query, request, canDispatch }),
        ),
      ).toMatchObject({
        kind: "reflection",
        text: expect.stringContaining("amber lanterns"),
        sources: [{ id: source.id, version: expect.any(String) }],
      });
      expect(operations.size).toBeGreaterThan(1);
      expect(new Set(operations.values())).toEqual(new Set(["settled"]));
      await store.remove(owner, source.id);
      await memory.syncHindsight();
    } finally {
      callback.stop(true);
      control.stop(true);
    }
  },
  30_000,
);
