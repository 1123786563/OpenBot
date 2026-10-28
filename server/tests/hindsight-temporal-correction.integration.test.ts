import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
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
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 09 (#386), integration layer: effective time and correction history on the
 * preference authority, through the same recall seam a Bot uses.
 *
 * The ticket's scenario, on a controlled clock: 例会周五 (confirmed at T0), corrected to
 * 例会周一 effective next Monday (T2), decided at T1. Three kinds of answer:
 *
 * 1. Current — before T2 the old fact still answers; from T2 on the successor answers, with
 *    its stated effective time carried to the Bot.
 * 2. Historical — an as-of moment inside the old window answers the old fact; inside the
 *    successor's window answers the successor.
 * 3. Time-unknown — a correction with no determinable time: the current answer carries
 *    timeUncertain, and a historical read inside the ambiguity returns the OLD fact flagged
 *    uncertain — an honest "was Friday, when it changed is unclear", never a fabricated date.
 *
 * Plus the guardrails: an unconfirmed change never alters an answer (the review gate), a
 * tombstone answers nothing (current or historical) while the untouched history of the same
 * chain stays readable, only the successor is retained on correction, and contradictory or
 * mid-chain corrections are refused.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_acme-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL = `prin_person-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;

// The controlled clock: T0 confirm, T1 correction decision, T2 the stated effective time.
const T0 = new Date("2026-10-01T09:00:00.000Z");
const T1 = new Date("2026-10-08T09:00:00.000Z");
const T2 = new Date("2026-10-12T00:00:00.000Z"); // 下周一
const BEFORE_T2 = new Date("2026-10-10T12:00:00.000Z");
const AFTER_T2 = new Date("2026-10-15T09:00:00.000Z");
const IN_OLD_WINDOW = new Date("2026-10-05T09:00:00.000Z");

let clock = new Date(T0);

type CapturedRetain = {
  bank: string;
  body: { items: { content: string; document_id: string }[] };
};

let scripted: {
  server: Server;
  url: string;
  retains: CapturedRetain[];
  recallBody: { results: { document_id: string }[] };
};

async function bootScriptedHindsight() {
  const retains: CapturedRetain[] = [];
  const state = { recallBody: { results: [] as { document_id: string }[] } };
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
        retains.push({ bank, body: body as CapturedRetain["body"] });
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: 1 }));
        return;
      }
      if (request.method === "POST" && path.endsWith("/memories/recall")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state.recallBody));
        return;
      }
      if (request.method === "DELETE" && path.includes("/documents/")) {
        response.writeHead(204);
        response.end();
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
    set recallBody(body: { results: { document_id: string }[] }) {
      state.recallBody = body;
    },
    get recallBody() {
      return state.recallBody;
    },
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

let service: ReturnType<typeof createPreferenceRecallService>;
let scope: PlatformScope;
let recordedWork: {
  subjectType: string;
  subjectId: string;
  contentDigest: string;
}[];

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: `usr_person-${run}`, email: `person-${run}@example.invalid` },
    ]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Acme ${run}` }]);
  await database
    .insert(enterprisePrincipals)
    .values([{ id: PRINCIPAL, userId: `usr_person-${run}` }]);
  await database
    .insert(enterpriseMemberships)
    .values([{ tenantId: TENANT, principalId: PRINCIPAL, role: "member" }]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE, name: `Team ${run}` }]);
  await database
    .insert(enterpriseWorkspaceMemberships)
    .values([
      { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL },
    ]);

  scripted = await bootScriptedHindsight();
  recordedWork = [];
  service = createPreferenceRecallService(
    createDrizzlePreferenceRecords(database),
    {
      apiUrl: scripted.url,
      serviceApiKey: SERVICE_KEY,
      assertionSecret: SECRET,
      requestTimeoutMs: 2000,
    },
    {
      now: () => clock,
      work: {
        record: async (input) => {
          recordedWork.push({
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            contentDigest: input.contentDigest,
          });
        },
      },
    },
  );
  scope = await makeTrustedScope();
});

afterAll(async () => {
  if (!scripted) return;
  await new Promise<void>((resolve) => {
    scripted.server.closeAllConnections?.();
    scripted.server.close(() => resolve());
  });
});

