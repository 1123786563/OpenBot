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
import { hindsightMemoryGrants } from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  createAnswerEvidenceService,
  EvidenceNotFoundError,
} from "../src/hindsight/answer-evidence";
import {
  sourceBankFor,
  teamBankFor,
  userBankFor,
} from "../src/hindsight/bank-scope";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
import { createDrizzleDerivedJudgmentRecords } from "../src/hindsight/derived-judgments";
import { createDerivedJudgmentReviewService } from "../src/hindsight/judgment-review";
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

/*
 * Hindsight 10 (#387), integration layer: the expandable evidence behind a personal-memory
 * answer, over the real authority tables, the real tenancy tables and a scripted Hindsight
 * service.
 *
 * One describe per acceptance clause:
 *
 * 1. An answer's bases expand into the full chain — hit (the id the answer cited) → original
 *    (the re-loaded confirmed bytes) → source authorization (provenance, and for source-bound
 *    facts the restriction #383 bound them to), preferences additionally carrying #386's
 *    validity window and correction link.
 * 2. The evidence entry can correct and forget, and the NEXT answer — indexed or degraded —
 *    reflects the latest facts and permissions.
 * 3. A basis that is missing, foreign, unreviewed, forgotten or no longer authorized answers
 *    a contentless "unavailable", and nothing is ever inferred into the gap.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_acme-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const PRINCIPAL_EMP = `prin_employee-${run}`;
const PRINCIPAL_ADMIN = `prin_admin-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_connected-${run}`;
const BOT_ONE = `agt_bot-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

const TEAM_BANK_A = teamBankFor(WORKSPACE_A);
const SOURCE_BANK_ONE = sourceBankFor(SOURCE_ONE);
const USER_BANK = userBankFor(PRINCIPAL_EMP);

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  bank: string;
};

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  retainStatus: number;
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let preferences: ReturnType<typeof createPreferenceRecallService>;
let sourceBound: ReturnType<typeof createSourceBoundRecallService>;
let facade: ReturnType<typeof createDegradedRecallFacade>;
let evidence: ReturnType<typeof createAnswerEvidenceService>;

/**
 * The file's controllable clock: a correction must land after its predecessor's start and
 * before "now", which real time cannot order. Shares one timeline across services so a
 * correction's window and the next answer's current/historical reads agree.
 */
let simulatedNow = new Date("2026-10-01T08:00:00.000Z");
const clock = () => simulatedNow;
const DAY = 86400_000;

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = { recallByBank: new Map(), retainStatus: 202 };
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
      calls.push({ method: request.method ?? "", path, body, bank });
      let status = 404;
      let payload: unknown = { error: "scripted: no route" };
      if (request.method === "DELETE") {
        status = 202;
        payload = { deleted: 1 };
      } else if (request.method !== "POST") {
        status = 202;
        payload = { accepted: 1 };
      } else if (path.endsWith("/memories")) {
        status = state.retainStatus;
        payload = { accepted: 1 };
      } else if (path.endsWith("/memories/recall")) {
        const answer = state.recallByBank.get(bank);
        status = answer?.status ?? 200;
        payload = answer?.body ?? { results: [] };
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

// The controlled-directory technique from hindsight-source-bound-recall.integration.test.ts:
// a drizzle-shaped database good enough for verifyDirectoryDatabase's capability probe and
// the membership select inside resolve(), so the minted scope carries the issuedScopes marker.
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

beforeAll(async () => {
  await database.insert(users).values([
    { id: GLOBAL_ACTOR, email: `global-${run}@example.invalid` },
    { id: `usr_admin-${run}`, email: `admin-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Acme ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: GLOBAL_ACTOR },
    { id: PRINCIPAL_ADMIN, userId: `usr_admin-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_ADMIN, role: "tenant_admin" },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT, id: WORKSPACE_A, name: `Team A ${run}` },
    { tenantId: TENANT, id: WORKSPACE_B, name: `Team B ${run}` },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT, workspaceId: WORKSPACE_A, principalId: PRINCIPAL_EMP },
    { tenantId: TENANT, workspaceId: WORKSPACE_B, principalId: PRINCIPAL_EMP },
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
  const config = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  };
  preferences = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    config,
    { now: clock },
  );
  sourceBound = createSourceBoundRecallService(
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    config,
    { now: clock },
  );
  facade = createDegradedRecallFacade(
    preferences,
    sourceBound,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    createDrizzleSourceBoundAuthorizations(database),
    { now: clock },
  );
  evidence = createAnswerEvidenceService(
    preferences,
    sourceBound,
    createDrizzlePreferenceRecords(database),
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    // #389: judgment ids dispatch to the review seam; this suite's judgment cases live in
    // hindsight-judgment-review.integration.test.ts, this construction just stays honest.
    createDerivedJudgmentReviewService(
      createDrizzlePreferenceRecords(database),
      createDrizzleSourceBoundRecords(database),
      createDrizzleDerivedJudgmentRecords(database),
      createDrizzleSourceBoundAuthorizations(database),
      config,
      { now: clock },
    ),
  );
});

