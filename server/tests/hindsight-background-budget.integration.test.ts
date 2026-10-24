import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
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
} from "../src/db/schema/enterprise-tenancy";
import { hindsightBudgetReservations } from "../src/db/schema/hindsight-budget";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import { hindsightSyncWork } from "../src/db/schema/hindsight-sync";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { userBankFor } from "../src/hindsight/bank-scope";
import { createDrizzleBudgetGate } from "../src/hindsight/budget-gate";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
import {
  createDerivedJudgmentService,
  createDrizzleDerivedJudgmentRecords,
} from "../src/hindsight/derived-judgments";
import { createDerivedJudgmentReviewService } from "../src/hindsight/judgment-review";
import { hindsightAdminHealthSnapshot } from "../src/hindsight/ops-view";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
} from "../src/hindsight/scoped-recall";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 15 (#393), integration layer: the background-processing budget and the operator's
 * backlog view, over the real tables and a scripted Hindsight service.
 *
 * One block per acceptance clause:
 *
 * 1. Exhaustion queues new processing and never touches authorized reads: a drained company
 *    at its cap defers its pending work, while recall of already-confirmed content (indexed
 *    and degraded) keeps answering.
 * 2. Recovery resumes the deferred work under its ORIGINAL tenant and user attribution, and a
 *    deferred retry is charged once — the admission's idempotency key sees to that. Charges
 *    never cross companies: each tenant's ledger holds only its own rows.
 * 3. The admin health view carries service state, backlog and budget usage — and nothing
 *    else: the structural scan proves no seeded memory content, candidate text or work-row
 *    error text survives into the serialized snapshot.
 *
 * Plus the two hardening pins from the G6 review round:
 *
 * 4. (RG6-2) The PERSONAL cap branch: a company with room but a person at their ceiling has
 *    that person's work deferred — charged nothing, the company ledger untouched by the
 *    refusal, a peer's work still admitted, and the whole state visible in the ops view.
 * 5. (RG6-3) A RELEASED reservation re-admitted on its original work key (the crash window
 *    between the queue's release and its attempts bump) re-checks both caps first: it stays
 *    released while either cap refuses, and re-reserves — once, under one row — when they
 *    do not.
 * 6. (FIX-W11 A-2) The judgment confirm's eager retain admits through the gate: an exhausted
 *    budget defers the retain to the work row's drain (the decision still stands, nothing
 *    charged), recovery resumes under the original identity and is charged exactly once, and
 *    an admitted eager retain charges without the drain adding a second one.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_bud-a-${run}`;
const TENANT_B = `tn_bud-b-${run}`;
const TENANT_C = `tn_bud-c-${run}`;
const TENANT_D = `tn_bud-d-${run}`;
const PRINCIPAL_C_EMP = `prin_c-emp-${run}`;
const PRINCIPAL_C_PEER = `prin_c-peer-${run}`;
const PRINCIPAL_D_EMP = `prin_d-emp-${run}`;
const PRINCIPAL_EMP = `prin_emp-${run}`;
const PRINCIPAL_PEER = `prin_peer-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  retainStatus: number;
  stallMs: number;
};

let scripted: { server: Server; url: string; state: ScriptedState };
let budget: ReturnType<typeof createDrizzleBudgetGate>;
let queue: ReturnType<typeof createHindsightSyncQueue>;
let facade: ReturnType<typeof createDegradedRecallFacade>;
let serviceConfig: {
  apiUrl: string;
  serviceApiKey: string;
  assertionSecret: string;
  requestTimeoutMs: number;
};

