import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
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
import { users } from "../src/db/schema/core";
import { enterpriseBotOwnership } from "../src/db/schema/enterprise-bot-ownership";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
  enterpriseWorkspaces,
} from "../src/db/schema/enterprise-tenancy";
import {
  hindsightMigrationQuarantine,
  hindsightMigrationRuns,
} from "../src/db/schema/hindsight-legacy-migration";
import { personalMemories } from "../src/db/schema/memory";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { resolveMemoryCompany } from "../src/memory/company";
import { createMemoryIngestion } from "../src/memory/ingestion";
import { createMemoryRoutes } from "../src/memory/routes";
import { createMemoryStore } from "../src/memory/store";
import { memoryTools } from "../src/memory/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * FIX-F1 (#376, FR-1), integration layer: the old personal-memory face's company isolation.
 *
 * One GLOBAL user holds confirmed memories in two companies (tenant A and tenant B), and the
 * assertions run through the production seams only — the real `createMemoryRoutes` with a
 * trusted-scope `companyScope` (the same `createScopeResolver` the production wiring hands the
 * routes), the real `memoryTools` with the production `resolveMemoryCompany` wiring, and the
 * real `contextFor` injection behind an ingestion wired with `companyFor`:
 *
 *   - FR-1 route leg: company A's memory is not on the company-B list and not on the no-company
 *     list (fail closed), and the same-company list is the positive answer; a company-B write
 *     stamps company B; review and forgetting reach only the current company's rows.
 *   - FR-1 tool leg: company B's Bot recalls company B's memories alone — company A's are not
 *     reachable through any tool of company B's Bot (recall, remember, observe, forget), and
 *     company A's Bot is the positive same-company answer.
 *   - An unattributed row (the migration's isolation semantics) is on nobody's list and in
 *     nobody's recall, its own owner's included.
 *   - A personal Bot of a two-company person resolves no company and its tools refuse; a
 *     personal Bot of a one-company person works in that company (the provable attribution).
 *   - A wiring WITHOUT the company options (a deployment without the enterprise layer) keeps
 *     the global-owner behaviour unchanged — the standing the brief tells us to preserve.
 *
 * The migration block at the bottom drives migration 0211's own SQL — read from the shipped
 * file — over a prepared pre-migration state and pins the backfill and isolation-list rules.
 *
 * Trusted scopes are minted by the same controlled directory stand-in the pause-entry suite
 * established (hindsight-pause-controls-entry.integration.test.ts): just enough of the tenancy
 * store's query shape to answer one principal's active membership, with the SELECTED company
 * carried by the same header the production resolver reads.
 */

const hereDir = dirname(fileURLToPath(import.meta.url));
const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_ca-a-${run}`;
const TENANT_B = `tn_ca-b-${run}`;
const WS_A = `ws_ca-a-${run}`;
const WS_B = `ws_ca-b-${run}`;
const USER = `usr_ca-u-${run}`;
const SOLO = `usr_ca-solo-${run}`;
const PRIN = `prin_ca-${run}`;
const PRIN_SOLO = `prin_ca-solo-${run}`;
const BOT_A = `bot_ca-a-${run}`;
const BOT_B = `bot_ca-b-${run}`;
const PERSONAL_BOT = `bot_ca-p-${run}`;
const SOLO_BOT = `bot_ca-solo-${run}`;
const A_FACT = `ca company A fact ${run}`;
const B_FACT = `ca company B fact ${run}`;
const UNATTRIBUTED_FACT = `ca unattributed fact ${run}`;
const SOLO_FACT = `ca solo person fact ${run}`;

const store = createMemoryStore(database);
const plugins = {
  listForAgent: async () => ({ tools: [] }),
  listServers: async () => [],
  agentOwner: async () => null,
  connectionsFor: async () => [],
  brokeredConnectionsFor: async () => [],
  deploymentConnectionFor: async () => null,
} as never;
// The enterprise wiring's ingestion: the production `companyFor` (memory/company.ts) behind it.
const ingestion = createMemoryIngestion({
  store,
  plugins,
  companyFor: (input) => resolveMemoryCompany(database, input),
});
// A deployment without the enterprise layer: no company anywhere, the old standing kept.
const unscopedIngestion = createMemoryIngestion({ store, plugins });

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

// The controlled directory stand-in from hindsight-pause-controls-entry.integration.test.ts:
// just enough of the tenancy store's query shape to mint one principal's trusted scope.
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

/** A trusted resolver for one principal, selecting company and workspace by the SAME headers the production resolver reads. */
async function trustedResolverFor(principalId: string) {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  return createScopeResolver(directory, {
    authenticate: async (request) => ({
      actorId: request.headers.get("x-test-actor") ?? "",
      entrypoint: "web" as const,
    }),
    selectTenant: (request) => request.headers.get("x-openbot-tenant"),
    selectWorkspace: (request) => request.headers.get("x-openbot-workspace"),
  });
}

const resolvers = new Map<
  string,
  (request: Request) => Promise<PlatformScope>
>();
let app: Hono<{ Variables: AppVariables }>;

beforeAll(async () => {
  await database.insert(users).values([
    { id: USER, email: `ca-u-${run}@example.invalid` },
    { id: SOLO, email: `ca-solo-${run}@example.invalid` },
  ]);
  await database.insert(enterpriseTenants).values([
    { id: TENANT_A, name: `Isolation A ${run}` },
    { id: TENANT_B, name: `Isolation B ${run}` },
  ]);
  await database.insert(enterprisePrincipals).values([
    { id: PRIN, userId: USER },
    { id: PRIN_SOLO, userId: SOLO },
  ]);
  // The global user is an active member of BOTH companies; the solo person of one.
  await database.insert(enterpriseMemberships).values([
    { tenantId: TENANT_A, principalId: PRIN, role: "member" },
    { tenantId: TENANT_B, principalId: PRIN, role: "member" },
    { tenantId: TENANT_A, principalId: PRIN_SOLO, role: "member" },
  ]);
  await database.insert(enterpriseWorkspaces).values([
    { tenantId: TENANT_A, id: WS_A, name: `Isolation A ws ${run}` },
    { tenantId: TENANT_B, id: WS_B, name: `Isolation B ws ${run}` },
  ]);
  await database.insert(enterpriseWorkspaceMemberships).values([
    { tenantId: TENANT_A, workspaceId: WS_A, principalId: PRIN },
    { tenantId: TENANT_B, workspaceId: WS_B, principalId: PRIN },
    { tenantId: TENANT_A, workspaceId: WS_A, principalId: PRIN_SOLO },
  ]);
  // The two company Bots (ownership rows are globally unique per Bot); the personal Bots have none.
  await database.insert(enterpriseBotOwnership).values([
    {
      tenantId: TENANT_A,
      agentId: BOT_A,
      workspaceId: WS_A,
      ownerPrincipalId: PRIN,
      displayName: `Isolation Bot A ${run}`,
      defaultConfig: {},
    },
    {
      tenantId: TENANT_B,
      agentId: BOT_B,
      workspaceId: WS_B,
      ownerPrincipalId: PRIN,
      displayName: `Isolation Bot B ${run}`,
      defaultConfig: {},
    },
  ]);
  // One person, two companies' confirmed memories, and one row nobody could attribute.
  await store.create(
    USER,
    { content: A_FACT, provenance: "You" },
    { tenantId: TENANT_A },
  );
  await store.create(
    USER,
    { content: B_FACT, provenance: "You" },
    { tenantId: TENANT_B },
  );
  await database.insert(personalMemories).values({
    id: `${run}-unattributed`,
    ownerUserId: USER,
    tenantId: null,
    content: UNATTRIBUTED_FACT,
    provenance: "You",
    reviewState: "confirmed",
    formedBy: "person",
  });
  await store.create(
    SOLO,
    { content: SOLO_FACT, provenance: "You" },
    { tenantId: TENANT_A },
  );
  // The route face, wired the way index.ts wires it: the trusted scope resolves the company.
  resolvers.set(TENANT_A, (await trustedResolverFor(PRIN)).resolve);
  resolvers.set(TENANT_B, (await trustedResolverFor(PRIN)).resolve);
  app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createMemoryRoutes(store, ingestion, requireTestUser, {
      companyScope: {
        resolveScope: (request) => {
          const resolve = resolvers.get(
            request.headers.get("x-openbot-tenant") ?? "",
          );
          if (!resolve) throw new Error("TENANT_REQUIRED");
          return resolve(request);
        },
      },
    }),
  );
});

afterAll(async () => {
  // The user rows cascade their memories, principals and (through them) memberships; the
  // tenants cascade workspaces and the Bot ownership rows; the isolation-list rows this run
  // wrote carry no FKs, so they go by their own ids before the run row is restored.
  await database
    .delete(hindsightMigrationQuarantine)
    .where(eq(hindsightMigrationQuarantine.runId, BACKFILL_RUN));
  await database
    .delete(hindsightMigrationQuarantine)
    .where(
      inArray(hindsightMigrationQuarantine.oldRecordId, quarantinedFixtureIds),
    );
  await database
    .update(hindsightMigrationRuns)
    .set({ processed: 0, quarantined: 0 })
    .where(eq(hindsightMigrationRuns.id, BACKFILL_RUN));
  await database.delete(users).where(inArray(users.id, [USER, SOLO]));
  await database
    .delete(enterpriseTenants)
    .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
  await database
    .delete(personalMemories)
    .where(eq(personalMemories.id, `${run}-unattributed`));
  await database.$client.close();
});

/** A request as one company of the two-company person (the headers the resolver reads). */
function requestAs(
  actor: string,
  path: string,
  init: RequestInit & { tenant?: string } = {},
) {
  const { tenant, ...rest } = init;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(rest.headers as Record<string, string>),
  };
  headers["x-test-actor"] = actor;
  if (tenant) {
    headers["x-openbot-tenant"] = tenant;
    headers["x-openbot-workspace"] = tenant === TENANT_A ? WS_A : WS_B;
  }
  return app.request(path, { ...rest, headers });
}

/** The memory tool of one Bot, wired the way index.ts wires the catalogue face. */
function toolOf(botId: string, name: string, ownerUserId = USER) {
  const tool = memoryTools({
    store,
    ingestion,
    ownerUserId,
    agentId: botId,
    companyFor: () =>
      resolveMemoryCompany(database, { ownerUserId, agentId: botId }),
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Expected the ${name} tool.`);
  return tool;
}

