import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
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
import { sourceBoundMemories } from "../src/db/schema/hindsight-source-bound";
import { hindsightSyncWork } from "../src/db/schema/hindsight-sync";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import {
  createDrizzleSourceBoundAuthorizations,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 07 (#384), integration layer: the durable sync queue over the real work table,
 * both authority tables, and a scripted Hindsight service whose retain answers we flip.
 *
 * One describe per acceptance clause:
 *
 * 1. States are durably recorded: a confirm writes the authority row AND a pending work row;
 *    an inline success drains as an idempotent no-op (no second remote write).
 * 2. Transient remote failure never produces a wrong active version: the work stays pending
 *    with the error recorded, the status surface reports failed — never "indexed" — and the
 *    drain after recovery completes the sync automatically.
 * 3. Duplicate tasks collapse (one pending row per subject, re-enqueue refreshes) and a stale
 *    edit task is superseded: only the newer content is ever successfully retained.
 * 4. Only confirmed, currently-authorized content is sent: unreviewed, paused and mismatched
 *    ownership are skipped without a remote call; an unauthorized source-bound restriction
 *    defers (pending, not sent) until re-authorized.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_acme-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL = `prin_person-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

type CapturedRetain = {
  bank: string;
  body: { items: { content: string; document_id: string }[] };
};

let scripted: {
  server: Server;
  url: string;
  retains: CapturedRetain[];
  state: { retainStatus: number };
};

async function bootScriptedHindsight() {
  const retains: CapturedRetain[] = [];
  const state = { retainStatus: 202 };
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
      if (request.method === "POST" && path.endsWith("/memories")) {
        retains.push({
          bank,
          body: body as CapturedRetain["body"],
        });
        response.writeHead(state.retainStatus, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ accepted: 1 }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "scripted: no route" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("scripted hindsight did not bind a port");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    retains,
    state,
  };
}

// The controlled-directory technique from hindsight-bank-scope.test.ts.
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

async function makeTrustedScope(): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(PRINCIPAL),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

let queue: ReturnType<typeof createHindsightSyncQueue>;
let service: ReturnType<typeof createPreferenceRecallService>;

beforeAll(async () => {
  await database.insert(users).values([
    { id: `usr_person-${run}`, email: `person-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT, name: `Acme ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL, userId: `usr_person-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL, role: "member" },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT, id: WORKSPACE, name: `Team ${run}` },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL },
  ]);

  scripted = await bootScriptedHindsight();
  const config = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  };
  queue = createHindsightSyncQueue(database, config, {
    authorizations: createDrizzleSourceBoundAuthorizations(database),
  });
  service = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    config,
    { work: queue },
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
  scripted.retains.length = 0;
  scripted.state.retainStatus = 202;
});

async function pendingWorkCount(
  tenantId: string,
  subjectType: "preference" | "source_bound",
  subjectId: string,
): Promise<number> {
  const rows = await database
    .select({ id: hindsightSyncWork.id })
    .from(hindsightSyncWork)
    .where(
      and(
        eq(hindsightSyncWork.tenantId, tenantId),
        eq(hindsightSyncWork.subjectType, subjectType),
        eq(hindsightSyncWork.subjectId, subjectId),
        eq(hindsightSyncWork.state, "pending"),
      ),
    );
  return rows.length;
}

describe("Hindsight 07 (#384): states are durably recorded", () => {
  test("a confirm writes the authority row and a pending work row", async () => {
    const scope = await makeTrustedScope();
    const { record, remoteSynced } = await service.confirmGenericPreference(scope, {
      content: `已确认偏好 ${run}`,
    });
    expect(remoteSynced).toBe(true);
    expect(await pendingWorkCount(TENANT, "preference", record.id)).toBe(1);

    // The drain after an inline success is an idempotent no-op: no second remote write
    // beyond the confirm's own retain.
    const retainsAfterConfirm = scripted.retains.length;
    expect(retainsAfterConfirm).toBe(1);
    const report = await queue.drain();
    expect(report.alreadyIndexed).toBe(1);
    expect(scripted.retains.length).toBe(retainsAfterConfirm);

    const status = await queue.syncStatus(TENANT, "preference", record.id);
    expect(status).toEqual({ state: "indexed", syncedAt: expect.any(Date) });
  });

  test("an edit records the new content's work under the same identity", async () => {
    const scope = await makeTrustedScope();
    const { record } = await service.confirmGenericPreference(scope, {
      content: `编辑前 ${run}`,
    });
    await service.editGenericPreference(scope, record.id, {
      content: `编辑后 ${run}`,
    });
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.id, record.id),
        ),
      )
      .limit(1);
    expect(row.hindsightDocumentId).toBe(
      preferenceDocumentIdFor(TENANT, record.id),
    );
    expect(await pendingWorkCount(TENANT, "preference", record.id)).toBe(1);
  });
});

