import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
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
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 08 (#385), integration layer: the safe-degradation recall over the real authority
 * tables, the real tenancy tables, and three outage shapes — a service that answers (up), a
 * service that never answers (hang → timeout), and no service at all (dead port → refused).
 *
 * One describe per acceptance clause:
 *
 * 1. SQL degradation returns only confirmed, not-paused, currently-authorized rows: candidates
 *    and revoked sources are invisible, the asking workspace's boundary holds, the same
 *    global user's other company never answers, and a semantic near-miss honestly answers
 *    nothing rather than guessing.
 * 2. An outage never fakes indexing: a confirmation during the outage stays pending (never
 *    "indexed"), and the recovery is the #384 queue draining once the service answers again.
 * 3. Every entrance degrades identically: web, desktop (the channel surface) and schedule
 *    mint the same trusted-scope vocabulary, and the degraded answer plus the revocation
 *    filtering are byte-identical across them.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_acme-${run}`;
const TENANT_OTHER = `tn_other-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const WORKSPACE_UNJOINED = `ws_team-c-${run}`;
const PRINCIPAL_EMP = `prin_employee-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_connected-1-${run}`;
const BOT_ONE = `agt_bot-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
/** A port nothing listens on: connection refused, immediately. */
const DEAD_URL = "http://127.0.0.1:9";

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  bank: string;
  authorization: string | undefined;
  scope: string | undefined;
};

/** The scripted service's mutable answers; the request handler reads this object live. */
type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  userBankRecall: { status: number; body: unknown } | null;
  retainStatus: number;
};

function bootAnsweringHindsight(): Promise<{
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
}> {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    userBankRecall: null,
    retainStatus: 202,
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const path = request.url ?? "";
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      calls.push({
        method: request.method ?? "",
        path,
        body,
        bank,
        authorization: request.headers.authorization,
        scope: request.headers["x-openbot-bank-scope"],
      });
      let status = 404;
      let payload: unknown = { error: "scripted: no route" };
      if (request.method !== "POST") {
        status = 202;
        payload = { accepted: 1 };
      } else if (path.endsWith("/memories")) {
        status = state.retainStatus;
        payload = { accepted: 1 };
      } else if (path.endsWith("/memories/recall")) {
        const scoped = state.recallByBank.get(bank);
        if (scoped) {
          status = scoped.status;
          payload = scoped.body;
        } else if (state.userBankRecall && bank.startsWith("ob_u_")) {
          status = state.userBankRecall.status;
          payload = state.userBankRecall.body;
        } else {
          status = 200;
          payload = { results: [] };
        }
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("scripted hindsight did not bind a port");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        calls,
        state,
      });
    });
  });
}

/** The outage shape the timeout clause names: accepts the request, never answers it. */
function bootHangingHindsight(): Promise<{ server: Server; url: string }> {
  const server = createServer(() => {
    // Deliberately no response: the caller's AbortSignal.timeout is the only way out.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("hanging hindsight did not bind a port");
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

// The controlled-directory technique from hindsight-source-bound-recall.integration.test.ts:
// a drizzle-shaped database good enough for verifyDirectoryDatabase's capability probe and
// the membership selects inside resolve(), so minted scopes carry the real issuedScopes
// marker. The member row answers with the principal of the company being asked about, so the
// same global user resolves to a different principal per tenant, exactly as production does.
function controlledQuery(
  rows: (table?: unknown) => readonly Record<string, unknown>[],
) {
  let result = rows();
  const query = Promise.resolve(rows());
  const chain = () => query;
  return Object.assign(query, {
    from(value: unknown) {
      result = rows(value);
      return this;
    },
    innerJoin: chain,
    where: chain,
    limit() {
      return Promise.resolve(result);
    },
  });
}

function controlledDirectoryDatabase(principalId: string): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  return {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () =>
          controlledQuery((table) =>
            table === enterpriseWorkspaceMemberships
              ? [{ status: "active" }]
              : [
                  {
                    principalId,
                    tenantStatus: "active",
                    principalStatus: "active",
                    memberStatus: "active",
                    memberEpoch: 3,
                  },
                ],
          ),
      }),
  } as unknown as Database;
}

/**
 * A production-minted trusted scope for one (tenant, workspace) under one entrance. The
 * controlled directory answers every membership question affirmatively, so the entrypoint is
 * the only variable the caller chooses.
 */
async function makeTrustedScope(
  tenantId: string,
  workspaceId: string,
  entrypoint: "web" | "desktop" | "schedule" = "web",
  principalId: string = PRINCIPAL_EMP,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint }),
    selectTenant: () => tenantId,
    selectWorkspace: () => workspaceId,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

type ServiceSet = {
  facade: ReturnType<typeof createDegradedRecallFacade>;
  preferences: ReturnType<typeof createPreferenceRecallService>;
  sourceBound: ReturnType<typeof createSourceBoundRecallService>;
  queue: ReturnType<typeof createHindsightSyncQueue>;
};

/**
 * The file's controllable clock: temporal acceptance needs a confirm BEFORE a correction
 * before "now", which real time cannot order fast enough. Every service and facade shares
 * it, so a correction's window and the fallback's current/historical reads agree.
 */
let simulatedNow = new Date("2026-10-01T08:00:00.000Z");
const clock = () => simulatedNow;

function serviceSet(
  apiUrl: string,
  requestTimeoutMs: number,
  withWork = false,
): ServiceSet {
  const config = {
    apiUrl,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs,
  };
  const queue = createHindsightSyncQueue(database, config, {
    authorizations: createDrizzleSourceBoundAuthorizations(database),
    now: clock,
  });
  // The work recorder stays OFF by default: every other test's confirmations would leave
  // pending rows in the shared sync-work table and pollute later suites' drain counts. Only
  // the recovery test couples confirmations to the queue, because only it asserts on it.
  const preferences = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    config,
    { now: clock, ...(withWork ? { work: queue } : {}) },
  );
  const sourceBound = createSourceBoundRecallService(
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    config,
    { now: clock, ...(withWork ? { work: queue } : {}) },
  );
  const facade = createDegradedRecallFacade(
    preferences,
    sourceBound,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    createDrizzleSourceBoundAuthorizations(database),
    { now: clock },
  );
  return { facade, preferences, sourceBound, queue };
}

let up: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let hang: { server: Server; url: string };
let upServices: ServiceSet;
let hangServices: ServiceSet;
let deadServices: ServiceSet;

beforeAll(async () => {
  // The attribution chain the foreign keys demand, in both companies. The tenancy tables
  // enforce one principal per global user (enterprise_principal_user), so the second company
  // rides its own user — the acceptance's isolation question is the authority rows' (tenant,
  // principal) pin, which the cross-company test below answers either way.
  await database.insert(users).values([
    { id: GLOBAL_ACTOR, email: `global-${run}@example.invalid` },
    { id: `${GLOBAL_ACTOR}-other`, email: `other-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT, name: `Acme ${run}` },
    { id: TENANT_OTHER, name: `Other ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: GLOBAL_ACTOR },
    { id: `${PRINCIPAL_EMP}-other`, userId: `${GLOBAL_ACTOR}-other` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" },
    {
      tenantId: TENANT_OTHER,
      principalId: `${PRINCIPAL_EMP}-other`,
      role: "member",
    },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT, id: WORKSPACE_A, name: `Team A ${run}` },
    { tenantId: TENANT, id: WORKSPACE_B, name: `Team B ${run}` },
    { tenantId: TENANT, id: WORKSPACE_UNJOINED, name: `Team C ${run}` },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT, workspaceId: WORKSPACE_A, principalId: PRINCIPAL_EMP },
    { tenantId: TENANT, workspaceId: WORKSPACE_B, principalId: PRINCIPAL_EMP },
  ]);
  await database.insert(hindsightMemoryGrants).values([
    {
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      kind: "source",
      targetId: SOURCE_ONE,
    },
    {
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      kind: "bot",
      targetId: BOT_ONE,
    },
  ]);

  up = await bootAnsweringHindsight();
  hang = await bootHangingHindsight();
  upServices = serviceSet(up.url, 2000);
  hangServices = serviceSet(hang.url, 300);
  deadServices = serviceSet(DEAD_URL, 300);
  // The shared test database carries whatever earlier runs (this session or another suite)
  // left pending in the sync-work table; settle it once so later suites' drain counts see
  // only their own rows. This is the queue's own mechanism, applied to test rows only.
  await upServices.queue.drain();
});

afterAll(async () => {
  for (const server of [up?.server, hang?.server]) {
    if (!server) continue;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
});

beforeEach(() => {
  if (up) {
    up.calls.length = 0;
    up.state.recallByBank.clear();
    up.state.userBankRecall = null;
    up.state.retainStatus = 202;
  }
});

async function seedPreference(
  input: Partial<typeof genericPersonalPreferences.$inferInsert> & {
    id: string;
  },
) {
  await database.insert(genericPersonalPreferences).values({
    tenantId: TENANT,
    principalId: PRINCIPAL_EMP,
    provenance: "seed",
    markedGenericAt: new Date(),
    hindsightDocumentId: preferenceDocumentIdFor(TENANT, input.id),
    ...input,
  });
}

async function seedSourceBound(
  input: Partial<typeof sourceBoundMemories.$inferInsert> & {
    id: string;
    restriction: "team" | "source" | "bot";
  },
) {
  await database.insert(sourceBoundMemories).values({
    tenantId: TENANT,
    principalId: PRINCIPAL_EMP,
    provenance: "seed",
    formedAt: new Date(),
    hindsightDocumentId: sourceBoundDocumentIdFor(TENANT, input.id),
    ...input,
  });
}

describe("Hindsight 08 (#385): the SQL fallback returns only confirmed, authorized rows", () => {
  test("a dead service degrades preferences to text-matched confirmed rows only", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record: confirmed } =
      await upServices.preferences.confirmGenericPreference(scope, {
        content: `确认的偏好内容 ${run}`,
      });
    await seedPreference({
      id: randomUUID(),
      content: `偏好 候选（未审核） ${run}`,
      reviewState: "unreviewed",
      enabled: true,
      deletedAt: null,
    });
    await seedPreference({
      id: randomUUID(),
      content: `偏好 已停用 ${run}`,
      reviewState: "confirmed",
      enabled: false,
      deletedAt: null,
    });
    await seedPreference({
      id: randomUUID(),
      content: `偏好 已遗忘 ${run}`,
      reviewState: "confirmed",
      enabled: false,
      deletedAt: new Date(),
    });

    const answer = await deadServices.facade.recallGenericPreferences(scope, {
      query: "偏好",
    });
    expect(answer.degraded).toBe(true);
    expect(answer.memories.map((item) => item.id)).toEqual([confirmed.id]);
    // The view is the seam's own contract: no bank, no document id, full temporal fields.
    expect(Object.keys(answer.memories[0]).sort()).toEqual([
      "content",
      "effectiveFrom",
      "effectiveUntil",
      "id",
      "markedGenericAt",
      "provenance",
      "timeUncertain",
    ]);
  });

  test("a hanging service degrades on timeout, not on refusal", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record } = await upServices.preferences.confirmGenericPreference(
      scope,
      {
        content: `周报要点简洁 ${run}`,
      },
    );
    const answer = await hangServices.facade.recallGenericPreferences(scope, {
      query: "周报",
    });
    expect(answer.degraded).toBe(true);
    expect(answer.memories.map((item) => item.id)).toEqual([record.id]);
    // A malformed query is still a refusal during an outage, never an outage answer.
    await expect(
      deadServices.facade.recallGenericPreferences(scope, { query: "" }),
    ).rejects.toThrow("1..512");
    await expect(
      deadServices.facade.recallGenericPreferences(scope, {
        query: "例会",
        asOf: "not-a-date",
      }),
    ).rejects.toThrow("as-of time must be a date");
  });

  test("a semantic near-miss answers nothing rather than guessing", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    await upServices.preferences.confirmGenericPreference(scope, {
      content: `每周站会 ${run}`,
    });
    const answer = await deadServices.facade.recallGenericPreferences(scope, {
      query: "站会周",
    });
    expect(answer.degraded).toBe(true);
    expect(answer.memories).toEqual([]);
  });

  test("temporal windows survive the fallback: current and historical answers", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    // T0 (the clock's start): the old fact is confirmed.
    const { record: original } =
      await upServices.preferences.confirmGenericPreference(scope, {
        content: `例会在周五 ${run}`,
      });
    // T2, still at T0 on the clock: the correction names mid-October.
    const correctedAt = new Date("2026-10-15T00:00:00.000Z");
    const { record: successor } =
      await upServices.preferences.correctGenericPreference(
        scope,
        original.id,
        {
          content: `例会改到下周一 ${run}`,
          effectiveFrom: correctedAt,
        },
      );
    // T3: the successor has taken effect; a January-style past moment has not happened yet,
    // so the historical question asks about mid-October, inside the old fact's window.
    simulatedNow = new Date("2026-10-20T00:00:00.000Z");
    const currentAnswer = await deadServices.facade.recallGenericPreferences(
      scope,
      { query: "例会" },
    );
    expect(currentAnswer.degraded).toBe(true);
    expect(currentAnswer.memories.map((item) => item.content)).toEqual([
      `例会改到下周一 ${run}`,
    ]);
    const historicalAnswer = await deadServices.facade.recallGenericPreferences(
      scope,
      { query: "例会", asOf: "2026-10-10T00:00:00.000Z" },
    );
    expect(historicalAnswer.memories.map((item) => item.content)).toEqual([
      `例会在周五 ${run}`,
    ]);
    expect(historicalAnswer.memories[0].timeUncertain).toBe(false);
    expect(successor.effectiveFrom?.toISOString()).toBe(
      correctedAt.toISOString(),
    );
  });

  test("source-bound degradation keeps the asking workspace, sources and Bots in check", async () => {
    const scopeA = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record: teamFact } =
      await upServices.sourceBound.confirmSourceBoundMemory(scopeA, {
        content: `团队 A 的业务事实 ${run}`,
        restriction: { kind: "team", workspaceId: WORKSPACE_A },
      });
    const { record: sourceFact } =
      await upServices.sourceBound.confirmSourceBoundMemory(scopeA, {
        content: `来源来源的事实 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_ONE },
      });
    const { record: botFact } =
      await upServices.sourceBound.confirmSourceBoundMemory(scopeA, {
        content: `Bot 自己的事实 ${run}`,
        restriction: { kind: "bot", agentId: BOT_ONE },
      });
    await seedSourceBound({
      id: randomUUID(),
      restriction: "team",
      workspaceId: WORKSPACE_A,
      content: `候选（未审核） ${run}`,
      reviewState: "unreviewed",
      enabled: true,
      deletedAt: null,
    });

    // Team A asking: the team fact and the source fact answer; the candidate never does.
    const inA = await deadServices.facade.recallSourceBoundMemories(scopeA, {
      query: "事实",
    });
    expect(inA.degraded).toBe(true);
    expect(inA.memories.map((item) => item.id).sort()).toEqual(
      [teamFact.id, sourceFact.id].sort(),
    );
    // The Bot's own fact answers only when that Bot is asking.
    const asBot = await deadServices.facade.recallSourceBoundMemories(scopeA, {
      query: "事实",
      askingAgentId: BOT_ONE,
    });
    expect(asBot.memories.map((item) => item.id)).toContain(botFact.id);
    const asOtherBot = await deadServices.facade.recallSourceBoundMemories(
      scopeA,
      { query: "事实", askingAgentId: "agt_someone-else" },
    );
    expect(asOtherBot.memories.map((item) => item.id)).not.toContain(
      botFact.id,
    );

    // Team B asking: team A's fact is structurally not team B's to see.
    const scopeB = await makeTrustedScope(TENANT, WORKSPACE_B);
    const inB = await deadServices.facade.recallSourceBoundMemories(scopeB, {
      query: "事实",
    });
    expect(inB.memories.map((item) => item.id)).toEqual([sourceFact.id]);
  });

  test("a revoked source disappears from the degraded answer too", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record } = await upServices.sourceBound.confirmSourceBoundMemory(
      scope,
      {
        content: `来源撤权验证 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_ONE },
      },
    );
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    try {
      const answer = await deadServices.facade.recallSourceBoundMemories(
        scope,
        { query: "撤权" },
      );
      expect(answer.degraded).toBe(true);
      expect(answer.memories.map((item) => item.id)).not.toContain(record.id);
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });

  test("an empty authorization snapshot answers empty, never a guessed bank", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    await upServices.sourceBound.confirmSourceBoundMemory(scope, {
      content: `快照为空的事实 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    // Everything that could name a bank goes away at once: the workspace membership is
    // suspended AND the only enabled source is revoked — an empty snapshot must answer
    // empty, not fall back to some bank the person held earlier.
    await database
      .update(enterpriseWorkspaceMemberships)
      .set({ status: "suspended" })
      .where(eq(enterpriseWorkspaceMemberships.workspaceId, WORKSPACE_A));
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    try {
      const answer = await deadServices.facade.recallSourceBoundMemories(
        scope,
        { query: "事实" },
      );
      // Empty, and honestly NOT degraded: with no bank to ask, the seam never reached the
      // service, so there was no outage to fall back from — the answer is simply nothing.
      expect(answer.degraded).toBe(false);
      expect(answer.memories).toEqual([]);
    } finally {
      await database
        .update(enterpriseWorkspaceMemberships)
        .set({ status: "active" })
        .where(eq(enterpriseWorkspaceMemberships.workspaceId, WORKSPACE_A));
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });

  test("the same global user's other company never answers", async () => {
    const PRINCIPAL_OTHER = `${PRINCIPAL_EMP}-other`;
    const WORKSPACE_OTHER = `ws_other-${run}`;
    await database.insert(enterpriseWorkspaces).values([
      {
        tenantId: TENANT_OTHER,
        id: WORKSPACE_OTHER,
        name: `Other HQ ${run}`,
      },
    ]);
    const scopeOne = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record: inOne } =
      await upServices.preferences.confirmGenericPreference(scopeOne, {
        content: `跨公司相同内容 ${run}`,
      });
    const scopeOther = await makeTrustedScope(
      TENANT_OTHER,
      WORKSPACE_OTHER,
      "web",
      PRINCIPAL_OTHER,
    );
    const { record: inOther } =
      await upServices.preferences.confirmGenericPreference(scopeOther, {
        content: `跨公司相同内容 ${run}`,
      });
    expect(inOne.id).not.toBe(inOther.id);
    const answerOne = await deadServices.facade.recallGenericPreferences(
      scopeOne,
      { query: "跨公司" },
    );
    expect(answerOne.memories.map((item) => item.id)).toEqual([inOne.id]);
    const answerOther = await deadServices.facade.recallGenericPreferences(
      scopeOther,
      { query: "跨公司" },
    );
    expect(answerOther.memories.map((item) => item.id)).toEqual([inOther.id]);
  });

  test("a healthy service answers through the seam, undegraded", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record } = await upServices.preferences.confirmGenericPreference(
      scope,
      { content: `健康路径 ${run}` },
    );
    up.state.userBankRecall = {
      status: 200,
      body: {
        results: [{ document_id: preferenceDocumentIdFor(TENANT, record.id) }],
      },
    };
    const answer = await upServices.facade.recallGenericPreferences(scope, {
      query: "健康",
    });
    expect(answer.degraded).toBe(false);
    expect(answer.memories.map((item) => item.id)).toEqual([record.id]);
    // A service 5xx is an outage for the WHOLE answer, not half: degrade, don't guess.
    up.state.userBankRecall = { status: 503, body: { error: "down" } };
    const outage = await upServices.facade.recallGenericPreferences(scope, {
      query: "健康",
    });
    expect(outage.degraded).toBe(true);
  });
});

