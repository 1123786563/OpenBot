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
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  botBankFor,
  sourceBankFor,
  teamBankFor,
  userBankFor,
  verifyBankScopeAssertion,
} from "../src/hindsight/bank-scope";
import type { HindsightBudgetGate } from "../src/hindsight/budget-gate";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 06 (#383), integration layer: the source-bound recall seam over the real authority
 * table, the real tenancy tables and a scripted Hindsight service.
 *
 * One describe per acceptance clause:
 *
 * 1. Confirm stays source-bound: the retain lands in the restriction's bank (team/source/bot
 *    derivation), never the user bank, and the contract a Bot sees carries no bank and no
 *    document id.
 * 2. Team isolation: team A's facts answer a team A recall and are dropped from a team B
 *    recall even when the scripted service wrongly hands team A's document id to the team B
 *    bank's answer — the row check, not the service, decides.
 * 3. Revocation: source disabled, workspace membership suspended, Bot's app revoked — the NEXT
 *    recall excludes the memories, and a revocation landed between hit and load is blocked the
 *    same way (the seam re-reads authorization after the remote answers).
 * 4. Person boundary: an administrator's trusted scope is another principal — the employee's
 *    rows are structurally not the admin's to load; a forged scope never gets a bank at all.
 *
 * Scopes are minted the production way (createScopeResolver over a controlled directory
 * database); the workspace-membership, source and Bot authorization checks run against the
 * REAL tables below, so suspending a membership or flipping a grant is a genuine revocation.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_acme-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const WORKSPACE_UNJOINED = `ws_team-c-${run}`;
const PRINCIPAL_EMP = `prin_employee-${run}`;
const PRINCIPAL_ADMIN = `prin_admin-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_connected-1-${run}`;
const SOURCE_TWO = `src_connected-2-${run}`;
const BOT_ONE = `agt_bot-1-${run}`;
const BOT_TWO = `agt_bot-2-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

const TEAM_BANK_A = teamBankFor(WORKSPACE_A);
const TEAM_BANK_B = teamBankFor(WORKSPACE_B);
const SOURCE_BANK_ONE = sourceBankFor(SOURCE_ONE);
const BOT_BANK_ONE = botBankFor(BOT_ONE);
const USER_BANK_EMP = userBankFor(PRINCIPAL_EMP);

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  bank: string;
  authorization: string | undefined;
  scope: string | undefined;
};

type ScriptedRecallAnswer = { status: number; body: unknown };

/** The scripted service's mutable answers; the request handler reads this object live. */
type ScriptedState = {
  recallByBank: Map<string, ScriptedRecallAnswer>;
  retainStatus: number;
  /** Runs before a recall is answered — the seam is mid-flight, waiting on the remote. */
  onRecall: ((bank: string) => Promise<void>) | null;
};

let service: ReturnType<typeof createSourceBoundRecallService>;
let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
    onRecall: null,
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
      if (request.method === "POST" && path.endsWith("/memories")) {
        status = state.retainStatus;
        payload = { accepted: 1 };
      } else if (
        request.method === "POST" &&
        path.endsWith("/memories/recall")
      ) {
        void (async () => {
          if (state.onRecall) await state.onRecall(bank);
          const answer = state.recallByBank.get(bank);
          status = answer?.status ?? 404;
          payload = answer?.body ?? { results: [] };
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        })();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("scripted hindsight did not bind a port");
  return { server, url: `http://127.0.0.1:${address.port}`, calls, state };
}

// The controlled-directory technique from hindsight-bank-scope.test.ts: a drizzle-shaped
// database good enough for verifyDirectoryDatabase's capability probe and the membership
// select inside resolve(), so the minted scope carries the real issuedScopes marker.
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