describe("Hindsight 09 (#386): 例会周五，下周起改周一", () => {
  let fridayRecord: { id: string };
  let mondayRecord: { id: string };

  beforeAll(async () => {
    // T0: the person confirms the Friday meeting.
    clock = new Date(T0);
    const confirmed = await service.confirmGenericPreference(scope, {
      content: "例会在周五",
    });
    fridayRecord = confirmed.record;
    // T1: the person corrects it, effective next Monday (T2).
    clock = new Date(T1);
    const corrected = await service.correctGenericPreference(
      scope,
      fridayRecord.id,
      { content: "例会在周一", effectiveFrom: T2.toISOString() },
    );
    mondayRecord = corrected.record;
  });

  test("the old fact is retained, with its window; only the successor is re-retained", async () => {
    // The confirm retained the Friday fact; the correction retained ONLY the Monday
    // successor — the predecessor's content did not change, so its document stands.
    const retainedDocuments = scripted.retains.map(
      (call) => call.body.items[0].document_id,
    );
    expect(retainedDocuments).toContain(
      preferenceDocumentIdFor(TENANT, fridayRecord.id),
    );
    expect(retainedDocuments).toContain(
      preferenceDocumentIdFor(TENANT, mondayRecord.id),
    );
    expect(
      scripted.retains.filter(
        (call) =>
          call.body.items[0].document_id ===
          preferenceDocumentIdFor(TENANT, fridayRecord.id),
      ).length,
    ).toBe(1);

    const [oldRow] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.id, fridayRecord.id),
        ),
      )
      .limit(1);
    expect(oldRow.content).toBe("例会在周五"); // 明确更正保留旧事实
    expect(oldRow.effectiveFrom?.toISOString()).toBe(T0.toISOString());
    expect(oldRow.effectiveUntil?.toISOString()).toBe(T2.toISOString());
    expect(oldRow.supersededBy).toBe(mondayRecord.id);
    expect(oldRow.supersededTimeUnknown).toBe(false);
    expect(oldRow.deletedAt).toBeNull(); // not a tombstone — a closed window

    const [newRow] = await database
      .select()
      .from(genericPersonalPreferences)
      .where(
        and(
          eq(genericPersonalPreferences.tenantId, TENANT),
          eq(genericPersonalPreferences.id, mondayRecord.id),
        ),
      )
      .limit(1);
    expect(newRow.effectiveFrom?.toISOString()).toBe(T2.toISOString());
    expect(newRow.supersededBy).toBeNull();
  });

  test("current questions: Friday until the change takes effect, Monday from then on", async () => {
    scripted.recallBody = {
      results: [
        { document_id: preferenceDocumentIdFor(TENANT, fridayRecord.id) },
        { document_id: preferenceDocumentIdFor(TENANT, mondayRecord.id) },
      ],
    };
    clock = new Date(BEFORE_T2);
    const before = await service.recallGenericPreferences(scope, {
      query: "例会",
    });
    expect(before.map((item) => item.content)).toEqual(["例会在周五"]);
    expect(before[0].timeUncertain).toBe(false);

    clock = new Date(AFTER_T2);
    const after = await service.recallGenericPreferences(scope, {
      query: "例会",
    });
    expect(after.map((item) => item.content)).toEqual(["例会在周一"]);
    expect(after[0].effectiveFrom?.toISOString()).toBe(T2.toISOString());
    expect(after[0].effectiveUntil).toBeNull();
    expect(after[0].timeUncertain).toBe(false);
  });

  test("historical questions read the fact that was valid at the moment", async () => {
    scripted.recallBody = {
      results: [
        { document_id: preferenceDocumentIdFor(TENANT, fridayRecord.id) },
        { document_id: preferenceDocumentIdFor(TENANT, mondayRecord.id) },
      ],
    };
    const lastWeek = await service.recallGenericPreferences(scope, {
      query: "例会",
      asOf: IN_OLD_WINDOW.toISOString(),
    });
    expect(lastWeek.map((item) => item.content)).toEqual(["例会在周五"]);
    expect(lastWeek[0].effectiveUntil?.toISOString()).toBe(T2.toISOString());

    const thisWeek = await service.recallGenericPreferences(scope, {
      query: "例会",
      asOf: AFTER_T2.toISOString(),
    });
    expect(thisWeek.map((item) => item.content)).toEqual(["例会在周一"]);
  });

  test("an unconfirmed change never alters the answer", async () => {
    // A candidate claiming the meeting moved again — unreviewed, it decides nothing.
    const candidateId = randomUUID();
    await database.insert(genericPersonalPreferences).values({
      tenantId: TENANT,
      id: candidateId,
      principalId: PRINCIPAL,
      content: "例会改在周三（候选）",
      provenance: "seed",
      reviewState: "unreviewed",
      enabled: true,
      markedGenericAt: new Date(),
      hindsightDocumentId: preferenceDocumentIdFor(TENANT, candidateId),
      effectiveFrom: new Date(AFTER_T2),
    });
    scripted.recallBody = {
      results: [
        { document_id: preferenceDocumentIdFor(TENANT, candidateId) },
        { document_id: preferenceDocumentIdFor(TENANT, mondayRecord.id) },
      ],
    };
    clock = new Date(AFTER_T2);
    const current = await service.recallGenericPreferences(scope, {
      query: "例会",
    });
    expect(current.map((item) => item.content)).toEqual(["例会在周一"]);
  });

  test("contradictory and mid-chain corrections are refused", async () => {
    // A fresh, still-current fact for the time contradiction: the stated time sits at the
    // old fact's own start, which would give it an empty (or negative) window.
    clock = new Date(T0);
    const fresh = await service.confirmGenericPreference(scope, {
      content: `值班在周四 ${run}`,
    });
    await expect(
      service.correctGenericPreference(scope, fresh.record.id, {
        content: "值班在周日",
        effectiveFrom: T0.toISOString(), // at the old fact's own start
      }),
    ).rejects.toThrow("cannot take effect at or before");
    // The chain has one head: the already-superseded Friday fact refuses another correction.
    await expect(
      service.correctGenericPreference(scope, fridayRecord.id, {
        content: "例会在周日",
      }),
    ).rejects.toThrow("already corrected");
  });

  test("a tombstone answers nothing, and the untouched history stays readable", async () => {
    scripted.recallBody = {
      results: [
        { document_id: preferenceDocumentIdFor(TENANT, fridayRecord.id) },
        { document_id: preferenceDocumentIdFor(TENANT, mondayRecord.id) },
      ],
    };
    clock = new Date(AFTER_T2);
    await service.forgetGenericPreference(scope, mondayRecord.id);
    const current = await service.recallGenericPreferences(scope, {
      query: "例会",
    });
    expect(current).toEqual([]); // forgotten — even though history existed
    const recentPast = await service.recallGenericPreferences(scope, {
      query: "例会",
      asOf: AFTER_T2.toISOString(),
    });
    expect(recentPast).toEqual([]); // the tombstone dominates history too

    // The PREDECESSOR's own window is untouched by the successor's forgetting.
    const oldPast = await service.recallGenericPreferences(scope, {
      query: "例会",
      asOf: IN_OLD_WINDOW.toISOString(),
    });
    expect(oldPast.map((item) => item.content)).toEqual(["例会在周五"]);
  });
});