describe("FIX-F1 — the old route face answers one company's rows", () => {
  test("the list shows the asking company's memories and neither the other company's nor an unattributed row", async () => {
    const listA = await requestAs(USER, "/", { tenant: TENANT_A });
    expect(listA.status).toBe(200);
    const bodyA = (await listA.json()) as { memories: { content: string }[] };
    const contentsA = bodyA.memories.map((memory) => memory.content);
    expect(contentsA).toContain(A_FACT);
    expect(contentsA).not.toContain(B_FACT);
    expect(contentsA).not.toContain(UNATTRIBUTED_FACT);

    const listB = await requestAs(USER, "/", { tenant: TENANT_B });
    const bodyB = (await listB.json()) as { memories: { content: string }[] };
    const contentsB = bodyB.memories.map((memory) => memory.content);
    expect(contentsB).toContain(B_FACT);
    expect(contentsB).not.toContain(A_FACT);
    expect(contentsB).not.toContain(UNATTRIBUTED_FACT);
  });

  test("a request the trusted scope cannot resolve fails closed, never a guessed company", async () => {
    const noTenant = await requestAs(USER, "/");
    expect(noTenant.status).toBe(400);
    expect(await noTenant.json()).toEqual({ error: "TENANT_REQUIRED" });
  });

  test("a write stamps the asking company; the row answers that company alone", async () => {
    const content = `ca route write ${run}`;
    const created = await requestAs(USER, "/", {
      method: "POST",
      tenant: TENANT_B,
      body: JSON.stringify({ content, provenance: "You" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { memory: { id: string } };
    expect(typeof createdBody.memory.id).toBe("string");

    const listB = await requestAs(USER, "/", { tenant: TENANT_B });
    expect(
      (
        (await listB.json()) as { memories: { content: string }[] }
      ).memories.map((row) => row.content),
    ).toContain(content);
    const listA = await requestAs(USER, "/", { tenant: TENANT_A });
    expect(
      (
        (await listA.json()) as { memories: { content: string }[] }
      ).memories.map((row) => row.content),
    ).not.toContain(content);

    // Review and forgetting are company-scoped acts too: company B cannot edit or forget
    // company A's row, and the refusal is the same not-found it always was.
    const aRow = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(eq(personalMemories.content, A_FACT))
      .limit(1);
    expect(aRow.length).toBe(1);
    const patched = await requestAs(USER, `/${aRow[0]!.id}`, {
      method: "PATCH",
      tenant: TENANT_B,
      body: JSON.stringify({ content: "rewritten by company B" }),
    });
    expect(patched.status).toBe(404);
    const removed = await requestAs(USER, `/${aRow[0]!.id}`, {
      method: "DELETE",
      tenant: TENANT_B,
    });
    expect(removed.status).toBe(404);
    // The row itself is untouched.
    const [after] = await database
      .select({ content: personalMemories.content })
      .from(personalMemories)
      .where(eq(personalMemories.id, aRow[0]!.id));
    expect(after.content).toBe(A_FACT);
  });
});

describe("FIX-F1 — the old tool face answers the Bot's company", () => {
  test("company B's Bot recalls company B alone; company A's Bot is the positive answer", async () => {
    const recallB = await toolOf(BOT_B, "recall_personal_memory").execute({});
    expect(recallB as string).toContain(B_FACT);
    expect(recallB as string).not.toContain(A_FACT);
    expect(recallB as string).not.toContain(UNATTRIBUTED_FACT);

    const recallA = await toolOf(BOT_A, "recall_personal_memory").execute({});
    expect(recallA as string).toContain(A_FACT);
    expect(recallA as string).not.toContain(B_FACT);
  });

  test("the personal-memory injection carries the Bot's company alone", async () => {
    expect(await ingestion.contextFor(USER, BOT_B)).toContain(B_FACT);
    expect(await ingestion.contextFor(USER, BOT_B)).not.toContain(A_FACT);
    expect(await ingestion.contextFor(USER, BOT_A)).toContain(A_FACT);
    expect(await ingestion.contextFor(USER, BOT_A)).not.toContain(B_FACT);
  });

  test("a company-B tool write stamps company B; the forget tool reaches only its own company", async () => {
    const content = `ca tool write ${run}`;
    const remembered = await toolOf(BOT_B, "remember_personal_fact").execute({
      content,
      provenance: "You",
    });
    const parsed = JSON.parse(remembered as string) as { id: string };
    const [row] = await database
      .select({ tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(eq(personalMemories.id, parsed.id));
    expect(row.tenantId).toBe(TENANT_B);

    const aRow = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(eq(personalMemories.content, A_FACT))
      .limit(1);
    // Company B's Bot cannot forget company A's memory: the refusal names not-found.
    const forgot = await toolOf(BOT_B, "forget_personal_memory").execute({
      id: aRow[0]!.id,
    });
    expect(forgot as string).toMatch(/^Refused\./);
    const [after] = await database
      .select({ content: personalMemories.content })
      .from(personalMemories)
      .where(eq(personalMemories.id, aRow[0]!.id));
    expect(after.content).toBe(A_FACT);
  });

  test("a personal Bot of a two-company person resolves no company and fails closed; a one-company person's works", async () => {
    // Two active memberships name no single company — the tools refuse, never guess.
    const recall = await toolOf(PERSONAL_BOT, "recall_personal_memory").execute(
      {},
    );
    expect(recall as string).toMatch(
      /^Refused\. Personal memory is not available for this Bot right now\.$/,
    );
    const remember = await toolOf(
      PERSONAL_BOT,
      "remember_personal_fact",
    ).execute({
      content: `ca ambiguous write ${run}`,
      provenance: "You",
    });
    expect(remember as string).toMatch(/^Refused\./);
    // The injection answers the same no-company with its honest empty.
    expect(await ingestion.contextFor(USER, PERSONAL_BOT)).toBe("");

    // One active membership IS provable: the personal Bot works in that company.
    const soloRecall = await toolOf(
      SOLO_BOT,
      "recall_personal_memory",
      SOLO,
    ).execute({});
    expect(soloRecall as string).toContain(SOLO_FACT);
    expect(await ingestion.contextFor(SOLO, SOLO_BOT)).toContain(SOLO_FACT);
  });

  test("a wiring without the enterprise layer keeps the global-owner behaviour unchanged", async () => {
    // The single-user deployment's standing: no company options anywhere, and the old face
    // answers the person's rows across the whole deployment exactly as it always did.
    expect(await unscopedIngestion.contextFor(USER, BOT_B)).toContain(A_FACT);
    expect(await unscopedIngestion.contextFor(USER, BOT_B)).toContain(B_FACT);
    expect(
      (await unscopedIngestion.recall(USER, BOT_A)).map((row) => row.content),
    ).toEqual(expect.arrayContaining([A_FACT, B_FACT]));
  });
});

/*
 * Migration 0211's own rules, driven over a prepared pre-migration state.
 *
 * The chain has already applied 0211 to this database (its DDL is in place), so this block
 * reads the SHIPPED file and executes its data statements again — every one of them is
 * state-based and idempotent (`WHERE tenant_id IS NULL`, `ON CONFLICT DO NOTHING`) — against
 * rows seeded the way the old table looked before the migration: the first three statements
 * are pinned as the DDL by shape before anything runs.
 */
const BACKFILL_RUN = "0211-personal-memories-company-attribution";
const quarantinedFixtureIds: string[] = [];

describe("FIX-F1 — migration 0211 backfills proven attribution and isolates the rest", () => {
  const PROV_USER = `usr_ca-prov-${run}`;
  const AMBIG_USER = `usr_ca-amb-${run}`;
  const NOPRIN_USER = `usr_ca-noprin-${run}`;
  const ids = {
    provConfirmed: `${run}-prov-confirmed`,
    provPending: `${run}-prov-pending`,
    ambConfirmed: `${run}-amb-confirmed`,
    ambPending: `${run}-amb-pending`,
    noprinConfirmed: `${run}-noprin-confirmed`,
  };

  beforeAll(async () => {
    await database.insert(users).values([
      { id: PROV_USER, email: `ca-prov-${run}@example.invalid` },
      { id: AMBIG_USER, email: `ca-amb-${run}@example.invalid` },
      { id: NOPRIN_USER, email: `ca-noprin-${run}@example.invalid` },
    ]);
    await database.insert(enterprisePrincipals).values([
      { id: `${run}-prin-prov`, userId: PROV_USER },
      { id: `${run}-prin-amb`, userId: AMBIG_USER },
    ]);
    await database.insert(enterpriseMemberships).values([
      { tenantId: TENANT_A, principalId: `${run}-prin-prov`, role: "member" },
      { tenantId: TENANT_A, principalId: `${run}-prin-amb`, role: "member" },
      { tenantId: TENANT_B, principalId: `${run}-prin-amb`, role: "member" },
    ]);
    const row = (
      id: string,
      ownerUserId: string,
      reviewState: "confirmed" | "unreviewed",
    ) => ({
      id,
      ownerUserId,
      tenantId: null,
      content: `ca migration ${id}`,
      provenance: "You",
      reviewState,
      formedBy: "person" as const,
    });
    await database
      .insert(personalMemories)
      .values([
        row(ids.provConfirmed, PROV_USER, "confirmed"),
        row(ids.provPending, PROV_USER, "unreviewed"),
        row(ids.ambConfirmed, AMBIG_USER, "confirmed"),
        row(ids.ambPending, AMBIG_USER, "unreviewed"),
        row(ids.noprinConfirmed, NOPRIN_USER, "confirmed"),
      ]);
    // The shipped file's data statements, after pinning the DDL shape in front of them.
    const file = await readFile(
      join(
        hereDir,
        "..",
        "drizzle",
        "0211_personal_memories_company_attribution.sql",
      ),
      "utf8",
    );
    const statements = file
      .split("-->")
      .map((statement) =>
        statement
          // The breakpoint marker half, then any leading comment block, then the gap.
          .replace(/^ statement-breakpoint.*$/m, "")
          .replace(/^(--[^\n]*\n\s*)+/, "")
          .trim(),
      )
      .filter(Boolean);
    expect(statements[0]).toMatch(
      /^ALTER TABLE "personal_memories" ADD COLUMN "tenant_id"/,
    );
    expect(statements[1]).toMatch(
      /^ALTER TABLE "personal_memories" ADD CONSTRAINT/,
    );
    expect(statements[2]).toMatch(
      /^CREATE INDEX "personal_memories_tenant_idx"/,
    );
    for (const statement of statements.slice(3)) {
      await database.execute(sql.raw(statement));
    }
    quarantinedFixtureIds.push(...Object.values(ids), `${run}-unattributed`);
  });

  test("an owner with exactly one active membership is backfilled on every row", async () => {
    const rows = await database
      .select({ id: personalMemories.id, tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(
        inArray(personalMemories.id, [ids.provConfirmed, ids.provPending]),
      );
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.tenantId])),
    ).toEqual({
      [ids.provConfirmed]: TENANT_A,
      [ids.provPending]: TENANT_A,
    });
    // Backfilled rows reach nobody's isolation list.
    const quarantined = await database
      .select({ oldRecordId: hindsightMigrationQuarantine.oldRecordId })
      .from(hindsightMigrationQuarantine)
      .where(
        inArray(hindsightMigrationQuarantine.oldRecordId, [
          ids.provConfirmed,
          ids.provPending,
        ]),
      );
    expect(quarantined).toEqual([]);
  });

  test("an ambiguous owner's confirmed row is isolated with its reason, never guessed; its pending row stays out of the list", async () => {
    const [confirmed] = await database
      .select({ tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(eq(personalMemories.id, ids.ambConfirmed));
    expect(confirmed.tenantId).toBeNull();
    const [quarantined] = await database
      .select({
        oldRecordId: hindsightMigrationQuarantine.oldRecordId,
        ownerUserId: hindsightMigrationQuarantine.ownerUserId,
        reason: hindsightMigrationQuarantine.reason,
      })
      .from(hindsightMigrationQuarantine)
      .where(eq(hindsightMigrationQuarantine.oldRecordId, ids.ambConfirmed));
    expect(quarantined).toEqual({
      oldRecordId: ids.ambConfirmed,
      ownerUserId: AMBIG_USER,
      reason: "ambiguous-company",
    });
    // The isolation list holds the reason, never content (the table has no content column).
    const [pending] = await database
      .select({ tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(eq(personalMemories.id, ids.ambPending));
    expect(pending.tenantId).toBeNull();
    const pendingQuarantined = await database
      .select({ oldRecordId: hindsightMigrationQuarantine.oldRecordId })
      .from(hindsightMigrationQuarantine)
      .where(eq(hindsightMigrationQuarantine.oldRecordId, ids.ambPending));
    expect(pendingQuarantined).toEqual([]);
  });

  test("an owner without a principal is isolated as no-principal; the run row records what the pass decided", async () => {
    const [quarantined] = await database
      .select({ reason: hindsightMigrationQuarantine.reason })
      .from(hindsightMigrationQuarantine)
      .where(eq(hindsightMigrationQuarantine.oldRecordId, ids.noprinConfirmed));
    expect(quarantined?.reason).toBe("no-principal");
    const [runRow] = await database
      .select()
      .from(hindsightMigrationRuns)
      .where(eq(hindsightMigrationRuns.id, BACKFILL_RUN));
    expect(runRow.state).toBe("succeeded");
    expect(runRow.quarantined).toBeGreaterThanOrEqual(3);
    expect(runRow.processed).toBeGreaterThanOrEqual(runRow.quarantined);
  });

  afterAll(async () => {
    await database
      .delete(personalMemories)
      .where(inArray(personalMemories.id, Object.values(ids)));
    await database
      .delete(enterpriseMemberships)
      .where(
        inArray(enterpriseMemberships.principalId, [
          `${run}-prin-prov`,
          `${run}-prin-amb`,
        ]),
      );
    await database
      .delete(enterprisePrincipals)
      .where(
        inArray(enterprisePrincipals.id, [
          `${run}-prin-prov`,
          `${run}-prin-amb`,
        ]),
      );
    await database
      .delete(users)
      .where(inArray(users.id, [PROV_USER, AMBIG_USER, NOPRIN_USER]));
  });
});
