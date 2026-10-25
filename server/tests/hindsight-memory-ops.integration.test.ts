import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { AppVariables } from "../src/auth/guards";
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
import { hindsightMemoryGrants } from "../src/db/schema/hindsight-source-bound";
import { hindsightSyncWork } from "../src/db/schema/hindsight-sync";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
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
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import { createRevocationService } from "../src/hindsight/revocation";
import { createDrizzleRevocationLedger } from "../src/hindsight/revocation-ledger";
import { createHindsightMemoryRoutes } from "../src/hindsight/routes";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import {
  MemorySensitivityRefusedError,
  SENSITIVE_CONFIRMATION_REQUIRED,
} from "../src/hindsight/sensitivity-gate";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import type { MemoryIngestion } from "../src/memory/ingestion";
import { createMemoryRoutes } from "../src/memory/routes";
import { CREDENTIAL_REFUSAL } from "../src/memory/sensitivity";
import { createMemoryStore } from "../src/memory/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * FIX-W2 (Run 2026-10-24-hindsight-376, audit G3-F2 + F-G1-4): the Hindsight chain's
 * production write/status surface, exercised through the REAL routes over the real authority
 * tables and a scripted Hindsight service.
 *
 * One describe per acceptance clause of the brief:
 *
 * 1. End to end: a confirm writes the authority row and a durable work row; the drain's
 *    retain lands and the status surface answers `indexed` (truthfully — the row's retained
 *    digest equals its current content). During an outage the confirm still succeeds, the
 *    status is pending and then failed — never indexed — and the drain after recovery
 *    completes the sync.
 * 2. Forgetting: recall is empty the instant the block lands — through the indexed seam AND
 *    through the degraded (SQL fallback) path — the remote deletion rides the revocation
 *    ledger's retry drain, and a stale pending sync task must not rebuild remotely what the
 *    person forgot.
 * 3. The chain-side sensitivity gate (F-G1-4): a credential is refused with an answer and an
 *    audit trace (the class only — never the bytes), and medical/financial/customer material
 *    is stored only with the person's explicit second confirmation; all three chain confirm
 *    paths (preferences, source-bound, derived judgments) answer to the same gate.
 * 4. The status surface stays self-scoped: another principal's subject answers
 *    `unknown-subject`, the same as a missing one.
 *
 * The mount is the production one: `createMemoryRoutes` with the hindsight sub-routes, behind
 * the family's `requireUser` + body limit (stubbed here the way the seam tests stub it —
 * the identity these routes act for comes from the scope resolver, minted the production way
 * over a controlled directory database so the trusted marker is real).
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_fixw2-${run}`;
const WORKSPACE = `ws_fixw2-${run}`;
const PRINCIPAL = `prin_fixw2-a-${run}`;
const PRINCIPAL_OTHER = `prin_fixw2-b-${run}`;
const SOURCE = `src_fixw2-${run}`;
const GLOBAL_ACTOR = `usr_fixw2-actor-${run}`;
const SECRET = `fixw2-secret-${run}`;
const SERVICE_KEY = `fixw2-key-${run}`;

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
};
type CapturedRetain = {
  bank: string;
  documentId: string;
  content: string;
};

type ScriptedState = {
  recall: { status: number; body: unknown };
  retainStatus: number;
  deleteStatus: number;
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  retains: CapturedRetain[];
  deletes: { bank: string; documentId: string }[];
  state: ScriptedState;
};

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const retains: CapturedRetain[] = [];
  const deletes: { bank: string; documentId: string }[] = [];
  const state: ScriptedState = {
    recall: { status: 200, body: { results: [] } },
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
      calls.push({ method: request.method ?? "", path, body });
      const bank = /\/banks\/([^/]+)\//.exec(path)?.[1] ?? "";
      if (request.method === "POST" && path.endsWith("/memories/recall")) {
        response.writeHead(state.recall.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(state.recall.body));
        return;
      }
      if (request.method === "POST" && path.endsWith("/memories")) {
        const items = (
          body as { items?: { document_id: string; content: string }[] }
        )?.items;
        retains.push({
          bank,
          documentId: items?.[0]?.document_id ?? "",
          content: items?.[0]?.content ?? "",
        });
        response.writeHead(state.retainStatus, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ accepted: 1 }));
        return;
      }
      if (request.method === "DELETE" && path.includes("/documents/")) {
        deletes.push({
          bank,
          documentId: decodeURIComponent(path.split("/documents/")[1] ?? ""),
        });
        response.writeHead(state.deleteStatus, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ deleted: true }));
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
    calls,
    retains,
    deletes,
    state,
  };
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

async function makeTrustedScope(principalId: string): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: GLOBAL_ACTOR,
    email: `fixw2-${run}@example.invalid`,
    name: `FIX-W2 ${run}`,
    image: null,
    role: "user",
  });
  await next();
};

type CapturedAuditEvent = {
  eventType: string;
  targetType: string;
  targetId?: string;
  actorUserId?: string;
  payload: Record<string, unknown>;
};
const auditTrail: CapturedAuditEvent[] = [];

let api: Hono;
let queue: ReturnType<typeof createHindsightSyncQueue>;
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let revocations: ReturnType<typeof createRevocationService>;
let facade: ReturnType<typeof createDegradedRecallFacade>;
let proposals: ReturnType<typeof createDerivedJudgmentService>;
let review: ReturnType<typeof createDerivedJudgmentReviewService>;
let scope: PlatformScope;

/** Which principal the next request acts for; production reads this from issued facts. */
let currentPrincipal = PRINCIPAL;

async function pendingWorkCount(
  subjectType: "preference" | "source_bound" | "derived_judgment",
  subjectId: string,
): Promise<number> {
  const rows = await database
    .select({ id: hindsightSyncWork.id })
    .from(hindsightSyncWork)
    .where(
      and(
        eq(hindsightSyncWork.tenantId, TENANT),
        eq(hindsightSyncWork.subjectType, subjectType),
        eq(hindsightSyncWork.subjectId, subjectId),
        eq(hindsightSyncWork.state, "pending"),
      ),
    );
  return rows.length;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

const postPreferences = (body: unknown) =>
  api.request("/api/memory/hindsight/preferences", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
const patchPreference = (id: string, body: unknown) =>
  api.request(`/api/memory/hindsight/preferences/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
