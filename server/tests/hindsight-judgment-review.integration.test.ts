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
import { derivedJudgmentCandidates } from "../src/db/schema/hindsight-judgments";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import { hindsightMemoryGrants } from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { createAnswerEvidenceService } from "../src/hindsight/answer-evidence";
import { teamBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  createDerivedJudgmentService,
  createDrizzleDerivedJudgmentRecords,
  DerivedJudgmentRefusedError,
  derivedJudgmentDocumentIdFor,
} from "../src/hindsight/derived-judgments";
import {
  createDerivedJudgmentReviewService,
  DerivedJudgmentNotFoundError,
  DerivedJudgmentReviewRefusedError,
} from "../src/hindsight/judgment-review";
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
 * Hindsight 12 (#389), integration layer: the person's review of derived judgment candidates
 * and the confirmed judgment's use, over the real authority tables, the real tenancy tables
 * and a scripted Hindsight service.
 *
 * One describe per acceptance clause, plus the lifecycle block the ticket names
 * (confirm/edit/reject/expire) and the evidence-chain block the answer path rides on:
 *
 * 1. Confirmed and edited judgments recall — into their own bank, out of the banks the asking
 *    context is authorized for — while every basis still stands; a rejected judgment never
 *    enters Bot context, even when the scripted service hands its document id back as a hit.
 * 2. The review surface carries the judgment text and its complete basis, and an edit mutates
 *    the text alone: the evidence relation, provenance and scope survive an edit untouched,
 *    and editing is refused while the basis is dead.
 * 3. Any basis later forgotten, de-authorized or deleted stops the judgment immediately —
 *    including a confirmed JUDGEMENT used as the basis of a next-level judgment — and the
 *    judgment returns by itself when the authority returns.
 *
 * The scripted service records every call (retain, recall, delete), so "nothing was sent" and
 * "the delete was attempted" are both observable. Scopes are minted the production way, and
 * revocations are real rows: a disabled grant or a suspended membership is a genuine loss of
 * authority, not a mock's flag.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_review-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const PRINCIPAL_EMP = `prin_employee-${run}`;
const PRINCIPAL_ADMIN = `prin_admin-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_connected-1-${run}`;
const BOT_ONE = `agt_bot-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

const TEAM_BANK_A = teamBankFor(WORKSPACE_A);
const TEAM_BANK_B = teamBankFor(WORKSPACE_B);
const USER_BANK_EMP = userBankFor(PRINCIPAL_EMP);
const USER_BANK_ADMIN = userBankFor(PRINCIPAL_ADMIN);

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  bank: string;
};

type ScriptedRecallAnswer = { status: number; body: unknown };

type ScriptedState = {
  recallByBank: Map<string, ScriptedRecallAnswer>;
  retainStatus: number;
  deleteStatus: number;
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let proposals: ReturnType<typeof createDerivedJudgmentService>;
let review: ReturnType<typeof createDerivedJudgmentReviewService>;
let evidence: ReturnType<typeof createAnswerEvidenceService>;
let serviceConfig: {
  apiUrl: string;
  serviceApiKey: string;
  assertionSecret: string;
  requestTimeoutMs: number;
};
let authorizations: ReturnType<typeof createDrizzleSourceBoundAuthorizations>;

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
    deleteStatus: 204,
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
      calls.push({ method: request.method ?? "", path, body, bank });
      let status = 404;
      let payload: unknown = { error: "scripted: no route" };
      if (request.method === "POST" && path.endsWith("/memories")) {
        status = state.retainStatus;
        payload = { accepted: 1 };
      } else if (
        request.method === "POST" &&
        path.endsWith("/memories/recall")
      ) {
        const answer = state.recallByBank.get(bank);
        status = answer?.status ?? 404;
        payload = answer?.body ?? { results: [] };
      } else if (
        request.method === "DELETE" &&
        /\/documents\/[^/]+$/.test(path)
      ) {
        status = state.deleteStatus;
        payload = { deleted: true };
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

// The controlled-directory technique from hindsight-derived-judgments.integration.test.ts:
// a drizzle-shaped database good enough for the capability probe and the membership select,
// so the minted scope carries the real issuedScopes trust marker.
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
  // The attribution chain the foreign keys demand, plus the grant registry rows the
  // authorization store reads. The employee sits in BOTH teams and holds a source and a Bot;
  // the admin shares only team A (their scope must never resolve the employee's judgments).
  await database.insert(users).values([
    { id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` },
    { id: `usr_admin-${run}`, email: `admin-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Review ${run}` }]);
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
  serviceConfig = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  };
  const preferenceRecords = createDrizzlePreferenceRecords(database);
  const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
  authorizations = createDrizzleSourceBoundAuthorizations(database);
  const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
  preferences = createPreferenceRecallService(preferenceRecords, serviceConfig);
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
  );
  proposals = createDerivedJudgmentService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
  );
  // The queue is the durable drain behind the confirm; wiring it in here is the production
  // shape (confirm records work, the queue drains it later).
  const queue = createHindsightSyncQueue(database, serviceConfig, {
    authorizations,
  });
  review = createDerivedJudgmentReviewService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    serviceConfig,
    { work: queue },
  );
  evidence = createAnswerEvidenceService(
    preferences,
    scoped,
    preferenceRecords,
    sourceBoundRecords,
    authorizations,
    review,
  );
});

