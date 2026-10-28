import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
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
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { sourceBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
import {
  createDerivedJudgmentService,
  createDrizzleDerivedJudgmentRecords,
  derivedJudgmentDocumentIdFor,
} from "../src/hindsight/derived-judgments";
import { createDerivedJudgmentReviewService } from "../src/hindsight/judgment-review";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import {
  createDrizzleRevocationLedger,
  STOPPED_USING_SUMMARY,
} from "../src/hindsight/revocation-ledger";
import { createRevocationService } from "../src/hindsight/revocation";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 13 (#390), integration layer: immediate blocking on forgetting and source
 * revocation, over the real authority tables, the real tenancy tables, the revocation ledger
 * and a scripted Hindsight service whose availability, latency and index staleness are all
 * injectable.
 *
 * One describe per acceptance clause, plus the backup-restore replay:
 *
 * 1. The block is durable BEFORE any remote deletion: a forget against an unreachable/slow
 *    service still stops every use at its own instant, and only the remote cleanup waits.
 * 2. A revoked source's originals AND dependent derived judgments never re-enter any entry —
 *    indexed recall with stale index hits, the SQL degradation path, and the sync queue's
 *    background retries — and re-enabling the grant does not resurrect them.
 * 3. The person-facing status is honest: "stopped being used" now, remote cleanup separate,
 *    never a claim that controlled copies are cleared.
 *
 * Stale-hit discipline: after a revocation the revoked bank itself is no longer asked, so the
 * stale index hits are scripted into banks that ARE still queried (the person's own bank, a
 * surviving source's bank) — the resurrection attempt arrives at the row re-load and dies
 * there, which is the defense the ticket demands.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_revoke-${run}`;
const WORKSPACE_A = `ws_rev-a-${run}`;
const PRINCIPAL_EMP = `prin_emp-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_revo-1-${run}`;
const SOURCE_TWO = `src_revo-2-${run}`;
const BOT_ONE = `agt_revo-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
/** Short enough that the scripted service's 3s stall reads as an outage, not a slow answer. */
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;

const USER_BANK = userBankFor(PRINCIPAL_EMP);
const SOURCE_BANK_ONE = sourceBankFor(SOURCE_ONE);
const SOURCE_BANK_TWO = sourceBankFor(SOURCE_TWO);

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  bank: string;
};

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  retainStatus: number;
  deleteStatus: number;
  /** > 0 stalls every response past the client timeout — the injected outage/delay. */
  stallMs: number;
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
let facade: ReturnType<typeof createDegradedRecallFacade>;
let revocations: ReturnType<typeof createRevocationService>;
let queue: ReturnType<typeof createHindsightSyncQueue>;
let serviceConfig: {
  apiUrl: string;
  serviceApiKey: string;
  assertionSecret: string;
  requestTimeoutMs: number;
};

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
    deleteStatus: 204,
    stallMs: 0,
  };
  const server = createServer((request, response) => {
    // Drain the request stream without buffering: "end" must fire for bodied requests, and
    // the scripted answers route on method and path alone.
    request.resume();
    request.on("end", () => {
      const path = request.url ?? "";
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      calls.push({ method: request.method ?? "", path, bank });
      const answer = () => {
        let status = 404;
        let payload: unknown = { error: "scripted: no route" };
        if (request.method === "POST" && path.endsWith("/memories")) {
          status = state.retainStatus;
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
          status = state.deleteStatus;
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
  return { server, url: `http://127.0.0.1:${address.port}`, calls, state };
}

// The controlled-directory technique from hindsight-judgment-review.integration.test.ts: a
// drizzle-shaped database good enough for the capability probe and the membership select, so
// the minted scope carries the real issuedScopes trust marker.
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
  await database
    .insert(users)
    .values([{ id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` }]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Revoke ${run}` }]);
  await database
    .insert(enterprisePrincipals)
    .values([{ id: PRINCIPAL_EMP, userId: `usr_emp-${run}` }]);
  await database
    .insert(enterpriseMemberships)
    .values([{ tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" }]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE_A, name: `Rev A ${run}` }]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_EMP,
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
      kind: "source",
      targetId: SOURCE_TWO,
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
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  const ledger = createDrizzleRevocationLedger(database);
  const preferenceRecords = createDrizzlePreferenceRecords(database);
  const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
  const authorizations = createDrizzleSourceBoundAuthorizations(database);
  const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
  preferences = createPreferenceRecallService(
    preferenceRecords,
    serviceConfig,
    {
      revocations: ledger,
    },
  );
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
    { revocations: ledger },
  );
  proposals = createDerivedJudgmentService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
  );
  review = createDerivedJudgmentReviewService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    serviceConfig,
    { revocations: ledger },
  );
  facade = createDegradedRecallFacade(
    preferences,
    scoped,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    authorizations,
  );
  revocations = createRevocationService(database, serviceConfig);
  queue = createHindsightSyncQueue(database, serviceConfig, {
    authorizations,
  });
});

afterAll(async () => {
  await scripted.server.close();
});

// The injected outage must never leak past a failing test: the stall flag is file-global.
afterEach(() => {
  scripted.state.stallMs = 0;
});

/** Confirm two source-bound facts in one source's restriction; returns their views. */
async function confirmTwoSourceBoundFacts(
  scope: PlatformScope,
  sourceId: string,
  contents: [string, string],
) {
  const first = await scoped.confirmSourceBoundMemory(scope, {
    content: contents[0],
    provenance: `revo-${run}`,
    restriction: { kind: "source", sourceId },
  });
  const second = await scoped.confirmSourceBoundMemory(scope, {
    content: contents[1],
    provenance: `revo-${run}`,
    restriction: { kind: "source", sourceId },
  });
  return { first: first.record, second: second.record };
}

describe("Hindsight 13 (#390) — immediate blocking", () => {
  test("AC1: forgetting a preference against an unreachable service stops every use at once; only the remote cleanup waits", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `meeting-notes-style-bullets-${run}`,
      provenance: "You",
    });
    expect(confirmed.remoteSynced).toBe(true);
    const documentId = preferenceDocumentIdFor(TENANT, confirmed.record.id);
    // The stale index: even after the block, the service keeps answering this document as a
    // hit — old index hits must not resurrect the blocked bytes.
    scripted.state.recallByBank.set(USER_BANK, {
      status: 200,
      body: { results: [{ document_id: documentId }] },
    });

    // The injected outage: every request now stalls past the client timeout.
    scripted.state.stallMs = STALL_MS;
    const status = await preferences.forgetGenericPreference(
      scope,
      confirmed.record.id,
    );
    // The honest two-part answer: stopped NOW (the block landed before any remote call could
    // complete), and the remote cleanup outstanding — never claimed cleared.
    expect(status.stoppedUsingAt instanceof Date).toBe(true);
    expect(status.remoteDeletion.attempted).toBe(false);
    expect(status.remoteDeletion.outstanding).toBe(1);
    expect(status.summary).toBe(STOPPED_USING_SUMMARY);
    expect(status.summary).not.toMatch(
      /all .*copies .*(cleared|purged|deleted)/i,
    );

    // The ledger row records the block and the unconfirmed deletion, for the retry drain.
    const [ledgerRow] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow.kind).toBe("memory");
    expect(ledgerRow.subjectType).toBe("preference");
    expect(ledgerRow.deletionState).toBe("failed");

    // Hindsight being down does not delay the stop: the indexed path cannot be asked, and the
    // SQL degradation it falls back to answers without the blocked bytes.
    const degraded = await facade.recallGenericPreferences(scope, {
      query: "meeting notes style",
    });
    expect(degraded.degraded).toBe(true);
    expect(degraded.memories).toEqual([]);

    // Service back: the retry drain completes the remote deletion, per document.
    scripted.state.stallMs = 0;
    const drained = await revocations.retryOutstandingDeletions({
      tenantId: TENANT,
    });
    expect(drained.confirmed).toBeGreaterThanOrEqual(1);
    const [after] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
    expect(after.deletionState).toBe("confirmed");
    // The stale index hit is dropped by the authority row: still nothing.
    const recalled = await facade.recallGenericPreferences(scope, {
      query: "meeting notes style",
    });
    expect(recalled.memories).toEqual([]);
  });

  test("AC2: revoking a source blocks its facts and dependent judgments everywhere, permanently, and the queue never resends them", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const sourceOne = await confirmTwoSourceBoundFacts(scope, SOURCE_ONE, [
      `revo-fact-alpha-${run}`,
      `revo-fact-beta-${run}`,
    ]);
    const sourceTwo = await confirmTwoSourceBoundFacts(scope, SOURCE_TWO, [
      `revo-fact-keep-a-${run}`,
      `revo-fact-keep-b-${run}`,
    ]);

    // A confirmed judgment over source one's facts — the dependent judgment the revocation
    // must block with its evidence; and a control judgment over source two's facts.
    const proposed = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `revo-judgment-src1-${run}`,
      provenance: "Hindsight",
      evidence: [
        sourceBoundDocumentIdFor(TENANT, sourceOne.first.id),
        sourceBoundDocumentIdFor(TENANT, sourceOne.second.id),
      ],
    });
    const adopted = await review.confirmDerivedJudgment(scope, proposed.id);
    expect(adopted.remoteSynced).toBe(true);
    const proposedControl = await proposals.proposeDerivedJudgmentCandidate(
      scope,
      {
        judgment: `revo-judgment-src2-${run}`,
        provenance: "Hindsight",
        evidence: [
          sourceBoundDocumentIdFor(TENANT, sourceTwo.first.id),
          sourceBoundDocumentIdFor(TENANT, sourceTwo.second.id),
        ],
      },
    );
    await review.confirmDerivedJudgment(scope, proposedControl.id);

    // Stale index hits, scripted into banks that stay queried after the revocation: the
    // person's own bank hands the revoked JUDGMENT's document back, and the surviving
    // source-two bank hands the revoked FACT's document back. Both must die at the row
    // re-load; only the genuinely live source-two fact survives.
    scripted.state.recallByBank.set(USER_BANK, {
      status: 200,
      body: {
        results: [
          { document_id: derivedJudgmentDocumentIdFor(TENANT, proposed.id) },
        ],
      },
    });
    scripted.state.recallByBank.set(SOURCE_BANK_TWO, {
      status: 200,
      body: {
        results: [
          // The revoked source-one fact, smuggled through the surviving bank.
          { document_id: sourceBoundDocumentIdFor(TENANT, sourceOne.first.id) },
          // The judgment whose evidence is revoked, likewise.
          {
            document_id: derivedJudgmentDocumentIdFor(TENANT, proposed.id),
          },
          // The one legitimate hit, and the control judgment's own document.
          {
            document_id: sourceBoundDocumentIdFor(TENANT, sourceTwo.first.id),
          },
          {
            document_id: derivedJudgmentDocumentIdFor(
              TENANT,
              proposedControl.id,
            ),
          },
        ],
      },
    });

    const status = await revocations.revokeAuthorizationTarget(scope, {
      kind: "source",
      targetId: SOURCE_ONE,
    });
    // The block covers the source's facts AND the dependent judgment — not source two.
    expect(status.blocked.sourceBoundMemories).toBe(2);
    expect(status.blocked.derivedJudgments).toBe(1);
    expect(status.stoppedUsingAt instanceof Date).toBe(true);
    expect(status.summary).toBe(STOPPED_USING_SUMMARY);

    // Every entry: web, channel and scheduled entries all arrive through these seams; the
    // SQL degradation is exercised through the facade with the service stalled.
    const scopedRecall = await facade.recallSourceBoundMemories(scope, {
      query: "revo fact",
    });
    expect(scopedRecall.memories.map((m) => m.content)).toEqual([
      sourceTwo.first.content,
    ]);
    const judgmentRecall = await review.recallDerivedJudgments(scope, {
      query: "revo judgment",
    });
    expect(judgmentRecall.map((j) => j.content)).toEqual([
      `revo-judgment-src2-${run}`,
    ]);
    scripted.state.stallMs = STALL_MS;
    const degradedScoped = await facade.recallSourceBoundMemories(scope, {
      query: "revo fact",
    });
    expect(degradedScoped.degraded).toBe(true);
    // The SQL fallback answers by text match over LIVE rows: both surviving source-two facts
    // match "revo fact"; the revoked source-one bytes appear in neither.
    expect(degradedScoped.memories.length).toBe(2);
    expect(degradedScoped.memories.map((m) => m.content).sort()).toEqual(
      [sourceTwo.first.content, sourceTwo.second.content].sort(),
    );
    scripted.state.stallMs = 0;

    // Re-enabling the grant must not resurrect the blocked bytes: the block lives on the
    // authority rows, not on the read-time authorization snapshot.
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true })
      .where(
        and(
          eq(hindsightMemoryGrants.tenantId, TENANT),
          eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP),
          eq(hindsightMemoryGrants.kind, "source"),
          eq(hindsightMemoryGrants.targetId, SOURCE_ONE),
        ),
      );
    const afterReEnable = await facade.recallSourceBoundMemories(scope, {
      query: "revo fact",
    });
    expect(afterReEnable.memories.map((m) => m.content)).toEqual([
      sourceTwo.first.content,
    ]);
    const judgmentsAfterReEnable = await review.recallDerivedJudgments(scope, {
      query: "revo judgment",
    });
    expect(judgmentsAfterReEnable.map((j) => j.content)).toEqual([
      `revo-judgment-src2-${run}`,
    ]);

    // The background retry: a pending sync-work row for a blocked subject drains with NO
    // retain into the revoked bank — the queue re-loads the row and finds nothing to send.
    await queue.record({
      subjectType: "source_bound",
      tenantId: TENANT,
      subjectId: sourceOne.first.id,
      principalId: PRINCIPAL_EMP,
      contentDigest: `deadbeef-${run}`,
    });
    const retainsIntoRevokedBank = () =>
      scripted.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path.endsWith("/memories") &&
          call.bank === SOURCE_BANK_ONE,
      ).length;
    const beforeDrain = retainsIntoRevokedBank();
    const report = await queue.drain({ limit: 200 });
    expect(retainsIntoRevokedBank()).toBe(beforeDrain);
    expect(report.nothingToDo).toBeGreaterThanOrEqual(1);
  });

  test("AC3: the status never claims controlled copies are cleared, before or after a confirmed deletion", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await scoped.confirmSourceBoundMemory(scope, {
      content: `status-honesty-fact-${run}`,
      provenance: "You",
      restriction: { kind: "bot", agentId: BOT_ONE },
    });
    expect(confirmed.remoteSynced).toBe(true);
    const status = await scoped.forgetSourceBoundMemory(
      scope,
      confirmed.record.id,
    );
    // Deletion confirmed by the service (204) — and STILL the status does not claim the
    // controlled copies are cleared: 2xx on one document is not that evidence (#14 owns it).
    expect(status.remoteDeletion.attempted).toBe(true);
    expect(status.remoteDeletion.outstanding).toBe(0);
    expect(status.summary).toBe(STOPPED_USING_SUMMARY);
    expect(status.summary).not.toMatch(/cleared|purged|all .*deleted/i);
    expect(Object.keys(status).sort()).toEqual(
      ["remoteDeletion", "stoppedUsingAt", "summary"].sort(),
    );
  });

  test("backup restore: replay re-applies the ledger's blocks and is idempotent", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const facts = await confirmTwoSourceBoundFacts(scope, SOURCE_TWO, [
      `replay-fact-one-${run}`,
      `replay-fact-two-${run}`,
    ]);
    // The bot revocation pins the kind='bot' wiring too (grant off, nothing to block).
    const botStatus = await revocations.revokeAuthorizationTarget(scope, {
      kind: "bot",
      targetId: BOT_ONE,
    });
    expect(botStatus.blocked).toEqual({
      sourceBoundMemories: 0,
      derivedJudgments: 0,
    });
    const revocation = await revocations.revokeAuthorizationTarget(scope, {
      kind: "source",
      targetId: SOURCE_TWO,
    });
    expect(revocation.blocked.sourceBoundMemories).toBeGreaterThanOrEqual(2);
    expect(revocation.blocked.derivedJudgments).toBeGreaterThanOrEqual(1);

    // The simulated restore: rows and grants come back alive from an older backup — including
    // every judgment row of this tenant.
    await database
      .update(sourceBoundMemories)
      .set({
        enabled: true,
        deletedAt: null,
        content: `resurrected-${run}`,
        syncedContentDigest: `restored-digest-${run}`,
        syncedAt: new Date(),
      })
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT),
          eq(sourceBoundMemories.id, facts.first.id),
        ),
      );
    await database
      .update(derivedJudgmentCandidates)
      .set({ enabled: true, deletedAt: null })
      .where(eq(derivedJudgmentCandidates.tenantId, TENANT));
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true })
      .where(
        and(
          eq(hindsightMemoryGrants.tenantId, TENANT),
          eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP),
          eq(hindsightMemoryGrants.kind, "source"),
          eq(hindsightMemoryGrants.targetId, SOURCE_TWO),
        ),
      );

    const replay = await revocations.replayRevocations({ tenantId: TENANT });
    expect(replay.reappliedMemoryBlocks).toBeGreaterThanOrEqual(0);
    expect(replay.reappliedAuthorizationBlocks).toBeGreaterThanOrEqual(1);

    // The resurrected row is blocked again, and the grant is off again.
    const [row] = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT),
          eq(sourceBoundMemories.id, facts.first.id),
        ),
      );
    expect(row.deletedAt).not.toBeNull();
    expect(row.content).toBe("");
    expect(row.enabled).toBe(false);
    const [grant] = await database
      .select()
      .from(hindsightMemoryGrants)
      .where(
        and(
          eq(hindsightMemoryGrants.tenantId, TENANT),
          eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP),
          eq(hindsightMemoryGrants.kind, "source"),
          eq(hindsightMemoryGrants.targetId, SOURCE_TWO),
        ),
      );
    expect(grant.enabled).toBe(false);

    // And recall stays closed on the restored-then-replayed state, stale hits included.
    const recalled = await facade.recallSourceBoundMemories(scope, {
      query: "resurrected",
    });
    expect(
      recalled.memories.filter((memory) => memory.id === facts.first.id),
    ).toEqual([]);

    // Idempotent: a second replay finds nothing to re-apply.
    const secondReplay = await revocations.replayRevocations({
      tenantId: TENANT,
    });
    expect(secondReplay.reappliedAuthorizationBlocks).toBe(0);
  });
});
