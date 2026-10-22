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
import { teamBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  createDerivedJudgmentService,
  createDrizzleDerivedJudgmentRecords,
  DerivedJudgmentRefusedError,
  derivedJudgmentDocumentIdFor,
} from "../src/hindsight/derived-judgments";
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
 * Hindsight 11 (#388), integration layer: the derived-judgment candidate seam over the real
 * authority tables, the real tenancy tables and a scripted Hindsight service.
 *
 * One describe per acceptance clause:
 *
 * 1. One source per judgment: two confirmed preferences (or two facts of the same team, the
 *    same connected source, the same Bot) produce a candidate scoped to exactly that source;
 *    any mix — general with source-bound, team A with team B, source with source, source with
 *    Bot — is refused as cross-source before a row exists.
 * 2. The full basis, or nothing: a candidate carries every basis with content, source and
 *    time; a citation that resolves to nothing (unknown id, another person's fact), an
 *    unconfirmed or forgotten basis, or a basis whose restriction lost its authorization
 *    (source disabled, membership suspended, Bot's app revoked) refuses the proposal, and a
 *    candidate already proposed disappears from the listing while its evidence is
 *    de-authorized.
 * 3. Unreviewed judgments are inert: proposing makes no remote call at all, the judgment's
 *    document id cannot surface through either recall seam even when the scripted service
 *    hands it back as a hit, and an unreviewed judgment cannot serve as evidence for a
 *    next-level judgment.
 *
 * Scopes are minted the production way (createScopeResolver over a controlled directory
 * database); evidence authorization runs against the REAL tenancy tables, so disabling a
 * grant or suspending a membership is a genuine revocation.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_judge-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const PRINCIPAL_EMP = `prin_employee-${run}`;
const PRINCIPAL_ADMIN = `prin_admin-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_connected-1-${run}`;
const SOURCE_TWO = `src_connected-2-${run}`;
const BOT_ONE = `agt_bot-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

const TEAM_BANK_A = teamBankFor(WORKSPACE_A);
const USER_BANK_EMP = userBankFor(PRINCIPAL_EMP);

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
};

let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
};
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let judgments: ReturnType<typeof createDerivedJudgmentService>;

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
  const state: ScriptedState = {
    recallByBank: new Map(),
    retainStatus: 202,
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

/** A structurally perfect scope nobody issued — the forgery this seam must refuse. */
function forgedScope(principalId: string, workspaceId: string): PlatformScope {
  return Object.freeze({
    tenantId: TENANT,
    workspaceId,
    principalId,
    actorId: GLOBAL_ACTOR,
    memberEpoch: 3,
    aclEpoch: 1,
    entrypoint: "web",
  } satisfies PlatformScope);
}

beforeAll(async () => {
  // The attribution chain the foreign keys demand, plus the grant registry rows the
  // authorization store reads. The employee sits in BOTH teams and holds two sources and a
  // Bot; the admin shares only team A (their facts must not resolve for the employee).
  await database.insert(users).values([
    { id: `usr_emp-${run}`, email: `emp-${run}@example.invalid` },
    { id: `usr_admin-${run}`, email: `admin-${run}@example.invalid` },
  ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Judge ${run}` }]);
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
  const serviceConfig = {
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  };
  const preferenceRecords = createDrizzlePreferenceRecords(database);
  const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
  const authorizations = createDrizzleSourceBoundAuthorizations(database);
  preferences = createPreferenceRecallService(preferenceRecords, serviceConfig);
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
  );
  judgments = createDerivedJudgmentService(
    preferenceRecords,
    sourceBoundRecords,
    createDrizzleDerivedJudgmentRecords(database),
    authorizations,
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

async function employeeScope(
  workspaceId = WORKSPACE_A,
): Promise<PlatformScope> {
  return makeTrustedScope(PRINCIPAL_EMP, workspaceId);
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

function refusalOf(
  promise: Promise<unknown>,
): Promise<DerivedJudgmentRefusedError> {
  return promise.then(
    () => {
      throw new Error("expected the proposal to be refused");
    },
    (error: unknown) => {
      if (!(error instanceof DerivedJudgmentRefusedError)) throw error;
      return error;
    },
  );
}

async function candidateRowCount(): Promise<number> {
  const rows = await database
    .select({ id: derivedJudgmentCandidates.id })
    .from(derivedJudgmentCandidates)
    .where(eq(derivedJudgmentCandidates.principalId, PRINCIPAL_EMP));
  return rows.length;
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

describe("Hindsight 11 (#388) AC1: one authorized source per judgment", () => {
  test("two confirmed experiences of the general memory produce a candidate", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `周报要点风格一 ${run}`);
    const second = await confirmPreference(scope, `周报要点风格二 ${run}`);
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `周报偏好：简短要点、风险优先 ${run}`,
      evidence: [first, second],
    });
    expect(candidate.scope).toEqual({ kind: "general" });
    expect(candidate.reviewState).toBe("unreviewed");
    expect(candidate.evidence).toHaveLength(2);
    expect(candidate.evidence.map((item) => item.kind)).toEqual([
      "preference",
      "preference",
    ]);
  });

  test("two facts of the same team produce a team-scoped candidate", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const first = await confirmBound(scope, `团队 A 业务事实一 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const second = await confirmBound(scope, `团队 A 业务事实二 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `团队 A 的综合判断 ${run}`,
      evidence: [first, second],
    });
    expect(candidate.scope).toEqual({
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
  });

  test("two facts of the same connected source produce a source-scoped candidate", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `来源一事实一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `来源一事实二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `来源一的综合判断 ${run}`,
      evidence: [first, second],
    });
    expect(candidate.scope).toEqual({
      kind: "source",
      sourceId: SOURCE_ONE,
    });
  });

  test("the general memory mixed with a source-bound fact is refused", async () => {
    const scope = await employeeScope();
    const preference = await confirmPreference(scope, `通用偏好事实 ${run}`);
    const teamFact = await confirmBound(scope, `团队 A 混合事实 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const before = await candidateRowCount();
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `跨范围判断 ${run}`,
        evidence: [preference, teamFact],
      }),
    );
    expect(error.reason).toBe("cross-source-evidence");
    expect(await candidateRowCount()).toBe(before);
  });

  test("team A mixed with team B is refused, named as cross-source", async () => {
    const scopeA = await employeeScope(WORKSPACE_A);
    const scopeB = await employeeScope(WORKSPACE_B);
    const factA = await confirmBound(scopeA, `团队 A 事实 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const factB = await confirmBound(scopeB, `团队 B 事实 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_B,
    });
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scopeA, {
        judgment: `A 加 B 判断 ${run}`,
        evidence: [factA, factB],
      }),
    );
    // Cross-source is named even though the team-B row would also fail team A's
    // authorization: the mix is the first thing wrong with this lead.
    expect(error.reason).toBe("cross-source-evidence");
  });

  test("one connected source mixed with another is refused", async () => {
    const scope = await employeeScope();
    const one = await confirmBound(scope, `来源一独有事实 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const two = await confirmBound(scope, `来源二独有事实 ${run}`, {
      kind: "source",
      sourceId: SOURCE_TWO,
    });
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `跨来源判断 ${run}`,
        evidence: [one, two],
      }),
    );
    expect(error.reason).toBe("cross-source-evidence");
  });

  test("a connected source mixed with a Bot's fact is refused", async () => {
    const scope = await employeeScope();
    const source = await confirmBound(scope, `来源一 Bot 混合事实 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const bot = await confirmBound(scope, `Bot 一事实 ${run}`, {
      kind: "bot",
      agentId: BOT_ONE,
    });
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `来源加 Bot 判断 ${run}`,
        evidence: [source, bot],
      }),
    );
    expect(error.reason).toBe("cross-source-evidence");
  });

  test("a forged scope is refused before any evidence is read", async () => {
    await expect(
      judgments.proposeDerivedJudgmentCandidate(
        forgedScope(PRINCIPAL_EMP, WORKSPACE_A),
        { judgment: `伪造判断 ${run}`, evidence: ["hgp_x", "hgp_y"] },
      ),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
  });
});

describe("Hindsight 11 (#388) AC2: the full basis, or no judgment", () => {
  test("the candidate shows every basis with its content, source, and time", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const preference = await confirmPreference(
      scope,
      `依据展示：通用偏好 ${run}`,
    );
    const second = await confirmPreference(
      scope,
      `依据展示：通用偏好二 ${run}`,
    );
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `依据展示判断 ${run}`,
      evidence: [preference, second],
    });
    expect(candidate.evidence).toHaveLength(2);
    const [firstBasis, secondBasis] = candidate.evidence;
    if (firstBasis.kind !== "preference" || secondBasis.kind !== "preference") {
      throw new Error("expected preference evidence");
    }
    expect(firstBasis.content).toContain("依据展示：通用偏好");
    expect(firstBasis.provenance).toBeTruthy();
    expect(firstBasis.markedGenericAt).toBeInstanceOf(Date);
    expect(firstBasis.effectiveFrom).toBeInstanceOf(Date);
    expect(firstBasis.effectiveUntil).toBeNull();
    expect(firstBasis.id).not.toBe(secondBasis.id);
    expect(candidate.proposedAt).toBeInstanceOf(Date);
  });

  test("a source-bound basis carries its restriction and forming time", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const first = await confirmBound(scope, `来源依据展示一 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const second = await confirmBound(scope, `来源依据展示二 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `团队依据展示判断 ${run}`,
      evidence: [first, second],
    });
    const basis = candidate.evidence[0];
    if (basis?.kind !== "source_bound") {
      throw new Error("expected source-bound evidence");
    }
    expect(basis.restriction).toEqual({
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    expect(basis.formedAt).toBeInstanceOf(Date);
    expect(basis.provenance).toBeTruthy();
  });

  test("a citation that resolves to nothing refuses the proposal", async () => {
    const scope = await employeeScope();
    const preference = await confirmPreference(
      scope,
      `缺失依据对照事实 ${run}`,
    );
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `缺失依据判断 ${run}`,
        evidence: [preference, "hgp_doesnotexist0000"],
      }),
    );
    expect(error.reason).toBe("missing-evidence");
  });

  test("another person's confirmed fact does not resolve as evidence", async () => {
    const adminScope = await makeTrustedScope(PRINCIPAL_ADMIN, WORKSPACE_A);
    const adminFact = await confirmPreference(
      adminScope,
      `管理员的私有事实 ${run}`,
    );
    expect(adminFact).toMatch(/^hgp_/);
    const scope = await employeeScope();
    const own = await confirmPreference(scope, `本人对照事实 ${run}`);
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `越权依据判断 ${run}`,
        evidence: [own, adminFact],
      }),
    );
    expect(error.reason).toBe("missing-evidence");
  });

  test("an unconfirmed basis refuses the proposal", async () => {
    const scope = await employeeScope();
    const confirmed = await confirmPreference(scope, `已确认对照 ${run}`);
    // A candidate memory the person never reviewed — inserted the way the candidate store
    // would hold one — is not evidence for a judgment.
    const id = randomUUID();
    await database.insert(genericPersonalPreferences).values({
      tenantId: TENANT,
      id,
      principalId: PRINCIPAL_EMP,
      content: `未确认候选事实 ${run}`,
      provenance: "You",
      reviewState: "unreviewed",
      enabled: true,
      deletedAt: null,
      markedGenericAt: new Date(),
      hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
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
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `未确认依据判断 ${run}`,
        evidence: [confirmed, preferenceDocumentIdFor(TENANT, id)],
      }),
    );
    expect(error.reason).toBe("unconfirmed-evidence");
  });

  test("a forgotten basis refuses the proposal", async () => {
    const scope = await employeeScope();
    const keep = await confirmPreference(scope, `遗忘对照保留 ${run}`);
    const { record: forgotten } = await preferences.confirmGenericPreference(
      scope,
      { content: `将被遗忘的依据 ${run}` },
    );
    await preferences.forgetGenericPreference(scope, forgotten.id);
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `遗忘依据判断 ${run}`,
        evidence: [keep, preferenceDocumentIdFor(TENANT, forgotten.id)],
      }),
    );
    expect(error.reason).toBe("unconfirmed-evidence");
    expect(forgotten.id).toBeTruthy();
  });

  test("a disabled connected source refuses the proposal", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `失权对照一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `失权对照二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    await setGrant(SOURCE_ONE, false);
    try {
      const error = await refusalOf(
        judgments.proposeDerivedJudgmentCandidate(scope, {
          judgment: `失权来源判断 ${run}`,
          evidence: [first, second],
        }),
      );
      expect(error.reason).toBe("unauthorized-evidence");
    } finally {
      await setGrant(SOURCE_ONE, true);
    }
  });

  test("a suspended team membership refuses the proposal", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const first = await confirmBound(scope, `挂起对照一 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const second = await confirmBound(scope, `挂起对照二 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    await suspendMembership(WORKSPACE_A);
    try {
      const error = await refusalOf(
        judgments.proposeDerivedJudgmentCandidate(scope, {
          judgment: `挂起成员判断 ${run}`,
          evidence: [first, second],
        }),
      );
      expect(error.reason).toBe("unauthorized-evidence");
    } finally {
      await restoreMembership(WORKSPACE_A);
    }
  });

  test("a revoked Bot app refuses the proposal", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `Bot 对照一 ${run}`, {
      kind: "bot",
      agentId: BOT_ONE,
    });
    const second = await confirmBound(scope, `Bot 对照二 ${run}`, {
      kind: "bot",
      agentId: BOT_ONE,
    });
    await setGrant(BOT_ONE, false);
    try {
      const error = await refusalOf(
        judgments.proposeDerivedJudgmentCandidate(scope, {
          judgment: `失权 Bot 判断 ${run}`,
          evidence: [first, second],
        }),
      );
      expect(error.reason).toBe("unauthorized-evidence");
    } finally {
      await setGrant(BOT_ONE, true);
    }
  });

  test("a proposed candidate disappears while its evidence is de-authorized", async () => {
    const scope = await employeeScope();
    const first = await confirmBound(scope, `列表对照一 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const second = await confirmBound(scope, `列表对照二 ${run}`, {
      kind: "source",
      sourceId: SOURCE_ONE,
    });
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `列表消隐判断 ${run}`,
      evidence: [first, second],
    });
    const listed = await judgments.listDerivedJudgmentCandidates(scope);
    expect(listed.some((item) => item.id === candidate.id)).toBe(true);
    await setGrant(SOURCE_ONE, false);
    try {
      const withheld = await judgments.listDerivedJudgmentCandidates(scope);
      expect(withheld.some((item) => item.id === candidate.id)).toBe(false);
    } finally {
      await setGrant(SOURCE_ONE, true);
    }
    const restored = await judgments.listDerivedJudgmentCandidates(scope);
    const again = restored.find((item) => item.id === candidate.id);
    expect(again?.evidence).toHaveLength(2);
  });
});