afterAll(async () => {
  if (!scripted) return;
  // Complete every pending work row this suite's confirms recorded (successful eager retains
  // leave their work pending), so the shared test database never hands another suite's drain
  // a straggler that would tilt its exact-count assertions.
  scripted.state.retainStatus = 202;
  await createHindsightSyncQueue(database, serviceConfig, {
    authorizations,
  }).drain({ limit: 500 });
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.state.recallByBank.clear();
  scripted.state.retainStatus = 202;
  scripted.state.deleteStatus = 204;
});

async function employeeScope(
  workspaceId = WORKSPACE_A,
): Promise<PlatformScope> {
  return makeTrustedScope(PRINCIPAL_EMP, workspaceId);
}

async function adminScope(workspaceId = WORKSPACE_A): Promise<PlatformScope> {
  return makeTrustedScope(PRINCIPAL_ADMIN, workspaceId);
}

async function confirmPreference(
  scope: PlatformScope,
  content: string,
): Promise<string> {
  const { record } = await preferences.confirmGenericPreference(scope, {
    content,
  });
  return preferenceDocumentIdFor(TENANT, record.id);
}

async function confirmBound(
  scope: PlatformScope,
  content: string,
  restriction: unknown,
): Promise<string> {
  const { record } = await scoped.confirmSourceBoundMemory(scope, {
    content,
    restriction,
  });
  return sourceBoundDocumentIdFor(TENANT, record.id);
}

/** Propose a general-scope candidate over two fresh confirmed preferences. */
async function proposeGeneralCandidate(
  scope: PlatformScope,
  judgment: string,
): Promise<{ id: string; basis: [string, string] }> {
  const first = await confirmPreference(scope, `依据甲 ${judgment}`);
  const second = await confirmPreference(scope, `依据乙 ${judgment}`);
  const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
    judgment,
    evidence: [first, second],
  });
  return { id: candidate.id, basis: [first, second] };
}

/** Propose a team-A candidate over two fresh confirmed team-A facts. */
async function proposeTeamCandidate(
  scope: PlatformScope,
  judgment: string,
): Promise<{ id: string; basis: [string, string] }> {
  const first = await confirmBound(scope, `团队依据甲 ${judgment}`, {
    kind: "team",
    workspaceId: WORKSPACE_A,
  });
  const second = await confirmBound(scope, `团队依据乙 ${judgment}`, {
    kind: "team",
    workspaceId: WORKSPACE_A,
  });
  const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
    judgment,
    evidence: [first, second],
  });
  return { id: candidate.id, basis: [first, second] };
}

function refusalOf(
  promise: Promise<unknown>,
): Promise<DerivedJudgmentRefusedError> {
  return promise.then(
    () => {
      throw new Error("expected the review act to be refused");
    },
    (error: unknown) => {
      if (!(error instanceof DerivedJudgmentRefusedError)) throw error;
      return error;
    },
  );
}

