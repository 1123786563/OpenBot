import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { inArray, eq } from "drizzle-orm";
import { createDatabase, type Database } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import { hindsightPauseControls } from "../src/db/schema/hindsight-pause";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { botBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
import { createDrizzlePauseControls } from "../src/hindsight/pause-controls";
import {
  createPersonalMemoryContext,
  renderPersonalMemoryContext,
} from "../src/hindsight/personal-memory-context";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Hindsight 18 (#395), the consumption side: what a Bot consumes of a person's memory comes from
 * the Hindsight chain behind one interface, over real authority tables and a scripted Hindsight
 * service.
 *
 * 1. Indexed recall answers through both halves — the general preferences and the source-bound
 *    memories — with the OpenBot authority text, and drops any hit whose row is not a live,
 *    confirmed record of this principal (a forgotten or unreviewed row answers nothing, however
 *    the service ranks it).
 * 2. The service stalling degrades, never empties: the SQL text-match answers confirmed rows and
 *    says `degraded` — the #385 rules the exit keeps — and there is no Intelligence path to fall
 *    back to.
 * 3. The query-less context block lists currently-effective confirmed memories of both halves
 *    under the same authorization gates, and the person's pause switch closes it before any row
 *    is read.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_ctx-${run}`;
const WORKSPACE = `ws_ctx-${run}`;
const PRINCIPAL = `prin_ctx-${run}`;
const ACTOR = `usr_ctx-${run}`;
const ASKING_BOT = `agt_ctxbot-${run}`;
const OTHER_BOT = `agt_ctxoth-${run}`;
const SOURCE_ON = `memsrc_ctx-on-${run}`;
const SECRET = `ctx-secret-${run}`;
const SERVICE_KEY = `ctx-service-key-${run}`;
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  stallMs: number;
};

let scripted: { server: Server; url: string; state: ScriptedState };
let context: ReturnType<typeof createPersonalMemoryContext>;
let preferences: ReturnType<typeof createPreferenceRecallService>;
let sourceBound: ReturnType<typeof createSourceBoundRecallService>;
let pause: ReturnType<typeof createDrizzlePauseControls>;
let scope: PlatformScope;
let recoveryOpen = true;

async function bootScriptedHindsight() {
  const state: ScriptedState = {
    recallByBank: new Map(),
    stallMs: 0,
  };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = request.url ?? "";
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      const answer = () => {
        let status = 404;
        let payload: unknown = { results: [] };
        if (request.method === "POST" && path.endsWith("/memories")) {
          status = 202;
          payload = { accepted: 1 };
        } else if (
          request.method === "POST" &&
          path.endsWith("/memories/recall")
        ) {
          const scriptedAnswer = state.recallByBank.get(bank);
          status = scriptedAnswer?.status ?? 404;
          payload = scriptedAnswer?.body ?? { results: [] };
        } else if (
          request.method === "DELETE" &&
          /\/documents\/[^/]+$/.test(path)
        ) {
          status = 204;
          payload = { deleted: true };
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (state.stallMs > 0) setTimeout(answer, state.stallMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("scripted hindsight did not bind a port");
  return { server, url: `http://127.0.0.1:${address.port}`, state };
}

function controlledDirectoryDatabase() {
  const membership = {
    principalId: PRINCIPAL,
    tenantStatus: "active",
    principalStatus: "active",
    memberStatus: "active",
    memberEpoch: 3,
  };
  // The resolver chains two joins per query; every step returns the same enriched promise, so
  // any chain shape reaches limit() and gets the rows this fixture means it to see.
  const rows = (table?: unknown) =>
    table === enterpriseWorkspaceMemberships
      ? [{ status: "active" }]
      : [membership];
  let result = rows();
  const query = Promise.resolve(rows());
  const chain = () => query;
  const controlled = Object.assign(query, {
    from(value: unknown) {
      result = rows(value);
      return this;
    },
    innerJoin: chain,
    where: chain,
    limit: () => Promise.resolve(result),
  });
  return {
    execute: async () => [
      {
        current_user_matches: true,
        capability_attributes_ok: true,
        login_attributes_ok: true,
        login_has_expected_capability: true,
        capability_has_no_escalation_membership: true,
        login_has_no_other_memberships: true,
        no_protected_ownership: true,
        login_has_no_enterprise_privileges: true,
      },
    ],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () => controlled,
      }),
  } as unknown as Database;
}

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: ACTOR, email: `ctx-${run}@example.invalid` }]);
  await database.insert(agents).values([
    {
      id: ASKING_BOT,
      name: `Asking ${run}`,
      type: "built_in",
      configuration: {},
    },
    {
      id: OTHER_BOT,
      name: `Other ${run}`,
      type: "built_in",
      configuration: {},
    },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Ctx ${run}` }]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE, name: `Ctx WS ${run}` }]);
  await database
    .insert(enterprisePrincipals)
    .values([{ id: PRINCIPAL, userId: ACTOR }]);
  await database
    .insert(enterpriseMemberships)
    .values([{ tenantId: TENANT, principalId: PRINCIPAL, role: "member" }]);
  await database
    .insert(enterpriseWorkspaceMemberships)
    .values([
      { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL },
    ]);
  // The asking Bot's and the enabled source's grants — what the authorization snapshot reads.
  await database.insert(hindsightMemoryGrants).values([
    {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      kind: "bot",
      targetId: ASKING_BOT,
      enabled: true,
    },
    {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      kind: "bot",
      targetId: OTHER_BOT,
      enabled: true,
    },
    {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      kind: "source",
      targetId: SOURCE_ON,
      enabled: true,
    },
  ]);

  scripted = await bootScriptedHindsight();
  const serviceConfig = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  pause = createDrizzlePauseControls(database);
  preferences = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    serviceConfig,
    { pause, recovery: { recallOpen: () => Promise.resolve(recoveryOpen) } },
  );
  sourceBound = createSourceBoundRecallService(
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    serviceConfig,
    { pause, recovery: { recallOpen: () => Promise.resolve(recoveryOpen) } },
  );
  context = createPersonalMemoryContext({
    recall: createDegradedRecallFacade(
      preferences,
      sourceBound,
      createDrizzleDegradedPreferenceSearch(database),
      createDrizzleDegradedSourceBoundSearch(database),
      createDrizzleSourceBoundAuthorizations(database),
    ),
    preferenceSearch: createDrizzleDegradedPreferenceSearch(database),
    sourceBoundSearch: createDrizzleDegradedSourceBoundSearch(database),
    authorizations: createDrizzleSourceBoundAuthorizations(database),
    pause,
    recovery: { recallOpen: () => Promise.resolve(recoveryOpen) },
  });

  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => WORKSPACE,
  });
  scope = await resolver.resolve(
    new Request("https://example.invalid/workwork"),
  );
});

afterEach(() => {
  scripted.state.stallMs = 0;
  scripted.state.recallByBank.clear();
});

afterAll(async () => {
  await scripted.server.close();
  await database
    .delete(sourceBoundMemories)
    .where(eq(sourceBoundMemories.tenantId, TENANT));
  await database
    .delete(genericPersonalPreferences)
    .where(eq(genericPersonalPreferences.tenantId, TENANT));
  await database
    .delete(hindsightMemoryGrants)
    .where(eq(hindsightMemoryGrants.tenantId, TENANT));
  await database
    .delete(hindsightPauseControls)
    .where(eq(hindsightPauseControls.tenantId, TENANT));
  await database
    .delete(enterpriseWorkspaceMemberships)
    .where(eq(enterpriseWorkspaceMemberships.principalId, PRINCIPAL));
  await database
    .delete(enterpriseMemberships)
    .where(eq(enterpriseMemberships.principalId, PRINCIPAL));
  await database
    .delete(enterprisePrincipals)
    .where(eq(enterprisePrincipals.id, PRINCIPAL));
  await database
    .delete(enterpriseWorkspaces)
    .where(eq(enterpriseWorkspaces.id, WORKSPACE));
  await database
    .delete(enterpriseTenants)
    .where(eq(enterpriseTenants.id, TENANT));
  await database
    .delete(agents)
    .where(inArray(agents.id, [ASKING_BOT, OTHER_BOT]));
  await database.delete(users).where(eq(users.id, ACTOR));
  await database.$client.end();
});

describe("Hindsight 18 (#395) — Bot consumption over the single authority", () => {
  test("indexed recall answers through both halves with the authority text, and drops dead rows", async () => {
    const pref = await preferences.confirmGenericPreference(scope, {
      content: `ctx-pref-tea-${run}`,
    });
    const botFact = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `ctx-bot-deploy-${run}`,
      restriction: { kind: "bot", agentId: ASKING_BOT },
    });

    // Rank the live row AND a document id that has no live authority row behind it: only the
    // rows a Bot may consume answer, whatever the index claims, and only the authority text.
    scripted.state.recallByBank.set(userBankFor(PRINCIPAL), {
      status: 200,
      body: {
        results: [
          { document_id: "hgp_ghost", content: "ghost" },
          {
            document_id: preferenceDocumentIdFor(TENANT, pref.record.id),
            content: "remote-garbage",
          },
        ],
      },
    });
    scripted.state.recallByBank.set(botBankFor(ASKING_BOT), {
      status: 200,
      body: {
        results: [
          {
            document_id: sourceBoundDocumentIdFor(TENANT, botFact.record.id),
          },
        ],
      },
    });

    const answer = await context.recallPersonalMemories(scope, {
      query: `ctx ${run}`,
      botId: ASKING_BOT,
    });
    expect(answer.degraded).toBe(false);
    expect(answer.memories.map((memory) => memory.kind)).toEqual([
      "general-preference",
      "source-bound",
    ]);
    // The confirmed original from the OpenBot authority rows, never the remote text.
    expect(answer.memories.map((memory) => memory.content)).toEqual([
      `ctx-pref-tea-${run}`,
      `ctx-bot-deploy-${run}`,
    ]);

    // A forgotten row answers nothing even when the service still ranks it.
    await preferences.forgetGenericPreference(scope, pref.record.id);
    scripted.state.recallByBank.set(userBankFor(PRINCIPAL), {
      status: 200,
      body: {
        results: [
          { document_id: preferenceDocumentIdFor(TENANT, pref.record.id) },
        ],
      },
    });
    const afterForget = await context.recallPersonalMemories(scope, {
      query: `ctx ${run}`,
      botId: ASKING_BOT,
    });
    expect(
      afterForget.memories.filter(
        (memory) => memory.kind === "general-preference",
      ),
    ).toEqual([]);
  });

  test("a stalled service degrades to the SQL text-match and says so", async () => {
    const pref = await preferences.confirmGenericPreference(scope, {
      content: `ctx-degraded-fact-${run}`,
    });
    scripted.state.stallMs = STALL_MS;

    const answer = await context.recallPersonalMemories(scope, {
      query: `degraded fact ${run}`,
      botId: ASKING_BOT,
    });
    expect(answer.degraded).toBe(true);
    expect(answer.memories.map((memory) => memory.content)).toEqual([
      `ctx-degraded-fact-${run}`,
    ]);
    // The same confirmed row the indexed path serves — there is no other authority to consult.
    expect(pref.record.id).toBeTruthy();
  });

  test("the context block lists currently-effective confirmed memories under the live gates", async () => {
    const live = await preferences.confirmGenericPreference(scope, {
      content: `ctx-live-pref-${run}`,
    });
    await sourceBound.confirmSourceBoundMemory(scope, {
      content: `ctx-team-fact-${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE },
    });
    const ownBotFact = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `ctx-own-bot-fact-${run}`,
      restriction: { kind: "bot", agentId: ASKING_BOT },
    });
    const otherBotFact = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `ctx-other-bot-fact-${run}`,
      restriction: { kind: "bot", agentId: OTHER_BOT },
    });

    const block = await context.personalMemoryContext(scope, ASKING_BOT);
    const contents = block.memories.map((memory) => memory.content);
    expect(contents).toContain(`ctx-live-pref-${run}`);
    expect(contents).toContain(`ctx-team-fact-${run}`);
    expect(contents).toContain(`ctx-own-bot-fact-${run}`);
    // Another Bot's bank is not this Bot's to read, even query-less.
    expect(contents).not.toContain(`ctx-other-bot-fact-${run}`);
    expect(ownBotFact.record.id).not.toBe(otherBotFact.record.id);

    // The Bot's grant revoked: its bank closes on the next context read.
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(inArray(hindsightMemoryGrants.targetId, [ASKING_BOT]));
    const revoked = await context.personalMemoryContext(scope, ASKING_BOT);
    expect(revoked.memories.map((memory) => memory.content)).not.toContain(
      `ctx-own-bot-fact-${run}`,
    );
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true })
      .where(inArray(hindsightMemoryGrants.targetId, [ASKING_BOT]));

    // Pause-usage closes the whole block before any row is read.
    await pause.setUsagePaused(TENANT, PRINCIPAL, true);
    expect(await context.personalMemoryContext(scope, ASKING_BOT)).toEqual({
      memories: [],
    });
    expect(
      await context.recallPersonalMemories(scope, {
        query: `ctx ${run}`,
        botId: ASKING_BOT,
      }),
    ).toEqual({ memories: [], degraded: false });
    await pause.setUsagePaused(TENANT, PRINCIPAL, false);

    // An unreplayed backup restore (#391) keeps every answer closed the same way.
    recoveryOpen = false;
    expect(await context.personalMemoryContext(scope, ASKING_BOT)).toEqual({
      memories: [],
    });
    recoveryOpen = true;
    const unpaused = await context.personalMemoryContext(scope, ASKING_BOT);
    expect(unpaused.memories.map((memory) => memory.content)).toContain(
      `ctx-live-pref-${run}`,
    );
    expect(live.record.id).toBeTruthy();
  });

  test("the rendered block quotes memories as untrusted attributed data", () => {
    const rendered = renderPersonalMemoryContext([
      {
        kind: "general-preference",
        id: "pref-1",
        content: "Prefers bullet points",
        provenance: "You",
        markedGenericAt: new Date(0),
        effectiveFrom: new Date(0),
        effectiveUntil: null,
        timeUncertain: false,
      },
    ]);
    expect(rendered).toContain("untrusted data");
    expect(rendered).toContain("Prefers bullet points");
    expect(renderPersonalMemoryContext([])).toBe("");
  });
});