async function bootScriptedHindsight() {
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
    stallMs: 0,
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "";
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      const answer = () => {
        let status = 404;
        let payload: unknown = { results: [] };
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
  tenantId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => "ws-unused",
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** Seed one confirmed preference row directly, with sync work pending — the drain's input. */
async function seedPendingWork(
  tenantId: string,
  principalId: string,
  content: string,
): Promise<string> {
  const id = randomUUID();
  // The digest the queue will compare against: sha256 of the content as enqueued.
  const digest = createHash("sha256").update(content).digest("hex");
  await database.insert(genericPersonalPreferences).values({
    tenantId,
    id,
    principalId,
    content,
    provenance: "You",
    reviewState: "confirmed",
    enabled: true,
    deletedAt: null,
    markedGenericAt: new Date(),
    hindsightDocumentId: `hgp_${id.slice(0, 16)}`,
    syncedContentDigest: null,
    syncedAt: null,
    effectiveFrom: new Date(),
    effectiveUntil: null,
    supersededBy: null,
    supersededTimeUnknown: false,
    correctedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.insert(hindsightSyncWork).values({
    tenantId,
    id,
    subjectType: "preference",
    subjectId: id,
    principalId,
    expectedDigest: digest,
    state: "pending",
    attempts: 0,
  });
  return id;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` },
    { id: `usr_peer-${run}`, email: `peer-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT_A, name: `Bud A ${run}` },
    { id: TENANT_B, name: `Bud B ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: `usr_emp-${run}` },
    { id: PRINCIPAL_PEER, userId: `usr_peer-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT_A, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT_A, principalId: PRINCIPAL_PEER, role: "member" },
    { tenantId: TENANT_B, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT_B, principalId: PRINCIPAL_PEER, role: "member" },
  ]);

  scripted = await bootScriptedHindsight();
  serviceConfig = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  budget = createDrizzleBudgetGate(database);
  // FIX-W11 A-2: the queue wired the way index.ts wires it — the budget gate AND the
  // authorization store (a derived_judgment work row defers without one, even in general
  // scope; the earlier preference-only tests are unaffected by the addition).
  queue = createHindsightSyncQueue(database, serviceConfig, {
    budget,
    authorizations: createDrizzleSourceBoundAuthorizations(database),
  });
  const preferences = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    serviceConfig,
  );
  facade = createDegradedRecallFacade(
    preferences,
    createSourceBoundRecallService(
      createDrizzleSourceBoundRecords(database),
      createDrizzleSourceBoundAuthorizations(database),
      serviceConfig,
    ),
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    createDrizzleSourceBoundAuthorizations(database),
  );
});

afterAll(async () => {
  await scripted.server.close();
  // AC3's seeded row is deliberately never drained; remove it so the next file's
  // queue.drain() in this process does not count it.
  await database
    .delete(hindsightSyncWork)
    .where(
      inArray(hindsightSyncWork.tenantId, [
        TENANT_A,
        TENANT_B,
        TENANT_C,
        TENANT_D,
      ]),
    );
});

afterEach(() => {
  scripted.state.stallMs = 0;
});