async function reviewRefusalOf(
  promise: Promise<unknown>,
): Promise<DerivedJudgmentReviewRefusedError> {
  return promise.then(
    () => {
      throw new Error("expected the review act to be refused");
    },
    (error: unknown) => {
      if (!(error instanceof DerivedJudgmentReviewRefusedError)) throw error;
      return error;
    },
  );
}

/** Teach the scripted service to hand these document ids back from one bank, ranked. */
function bankHits(bank: string, documentIds: string[]) {
  scripted.state.recallByBank.set(bank, {
    status: 200,
    body: {
      results: documentIds.map((document_id) => ({ document_id })),
    },
  });
}

async function setGrant(targetId: string, enabled: boolean) {
  await database
    .update(hindsightMemoryGrants)
    .set({ enabled })
    .where(eq(hindsightMemoryGrants.targetId, targetId));
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

async function judgmentRow(id: string) {
  const [row] = await database
    .select()
    .from(derivedJudgmentCandidates)
    .where(eq(derivedJudgmentCandidates.id, id))
    .limit(1);
  return row;
}

describe("Hindsight 12 (#389) lifecycle: confirm, edit, reject, expire", () => {
  test("confirming a candidate retains it into the user bank under its hdj_ identity", async () => {
    const scope = await employeeScope();
    const { id, basis } = await proposeGeneralCandidate(
      scope,
      `周报偏好综合判断 ${run}`,
    );
    scripted.calls.length = 0;
    const outcome = await review.confirmDerivedJudgment(scope, id);
    expect(outcome.remoteSynced).toBe(true);
    expect(outcome.judgment.reviewState).toBe("confirmed");
    expect(outcome.judgment.scope).toEqual({ kind: "general" });
    expect(outcome.judgment.evidence).toHaveLength(2);
    const documentId = derivedJudgmentDocumentIdFor(TENANT, id);
    const retain = scripted.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.endsWith("/memories") &&
        call.bank === USER_BANK_EMP,
    );
    expect(retain).toBeTruthy();
    expect(JSON.stringify(retain?.body)).toContain(documentId);
    expect(JSON.stringify(retain?.body)).toContain("replace");
    // Exactly one write left the process for the judgment's confirm — its own retain, into
    // the user bank and no other.
    expect(
      scripted.calls.filter((call) => call.method === "POST"),
    ).toHaveLength(1);
    const row = await judgmentRow(id);
    expect(row?.reviewState).toBe("confirmed");
    expect(row?.reviewedAt).not.toBeNull();
    expect(row?.syncedAt).not.toBeNull();
    expect(basis).toHaveLength(2);
  });

  test("a team judgment retains into the team bank and recalls only from its own workspace", async () => {
    const scopeA = await employeeScope(WORKSPACE_A);
    const { id } = await proposeTeamCandidate(scopeA, `团队综合判断 ${run}`);
    scripted.calls.length = 0;
    const outcome = await review.confirmDerivedJudgment(scopeA, id);
    expect(outcome.remoteSynced).toBe(true);
    const retain = scripted.calls.find((call) => call.method === "POST");
    expect(retain?.bank).toBe(TEAM_BANK_A);
    // Asking from team A recalls it…
    const documentId = derivedJudgmentDocumentIdFor(TENANT, id);
    bankHits(TEAM_BANK_A, [documentId]);
    const fromA = await review.recallDerivedJudgments(scopeA, {
      query: `团队判断 ${run}`,
    });
    expect(fromA.map((item) => item.id)).toContain(id);
    // …asking from team B does not, even though the (buggy or hostile) service hands the
    // document id back in team B's bank too: defense in depth drops it.
    const scopeB = await employeeScope(WORKSPACE_B);
    bankHits(TEAM_BANK_B, [documentId]);
    const fromB = await review.recallDerivedJudgments(scopeB, {
      query: `团队判断 ${run}`,
    });
    expect(fromB.map((item) => item.id)).not.toContain(id);
  });

  test("a confirm whose evidence died is refused with its reason and changes nothing", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `失权确认依据一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `失权确认依据二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `失权后确认判断 ${run}`,
      evidence: [first, second],
    });
    await setGrant(SOURCE_ONE, false);
    try {
      scripted.calls.length = 0;
      const error = await refusalOf(
        review.confirmDerivedJudgment(scope, candidate.id),
      );
      expect(error.reason).toBe("unauthorized-evidence");
      const row = await judgmentRow(candidate.id);
      expect(row?.reviewState).toBe("unreviewed");
      expect(
        scripted.calls.filter((call) => call.method === "POST"),
      ).toHaveLength(0);
    } finally {
      await setGrant(SOURCE_ONE, true);
    }
  });

  test("confirming twice is refused: only an unreviewed candidate can be confirmed", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `二次确认判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    await reviewRefusalOf(review.confirmDerivedJudgment(scope, id));
  });

  test("editing as the review act adopts the candidate with the new text, basis untouched", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `编辑审核判断 ${run}`);
    const before = await judgmentRow(id);
    scripted.calls.length = 0;
    const outcome = await review.editDerivedJudgment(scope, id, {
      content: `编辑后的判断文本 ${run}`,
    });
    expect(outcome.judgment.content).toBe(`编辑后的判断文本 ${run}`);
    expect(outcome.judgment.reviewState).toBe("edited");
    expect(outcome.judgment.reviewedAt).not.toBeNull();
    const after = await judgmentRow(id);
    // The text changed; nothing else did — provenance, scope and the evidence relation stay.
    expect(after?.content).toBe(`编辑后的判断文本 ${run}`);
    expect(after?.provenance).toBe(before?.provenance);
    expect(after?.scopeKind).toBe(before?.scopeKind);
    expect(after?.reviewState).toBe("edited");
    // The edited text was retained under the SAME document identity (replace, user bank).
    const documentId = derivedJudgmentDocumentIdFor(TENANT, id);
    const retain = scripted.calls.find(
      (call) => call.method === "POST" && call.bank === USER_BANK_EMP,
    );
    expect(JSON.stringify(retain?.body)).toContain(documentId);
    expect(JSON.stringify(retain?.body)).toContain("编辑后的判断文本");
  });

  test("an edited judgment recalls with its edited text and unchanged citations", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `编辑召回判断 ${run}`);
    const outcome = await review.editDerivedJudgment(scope, id, {
      content: `风险优先的周报判断 ${run}`,
    });
    const citationsBefore = outcome.judgment.evidence.map((item) => item.id);
    bankHits(USER_BANK_EMP, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(scope, {
      query: `周报判断 ${run}`,
    });
    const mine = recalled.find((item) => item.id === id);
    expect(mine?.content).toBe(`风险优先的周报判断 ${run}`);
    expect(mine?.reviewState).toBe("edited");
    expect(mine?.evidence.map((item) => item.id)).toEqual(citationsBefore);
    expect(mine?.evidence.every((item) => item.kind === "preference")).toBe(
      true,
    );
  });

  test("rejecting an unreviewed candidate makes no remote call and never recalls", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `拒绝候选判断 ${run}`);
    scripted.calls.length = 0;
    const outcome = await review.rejectDerivedJudgment(scope, id);
    expect(outcome.reviewState).toBe("rejected");
    expect(scripted.calls).toHaveLength(0);
    // Even a hostile index hit cannot surface it: the row fails the review gate.
    bankHits(USER_BANK_EMP, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(scope, {
      query: `拒绝判断 ${run}`,
    });
    expect(recalled.map((item) => item.id)).not.toContain(id);
    // Rejecting twice is the same decision.
    const again = await review.rejectDerivedJudgment(scope, id);
    expect(again.reviewState).toBe("rejected");
  });

  test("rejecting a confirmed judgment attempts the remote delete and stops recall", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `拒绝确认判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    scripted.calls.length = 0;
    const outcome = await review.rejectDerivedJudgment(scope, id);
    expect(outcome.reviewState).toBe("rejected");
    const remove = scripted.calls.find((call) => call.method === "DELETE");
    expect(remove?.bank).toBe(USER_BANK_EMP);
    expect(remove?.path).toContain(derivedJudgmentDocumentIdFor(TENANT, id));
    bankHits(USER_BANK_EMP, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(scope, {
      query: `拒绝判断 ${run}`,
    });
    expect(recalled.map((item) => item.id)).not.toContain(id);
  });

  test("a stale unreviewed candidate expires after thirty days and leaves the surface", async () => {
    const scope = await employeeScope();
    const stale = await proposeGeneralCandidate(scope, `过期候选判断 ${run}`);
    // A review service whose clock runs thirty-one days ahead: the sweep it runs expires
    // everything proposed before its cutoff, which by then includes this candidate.
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const later = createDerivedJudgmentReviewService(
      createDrizzlePreferenceRecords(database),
      createDrizzleSourceBoundRecords(database),
      createDrizzleDerivedJudgmentRecords(database),
      createDrizzleSourceBoundAuthorizations(database),
      {
        apiUrl: scripted.url,
        serviceApiKey: SERVICE_KEY,
        assertionSecret: SECRET,
        requestTimeoutMs: 2000,
      },
      { now: () => future },
    );
    const sweep = await later.expireStaleDerivedJudgmentCandidates();
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    expect((await judgmentRow(stale.id))?.reviewState).toBe("expired");
    // Gone from the review surface…
    const listed = await proposals.listDerivedJudgmentCandidates(scope);
    expect(listed.map((item) => item.id)).not.toContain(stale.id);
    // …and editing an expired candidate is refused; only a fresh derivation can come back.
    await reviewRefusalOf(
      review.editDerivedJudgment(scope, stale.id, {
        content: `过期后编辑 ${run}`,
      }),
    );
    // A replayed lead produces a FRESH candidate rather than folding into the expired row.
    const [first, second] = stale.basis;
    const reborn = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `过期候选判断 ${run}`,
      evidence: [first, second],
    });
    expect(reborn.id).not.toBe(stale.id);
    // A confirmed judgment never expires: sweep again, the reborn row survives confirmed.
    await review.confirmDerivedJudgment(scope, reborn.id);
    await later.expireStaleDerivedJudgmentCandidates();
    expect((await judgmentRow(reborn.id))?.reviewState).toBe("confirmed");
  });

  test("the sync queue drains a confirm whose eager retain failed", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(
      scope,
      `排队补同步判断 ${run}`,
    );
    scripted.state.retainStatus = 500;
    const failed = await review.confirmDerivedJudgment(scope, id);
    expect(failed.remoteSynced).toBe(false);
    expect((await judgmentRow(id))?.syncedAt).toBeNull();
    scripted.state.retainStatus = 202;
    const report = await createHindsightSyncQueue(
      database,
      {
        apiUrl: scripted.url,
        serviceApiKey: SERVICE_KEY,
        assertionSecret: SECRET,
        requestTimeoutMs: 2000,
      },
      { authorizations: createDrizzleSourceBoundAuthorizations(database) },
    ).drain();
    expect(report.synced).toBeGreaterThanOrEqual(1);
    const row = await judgmentRow(id);
    expect(row?.syncedAt).not.toBeNull();
    expect(row?.syncedContentDigest).toBeTruthy();
  });

  test("the queue buries pending work for a judgment rejected after its confirm", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(
      scope,
      `确认后拒绝排队判断 ${run}`,
    );
    scripted.state.retainStatus = 500;
    await review.confirmDerivedJudgment(scope, id);
    await review.rejectDerivedJudgment(scope, id);
    scripted.state.retainStatus = 202;
    // The only trace of the failed eager attempt is below this line's window: what the drain
    // does next must not contain the judgment's document anywhere.
    scripted.calls.length = 0;
    const report = await createHindsightSyncQueue(
      database,
      {
        apiUrl: scripted.url,
        serviceApiKey: SERVICE_KEY,
        assertionSecret: SECRET,
        requestTimeoutMs: 2000,
      },
      { authorizations: createDrizzleSourceBoundAuthorizations(database) },
    ).drain();
    expect(report.nothingToDo).toBeGreaterThanOrEqual(1);
    expect(
      scripted.calls.some(
        (call) =>
          call.method === "POST" &&
          JSON.stringify(call.body ?? "").includes(
            derivedJudgmentDocumentIdFor(TENANT, id),
          ),
      ),
    ).toBe(false);
  });

  test("a foreign principal's scope never sees or reviews another person's judgment", async () => {
    const scope = await employeeScope();
    const admin = await adminScope();
    const { id } = await proposeGeneralCandidate(scope, `他人判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    bankHits(USER_BANK_ADMIN, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(admin, {
      query: `他人判断 ${run}`,
    });
    expect(recalled).toHaveLength(0);
    await expect(review.confirmDerivedJudgment(admin, id)).rejects.toThrow(
      DerivedJudgmentNotFoundError,
    );
  });
});

describe("Hindsight 12 (#389) AC1: recall bounded by every basis still standing", () => {
  test("a confirmed judgment recalls from its bank with its citations", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(
      scope,
      `召回主路径判断 ${run}`,
    );
    await review.confirmDerivedJudgment(scope, id);
    bankHits(USER_BANK_EMP, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(scope, {
      query: `主路径 ${run}`,
    });
    const mine = recalled.find((item) => item.id === id);
    expect(mine).toBeTruthy();
    expect(mine?.reviewState).toBe("confirmed");
    expect(mine?.scope).toEqual({ kind: "general" });
    expect(mine?.evidence).toHaveLength(2);
    expect(mine?.reviewedAt).toBeTruthy();
  });

  test("recall drops an unreviewed candidate's document id even when the index returns it", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(
      scope,
      `未审不召回判断 ${run}`,
    );
    bankHits(USER_BANK_EMP, [derivedJudgmentDocumentIdFor(TENANT, id)]);
    const recalled = await review.recallDerivedJudgments(scope, {
      query: `未审 ${run}`,
    });
    expect(recalled.map((item) => item.id)).not.toContain(id);
  });

  test("a suspended membership stops a team judgment's recall until it is restored", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const { id } = await proposeTeamCandidate(scope, `挂起停用判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    const documentId = derivedJudgmentDocumentIdFor(TENANT, id);
    bankHits(TEAM_BANK_A, [documentId]);
    await suspendMembership(WORKSPACE_A);
    try {
      const suspended = await review.recallDerivedJudgments(scope, {
        query: `停用 ${run}`,
      });
      expect(suspended.map((item) => item.id)).not.toContain(id);
    } finally {
      await restoreMembership(WORKSPACE_A);
    }
    const restored = await review.recallDerivedJudgments(scope, {
      query: `停用 ${run}`,
    });
    expect(restored.map((item) => item.id)).toContain(id);
  });
});