const deletePreference = (id: string) =>
  api.request(`/api/memory/hindsight/preferences/${id}`, { method: "DELETE" });
const getStatus = (subjectType: string, subjectId: string) =>
  api.request(`/api/memory/hindsight/status/${subjectType}/${subjectId}`);

async function readStatus(subjectType: string, subjectId: string) {
  const response = await getStatus(subjectType, subjectId);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    status: Record<string, unknown>;
  };
  return payload.status;
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: `usr_fixw2-a-${run}`, email: `fixw2-a-${run}@example.invalid` },
    { id: `usr_fixw2-b-${run}`, email: `fixw2-b-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `FIX-W2 ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL, userId: `usr_fixw2-a-${run}` },
    { id: PRINCIPAL_OTHER, userId: `usr_fixw2-b-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_OTHER, role: "member" },
  ]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE, name: `FIX-W2 team ${run}` }]);
  await database
    .insert(enterpriseWorkspaceMemberships)
    .values([
      { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL },
    ]);
  await database.insert(hindsightMemoryGrants).values([
    {
      tenantId: TENANT,
      principalId: PRINCIPAL,
      kind: "source",
      targetId: SOURCE,
    },
  ]);

  scripted = await bootScriptedHindsight();
  const config = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  };
  const preferenceRecords = createDrizzlePreferenceRecords(database);
  const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
  const authorizations = createDrizzleSourceBoundAuthorizations(database);
  const ledger = createDrizzleRevocationLedger(database);
  queue = createHindsightSyncQueue(database, config, { authorizations });
  // The production shape (index.ts G3-F2 wiring): the confirm seams carry the queue, the
  // forget seams carry the revocation ledger.
  preferences = createPreferenceRecallService(preferenceRecords, config, {
    work: queue,
    revocations: ledger,
  });
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    config,
    { work: queue, revocations: ledger },
  );
  revocations = createRevocationService(database, config);
  facade = createDegradedRecallFacade(
    preferences,
    scoped,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    authorizations,
  );
  const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
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
    config,
    { work: queue },
  );

  api = new Hono();
  api.route(
    "/api/memory",
    createMemoryRoutes(
      createMemoryStore(database),
      // The /sources surface this suite never touches; the hindsight sub-routes are its subject.
      {} as unknown as MemoryIngestion,
      requireUser,
      {
        hindsight: createHindsightMemoryRoutes({
        preferences,
        sourceBound: scoped,
        syncQueue: queue,
        resolveScope: () => makeTrustedScope(currentPrincipal),
        audit: {
          record: async (event) => {
            auditTrail.push(event);
          },
        },
      }),
      },
    ),
  );
  scope = await makeTrustedScope(PRINCIPAL);
});

afterAll(async () => {
  if (!scripted) return;
  // Complete every pending work row this suite recorded (successful eager retains leave
  // theirs pending), so the shared database never hands another suite's drain a straggler.
  scripted.state.retainStatus = 202;
  await queue.drain({ limit: 500 });
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.retains.length = 0;
  scripted.deletes.length = 0;
  scripted.state.recall = { status: 200, body: { results: [] } };
  scripted.state.retainStatus = 202;
  scripted.state.deleteStatus = 204;
  auditTrail.length = 0;
  currentPrincipal = PRINCIPAL;
});

describe("FIX-W2 end to end: confirm → work row → drain → status (G3-F2)", () => {
  test("a confirm writes the row and the work, and the drain answers indexed", async () => {
    const response = await postPreferences({ content: `周报偏好 ${run}` });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      preference: { id: string };
      remoteSynced: boolean;
    };
    // The inline retain succeeded, so the surface may already answer indexed — truthfully,
    // because the row's retained digest equals its content.
    expect(payload.remoteSynced).toBe(true);
    expect(scripted.retains).toHaveLength(1);
    expect(await pendingWorkCount("preference", payload.preference.id)).toBe(1);
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });

    // The drain after an inline success is the idempotent no-op: no second remote write.
    const report = await queue.drain();
    expect(report.alreadyIndexed).toBe(1);
    expect(scripted.retains).toHaveLength(1);
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });
  });

  test("an outage fails neither the confirm nor the answer, and recovery re-syncs", async () => {
    scripted.state.retainStatus = 503;
    const response = await postPreferences({ content: `宕机期偏好 ${run}` });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      preference: { id: string };
      remoteSynced: boolean;
    };
    expect(payload.remoteSynced).toBe(false);
    expect(await pendingWorkCount("preference", payload.preference.id)).toBe(1);
    // Before any attempt: pending, never "indexed".
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "pending",
      attempts: 0,
    });
    const failedDrain = await queue.drain();
    expect(failedDrain.failed).toBe(1);
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "failed",
      attempts: 1,
      lastError: expect.stringContaining("503"),
      willRetry: true,
    });

    // Recovery: the next drain retains through the derived user bank and reports indexed. The
    // capture counts ATTEMPTS (the inline try and the failed drain included); the last one is
    // the drain's successful retain.
    scripted.state.retainStatus = 202;
    const recovered = await queue.drain();
    expect(recovered.synced).toBe(1);
    expect(scripted.retains).toHaveLength(3);
    expect(scripted.retains.at(-1)?.documentId).toBe(
      preferenceDocumentIdFor(TENANT, payload.preference.id),
    );
    expect(scripted.retains.at(-1)?.content).toBe(`宕机期偏好 ${run}`);
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });
  });
});

describe("FIX-W2 forgetting: immediate block, deletion task, no resurrection", () => {
  test("forget empties both recall paths at once and the deletion rides the ledger", async () => {
    const confirm = await postPreferences({ content: `遗忘目标偏好 ${run}` });
    const { preference } = (await confirm.json()) as {
      preference: { id: string };
    };
    const documentId = preferenceDocumentIdFor(TENANT, preference.id);
    scripted.state.deleteStatus = 500;

    const forgotten = await deletePreference(preference.id);
    expect(forgotten.status).toBe(200);
    const status = (await forgotten.json()) as {
      remoteDeletion: { attempted: boolean; outstanding: number };
    };
    // The block landed before the delete was initiated; the failed remote call is the
    // ledger's retry work, reported honestly as outstanding.
    expect(status.remoteDeletion).toEqual({ attempted: true, outstanding: 1 });
    const [ledgerRow] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      )
      .limit(1);
    expect(ledgerRow?.kind).toBe("memory");
    expect(ledgerRow?.subjectType).toBe("preference");
    expect(ledgerRow?.deletionState).toBe("failed");

    // The indexed seam: even when the service still hands the document id back, the
    // tombstoned row is dropped before anything reaches a Bot.
    scripted.state.recall = {
      status: 200,
      body: { results: [{ document_id: documentId }] },
    };
    expect(
      await preferences.recallGenericPreferences(scope, { query: "遗忘" }),
    ).toEqual([]);
    // The degraded path: the service is unreachable, the SQL fallback takes over — a query
    // that text-matches the original content still answers empty, because the row is gone.
    scripted.state.recall = { status: 503, body: {} };
    const degraded = await facade.recallGenericPreferences(scope, {
      query: "遗忘目标偏好",
    });
    expect(degraded.degraded).toBe(true);
    expect(degraded.memories).toEqual([]);

    // The outstanding deletion retries on the ledger's drain once the service answers.
    scripted.state.deleteStatus = 204;
    const retry = await revocations.retryOutstandingDeletions({
      tenantId: TENANT,
    });
    expect(retry.confirmed).toBe(1);
    expect(scripted.deletes).toHaveLength(2);
    expect(scripted.deletes[1]?.documentId).toBe(documentId);
    // The confirm's pending work is consumed here (the row is gone: nothing to send), so the
    // next test's drain sees only its own work.
    await queue.drain();
  });

  test("a stale pending sync task must not rebuild what the person forgot", async () => {
    // The confirm lands while the service is down: the work stays pending.
    scripted.state.retainStatus = 503;
    const confirm = await postPreferences({
      content: `先同步失败后遗忘 ${run}`,
    });
    const { preference } = (await confirm.json()) as {
      preference: { id: string };
    };
    const documentId = preferenceDocumentIdFor(TENANT, preference.id);
    expect(await pendingWorkCount("preference", preference.id)).toBe(1);
    // The confirm's own inline attempt was captured (and refused with 503); what must not
    // happen is a retain attempt AFTER the block.
    const attemptsBeforeForget = scripted.retains.filter(
      (retain) => retain.documentId === documentId,
    ).length;
    expect(attemptsBeforeForget).toBe(1);

    // Forgetting comes first; the service recovers only afterwards.
    scripted.state.retainStatus = 202;
    const forgotten = await deletePreference(preference.id);
    expect(forgotten.status).toBe(200);

    const report = await queue.drain();
    expect(report.nothingToDo).toBe(1);
    // The pending task finished without a remote call: nothing was re-sent after the block.
    expect(
      scripted.retains.filter((retain) => retain.documentId === documentId),
    ).toHaveLength(attemptsBeforeForget);
    expect(await pendingWorkCount("preference", preference.id)).toBe(0);
    await expect(
      readStatus("preference", preference.id),
    ).resolves.not.toMatchObject({ state: "indexed" });
  });

  test("forgetting a source-bound memory blocks it and retries the remote deletion", async () => {
    const confirm = await api.request("/api/memory/hindsight/source-bound", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        content: `来源受限遗忘 ${run}`,
        restriction: { kind: "source", sourceId: SOURCE },
      }),
    });
    expect(confirm.status).toBe(201);
    const { memory } = (await confirm.json()) as { memory: { id: string } };
    const documentId = sourceBoundDocumentIdFor(TENANT, memory.id);

    scripted.state.deleteStatus = 500;
    const forgotten = await api.request(
      `/api/memory/hindsight/source-bound/${memory.id}`,
      { method: "DELETE" },
    );
    expect(forgotten.status).toBe(200);
    const status = (await forgotten.json()) as {
      remoteDeletion: { attempted: boolean; outstanding: number };
    };
    expect(status.remoteDeletion).toEqual({ attempted: true, outstanding: 1 });
    const [ledgerRow] = await database
      .select()
      .from(hindsightRevocations)
      .where(
        and(
          eq(hindsightRevocations.tenantId, TENANT),
          eq(hindsightRevocations.documentId, documentId),
        ),
      )
      .limit(1);
    expect(ledgerRow?.subjectType).toBe("source_bound");

    scripted.state.deleteStatus = 204;
    const retry = await revocations.retryOutstandingDeletions({
      tenantId: TENANT,
    });
    expect(retry.confirmed).toBe(1);
    // Consume this confirm's pending work (the row is gone: nothing to send).
    await queue.drain();
  });
});

describe("FIX-W2 sensitivity gate (F-G1-4): credentials never, sensitive twice", () => {
  test("a credential is refused with an answer and a trail, and nothing is stored or sent", async () => {
    const credential = "My password is hunter2neverstored";
    const response = await postPreferences({ content: credential });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: CREDENTIAL_REFUSAL });

    // No authority row, no work, no remote call.
    const leaked = await database
      .select({ id: genericPersonalPreferences.id })
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.principalId, PRINCIPAL),
          eq(genericPersonalPreferences.content, credential),
        ),
      );
    expect(leaked).toHaveLength(0);
    expect(scripted.retains).toHaveLength(0);

    // The trail holds the refusal — the class, never the bytes.
    expect(auditTrail).toHaveLength(1);
    expect(auditTrail[0]).toEqual({
      eventType: "memory.sensitivity_refused",
      targetType: "memory",
      actorUserId: GLOBAL_ACTOR,
      payload: { subjectType: "preference", sensitivity: "credential" },
    });
    expect(JSON.stringify(auditTrail)).not.toContain("hunter2neverstored");
  });

  test("the source-bound confirm path refuses a credential the same way", async () => {
    const response = await api.request("/api/memory/hindsight/source-bound", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        content: "The API key is sk-live-abcdef1234567890",
        restriction: { kind: "source", sourceId: SOURCE },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: CREDENTIAL_REFUSAL });
    expect(auditTrail).toHaveLength(1);
    expect(auditTrail[0]?.payload).toEqual({
      subjectType: "source_bound",
      sensitivity: "credential",
    });
    expect(scripted.retains).toHaveLength(0);
  });

  test("sensitive content needs the second confirmation to be stored and indexed", async () => {
    const sensitive = "Diagnosed with diabetes last month";
    const refused = await postPreferences({ content: sensitive });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: SENSITIVE_CONFIRMATION_REQUIRED,
    });
    const stored = await database
      .select({ id: genericPersonalPreferences.id })
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.principalId, PRINCIPAL),
          eq(genericPersonalPreferences.content, sensitive),
        ),
      );
    expect(stored).toHaveLength(0);
    expect(auditTrail[0]?.payload).toEqual({
      subjectType: "preference",
      sensitivity: "medical",
    });

    // The person's explicit second confirmation is the ask AND the second look.
    const confirmed = await postPreferences({
      content: sensitive,
      confirmSensitive: true,
    });
    expect(confirmed.status).toBe(201);
    const payload = (await confirmed.json()) as {
      preference: { id: string };
      remoteSynced: boolean;
    };
    expect(payload.remoteSynced).toBe(true);
    expect(scripted.retains[0]?.content).toBe(sensitive);
    await expect(
      readStatus("preference", payload.preference.id),
    ).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });
    await queue.drain();
  });

  test("an edit answers to the same gate and a refused edit keeps the original", async () => {
    const confirm = await postPreferences({ content: `普通编辑基线 ${run}` });
    const { preference } = (await confirm.json()) as {
      preference: { id: string };
    };

    const credentialEdit = await patchPreference(preference.id, {
      content: "My password is hunter2edited",
    });
    expect(credentialEdit.status).toBe(400);
    expect(await credentialEdit.json()).toEqual({ error: CREDENTIAL_REFUSAL });
    const sensitiveEdit = await patchPreference(preference.id, {
      content: "My salary is 120000 a year",
    });
    expect(sensitiveEdit.status).toBe(400);
    expect(await sensitiveEdit.json()).toEqual({
      error: SENSITIVE_CONFIRMATION_REQUIRED,
    });

    // Both refused edits left the confirmed original untouched, still indexed.
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.id, preference.id),
        ),
      )
      .limit(1);
    expect(row?.content).toBe(`普通编辑基线 ${run}`);
    expect(row?.reviewState).toBe("confirmed");
    await expect(readStatus("preference", preference.id)).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });

    const accepted = await patchPreference(preference.id, {
      content: "My salary is 120000 a year",
      confirmSensitive: true,
    });
    expect(accepted.status).toBe(200);
    await queue.drain();
  });

  test("the derived-judgment confirm path answers to the same gate", async () => {
    const first = await preferences.confirmGenericPreference(scope, {
      content: `判断依据甲 ${run}`,
    });
    const second = await preferences.confirmGenericPreference(scope, {
      content: `判断依据乙 ${run}`,
    });
    const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: "diagnosed with diabetes recently",
      evidence: [
        preferenceDocumentIdFor(TENANT, first.record.id),
        preferenceDocumentIdFor(TENANT, second.record.id),
      ],
    });
    await expect(
      review.confirmDerivedJudgment(scope, candidate.id),
    ).rejects.toBeInstanceOf(MemorySensitivityRefusedError);

    const adopted = await review.confirmDerivedJudgment(scope, candidate.id, {
      confirmSensitive: true,
    });
    expect(adopted.remoteSynced).toBe(true);
    expect(await pendingWorkCount("derived_judgment", candidate.id)).toBe(1);
    await queue.drain();
  });
});

describe("FIX-W2 status surface: self-scoped, never over-claiming", () => {
  test("another principal's subject answers unknown-subject, like a missing one", async () => {
    const confirm = await postPreferences({ content: `归属隔离偏好 ${run}` });
    const { preference } = (await confirm.json()) as {
      preference: { id: string };
    };

    currentPrincipal = PRINCIPAL_OTHER;
    await expect(readStatus("preference", preference.id)).resolves.toEqual({
      state: "unknown-subject",
    });
    await expect(readStatus("preference", `missing-${run}`)).resolves.toEqual({
      state: "unknown-subject",
    });
    // The same subject, asked by its owner, answers truthfully.
    currentPrincipal = PRINCIPAL;
    await expect(readStatus("preference", preference.id)).resolves.toEqual({
      state: "indexed",
      syncedAt: expect.any(String),
    });
    // A type this surface does not name is a refusal, not a guess.
    const unknown = await getStatus("not_a_subject", preference.id);
    expect(unknown.status).toBe(400);
    await queue.drain();
  });

  /*
   * FIX-OCR1 (OCR-M5, #376): the settings page's memory badges read their statuses as one
   * batched request for the whole list, keyed `${subjectType}:${subjectId}` — same facts,
   * same self-scoping, same refusal vocabulary as the single read beside it.
   */
  test("a batched read answers the whole list once, self-scoped the same way", async () => {
    const confirm = await postPreferences({ content: `批量状态偏好 ${run}` });
    const { preference } = (await confirm.json()) as {
      preference: { id: string };
    };

    const batched = await api.request("/api/memory/hindsight/status/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        subjects: [
          { subjectType: "preference", subjectId: preference.id },
          { subjectType: "preference", subjectId: `missing-${run}` },
        ],
      }),
    });
    expect(batched.status).toBe(200);
    expect(await batched.json()).toEqual({
      statuses: {
        [`preference:${preference.id}`]: {
          state: "indexed",
          syncedAt: expect.any(String),
        },
        [`preference:missing-${run}`]: { state: "unknown-subject" },
      },
    });

    // Another principal's batch answers unknown-subject across the board — a foreign
    // subject is never told apart from one that never existed.
    currentPrincipal = PRINCIPAL_OTHER;
    const foreign = await api.request("/api/memory/hindsight/status/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        subjects: [{ subjectType: "preference", subjectId: preference.id }],
      }),
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({
      statuses: {
        [`preference:${preference.id}`]: { state: "unknown-subject" },
      },
    });
    currentPrincipal = PRINCIPAL;

    // The read's bounds and vocabulary: an oversized batch, and a subject of a type the
    // surface does not name, are refusals — never a partial or guessed answer.
    const oversized = await api.request("/api/memory/hindsight/status/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        subjects: Array.from({ length: 201 }, () => ({
          subjectType: "preference",
          subjectId: preference.id,
        })),
      }),
    });
    expect(oversized.status).toBe(400);
    const shapeless = await api.request("/api/memory/hindsight/status/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        subjects: [{ subjectType: "not_a_subject", subjectId: "x" }],
      }),
    });
    expect(shapeless.status).toBe(400);
    await queue.drain();
  });
});