describe("Hindsight 15 (#393) — background budget and operational backlog", () => {
  test("AC1: exhaustion queues new processing and never touches authorized reads", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, TENANT_A);
    const preferences = createPreferenceRecallService(
      createDrizzlePreferenceRecords(database),
      serviceConfig,
    );
    const confirmed = await preferences.confirmGenericPreference(scope, {
      content: `budget-readable-preference-${run}`,
      provenance: "You",
    });
    expect(confirmed.remoteSynced).toBe(true);

    // The company cap is set to exactly what is already used (the confirm above did not go
    // through the queue, so the ledger is empty — a cap of 0 units means every new admission
    // queues). Reads keep working regardless.
    await budget.setCaps(TENANT_A, {
      companyMonthlyUnits: 0,
      personalMonthlyUnits: 5,
    });
    const workId = await seedPendingWork(
      TENANT_A,
      PRINCIPAL_EMP,
      `budget-queued-fact-${run}`,
    );
    const report = await queue.drain({ limit: 50 });
    expect(report.deferred).toBeGreaterThanOrEqual(1);
    const [workRow] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncWork(TENANT_A, workId));
    expect(workRow.state).toBe("pending");
    expect(workRow.lastError).toBe("budget: company-cap");

    // Authorized reads are untouched by exhaustion — both the indexed and degraded paths.
    scripted.state.recallByBank.set(userBankFor(PRINCIPAL_EMP), {
      status: 200,
      body: {
        results: [
          {
            document_id: preferenceDocumentIdFor(
              TENANT_A,
              confirmed.record.id,
            ),
          },
        ],
      },
    });
    const readable = await preferences.recallGenericPreferences(scope, {
      query: "budget readable",
    });
    expect(readable.map((memory) => memory.id)).toContain(confirmed.record.id);
    // And with the service unreachable, the degraded path still answers the confirmed
    // content — exhaustion bought no change to reads.
    scripted.state.stallMs = STALL_MS;
    const degradedAnswer = await facade.recallGenericPreferences(scope, {
      query: "budget readable",
    });
    expect(degradedAnswer.degraded).toBe(true);
    expect(
      degradedAnswer.memories.map((memory) => memory.id),
    ).toContain(confirmed.record.id);
  });

  test("AC2: recovery resumes the deferred work under its original identity, charged once, never across companies", async () => {
    // Two companies, each with pending work; tenant A is capped to ONE unit this month (the
    // AC1 leftover row, being older, is the one that spends it), tenant B is uncapped.
    const workA1 = await seedPendingWork(
      TENANT_A,
      PRINCIPAL_EMP,
      `recovery-fact-a1-${run}`,
    );
    const workA2 = await seedPendingWork(
      TENANT_A,
      PRINCIPAL_EMP,
      `recovery-fact-a2-${run}`,
    );
    await seedPendingWork(
      TENANT_B,
      PRINCIPAL_EMP,
      `recovery-fact-b-${run}`,
    );
    await budget.setCaps(TENANT_A, {
      companyMonthlyUnits: 1,
      personalMonthlyUnits: 5,
    });
    const capped = await queue.drain({ limit: 50 });
    expect(capped.deferred).toBeGreaterThanOrEqual(2);
    expect(capped.synced).toBeGreaterThanOrEqual(2); // the cap unit + tenant B's work

    // The recovery: the platform raises the cap; the SAME pending row, still carrying its
    // original tenant and principal, drains on the next pass.
    await budget.setCaps(TENANT_A, {
      companyMonthlyUnits: 100,
      personalMonthlyUnits: 5,
    });
    const recovered = await queue.drain({ limit: 50 });
    expect(recovered.synced).toBeGreaterThanOrEqual(2);
    for (const id of [workA1, workA2]) {
      const [rowA] = await database
        .select()
        .from(hindsightSyncWork)
        .where(eqSyncWork(TENANT_A, id));
      expect(rowA.state).toBe("done");
      expect(rowA.principalId).toBe(PRINCIPAL_EMP);
    }

    // Charged once: the deferred attempt and the recovery attempt share one reservation —
    // the deferred admission created it, the recovery re-admitted it by work key.
    const usageA = await budget.currentUsage(TENANT_A);
    const usageB = await budget.currentUsage(TENANT_B);
    const chargedForA = usageA.personalUnits.find(
      (entry) => entry.principalId === PRINCIPAL_EMP,
    )?.units;
    // Tenant A's ledger: three units — the cap unit from the capped drain plus the two
    // recovered rows, each charged exactly once (the deferred admissions were refused BEFORE
    // a reservation existed, so nothing was held against the exhausted cap).
    expect(chargedForA).toBe(3);
    // Cross-company: tenant B's work charged tenant B only, and tenant A's units never
    // appeared in B's ledger.
    expect(usageB.companyUnits).toBeGreaterThanOrEqual(1);
    const bChargedForEmp = usageB.personalUnits.find(
      (entry) => entry.principalId === PRINCIPAL_EMP,
    );
    expect(bChargedForEmp?.units).toBeGreaterThanOrEqual(1);

    // A retry after a REMOTE failure is a genuinely new attempt (attempts bumped → new work
    // key → a fresh, honest admission): pin that the key derivation separates them.
    const admissionOne = await budget.admitBackgroundWork({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_EMP,
      workKey: `${workA1}:0`,
    });
    const admissionOneAgain = await budget.admitBackgroundWork({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_EMP,
      workKey: `${workA1}:0`,
    });
    const admissionTwo = await budget.admitBackgroundWork({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_EMP,
      workKey: `${workA1}:1`,
    });
    expect(admissionOne.ok && admissionOneAgain.ok && admissionTwo.ok).toBe(
      true,
    );
    if (admissionOne.ok && admissionOneAgain.ok && admissionTwo.ok) {
      expect(admissionOneAgain.reservationId).toBe(admissionOne.reservationId);
      expect(admissionTwo.reservationId).not.toBe(admissionOne.reservationId);
    }

  });

  test("AC3: the admin health view shows service, backlog and budgets — and no content", async () => {
    // Seed content-bearing rows: pending work whose subject row carries distinctive text, and
    // an error message on the work row itself.
    const seededWorkId = await seedPendingWork(
      TENANT_B,
      PRINCIPAL_PEER,
      `ops-view-secret-content-${run}`,
    );
    await database
      .update(hindsightSyncWork)
      .set({ lastError: `ops-view-secret-error-${run}`, attempts: 1 })
      .where(eqSyncWork(TENANT_B, seededWorkId));

    await budget.setCaps(TENANT_B, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 3,
    });

    const snapshot = await hindsightAdminHealthSnapshot(
      database,
      budget,
      TENANT_B,
      { serviceState: "service_up" },
    );
    // Service state, backlog and budgets, checked at an instant.
    expect(snapshot.service.state).toBe("service_up");
    expect(snapshot.backlog.pendingWork).toBeGreaterThanOrEqual(1);
    expect(snapshot.backlog.oldestPendingAt instanceof Date).toBe(true);
    expect(snapshot.budgets.companyMonthlyUnits).toBe(10);
    expect(snapshot.budgets.personalMonthlyUnits).toBe(3);
    expect(typeof snapshot.checkedAt).toBe("string");

    // The structural guarantee: no seeded content, error text or candidate words survive
    // serialization of the snapshot.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(`ops-view-secret-content-${run}`);
    expect(serialized).not.toContain(`ops-view-secret-error-${run}`);
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("lastError");
    expect(serialized).not.toContain("provenance");
    // And the key set is exactly the three blocks plus the instant.
    expect(Object.keys(snapshot).sort()).toEqual(
      ["backlog", "budgets", "checkedAt", "service"].sort(),
    );
  });

  test("RG6-2: the personal cap defers that person's work, charges nothing, and leaves the company budget to peers", async () => {
    await database.insert(users).values([
      { id: `usr_c-emp-${run}`, email: `c-emp-${run}@example.invalid` },
      { id: `usr_c-peer-${run}`, email: `c-peer-${run}@example.invalid` },
    ]);
    await database
      .insert(enterpriseTenants)
      .values({ id: TENANT_C, name: `Bud C ${run}` });
    await database.insert(enterprisePrincipals).values([
      { id: PRINCIPAL_C_EMP, userId: `usr_c-emp-${run}` },
      { id: PRINCIPAL_C_PEER, userId: `usr_c-peer-${run}` },
    ]);
    await database.insert(enterpriseMemberships).values([
      { tenantId: TENANT_C, principalId: PRINCIPAL_C_EMP, role: "member" },
      { tenantId: TENANT_C, principalId: PRINCIPAL_C_PEER, role: "member" },
    ]);

    // The company has room; the person does not. EMP's ceiling is one unit and this month's
    // one unit is already settled; PEER has spent nothing.
    await budget.setCaps(TENANT_C, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 1,
    });
    const spent = await budget.admitBackgroundWork({
      tenantId: TENANT_C,
      principalId: PRINCIPAL_C_EMP,
      workKey: `spent:${TENANT_C}`,
      units: 1,
    });
    expect(spent.ok).toBe(true);
    if (spent.ok) await budget.settleBackgroundWork(spent.reservationId);

    const empWork = await seedPendingWork(
      TENANT_C,
      PRINCIPAL_C_EMP,
      `budget-personal-emp-${run}`,
    );
    const peerWork = await seedPendingWork(
      TENANT_C,
      PRINCIPAL_C_PEER,
      `budget-personal-peer-${run}`,
    );
    const report = await queue.drain({ limit: 50 });
    expect(report.deferred).toBeGreaterThanOrEqual(1);

    // EMP's work waits with the personal-cap reason; PEER's ran — the company budget was
    // never the constraint, and a person's ceiling does not reach their peers.
    const [empRow] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncWork(TENANT_C, empWork));
    expect(empRow.state).toBe("pending");
    expect(empRow.lastError).toBe("budget: personal-cap");
    const [peerRow] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncWork(TENANT_C, peerWork));
    expect(peerRow.state).toBe("done");

    // The refusal charged nothing: EMP sits at the one settled unit, PEER's admitted unit is
    // the only new charge, and the company total is exactly those two.
    const usage = await budget.currentUsage(TENANT_C);
    expect(usage.companyUnits).toBe(2);
    expect(
      usage.personalUnits.find(
        (entry) => entry.principalId === PRINCIPAL_C_EMP,
      )?.units,
    ).toBe(1);
    expect(
      usage.personalUnits.find(
        (entry) => entry.principalId === PRINCIPAL_C_PEER,
      )?.units,
    ).toBe(1);

    // And the state is where an operator looks: caps, usage and the waiting backlog.
    const snapshot = await hindsightAdminHealthSnapshot(
      database,
      budget,
      TENANT_C,
      { serviceState: "service_up" },
    );
    expect(snapshot.budgets.companyMonthlyUnits).toBe(10);
    expect(snapshot.budgets.personalMonthlyUnits).toBe(1);
    expect(snapshot.budgets.companyUsedUnits).toBe(2);
    expect(snapshot.budgets.companyOverCap).toBe(false);
    expect(
      snapshot.budgets.personalUsage.find(
        (entry) => entry.principalId === PRINCIPAL_C_EMP,
      )?.units,
    ).toBe(1);
    expect(snapshot.backlog.pendingWork).toBeGreaterThanOrEqual(1);
  });

  test("RG6-3: a released reservation re-admitted on its original work key re-checks both caps", async () => {
    // Room for the first admission to succeed: EMP has one settled unit from RG6-2.
    await budget.setCaps(TENANT_C, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 5,
    });
    const workKey = `recheck:${TENANT_C}`;
    const first = await budget.admitBackgroundWork({
      tenantId: TENANT_C,
      principalId: PRINCIPAL_C_EMP,
      workKey,
      units: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A transport failure released the hold before the service was reached: it never counted
    // (EMP's settled unit + PEER's admitted unit remain the whole company ledger).
    await budget.releaseBackgroundWork(first.reservationId, "transport failure");
    const afterRelease = await budget.currentUsage(TENANT_C);
    expect(afterRelease.companyUnits).toBe(2);

    // The crash window: the queue's release ran but its attempts bump did not, so the next
    // drain re-admits the SAME work key — after the platform shrank the caps. The re-admission
    // must re-check them, not flip the released row back to reserved on sight.
    await budget.setCaps(TENANT_C, {
      companyMonthlyUnits: 2,
      personalMonthlyUnits: 5,
    });
    const deniedByCompany = await budget.admitBackgroundWork({
      tenantId: TENANT_C,
      principalId: PRINCIPAL_C_EMP,
      workKey,
      units: 1,
    });
    expect(deniedByCompany).toEqual({ ok: false, reason: "company-cap" });
    const [stillReleased] = await database
      .select()
      .from(hindsightBudgetReservations)
      .where(eq(hindsightBudgetReservations.workKey, workKey));
    expect(stillReleased.state).toBe("released");

    // The personal half, symmetrically: the company has room again, the person does not.
    await budget.setCaps(TENANT_C, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 1,
    });
    const deniedByPerson = await budget.admitBackgroundWork({
      tenantId: TENANT_C,
      principalId: PRINCIPAL_C_EMP,
      workKey,
      units: 1,
    });
    expect(deniedByPerson).toEqual({ ok: false, reason: "personal-cap" });
    const [stillReleasedAgain] = await database
      .select()
      .from(hindsightBudgetReservations)
      .where(eq(hindsightBudgetReservations.workKey, workKey));
    expect(stillReleasedAgain.state).toBe("released");

    // Within the caps again: the SAME reservation comes back, charged once — the release
    // never counted and the re-admission is one row, not a second one beside the first.
    await budget.setCaps(TENANT_C, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 5,
    });
    const readmitted = await budget.admitBackgroundWork({
      tenantId: TENANT_C,
      principalId: PRINCIPAL_C_EMP,
      workKey,
      units: 1,
    });
    expect(readmitted.ok).toBe(true);
    if (readmitted.ok) {
      expect(readmitted.reservationId).toBe(first.reservationId);
    }
    const rows = await database
      .select()
      .from(hindsightBudgetReservations)
      .where(eq(hindsightBudgetReservations.workKey, workKey));
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe("reserved");
    const usageAfter = await budget.currentUsage(TENANT_C);
    expect(usageAfter.companyUnits).toBe(3);
    expect(
      usageAfter.personalUnits.find(
        (entry) => entry.principalId === PRINCIPAL_C_EMP,
      )?.units,
    ).toBe(2);
  });

  test("FIX-W11 A-2: the judgment confirm's eager retain admits through the gate; exhaustion defers, recovery charges once", async () => {
    // A fourth company, its person and the judgment chain — the review service wired with the
    // SAME budget gate and work recorder the production assembly wires (FIX-W11 index.ts).
    await database
      .insert(users)
      .values([{ id: `usr_d-emp-${run}`, email: `d-emp-${run}@example.invalid` }]);
    await database
      .insert(enterpriseTenants)
      .values({ id: TENANT_D, name: `Bud D ${run}` });
    await database
      .insert(enterprisePrincipals)
      .values({ id: PRINCIPAL_D_EMP, userId: `usr_d-emp-${run}` });
    await database.insert(enterpriseMemberships).values([
      { tenantId: TENANT_D, principalId: PRINCIPAL_D_EMP, role: "member" },
    ]);
    const scope = await makeTrustedScope(PRINCIPAL_D_EMP, TENANT_D);
    const preferenceRecords = createDrizzlePreferenceRecords(database);
    const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
    const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
    const authorizations = createDrizzleSourceBoundAuthorizations(database);
    const preferences = createPreferenceRecallService(
      preferenceRecords,
      serviceConfig,
    );
    const proposals = createDerivedJudgmentService(
      preferenceRecords,
      sourceBoundRecords,
      judgmentRecords,
      authorizations,
    );
    const review = createDerivedJudgmentReviewService(
      preferenceRecords,
      sourceBoundRecords,
      judgmentRecords,
      authorizations,
      serviceConfig,
      { work: queue, budget },
    );

    // The judgment's basis: two confirmed general preferences.
    const basisA = await preferences.confirmGenericPreference(scope, {
      content: `fixw11-basis-a-${run}`,
    });
    const basisB = await preferences.confirmGenericPreference(scope, {
      content: `fixw11-basis-b-${run}`,
    });
    const lead = [
      preferenceDocumentIdFor(TENANT_D, basisA.record.id),
      preferenceDocumentIdFor(TENANT_D, basisB.record.id),
    ];

    // Exhausted: the confirm's DECISION stands, the eager retain defers to the work row, and
    // nothing is charged — the refusal precedes any reservation.
    await budget.setCaps(TENANT_D, {
      companyMonthlyUnits: 0,
      personalMonthlyUnits: 0,
    });
    const candidateA = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `fixw11-judgment-a-${run}`,
      evidence: lead,
    });
    const deferred = await review.confirmDerivedJudgment(
      scope,
      candidateA.id,
      {},
    );
    expect(deferred.judgment.reviewState).toBe("confirmed");
    expect(deferred.remoteSynced).toBe(false);
    expect((await budget.currentUsage(TENANT_D)).companyUnits).toBe(0);
    const [deferredWork] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncSubject(TENANT_D, candidateA.id));
    expect(deferredWork.state).toBe("pending");

    // Recovery: the platform raises the caps and the drain resumes the deferred work under
    // its original tenant and principal — charged exactly once, and a second drain finds
    // nothing left to charge.
    await budget.setCaps(TENANT_D, {
      companyMonthlyUnits: 10,
      personalMonthlyUnits: 10,
    });
    const resumed = await queue.drain({ limit: 50 });
    expect(resumed.synced).toBeGreaterThanOrEqual(1);
    const [resumedWork] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncSubject(TENANT_D, candidateA.id));
    expect(resumedWork.state).toBe("done");
    expect(resumedWork.principalId).toBe(PRINCIPAL_D_EMP);
    expect((await budget.currentUsage(TENANT_D)).companyUnits).toBe(1);
    await queue.drain({ limit: 50 });
    expect((await budget.currentUsage(TENANT_D)).companyUnits).toBe(1);

    // With budget available the eager retain runs and settles its own admission; the work
    // row the confirm recorded then finds the row already indexed and adds no second charge.
    const candidateB = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `fixw11-judgment-b-${run}`,
      evidence: lead,
    });
    const eager = await review.confirmDerivedJudgment(
      scope,
      candidateB.id,
      {},
    );
    expect(eager.remoteSynced).toBe(true);
    expect((await budget.currentUsage(TENANT_D)).companyUnits).toBe(2);
    await queue.drain({ limit: 50 });
    const [eagerWork] = await database
      .select()
      .from(hindsightSyncWork)
      .where(eqSyncSubject(TENANT_D, candidateB.id));
    expect(eagerWork.state).toBe("done");
    expect((await budget.currentUsage(TENANT_D)).companyUnits).toBe(2);
  });
});
function eqSyncWork(tenantId: string, id: string) {
  return and(
    eq(hindsightSyncWork.tenantId, tenantId),
    eq(hindsightSyncWork.id, id),
  );
}

/** The queue mints its own work-row id; the judgment legs find theirs by subject. */
function eqSyncSubject(tenantId: string, subjectId: string) {
  return and(
    eq(hindsightSyncWork.tenantId, tenantId),
    eq(hindsightSyncWork.subjectType, "derived_judgment"),
    eq(hindsightSyncWork.subjectId, subjectId),
  );
}
