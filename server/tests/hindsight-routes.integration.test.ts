import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  afterAll,
  afterEach,
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
import { hindsightBackupRestores } from "../src/db/schema/hindsight-restore";
import { hindsightControlledBackups } from "../src/db/schema/hindsight-restore";
import { derivedJudgmentCandidates } from "../src/db/schema/hindsight-judgments";
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import { hindsightMemoryGrants } from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { createAnswerEvidenceService } from "../src/hindsight/answer-evidence";
import { reconcileControlledBackups } from "../src/hindsight/backup-registry";
import { sourceBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  CONTROLLED_COPIES_CLEARED_SUMMARY,
  createCleanupEvidenceService,
} from "../src/hindsight/cleanup-evidence";
import {
  createDerivedJudgmentService,
  createDrizzleDerivedJudgmentRecords,
  derivedJudgmentDocumentIdFor,
} from "../src/hindsight/derived-judgments";
import { createDerivedJudgmentReviewService } from "../src/hindsight/judgment-review";
import { createDrizzlePauseControls } from "../src/hindsight/pause-controls";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import { createRestoreRecoveryService } from "../src/hindsight/restore-recovery";
import { createRevocationService } from "../src/hindsight/revocation";
import {
  createDrizzleRevocationLedger,
  STOPPED_USING_SUMMARY,
} from "../src/hindsight/revocation-ledger";
import { createHindsightRoutes } from "../src/hindsight/routes";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The /api/hindsight route family over the real seams, the real authority tables and the real
 * tenancy resolver — one describe per acceptance clause of the wiring ticket (RG4-1 +
 * G5-F1 tail):
 *
 * 1. Every personal entry answers for the caller alone: own bases expand, foreign / missing /
 *    unreviewed / de-authorized ones stay contentless, and no request field can name another
 *    subject's placement.
 * 2. The judgment review routes (list / propose / confirm / edit / reject / forget) work
 *    end to end; forget blocks immediately and records its revocation honestly.
 * 3. The source-revocation route blocks only the caller's feed.
 * 4. Cleanup evidence shows "受控副本清除完成" only when all three legs hold.
 * 5. The operator restore gate and backup registration are admin-only and content-free.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_routes-${run}`;
const WORKSPACE_A = `ws_routes-a-${run}`;
const WORKSPACE_B = `ws_routes-b-${run}`;
const PRINCIPAL_EMP = `prin_routes-emp-${run}`;
const PRINCIPAL_PEER = `prin_routes-peer-${run}`;
const PRINCIPAL_ADMIN = `prin_routes-admin-${run}`;
const ACTOR_EMP = `usr_routes-emp-${run}`;
const ACTOR_PEER = `usr_routes-peer-${run}`;
const ACTOR_ADMIN = `usr_routes-admin-${run}`;
const SOURCE_ONE = `src_routes-${run}`;
const SECRET = `routes-assertion-secret-${run}`;
const SERVICE_KEY = `routes-service-key-${run}`;

const USER_BANK_EMP = userBankFor(PRINCIPAL_EMP);

type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  bank: string;
};

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  retainStatus: number;
  deleteStatus: number;
  /** Document ids the service answers 200 for on the absence probe (restores, stray copies). */
  documentsPresent: Set<string>;
  /** document_id → memory units still referencing it. */
  unitsByDocument: Map<string, number>;
  /** bank → terminal operations the service still holds. */
  operationsByBank: Map<string, { created_at: string }[]>;
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let serviceConfig: {
  apiUrl: string;
  serviceApiKey: string;
  assertionSecret: string;
  requestTimeoutMs: number;
};
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let proposals: ReturnType<typeof createDerivedJudgmentService>;
let review: ReturnType<typeof createDerivedJudgmentReviewService>;
let evidence: ReturnType<typeof createAnswerEvidenceService>;
let revocations: ReturnType<typeof createRevocationService>;
let recovery: ReturnType<typeof createRestoreRecoveryService>;
let cleanup: ReturnType<typeof createCleanupEvidenceService>;

/** The declared operation-retention window the cleanup leg measures against; per-test mutable. */
let declaredOperationRetentionDays: number | null = 1;
/** The backup manifest directory the routes reconcile; per-test mutable. */
let currentManifestDir: string | null = null;

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
    deleteStatus: 204,
    documentsPresent: new Set(),
    unitsByDocument: new Map(),
    operationsByBank: new Map(),
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
      const url = new URL(request.url ?? "/", "http://scripted.invalid");
      const path = url.pathname;
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
      } else if (request.method === "GET" && /\/documents\/[^/]+$/.test(path)) {
        const documentId = decodeURIComponent(
          path.slice(path.lastIndexOf("/") + 1),
        );
        status = state.documentsPresent.has(documentId) ? 200 : 404;
        payload = state.documentsPresent.has(documentId)
          ? { document: { document_id: documentId } }
          : { error: "absent" };
      } else if (request.method === "GET" && path.endsWith("/memories/list")) {
        status = 200;
        const documentId = url.searchParams.get("document_id") ?? "";
        const remaining = state.unitsByDocument.get(documentId) ?? 0;
        payload = {
          items: Array.from({ length: remaining }, (_v, index) => ({
            id: `${documentId}-unit-${index}`,
          })),
        };
      } else if (request.method === "GET" && path.endsWith("/operations")) {
        status = 200;
        const operations = state.operationsByBank.get(bank) ?? [];
        payload = { operations, total: operations.length };
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

// The controlled-directory technique from hindsight-judgment-review.integration.test.ts: a
// drizzle-shaped database good enough for the capability probe and the membership select inside
// resolve(), so the minted scope carries the real issuedScopes trust marker.
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

async function resolverFor(principalId: string, workspaceId: string) {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  return createScopeResolver(directory, {
    // The harness pins who is asking; the header only carries that a session exists at all.
    authenticate: async (request: Request) =>
      request.headers.get("x-test-actor")
        ? { actorId: ACTOR_EMP, entrypoint: "web" as const }
        : null,
    selectTenant: () => TENANT,
    selectWorkspace: () => workspaceId,
  });
}

async function scopeForPrincipal(
  principalId: string,
  workspaceId = WORKSPACE_A,
): Promise<PlatformScope> {
  const resolver = await resolverFor(principalId, workspaceId);
  return resolver.resolve(
    new Request("https://example.invalid/workbench", {
      headers: { "x-test-actor": "yes" },
    }),
  );
}

/**
 * The mounted route family as one principal sees it. `role` answers the operator gates;
 * every other identity field is derived inside the seams, exactly as in production.
 */
async function harnessFor(
  principalId: string,
  role: "user" | "admin",
  workspaceId = WORKSPACE_A,
): Promise<Hono> {
  const scopes = await resolverFor(principalId, workspaceId);
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    if (!context.req.header("x-test-actor")) {
      return context.json({ error: "Authentication required." }, 401);
    }
    context.set("actor", {
      id: principalId,
      email: `${principalId}@example.invalid`,
      role,
    });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/hindsight",
    createHindsightRoutes({
      scopes,
      evidence,
      judgments: proposals,
      review,
      revocations,
      cleanup,
      recovery,
      requireUser,
      operationRetentionDays: () => declaredOperationRetentionDays,
      reconcileBackups: currentManifestDir
        ? () =>
            reconcileControlledBackups({
              database,
              manifestDirectory: currentManifestDir as string,
              registry: cleanup,
            })
        : null,
    }),
  );
  return app;
}

function call(
  app: Hono,
  init: {
    method: string;
    path: string;
    body?: unknown;
    authenticated?: boolean;
    contentType?: string;
  },
): Promise<Response> {
  const headers = new Headers();
  if (init.authenticated !== false) headers.set("x-test-actor", "yes");
  if (init.body !== undefined)
    headers.set("content-type", init.contentType ?? "application/json");
  return app.request(init.path, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Teach the scripted service to hand these document ids back from one bank, ranked. */
function bankHits(bank: string, documentIds: string[]) {
  scripted.state.recallByBank.set(bank, {
    status: 200,
    body: { results: documentIds.map((document_id) => ({ document_id })) },
  });
}

/**
 * One confirmed fact, named both ways: the RECORD id is what the evidence seam expands, the
 * DOCUMENT id is what the index cites and a propose lead hands in.
 */
async function confirmPreference(
  principalId: string,
  content: string,
): Promise<{ id: string; documentId: string }> {
  const scope = await scopeForPrincipal(principalId);
  const { record } = await preferences.confirmGenericPreference(scope, {
    content,
  });
  return {
    id: record.id,
    documentId: preferenceDocumentIdFor(TENANT, record.id),
  };
}

async function confirmBound(
  principalId: string,
  content: string,
  restriction: unknown,
): Promise<{ id: string; documentId: string }> {
  const scope = await scopeForPrincipal(principalId);
  const { record } = await scoped.confirmSourceBoundMemory(scope, {
    content,
    restriction,
  });
  return {
    id: record.id,
    documentId: sourceBoundDocumentIdFor(TENANT, record.id),
  };
}

/** One source-bound judgment for the employee: two source facts, one candidate, confirmed. */
async function confirmSourceBoundJudgment(content: string): Promise<{
  id: string;
  documentId: string;
}> {
  const scope = await scopeForPrincipal(PRINCIPAL_EMP);
  const first = await confirmBound(PRINCIPAL_EMP, `${content} 依据一`, {
    kind: "source",
    sourceId: SOURCE_ONE,
  });
  const second = await confirmBound(PRINCIPAL_EMP, `${content} 依据二`, {
    kind: "source",
    sourceId: SOURCE_ONE,
  });
  const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
    judgment: content,
    evidence: [first.documentId, second.documentId],
  });
  await review.confirmDerivedJudgment(scope, candidate.id);
  return {
    id: candidate.id,
    documentId: derivedJudgmentDocumentIdFor(TENANT, candidate.id),
  };
}

async function ledgerRowsFor(principalId: string) {
  return database
    .select()
    .from(hindsightRevocations)
    .where(eq(hindsightRevocations.principalId, principalId));
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: ACTOR_EMP, email: `emp-${run}@example.invalid` },
    { id: ACTOR_PEER, email: `peer-${run}@example.invalid` },
    { id: ACTOR_ADMIN, email: `admin-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Routes ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_EMP, userId: ACTOR_EMP },
    { id: PRINCIPAL_PEER, userId: ACTOR_PEER },
    { id: PRINCIPAL_ADMIN, userId: ACTOR_ADMIN },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_PEER, role: "member" },
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
      principalId: PRINCIPAL_PEER,
    },
  ]);
  await database.insert(hindsightMemoryGrants).values([
    {
      tenantId: TENANT,
      principalId: PRINCIPAL_EMP,
      kind: "source",
      targetId: SOURCE_ONE,
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
  const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
  const authorizations = createDrizzleSourceBoundAuthorizations(database);
  const pause = createDrizzlePauseControls(database);
  revocations = createRevocationService(database, serviceConfig);
  recovery = createRestoreRecoveryService(database, revocations);
  preferences = createPreferenceRecallService(
    preferenceRecords,
    serviceConfig,
    {
      pause,
      recovery: recovery.gate,
    },
  );
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
    { pause, recovery: recovery.gate },
  );
  proposals = createDerivedJudgmentService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    { pause },
  );
  // The production shape: the durable ledger wired, the sync-queue recorder absent (that is
  // FIX-W2's assembly — a confirm's retain here is eager, exactly like the index.ts wiring).
  review = createDerivedJudgmentReviewService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    serviceConfig,
    {
      pause,
      recovery: recovery.gate,
      revocations: createDrizzleRevocationLedger(database),
    },
  );
  evidence = createAnswerEvidenceService(
    preferences,
    scoped,
    preferenceRecords,
    sourceBoundRecords,
    authorizations,
    review,
  );
  cleanup = createCleanupEvidenceService(database, serviceConfig);
});