describe("Hindsight 08 (#385): an outage never fakes indexing", () => {
  test("confirmations during the outage stay pending and drain after recovery", async () => {
    // The one place this file couples confirmations to the sync queue (#384): the outage
    // semantics under acceptance 2.
    const deadWithWork = serviceSet(DEAD_URL, 300, true);
    const recoveryQueue = createHindsightSyncQueue(
      database,
      {
        apiUrl: up.url,
        serviceApiKey: SERVICE_KEY,
        assertionSecret: SECRET,
        requestTimeoutMs: 2000,
      },
      {
        authorizations: createDrizzleSourceBoundAuthorizations(database),
        now: clock,
      },
    );
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record, remoteSynced } =
      await deadWithWork.preferences.confirmGenericPreference(scope, {
        content: `故障期间的确认 ${run}`,
      });
    expect(remoteSynced).toBe(false);
    const duringOutage = await deadWithWork.queue.syncStatus(
      TENANT,
      "preference",
      record.id,
    );
    expect(duringOutage).toEqual({ state: "pending", attempts: 0 });

    const sourceScope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record: boundRecord, remoteSynced: boundSynced } =
      await deadWithWork.sourceBound.confirmSourceBoundMemory(sourceScope, {
        content: `故障期间的来源确认 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_ONE },
      });
    expect(boundSynced).toBe(false);

    const report = await recoveryQueue.drain();
    // This file settles pre-existing pending rows beforeAll, so the drain sees exactly the
    // two outage confirmations; the bound stays >= so a leftover can never fail the suite.
    expect(report.synced).toBeGreaterThanOrEqual(2);
    const afterRecovery = await recoveryQueue.syncStatus(
      TENANT,
      "preference",
      record.id,
    );
    expect(afterRecovery.state).toBe("indexed");
    const boundAfter = await recoveryQueue.syncStatus(
      TENANT,
      "source_bound",
      boundRecord.id,
    );
    expect(boundAfter.state).toBe("indexed");
  });

  test("a recovered service answers undegraded again", async () => {
    const scope = await makeTrustedScope(TENANT, WORKSPACE_A);
    const { record } = await upServices.preferences.confirmGenericPreference(
      scope,
      { content: `恢复后的回答 ${run}` },
    );
    up.state.userBankRecall = {
      status: 200,
      body: {
        results: [{ document_id: preferenceDocumentIdFor(TENANT, record.id) }],
      },
    };
    const answer = await upServices.facade.recallGenericPreferences(scope, {
      query: "恢复",
    });
    expect(answer.degraded).toBe(false);
    expect(answer.memories.map((item) => item.id)).toEqual([record.id]);
  });
});

describe("Hindsight 08 (#385): every entrance degrades identically", () => {
  test("web, desktop and schedule scopes get the same degraded answer", async () => {
    const entries = ["web", "desktop", "schedule"] as const;
    const scopes = await Promise.all(
      entries.map((entrypoint) =>
        makeTrustedScope(TENANT, WORKSPACE_A, entrypoint),
      ),
    );
    const { record } = await upServices.preferences.confirmGenericPreference(
      scopes[0],
      { content: `跨入口的事实 ${run}` },
    );
    const answers = await Promise.all(
      scopes.map((scope) =>
        deadServices.facade.recallGenericPreferences(scope, {
          query: "跨入口",
        }),
      ),
    );
    for (const answer of answers) {
      expect(answer.degraded).toBe(true);
      expect(answer.memories).toEqual(answers[0].memories);
    }
    expect(answers[0].memories.map((item) => item.id)).toEqual([record.id]);

    // The revocation filter is the same under every entrance too.
    const { record: bound } =
      await upServices.sourceBound.confirmSourceBoundMemory(scopes[0], {
        content: `跨入口的来源事实 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_ONE },
      });
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    try {
      const revoked = await Promise.all(
        scopes.map((scope) =>
          deadServices.facade.recallSourceBoundMemories(scope, {
            query: "跨入口的来源",
          }),
        ),
      );
      for (const answer of revoked) {
        expect(answer.degraded).toBe(true);
        expect(answer.memories.map((item) => item.id)).not.toContain(bound.id);
      }
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });
});