describe("Hindsight 09 (#386): a correction whose time cannot be determined", () => {
  test("the current answer is uncertain; the historical answer is the old fact, uncertain", async () => {
    clock = new Date(T0);
    const weekly = await service.confirmGenericPreference(scope, {
      content: "周报在周五发",
    });
    clock = new Date(T1);
    const corrected = await service.correctGenericPreference(
      scope,
      weekly.record.id,
      {
        content: "周报在周一发",
        // no effectiveFrom: the person cannot say when the change applies
      },
    );
    expect(corrected.record.timeUncertain).toBe(true);
    expect(corrected.record.effectiveFrom).toBeNull();
    expect(corrected.superseded.effectiveUntil).toBeNull();
    expect(corrected.superseded.timeUncertain).toBe(false);

    scripted.recallBody = {
      results: [
        { document_id: preferenceDocumentIdFor(TENANT, weekly.record.id) },
        { document_id: preferenceDocumentIdFor(TENANT, corrected.record.id) },
      ],
    };

    clock = new Date(AFTER_T2);
    const current = await service.recallGenericPreferences(scope, {
      query: "周报",
    });
    expect(current.map((item) => item.content)).toEqual(["周报在周一发"]);
    expect(current[0].timeUncertain).toBe(true); // 表达不确定，不臆造日期
    expect(current[0].effectiveFrom).toBeNull();

    const past = await service.recallGenericPreferences(scope, {
      query: "周报",
      asOf: IN_OLD_WINDOW.toISOString(),
    });
    expect(past.map((item) => item.content)).toEqual(["周报在周五发"]);
    expect(past[0].timeUncertain).toBe(true); // when it changed is unknown — honest
    expect(past[0].effectiveUntil).toBeNull();
  });
});

describe("Hindsight 09 (#386): corrections record durable sync work", () => {
  test("the successor's work is recorded with its own digest", async () => {
    recordedWork.length = 0;
    clock = new Date(T0);
    const confirmed = await service.confirmGenericPreference(scope, {
      content: "站立会在周二",
    });
    clock = new Date(T1);
    const corrected = await service.correctGenericPreference(
      scope,
      confirmed.record.id,
      { content: "站立会在周三", effectiveFrom: T2.toISOString() },
    );
    const successorWork = recordedWork.filter(
      (work) => work.subjectId === corrected.record.id,
    );
    expect(successorWork.length).toBe(1);
    // The predecessor's window change is not content: no work is recorded for it.
    const predecessorWork = recordedWork.filter(
      (work) => work.subjectId === confirmed.record.id,
    );
    expect(predecessorWork.length).toBe(1); // its own confirm's work, unchanged
  });
});