afterAll(async () => {
  if (!scripted) return;
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.state.recallByBank.clear();
  scripted.state.retainStatus = 202;
});

function answerUserBankHits(documentIds: string[]) {
  scripted.state.recallByBank.set(USER_BANK, {
    status: 200,
    body: { results: documentIds.map((document_id) => ({ document_id })) },
  });
}

function answerBankHits(bank: string, documentIds: string[]) {
  scripted.state.recallByBank.set(bank, {
    status: 200,
    body: { results: documentIds.map((document_id) => ({ document_id })) },
  });
}

describe("Hindsight 10 (#387): an answer's bases expand into the full chain", () => {
  test("a preference basis shows the hit, the re-loaded original, the window and actions", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await preferences.confirmGenericPreference(scope, {
      content: `周报使用简短要点 ${run}`,
      provenance: `团队对话 ${run}`,
    });
    answerUserBankHits([preferenceDocumentIdFor(TENANT, record.id)]);
    const answer = await facade.recallGenericPreferences(scope, {
      query: "周报",
    });
    expect(answer.memories.map((item) => item.id)).toEqual([record.id]);

    const [basis] = await evidence.inspectEvidence(scope, { ids: [record.id] });
    expect(basis).toMatchObject({
      state: "available",
      kind: "preference",
      id: record.id,
      content: `周报使用简短要点 ${run}`,
      provenance: `团队对话 ${run}`,
      effectiveUntil: null,
      supersededBy: null,
      actions: ["edit", "correct", "forget"],
    });
    if (basis.state !== "available" || basis.kind !== "preference") {
      throw new Error("expected an available preference basis");
    }
    // The window the person marked: the confirmation moment is the start that is always known.
    expect(basis.effectiveFrom?.toISOString()).toBe(
      record.markedGenericAt.toISOString(),
    );
  });

  test("a historical basis carries its closed window and the correction link", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const startedAt = clock();
    const { record: original } = await preferences.confirmGenericPreference(
      scope,
      { content: `例会在周五 ${run}` },
    );
    const correctionAt = new Date(startedAt.getTime() + 7 * DAY);
    const { record: successor, superseded } =
      await preferences.correctGenericPreference(scope, original.id, {
        content: `例会改到下周一 ${run}`,
        effectiveFrom: correctionAt,
      });
    simulatedNow = new Date(startedAt.getTime() + 14 * DAY);
    // The historical answer cited the OLD fact; expanding it shows the window and the link.
    answerUserBankHits([preferenceDocumentIdFor(TENANT, original.id)]);
    const answer = await preferences.recallGenericPreferences(scope, {
      query: "例会",
      asOf: new Date(startedAt.getTime() + 3 * DAY).toISOString(),
    });
    expect(answer.map((item) => item.id)).toEqual([original.id]);
    const bases = await evidence.inspectEvidence(scope, {
      ids: [original.id, successor.id],
    });
    expect(bases[0]).toMatchObject({
      state: "available",
      kind: "preference",
      id: original.id,
      content: `例会在周五 ${run}`,
      effectiveUntil: correctionAt,
      supersededBy: successor.id,
      supersededTimeUnknown: false,
    });
    expect(bases[1]).toMatchObject({
      state: "available",
      kind: "preference",
      id: successor.id,
      effectiveFrom: correctionAt,
      supersededBy: null,
    });
    expect(superseded.id).toBe(original.id);
  });

  test("a source-bound basis shows provenance, the restriction and its formation time", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `团队 A 的风险排序 ${run}`,
      provenance: `项目频道 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    answerBankHits(TEAM_BANK_A, [sourceBoundDocumentIdFor(TENANT, record.id)]);
    const answer = await facade.recallSourceBoundMemories(scope, {
      query: "风险",
    });
    expect(answer.memories.map((item) => item.id)).toEqual([record.id]);

    const [basis] = await evidence.inspectEvidence(scope, { ids: [record.id] });
    expect(basis).toMatchObject({
      state: "available",
      kind: "source_bound",
      id: record.id,
      content: `团队 A 的风险排序 ${run}`,
      provenance: `项目频道 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
      actions: ["edit", "forget"],
    });
    if (basis.state !== "available" || basis.kind !== "source_bound") {
      throw new Error("expected an available source-bound basis");
    }
    expect(basis.formedAt instanceof Date).toBe(true);
  });

  test("the evidence contract carries no bank, no document id and no sync state", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `契约面事实 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    const [basis] = await evidence.inspectEvidence(scope, { ids: [record.id] });
    const serialized = JSON.stringify(basis);
    expect(serialized.includes("ob_")).toBe(false);
    expect(serialized.includes("hsb_")).toBe(false);
    expect(serialized.includes("hgp_")).toBe(false);
    expect(serialized.includes("synced")).toBe(false);
  });
});

describe("Hindsight 10 (#387): currently unauthorized sources do not leak", () => {
  test("a disabled source answers unavailable, with nothing of itself in the payload", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `来源撤权后的依据 ${run}`,
      provenance: `已停用来源 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    try {
      const [basis] = await evidence.inspectEvidence(scope, {
        ids: [record.id],
      });
      expect(basis).toEqual({ state: "unavailable", id: record.id });
      // Not the content, not the provenance, not the source id — nowhere.
      const serialized = JSON.stringify(basis);
      expect(serialized.includes(SOURCE_ONE)).toBe(false);
      expect(serialized.includes(`来源撤权后的依据 ${run}`)).toBe(false);
      expect(serialized.includes("已停用来源")).toBe(false);
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });

  test("a team A fact opened from a team B context is unavailable", async () => {
    const scopeA = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scopeA, {
      content: `团队边界依据 ${run}`,
      restriction: { kind: "team", workspaceId: WORKSPACE_A },
    });
    const scopeB = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_B);
    const [fromB] = await evidence.inspectEvidence(scopeB, {
      ids: [record.id],
    });
    expect(fromB).toEqual({ state: "unavailable", id: record.id });
    const [fromA] = await evidence.inspectEvidence(scopeA, {
      ids: [record.id],
    });
    expect(fromA.state).toBe("available");
  });

  test("a Bot-restricted basis is unavailable once the Bot loses its app", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `Bot 依据 ${run}`,
      restriction: { kind: "bot", agentId: BOT_ONE },
    });
    const [before] = await evidence.inspectEvidence(scope, {
      ids: [record.id],
    });
    expect(before.state).toBe("available");
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, BOT_ONE));
    try {
      const [after] = await evidence.inspectEvidence(scope, {
        ids: [record.id],
      });
      expect(after).toEqual({ state: "unavailable", id: record.id });
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, BOT_ONE));
    }
  });
});