beforeEach(() => {
  scripted.calls.length = 0;
  scripted.state.recallByBank.clear();
  scripted.state.retainStatus = 202;
  scripted.state.deleteStatus = 204;
  scripted.state.documentsPresent.clear();
  scripted.state.unitsByDocument.clear();
  scripted.state.operationsByBank.clear();
  declaredOperationRetentionDays = 1;
  currentManifestDir = null;
});

afterAll(async () => {
  // Leave the shared database exactly as tidy as this file's evidence needs: no open restore
  // gate (it would close EVERY tenant's recall), none of this file's restore markers, backup
  // registrations or ledger rows.
  try {
    await recovery.replayBackupRestore();
  } catch {
    /* replay on an empty state is a no-op; a scripted outage would only retry */
  }
  await database
    .delete(hindsightBackupRestores)
    .where(eq(hindsightBackupRestores.restoreKey, `restore-${run}-1`));
  await database
    .delete(hindsightControlledBackups)
    .where(
      eq(hindsightControlledBackups.backupId, `hindsight-bk${run}-a.sql.gz`),
    );
  await database
    .delete(hindsightControlledBackups)
    .where(
      eq(hindsightControlledBackups.backupId, `hindsight-bk${run}-b.sql.gz`),
    );
  await database
    .delete(hindsightRevocations)
    .where(eq(hindsightRevocations.tenantId, TENANT));
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

describe("the evidence route (#387)", () => {
  test("the person's own confirmed bases expand; foreign, unreviewed and missing ids stay contentless", async () => {
    const own = await confirmPreference(PRINCIPAL_EMP, `喜欢短答案 ${run}`);
    const foreign = await confirmPreference(
      PRINCIPAL_PEER,
      `不应被雇员看见 ${run}`,
    );
    const empScope = await scopeForPrincipal(PRINCIPAL_EMP);
    const unreviewed = await proposals.proposeDerivedJudgmentCandidate(
      empScope,
      {
        judgment: `未审核候选 ${run}`,
        evidence: [
          own.documentId,
          (await confirmPreference(PRINCIPAL_EMP, `第二依据 ${run}`))
            .documentId,
        ],
      },
    );
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const response = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [own.id, foreign.id, unreviewed.id, randomUUID()] },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      evidence: { state: string; id: string; content?: string }[];
    };
    expect(body.evidence.map((entry) => entry.id)).toEqual([
      own.id,
      foreign.id,
      unreviewed.id,
      body.evidence[3]?.id,
    ]);
    expect(body.evidence[0]?.state).toBe("available");
    expect(body.evidence[0]?.content).toBe(`喜欢短答案 ${run}`);
    for (const entry of body.evidence.slice(1)) {
      expect(entry.state).toBe("unavailable");
      expect(JSON.stringify(entry)).not.toContain(`不应被雇员看见 ${run}`);
      expect(JSON.stringify(entry)).not.toContain(`未审核候选 ${run}`);
    }
  });

  test("a basis that lost its authorization no longer expands (无权依据不展示)", async () => {
    const bound = await confirmBound(PRINCIPAL_EMP, `来源受限事实 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const before = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [bound.id] },
    });
    const beforeBody = (await before.json()) as {
      evidence: { state: string }[];
    };
    expect(beforeBody.evidence[0]?.state).toBe("available");
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
    try {
      const after = await call(app, {
        method: "POST",
        path: "/api/hindsight/evidence",
        body: { ids: [bound.id] },
      });
      const afterBody = (await after.json()) as {
        evidence: { state: string }[];
      };
      expect(afterBody.evidence[0]?.state).toBe("unavailable");
      expect(JSON.stringify(afterBody)).not.toContain(`来源受限事实 ${run}`);
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
    }
  });

  test("an unauthenticated request answers 401 before any memory is read", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const response = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: ["anything"] },
      authenticated: false,
    });
    expect(response.status).toBe(401);
  });

  test("a non-JSON body is refused, not parsed", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const response = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: ["anything"] },
      contentType: "text/plain",
    });
    expect(response.status).toBe(400);
  });
});

describe("the judgment review routes (#388/#389)", () => {
  test("propose, list, confirm, edit, reject over the routes", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const first = await confirmPreference(PRINCIPAL_EMP, `甲 ${run}`);
    const second = await confirmPreference(PRINCIPAL_EMP, `乙 ${run}`);
    const third = await confirmPreference(PRINCIPAL_EMP, `丙 ${run}`);
    const proposed = await call(app, {
      method: "POST",
      path: "/api/hindsight/judgments/candidates",
      body: {
        judgment: `员工偏好简洁表达 ${run}`,
        evidence: [first.documentId, second.documentId],
      },
    });
    expect(proposed.status).toBe(201);
    const candidateBody = (await proposed.json()) as {
      candidate: { id: string; evidence: { id: string }[] };
    };
    // The review view cites the record ids its expansion takes, in lead order.
    expect(candidateBody.candidate.evidence.map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
    ]);

    const listed = await call(app, {
      method: "GET",
      path: "/api/hindsight/judgments/candidates?limit=20",
    });
    const listedBody = (await listed.json()) as {
      candidates: { id: string; content: string }[];
    };
    expect(listedBody.candidates.map((entry) => entry.id)).toContain(
      candidateBody.candidate.id,
    );

    const confirmed = await call(app, {
      method: "POST",
      path: `/api/hindsight/judgments/${candidateBody.candidate.id}/confirm`,
    });
    expect(confirmed.status).toBe(200);
    const confirmedBody = (await confirmed.json()) as {
      judgment: { reviewState: string };
      remoteSynced: boolean;
    };
    expect(confirmedBody.judgment.reviewState).toBe("confirmed");
    expect(confirmedBody.remoteSynced).toBe(true);
    expect(scripted.calls.find((entry) => entry.method === "POST")?.bank).toBe(
      USER_BANK_EMP,
    );

    // An edit moves the text alone; the basis is the same rows in the same order.
    const edited = await call(app, {
      method: "PATCH",
      path: `/api/hindsight/judgments/${candidateBody.candidate.id}`,
      body: { content: `员工偏好简洁表达（修订） ${run}` },
    });
    expect(edited.status).toBe(200);
    const editedBody = (await edited.json()) as {
      judgment: { content: string; evidence: { id: string }[] };
    };
    expect(editedBody.judgment.content).toBe(`员工偏好简洁表达（修订） ${run}`);
    expect(editedBody.judgment.evidence.map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
    ]);
    const expanded = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [candidateBody.candidate.id] },
    });
    const expandedBody = (await expanded.json()) as {
      evidence: { state: string; content?: string; actions?: string[] }[];
    };
    expect(expandedBody.evidence[0]?.state).toBe("available");
    expect(expandedBody.evidence[0]?.content).toBe(
      `员工偏好简洁表达（修订） ${run}`,
    );
    expect(expandedBody.evidence[0]?.actions).toEqual(["edit", "forget"]);

    // A second candidate rejected over the route leaves the listing and refuses review acts.
    const secondProposal = await call(app, {
      method: "POST",
      path: "/api/hindsight/judgments/candidates",
      body: {
        judgment: `将被拒绝的判断 ${run}`,
        evidence: [third.documentId, first.documentId],
      },
    });
    const secondId = (
      (await secondProposal.json()) as { candidate: { id: string } }
    ).candidate.id;
    const rejected = await call(app, {
      method: "POST",
      path: `/api/hindsight/judgments/${secondId}/reject`,
    });
    expect(rejected.status).toBe(200);
    const afterReject = await call(app, {
      method: "GET",
      path: "/api/hindsight/judgments/candidates",
    });
    const remaining = (
      (await afterReject.json()) as {
        candidates: { id: string }[];
      }
    ).candidates.map((entry) => entry.id);
    expect(remaining).not.toContain(secondId);
    const confirmRejected = await call(app, {
      method: "POST",
      path: `/api/hindsight/judgments/${secondId}/confirm`,
    });
    expect(confirmRejected.status).toBe(409);
  });

  test("another principal's candidate is invisible and cannot be acted on through my identity", async () => {
    const scope = await scopeForPrincipal(PRINCIPAL_EMP);
    const first = await confirmPreference(PRINCIPAL_EMP, `隐私甲 ${run}`);
    const second = await confirmPreference(PRINCIPAL_EMP, `隐私乙 ${run}`);
    const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
      judgment: `不应被同事看见的判断 ${run}`,
      evidence: [first.documentId, second.documentId],
    });
    const peerApp = await harnessFor(PRINCIPAL_PEER, "user");
    const peerList = await call(peerApp, {
      method: "GET",
      path: "/api/hindsight/judgments/candidates",
    });
    const peerCandidates = (
      (await peerList.json()) as {
        candidates: { id: string }[];
      }
    ).candidates.map((entry) => entry.id);
    expect(peerCandidates).not.toContain(candidate.id);
    const peerConfirm = await call(peerApp, {
      method: "POST",
      path: `/api/hindsight/judgments/${candidate.id}/confirm`,
    });
    expect(peerConfirm.status).toBe(404);
    const peerEdit = await call(peerApp, {
      method: "PATCH",
      path: `/api/hindsight/judgments/${candidate.id}`,
      body: { content: "tampered" },
    });
    expect(peerEdit.status).toBe(404);
    const peerForget = await call(peerApp, {
      method: "DELETE",
      path: `/api/hindsight/judgments/${candidate.id}`,
    });
    expect(peerForget.status).toBe(404);
  });

  test("identity fields in the request body name nobody; the trusted scope decides", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const first = await confirmPreference(PRINCIPAL_EMP, `冒名甲 ${run}`);
    const second = await confirmPreference(PRINCIPAL_EMP, `冒名乙 ${run}`);
    const proposed = await call(app, {
      method: "POST",
      path: "/api/hindsight/judgments/candidates",
      body: {
        judgment: `冒名测试判断 ${run}`,
        evidence: [first.documentId, second.documentId],
        // A hostile request may name anything; none of these reach a placement.
        tenantId: TENANT,
        principalId: PRINCIPAL_PEER,
        workspaceId: WORKSPACE_B,
        bank: userBankFor(PRINCIPAL_PEER),
      },
    });
    expect(proposed.status).toBe(201);
    const candidateId = (
      (await proposed.json()) as { candidate: { id: string } }
    ).candidate.id;
    const row = await database
      .select({ principalId: derivedJudgmentCandidates.principalId })
      .from(derivedJudgmentCandidates)
      .where(eq(derivedJudgmentCandidates.id, candidateId));
    expect(row[0]?.principalId).toBe(PRINCIPAL_EMP);
  });

  test("listing shape is validated rather than silently truncated", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const tooLow = await call(app, {
      method: "GET",
      path: "/api/hindsight/judgments/candidates?limit=0",
    });
    expect(tooLow.status).toBe(400);
    const tooHigh = await call(app, {
      method: "GET",
      path: "/api/hindsight/judgments/candidates?limit=999",
    });
    expect(tooHigh.status).toBe(400);
  });
});

describe("the judgment forget route (#389/#390)", () => {
  test("forgetting blocks recall immediately and answers honestly", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const { id, documentId } = await confirmSourceBoundJudgment(
      `将被遗忘的判断 ${run}`,
    );
    const empScope = await scopeForPrincipal(PRINCIPAL_EMP);
    // A source-scoped judgment lives in the source's bank; the scripted index answers from it.
    bankHits(sourceBankFor(SOURCE_ONE), [documentId]);
    const before = await review.recallDerivedJudgments(empScope, {
      query: `将被遗忘的判断 ${run}`,
    });
    expect(before.map((entry) => entry.id)).toContain(id);

    const forgotten = await call(app, {
      method: "DELETE",
      path: `/api/hindsight/judgments/${id}`,
    });
    expect(forgotten.status).toBe(200);
    const forgottenBody = (await forgotten.json()) as {
      stoppedUsingAt: string;
      remoteDeletion: { attempted: boolean; outstanding: number };
      summary: string;
    };
    expect(forgottenBody.summary).toBe(STOPPED_USING_SUMMARY);
    expect(forgottenBody.summary).not.toMatch(/cleared|purged|all .*deleted/i);
    expect(forgottenBody.remoteDeletion.attempted).toBe(true);
    expect(forgottenBody.remoteDeletion.outstanding).toBe(0);

    // The stale index may keep handing the document id back; the row reload drops it.
    const after = await review.recallDerivedJudgments(empScope, {
      query: `将被遗忘的判断 ${run}`,
    });
    expect(after.map((entry) => entry.id)).not.toContain(id);

    const expanded = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [id] },
    });
    const expandedBody = (await expanded.json()) as {
      evidence: { state: string }[];
    };
    expect(expandedBody.evidence[0]?.state).toBe("unavailable");

    const ledger = await ledgerRowsFor(PRINCIPAL_EMP);
    const block = ledger.find((entry) => entry.documentId === documentId);
    expect(block?.kind).toBe("memory");
    expect(block?.subjectType).toBe("derived_judgment");
    expect(block?.deletionState).toBe("confirmed");
  });

  test("the deletion drain call point retries a delete that failed, and confirms it", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    // The service refuses the delete: the block still lands, the deletion stays outstanding.
    scripted.state.deleteStatus = 500;
    const { id, documentId } = await confirmSourceBoundJudgment(
      `删除重试判断 ${run}`,
    );
    const forgotten = await call(app, {
      method: "DELETE",
      path: `/api/hindsight/judgments/${id}`,
    });
    const forgottenBody = (await forgotten.json()) as {
      remoteDeletion: { attempted: boolean; outstanding: number };
    };
    expect(forgottenBody.remoteDeletion.attempted).toBe(true);
    expect(forgottenBody.remoteDeletion.outstanding).toBe(1);
    const failedRow = (await ledgerRowsFor(PRINCIPAL_EMP)).find(
      (entry) => entry.documentId === documentId,
    );
    expect(failedRow?.deletionState).toBe("failed");

    // The call point the background drain owns: one pass re-issues the delete and confirms it.
    scripted.state.deleteStatus = 204;
    const pass = await revocations.retryOutstandingDeletions();
    expect(pass.confirmed).toBeGreaterThanOrEqual(1);
    const confirmedRow = (await ledgerRowsFor(PRINCIPAL_EMP)).find(
      (entry) => entry.documentId === documentId,
    );
    expect(confirmedRow?.deletionState).toBe("confirmed");
  });

  test("a judgment whose basis lost its authorization stops recalling, even though confirmed", async () => {
    const { id, documentId } = await confirmSourceBoundJudgment(
      `失权判断 ${run}`,
    );
    const empScope = await scopeForPrincipal(PRINCIPAL_EMP);
    bankHits(sourceBankFor(SOURCE_ONE), [documentId]);
    const before = await review.recallDerivedJudgments(empScope, {
      query: `失权判断 ${run}`,
    });
    expect(before.map((entry) => entry.id)).toContain(id);
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
    try {
      const after = await review.recallDerivedJudgments(empScope, {
        query: `失权判断 ${run}`,
      });
      expect(after.map((entry) => entry.id)).not.toContain(id);
    } finally {
      await database
        .update(hindsightMemoryGrants)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
    }
  });
});

describe("the source-revocation route (#390)", () => {
  afterEach(async () => {
    /*
     * The revocation block disables the caller's own grant by design. Later describes
     * confirm fresh source-bound facts, which the seam rightly refuses while the grant is
     * off — so the grant is restored between tests, exactly as a person would re-connect
     * the source. The tombstoned rows stay tombstoned.
     */
    await database
      .update(hindsightMemoryGrants)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
  });

  test("revoking a source blocks what it fed — rows, judgments, grant — and only the caller's", async () => {
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const boundDocument = await confirmBound(
      PRINCIPAL_EMP,
      `撤销波及事实 ${run}`,
      {
        kind: "source",
        sourceId: SOURCE_ONE,
      },
    );
    const { documentId: judgmentDocument } = await confirmSourceBoundJudgment(
      `撤销波及判断 ${run}`,
    );

    // The peer's same-named grant feed is untouched by what follows: it exists first, with
    // its own fact confirmed into it.
    await database.insert(hindsightMemoryGrants).values([
      {
        tenantId: TENANT,
        principalId: PRINCIPAL_PEER,
        kind: "source",
        targetId: SOURCE_ONE,
      },
    ]);
    const peerBound = await confirmBound(
      PRINCIPAL_PEER,
      `同事来源事实 ${run}`,
      {
        kind: "source",
        sourceId: SOURCE_ONE,
      },
    );

    const revoked = await call(app, {
      method: "POST",
      path: "/api/hindsight/revocations",
      body: {
        kind: "source",
        targetId: SOURCE_ONE,
        // Hostile leftovers: none of these are read.
        principalId: PRINCIPAL_PEER,
        bank: userBankFor(PRINCIPAL_PEER),
      },
    });
    expect(revoked.status).toBe(200);
    const body = (await revoked.json()) as {
      blocked: { sourceBoundMemories: number; derivedJudgments: number };
      summary: string;
    };
    expect(body.summary).toBe(STOPPED_USING_SUMMARY);
    expect(body.blocked.sourceBoundMemories).toBeGreaterThanOrEqual(1);
    expect(body.blocked.derivedJudgments).toBeGreaterThanOrEqual(1);

    const empGrant = await database
      .select({ enabled: hindsightMemoryGrants.enabled })
      .from(hindsightMemoryGrants)
      .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_EMP));
    expect(empGrant[0]?.enabled).toBe(false);
    const peerGrant = await database
      .select({ enabled: hindsightMemoryGrants.enabled })
      .from(hindsightMemoryGrants)
      .where(eq(hindsightMemoryGrants.principalId, PRINCIPAL_PEER));
    expect(peerGrant[0]?.enabled).toBe(true);

    const ledger = await ledgerRowsFor(PRINCIPAL_EMP);
    expect(ledger.some((entry) => entry.documentId === judgmentDocument)).toBe(
      true,
    );
    const peerLedger = await ledgerRowsFor(PRINCIPAL_PEER);
    expect(peerLedger).toHaveLength(0);

    // What was blocked no longer expands for anyone, and the peer's row still does for them.
    const empExpanded = await call(app, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [boundDocument.id] },
    });
    expect(
      ((await empExpanded.json()) as { evidence: { state: string }[] })
        .evidence[0]?.state,
    ).toBe("unavailable");
    const peerApp = await harnessFor(PRINCIPAL_PEER, "user");
    const peerExpanded = await call(peerApp, {
      method: "POST",
      path: "/api/hindsight/evidence",
      body: { ids: [peerBound.id] },
    });
    expect(
      ((await peerExpanded.json()) as { evidence: { state: string }[] })
        .evidence[0]?.state,
    ).toBe("available");
  });
});

/** Write one backup job artifact plus its registration manifest. */
async function writeBackup(
  directory: string,
  backupId: string,
  takenAt: Date,
): Promise<void> {
  const manifestName = backupId.replace(/\.sql\.gz$/, ".manifest.json");
  await writeFile(
    join(directory, manifestName),
    `${JSON.stringify({ backupId, takenAt: takenAt.toISOString() })}\n`,
    "utf8",
  );
  await writeFile(join(directory, backupId), "not-a-real-dump", "utf8");
}

type CleanupBody = {
  controlledCopiesCleared: boolean;
  summary: string | null;
  externalModelLogs: { coveredByThisClaim: boolean; note: string };
  activeData: {
    cleared: boolean;
    documents: number;
    blockedByOpenRestore: boolean;
  };
  finishedTaskPayloads: {
    cleared: boolean;
    checked: boolean;
    reason: string | null;
  };
  controlledBackups: {
    cleared: boolean;
    registered: number;
    outstanding: number | null;
    oldestOutstandingTakenAt: string | null;
  };
  backupRegistration: {
    manifests: number;
    skipped: number;
    registered: number;
    alreadyRegistered: number;
    purged: number;
  } | null;
};

async function cleanupStatus(app: Hono): Promise<CleanupBody> {
  const response = await call(app, {
    method: "GET",
    path: "/api/hindsight/cleanup",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as CleanupBody;
}

describe("the cleanup-evidence routes (#391)", () => {
  test("all three observed legs make the claim; a missing or outstanding leg shows the actual state", async () => {
    const manifestDir = await mkdtemp(join(tmpdir(), `h376-fixw2b-${run}-`));
    currentManifestDir = manifestDir;
    const app = await harnessFor(PRINCIPAL_EMP, "user");
    const adminApp = await harnessFor(PRINCIPAL_ADMIN, "admin");
    try {
      /*
       * The controlled-backup registry is global (a copy holds every company's banks):
       * artifacts left by earlier suites against this database would be indistinguishable
       * from real un-purged evidence and would legitimately block the claim. This suite
       * clears the registry before asserting absolutes, the same ownership move the
       * purge-restore suite documents for itself.
       */
      await database.delete(hindsightControlledBackups);

      // One confirmed deletion of this person's, verified absent by the route's own probes.
      const { id } = await confirmSourceBoundJudgment(`清理证据判断 ${run}`);
      const forgotten = await call(app, {
        method: "DELETE",
        path: `/api/hindsight/judgments/${id}`,
      });
      expect(forgotten.status).toBe(200);
      const verified = await call(app, {
        method: "POST",
        path: "/api/hindsight/cleanup/verify",
      });
      expect(verified.status).toBe(200);
      const outcomes = (
        (await verified.json()) as { outcomes: { state: string }[] }
      ).outcomes;
      expect(outcomes.length).toBeGreaterThanOrEqual(1);
      expect(outcomes.every((outcome) => outcome.state === "absent")).toBe(
        true,
      );

      // A controlled copy taken AFTER the deletion cannot hold the content.
      const backupA = `hindsight-bk${run}-a.sql.gz`;
      await writeBackup(manifestDir, backupA, new Date(Date.now() + 3_600_000));
      const reconciled = await call(adminApp, {
        method: "POST",
        path: "/api/hindsight/ops/backups/reconcile",
      });
      expect(reconciled.status).toBe(200);
      const report =
        (await reconciled.json()) as CleanupBody["backupRegistration"];
      expect(report?.manifests).toBe(1);
      expect(report?.registered).toBe(1);
      expect(report?.skipped).toBe(0);

      const cleared = await cleanupStatus(app);
      expect(cleared.activeData.cleared).toBe(true);
      expect(cleared.activeData.blockedByOpenRestore).toBe(false);
      expect(cleared.finishedTaskPayloads.checked).toBe(true);
      expect(cleared.finishedTaskPayloads.cleared).toBe(true);
      expect(cleared.controlledBackups.cleared).toBe(true);
      expect(cleared.controlledCopiesCleared).toBe(true);
      expect(cleared.summary).toBe(CONTROLLED_COPIES_CLEARED_SUMMARY);
      expect(cleared.externalModelLogs.coveredByThisClaim).toBe(false);
      // The status read reconciles first; the same manifest is a no-op the second time.
      expect(cleared.backupRegistration?.alreadyRegistered).toBe(1);

      // A copy taken BEFORE the deletion may hold it until purged: the claim drops, the
      // actual state stays visible.
      const backupB = `hindsight-bk${run}-b.sql.gz`;
      await writeBackup(
        manifestDir,
        backupB,
        new Date(Date.now() - 172_800_000),
      );
      await call(adminApp, {
        method: "POST",
        path: "/api/hindsight/ops/backups/reconcile",
      });
      const blocked = await cleanupStatus(app);
      expect(blocked.controlledCopiesCleared).toBe(false);
      expect(blocked.summary).toBeNull();
      expect(blocked.controlledBackups.outstanding).toBe(1);
      expect(blocked.controlledBackups.oldestOutstandingTakenAt).not.toBeNull();
      expect(blocked.activeData.cleared).toBe(true);

      // The retention sweep's deletion is the purge evidence: manifest stays, archive gone.
      await unlink(join(manifestDir, backupB));
      const purged = await call(adminApp, {
        method: "POST",
        path: "/api/hindsight/ops/backups/reconcile",
      });
      expect(((await purged.json()) as { purged: number }).purged).toBe(1);
      const recovered = await cleanupStatus(app);
      expect(recovered.controlledCopiesCleared).toBe(true);
      expect(recovered.summary).toBe(CONTROLLED_COPIES_CLEARED_SUMMARY);

      // An undeclared payload window is unevidenced, never measured against a guess.
      declaredOperationRetentionDays = null;
      const undeclared = await cleanupStatus(app);
      expect(undeclared.finishedTaskPayloads.checked).toBe(false);
      expect(undeclared.finishedTaskPayloads.cleared).toBe(false);
      expect(undeclared.finishedTaskPayloads.reason).not.toBeNull();
      expect(undeclared.controlledCopiesCleared).toBe(false);
      declaredOperationRetentionDays = 1;

      // Another person's status makes no claim over this person's records.
      const peerApp = await harnessFor(PRINCIPAL_PEER, "user");
      const peerStatus = await cleanupStatus(peerApp);
      expect(peerStatus.activeData.documents).toBe(0);
      expect(peerStatus.activeData.cleared).toBe(false);
      expect(peerStatus.controlledCopiesCleared).toBe(false);
    } finally {
      currentManifestDir = null;
      await rm(manifestDir, { recursive: true, force: true });
    }
  });
});

describe("the operator restore routes (#391)", () => {
  test("the restore gate is admin-only and content-free; a note closes recall until the replay re-opens it", async () => {
    const userApp = await harnessFor(PRINCIPAL_EMP, "user");
    const adminApp = await harnessFor(PRINCIPAL_ADMIN, "admin");
    expect(
      (
        await call(userApp, {
          method: "GET",
          path: "/api/hindsight/ops/restores",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(userApp, {
          method: "POST",
          path: "/api/hindsight/ops/restores",
          body: { restoreKey: `restore-${run}-1` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(userApp, {
          method: "POST",
          path: "/api/hindsight/ops/restores/replay",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(userApp, {
          method: "POST",
          path: "/api/hindsight/ops/backups/reconcile",
        })
      ).status,
    ).toBe(403);

    const closed = await call(adminApp, {
      method: "GET",
      path: "/api/hindsight/ops/restores",
    });
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as { recallOpen: boolean }).recallOpen).toBe(
      true,
    );

    // A confirmed judgment the person can recall up to the restore.
    const { id, documentId } = await confirmSourceBoundJudgment(
      `恢复演练判断 ${run}`,
    );
    const empScope = await scopeForPrincipal(PRINCIPAL_EMP);
    bankHits(sourceBankFor(SOURCE_ONE), [documentId]);
    expect(
      (
        await review.recallDerivedJudgments(empScope, {
          query: `恢复演练 ${run}`,
        })
      ).map((entry) => entry.id),
    ).toContain(id);

    const noted = await call(adminApp, {
      method: "POST",
      path: "/api/hindsight/ops/restores",
      body: { restoreKey: `restore-${run}-1` },
    });
    expect(noted.status).toBe(201);
    const notedBody = (await noted.json()) as {
      noted: boolean;
      state: string;
    };
    expect(notedBody.noted).toBe(true);
    expect(notedBody.state).toBe("open");
    expect(JSON.stringify(notedBody)).not.toContain(`恢复演练判断 ${run}`);

    // While the gate is open every recall answers empty — the restore may have
    // resurrected rows, and the replay has not landed yet.
    expect(
      await review.recallDerivedJudgments(empScope, {
        query: `恢复演练 ${run}`,
      }),
    ).toEqual([]);
    const open = await call(adminApp, {
      method: "GET",
      path: "/api/hindsight/ops/restores",
    });
    const openBody = (await open.json()) as {
      recallOpen: boolean;
      openRestores: number;
      oldestRestoredAt: string | null;
    };
    expect(openBody.recallOpen).toBe(false);
    expect(openBody.openRestores).toBe(1);
    expect(typeof openBody.oldestRestoredAt).toBe("string");

    const replayed = await call(adminApp, {
      method: "POST",
      path: "/api/hindsight/ops/restores/replay",
    });
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as {
      replayed: boolean;
      evidence: {
        localBlocks: Record<string, number>;
        remoteDeletions: Record<string, number>;
        finishedAt: string;
      } | null;
    };
    expect(replayedBody.replayed).toBe(true);
    expect(
      replayedBody.evidence?.localBlocks.memoryRows,
    ).toBeGreaterThanOrEqual(0);
    expect(
      replayedBody.evidence?.remoteDeletions.considered,
    ).toBeGreaterThanOrEqual(0);
    // Counts and instants only: no memory text rides along with the replay evidence.
    expect(JSON.stringify(replayedBody)).not.toContain(`恢复演练判断 ${run}`);

    const reopened = await call(adminApp, {
      method: "GET",
      path: "/api/hindsight/ops/restores",
    });
    expect(
      ((await reopened.json()) as { recallOpen: boolean; openRestores: number })
        .recallOpen,
    ).toBe(true);
    // The same restore noted again cannot re-close recall.
    const again = await call(adminApp, {
      method: "POST",
      path: "/api/hindsight/ops/restores",
      body: { restoreKey: `restore-${run}-1` },
    });
    const againBody = (await again.json()) as { noted: boolean; state: string };
    expect(againBody.noted).toBe(false);
    expect(againBody.state).toBe("replayed");
  });

  test("reconciliation answers explicitly when no manifest directory is declared", async () => {
    const adminApp = await harnessFor(PRINCIPAL_ADMIN, "admin");
    currentManifestDir = null;
    const response = await call(adminApp, {
      method: "POST",
      path: "/api/hindsight/ops/backups/reconcile",
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("manifest");
  });

  test("a malformed manifest is skipped and never registers a copy", async () => {
    const manifestDir = await mkdtemp(
      join(tmpdir(), `h376-fixw2b-bad-${run}-`),
    );
    currentManifestDir = manifestDir;
    const adminApp = await harnessFor(PRINCIPAL_ADMIN, "admin");
    try {
      await writeFile(
        join(manifestDir, `hindsight-bad${run}.manifest.json`),
        "{ not json",
        "utf8",
      );
      await writeFile(
        join(manifestDir, `hindsight-evil${run}.manifest.json`),
        JSON.stringify({
          backupId: "../../etc/passwd",
          takenAt: new Date().toISOString(),
        }),
        "utf8",
      );
      const response = await call(adminApp, {
        method: "POST",
        path: "/api/hindsight/ops/backups/reconcile",
      });
      expect(response.status).toBe(200);
      const report = (await response.json()) as {
        manifests: number;
        skipped: number;
        registered: number;
      };
      expect(report.manifests).toBe(0);
      expect(report.skipped).toBe(2);
      expect(report.registered).toBe(0);
    } finally {
      currentManifestDir = null;
      await rm(manifestDir, { recursive: true, force: true });
    }
  });
});
