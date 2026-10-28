import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
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
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import { hindsightControlledBackups } from "../src/db/schema/hindsight-restore";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import { hindsightSyncWork } from "../src/db/schema/hindsight-sync";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { sourceBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  CONTROLLED_COPIES_CLEARED_SUMMARY,
  createCleanupEvidenceService,
  EXTERNAL_MODEL_LOGS_NOTE,
} from "../src/hindsight/cleanup-evidence";
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
import { createDrizzleRevocationLedger } from "../src/hindsight/revocation-ledger";
import { createRevocationService } from "../src/hindsight/revocation";
import { createRestoreRecoveryService } from "../src/hindsight/restore-recovery";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 14 (#391), integration layer: the remote-deletion evidence chain, the
 * backup-restore recovery gate, and the composed “受控副本清除完成” claim — over the real
 * authority tables, the real revocation ledger and a scripted Hindsight service whose
 * document / memory-unit / operation answers are all injectable per probe.
 *
 * One describe per acceptance clause:
 *
 * 1. The deletion task: a failed delete stays outstanding and the retry drain confirms it;
 *    the absence verification is an INDEPENDENT probe (document 404 AND its memory units
 *    empty), so a delete whose copy came back — or whose units outlived it — verifies
 *    present; and an old sync task cannot rebuild a forgotten document even when a restored
 *    backup has momentarily resurrected the authority row behind it.
 * 2. The backup-restore gate: an open restore marker closes every recall entry BEFORE any
 *    remote call (the SQL degradation path included — exactly the path whose rows a restore
 *    resurrects), and the ordered replay re-applies local blocks, re-issues remote deletions
 *    for CONFIRMED rows too (a Hindsight-side restore resurrects those), then reopens.
 *    Noting the same restore again dedups; a different restore opens its own gate.
 * 3. The cleanup claim: it appears only when active data, finished task payloads and
 *    controlled backups each hold ACTUAL evidence — an unverified confirmation, a terminal
 *    operation beyond the retention window, an empty backup registry, or an un-purged copy
 *    taken before the deletion each keep it off; external model logs stay a separate note.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_purge-${run}`;
const WORKSPACE_A = `ws_purge-a-${run}`;
const PRINCIPAL_EMP = `prin_emp-${run}`;
const PRINCIPAL_OTHER = `prin_other-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_purge-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;

const USER_BANK = userBankFor(PRINCIPAL_EMP);
const SOURCE_BANK_ONE = sourceBankFor(SOURCE_ONE);

type CapturedCall = { method: string; path: string; bank: string };

type ScriptedOperation = { created_at: string; status: string };

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  retainStatus: number;
  deleteStatus: number;
  /** > 0 stalls every response past the client timeout — the injected outage/delay. */
  stallMs: number;
  /** document id -> whether the service currently holds it (retain sets it, delete clears). */
  documents: Map<string, "present" | "absent">;
  /** document id -> extracted memory units the service still holds for it. */
  memoryUnits: Map<string, number>;
  /** bank id -> terminal-operation payloads the service still reports. */
  operationsByBank: Map<string, ScriptedOperation[]>;
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let review: ReturnType<typeof createDerivedJudgmentReviewService>;
let facade: ReturnType<typeof createDegradedRecallFacade>;
let revocations: ReturnType<typeof createRevocationService>;
let queue: ReturnType<typeof createHindsightSyncQueue>;
let recovery: ReturnType<typeof createRestoreRecoveryService>;
let evidence: ReturnType<typeof createCleanupEvidenceService>;
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
    documents: new Map(),
    memoryUnits: new Map(),
    operationsByBank: new Map(),
  };
  const server = createServer((request, response) => {
    // Buffer the body (retains carry the document id), then route on method and path.
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      calls.push({ method: request.method ?? "", path, bank });
      const body = Buffer.concat(chunks).toString("utf8");
      const answer = () => {
        let status = 404;
        let payload: unknown = { error: "scripted: no route" };
        if (request.method === "POST" && path.endsWith("/memories")) {
          status = state.retainStatus;
          payload = { accepted: 1 };
          if (status >= 200 && status < 300) {
            // The scripted pipeline: a retained document is held with one extracted unit,
            // and the retain leaves a terminal operation payload behind.
            const items = (
              JSON.parse(body || "{}") as {
                items?: { document_id?: string }[];
              }
            ).items;
            for (const item of items ?? []) {
              if (item.document_id) {
                state.documents.set(item.document_id, "present");
                state.memoryUnits.set(item.document_id, 1);
                const ops = state.operationsByBank.get(bank) ?? [];
                ops.push({
                  created_at: new Date().toISOString(),
                  status: "completed",
                });
                state.operationsByBank.set(bank, ops);
              }
            }
          }
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
          if (status >= 200 && status < 300) {
            // The cascade the real service performs: the document AND its units go.
            const documentId = decodeURIComponent(
              /\/documents\/([^/]+)$/.exec(path)?.[1] ?? "",
            );
            state.documents.set(documentId, "absent");
            state.memoryUnits.set(documentId, 0);
          }
        } else if (
          request.method === "GET" &&
          /\/documents\/[^/]+$/.test(path)
        ) {
          const documentId = decodeURIComponent(
            /\/documents\/([^/]+)$/.exec(path)?.[1] ?? "",
          );
          if (state.documents.get(documentId) === "present") {
            status = 200;
            payload = { original_text: `held-${documentId}` };
          } else {
            status = 404;
            payload = { detail: "Document not found" };
          }
        } else if (
          request.method === "GET" &&
          path.includes("/memories/list")
        ) {
          const documentId = decodeURIComponent(
            /[?&]document_id=([^&]+)/.exec(path)?.[1] ?? "",
          );
          const remaining = state.memoryUnits.get(documentId) ?? 0;
          status = 200;
          payload = {
            items: Array.from({ length: remaining }, (_, index) => ({
              id: randomUUID(),
              text: `unit-${index}`,
            })),
            total: remaining,
            limit: 100,
            offset: 0,
          };
        } else if (request.method === "GET" && path.includes("/operations")) {
          const statusFilter = /[?&]status=([^&]+)/.exec(path)?.[1];
          const ops = (state.operationsByBank.get(bank) ?? []).filter(
            (operation) =>
              statusFilter === undefined || operation.status === statusFilter,
          );
          status = 200;
          payload = {
            bank_id: bank,
            total: ops.length,
            limit: 100,
            offset: 0,
            operations: ops,
          };
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

// The controlled-directory technique from hindsight-revocation.integration.test.ts: a
// drizzle-shaped database good enough for the capability probe and the membership select.
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

const recallCalls = () =>
  scripted.calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/memories/recall"),
  ).length;

const deletesOfDocument = (documentId: string) =>
  scripted.calls.filter(
    (call) => call.method === "DELETE" && call.path.endsWith(`/${documentId}`),
  ).length;

const retainsIntoBank = (bank: string) =>
  scripted.calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path.endsWith("/memories") &&
      call.bank === bank,
  ).length;

beforeAll(async () => {
  await database.insert(users).values([
    { id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` },
    { id: `usr_other-${run}`, email: `other-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Purge ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: `usr_emp-${run}` },
    { id: PRINCIPAL_OTHER, userId: `usr_other-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_OTHER, role: "member" },
  ]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE_A, name: `Purge A ${run}` }]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_EMP,
    },
  ]);
  await database.insert(hindsightMemoryGrants).values({
    tenantId: TENANT,
    principalId: PRINCIPAL_EMP,
    kind: "source",
    targetId: SOURCE_ONE,
  });

  // The controlled-backup registry is global (a copy holds every company's banks); copies
  // left by earlier runs of this suite against the same database would be indistinguishable
  // from real un-purged evidence — and would legitimately block the claim. The suite owns
  // this table alone, so it clears its own artifacts before asserting absolutes.
  await database.delete(hindsightControlledBackups);
  // This suite's own ledger rows from earlier runs likewise accumulate: the restore replay
  // re-issues deletions for EVERY row in the table (a Hindsight restore is whole-database),
  // so stale tn_purge-* rows from prior runs would slow each rerun and muddy the drains'
  // counts. Other suites' rows (tn_revoke-*, tn_jreview-*, …) are not this suite's to touch.
  await database
    .delete(hindsightRevocations)
    .where(sql`${hindsightRevocations.tenantId} like ${`tn_purge-%`}`);

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
  revocations = createRevocationService(database, serviceConfig);
  recovery = createRestoreRecoveryService(database, revocations);
  preferences = createPreferenceRecallService(
    preferenceRecords,
    serviceConfig,
    {
      revocations: ledger,
      recovery: recovery.gate,
    },
  );
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
    { revocations: ledger, recovery: recovery.gate },
  );
  review = createDerivedJudgmentReviewService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    serviceConfig,
    { revocations: ledger, recovery: recovery.gate },
  );
  facade = createDegradedRecallFacade(
    preferences,
    scoped,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    authorizations,
  );
  queue = createHindsightSyncQueue(database, serviceConfig, { authorizations });
  evidence = createCleanupEvidenceService(database, serviceConfig);
});

afterAll(async () => {
  await scripted.server.close();
});

// The injected outage must never leak past a failing test; the stall flag is file-global.
afterEach(() => {
  scripted.state.stallMs = 0;
});

describe("Hindsight 14 (#391) — the deletion task and its evidence", () => {
  test("AC1: a failed delete stays outstanding, the retry drain confirms it, and the absence verification probes independently", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `purge-retry-marker-${run}`,
      provenance: "You",
    });
    expect(confirmed.remoteSynced).toBe(true);
    const documentId = preferenceDocumentIdFor(TENANT, confirmed.record.id);
    expect(scripted.state.documents.get(documentId)).toBe("present");

    // The outage: the delete cannot complete, but the block did.
    scripted.state.stallMs = STALL_MS;
    const status = await preferences.forgetGenericPreference(
      scope,
      confirmed.record.id,
    );
    expect(status.stoppedUsingAt instanceof Date).toBe(true);
    expect(status.remoteDeletion.outstanding).toBe(1);
    const [failedRow] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
    expect(failedRow.deletionState).toBe("failed");
    expect(failedRow.verifyState).toBe("unverified");

    // Service back: the retry drain confirms the delete — the deletion task's retry leg.
    scripted.state.stallMs = 0;
    const drained = await revocations.retryOutstandingDeletions({
      tenantId: TENANT,
    });
    expect(drained.confirmed).toBeGreaterThanOrEqual(1);

    // The verification sweep is a SECOND probe, not the delete's receipt read back.
    const outcomes = await evidence.verifyActiveDataCleanup({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
    });
    expect(outcomes).toContainEqual({
      documentId,
      state: "absent",
      error: null,
    });
    const [verifiedRow] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
    expect(verifiedRow.deletionState).toBe("confirmed");
    expect(verifiedRow.verifyState).toBe("absent");
    expect(verifiedRow.verifiedAt).not.toBeNull();
  });

  test("AC1: one API success is not the proof — a copy that came back, or units that outlived the delete, verify present", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    // Case one: the delete answered 2xx, but the copy came back (a restore resurrected it).
    const resurrected = await preferences.confirmGenericPreference(scope, {
      content: `purge-resurrected-marker-${run}`,
      provenance: "You",
    });
    const resurrectedId = preferenceDocumentIdFor(
      TENANT,
      resurrected.record.id,
    );
    await preferences.forgetGenericPreference(scope, resurrected.record.id);
    scripted.state.documents.set(resurrectedId, "present");
    // Case two: the document is gone but its extracted units survived the delete.
    const unitsLeft = await preferences.confirmGenericPreference(scope, {
      content: `purge-units-marker-${run}`,
      provenance: "You",
    });
    const unitsLeftId = preferenceDocumentIdFor(TENANT, unitsLeft.record.id);
    await preferences.forgetGenericPreference(scope, unitsLeft.record.id);
    scripted.state.memoryUnits.set(unitsLeftId, 1);

    const outcomes = await evidence.verifyActiveDataCleanup({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
    });
    const byDocument = new Map(outcomes.map((o) => [o.documentId, o]));
    expect(byDocument.get(resurrectedId)?.state).toBe("present");
    expect(byDocument.get(unitsLeftId)?.state).toBe("present");

    // Clean up the scripted contamination so the later claim tests start from absence.
    scripted.state.documents.set(resurrectedId, "absent");
    scripted.state.memoryUnits.set(unitsLeftId, 0);
    const reverified = await evidence.verifyActiveDataCleanup({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
    });
    expect(
      reverified.filter((outcome) => outcome.state === "absent").length,
    ).toBe(reverified.length);
  });

  test("AC1: an old sync task cannot rebuild a forgotten record, even over a resurrected authority row", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await scoped.confirmSourceBoundMemory(scope, {
      content: `purge-sync-guard-${run}`,
      provenance: "You",
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    expect(confirmed.remoteSynced).toBe(true);
    const documentId = sourceBoundDocumentIdFor(TENANT, confirmed.record.id);
    await scoped.forgetSourceBoundMemory(scope, confirmed.record.id);
    expect(scripted.state.documents.get(documentId)).toBe("absent");

    // The backup-restore window: the authority row comes back alive from the old copy.
    await database
      .update(sourceBoundMemories)
      .set({
        enabled: true,
        deletedAt: null,
        content: `purge-sync-guard-${run}`,
        syncedContentDigest: null,
        syncedAt: null,
      })
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT),
          eq(sourceBoundMemories.id, confirmed.record.id),
        ),
      );
    // An old (restored) sync task for it drains while the row is "live" again.
    await queue.record({
      subjectType: "source_bound",
      tenantId: TENANT,
      subjectId: confirmed.record.id,
      principalId: PRINCIPAL_EMP,
      contentDigest: "irrelevant-to-the-guard",
    });
    const before = retainsIntoBank(SOURCE_BANK_ONE);
    const report = await queue.drain({ limit: 200 });
    expect(report.nothingToDo).toBeGreaterThanOrEqual(1);
    // No retain into the blocked document's bank, and the remote copy stayed deleted.
    expect(retainsIntoBank(SOURCE_BANK_ONE)).toBe(before);
    expect(scripted.state.documents.get(documentId)).toBe("absent");
    const [work] = await database
      .select()
      .from(hindsightSyncWork)
      .where(
        and(
          eq(hindsightSyncWork.tenantId, TENANT),
          eq(hindsightSyncWork.subjectId, confirmed.record.id),
        ),
      )
      .orderBy(hindsightSyncWork.createdAt)
      .limit(1);
    expect(work.state).toBe("done");
    expect(work.lastError).toBe("subject blocked by revocation ledger");
  });
});

describe("Hindsight 14 (#391) — the backup-restore gate and its replay", () => {
  test("AC2: an open restore marker closes every recall entry — the SQL degradation path included — until the replay lands", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    // One preference stays lawful; one is forgotten and its row resurrected by the restore.
    const live = await preferences.confirmGenericPreference(scope, {
      content: `gate-live-marker-${run}`,
      provenance: "You",
    });
    const forgotten = await preferences.confirmGenericPreference(scope, {
      content: `gate-forgotten-marker-${run}`,
      provenance: "You",
    });
    const forgottenId = preferenceDocumentIdFor(TENANT, forgotten.record.id);
    await preferences.forgetGenericPreference(scope, forgotten.record.id);
    // The stale index answers both documents; the forgotten one dies at the row re-load.
    scripted.state.recallByBank.set(USER_BANK, {
      status: 200,
      body: {
        results: [
          { document_id: preferenceDocumentIdFor(TENANT, live.record.id) },
          { document_id: forgottenId },
        ],
      },
    });

    // Sanity: gate open — the live preference answers, the forgotten one does not.
    const open = await facade.recallGenericPreferences(scope, {
      query: "gate marker",
    });
    expect(open.degraded).toBe(false);
    expect(open.memories.map((m) => m.id)).toEqual([live.record.id]);

    // The restore: marker FIRST (the safe order), then the row resurrection, service down.
    const note = await recovery.noteBackupRestored({
      restoreKey: `restore-gate-${run}`,
    });
    expect(note.noted).toBe(true);
    expect(note.state).toBe("open");
    await database
      .update(genericPersonalPreferences)
      .set({
        enabled: true,
        deletedAt: null,
        content: `gate-forgotten-marker-${run}`,
      })
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.id, forgotten.record.id),
        ),
      );
    scripted.state.stallMs = STALL_MS;
    const callsBefore = recallCalls();

    // Closed gate: empty answer, no remote recall attempt, and NO degradation — the
    // resurrection window cannot serve the SQL rows either (they are the restored ones).
    const closed = await facade.recallGenericPreferences(scope, {
      query: "gate marker",
    });
    expect(closed.degraded).toBe(false);
    expect(closed.memories).toEqual([]);
    expect(recallCalls()).toBe(callsBefore);
    // The same closed door on the other entries.
    const scopedClosed = await facade.recallSourceBoundMemories(scope, {
      query: "gate marker",
    });
    expect(scopedClosed.memories).toEqual([]);
    expect(scopedClosed.degraded).toBe(false);
    const judgmentClosed = await review.recallDerivedJudgments(scope, {
      query: "gate marker",
    });
    expect(judgmentClosed).toEqual([]);
    scripted.state.stallMs = 0;

    // The replay: local blocks re-applied FIRST, then the gate opens again.
    const replay = await recovery.replayBackupRestore();
    expect(replay.replayed).toBe(true);
    expect(
      replay.evidence?.localBlocks.reappliedMemoryBlocks,
    ).toBeGreaterThanOrEqual(1);
    const reopened = await facade.recallGenericPreferences(scope, {
      query: "gate marker",
    });
    // The resurrected row is blocked again by the replay; only the lawful one answers.
    expect(reopened.memories.map((m) => m.id)).toEqual([live.record.id]);

    // Dedup: noting the SAME restore again neither re-closes recall nor re-replays.
    const again = await recovery.noteBackupRestored({
      restoreKey: `restore-gate-${run}`,
    });
    expect(again.noted).toBe(false);
    expect(again.state).toBe("replayed");
    const afterDedup = await facade.recallGenericPreferences(scope, {
      query: "gate marker",
    });
    expect(afterDedup.memories.map((m) => m.id)).toEqual([live.record.id]);
    // A DIFFERENT restore opens its own gate and its own replay.
    const other = await recovery.noteBackupRestored({
      restoreKey: `restore-second-${run}`,
    });
    expect(other.noted).toBe(true);
    expect(other.state).toBe("open");
    const closedAgain = await facade.recallGenericPreferences(scope, {
      query: "gate marker",
    });
    expect(closedAgain.memories).toEqual([]);
    const secondReplay = await recovery.replayBackupRestore();
    expect(secondReplay.replayed).toBe(true);
    const noop = await recovery.replayBackupRestore();
    expect(noop.replayed).toBe(false);
    expect(noop.evidence).toBeNull();
  });

  test("AC2: a replay against an unreachable service still reopens recall — cleanup waits, the block does not", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `outage-replay-marker-${run}`,
      provenance: "You",
    });
    await preferences.forgetGenericPreference(scope, confirmed.record.id);

    // The restore lands while Hindsight is down: the replay cannot re-issue anything.
    await recovery.noteBackupRestored({ restoreKey: `restore-outage-${run}` });
    scripted.state.stallMs = STALL_MS;
    const replay = await recovery.replayBackupRestore();
    expect(replay.replayed).toBe(true);
    expect(
      replay.evidence?.remoteDeletions.stillOutstanding,
    ).toBeGreaterThanOrEqual(1);
    // The markers flipped anyway: the LOCAL block is what makes recall safe to re-open.
    // (Under the ongoing outage the open gate would LAWFULLY degrade to SQL — that is the
    // facade's own contract — so the reopen assertion runs with the service back.)
    scripted.state.stallMs = 0;
    const reopened = await facade.recallGenericPreferences(scope, {
      query: "outage replay",
    });
    expect(reopened.degraded).toBe(false);
    expect(
      reopened.memories.filter(
        (memory) => memory.content === `outage-replay-marker-${run}`,
      ),
    ).toEqual([]);

    // Service back: the routine retry drain finishes what the replay could not, per row.
    const drained = await revocations.retryOutstandingDeletions({
      tenantId: TENANT,
    });
    expect(drained.confirmed).toBeGreaterThanOrEqual(1);
    const stillOpen = await recovery.gateStatus();
    expect(stillOpen.recallOpen).toBe(true);
  }, // default per-test budget is not enough once the row count grows mid-suite. // The outage replay re-issues one timed-out delete per ledger row (~500ms each); the
  60_000);

  test("AC2: the replay re-issues deletions for CONFIRMED documents a Hindsight-side restore resurrected", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `hindsight-restore-marker-${run}`,
      provenance: "You",
    });
    const documentId = preferenceDocumentIdFor(TENANT, confirmed.record.id);
    await preferences.forgetGenericPreference(scope, confirmed.record.id);
    const [row] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      );
    expect(row.deletionState).toBe("confirmed");

    // The Hindsight-side restore: the already-confirmed document is back in the service.
    scripted.state.documents.set(documentId, "present");
    scripted.state.memoryUnits.set(documentId, 1);
    await recovery.noteBackupRestored({ restoreKey: `restore-hs-${run}` });

    const replay = await recovery.replayBackupRestore();
    expect(replay.replayed).toBe(true);
    // The re-issue covered the previously CONFIRMED row; the scripted cascade cleared it.
    expect(deletesOfDocument(documentId)).toBeGreaterThanOrEqual(2);
    expect(scripted.state.documents.get(documentId)).toBe("absent");
    expect(scripted.state.memoryUnits.get(documentId)).toBe(0);
    expect(replay.evidence?.remoteDeletions.considered).toBeGreaterThanOrEqual(
      1,
    );

    // And the verification sweep re-establishes absence after the replay.
    const outcomes = await evidence.verifyActiveDataCleanup({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
    });
    expect(
      outcomes.find((outcome) => outcome.documentId === documentId)?.state,
    ).toBe("absent");
  });
});

describe("Hindsight 14 (#391) — the composed cleanup claim", () => {
  test("AC3: the claim appears only when all three legs hold actual evidence", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `claim-marker-${run}`,
      provenance: "You",
    });
    const documentId = preferenceDocumentIdFor(TENANT, confirmed.record.id);
    await preferences.forgetGenericPreference(scope, confirmed.record.id);

    // Step 0: the delete answered 2xx, but the copy is still held — the status re-probes
    // the confirmed row ITSELF (a stored verdict or the delete's receipt is not the proof),
    // finds it present, and the claim stays off.
    scripted.state.documents.set(documentId, "present");
    let status = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(status.activeData.documents).toBeGreaterThanOrEqual(1);
    expect(status.activeData.resurrected).toBeGreaterThanOrEqual(1);
    expect(status.controlledCopiesCleared).toBe(false);
    expect(status.summary).toBeNull();

    // Step 1: the copy is really gone now; a terminal payload beyond the window is still held.
    scripted.state.documents.set(documentId, "absent");
    scripted.state.operationsByBank.get(USER_BANK)?.push({
      created_at: new Date(Date.now() - 3 * DAY_MS).toISOString(),
      status: "completed",
    });
    status = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(status.activeData.cleared).toBe(true);
    expect(status.finishedTaskPayloads.checked).toBe(true);
    expect(status.finishedTaskPayloads.beyondWindow).toBeGreaterThanOrEqual(1);
    expect(status.controlledCopiesCleared).toBe(false);
    expect(status.summary).toBeNull();

    // Step 2: payloads within the window; an EMPTY backup registry is still no evidence.
    const ops = scripted.state.operationsByBank.get(USER_BANK) ?? [];
    scripted.state.operationsByBank.set(
      USER_BANK,
      ops.filter(
        (operation) =>
          new Date(operation.created_at).getTime() > Date.now() - DAY_MS,
      ),
    );
    status = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(status.finishedTaskPayloads.cleared).toBe(true);
    expect(status.controlledBackups.registered).toBe(0);
    expect(status.controlledBackups.outstanding).toBeNull();
    expect(status.controlledBackups.cleared).toBe(false);
    expect(status.controlledCopiesCleared).toBe(false);

    // Step 3: a registered copy taken BEFORE the deletion, un-purged — no claim.
    await evidence.recordControlledBackup({
      backupId: `bk-old-${run}`,
      takenAt: new Date(Date.now() - 5 * DAY_MS),
    });
    await evidence.recordControlledBackup({
      backupId: `bk-fresh-${run}`,
      takenAt: new Date(),
    });
    // Registering the same copy again changes nothing (registry dedup).
    await evidence.recordControlledBackup({
      backupId: `bk-old-${run}`,
      takenAt: new Date(Date.now() - 5 * DAY_MS),
    });
    status = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(status.controlledBackups.registered).toBe(2);
    expect(status.controlledBackups.outstanding).toBe(1);
    expect(status.controlledBackups.oldestOutstandingTakenAt).not.toBeNull();
    expect(status.controlledCopiesCleared).toBe(false);

    // Step 4: the pre-deletion copy purged with evidence — the claim lands, pinned verbatim.
    await evidence.noteControlledBackupPurged({
      backupId: `bk-old-${run}`,
      evidence: "integration sweep",
    });
    status = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(status.activeData.cleared).toBe(true);
    expect(status.finishedTaskPayloads.cleared).toBe(true);
    expect(status.controlledBackups.cleared).toBe(true);
    expect(status.controlledCopiesCleared).toBe(true);
    expect(status.summary).toBe(CONTROLLED_COPIES_CLEARED_SUMMARY);
    // External model logs stay a separate, excluded note — never folded into the claim.
    expect(status.externalModelLogs).toEqual({
      coveredByThisClaim: false,
      note: EXTERNAL_MODEL_LOGS_NOTE,
    });
  });

  test("AC3: an undeclared retention window or an unreachable probe keeps the payload leg unevidenced", async () => {
    const undeclared = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: null,
    });
    expect(undeclared.finishedTaskPayloads.checked).toBe(false);
    expect(undeclared.finishedTaskPayloads.retentionDays).toBeNull();
    expect(undeclared.finishedTaskPayloads.cleared).toBe(false);
    expect(undeclared.controlledCopiesCleared).toBe(false);

    scripted.state.stallMs = STALL_MS;
    const unreachable = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(unreachable.finishedTaskPayloads.checked).toBe(false);
    expect(unreachable.finishedTaskPayloads.reason).toContain(
      "could not be reached",
    );
    expect(unreachable.controlledCopiesCleared).toBe(false);
  });

  test("AC3: the status stays person-scoped, and an open restore marker blocks the active-data leg", async () => {
    // Another person's outstanding row does not block this person's verdict.
    await database.insert(hindsightRevocations).values({
      tenantId: TENANT,
      id: randomUUID(),
      principalId: PRINCIPAL_OTHER,
      kind: "memory",
      subjectType: "preference",
      targetId: `other-row-${run}`,
      documentId: `doc-other-${run}`,
      bankId: userBankFor(PRINCIPAL_OTHER),
      bankKind: "user",
      blockedAt: new Date(),
      deletionState: "pending",
    });
    const mine = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(mine.activeData.outstanding).toBe(0);
    expect(mine.activeData.documents).toBeGreaterThanOrEqual(1);

    // An open restore marker: verification cannot be trusted, so no claim — for anyone.
    await recovery.noteBackupRestored({ restoreKey: `restore-claim-${run}` });
    const blocked = await evidence.cleanupEvidenceStatus({
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      operationRetentionDays: 1,
    });
    expect(blocked.activeData.blockedByOpenRestore).toBe(true);
    expect(blocked.activeData.cleared).toBe(false);
    expect(blocked.controlledCopiesCleared).toBe(false);
    await recovery.replayBackupRestore();
  });
});