async function makeTrustedScope(
  principalId: string,
  workspaceId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => workspaceId,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** A structurally perfect scope nobody issued — the forgery this seam must refuse. */
function forgedScope(principalId: string, workspaceId: string): PlatformScope {
  return Object.freeze({
    tenantId: TENANT,
    workspaceId,
    principalId,
    actorId: GLOBAL_ACTOR,
    memberEpoch: 3,
    aclEpoch: 1,
    entrypoint: "web",
  } satisfies PlatformScope);
}

beforeAll(async () => {
  // The attribution chain the foreign keys demand: users → principals → tenant → memberships
  // → workspaces → workspace memberships, plus the grant registry rows the authorization
  // store reads. The employee sits in BOTH teams; the admin shares only team A.
  await database.insert(users).values([
    { id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` },
    { id: `usr_admin-${run}`, email: `admin-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Acme ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: `usr_emp-${run}` },
    { id: PRINCIPAL_ADMIN, userId: `usr_admin-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_ADMIN, role: "tenant_admin" },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT, id: WORKSPACE_A, name: `Team A ${run}` },
    { tenantId: TENANT, id: WORKSPACE_B, name: `Team B ${run}` },
    { tenantId: TENANT, id: WORKSPACE_UNJOINED, name: `Team C ${run}` },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_EMP,
    },
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_B,
      principalId: PRINCIPAL_EMP,
    },
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_ADMIN,
    },
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

  scripted = await bootScriptedHindsight();
  service = createSourceBoundRecallService(
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    {
      apiUrl: scripted.url,
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 2000,
    },
  );
});

afterAll(async () => {
  if (!scripted) return;
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

/** Every test starts from a clean scripted service: no stale answers, no stale hooks. */
beforeEach(() => {
  scripted.calls.length = 0;
  scripted.state.recallByBank.clear();
  scripted.state.retainStatus = 202;
  scripted.state.onRecall = null;
});

function answerHits(bank: string, documentIds: string[]) {
  scripted.state.recallByBank.set(bank, {
    status: 200,
    body: { results: documentIds.map((document_id) => ({ document_id })) },
  });
}

async function suspendMembership(workspaceId: string) {
  await database
    .update(enterpriseWorkspaceMemberships)
    .set({ status: "suspended" })
    .where(eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId));
}

async function restoreMembership(workspaceId: string) {
  await database
    .update(enterpriseWorkspaceMemberships)
    .set({ status: "active" })
    .where(eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId));
}

describe("Hindsight 06 (#383): confirming keeps the memory source-bound", () => {
  test("a team fact retains into the team bank, never the user bank", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record, remoteSynced } = await service.confirmSourceBoundMemory(
      scope,
      {
        content: `团队 A 的业务事实 ${run}`,
        restriction: { kind: "team", workspaceId: WORKSPACE_A },
      },
    );
    expect(remoteSynced).toBe(true);
    expect(record.restriction).toEqual({
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const retains = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    );
    expect(retains.length).toBeGreaterThan(0);
    expect(retains.every((call) => call.bank === TEAM_BANK_A)).toBe(true);
    expect(scripted.calls.some((call) => call.bank === USER_BANK_EMP)).toBe(
      false,
    );
    // The retain carries the stable document identity and replaces in place.
    const body = retains[0].body as {
      items: { content: string; document_id: string }[];
    };
    expect(body.items[0].document_id).toBe(
      sourceBoundDocumentIdFor(TENANT, record.id),
    );
  });

  test("a source fact and a Bot fact retain into their own banks", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    await service.confirmSourceBoundMemory(scope, {
      content: `连接来源的事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    await service.confirmSourceBoundMemory(scope, {
      content: `Bot 形成的事实 ${run}`,
      restriction: { kind: "bot", agentId: BOT_ONE },
    });
    const banks = scripted.calls
      .filter(
        (call) => call.method === "POST" && call.path.endsWith("/memories"),
      )
      .map((call) => call.bank);
    expect(banks).toContain(SOURCE_BANK_ONE);
    expect(banks).toContain(BOT_BANK_ONE);
    expect(banks).not.toContain(USER_BANK_EMP);
  });

  test("confirming into a scope not currently authorized is refused", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    await expect(
      service.confirmSourceBoundMemory(scope, {
        content: `未加入团队的事实 ${run}`,
        restriction: { kind: "team", workspaceId: WORKSPACE_UNJOINED },
      }),
    ).rejects.toThrow("not currently authorized");
    await expect(
      service.confirmSourceBoundMemory(scope, {
        content: `未启用来源的事实 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_TWO },
      }),
    ).rejects.toThrow("not currently authorized");
    await expect(
      service.confirmSourceBoundMemory(scope, {
        content: `未授权 Bot 的事实 ${run}`,
        restriction: { kind: "bot", agentId: BOT_TWO },
      }),
    ).rejects.toThrow("not currently authorized");
  });

  test("the contract a Bot sees carries no bank and no document id", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    answerHits(SOURCE_BANK_ONE, []);
    const recalled = await service.recallSourceBoundMemories(scope, {
      query: "业务事实",
    });
    expect(
      recalled.every(
        (item) =>
          JSON.stringify(item).includes("ob_") === false &&
          JSON.stringify(item).includes("hsb_") === false,
      ),
    ).toBe(true);
  });
});

describe("Hindsight 06 (#383): team A facts do not answer a team B recall", () => {
  test("the recall answers inside the asking workspace only", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(scope, {
      content: `团队 A 独有事实 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    const documentId = sourceBoundDocumentIdFor(TENANT, record.id);
    answerHits(TEAM_BANK_A, [documentId]);
    // The scripted service wrongly hands team A's document id to the team B bank too: the
    // seam, not the service, decides — and the row says workspace A.
    answerHits(TEAM_BANK_B, [documentId]);

    const inA = await service.recallSourceBoundMemories(
      await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A),
      { query: "团队事实" },
    );
    expect(inA.map((item) => item.id)).toEqual([record.id]);

    const inB = await service.recallSourceBoundMemories(
      await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_B),
      { query: "团队事实" },
    );
    expect(inB).toEqual([]);

    // The team B recall asked only team B's bank: team A's bank was never queried.
    const recallPaths = scripted.calls
      .filter((call) => call.path.endsWith("/memories/recall"))
      .map((call) => call.bank);
    expect(recallPaths).toContain(TEAM_BANK_B);
  });

  test("one assertion covers the banks of the asking context, and only those", async () => {
    scripted.calls.length = 0;
    answerHits(TEAM_BANK_A, []);
    answerHits(SOURCE_BANK_ONE, []);
    answerHits(BOT_BANK_ONE, []);
    await service.recallSourceBoundMemories(
      await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A),
      { query: "一切事实", askingAgentId: BOT_ONE },
    );
    const recalls = scripted.calls.filter((call) =>
      call.path.endsWith("/memories/recall"),
    );
    expect(recalls.length).toBe(3);
    for (const call of recalls) {
      const payload = call.scope
        ? verifyBankScopeAssertion(call.scope, { secret: SECRET })
        : null;
      expect(payload).not.toBeNull();
      expect(new Set(payload?.b)).toEqual(
        new Set([TEAM_BANK_A, SOURCE_BANK_ONE, BOT_BANK_ONE]),
      );
      expect(call.authorization).toBe(`Bearer ${SERVICE_KEY}`);
      expect(payload?.b).toContain(call.bank);
    }
  });
});

describe("Hindsight 06 (#383): revocation excludes on the next recall", () => {
  test("a disabled source drops its memories", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(scope, {
      content: `来源受限事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    answerHits(SOURCE_BANK_ONE, [sourceBoundDocumentIdFor(TENANT, record.id)]);
    const before = await service.recallSourceBoundMemories(scope, {
      query: "来源事实",
    });
    expect(before.map((item) => item.id)).toEqual([record.id]);

    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    const after = await service.recallSourceBoundMemories(scope, {
      query: "来源事实",
    });
    expect(after).toEqual([]);
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
  });

  test("a suspended workspace membership drops the team bank and the hits", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(scope, {
      content: `团队事实（成员资格） ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    answerHits(TEAM_BANK_A, [sourceBoundDocumentIdFor(TENANT, record.id)]);
    await suspendMembership(WORKSPACE_A);
    try {
      scripted.calls.length = 0;
      const after = await service.recallSourceBoundMemories(scope, {
        query: "团队事实",
      });
      expect(after).toEqual([]);
      // The suspended workspace's bank was not even asked.
      const recallPaths = scripted.calls
        .filter((call) => call.path.endsWith("/memories/recall"))
        .map((call) => call.bank);
      expect(recallPaths).not.toContain(TEAM_BANK_A);
    } finally {
      await restoreMembership(WORKSPACE_A);
    }
  });

  test("a Bot that lost its app is excluded, and another Bot never sees its bank", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(scope, {
      content: `Bot 事实（应用权限） ${run}`,
      restriction: { kind: "bot", agentId: BOT_ONE },
    });
    answerHits(BOT_BANK_ONE, [sourceBoundDocumentIdFor(TENANT, record.id)]);
    const asking = await service.recallSourceBoundMemories(scope, {
      query: "Bot 事实",
      askingAgentId: BOT_ONE,
    });
    expect(asking.map((item) => item.id)).toEqual([record.id]);

    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, BOT_ONE));
    const revoked = await service.recallSourceBoundMemories(scope, {
      query: "Bot 事实",
      askingAgentId: BOT_ONE,
    });
    expect(revoked).toEqual([]);
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true })
      .where(eq(hindsightMemoryGrants.targetId, BOT_ONE));

    // Another Bot asking does not bring BOT_ONE's bank along at all.
    scripted.calls.length = 0;
    await service.recallSourceBoundMemories(scope, {
      query: "Bot 事实",
      askingAgentId: BOT_TWO,
    });
    const banks = scripted.calls
      .filter((call) => call.path.endsWith("/memories/recall"))
      .map((call) => call.bank);
    expect(banks).not.toContain(BOT_BANK_ONE);
  });

  test("a revocation landing between hit and load is blocked", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(scope, {
      content: `撤权窗口内的事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    const documentId = sourceBoundDocumentIdFor(TENANT, record.id);
    answerHits(SOURCE_BANK_ONE, [documentId]);
    // The remote is ABOUT to answer with the hit; the source is disabled while the seam
    // waits — the second authorization read must drop what the first one searched for.
    scripted.state.onRecall = async (bank) => {
      if (bank !== SOURCE_BANK_ONE) return;
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: false })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    };
    try {
      const recalled = await service.recallSourceBoundMemories(scope, {
        query: "撤权窗口",
      });
      expect(recalled).toEqual([]);
    } finally {
      scripted.state.onRecall = null;
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });

  test("unreviewed, disabled and forgotten rows never reach the Bot", async () => {
    const seeds = [
      {
        id: randomUUID(),
        restriction: "team" as const,
        workspaceId: WORKSPACE_A,
        reviewState: "unreviewed" as const,
        enabled: true,
        deletedAt: null,
        content: `候选（未审核） ${run}`,
      },
      {
        id: randomUUID(),
        restriction: "team" as const,
        workspaceId: WORKSPACE_A,
        reviewState: "confirmed" as const,
        enabled: false,
        deletedAt: null,
        content: `已停用 ${run}`,
      },
      {
        id: randomUUID(),
        restriction: "team" as const,
        workspaceId: WORKSPACE_A,
        reviewState: "confirmed" as const,
        enabled: true,
        deletedAt: new Date(),
        content: "",
      },
    ];
    for (const seed of seeds) {
      await database.insert(sourceBoundMemories).values({
        tenantId: TENANT,
        id: seed.id,
        principalId: PRINCIPAL_EMP,
        restriction: seed.restriction,
        workspaceId: seed.workspaceId,
        sourceId: null,
        agentId: null,
        content: seed.content,
        provenance: "seed",
        reviewState: seed.reviewState,
        enabled: seed.enabled,
        deletedAt: seed.deletedAt,
        hindsightDocumentId: sourceBoundDocumentIdFor(TENANT, seed.id),
      });
      answerHits(TEAM_BANK_A, [
        ...seeds.map((item) => sourceBoundDocumentIdFor(TENANT, item.id)),
      ]);
    }
    const recalled = await service.recallSourceBoundMemories(
      await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A),
      { query: "一切" },
    );
    expect(recalled).toEqual([]);
  });
});

describe("Hindsight 06 (#383): the person boundary", () => {
  test("an administrator's scope does not load an employee's rows", async () => {
    const employeeScope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await service.confirmSourceBoundMemory(employeeScope, {
      content: `员工的事实 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    answerHits(TEAM_BANK_A, [sourceBoundDocumentIdFor(TENANT, record.id)]);
    // The scripted service hands the employee's document id to whoever asks; the admin's
    // own rows do not own it, so the seam drops it before anything reaches the Bot.
    const asAdmin = await service.recallSourceBoundMemories(
      await makeTrustedScope(PRINCIPAL_ADMIN, WORKSPACE_A),
      { query: "员工的事实" },
    );
    expect(asAdmin).toEqual([]);
  });

  test("a forged scope is refused before any bank is chosen", async () => {
    scripted.calls.length = 0;
    await expect(
      service.recallSourceBoundMemories(
        forgedScope(PRINCIPAL_EMP, WORKSPACE_A),
        { query: "伪造身份" },
      ),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    await expect(
      service.confirmSourceBoundMemory(
        forgedScope(PRINCIPAL_EMP, WORKSPACE_A),
        {
          content: `伪造身份的事实 ${run}`,
          restriction: { kind: "team", workspaceId: WORKSPACE_A },
        },
      ),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    expect(scripted.calls.length).toBe(0);
  });
});

/*
 * FIX-OCR3 (O3-M1): the eager retain's budget bookkeeping is a local DB write that runs
 * after the source-bound row and its work row already landed — the judgment review's O2-M1
 * rule, which this seam's docblock claimed by name but did not actually carry. On BASE a
 * throwing settle or admission released into the confirm's answer: a decision that had
 * already succeeded reported failure, and the person's retry landed on the same content.
 */
describe("FIX-OCR3 — budget bookkeeping never fails the source-bound confirm", () => {
  const failures = { admit: false, settle: false, release: false };
  const throwingBudget: HindsightBudgetGate = {
    async admitBackgroundWork() {
      if (failures.admit) throw new Error("admission ledger exploded");
      return { ok: true, reservationId: `res-o3-${run}` };
    },
    async settleBackgroundWork() {
      if (failures.settle) throw new Error("settle ledger exploded");
    },
    async releaseBackgroundWork() {
      if (failures.release) throw new Error("release ledger exploded");
    },
    async currentUsage() {
      return { companyUnits: 0, personalUnits: [], period: "2026-10" };
    },
  };
  /** A source-bound service over the same records as the suite's, with the failing budget. */
  const budgetedService = (config: {
    apiUrl: string;
    serviceApiKey: string;
    assertionSecret: string;
    requestTimeoutMs: number;
  }) =>
    createSourceBoundRecallService(
      createDrizzleSourceBoundRecords(database),
      createDrizzleSourceBoundAuthorizations(database),
      config,
      { budget: throwingBudget },
    );

  test("a settle that throws after a successful retain keeps the confirm standing and synced", async () => {
    failures.admit = false;
    failures.settle = true;
    failures.release = false;
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record, remoteSynced } = await budgetedService({
      apiUrl: scripted.url,
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 2000,
    }).confirmSourceBoundMemory(scope, {
      content: `簿记失败结算来源事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    expect(remoteSynced).toBe(true);
    const [row] = await database
      .select()
      .from(sourceBoundMemories)
      .where(eq(sourceBoundMemories.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    failures.settle = false;
  });

  test("an admission that throws skips the retain: the decision stands, unsynced", async () => {
    failures.admit = true;
    failures.settle = false;
    failures.release = false;
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const retainsBefore = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    ).length;
    const { record, remoteSynced } = await budgetedService({
      apiUrl: scripted.url,
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 2000,
    }).confirmSourceBoundMemory(scope, {
      content: `簿记失败准入来源事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    expect(remoteSynced).toBe(false);
    const [row] = await database
      .select()
      .from(sourceBoundMemories)
      .where(eq(sourceBoundMemories.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    const retainsAfter = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    ).length;
    expect(retainsAfter).toBe(retainsBefore);
    failures.admit = false;
  });
});