describe("Hindsight 12 (#389) AC2: the review shows all evidence; an edit widens nothing", () => {
  test("the confirm's view carries the judgment text and its complete basis", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `完整依据判断 ${run}`);
    const outcome = await review.confirmDerivedJudgment(scope, id);
    expect(outcome.judgment.content).toBe(`完整依据判断 ${run}`);
    for (const basis of outcome.judgment.evidence) {
      expect(basis.kind).toBe("preference");
      expect(basis.content).toContain(`依据`);
      expect(basis.provenance).toBeTruthy();
      expect(basis.markedGenericAt).toBeTruthy();
    }
  });

  test("an edit is refused while the basis is unauthorized, and the text survives", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `失权编辑依据一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `失权编辑依据二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `失权编辑判断 ${run}`,
      evidence: [first, second],
    });
    await setGrant(SOURCE_ONE, false);
    try {
      const error = await refusalOf(
        review.editDerivedJudgment(scope, candidate.id, {
          content: `失权后的编辑 ${run}`,
        }),
      );
      expect(error.reason).toBe("unauthorized-evidence");
      const row = await judgmentRow(candidate.id);
      expect(row?.content).toBe(`失权编辑判断 ${run}`);
      expect(row?.reviewState).toBe("unreviewed");
    } finally {
      await setGrant(SOURCE_ONE, true);
    }
  });

  test("a team judgment stays team-scoped through its edit: the retain re-enters the team bank", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const { id } = await proposeTeamCandidate(scope, `团队编辑判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    scripted.calls.length = 0;
    await review.editDerivedJudgment(scope, id, {
      content: `团队编辑后的文本 ${run}`,
    });
    const retain = scripted.calls.find((call) => call.method === "POST");
    expect(retain?.bank).toBe(TEAM_BANK_A);
    const row = await judgmentRow(id);
    expect(row?.scopeKind).toBe("team");
    expect(row?.workspaceId).toBe(WORKSPACE_A);
  });
});

describe("Hindsight 12 (#389) AC3: a dying basis stops the judgment immediately", () => {
  test("a forgotten preference basis drops the confirmed judgment from recall", async () => {
    const scope = await employeeScope();
    const { id, basis } = await proposeGeneralCandidate(
      scope,
      `遗忘停用判断 ${run}`,
    );
    await review.confirmDerivedJudgment(scope, id);
    const documentId = derivedJudgmentDocumentIdFor(TENANT, id);
    bankHits(USER_BANK_EMP, [documentId]);
    const before = await review.recallDerivedJudgments(scope, {
      query: `遗忘 ${run}`,
    });
    expect(before.map((item) => item.id)).toContain(id);
    // Forget one of the two basis preferences — the judgment loses a leg.
    const [preferenceDocument] = basis;
    const [preferenceRow] = await database
      .select({ id: genericPersonalPreferences.id })
      .from(genericPersonalPreferences)
      .where(
        eq(genericPersonalPreferences.hindsightDocumentId, preferenceDocument),
      )
      .limit(1);
    await preferences.forgetGenericPreference(scope, preferenceRow.id);
    const after = await review.recallDerivedJudgments(scope, {
      query: `遗忘 ${run}`,
    });
    expect(after.map((item) => item.id)).not.toContain(id);
  });

  test("a disabled source drops the confirmed judgment, and it returns with the authority", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `来源停用依据一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `来源停用依据二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `来源停用判断 ${run}`,
      evidence: [first, second],
    });
    await review.confirmDerivedJudgment(scope, candidate.id);
    const documentId = derivedJudgmentDocumentIdFor(TENANT, candidate.id);
    bankHits(USER_BANK_EMP, [documentId]);
    await setGrant(SOURCE_ONE, false);
    try {
      const dropped = await review.recallDerivedJudgments(scope, {
        query: `停用 ${run}`,
      });
      expect(dropped.map((item) => item.id)).not.toContain(candidate.id);
    } finally {
      await setGrant(SOURCE_ONE, true);
    }
    const returned = await review.recallDerivedJudgments(scope, {
      query: `停用 ${run}`,
    });
    expect(returned.map((item) => item.id)).toContain(candidate.id);
  });

  test("forgetting a confirmed JUDGMENT stops the next-level judgment built on it", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `上层判断依据一 ${run}`);
    const second = await confirmPreference(scope, `上层判断依据二 ${run}`);
    const lower = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `第一层已确认判断 ${run}`,
      evidence: [first, second],
    });
    await review.confirmDerivedJudgment(scope, lower.id);
    // A next-level judgment citing the confirmed judgment plus one more experience.
    const third = await confirmPreference(scope, `上层判断依据三 ${run}`);
    const upper = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `第二层判断 ${run}`,
      evidence: [third, derivedJudgmentDocumentIdFor(TENANT, lower.id)],
    });
    await review.confirmDerivedJudgment(scope, upper.id);
    const upperDocument = derivedJudgmentDocumentIdFor(TENANT, upper.id);
    bankHits(USER_BANK_EMP, [upperDocument]);
    const before = await review.recallDerivedJudgments(scope, {
      query: `第二层 ${run}`,
    });
    expect(before.map((item) => item.id)).toContain(upper.id);
    // The person forgets the LOWER judgment: the upper one's basis died with it.
    await review.forgetDerivedJudgment(scope, lower.id);
    const after = await review.recallDerivedJudgments(scope, {
      query: `第二层 ${run}`,
    });
    expect(after.map((item) => item.id)).not.toContain(upper.id);
  });
});

describe("Hindsight 12 (#389): the expandable evidence chain behind an answer", () => {
  test("a cited judgment expands into text, scope, adoption time and its full basis", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `链条依据一 ${run}`);
    const second = await confirmPreference(scope, `链条依据二 ${run}`);
    const lower = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `链条下层判断 ${run}`,
      evidence: [first, second],
    });
    await review.confirmDerivedJudgment(scope, lower.id);
    const third = await confirmPreference(scope, `链条依据三 ${run}`);
    const upper = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `链条上层判断 ${run}`,
      evidence: [third, derivedJudgmentDocumentIdFor(TENANT, lower.id)],
    });
    await review.confirmDerivedJudgment(scope, upper.id);
    const [expanded] = await evidence.inspectEvidence(scope, {
      ids: [upper.id],
    });
    if (
      expanded.state !== "available" ||
      expanded.kind !== "derived_judgment"
    ) {
      throw new Error(`expected the judgment to expand, got ${expanded.state}`);
    }
    expect(expanded.content).toBe(`链条上层判断 ${run}`);
    expect(expanded.reviewState).toBe("confirmed");
    expect(expanded.reviewedAt).toBeTruthy();
    expect(expanded.actions).toEqual(["edit", "forget"]);
    expect(expanded.evidence).toHaveLength(2);
    const [preferenceBasis, judgmentBasis] = expanded.evidence;
    if (preferenceBasis.kind !== "preference") {
      throw new Error("expected a preference basis first");
    }
    expect(preferenceBasis.content).toContain(`链条依据三`);
    // The nested judgment carries its own id — one level per request, never infinite.
    if (judgmentBasis.kind !== "derived_judgment") {
      throw new Error("expected a judgment basis second");
    }
    expect(judgmentBasis.id).toBe(lower.id);
    expect(judgmentBasis.content).toBe(`链条下层判断 ${run}`);
    expect("evidence" in judgmentBasis && judgmentBasis.evidence).toBeFalsy();
    // Expanding THAT id is the next request, and it works.
    const [lowerExpanded] = await evidence.inspectEvidence(scope, {
      ids: [lower.id],
    });
    expect(lowerExpanded.state).toBe("available");
    expect(lowerExpanded.kind).toBe("derived_judgment");
  });

  test("a judgment whose basis died expands to unavailable, with no reason leaked", async () => {
    const scope = await employeeScope();
    const { id, basis } = await proposeGeneralCandidate(
      scope,
      `失权链条判断 ${run}`,
    );
    await review.confirmDerivedJudgment(scope, id);
    const [preferenceDocument] = basis;
    const [preferenceRow] = await database
      .select({ id: genericPersonalPreferences.id })
      .from(genericPersonalPreferences)
      .where(
        eq(genericPersonalPreferences.hindsightDocumentId, preferenceDocument),
      )
      .limit(1);
    await preferences.forgetGenericPreference(scope, preferenceRow.id);
    const [expanded] = await evidence.inspectEvidence(scope, { ids: [id] });
    expect(expanded).toEqual({ state: "unavailable", id });
  });

  test("the chain's edit and forget act on the judgment through the seam", async () => {
    const scope = await employeeScope();
    const { id } = await proposeGeneralCandidate(scope, `链上操作判断 ${run}`);
    await review.confirmDerivedJudgment(scope, id);
    await evidence.editEvidence(scope, id, {
      content: `从依据链编辑后的判断 ${run}`,
    });
    const row = await judgmentRow(id);
    expect(row?.content).toBe(`从依据链编辑后的判断 ${run}`);
    expect(row?.reviewState).toBe("edited");
    await evidence.forgetEvidence(scope, id);
    const forgotten = await judgmentRow(id);
    expect(forgotten?.deletedAt).not.toBeNull();
    expect(forgotten?.content).toBe("");
    const [expanded] = await evidence.inspectEvidence(scope, { ids: [id] });
    expect(expanded.state).toBe("unavailable");
  });
});
