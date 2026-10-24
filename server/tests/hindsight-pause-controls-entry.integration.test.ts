import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase, type Database } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import { derivedJudgmentCandidates } from "../src/db/schema/hindsight-judgments";
import { hindsightPauseControls } from "../src/db/schema/hindsight-pause";
import { memorySources, personalMemories } from "../src/db/schema/memory";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { createDrizzleDerivedJudgmentRecords } from "../src/hindsight/derived-judgments";
import { createDerivedJudgmentReviewService } from "../src/hindsight/judgment-review";
import {
  createDrizzlePauseControls,
  createUserPauseGate,
} from "../src/hindsight/pause-controls";
import { createDrizzlePreferenceRecords } from "../src/hindsight/preference-recall";
import {
  createDrizzleSourceBoundAuthorizations,
  createDrizzleSourceBoundRecords,
} from "../src/hindsight/scoped-recall";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryStore } from "../src/memory/store";
import { memoryTools } from "../src/memory/tools";
import { MemoryRefusedError } from "../src/memory/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Hindsight 14 (#392) FIX-W1, integration layer: the pause switches' production wiring.
 *
 * F-G1-1: the person's own server entry (`/api/memory/pause-controls` in the memory route
 * family) reads and writes both switches under a server-resolved trusted scope; a body that
 * tries to name a tenant, principal or bank is refused; nobody unauthenticated reaches it; and
 * no other person's switches move. The trusted scopes here are minted by the same
 * `createScopeResolver` the production wiring uses (index.ts hands the routes
 * `enterpriseCapabilities.scopes.resolve`), over a controlled directory stand-in — the same
 * pattern hindsight-pause-controls.integration.test.ts established.
 *
 * F-G1-2: the two legacy recall seams (the personal-memory injection `contextFor` and the
 * `recall_personal_memory` tool's `recall`) answer empty while the person's usage switch is
 * on, silently, and return after resume.
 *
 * F-G1-3: the two legacy candidate seams (a Bot's observation `formMemory` and a connector
 * import `completeSync`) produce nothing while the person's learning switch is on; the
 * person's own explicit remember and everything already stored are untouched.
 *
 * F-G1-5: `expireStaleDerivedJudgmentCandidates` expires only stale unreviewed candidates,
 * idempotently, and the production sweep call point is asserted at source level.
 *
 * FIX-W8 (RFW1-1): the legacy user gate answers under a RESTRICTED application login — the
 * enterprise form's non-superuser, non-BYPASSRLS role with no ob_ent_* capability membership.
 * The pre-fix gate joined enterprise_principals on the main connection; FORCE RLS made that
 * join answer zero rows and both gates fail open. The probe below reproduces that exact form
 * in-session (a dedicated NOLOGIN role granted the reads the application needs, entered with
 * SET LOCAL ROLE inside one transaction) and pins both facts: the old join shape still sees
 * nothing there, and the gate — reading the row's stored user attribution — still answers
 * paused. On the BASE tree this test's gate assertions fail (gate answers not-paused); the
 * fail-open reproduction evidence is .e2e/fixw8/probe-before.log in the run's verification.
 */

const hereDir = dirname(fileURLToPath(import.meta.url));
const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_pw-${run}`;
const WORKSPACE = `ws_pw-${run}`;
const USER_A = `usr_pw-a-${run}`;
const USER_B = `usr_pw-b-${run}`;
const PRINCIPAL_A = `prin_pw-a-${run}`;
const PRINCIPAL_B = `prin_pw-b-${run}`;
const BOT = `bot_pw-${run}`;
const SOURCE = `src_pw-${run}`;

const pause = createDrizzlePauseControls(database);
const userPause = createUserPauseGate(database);
// The production wiring's pair (server/src/index.ts): the store and the ingestion read the
// switches live through the same user bridge the Hindsight chain's seams use beside it.
const store = createMemoryStore(database, {
  learningPaused: (ownerUserId) => userPause.learningPaused(ownerUserId),
});
const plugins = {
  listForAgent: async () => ({ tools: [] }),
  listServers: async () => [],
  agentOwner: async () => null,
  connectionsFor: async () => [],
  brokeredConnectionsFor: async () => [],
  deploymentConnectionFor: async () => null,
} as never;
const ingestion = createMemoryIngestion({
  store,
  plugins,
  usagePaused: (ownerUserId) => userPause.usagePaused(ownerUserId),
});

/** The test harness's session: one header carries who is asking, nothing else. */
const requireTestUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-test-actor");
  if (!id) return context.json({ error: "AUTH_REQUIRED" }, 401);
  context.set("actor", {
    id,
    email: `${id}@example.invalid`,
    name: null,
    image: null,
    role: "user",
  });
  await next();
};

// The controlled directory stand-in from hindsight-pause-controls.integration.test.ts: just
// enough of the tenancy store's query shape to mint a trusted scope for one principal.
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
                    memberEpoch: 1,
                  },
                ],
          ),
      }),
  } as unknown as Database;
}

async function trustedResolverFor(principalId: string, actorId: string) {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  return createScopeResolver(directory, {
    authenticate: async () => ({ actorId, entrypoint: "web" as const }),
    selectTenant: () => TENANT,
    selectWorkspace: () => WORKSPACE,
  });
}

const resolvers = new Map<
  string,
  (request: Request) => Promise<PlatformScope>
>();
let app: Hono<{ Variables: AppVariables }>;

beforeAll(async () => {
  await database.insert(users).values([
    { id: USER_A, email: `pw-a-${run}@example.invalid` },
    { id: USER_B, email: `pw-b-${run}@example.invalid` },
  ]);
  await database.insert(agents).values({
    id: BOT,
    name: "Pause Wiring Bot",
    type: "built_in",
    configuration: {},
  });
  await database
    .insert(enterpriseTenants)
    .values([{ id: TENANT, name: `Pause Wiring ${run}` }]);
  await database.insert(enterprisePrincipals).values([
    { id: PRINCIPAL_A, userId: USER_A },
    { id: PRINCIPAL_B, userId: USER_B },
  ]);
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT, principalId: PRINCIPAL_A, role: "member" },
    { tenantId: TENANT, principalId: PRINCIPAL_B, role: "member" },
  ]);
  await database
    .insert(enterpriseWorkspaces)
    .values([
      { tenantId: TENANT, id: WORKSPACE, name: `Pause Wiring A ${run}` },
    ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL_A },
    { tenantId: TENANT, workspaceId: WORKSPACE, principalId: PRINCIPAL_B },
  ]);
  resolvers.set(
    USER_A,
    (await trustedResolverFor(PRINCIPAL_A, USER_A)).resolve,
  );
  resolvers.set(
    USER_B,
    (await trustedResolverFor(PRINCIPAL_B, USER_B)).resolve,
  );
  app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMemoryRoutes(store, ingestion, requireTestUser, {
      pauseControls: {
        pause,
        resolveScope: (request) => {
          const resolve = resolvers.get(
            request.headers.get("x-test-actor") ?? "",
          );
          if (!resolve) throw new Error("AUTH_REQUIRED");
          return resolve(request);
        },
      },
    }),
  );
});

afterAll(async () => {
  // Resuming clears the columns, not the row; the row's (tenant, principal) keys must go before
  // the membership they hang off.
  await database
    .delete(hindsightPauseControls)
    .where(eq(hindsightPauseControls.tenantId, TENANT));
  await database
    .delete(derivedJudgmentCandidates)
    .where(eq(derivedJudgmentCandidates.tenantId, TENANT));
  await database.delete(users).where(eq(users.id, USER_A));
  await database.delete(users).where(eq(users.id, USER_B));
  await database
    .delete(enterpriseWorkspaceMemberships)
    .where(eq(enterpriseWorkspaceMemberships.tenantId, TENANT));
  await database
    .delete(enterpriseMemberships)
    .where(eq(enterpriseMemberships.tenantId, TENANT));
  await database
    .delete(enterpriseWorkspaces)
    .where(eq(enterpriseWorkspaces.tenantId, TENANT));
  await database
    .delete(enterprisePrincipals)
    .where(eq(enterprisePrincipals.id, PRINCIPAL_A));
  await database
    .delete(enterprisePrincipals)
    .where(eq(enterprisePrincipals.id, PRINCIPAL_B));
  await database
    .delete(enterpriseTenants)
    .where(eq(enterpriseTenants.id, TENANT));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.$client.close();
});

function requestAs(actor: string | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  if (actor) headers["x-test-actor"] = actor;
  return app.request(path, { ...init, headers });
}

async function pauseStateFor(actor: string) {
  const response = await requestAs(actor, "/pause-controls");
  return { status: response.status, body: await response.json() };
}

describe("#392 FIX-W1 — the person's own pause entry (F-G1-1)", () => {
  test("reads and writes the person's own two switches, each resume clearing only its own", async () => {
    const before = await pauseStateFor(USER_A);
    expect(before.status).toBe(200);
    expect(before.body.pauseControls.learningPausedAt).toBeNull();
    expect(before.body.pauseControls.usagePausedAt).toBeNull();

    const paused = await requestAs(USER_A, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ learningPaused: true, usagePaused: true }),
    });
    expect(paused.status).toBe(200);
    const pausedBody = await paused.json();
    expect(typeof pausedBody.pauseControls.learningPausedAt).toBe("string");
    expect(typeof pausedBody.pauseControls.usagePausedAt).toBe("string");

    // Resuming learning leaves usage paused: each switch clears exactly its own instant.
    const resumedLearning = await requestAs(USER_A, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ learningPaused: false }),
    });
    const resumedBody = await resumedLearning.json();
    expect(resumedBody.pauseControls.learningPausedAt).toBeNull();
    expect(resumedBody.pauseControls.usagePausedAt).toBe(
      pausedBody.pauseControls.usagePausedAt,
    );

    const cleared = await requestAs(USER_A, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ usagePaused: false }),
    });
    expect((await cleared.json()).pauseControls.usagePausedAt).toBeNull();
  });

  test("refuses a body that tries to name a tenant, principal or bank", async () => {
    for (const forged of [
      { learningPaused: true, tenantId: "tn_other" },
      { usagePaused: true, principalId: "prin_other" },
      { usagePaused: true, bank: "ob_b_forge" },
    ]) {
      const response = await requestAs(USER_A, "/pause-controls", {
        method: "POST",
        body: JSON.stringify(forged),
      });
      expect(response.status).toBe(400);
      // And nothing moved on the wire: the strict schema refused before any write.
      expect((await pauseStateFor(USER_A)).body.pauseControls).toEqual({
        learningPausedAt: null,
        usagePausedAt: null,
      });
    }
  });

  test("refuses an unauthenticated ask, and answers a scopeless ask the same way", async () => {
    expect((await requestAs(null, "/pause-controls")).status).toBe(401);
    const noSession = await requestAs(null, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ learningPaused: true }),
    });
    expect(noSession.status).toBe(401);
    // A session nobody resolves a scope for reads as the same refusal, not a guessed identity.
    const unresolvable = await requestAs(
      `usr_unknown-${run}`,
      "/pause-controls",
    );
    expect(unresolvable.status).toBe(401);
  });

  test("is the person's own face only: another person's switches stay put, and no admin face exists", async () => {
    await requestAs(USER_A, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ learningPaused: true }),
    });
    expect((await pauseStateFor(USER_B)).body.pauseControls).toEqual({
      learningPausedAt: null,
      usagePausedAt: null,
    });
    await requestAs(USER_A, "/pause-controls", {
      method: "POST",
      body: JSON.stringify({ learningPaused: false }),
    });
    // The switch family has exactly one face — the person's own memory settings route. The
    // admin surfaces register nothing here (a scan over the server sources, like the
    // payer-no-fallback wiring pins): a way to pause somebody else's memory would appear.
    const routesSource = await readFile(
      join(hereDir, "..", "src", "memory", "routes.ts"),
      "utf8",
    );
    expect(routesSource).toContain('"/pause-controls"');
    const { readdir } = await import("node:fs/promises");
    const adminDir = join(hereDir, "..", "src", "admin");
    const adminFiles = await readdir(adminDir).catch(() => [] as string[]);
    for (const file of adminFiles) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(join(adminDir, file), "utf8");
      expect(source).not.toContain("pause-controls");
      expect(source).not.toContain("setLearningPaused");
      expect(source).not.toContain("setUsagePaused");
    }
  });
});

describe("#392 FIX-W1 — the legacy recall seams obey pause-usage (F-G1-2)", () => {
  test("injection and the recall tool answer empty while paused, and return after resume", async () => {
    const content = `pw2 tea preference ${run}`;
    await store.create(USER_A, { content, provenance: "You" });
    // Before the switch: both legacy seams answer the confirmed memory.
    expect(await ingestion.contextFor(USER_A, BOT)).toContain(content);
    expect((await ingestion.recall(USER_A, BOT)).length).toBeGreaterThan(0);
    const recallTool = memoryTools({
      store,
      ingestion,
      ownerUserId: USER_A,
      agentId: BOT,
    }).find((tool) => tool.name === "recall_personal_memory");
    if (!recallTool) throw new Error("Expected the recall tool.");
    expect((await recallTool.execute({})) as string).toContain(content);

    await pause.setUsagePaused(TENANT, PRINCIPAL_A, USER_A, true);
    // While paused: both seams answer empty — no error, and no word of the switch in the tool's
    // answer ("[]" is the empty-memory shape, not a pause tell).
    expect(await ingestion.contextFor(USER_A, BOT)).toBe("");
    expect(await ingestion.recall(USER_A, BOT)).toEqual([]);
    expect(await recallTool.execute({})).toBe("[]");
    // Pausing usage deleted nothing: the person's own list still shows the memory.
    expect(
      (await store.list(USER_A)).some((memory) => memory.content === content),
    ).toBe(true);

    await pause.setUsagePaused(TENANT, PRINCIPAL_A, USER_A, false);
    expect(await ingestion.contextFor(USER_A, BOT)).toContain(content);
    expect(await recallTool.execute({})).toContain(content);
  });

  test("the switch is per person: the other person's recall is untouched", async () => {
    const content = `pw2 keeps recalling ${run}`;
    await store.create(USER_B, { content, provenance: "You" });
    await pause.setUsagePaused(TENANT, PRINCIPAL_A, USER_A, true);
    try {
      expect(await ingestion.contextFor(USER_A, BOT)).toBe("");
      expect(await ingestion.contextFor(USER_B, BOT)).toContain(content);
    } finally {
      await pause.setUsagePaused(TENANT, PRINCIPAL_A, USER_A, false);
    }
  });
});

describe("#392 FIX-W1 — the candidate seams obey pause-learning (F-G1-3)", () => {
  test("a Bot observation is refused while paused and resumes afterwards; explicit remember and visibility are untouched", async () => {
    const observed = `pw3 observed fact ${run}`;
    const formed = await store.formMemory(USER_A, {
      content: observed,
      sourceApp: "Chat",
      agentId: BOT,
      sourceRef: null,
    });
    expect(formed.duplicate).toBe(false);

    await pause.setLearningPaused(TENANT, PRINCIPAL_A, USER_A, true);
    try {
      // The observation seam: refused, nothing written.
      await expect(
        store.formMemory(USER_A, {
          content: `pw3 paused observation ${run}`,
          sourceApp: "Chat",
          agentId: BOT,
          sourceRef: null,
        }),
      ).rejects.toBeInstanceOf(MemoryRefusedError);
      expect(
        await database
          .select({ id: personalMemories.id })
          .from(personalMemories)
          .where(
            and(
              eq(personalMemories.ownerUserId, USER_A),
              eq(personalMemories.content, `pw3 paused observation ${run}`),
            ),
          ),
      ).toEqual([]);
      // The person's own explicit remember is not this switch's business.
      await store.create(USER_A, {
        content: `pw3 explicit remember ${run}`,
        provenance: "You",
      });
      // Everything already stored stays visible to the person.
      const listed = (await store.list(USER_A)).map((memory) => memory.content);
      expect(listed).toContain(observed);
      expect(listed).toContain(`pw3 explicit remember ${run}`);
      // And the already-confirmed content still recalls (usage was never paused here).
      expect(await ingestion.recall(USER_A, BOT, "pw3 explicit")).not.toEqual(
        [],
      );
    } finally {
      await pause.setLearningPaused(TENANT, PRINCIPAL_A, USER_A, false);
    }
    // After resume the observation seam forms candidates again.
    const resumed = await store.formMemory(USER_A, {
      content: `pw3 resumed observation ${run}`,
      sourceApp: "Chat",
      agentId: BOT,
      sourceRef: null,
    });
    expect(resumed.duplicate).toBe(false);
  });

  test("a connector sync completes but writes no candidate while paused", async () => {
    await database.insert(memorySources).values({
      id: SOURCE,
      ownerUserId: USER_A,
      agentId: BOT,
      toolRef: "srv/read_documents",
      title: "Records",
      enabled: true,
    });
    const record = (externalId: string, content: string) => ({
      externalId,
      content,
      provenance: "Records",
      digest: `${externalId}-digest-${run}`,
    });
    const imported = async () =>
      database
        .select({ externalId: personalMemories.externalId })
        .from(personalMemories)
        .where(eq(personalMemories.sourceId, SOURCE));

    await store.completeSync(USER_A, SOURCE, [
      record("pw4-a", `pw4 record a ${run}`),
      record("pw4-b", `pw4 record b ${run}`),
    ]);
    expect((await imported()).length).toBe(2);

    await pause.setLearningPaused(TENANT, PRINCIPAL_A, USER_A, true);
    try {
      const sourceBefore = await store.getSource(USER_A, SOURCE);
      await store.completeSync(USER_A, SOURCE, [
        record("pw4-c", `pw4 record c ${run}`),
      ]);
      // No new candidate — and the sync still completed honestly: the source succeeded and its
      // schedule advanced, the already-imported rows untouched.
      expect((await imported()).length).toBe(2);
      const sourceAfter = await store.getSource(USER_A, SOURCE);
      expect(sourceAfter.syncStatus).toBe("succeeded");
      expect(sourceAfter.lastSyncAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
        sourceBefore.lastSyncAt?.getTime() ?? 0,
      );
    } finally {
      await pause.setLearningPaused(TENANT, PRINCIPAL_A, USER_A, false);
    }
    // After resume the same record imports.
    await store.completeSync(USER_A, SOURCE, [
      record("pw4-c", `pw4 record c ${run}`),
    ]);
    expect((await imported()).length).toBe(3);
  });
});

describe("#392 FIX-W1 — the derived-judgment expiry rides the sweep (F-G1-5)", () => {
  test("expireStaleDerivedJudgmentCandidates expires only stale unreviewed candidates, idempotently", async () => {
    const judgments = createDrizzleDerivedJudgmentRecords(database);
    const review = createDerivedJudgmentReviewService(
      createDrizzlePreferenceRecords(database),
      createDrizzleSourceBoundRecords(database),
      judgments,
      createDrizzleSourceBoundAuthorizations(database),
      // The expiry stage makes no remote call; the config only has to be shaped.
      {
        apiUrl: "http://127.0.0.1:9",
        serviceApiKey: `svc-${run}`,
        assertionSecret: `assert-${run}`,
        requestTimeoutMs: 100,
      },
    );
    const staleAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const insert = (id: string, extra: Record<string, unknown> = {}) =>
      database.insert(derivedJudgmentCandidates).values({
        tenantId: TENANT,
        id,
        principalId: PRINCIPAL_A,
        scopeKind: "general",
        content: `pw5 judgment ${id} ${run}`,
        provenance: "Hindsight",
        proposalDigest: `pw5-digest-${id}-${run}`,
        hindsightDocumentId: `pw5-doc-${id}-${run}`,
        ...extra,
      });
    await insert(`stale-${run}`, { proposedAt: staleAt });
    await insert(`fresh-${run}`, { proposedAt: new Date() });
    await insert(`confirmed-${run}`, {
      proposedAt: staleAt,
      reviewState: "confirmed",
      reviewedAt: new Date(),
    });

    const first = await review.expireStaleDerivedJudgmentCandidates();
    expect(first.expired).toBe(1);
    const rows = await database
      .select({
        id: derivedJudgmentCandidates.id,
        reviewState: derivedJudgmentCandidates.reviewState,
        reviewedAt: derivedJudgmentCandidates.reviewedAt,
      })
      .from(derivedJudgmentCandidates)
      .where(eq(derivedJudgmentCandidates.tenantId, TENANT));
    const stateOf = (id: string) =>
      rows.find((row) => row.id === id)?.reviewState;
    expect(stateOf(`stale-${run}`)).toBe("expired");
    expect(stateOf(`fresh-${run}`)).toBe("unreviewed");
    expect(stateOf(`confirmed-${run}`)).toBe("confirmed");
    // Idempotent: a repeated sweep expires nothing more.
    expect((await review.expireStaleDerivedJudgmentCandidates()).expired).toBe(
      0,
    );
  });

  test("the sweep step and the one-switch wiring exist in the server entry", async () => {
    const source = await readFile(
      join(hereDir, "..", "src", "index.ts"),
      "utf8",
    );
    // F-G1-5: the expiry rides the existing memorySweep stages.
    expect(source).toContain(
      'sweepStep("expireStaleDerivedJudgmentCandidates"',
    );
    expect(source).toContain("expireStaleDerivedJudgmentCandidates()");
    // The ONE switch instance serves the chain seams, the legacy gates and the entry.
    expect(source).toContain("personalMemoryPauseControls");
    expect(source).toContain("createUserPauseGate(database)");
    expect(source).toContain("pauseControls: {");
  });
});

describe("#392 FIX-W8 — the user gate holds under a restricted application login (RFW1-1)", () => {
  test("the join shape fail-opens under a restricted role; the stored attribution does not", async () => {
    // The enterprise form's application login: the grants the application's own reads need,
    // and membership in no capability role, no superuser, no BYPASSRLS — the shape every
    // policy on enterprise_principals (FORCE RLS) refuses, which is exactly the point.
    const PROBE_ROLE = `ob_pw_rls_${run.replaceAll("-", "")}`;
    const createProbeRole = async () => {
      await database.execute(
        sql.raw(
          `CREATE ROLE "${PROBE_ROLE}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        ),
      );
      await database.execute(
        sql.raw(`GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}"`),
      );
      await database.execute(
        sql.raw(
          `GRANT SELECT ON TABLE enterprise_principals, hindsight_pause_controls TO "${PROBE_ROLE}"`,
        ),
      );
    };
    const dropProbeRole = async () => {
      await database
        .execute(
          sql.raw(
            `REVOKE ALL ON TABLE enterprise_principals, hindsight_pause_controls FROM "${PROBE_ROLE}"`,
          ),
        )
        .catch(() => undefined);
      await database
        .execute(sql.raw(`REVOKE USAGE ON SCHEMA public FROM "${PROBE_ROLE}"`))
        .catch(() => undefined);
      await database
        .execute(sql.raw(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`))
        .catch(() => undefined);
    };
    await dropProbeRole();
    await createProbeRole();
    try {
      // The production write path flips both switches for A; the row must carry A's own
      // server-resolved attribution (the resolver selected the principal BY the actor's id).
      const paused = await requestAs(USER_A, "/pause-controls", {
        method: "POST",
        body: JSON.stringify({ learningPaused: true, usagePaused: true }),
      });
      expect(paused.status).toBe(200);
      const [stored] = await database
        .select({ userId: hindsightPauseControls.userId })
        .from(hindsightPauseControls)
        .where(
          and(
            eq(hindsightPauseControls.tenantId, TENANT),
            eq(hindsightPauseControls.principalId, PRINCIPAL_A),
          ),
        );
      expect(stored?.userId).toBe(USER_A);

      // The superuser connection (every pre-FIX-W8 test topology) holds, as always.
      const superuserGate = createUserPauseGate(database);
      expect(await superuserGate.learningPaused(USER_A)).toBe(true);
      expect(await superuserGate.usagePaused(USER_A)).toBe(true);

      // The restricted application login: one transaction, one pinned connection, the role
      // entered and left with the transaction — nothing persists outside it.
      await database.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL ROLE "${PROBE_ROLE}"`));

        // The pre-fix resolution shape: joining the FORCE-RLS directory table answers zero
        // rows here. Pinned so the topology stays honest — if this ever returns rows, the
        // probe role accidentally became a capability role and the test proves nothing.
        const joinRows = (await tx.execute(sql`
          SELECT p.learning_paused_at
          FROM hindsight_pause_controls p
          INNER JOIN enterprise_principals ep ON ep.id = p.principal_id
          WHERE ep.user_id = ${USER_A}
        `)) as unknown as unknown[];
        expect(joinRows.length).toBe(0);

        // The gate itself, on the same restricted connection: both switches hold — the
        // single-table read never consults the directory's row visibility, so the answer no
        // longer depends on the connection's privileges.
        const gate = createUserPauseGate(tx as unknown as Database);
        expect(await gate.learningPaused(USER_A)).toBe(true);
        expect(await gate.usagePaused(USER_A)).toBe(true);
        // And the attribution stays per person: B's memories are not paused by A's switch.
        expect(await gate.usagePaused(USER_B)).toBe(false);
      });
    } finally {
      await requestAs(USER_A, "/pause-controls", {
        method: "POST",
        body: JSON.stringify({ learningPaused: false, usagePaused: false }),
      }).catch(() => undefined);
      await dropProbeRole();
    }
  });
});
