import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
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
} from "../src/db/schema/enterprise-tenancy";
import { hindsightControlledBackups } from "../src/db/schema/hindsight-restore";
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import { createCleanupEvidenceService } from "../src/hindsight/cleanup-evidence";
import {
  companySchemaFor,
  mintBankScopeAssertion,
  userBankFor,
} from "../src/hindsight/bank-scope";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 14 (#391) on a REAL self-hosted Hindsight instance — the dedicated throwaway
 * booted by deploy/hindsight/test/contract-instance.sh, whose gateway stand-in extracts one
 * echo fact per retain so documents really seed memory units.
 *
 * What only the real service can prove here:
 *   - the deletion evidence endpoints behave as the module assumes: a deleted document
 *     answers 404 AND its memory units answer empty (the cascade delete the service's own
 *     description promises), while a document still held answers 200 — the production
 *     verification sweep (verifyActiveDataCleanup) reads exactly those two answers;
 *   - the operations endpoint answers the shape the finished-payload probe parses, and the
 *     retain payloads it holds are inside the declared window on a fresh instance;
 *   - the composed status (cleanupEvidenceStatus) runs its whole evidence chain against the
 *     real service and lands the claim only with a purged controlled copy registered.
 *
 * The ledger rows are written directly (the block-and-forget flows are the integration
 * suite's subject against the scripted service); what this suite exercises is the PRODUCTION
 * probe code against real wire behavior. When the instance is not reachable the suite skips
 * loudly, exactly like #381's contract suite.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_purgect-a-${run}`;
const TENANT_B = `tn_purgect-b-${run}`;
const PRINCIPAL_A = `prin_purgect-a-${run}`;
const PRINCIPAL_B = `prin_purgect-b-${run}`;

const API_MS = 15_000;

async function live(): Promise<boolean> {
  try {
    const response = await fetch(`${CONTRACT_URL}/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = CONTRACT_API_KEY && CONTRACT_SECRET && (await live());

function bankToken(
  tenantId: string,
  principalId: string,
): {
  bank: string;
  token: string;
} {
  const bank = userBankFor(principalId);
  const token = mintBankScopeAssertion(
    {
      schema: companySchemaFor(tenantId),
      banks: [{ id: bank, kind: "user" }],
      tenantId,
      principalId,
    },
    { secret: CONTRACT_SECRET ?? "unset", ttlMs: 5 * 60_000 },
  );
  return { bank, token };
}

async function hindsight(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${CONTRACT_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CONTRACT_API_KEY}`,
      "x-openbot-bank-scope": token,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(API_MS),
  });
}

async function seedLedgerRow(input: {
  tenantId: string;
  principalId: string;
  targetId: string;
  documentId: string;
}): Promise<void> {
  await database.insert(hindsightRevocations).values({
    tenantId: input.tenantId,
    id: randomUUID(),
    principalId: input.principalId,
    kind: "memory",
    subjectType: "preference",
    targetId: input.targetId,
    documentId: input.documentId,
    bankId: userBankFor(input.principalId),
    bankKind: "user",
    blockedAt: new Date(),
    deletionState: "confirmed",
    deletionAttemptedAt: new Date(),
  });
}

beforeAll(async () => {
  if (!available) return;
  // The controlled-backup registry is global; copies left by earlier runs of this suite
  // against the same database are the suite's own artifacts — cleared so the claim's
  // absolute assertions hold. Only this suite and the integration suite touch the table.
  await database.delete(hindsightControlledBackups);
  await database.insert(users).values([
    { id: `usr_pa-${run}`, email: `pa-${run}@example.invalid` },
    { id: `usr_pb-${run}`, email: `pb-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT_A, name: `Purge CT A ${run}` },
    { id: TENANT_B, name: `Purge CT B ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_A, userId: `usr_pa-${run}` },
    { id: PRINCIPAL_B, userId: `usr_pb-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
    { tenantId: TENANT_B, principalId: PRINCIPAL_B, role: "member" },
  ]);
});

describe.skipIf(!available)(
  "hindsight purge/restore evidence (#391) on a real instance",
  () => {
    test("a deleted document verifies absent: 404 on the document, empty on its memory units", async () => {
      const { bank, token } = bankToken(TENANT_A, PRINCIPAL_A);
      const documentId = `purge-ct-absent-${run}`;
      const retain = await hindsight(
        token,
        `/v1/default/banks/${bank}/memories`,
        {
          method: "POST",
          body: {
            items: [
              {
                content: `Contract person prefers ct-absent-${run} in the morning`,
                document_id: documentId,
              },
            ],
          },
        },
      );
      expect([200, 201, 202]).toContain(retain.status);
      // The extraction pipeline settles; one echo unit should reference the document.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const unitsBefore = await hindsight(
        token,
        `/v1/default/banks/${bank}/memories/list?document_id=${encodeURIComponent(documentId)}`,
      );
      expect(unitsBefore.status).toBe(200);
      const before = (await unitsBefore.json()) as { total?: number };
      expect(before.total ?? 0).toBeGreaterThanOrEqual(1);

      const removed = await hindsight(
        token,
        `/v1/default/banks/${bank}/documents/${encodeURIComponent(documentId)}`,
        { method: "DELETE" },
      );
      expect([200, 202, 204]).toContain(removed.status);

      await seedLedgerRow({
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        targetId: `ct-absent-row-${run}`,
        documentId,
      });
      const evidence = createCleanupEvidenceService(database, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "",
        assertionSecret: CONTRACT_SECRET ?? "",
        requestTimeoutMs: API_MS,
      });
      const outcomes = await evidence.verifyActiveDataCleanup({
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
      });
      expect(outcomes).toContainEqual({
        documentId,
        state: "absent",
        error: null,
      });
      const [row] = await database
        .select()
        .from(hindsightRevocations)
        .where(
          and(
            eq(hindsightRevocations.tenantId, TENANT_A),
            eq(hindsightRevocations.documentId, documentId),
          ),
        );
      expect(row.verifyState).toBe("absent");
      expect(row.verifiedAt).not.toBeNull();
    }, 60_000);

    test("a document the service still holds verifies present — one API success is not the proof", async () => {
      const { bank, token } = bankToken(TENANT_B, PRINCIPAL_B);
      const documentId = `purge-ct-present-${run}`;
      const retain = await hindsight(
        token,
        `/v1/default/banks/${bank}/memories`,
        {
          method: "POST",
          body: {
            items: [
              {
                content: `Contract person prefers ct-present-${run} at standup`,
                document_id: documentId,
              },
            ],
          },
        },
      );
      expect([200, 201, 202]).toContain(retain.status);
      // No delete: the copy is held. A ledger row claiming confirmed deletion must verify
      // PRESENT against the real service — the exact dishonesty the sweep exists to catch.
      await seedLedgerRow({
        tenantId: TENANT_B,
        principalId: PRINCIPAL_B,
        targetId: `ct-present-row-${run}`,
        documentId,
      });
      const evidence = createCleanupEvidenceService(database, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "",
        assertionSecret: CONTRACT_SECRET ?? "",
        requestTimeoutMs: API_MS,
      });
      const outcomes = await evidence.verifyActiveDataCleanup({
        tenantId: TENANT_B,
        principalId: PRINCIPAL_B,
      });
      expect(outcomes).toContainEqual({
        documentId,
        state: "present",
        error: "document answered 200 after its deletion",
      });
      const [row] = await database
        .select()
        .from(hindsightRevocations)
        .where(
          and(
            eq(hindsightRevocations.tenantId, TENANT_B),
            eq(hindsightRevocations.documentId, documentId),
          ),
        );
      expect(row.verifyState).toBe("present");
      expect(row.verifyError).not.toBeNull();
    }, 60_000);

    test("the composed claim runs its whole chain on the real service", async () => {
      const evidence = createCleanupEvidenceService(database, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "",
        assertionSecret: CONTRACT_SECRET ?? "",
        requestTimeoutMs: API_MS,
      });
      // Tenant A holds one confirmed AND verified-absent document; fresh retain payloads sit
      // inside the declared one-day window, so the payload leg observes clearance.
      const before = await evidence.cleanupEvidenceStatus({
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        operationRetentionDays: 1,
      });
      expect(before.activeData.cleared).toBe(true);
      expect(before.finishedTaskPayloads.checked).toBe(true);
      expect(before.finishedTaskPayloads.beyondWindow).toBe(0);
      // No controlled copy is registered yet — no evidence, no claim.
      expect(before.controlledBackups.registered).toBe(0);
      expect(before.controlledBackups.cleared).toBe(false);
      expect(before.controlledCopiesCleared).toBe(false);

      // A copy taken BEFORE the deletion confirmation may contain the document: registered
      // but un-purged it keeps the claim off; purged with evidence the claim lands.
      await evidence.recordControlledBackup({
        backupId: `ct-bk-old-${run}`,
        takenAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });
      const withCopy = await evidence.cleanupEvidenceStatus({
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        operationRetentionDays: 1,
      });
      expect(withCopy.controlledBackups.outstanding).toBe(1);
      expect(withCopy.controlledCopiesCleared).toBe(false);
      await evidence.noteControlledBackupPurged({
        backupId: `ct-bk-old-${run}`,
        evidence: "contract-instance sweep",
      });
      const claimed = await evidence.cleanupEvidenceStatus({
        tenantId: TENANT_A,
        principalId: PRINCIPAL_A,
        operationRetentionDays: 1,
      });
      expect(claimed.controlledCopiesCleared).toBe(true);
      expect(claimed.summary).toBeTruthy();
      expect(claimed.externalModelLogs.coveredByThisClaim).toBe(false);
    }, 60_000);
  },
);
