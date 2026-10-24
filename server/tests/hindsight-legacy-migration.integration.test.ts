import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
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
import { hindsightMigrationMap } from "../src/db/schema/hindsight-legacy-migration";
import { hindsightMigrationQuarantine } from "../src/db/schema/hindsight-legacy-migration";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import { hindsightSyncWork } from "../src/db/schema/hindsight-sync";
import {
  memorySources,
  personalMemories,
} from "../src/db/schema/memory";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { userBankFor } from "../src/hindsight/bank-scope";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
import { createLegacyMemoryMigrator } from "../src/hindsight/legacy-migration";
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
 * Hindsight 16 (#394), integration layer: the legacy confirmed-memory migration over real
 * tables — the old global-user personal_memories, the tenancy tables, the new authority
 * tables and the sync queue — plus a scripted Hindsight service for the sample-recall side.
 *
 * One block per acceptance clause:
 *
 * 1. WHAT migrates and what does not, on multi-company and missing-attribution data: only
 *    confirmed, alive, OpenBot-recorded rows with PROVABLE company attribution (exactly one
 *    active membership). Unreviewed rows stay pending; disabled/deleted rows are inactive;
 *    no-principal / no-membership / ambiguous-company rows land in the quarantine list — and
 *    the new domain holds nothing of theirs. A global user id never guesses a tenant.
 * 2. The permission mapping: person-formed → general preference, Bot-formed → Bot-restricted
 *    source-bound (grant seeded), import → source-restricted (grant seeded from the old
 *    source's enabled flag — a disabled old source stays disabled).
 * 3. Resume from durable state without duplicating active content: a bounded pass stops
 *    mid-table, the same run id resumes strictly after the cursor, and re-running a completed
 *    migration migrates nothing new (the deterministic id + map fold every repeat).
 * 4. Reconciliation and sample recall: the before/after counts balance, the migrated rows
 *    enqueue sync work the queue drains, and a migrated preference recalls through the real
 *    seam — indexed (scripted hit) and degraded (SQL fallback with the service stalled).
 * 5. Permission shapes the new domain cannot reproduce (RG6-1): a Bot row that lost its agent
 *    id, an import row without its source id, a formed_by value outside the mapped shapes, and
 *    a Bot row whose source_ref narrowed recall to the forming Bot's still-held source app are
 *    each quarantined with their own reason — never silently reclassified as a general
 *    preference every authorized Bot of the person may read.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_mig-a-${run}`;
const TENANT_B = `tn_mig-b-${run}`;
const WORKSPACE_A = `ws_mig-a-${run}`;
const PRINCIPAL_A = `prin_a-${run}`;
const PRINCIPAL_MULTI = `prin_multi-${run}`;
const PRINCIPAL_SUSPENDED = `prin_susp-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const USER_A = `usr_a-${run}`;
const USER_MULTI = `usr_multi-${run}`;
const USER_SUSPENDED = `usr_susp-${run}`;
const USER_BARE = `usr_bare-${run}`;
const OLD_BOT = `agt_oldbot-${run}`;
const OLD_SOURCE = `memsrc_old-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;
const OWNERS = [USER_A, USER_MULTI, USER_SUSPENDED, USER_BARE];

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  stallMs: number;
};

let scripted: { server: Server; url: string; state: ScriptedState };
let migrator: ReturnType<typeof createLegacyMemoryMigrator>;
let queue: ReturnType<typeof createHindsightSyncQueue>;
let preferences: ReturnType<typeof createPreferenceRecallService>;
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
    stallMs: 0,
  };
  const server = createServer((request, response) => {
    // Drain the request stream without buffering: "end" must fire for bodied requests, and
    // the scripted answers route on method and path alone.
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
    selectWorkspace: () => WORKSPACE_A,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** Seed one old personal memory row; ids are ordered so the cursor's resume is observable. */
let oldSequence = 0;
async function seedOld(
  ownerUserId: string,
  input: {
    content: string;
    reviewState?: "unreviewed" | "confirmed" | "edited";
    formedBy?: "person" | "import" | "bot" | "intelligence";
    formedByAgentId?: string | null;
    sourceId?: string | null;
    sourceRef?: string | null;
    enabled?: boolean;
    deletedAt?: Date | null;
  },
): Promise<string> {
  oldSequence++;
  const id = `old_${run}_${String(oldSequence).padStart(4, "0")}`;
  await database.insert(personalMemories).values({
    id,
    ownerUserId,
    sourceId: input.sourceId ?? null,
    externalId: null,
    importDigest: null,
    content: input.content,
    provenance: `legacy-${run}`,
    enabled: input.enabled ?? true,
    reviewState: input.reviewState ?? "confirmed",
    deletedAt: input.deletedAt ?? null,
    formedBy: input.formedBy ?? "person",
    formedByAgentId: input.formedByAgentId ?? null,
    sourceApp: null,
    sourceRef: input.sourceRef ?? null,
    sourceLink: null,
    observedAt: null,
    intelligenceMemoryId: null,
    intelligenceDigest: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: USER_A, email: `a-${run}@example.invalid` },
    { id: USER_MULTI, email: `multi-${run}@example.invalid` },
    { id: USER_SUSPENDED, email: `susp-${run}@example.invalid` },
    { id: USER_BARE, email: `bare-${run}@example.invalid` },
  ]);
  await database.insert(agents).values([
    { id: OLD_BOT, name: `Legacy Bot ${run}`, type: "built_in", configuration: {} },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT_A, name: `Mig A ${run}` },
    { id: TENANT_B, name: `Mig B ${run}` },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT_A, id: WORKSPACE_A, name: `Mig WS ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_A, userId: USER_A },
    { id: PRINCIPAL_MULTI, userId: USER_MULTI },
    { id: PRINCIPAL_SUSPENDED, userId: USER_SUSPENDED },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
    // The multi-company user: provably in BOTH, therefore provably in NEITHER.
    { tenantId: TENANT_A, principalId: PRINCIPAL_MULTI, role: "member" },
    { tenantId: TENANT_B, principalId: PRINCIPAL_MULTI, role: "member" },
    // A principal whose only membership is suspended — attribution not provable.
    {
      tenantId: TENANT_B,
      principalId: PRINCIPAL_SUSPENDED,
      role: "member",
      status: "suspended",
    },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT_A, workspaceId: WORKSPACE_A, principalId: PRINCIPAL_A },
  ]);
  await database.insert(memorySources).values({
    id: OLD_SOURCE,
    ownerUserId: USER_A,
    agentId: OLD_BOT,
    toolRef: "legacy-import",
    title: `Legacy import ${run}`,
    args: {},
    enabled: false, // the old source was disabled — the seeded grant must say so
  });

  scripted = await bootScriptedHindsight();
  serviceConfig = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  queue = createHindsightSyncQueue(database, serviceConfig);
  migrator = createLegacyMemoryMigrator(database, { work: queue });
  preferences = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    serviceConfig,
  );
  const scoped = createSourceBoundRecallService(
    createDrizzleSourceBoundRecords(database),
    createDrizzleSourceBoundAuthorizations(database),
    serviceConfig,
  );
  facade = createDegradedRecallFacade(
    preferences,
    scoped,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    createDrizzleSourceBoundAuthorizations(database),
  );
});

