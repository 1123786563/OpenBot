import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { and, eq } from "drizzle-orm";
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
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../src/db/schema/hindsight-source-bound";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { sourceBankFor, userBankFor } from "../src/hindsight/bank-scope";
import {
  createDegradedRecallFacade,
  createDrizzleDegradedPreferenceSearch,
  createDrizzleDegradedSourceBoundSearch,
} from "../src/hindsight/degraded-recall";
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
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
  createSourceBoundRecallService,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 14 (#392), integration layer: pause-learning and pause-usage as two separate
 * switches, applied at the candidate-generation seam and every recall seam respectively.
 *
 * The matrix the ticket names — the four combinations of the two switches, across the entries
 * (indexed recall, SQL degradation, automatic proposal, the person's own explicit review), the
 * next run after a toggle, and the Hindsight-down scenario. Web chat, channels and scheduled
 * jobs all enter through these seams (the personal-memory module is the only public entry),
 * so the gates here are the gates everywhere.
 *
 * What must hold everywhere:
 *   - pause-learning refuses the AUTOMATIC proposal only; the person's own confirm/review/
 *     forget keep working, and nothing is deleted by either switch;
 *   - pause-usage answers recall empty BEFORE the service is asked — so with the service down
 *     the SQL degradation path (reached only through the seams' unavailability signal) never
 *     runs either: a pause is not an outage;
 *   - resuming a control restores exactly its own behavior: no candidate is confirmed, no
 *     authorization widened, and previously confirmed content recalls again unchanged.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_pause-${run}`;
const WORKSPACE_A = `ws_pause-a-${run}`;
const PRINCIPAL_EMP = `prin_emp-${run}`;
const USER_EMP = `usr_emp-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;
const SOURCE_ONE = `src_pause-1-${run}`;
const SECRET = `test-assertion-secret-${run}`;
const SERVICE_KEY = `it-service-key-${run}`;
const REQUEST_TIMEOUT_MS = 500;
const STALL_MS = 3000;

type ScriptedState = {
  recallByBank: Map<string, { status: number; body: unknown }>;
  stallMs: number;
  recallCalls: number;
};

let scripted: { server: Server; url: string; state: ScriptedState };
let preferences: ReturnType<typeof createPreferenceRecallService>;
let scoped: ReturnType<typeof createSourceBoundRecallService>;
let proposals: ReturnType<typeof createDerivedJudgmentService>;
let review: ReturnType<typeof createDerivedJudgmentReviewService>;
let facade: ReturnType<typeof createDegradedRecallFacade>;
let pause: ReturnType<typeof createDrizzlePauseControls>;
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
    recallCalls: 0,
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
          status = 202;
          payload = { accepted: 1 };
        } else if (
          request.method === "POST" &&
          path.endsWith("/memories/recall")
        ) {
          state.recallCalls++;
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

beforeAll(async () => {
  await database
    .insert(users)
    .values([{ id: USER_EMP, email: `emp-${run}@example.invalid` }]);
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Pause ${run}` }]);
  await database
    .insert(enterprisePrincipals)
    .values([{ id: PRINCIPAL_EMP, userId: USER_EMP }]);
  await database
    .insert(enterpriseMemberships)
    .values([{ tenantId: TENANT, principalId: PRINCIPAL_EMP, role: "member" }]);
  await database
    .insert(enterpriseWorkspaces)
    .values([{ tenantId: TENANT, id: WORKSPACE_A, name: `Pause A ${run}` }]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    {
      tenantId: TENANT,
      workspaceId: WORKSPACE_A,
      principalId: PRINCIPAL_EMP,
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
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  pause = createDrizzlePauseControls(database);
  const preferenceRecords = createDrizzlePreferenceRecords(database);
  const sourceBoundRecords = createDrizzleSourceBoundRecords(database);
  const authorizations = createDrizzleSourceBoundAuthorizations(database);
  const judgmentRecords = createDrizzleDerivedJudgmentRecords(database);
  preferences = createPreferenceRecallService(
    preferenceRecords,
    serviceConfig,
    {
      pause,
    },
  );
  scoped = createSourceBoundRecallService(
    sourceBoundRecords,
    authorizations,
    serviceConfig,
    { pause },
  );
  proposals = createDerivedJudgmentService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    { pause },
  );
  review = createDerivedJudgmentReviewService(
    preferenceRecords,
    sourceBoundRecords,
    judgmentRecords,
    authorizations,
    serviceConfig,
    { pause },
  );
  facade = createDegradedRecallFacade(
    preferences,
    scoped,
    createDrizzleDegradedPreferenceSearch(database),
    createDrizzleDegradedSourceBoundSearch(database),
    authorizations,
  );
});

afterAll(async () => {
  await scripted.server.close();
});

afterEach(() => {
  scripted.state.stallMs = 0;
});

describe("Hindsight 14 (#392) — pause-learning and pause-usage", () => {
  test("the four combinations: each switch gates only its own seam, and neither deletes anything", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);

    // Confirmed content to recall, and two source-bound facts to propose a judgment over.
    const preference = await preferences.confirmGenericPreference(scope, {
      content: `pause-matrix-preference-${run}`,
      provenance: "You",
    });
    const factA = await scoped.confirmSourceBoundMemory(scope, {
      content: `pause-matrix-fact-a-${run}`,
      provenance: "You",
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    const factB = await scoped.confirmSourceBoundMemory(scope, {
      content: `pause-matrix-fact-b-${run}`,
      provenance: "You",
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    const proposeLead = () =>
      proposals.proposeDerivedJudgmentCandidate(scope, {
        judgment: `pause-matrix-judgment-${run}-${randomUUID().slice(0, 4)}`,
        provenance: "Hindsight",
        evidence: [
          sourceBoundDocumentIdFor(TENANT, factA.record.id),
          sourceBoundDocumentIdFor(TENANT, factB.record.id),
        ],
      });
    // The index answers the confirmed preference's document from the person's own bank, so
    // the indexed path is the one exercised (not the 404-as-empty shortcut).
    scripted.state.recallByBank.set(userBankFor(PRINCIPAL_EMP), {
      status: 200,
      body: {
        results: [
          {
            document_id: preferenceDocumentIdFor(TENANT, preference.record.id),
          },
        ],
      },
    });

    // Both off: proposals work, recalls answer.
    const proposed = await proposeLead();
    expect(proposed.reviewState).toBe("unreviewed");
    expect(
      (await facade.recallGenericPreferences(scope, { query: "pause matrix" }))
        .memories.length,
    ).toBeGreaterThan(0);

    // Learning on, usage off: the automatic proposal is refused with its own reason; recall
    // keeps answering.
    await pause.setLearningPaused(TENANT, PRINCIPAL_EMP, USER_EMP, true);
    await expect(proposeLead()).rejects.toMatchObject({
      name: "DerivedJudgmentRefusedError",
      reason: "learning-paused",
    });
    expect(
      (await facade.recallGenericPreferences(scope, { query: "pause matrix" }))
        .memories.length,
    ).toBeGreaterThan(0);
    // The person's own explicit acts still work while learning is paused: reviewing the
    // already-proposed candidate is their own decision, not an automatic proposal.
    const adopted = await review.confirmDerivedJudgment(scope, proposed.id);
    expect(adopted.judgment.reviewState).toBe("confirmed");
    // The confirmed judgment's document answers from its source bank, for the later resume
    // assertions to read through the indexed path.
    scripted.state.recallByBank.set(sourceBankFor(SOURCE_ONE), {
      status: 200,
      body: {
        results: [
          { document_id: derivedJudgmentDocumentIdFor(TENANT, proposed.id) },
        ],
      },
    });

    // Learning on, usage on: recall of confirmed content answers empty at every seam; the
    // explicit review act above stays recorded.
    await pause.setUsagePaused(TENANT, PRINCIPAL_EMP, USER_EMP, true);
    expect(
      await facade.recallGenericPreferences(scope, { query: "pause matrix" }),
    ).toEqual({ memories: [], degraded: false });
    expect(
      await facade.recallSourceBoundMemories(scope, { query: "pause matrix" }),
    ).toEqual({ memories: [], degraded: false });
    expect(
      await review.recallDerivedJudgments(scope, { query: "pause matrix" }),
    ).toEqual([]);

    // Learning off, usage on: proposals work again (a fresh lead, not the confirmed one), and
    // recall stays empty.
    await pause.setLearningPaused(TENANT, PRINCIPAL_EMP, USER_EMP, false);
    const reproposed = await proposeLead();
    expect(reproposed.reviewState).toBe("unreviewed");
    expect(
      (await facade.recallGenericPreferences(scope, { query: "pause matrix" }))
        .memories,
    ).toEqual([]);

    // Both off again (resume usage): the confirmed content recalls unchanged — resuming usage
    // confirmed nothing new and deleted nothing.
    await pause.setUsagePaused(TENANT, PRINCIPAL_EMP, USER_EMP, false);
    const resumed = await facade.recallGenericPreferences(scope, {
      query: "pause matrix",
    });
    expect(resumed.memories.map((memory) => memory.id)).toContain(
      preference.record.id,
    );
    expect(resumed.degraded).toBe(false);
    const resumedJudgments = await review.recallDerivedJudgments(scope, {
      query: "pause matrix",
    });
    // Exactly the one judgment the PERSON confirmed during the pause — no quiet confirmation
    // of the reproposed candidate by the resume.
    expect(resumedJudgments.map((j) => j.id)).toEqual([proposed.id]);

    // The two switches are stored apart: resuming learning left usage's instant intact and
    // vice versa — verified by the sequence above; the state read confirms the columns.
    const state = await pause.getPauseState(TENANT, PRINCIPAL_EMP);
    expect(state.learningPausedAt).toBeNull();
    expect(state.usagePausedAt).toBeNull();
  });

  test("pause-usage with Hindsight down: no service call, no degradation fallback — a pause is not an outage", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    await preferences.confirmGenericPreference(scope, {
      content: `pause-outage-preference-${run}`,
      provenance: "You",
    });

    await pause.setUsagePaused(TENANT, PRINCIPAL_EMP, USER_EMP, true);
    scripted.state.stallMs = STALL_MS;
    const callsBefore = scripted.state.recallCalls;
    const answer = await facade.recallGenericPreferences(scope, {
      query: "pause outage",
    });
    // Empty WITHOUT the degraded flag: the pause gate answered before the service was ever
    // asked, so the unavailability signal the SQL fallback keys on never fired.
    expect(answer).toEqual({ memories: [], degraded: false });
    expect(scripted.state.recallCalls).toBe(callsBefore);
    scripted.state.stallMs = 0;

    // The same outage WITHOUT the pause degrades as designed — proving the pause, not the
    // wiring, produced the empty answer above.
    await pause.setUsagePaused(TENANT, PRINCIPAL_EMP, USER_EMP, false);
    scripted.state.stallMs = STALL_MS;
    const degraded = await facade.recallGenericPreferences(scope, {
      query: "pause outage",
    });
    expect(degraded.degraded).toBe(true);
    expect(degraded.memories.length).toBeGreaterThan(0);
  });

  test("pausing deletes nothing: the authority rows outlive both switches", async () => {
    const scope = await makeTrustedScope(PRINCIPAL_EMP, WORKSPACE_A);
    const confirmed = await scoped.confirmSourceBoundMemory(scope, {
      content: `pause-keeps-rows-${run}`,
      provenance: "You",
      restriction: { kind: "source", sourceId: SOURCE_ONE },
    });
    await pause.setLearningPaused(TENANT, PRINCIPAL_EMP, USER_EMP, true);
    await pause.setUsagePaused(TENANT, PRINCIPAL_EMP, USER_EMP, true);
    const [row] = await database
      .select()
      .from(sourceBoundMemories)
      .where(
        and(
          eq(sourceBoundMemories.tenantId, TENANT),
          eq(sourceBoundMemories.id, confirmed.record.id),
        ),
      );
    expect(row.deletedAt).toBeNull();
    expect(row.content).toBe(`pause-keeps-rows-${run}`);
    expect(row.enabled).toBe(true);
    // And the person can still forget while paused — their own act, ungated.
    const forgotten = await scoped.forgetSourceBoundMemory(
      scope,
      confirmed.record.id,
    );
    expect(forgotten.stoppedUsingAt instanceof Date).toBe(true);
  });
});
