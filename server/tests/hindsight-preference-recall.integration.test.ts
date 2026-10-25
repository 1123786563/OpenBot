import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  afterAll,
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
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  companySchemaFor,
  userBankFor,
  verifyBankScopeAssertion,
} from "../src/hindsight/bank-scope";
import type { HindsightBudgetGate } from "../src/hindsight/budget-gate";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 05 (#382), integration layer: the general-personal-preference recall seam over the
 * real authority table and a scripted Hindsight service.
 *
 * The seam's three clauses, one describe each:
 *
 * 1. Confirm syncs a STABLE document identity — the retain request names the derived user bank,
 *    authenticates as service key + freshly minted assertion (verified here with the mirror
 *    verifier), and an edit re-retains the SAME document id rather than creating a twin. A
 *    service failure never fails the person's confirmation; the row simply awaits its sync.
 * 2. Cross-Bot recall within the company: two different asking Bots, one user scope, the same
 *    confirmed originals — and the contract carries no bank id and no document id. Another
 *    company's scope (same global user) and another principal get nothing, even when the
 *    scripted service hands their document ids to the wrong caller: the seam drops what the
 *    caller's own rows do not own.
 * 3. Drop rules: orphan hits, unreviewed, disabled, forgotten and other-principal rows never
 *    reach the Bot, and the extracted fact text the service also returns is read past — the
 *    Bot's content is the OpenBot-confirmed original, byte for byte.
 *
 * The service here is scripted because the real service's allow/deny matrix is #381's contract
 * suite (hindsight-bank-isolation.contract.test.ts, on the real instance); this layer pins the
 * seam's own behavior against a well-behaved remote. Scopes are minted the production way
 * (createScopeResolver over a controlled directory database), so the untrusted-scope refusals
 * exercise the real trust marker, not a stub of it.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_acme-${run}`;
const TENANT_B = `tn_globex-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL_A = `prin_same-person-a-${run}`;
const PRINCIPAL_B = `prin_same-person-b-${run}`;
const PRINCIPAL_OTHER = `prin_other-person-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

/** What the scripted Hindsight service received, in order. */
type CapturedCall = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
  scope: string | undefined;
};

/** The scripted service's mutable answers; the request handler reads this object live. */
type ScriptedState = {
  recall: { status: number; body: unknown };
  retainStatus: number;
  deleteStatus: number;
};

let service: ReturnType<typeof createPreferenceRecallService>;
let scripted: {
  server: Server;
  url: string;
  calls: CapturedCall[];
  state: ScriptedState;
  reset: () => void;
};

async function bootScriptedHindsight() {
  const calls: CapturedCall[] = [];
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
      calls.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        authorization: request.headers.authorization,
        scope: request.headers["x-openbot-bank-scope"],
      });
      const path = request.url ?? "";
      let status = 404;
      let payload: unknown = { error: "scripted: no route" };
      if (request.method === "POST" && path.endsWith("/memories")) {
        status = state.retainStatus;
        payload = { accepted: 1 };
      } else if (
        request.method === "POST" &&
        path.endsWith("/memories/recall")
      ) {
        status = state.recall.status;
        payload = state.recall.body;
      } else if (request.method === "DELETE" && path.includes("/documents/")) {
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
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    calls,
    state,
    reset: () => {
      calls.length = 0;
      state.recall = { status: 200, body: { results: [] } };
      state.retainStatus = 202;
      state.deleteStatus = 204;
    },
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

async function makeTrustedScope(
  tenantId: string,
  principalId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** A structurally perfect scope nobody issued — the forgery this seam must refuse. */
function forgedScope(tenantId: string, principalId: string): PlatformScope {
  return Object.freeze({
    tenantId,
    workspaceId: WORKSPACE,
    principalId,
    actorId: GLOBAL_ACTOR,
    memberEpoch: 3,
    aclEpoch: 1,
    entrypoint: "web",
  } satisfies PlatformScope);
}

beforeAll(async () => {
  // The attribution chain the authority table's foreign keys demand: user → principal →
  // tenant → membership. The shipped enterprise schema maps principal↔user one-to-one, so
  // these fixture rows give each principal its own user; "the same global user holds a
  // principal in each company" rides the minted scopes (one actor authenticating into two
  // companies), which is the identity this seam actually consumes — it never reads the
  // users table.
  await database.insert(users).values([
    { id: `usr_a-${run}`, email: `a-${run}@example.invalid` },
    { id: `usr_b-${run}`, email: `b-${run}@example.invalid` },
    { id: `usr_other-${run}`, email: `other-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT_A, name: `Acme ${run}` },
    { id: TENANT_B, name: `Globex ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_A, userId: `usr_a-${run}` },
    { id: PRINCIPAL_B, userId: `usr_b-${run}` },
    { id: PRINCIPAL_OTHER, userId: `usr_other-${run}` },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
    { tenantId: TENANT_B, principalId: PRINCIPAL_B, role: "member" },
    { tenantId: TENANT_A, principalId: PRINCIPAL_OTHER, role: "member" },
  ]);

  scripted = await bootScriptedHindsight();
  service = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    {
      apiUrl: scripted.url,
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 2000,
    },
  );
});

afterAll(async () => {
  // This suite's rows are all run-tagged; leaving them costs nothing, but the scripted
  // server's port should go back. Guarded: a failed beforeAll must not mask its own error.
  if (!scripted) return;
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

/** A confirmed row inserted directly, with a known document id, for the drop-rule matrix. */
async function seedRow(
  tenantId: string,
  principalId: string,
  overrides: Partial<{
    content: string;
    reviewState: "unreviewed" | "confirmed" | "edited";
    enabled: boolean;
    deletedAt: Date;
    hindsightDocumentId: string;
  }>,
) {
  const id = randomUUID();
  const row = {
    tenantId,
    id,
    principalId,
    content: overrides.content ?? `preference of ${id}`,
    provenance: "seed",
    reviewState: overrides.reviewState ?? "confirmed",
    enabled: overrides.enabled ?? true,
    deletedAt: overrides.deletedAt ?? null,
    markedGenericAt: new Date(),
    hindsightDocumentId:
      overrides.hindsightDocumentId ?? preferenceDocumentIdFor(tenantId, id),
    syncedContentDigest: null,
    syncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await database.insert(genericPersonalPreferences).values(row);
  return row;
}

describe("confirm syncs a stable document identity (#382 AC1)", () => {
  test("confirm retains under the derived bank with a fresh verifiable assertion", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const { record, remoteSynced } = await service.confirmGenericPreference(
      scope,
      { content: "周报用简短要点，例会周五", provenance: "standup" },
    );
    expect(remoteSynced).toBe(true);

    const retain = scripted.calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    );
    expect(retain).toBeDefined();
    // The bank is the derived user bank of this principal in this company — never chosen.
    expect(retain?.path).toBe(
      `/v1/default/banks/${userBankFor(PRINCIPAL_A)}/memories`,
    );
    expect(retain?.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    // The service identity is the pair: the assertion verifies and names exactly this grant.
    const payload = verifyBankScopeAssertion(retain?.scope ?? "", {
      secret: SECRET,
    });
    expect(payload?.sch).toBe(companySchemaFor(TENANT_A));
    expect(payload?.b).toEqual([userBankFor(PRINCIPAL_A)]);
    // Stable identity + replace: the retain names the row's derived document id.
    const item = (
      retain?.body as {
        items?: { document_id?: string; update_mode?: string }[];
      }
    )?.items?.[0];
    expect(item?.document_id).toBe(
      preferenceDocumentIdFor(TENANT_A, record.id),
    );
    expect(item?.update_mode).toBe("replace");

    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    expect(row.syncedContentDigest).not.toBeNull();
  });

  test("an edit re-retains the SAME document id; the twin never appears", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const first = await service.confirmGenericPreference(scope, {
      content: "周报用段落",
    });
    const edited = await service.editGenericPreference(scope, first.record.id, {
      content: "周报用简短要点",
    });
    expect(edited.record.content).toBe("周报用简短要点");
    expect(edited.remoteSynced).toBe(true);

    const retains = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    );
    expect(retains).toHaveLength(2);
    const ids = retains.map(
      (call) =>
        (call.body as { items?: { document_id?: string }[] }).items?.[0]
          ?.document_id,
    );
    expect(new Set(ids).size).toBe(1);
  });

  test("a service failure never fails the confirmation; the row awaits its sync", async () => {
    scripted.reset();
    scripted.state.retainStatus = 500;
    const scope = await makeTrustedScope(TENANT_B, PRINCIPAL_B);
    const { record, remoteSynced } = await service.confirmGenericPreference(
      scope,
      { content: "代码评审先看测试" },
    );
    expect(remoteSynced).toBe(false);
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    expect(row.syncedContentDigest).toBeNull();
    expect(row.syncedAt).toBeNull();
  });

  test("an untrusted scope is refused before any request leaves", async () => {
    scripted.reset();
    await expect(
      service.recallGenericPreferences(forgedScope(TENANT_A, PRINCIPAL_A), {
        query: "周报",
        askingAgentId: "bot-1",
      }),
    ).rejects.toThrow("UNVERIFIED_SCOPE");
    await new Promise((settle) => setTimeout(settle, 25));
    expect(scripted.calls).toHaveLength(0);
  });
});

describe("cross-Bot recall inside the company; nobody else's (#382 AC2)", () => {
  test("two asking Bots, one user scope: the same confirmed originals", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const first = await service.confirmGenericPreference(scope, {
      content: "周报风险优先",
      provenance: "review session",
    });
    const second = await service.confirmGenericPreference(scope, {
      content: "例会改到周一",
    });
    scripted.state.recall = {
      status: 200,
      body: {
        results: [
          {
            document_id: preferenceDocumentIdFor(TENANT_A, second.record.id),
            text: "SOME EXTRACTED FACT TEXT",
          },
          {
            document_id: preferenceDocumentIdFor(TENANT_A, first.record.id),
            text: "another extracted fact",
          },
        ],
      },
    };
    const viaBotOne = await service.recallGenericPreferences(scope, {
      query: "备周报的要点",
      askingAgentId: "bot-writer",
    });
    const viaBotTwo = await service.recallGenericPreferences(scope, {
      query: "例会时间",
      askingAgentId: "bot-scheduler",
    });
    // Same session-independent originals for both Bots, in the service's rank order.
    expect(viaBotOne.map((item) => item.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
    expect(viaBotTwo.map((item) => item.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
    expect(viaBotOne[0].content).toBe("例会改到周一");
    expect(viaBotOne[1].content).toBe("周报风险优先");
    // The contract carries no bank and no remote document id, and no extracted text.
    const serialized = JSON.stringify(viaBotOne);
    expect(serialized).not.toContain(userBankFor(PRINCIPAL_A));
    expect(serialized).not.toContain("document");
    expect(serialized).not.toContain("EXTRACTED FACT");
    for (const item of viaBotOne) {
      // Hindsight 09 (#386) added the temporal fields; still no bank, no document id.
      expect(Object.keys(item).sort()).toEqual([
        "content",
        "effectiveFrom",
        "effectiveUntil",
        "id",
        "markedGenericAt",
        "provenance",
        "timeUncertain",
      ]);
    }
  });

  test("another company of the same global user gets nothing, even handed A's hits", async () => {
    scripted.reset();
    const scopeA = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const confirmed = await service.confirmGenericPreference(scopeA, {
      content: "甲公司内部偏好",
    });
    const scopeB = await makeTrustedScope(TENANT_B, PRINCIPAL_B);
    // The scripted service misbehaves: B's recall is handed A's document hit.
    scripted.state.recall = {
      status: 200,
      body: {
        results: [
          {
            document_id: preferenceDocumentIdFor(TENANT_A, confirmed.record.id),
            text: "acme-only",
          },
        ],
      },
    };
    const throughB = await service.recallGenericPreferences(scopeB, {
      query: "内部偏好",
      askingAgentId: "bot-b",
    });
    expect(throughB).toEqual([]);
    // A's own scope still answers the confirmed original.
    const throughA = await service.recallGenericPreferences(scopeA, {
      query: "内部偏好",
      askingAgentId: "bot-a",
    });
    expect(throughA.map((item) => item.content)).toEqual(["甲公司内部偏好"]);
  });

  test("another user's rows are not this caller's, even named as hits", async () => {
    scripted.reset();
    const other = await seedRow(TENANT_A, PRINCIPAL_OTHER, {
      content: "别人确认的偏好",
      hindsightDocumentId: `hgp_other-${run}`,
    });
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    scripted.state.recall = {
      status: 200,
      body: { results: [{ document_id: other.hindsightDocumentId }] },
    };
    const recalled = await service.recallGenericPreferences(scope, {
      query: "anything",
      askingAgentId: "bot-a",
    });
    expect(recalled).toEqual([]);
  });
});

describe("remote results without a current confirmed row are dropped (#382 AC3)", () => {
  test("orphan, unreviewed, disabled, forgotten and duplicate hits: only live confirmed rows answer", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const live = await service.confirmGenericPreference(scope, {
      content: "本人确认且通用的偏好",
    });
    await seedRow(TENANT_A, PRINCIPAL_A, {
      reviewState: "unreviewed",
      hindsightDocumentId: `hgp_unreviewed-${run}`,
    });
    await seedRow(TENANT_A, PRINCIPAL_A, {
      enabled: false,
      hindsightDocumentId: `hgp_disabled-${run}`,
    });
    await seedRow(TENANT_A, PRINCIPAL_A, {
      deletedAt: new Date(),
      content: "",
      hindsightDocumentId: `hgp_forgotten-${run}`,
    });
    const liveDoc = preferenceDocumentIdFor(TENANT_A, live.record.id);
    scripted.state.recall = {
      status: 200,
      body: {
        results: [
          { document_id: `hgp_orphan-${run}`, text: "a document nobody owns" },
          { document_id: `hgp_unreviewed-${run}` },
          { document_id: `hgp_disabled-${run}` },
          { document_id: `hgp_forgotten-${run}` },
          {
            document_id: liveDoc,
            text: "the extracted shape, not the original",
          },
          { document_id: liveDoc },
          { text: "a hit with no document id at all" },
        ],
      },
    };
    const recalled = await service.recallGenericPreferences(scope, {
      query: "通用偏好",
      askingAgentId: "bot-a",
    });
    expect(recalled.map((item) => item.id)).toEqual([live.record.id]);
    expect(recalled[0].content).toBe("本人确认且通用的偏好");
  });

  test("forget tombstones the row and drops its hit from then on", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const { record } = await service.confirmGenericPreference(scope, {
      content: "将被遗忘的偏好",
    });
    const doc = preferenceDocumentIdFor(TENANT_A, record.id);
    await service.forgetGenericPreference(scope, record.id);
    // The remote document was deleted best-effort, under the derived bank.
    const removed = scripted.calls.find(
      (call) =>
        call.method === "DELETE" && call.path.endsWith(`/documents/${doc}`),
    );
    expect(removed?.path).toContain(userBankFor(PRINCIPAL_A));
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, record.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.content).toBe("");
    expect(row.enabled).toBe(false);
    // Even a hit the service still returns for the forgotten document answers nothing.
    scripted.state.recall = {
      status: 200,
      body: { results: [{ document_id: doc }] },
    };
    const recalled = await service.recallGenericPreferences(scope, {
      query: "遗忘",
      askingAgentId: "bot-a",
    });
    expect(recalled).toEqual([]);
  });

  test("an unreachable or malformed service is an error or silence, never invented content", async () => {
    scripted.reset();
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    scripted.state.recall = { status: 503, body: { error: "down" } };
    await expect(
      service.recallGenericPreferences(scope, {
        query: "x",
        askingAgentId: "b",
      }),
    ).rejects.toThrow("memory index is unreachable");
    // A bank the service has never seen is a person with nothing confirmed yet: empty,
    // not an outage.
    scripted.state.recall = {
      status: 404,
      body: { detail: "Bank not found" },
    };
    const noBank = await service.recallGenericPreferences(scope, {
      query: "x",
      askingAgentId: "b",
    });
    expect(noBank).toEqual([]);
    scripted.state.recall = { status: 200, body: "not json" };
    const empty = await service.recallGenericPreferences(scope, {
      query: "x",
      askingAgentId: "b",
    });
    expect(empty).toEqual([]);
  });
});

/*
 * FIX-OCR3 (O3-M1): the preference seam's admittedRetain claimed the judgment review's
 * discipline "verbatim" while missing its O2-M1 bookkeeping guard. The row and the work row
 * land before admittedRetain runs, so a throwing admission or settle must degrade — the
 * confirm stands with the retain's own outcome, never fails into a retry that would hit the
 * same content as a duplicate.
 */
describe("FIX-OCR3 — budget bookkeeping never fails the preference confirm", () => {
  const failures = { admit: false, settle: false, release: false };
  const throwingBudget: HindsightBudgetGate = {
    async admitBackgroundWork() {
      if (failures.admit) throw new Error("admission ledger exploded");
      return { ok: true, reservationId: `res-o3p-${run}` };
    },
    async settleBackgroundWork() {
      if (failures.settle) throw new Error("settle ledger exploded");
    },
    async releaseBackgroundWork() {
      if (failures.release) throw new Error("release ledger exploded");
    },
    async currentUsage() {
      return { companyUnits: 0, personalUnits: [], period: "2026-10" };
    },
  };
  const budgetedService = (config: {
    apiUrl: string;
    serviceApiKey: string;
    assertionSecret: string;
    requestTimeoutMs: number;
  }) =>
    createPreferenceRecallService(
      createDrizzlePreferenceRecords(database),
      config,
      { budget: throwingBudget },
    );
  // The scripted service only exists after beforeAll, so the config is read per leg.
  const liveConfig = () => ({
    apiUrl: scripted.url,
    serviceApiKey: SERVICE_KEY,
    assertionSecret: SECRET,
    requestTimeoutMs: 2000,
  });

  test("a settle that throws after a successful retain keeps the confirm standing and synced", async () => {
    failures.admit = false;
    failures.settle = true;
    failures.release = false;
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const { record, remoteSynced } = await budgetedService(
      liveConfig(),
    ).confirmGenericPreference(scope, {
      content: `簿记失败结算偏好 ${run}`,
    });
    expect(remoteSynced).toBe(true);
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    failures.settle = false;
  });

  test("an admission that throws skips the retain: the decision stands, unsynced", async () => {
    failures.admit = true;
    failures.settle = false;
    failures.release = false;
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const retainsBefore = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    ).length;
    const { record, remoteSynced } = await budgetedService(
      liveConfig(),
    ).confirmGenericPreference(scope, {
      content: `簿记失败准入偏好 ${run}`,
    });
    expect(remoteSynced).toBe(false);
    const [row] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(eq(genericPersonalPreferences.id, record.id));
    expect(row.reviewState).toBe("confirmed");
    const retainsAfter = scripted.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/memories"),
    ).length;
    expect(retainsAfter).toBe(retainsBefore);
    failures.admit = false;
  });
});