afterAll(async () => {
  await scripted.server.close();
  // The deferred import-source work rows legitimately stay pending forever (their source
  // grant is disabled) — fine in production, but the next file's queue.drain() in this
  // process would count them. This file's rows are this file's to remove.
  await database
    .delete(hindsightSyncWork)
    .where(inArray(hindsightSyncWork.tenantId, [TENANT_A, TENANT_B]));
});

afterEach(() => {
  scripted.state.stallMs = 0;
});

describe("Hindsight 16 (#394) — legacy confirmed-memory migration", () => {
  test("AC1+AC2: only provable, confirmed, alive OpenBot records migrate, with their permission mapping intact", async () => {
    // User A: one active membership — everything of theirs is attributable.
    const personRow = await seedOld(USER_A, {
      content: `mig-person-fact-${run}`,
    });
    const editedRow = await seedOld(USER_A, {
      content: `mig-edited-fact-${run}`,
      reviewState: "edited",
    });
    const botRow = await seedOld(USER_A, {
      content: `mig-bot-fact-${run}`,
      formedBy: "bot",
      formedByAgentId: OLD_BOT,
    });
    const importRow = await seedOld(USER_A, {
      content: `mig-import-fact-${run}`,
      formedBy: "import",
      sourceId: OLD_SOURCE,
    });
    const pendingRow = await seedOld(USER_A, {
      content: `mig-pending-fact-${run}`,
      reviewState: "unreviewed",
    });
    await seedOld(USER_A, {
      content: `mig-dead-fact-${run}`,
      enabled: false,
    });
    // The attribution failures, each with confirmed alive rows that must be quarantined.
    const multiRow = await seedOld(USER_MULTI, {
      content: `mig-multi-fact-${run}`,
    });
    const suspendedRow = await seedOld(USER_SUSPENDED, {
      content: `mig-susp-fact-${run}`,
    });
    const bareRow = await seedOld(USER_BARE, {
      content: `mig-bare-fact-${run}`,
    });

    const report = await migrator.run({ owners: OWNERS });
    expect(report.completed).toBe(true);
    expect(report.migrated).toBe(4);
    expect(report.skippedPendingReview).toBe(1);
    expect(report.skippedInactive).toBe(1);
    expect(report.quarantined).toBe(3);

    // The permission mapping, row by row.
    const [prefPerson] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT_A),
          eq(genericPersonalPreferences.id, personRow),
        ),
      );
    expect(prefPerson.content).toBe(`mig-person-fact-${run}`);
    expect(prefPerson.reviewState).toBe("confirmed");
    expect(prefPerson.principalId).toBe(PRINCIPAL_A);
    const [prefEdited] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT_A),
          eq(genericPersonalPreferences.id, editedRow),
        ),
      );
    expect(prefEdited.reviewState).toBe("edited");

    const [botBound] = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT_A),
          eq(sourceBoundMemories.id, botRow),
        ),
      );
    expect(botBound.restriction).toBe("bot");
    expect(botBound.agentId).toBe(OLD_BOT);
    const [importBound] = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT_A),
          eq(sourceBoundMemories.id, importRow),
        ),
      );
    expect(importBound.restriction).toBe("source");
    expect(importBound.sourceId).toBe(OLD_SOURCE);

    // The seeded grants: the Bot's authorization (enabled), and the old source's standing
    // (disabled — the permission reconciliation carries the old state, not a fresh default).
    const [botGrant] = await database
      .select()
      .from(hindsightMemoryGrants)
      .where(
        and(
          eq(hindsightMemoryGrants.tenantId, TENANT_A),
          eq(hindsightMemoryGrants.principalId, PRINCIPAL_A),
          eq(hindsightMemoryGrants.kind, "bot"),
          eq(hindsightMemoryGrants.targetId, OLD_BOT),
        ),
      );
    expect(botGrant.enabled).toBe(true);
    const [sourceGrant] = await database
      .select()
      .from(hindsightMemoryGrants)
      .where(
        and(
          eq(hindsightMemoryGrants.tenantId, TENANT_A),
          eq(hindsightMemoryGrants.principalId, PRINCIPAL_A),
          eq(hindsightMemoryGrants.kind, "source"),
          eq(hindsightMemoryGrants.targetId, OLD_SOURCE),
        ),
      );
    expect(sourceGrant.enabled).toBe(false);

    // The unreviewed row stayed in the old table and produced nothing new.
    const [pendingOld] = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, pendingRow));
    expect(pendingOld.reviewState).toBe("unreviewed");
    const pendingMapped = await database
      .select()
      .from(hindsightMigrationMap)
      .where(eq(hindsightMigrationMap.oldRecordId, pendingRow));
    expect(pendingMapped).toEqual([]);

    // The quarantine list: the three attribution failures, each with its reason, none with
    // content, and NOTHING of theirs in the new domain — a global user id never guessed a
    // tenant, even though one of the multi-user's companies might have looked likely.
    const quarantine = await database
      .select()
      .from(hindsightMigrationQuarantine);
    const byOld = new Map(quarantine.map((row) => [row.oldRecordId, row]));
    expect(byOld.get(multiRow)?.reason).toBe("ambiguous-company");
    expect(byOld.get(suspendedRow)?.reason).toBe("no-active-membership");
    expect(byOld.get(bareRow)?.reason).toBe("no-principal");
    for (const id of [multiRow, suspendedRow, bareRow]) {
      expect(
        Object.keys(byOld.get(id) ?? {}).sort(),
      ).not.toContain("content");
    }
    const newRowsOfTheirs = await database
      .select()
      .from(hindsightMigrationMap)
      .where(eq(hindsightMigrationMap.ownerUserId, USER_MULTI));
    expect(newRowsOfTheirs).toEqual([]);
    const quarantinedIds = [multiRow, suspendedRow, bareRow];
    const preferencesOfTheirs = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, quarantinedIds[0]));
    expect(preferencesOfTheirs).toEqual([]);
  });

  test("AC3: a bounded pass resumes from the durable cursor and never duplicates active content", async () => {
    // A fresh, larger old-side cohort for user A only.
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) {
      seeded.push(
        await seedOld(USER_A, { content: `mig-resume-fact-${i}-${run}` }),
      );
    }
    const before = await migrator.reconcile({ owners: [USER_A] });
    // USER_A's old rows in the order the cursor walks them: AC1's cohort first, then the
    // fresh six — the bounded pass stops wherever its limit lands, not on our convenience.
    const userOldRows = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(eq(personalMemories.ownerUserId, USER_A))
      .orderBy(asc(personalMemories.id));
    const firstFourIds = userOldRows.slice(0, 4).map((row) => row.id);

    const runId = `mig-run-${run}`;
    const first = await migrator.run({ runId, owners: [USER_A], limit: 4 });
    expect(first.completed).toBe(false);
    expect(first.considered).toBe(4);
    const stateAfterFirst = await migrator.runState(runId);
    expect(stateAfterFirst?.state).toBe("running");
    expect(stateAfterFirst?.cursorOldId).toBe(firstFourIds[3]);

    // The resume: same run id, strictly after the cursor, to the end — the fresh six migrate
    // here, and the unreviewed/inactive leftovers of AC1's cohort are skipped again.
    const resumed = await migrator.run({ runId, owners: [USER_A] });
    expect(resumed.completed).toBe(true);
    expect(resumed.migrated).toBe(seeded.length);
    const stateAfterResume = await migrator.runState(runId);
    expect(stateAfterResume?.state).toBe("succeeded");

    // Reconciliation: exactly one new row per seeded record, no second active copy.
    const after = await migrator.reconcile({ owners: [USER_A] });
    expect(after.newSide.migrated).toBe(
      before.newSide.migrated + seeded.length,
    );
    // The old side is never mutated by the migration: what was confirmed-alive before the
    // pass is exactly what is confirmed-alive after it.
    expect(after.oldSide.confirmedAlive).toBe(before.oldSide.confirmedAlive);
    expect(after.balanced).toBe(true);
    const mapRows = await database
      .select()
      .from(hindsightMigrationMap)
      .where(eq(hindsightMigrationMap.ownerUserId, USER_A));
    const newIds = mapRows.map((row) => row.newRecordId);
    expect(new Set(newIds).size).toBe(newIds.length);

    // A full re-run of the completed migration migrates nothing (deterministic ids fold).
    const rerun = await migrator.run({ owners: [USER_A] });
    expect(rerun.migrated).toBe(0);
    expect(rerun.alreadyMigrated).toBe(before.oldSide.confirmedAlive);
    expect(rerun.completed).toBe(true);
  });

  test("AC3: the migration enqueues sync work the queue drains, and a sample recalls through the real seams", async () => {
    const sample = await migrator.sampleRows(TENANT_A, 3);
    expect(sample.length).toBeGreaterThan(0);
    const preferenceSample = sample.find(
      (row) => row.subjectType === "preference",
    );
    expect(preferenceSample).toBeDefined();

    // The migrated rows hold pending sync work under their own ids — the #384 pattern.
    const [workRow] = await database
      .select()
      .from(hindsightSyncWork)
      .where(
        and(
          eq(hindsightSyncWork.tenantId, TENANT_A),
          eq(hindsightSyncWork.subjectId, preferenceSample!.id),
        ),
      );
    expect(workRow?.state).toBe("pending");
    const drained = await queue.drain({ limit: 100 });
    expect(drained.synced).toBeGreaterThanOrEqual(1);

    // Sample recall through the indexed seam: the scripted service answers the migrated
    // preference's document, and the confirmed original comes back from the new table.
    const scope = await makeTrustedScope(PRINCIPAL_A, TENANT_A);
    scripted.state.recallByBank.set(userBankFor(PRINCIPAL_A), {
      status: 200,
      body: {
        results: [
          {
            document_id: preferenceDocumentIdFor(
              TENANT_A,
              preferenceSample!.id,
            ),
          },
        ],
      },
    });
    const indexed = await preferences.recallGenericPreferences(scope, {
      query: "mig sample",
    });
    expect(indexed.map((memory) => memory.id)).toContain(
      preferenceSample!.id,
    );
    // And through the degraded path with the service unreachable: the SQL fallback answers
    // the same confirmed original.
    scripted.state.stallMs = STALL_MS;
    const degraded = await facade.recallGenericPreferences(scope, {
      query: "mig person fact",
    });
    expect(degraded.degraded).toBe(true);
    expect(
      degraded.memories.map((memory) => memory.content),
    ).toContain(`mig-person-fact-${run}`);
  });
  test("RG6-1: out-of-shape and source-ref-narrowed rows quarantine instead of widening their audience", async () => {
    // A dedicated owner so the run below sees this cohort alone.
    const USER_SHAPE = `usr_shape-${run}`;
    const PRINCIPAL_SHAPE = `prin_shape-${run}`;
    const SOURCE_REF = `srv-proactive-${run}/messages/42`;
    await database.insert(users).values({
      id: USER_SHAPE,
      email: `shape-${run}@example.invalid`,
    });
    await database.insert(enterprisePrincipals).values({
      id: PRINCIPAL_SHAPE,
      userId: USER_SHAPE,
    });
    await database.insert(enterpriseMemberships).values({
      tenantId: TENANT_A,
      principalId: PRINCIPAL_SHAPE,
      role: "member",
    });

    // The two well-formed controls of the same cohort — they must still migrate.
    const personControl = await seedOld(USER_SHAPE, {
      content: `mig-shape-person-${run}`,
    });
    const botControl = await seedOld(USER_SHAPE, {
      content: `mig-shape-bot-${run}`,
      formedBy: "bot",
      formedByAgentId: OLD_BOT,
    });
    // The shapes the new tables cannot reproduce.
    const narrowedBot = await seedOld(USER_SHAPE, {
      content: `mig-shape-narrowed-${run}`,
      formedBy: "bot",
      formedByAgentId: OLD_BOT,
      // The old rule additionally required the forming Bot to still hold this source app
      // (split_part(source_ref, '/', 1)); the new domain has no column to carry it.
      sourceRef: SOURCE_REF,
    });
    const agentlessBot = await seedOld(USER_SHAPE, {
      content: `mig-shape-agentless-${run}`,
      formedBy: "bot",
    });
    const sourcelessImport = await seedOld(USER_SHAPE, {
      content: `mig-shape-sourceless-${run}`,
      formedBy: "import",
    });
    // formed_by has no CHECK in the old table: history may hold a value outside the three
    // mapped shapes. Written the way history wrote it, past the typed insert.
    const unknownShape = `old_${run}_unknown`;
    await database.execute(sql`
      insert into personal_memories
        (id, owner_user_id, content, provenance, enabled, review_state, formed_by, created_at, updated_at)
      values
        (${unknownShape}, ${USER_SHAPE}, ${`mig-shape-unknown-${run}`}, ${`legacy-${run}`}, true, 'confirmed', 'intelligence', now(), now())
    `);

    const report = await migrator.run({ owners: [USER_SHAPE] });
    expect(report.completed).toBe(true);
    expect(report.migrated).toBe(2);
    expect(report.quarantined).toBe(4);

    // Each held-back row lands in the isolation list with its own reason.
    const quarantinedIds = [
      narrowedBot,
      agentlessBot,
      sourcelessImport,
      unknownShape,
    ];
    const quarantine = await database
      .select()
      .from(hindsightMigrationQuarantine)
      .where(
        inArray(hindsightMigrationQuarantine.oldRecordId, quarantinedIds),
      );
    const byOld = new Map(quarantine.map((row) => [row.oldRecordId, row]));
    expect(byOld.get(narrowedBot)?.reason).toBe("source-ref-narrowing");
    expect(byOld.get(agentlessBot)?.reason).toBe("unmappable-permission-shape");
    expect(byOld.get(sourcelessImport)?.reason).toBe(
      "unmappable-permission-shape",
    );
    expect(byOld.get(unknownShape)?.reason).toBe(
      "unmappable-permission-shape",
    );
    for (const id of quarantinedIds) {
      expect(Object.keys(byOld.get(id) ?? {})).not.toContain("content");
    }

    // None of them reached the new domain — no map row, no preference, no source-bound row —
    // so the audience each old restriction named was never widened.
    const mapped = await database
      .select()
      .from(hindsightMigrationMap)
      .where(inArray(hindsightMigrationMap.oldRecordId, quarantinedIds));
    expect(mapped).toEqual([]);
    const preferencesOfTheirs = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT_A),
          inArray(genericPersonalPreferences.id, quarantinedIds),
        ),
      );
    expect(preferencesOfTheirs).toEqual([]);
    const boundOfTheirs = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT_A),
          inArray(sourceBoundMemories.id, quarantinedIds),
        ),
      );
    expect(boundOfTheirs).toEqual([]);

    // The source-ref row keeps its original reference where it always lived — the old table —
    // and the isolation row points at it by old id, so nothing had to be copied to hold it.
    const [narrowedOld] = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, narrowedBot));
    expect(narrowedOld.sourceRef).toBe(SOURCE_REF);
    expect(narrowedOld.enabled).toBe(true);
    expect(narrowedOld.reviewState).toBe("confirmed");

    // The controls migrated: the person row is a general preference, the Bot row a Bot-bound
    // source-bound memory — the same run, the same cohort, no shape smuggled into either.
    const [personRow] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT_A),
          eq(genericPersonalPreferences.id, personControl),
        ),
      );
    expect(personRow.content).toBe(`mig-shape-person-${run}`);
    const [botRow] = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT_A),
          eq(sourceBoundMemories.id, botControl),
        ),
      );
    expect(botRow.restriction).toBe("bot");
    expect(botRow.agentId).toBe(OLD_BOT);

    // Reconciliation answers with the new reasons, and still balances: the six confirmed-alive
    // rows of this cohort are two migrations and four quarantines, not fewer.
    const reconciled = await migrator.reconcile({ owners: [USER_SHAPE] });
    expect(reconciled.oldSide.confirmedAlive).toBe(6);
    expect(reconciled.newSide.migrated).toBe(2);
    expect(reconciled.quarantined.byReason["source-ref-narrowing"]).toBe(1);
    expect(
      reconciled.quarantined.byReason["unmappable-permission-shape"],
    ).toBe(3);
    expect(reconciled.balanced).toBe(true);
  });
});