describe("Hindsight 07 (#384): transient failure recovers, never lies", () => {
  test("a failed retain stays pending, reports failed, and resyncs after recovery", async () => {
    const scope = await makeTrustedScope();
    scripted.state.retainStatus = 500;
    const { record, remoteSynced } = await service.confirmGenericPreference(scope, {
      content: `失败后重试的偏好 ${run}`,
    });
    expect(remoteSynced).toBe(false);

    // Pending before any attempt; failed — never "indexed" — after one.
    expect(await queue.syncStatus(TENANT, "preference", record.id)).toEqual({
      state: "pending",
      attempts: 0,
    });
    const failedDrain = await queue.drain();
    expect(failedDrain.failed).toBe(1);
    const afterFailure = await queue.syncStatus(
      TENANT,
      "preference",
      record.id,
    );
    expect(afterFailure.state).toBe("failed");
    if (afterFailure.state === "failed") {
      expect(afterFailure.attempts).toBe(1);
      expect(afterFailure.lastError).toContain("500");
      expect(afterFailure.willRetry).toBe(true);
    }

    // Recovery: the next drain completes the sync automatically.
    scripted.state.retainStatus = 202;
    scripted.retains.length = 0;
    const recovered = await queue.drain();
    expect(recovered.synced).toBe(1);
    expect(scripted.retains.length).toBe(1);
    expect(scripted.retains[0].body.items[0].content).toBe(
      `失败后重试的偏好 ${run}`,
    );
    expect(scripted.retains[0].body.items[0].document_id).toBe(
      preferenceDocumentIdFor(TENANT, record.id),
    );
    expect(await queue.syncStatus(TENANT, "preference", record.id)).toEqual({
      state: "indexed",
      syncedAt: expect.any(Date),
    });
  });
});

describe("Hindsight 07 (#384): duplicates collapse, stale tasks cannot win", () => {
  test("re-enqueueing pending work refreshes it instead of adding a task", async () => {
    const scope = await makeTrustedScope();
    scripted.state.retainStatus = 500;
    const { record } = await service.confirmGenericPreference(scope, {
      content: `重复任务偏好 ${run}`,
    });
    await queue.drain(); // one failed attempt; work stays pending
    // A duplicate enqueue of the same subject and digest:
    await queue.record({
      subjectType: "preference",
      tenantId: TENANT,
      subjectId: record.id,
      principalId: PRINCIPAL,
      contentDigest: createHash("sha256")
        .update(`重复任务偏好 ${run}`)
        .digest("hex"),
    });
    expect(await pendingWorkCount(TENANT, "preference", record.id)).toBe(1);

    scripted.state.retainStatus = 202;
    scripted.retains.length = 0;
    const report = await queue.drain();
    expect(report.synced).toBe(1);
    // One subject, one remote write — the duplicate did not double it.
    expect(scripted.retains.length).toBe(1);
  });

  test("a task standing for older content is superseded, never retained", async () => {
    // The re-enqueue path refreshes the single pending task, so a task with stale content
    // reaches the drain only through the in-flight window (task loaded, edit lands). Model
    // that directly: an authority row whose content moved on, and a task still standing for
    // the older digest — exactly what the drain must refuse to send.
    const id = randomUUID();
    await database.insert(genericPersonalPreferences).values({
      tenantId: TENANT,
      id,
      principalId: PRINCIPAL,
      content: `新内容 ${run}`,
      provenance: "seed",
      reviewState: "edited",
      enabled: true,
      markedGenericAt: new Date(),
      hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
    });
    await database.insert(hindsightSyncWork).values({
      tenantId: TENANT,
      id: randomUUID(),
      subjectType: "preference",
      subjectId: id,
      principalId: PRINCIPAL,
      expectedDigest: createHash("sha256").update(`旧内容 ${run}`).digest("hex"),
      state: "pending",
    });

    scripted.retains.length = 0;
    const report = await queue.drain();
    expect(report.superseded).toBe(1);
    expect(scripted.retains.length).toBe(0);

    const [work] = await database
      .select()
      .from(hindsightSyncWork)
      .where(
        and(
          eq(hindsightSyncWork.tenantId, TENANT),
          eq(hindsightSyncWork.subjectId, id),
          eq(hindsightSyncWork.state, "superseded"),
        ),
      )
      .limit(1);
    expect(work).toBeDefined();
    // Not indexed, and not retried: the stale task is closed.
    expect((await queue.syncStatus(TENANT, "preference", id)).state).toBe(
      "pending",
    );

    // The same row enqueued for its CURRENT content drains normally: only new content
    // is ever sent.
    await queue.record({
      subjectType: "preference",
      tenantId: TENANT,
      subjectId: id,
      principalId: PRINCIPAL,
      contentDigest: createHash("sha256").update(`新内容 ${run}`).digest("hex"),
    });
    const second = await queue.drain();
    expect(second.synced).toBe(1);
    expect(scripted.retains.length).toBe(1);
    expect(scripted.retains[0].body.items[0].content).toBe(`新内容 ${run}`);
    expect(await queue.syncStatus(TENANT, "preference", id)).toEqual({
      state: "indexed",
      syncedAt: expect.any(Date),
    });
  });
});