describe("Hindsight 11 (#388) AC3: unreviewed judgments are inert", () => {
  test("proposing a candidate makes no remote call — nothing is retained", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `无远端对照一 ${run}`);
    const second = await confirmPreference(scope, `无远端对照二 ${run}`);
    const remoteCallsAfterConfirms = scripted.calls.length;
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `无远端判断 ${run}`,
      evidence: [first, second],
    });
    expect(candidate.id).toBeTruthy();
    expect(scripted.calls.length).toBe(remoteCallsAfterConfirms);
    // And the judgment's document identity was never sent anywhere.
    const documentId = derivedJudgmentDocumentIdFor(TENANT, candidate.id);
    expect(
      scripted.calls.some((call) =>
        JSON.stringify(call.body ?? "").includes(documentId),
      ),
    ).toBe(false);
  });

  test("the judgment's document id cannot surface through the preference recall", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `召回对照一 ${run}`);
    const second = await confirmPreference(scope, `召回对照二 ${run}`);
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `不可召回的通用判断 ${run}`,
      evidence: [first, second],
    });
    const judgmentDocument = derivedJudgmentDocumentIdFor(TENANT, candidate.id);
    // The service turns malicious or buggy and hands the judgment's document id back as a
    // hit alongside its real evidence; the recall must drop it — no preference row owns it.
    scripted.state.recallByBank.set(USER_BANK_EMP, {
      status: 200,
      body: {
        results: [first, second, judgmentDocument].map((document_id) => ({
          document_id,
        })),
      },
    });
    const recalled = await preferences.recallGenericPreferences(scope, {
      query: `周报风格 ${run}`,
    });
    expect(recalled).toHaveLength(2);
    expect(
      recalled.every((item) => !item.content.includes("不可召回的通用判断")),
    ).toBe(true);
  });

  test("the judgment's document id cannot surface through the scoped recall either", async () => {
    const scope = await employeeScope(WORKSPACE_A);
    const first = await confirmBound(scope, `范围召回对照一 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const second = await confirmBound(scope, `范围召回对照二 ${run}`, {
      kind: "team",
      workspaceId: WORKSPACE_A,
    });
    const candidate = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `不可召回的团队判断 ${run}`,
      evidence: [first, second],
    });
    const judgmentDocument = derivedJudgmentDocumentIdFor(TENANT, candidate.id);
    scripted.state.recallByBank.set(TEAM_BANK_A, {
      status: 200,
      body: {
        results: [first, second, judgmentDocument].map((document_id) => ({
          document_id,
        })),
      },
    });
    const recalled = await scoped.recallSourceBoundMemories(scope, {
      query: `团队业务 ${run}`,
    });
    expect(recalled).toHaveLength(2);
    expect(
      recalled.every((item) => !item.content.includes("不可召回的团队判断")),
    ).toBe(true);
  });

  test("an unreviewed judgment cannot serve as evidence for a next-level judgment", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `下一层对照一 ${run}`);
    const second = await confirmPreference(scope, `下一层对照二 ${run}`);
    const base = await judgments.proposeDerivedJudgmentCandidate(scope, {
      judgment: `第一层判断 ${run}`,
      evidence: [first, second],
    });
    const error = await refusalOf(
      judgments.proposeDerivedJudgmentCandidate(scope, {
        judgment: `建立在判断上的判断 ${run}`,
        evidence: [first, derivedJudgmentDocumentIdFor(TENANT, base.id)],
      }),
    );
    expect(error.reason).toBe("unconfirmed-evidence");
  });

  test("a replayed lead folds into the candidate it already produced", async () => {
    const scope = await employeeScope();
    const first = await confirmPreference(scope, `幂等对照一 ${run}`);
    const second = await confirmPreference(scope, `幂等对照二 ${run}`);
    const lead = {
      judgment: `幂等判断 ${run}`,
      evidence: [first, second],
    };
    const original = await judgments.proposeDerivedJudgmentCandidate(
      scope,
      lead,
    );
    const replayed = await judgments.proposeDerivedJudgmentCandidate(
      scope,
      lead,
    );
    expect(replayed.id).toBe(original.id);
    const listed = await judgments.listDerivedJudgmentCandidates(scope);
    const mine = listed.filter((item) => item.id === original.id);
    expect(mine).toHaveLength(1);
  });
});