describe("Hindsight 10 (#387): the evidence entry corrects and forgets", () => {
  test("editing a preference basis changes the NEXT answer's content", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await preferences.confirmGenericPreference(scope, {
      content: `编辑前的偏好 ${run}`,
    });
    await evidence.editEvidence(scope, record.id, {
      content: `编辑后的偏好 ${run}`,
    });
    answerUserBankHits([preferenceDocumentIdFor(TENANT, record.id)]);
    const answer = await facade.recallGenericPreferences(scope, {
      query: "偏好",
    });
    expect(answer.memories.map((item) => item.content)).toEqual([
      `编辑后的偏好 ${run}`,
    ]);
  });

  test("correcting a preference basis re-answers current and historical questions", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const startedAt = clock();
    const { record } = await preferences.confirmGenericPreference(scope, {
      content: `更正前的事实 ${run}`,
    });
    const correctionAt = new Date(startedAt.getTime() + 7 * DAY);
    const { record: successor } = await evidence.correctEvidence(
      scope,
      record.id,
      {
        content: `更正后的事实 ${run}`,
        effectiveFrom: correctionAt,
      },
    );
    simulatedNow = new Date(startedAt.getTime() + 14 * DAY);
    answerUserBankHits([
      preferenceDocumentIdFor(TENANT, record.id),
      preferenceDocumentIdFor(TENANT, successor.id),
    ]);
    const current = await preferences.recallGenericPreferences(scope, {
      query: "更正",
    });
    expect(current.map((item) => item.content)).toEqual([
      `更正后的事实 ${run}`,
    ]);
    const historical = await preferences.recallGenericPreferences(scope, {
      query: "更正",
      asOf: new Date(startedAt.getTime() + 3 * DAY).toISOString(),
    });
    expect(historical.map((item) => item.content)).toEqual([
      `更正前的事实 ${run}`,
    ]);
  });

  test("a source-bound fact is corrected by editing; window corrections are refused", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `来源事实原文 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    await expect(
      evidence.correctEvidence(scope, record.id, {
        content: `不该出现 ${run}`,
        effectiveFrom: new Date("2026-10-18T00:00:00.000Z"),
      }),
    ).rejects.toThrow("source-bound fact is corrected by editing");
    await evidence.editEvidence(scope, record.id, {
      content: `来源事实修订 ${run}`,
    });
    // The edit re-asserts into the restriction's bank, never the user bank.
    const retains = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    );
    expect(retains.length).toBeGreaterThan(0);
    expect(retains.every((call) => call.bank === SOURCE_BANK_ONE)).toBe(true);
    answerBankHits(SOURCE_BANK_ONE, [
      sourceBoundDocumentIdFor(TENANT, record.id),
    ]);
    const answer = await facade.recallSourceBoundMemories(scope, {
      query: "来源事实",
    });
    expect(answer.memories.map((item) => item.content)).toEqual([
      `来源事实修订 ${run}`,
    ]);
  });

  test("editing a basis whose restriction went out of scope is refused", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await sourceBound.confirmSourceBoundMemory(scope, {
      content: `失权后的编辑 ${run}`,
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false })
      .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    try {
      await expect(
        evidence.editEvidence(scope, record.id, { content: `失权修订 ${run}` }),
      ).rejects.toThrow("not currently authorized");
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true })
        .where(eq(hindsightMemoryGrants.targetId, SOURCE_ONE));
    }
  });

  test("forgetting removes the basis from every next answer, degraded included", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record: preferenceRecord } =
      await preferences.confirmGenericPreference(scope, {
        content: `将被遗忘的偏好 ${run}`,
      });
    const { record: boundRecord } = await sourceBound.confirmSourceBoundMemory(
      scope,
      {
        content: `将被遗忘的来源事实 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE_ONE },
      },
    );
    await evidence.forgetEvidence(scope, preferenceRecord.id);
    await evidence.forgetEvidence(scope, boundRecord.id);
    // The remote document delete went out under the row's own bank attribution.
    const deletes = scripted.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.bank).sort()).toEqual(
      [USER_BANK, SOURCE_BANK_ONE].sort(),
    );

    // The next indexed answer drops both, even handed their document ids.
    answerUserBankHits([preferenceDocumentIdFor(TENANT, preferenceRecord.id)]);
    answerBankHits(SOURCE_BANK_ONE, [
      sourceBoundDocumentIdFor(TENANT, boundRecord.id),
    ]);
    const indexed = await facade.recallGenericPreferences(scope, {
      query: "遗忘",
    });
    expect(indexed.memories).toEqual([]);
    const indexedBound = await facade.recallSourceBoundMemories(scope, {
      query: "遗忘",
    });
    expect(indexedBound.memories).toEqual([]);

    // The degraded answer drops them too: the tombstone outranks any index hit.
    scripted.state.recallByBank.clear();
    const degradedServiceConfig = {
      apiUrl: "http://127.0.0.1:9",
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 300,
    };
    const deadFacade = createDegradedRecallFacade(
      createPreferenceRecallService(
        createDrizzlePreferenceRecords(database),
        degradedServiceConfig,
      ),
      createSourceBoundRecallService(
        createDrizzleSourceBoundRecords(database),
        createDrizzleSourceBoundAuthorizations(database),
        degradedServiceConfig,
      ),
      createDrizzleDegradedPreferenceSearch(database),
      createDrizzleDegradedSourceBoundSearch(database),
      createDrizzleSourceBoundAuthorizations(database),
    );
    const degraded = await deadFacade.recallGenericPreferences(scope, {
      query: "将被遗忘的偏好",
    });
    expect(degraded.degraded).toBe(true);
    expect(degraded.memories).toEqual([]);
    const degradedBound = await deadFacade.recallSourceBoundMemories(scope, {
      query: "将被遗忘的来源事实",
    });
    expect(degradedBound.memories).toEqual([]);

    // And the evidence itself now says unavailable, with nothing inside.
    const bases = await evidence.inspectEvidence(scope, {
      ids: [preferenceRecord.id, boundRecord.id],
    });
    expect(bases).toEqual([
      { state: "unavailable", id: preferenceRecord.id },
      { state: "unavailable", id: boundRecord.id },
    ]);
  });

  test("another principal cannot operate a basis they do not own", async () => {
    const employeeScope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const { record } = await preferences.confirmGenericPreference(
      employeeScope,
      { content: `员工私有依据 ${run}` },
    );
    const adminScope = await makeTrustedScope(PRINCIPAL_ADMIN, WORKSPACE_A);
    await expect(
      evidence.inspectEvidence(adminScope, { ids: [record.id] }),
    ).resolves.toEqual([{ state: "unavailable", id: record.id }]);
    await expect(
      evidence.forgetEvidence(adminScope, record.id),
    ).rejects.toThrow(EvidenceNotFoundError);
    await expect(
      evidence.editEvidence(adminScope, record.id, { content: "not yours" }),
    ).rejects.toThrow(EvidenceNotFoundError);
  });
});

describe("Hindsight 10 (#387): missing or unmapped bases are clearly unavailable", () => {
  test("an id with no row answers unavailable, with only the id in the payload", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const orphan = randomUUID();
    const [basis] = await evidence.inspectEvidence(scope, { ids: [orphan] });
    expect(basis).toEqual({ state: "unavailable", id: orphan });
    expect(Object.keys(basis).sort()).toEqual(["id", "state"]);
  });

  test("malformed inspection requests are refused, not emptied", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    await expect(evidence.inspectEvidence(scope, { ids: [] })).rejects.toThrow(
      "non-empty array",
    );
    await expect(
      evidence.inspectEvidence(scope, { ids: "not-an-array" }),
    ).rejects.toThrow("non-empty array");
    await expect(
      evidence.inspectEvidence(scope, { ids: [42] }),
    ).rejects.toThrow("Evidence ids must be strings");
  });
});