describe("Hindsight 07 (#384): only confirmed, currently-authorized content is sent", () => {
  test("unreviewed and paused rows are skipped without a remote call", async () => {
    for (const seed of [
      { reviewState: "unreviewed" as const, enabled: true },
      { reviewState: "confirmed" as const, enabled: false },
    ]) {
      const id = randomUUID();
      await database.insert(genericPersonalPreferences).values({
        tenantId: TENANT,
        id,
        principalId: PRINCIPAL,
        content: `不应发送的内容 ${run}`,
        provenance: "seed",
        reviewState: seed.reviewState,
        enabled: seed.enabled,
        markedGenericAt: new Date(),
        hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
      });
      await queue.record({
        subjectType: "preference",
        tenantId: TENANT,
        subjectId: id,
        principalId: PRINCIPAL,
        contentDigest: "0".repeat(64),
      });
    }
    scripted.retains.length = 0;
    const report = await queue.drain();
    expect(report.nothingToDo).toBe(2);
    expect(scripted.retains.length).toBe(0);
  });

  test("ownership is re-verified at task time", async () => {
    const id = randomUUID();
    await database.insert(genericPersonalPreferences).values({
      tenantId: TENANT,
      id,
      principalId: PRINCIPAL,
      content: `归属重核 ${run}`,
      provenance: "seed",
      reviewState: "confirmed",
      enabled: true,
      markedGenericAt: new Date(),
      hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
    });
    // Work claiming another principal owns this row — the drain must refuse to send.
    await database.insert(hindsightSyncWork).values({
      tenantId: TENANT,
      id: randomUUID(),
      subjectType: "preference",
      subjectId: id,
      principalId: `prin_someone-else-${run}`,
      expectedDigest: "0".repeat(64),
      state: "pending",
    });
    scripted.retains.length = 0;
    const report = await queue.drain();
    expect(report.nothingToDo).toBe(1);
    expect(scripted.retains.length).toBe(0);
    const status = await queue.syncStatus(TENANT, "preference", id);
    // Not indexed, and not silently retried either: the work is closed as done.
    expect(status.state).not.toBe("indexed");
  });

  test("an unauthorized source-bound restriction defers; re-authorization resyncs", async () => {
    const id = randomUUID();
    await database.insert(sourceBoundMemories).values({
      tenantId: TENANT,
      id,
      principalId: PRINCIPAL,
      restriction: "team",
      workspaceId: WORKSPACE,
      sourceId: null,
      agentId: null,
      content: `来源受限待同步 ${run}`,
      provenance: "seed",
      reviewState: "confirmed",
      enabled: true,
      hindsightDocumentId: sourceBoundDocumentIdFor(TENANT, id),
    });
    await queue.record({
      subjectType: "source_bound",
      tenantId: TENANT,
      subjectId: id,
      principalId: PRINCIPAL,
      contentDigest: createHash("sha256")
        .update(`来源受限待同步 ${run}`)
        .digest("hex"),
    });

    // Membership suspended: the restriction is not currently authorized — nothing is sent.
    await database
      .update(enterpriseWorkspaceMemberships)
      .set({ status: "suspended" })
      .where(
        eq(enterpriseWorkspaceMemberships.workspaceId, WORKSPACE),
      );
    scripted.retains.length = 0;
    const deferred = await queue.drain();
    expect(deferred.deferred).toBe(1);
    expect(scripted.retains.length).toBe(0);
    expect(await pendingWorkCount(TENANT, "source_bound", id)).toBe(1);

    // Re-authorized: the same pending work syncs into the team bank.
    await database
      .update(enterpriseWorkspaceMemberships)
      .set({ status: "active" })
      .where(eq(enterpriseWorkspaceMemberships.workspaceId, WORKSPACE));
    const synced = await queue.drain();
    expect(synced.synced).toBe(1);
    expect(scripted.retains.length).toBe(1);
    expect(scripted.retains[0].bank).toMatch(/^ob_t_[0-9a-f]{16}$/);
    expect(await queue.syncStatus(TENANT, "source_bound", id)).toEqual({
      state: "indexed",
      syncedAt: expect.any(Date),
    });
  });
});
