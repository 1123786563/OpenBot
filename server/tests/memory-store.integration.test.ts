import { afterAll, beforeAll, expect, test } from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import { lastValueFrom, of, toArray } from "rxjs";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import { mcpServers, mcpTools } from "../src/db/schema/plugins";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryStore } from "../src/memory/store";
import { memoryTools, PersonalMemoryMiddleware } from "../src/memory/tools";
import { MemoryNotFoundError, MemoryRefusedError } from "../src/memory/types";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `memory-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const server = `${prefix}-connector`;
const ref = `${server}/read_documents`;
let vendorText =
  '[{"id":"doc1","text":"Project launch is Tuesday","title":"Roadmap"}]';
let vendorError = false;
const calls: { actorId?: string; botId?: string }[] = [];
const plugins = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  callVendor: async (connection) => {
    calls.push(connection);
    return { text: vendorText, isError: vendorError };
  },
});
const store = createMemoryStore(database);
const ingestion = createMemoryIngestion({ store, plugins });
beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values([
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
      effect: "read",
      inputSchema: {},
    },
    {
      serverId: server,
      name: "write_document",
      effect: "write",
      inputSchema: {},
    },
  ]);
  await plugins.grant("mcp", ref, bot, owner);
  await plugins.grant("mcp", `${server}/write_document`, bot, owner);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
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
/** A source whose imported record the person has confirmed, so recall-gated tests still see it. */
async function confirmedSource() {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.update(owner, fact.id, { reviewState: "confirmed" });
  return { value, fact };
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
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  await store.update(owner, fact.id, { reviewState: "confirmed" });
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
  const { value } = await confirmedSource();
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
  const { value } = await confirmedSource();
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
  const { value } = await confirmedSource();
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
  const { value } = await confirmedSource();
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
    reviewState: "confirmed",
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

test("an unreviewed candidate is invisible to every Bot-side recall path until confirmed", async () => {
  const candidate = `Unreviewed candidate ${randomUUID()}`;
  const formed = await store.formMemory(owner, {
    agentId: bot,
    content: candidate,
    sourceApp: "Docs",
    sourceRef: ref,
  });
  const confirmed = await store.create(owner, {
    content: `Confirmed alongside ${randomUUID()}`,
  });
  // The person's candidate list keeps both; review is what separates them.
  const listed = await store.list(owner);
  expect(listed.find((row) => row.id === formed.id)?.reviewState).toBe(
    "unreviewed",
  );
  expect(listed.some((row) => row.id === confirmed.id)).toBe(true);
  // Every Bot-side path (the one store seam under recall and context) hides the candidate.
  const personPath = await store.retrieve(owner, [], "");
  expect(personPath.some((row) => row.id === formed.id)).toBe(false);
  expect(personPath.some((row) => row.id === confirmed.id)).toBe(true);
  const formedPath = await store.retrieve(owner, [], "", {
    botId: bot,
    heldServerIds: new Set([server]),
  });
  expect(formedPath.some((row) => row.id === formed.id)).toBe(false);
  const recalled = await ingestion.recall(owner, bot);
  expect(recalled.some((row) => row.id === formed.id)).toBe(false);
  expect(recalled.some((row) => row.id === confirmed.id)).toBe(true);
  expect(await ingestion.contextFor(owner, bot)).not.toContain(candidate);
  // Confirmation moves it onto every path at once; rejection removes it again.
  await store.update(owner, formed.id, { reviewState: "confirmed" });
  expect(
    (await ingestion.recall(owner, bot)).some((row) => row.id === formed.id),
  ).toBe(true);
  expect(await ingestion.contextFor(owner, bot)).toContain(candidate);
  await store.remove(owner, formed.id);
  expect(
    (await ingestion.recall(owner, bot)).some((row) => row.id === formed.id),
  ).toBe(false);
});

test("an imported fact waits for the person's confirmation before any Bot recalls it", async () => {
  const value = await source();
  const fact = (await store.list(owner)).find(
    (row) => row.sourceId === value.id,
  );
  if (!fact) throw new Error("Expected imported memory.");
  expect(fact.reviewState).toBe("unreviewed");
  expect(
    (await ingestion.recall(owner, bot)).some((row) => row.id === fact.id),
  ).toBe(false);
  expect(await ingestion.contextFor(owner, bot)).not.toContain(
    "Project launch is Tuesday",
  );
  await store.update(owner, fact.id, { reviewState: "confirmed" });
  expect(
    (await ingestion.recall(owner, bot)).some((row) => row.id === fact.id),
  ).toBe(true);
  expect(await ingestion.contextFor(owner, bot)).toContain(
    "Project launch is Tuesday",
  );
});

class RecordingAgent extends AbstractAgent {
  readonly requests: RunAgentInput[] = [];
  run(input: RunAgentInput) {
    this.requests.push(input);
    return of<BaseEvent>(
      {
        type: EventType.RUN_STARTED,
        runId: input.runId,
        threadId: input.threadId,
      },
      {
        type: EventType.RUN_FINISHED,
        runId: input.runId,
        threadId: input.threadId,
      },
    );
  }
}

test("the Bot's injected memory context and recall tool carry no unreviewed candidate", async () => {
  const candidate = `Middleware candidate ${randomUUID()}`;
  const formed = await store.formMemory(owner, {
    agentId: bot,
    content: candidate,
    sourceApp: "Docs",
    sourceRef: ref,
  });
  const confirmed = await store.create(owner, {
    content: `Middleware confirmed ${randomUUID()}`,
  });
  // The middleware the server wires to contextFor injects only reviewed memories.
  const agent = new RecordingAgent({ agentId: bot });
  await lastValueFrom(
    new PersonalMemoryMiddleware(bot, (id) => ingestion.contextFor(owner, id))
      .run(
        {
          runId: "run",
          threadId: "thread",
          messages: [
            { id: "user", role: "user", content: "What should I know?" },
          ],
          context: [],
          tools: [],
          state: { progress: 1 },
          forwardedProps: {},
        },
        agent,
      )
      .pipe(toArray()),
  );
  const injected =
    agent.requests[0]?.messages.find(
      (message) => message.id === "openbot:personal-memory",
    )?.content ?? "";
  expect(injected).toContain("Middleware confirmed");
  expect(injected).not.toContain(candidate);
  // And so does the recall tool a Bot holds.
  const tool = memoryTools({
    store,
    ingestion,
    ownerUserId: owner,
    agentId: bot,
  }).find((entry) => entry.name === "recall_personal_memory");
  if (!tool) throw new Error("Expected the recall tool.");
  const result = JSON.parse(String(await tool.execute({}))) as {
    id: string;
  }[];
  expect(result.some((row) => row.id === formed.id)).toBe(false);
  expect(result.some((row) => row.id === confirmed.id)).toBe(true);
});

test("'remember' confirms exactly the person's explicit statement, word for word", async () => {
  const statement = `I prefer morning meetings on ${randomUUID()}`;
  const before = await store.list(owner);
  const memory = await store.create(owner, { content: statement });
  const after = await store.list(owner);
  expect(memory.content).toBe(statement);
  expect(memory.reviewState).toBe("confirmed");
  // One explicit statement becomes exactly one confirmed memory, never more facts.
  expect(after.length).toBe(before.length + 1);
  expect(after.filter((row) => row.content === statement)).toHaveLength(1);
});
