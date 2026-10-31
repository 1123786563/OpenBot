import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { memorySources, personalMemories } from "../src/db/schema/memory";
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
 *   - FIX-W13 (FR2-2), the source family: a source's company is its own — fixed at binding,
 *     persisted on the row, backfilled by migration 0212 — and the request's company only
 *     authorizes. Another company's source (or an isolated one) is not on the asking
 *     company's list, not its to enable, disable or delete, and its sync is not-found with
 *     the connector never read; the same-company paths stamp the row's own company, the
 *     binding of another company's Bot is refused, and the background loop uses the same
 *     rule — attributed sources sync, isolated ones are skipped (read nothing, stamped
 *     nothing) but deferred out of the due set, so they cannot starve the sweep.
 *
 * The migration block at the bottom drives migration 0211's own SQL — read from the shipped
 * file — over a prepared pre-migration state and pins the backfill and isolation-list rules;
 * the FIX-W13 migration block after it does the same for 0212.
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

/*
 * FIX-OCR2 (O2-M2): the production wiring hands the store the person's learning switch
 * (index.ts bridges the pause controls in); here an in-test set stands in for that bridge,
 * so the paused-import count is observable without minting pause rows.
 */
const learningPausedUsers = new Set<string>();
const store = createMemoryStore(database, {
  learningPaused: (ownerUserId) =>
    Promise.resolve(learningPausedUsers.has(ownerUserId)),
});
/*
 * FIX-W13: the connector stand-in. The FIX-F1 seams above need no source work at all; the
 * source cases below key a little state into the same mock — which Bots hold the fixture
 * tool, whose Bots they answer as owner, and what one sync reads — so the production
 * `createMemoryIngestion` runs the binding and sync paths without a vendor. The defaults
 * stay the FIX-F1 answers (no grants, no servers, nobody's Bot), which is what every
 * recall and injection case above still sees.
 */
const SOURCE_TOOL = {
  ref: `notes_${run}/read_notes`,
  effect: "read" as const,
  destructive: false,
};
const SOURCE_SERVER = {
  id: `notes_${run}`,
  title: "Notes",
  provenance: "custom",
  url: `https://notes-${run}.example.invalid`,
  authScheme: null,
  accountMode: null,
  tools: [SOURCE_TOOL],
};
const grantedBots = new Set<string>();
const ownedBots = new Set<string>();
let vendorText = "[]";
/** Every connector read, by source id: what the sync paths actually reached. */
const connectorReads: string[] = [];
const plugins = {
  agentOwner: async (botId: string) => (ownedBots.has(botId) ? USER : null),
  listForAgent: async (agentId: string) => ({
    tools: grantedBots.has(agentId) ? [{ ref: SOURCE_TOOL.ref }] : [],
  }),
  listServers: async () => [SOURCE_SERVER],
  connectionsFor: async () => [],
  brokeredConnectionsFor: async () => [],
  deploymentConnectionFor: async () => null,
  callTool: async (request: { initiator?: { id?: string } }) => {
    connectorReads.push(request.initiator?.id ?? "unknown");
    return { text: vendorText, isError: false };
  },
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
        "0214_personal_memories_company_attribution.sql",
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

/*
 * FIX-W13 (FR2-2): the source family over the same production seams — the same route app
 * (real `createMemoryRoutes` behind the trusted-scope `companyScope`), the same
 * enterprise-wired `ingestion`, one connector stand-in answering every sync.
 */
describe("FIX-W13 — a source's own company decides; the request only authorizes", () => {
  const SRC_A = `${run}-src-a`;
  const SRC_B = `${run}-src-b`;
  const SRC_ISO = `${run}-src-iso`;
  const SRC_BG = `${run}-src-bg`;
  const A_RECORD = `[{"id":"w13-a-1","text":"W13 company A record ${run}","title":"Notes"}]`;
  const B_RECORD = `[{"id":"w13-b-1","text":"W13 company B record ${run}","title":"Notes"}]`;
  const B_RECORD_NEXT = `[{"id":"w13-b-2","text":"W13 company B follow-up ${run}","title":"Notes"}]`;
  const boundIds: string[] = [];
  const importedOf = (sourceId: string) =>
    database
      .select({ id: personalMemories.id, tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(eq(personalMemories.sourceId, sourceId));

  beforeAll(async () => {
    for (const bot of [BOT_A, BOT_B, PERSONAL_BOT]) {
      grantedBots.add(bot);
      ownedBots.add(bot);
    }
    // The source rows' agent_id FK needs the Bots to exist as agents rows at all.
    await database.insert(agents).values(
      [BOT_A, BOT_B, PERSONAL_BOT].map((id) => ({
        id,
        name: `Isolation agent ${id}`,
        type: "built_in" as const,
        configuration: {},
      })),
    );
    await database.insert(memorySources).values([
      {
        id: SRC_A,
        ownerUserId: USER,
        tenantId: TENANT_A,
        agentId: BOT_A,
        toolRef: SOURCE_TOOL.ref,
        title: "Notes A",
        enabled: true,
      },
      {
        id: SRC_B,
        ownerUserId: USER,
        tenantId: TENANT_B,
        agentId: BOT_B,
        toolRef: SOURCE_TOOL.ref,
        title: "Notes B",
        enabled: true,
      },
      // A source nobody could attribute: a personal Bot of a person in two companies.
      {
        id: SRC_ISO,
        ownerUserId: USER,
        tenantId: null,
        agentId: PERSONAL_BOT,
        toolRef: SOURCE_TOOL.ref,
        title: "Notes isolated",
        enabled: true,
      },
      {
        id: SRC_BG,
        ownerUserId: USER,
        tenantId: TENANT_A,
        agentId: BOT_A,
        toolRef: SOURCE_TOOL.ref,
        title: "Notes background",
        enabled: true,
      },
    ]);
  });

  test("the asking company's source list is that company's alone", async () => {
    const listA = await requestAs(USER, "/sources", { tenant: TENANT_A });
    expect(listA.status).toBe(200);
    const idsA = (
      (await listA.json()) as { sources: { id: string }[] }
    ).sources.map((row) => row.id);
    expect(idsA).toContain(SRC_A);
    expect(idsA).toContain(SRC_BG);
    expect(idsA).not.toContain(SRC_B);
    expect(idsA).not.toContain(SRC_ISO);

    const listB = await requestAs(USER, "/sources", { tenant: TENANT_B });
    const idsB = (
      (await listB.json()) as { sources: { id: string }[] }
    ).sources.map((row) => row.id);
    expect(idsB).toContain(SRC_B);
    expect(idsB).not.toContain(SRC_A);
    expect(idsB).not.toContain(SRC_ISO);
  });

  test("a manual sync of another company's source is not-found, reads nothing and stamps nothing", async () => {
    vendorText = A_RECORD;
    const readsBefore = connectorReads.length;
    const refused = await requestAs(USER, `/sources/${SRC_A}/sync`, {
      method: "POST",
      tenant: TENANT_B,
    });
    // Not this company's source: the same not-found a missing row answers, and the
    // connector was never read — nothing of company A reached this request at all.
    expect(refused.status).toBe(404);
    expect(connectorReads.length).toBe(readsBefore);
    expect(await importedOf(SRC_A)).toEqual([]);
  });

  test("an isolated source is nobody's to sync: not-found from every company", async () => {
    const asA = await requestAs(USER, `/sources/${SRC_ISO}/sync`, {
      method: "POST",
      tenant: TENANT_A,
    });
    expect(asA.status).toBe(404);
    const asB = await requestAs(USER, `/sources/${SRC_ISO}/sync`, {
      method: "POST",
      tenant: TENANT_B,
    });
    expect(asB.status).toBe(404);
    expect(connectorReads).not.toContain(SRC_ISO);
  });

  test("the same-company sync stamps the source's own company, and a new externalId keeps it", async () => {
    vendorText = B_RECORD;
    const synced = await requestAs(USER, `/sources/${SRC_B}/sync`, {
      method: "POST",
      tenant: TENANT_B,
    });
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { imported: number }).imported).toBe(1);
    const [first] = await database
      .select({ tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.sourceId, SRC_B),
          eq(personalMemories.externalId, "w13-b-1"),
        ),
      );
    expect(first.tenantId).toBe(TENANT_B);

    // A NEW externalId on the next sync carries the same stamp — the row's own company,
    // whatever scope happens to be asking (here the matching one; the refusing leg above
    // is the mismatch case).
    vendorText = B_RECORD_NEXT;
    const again = await requestAs(USER, `/sources/${SRC_B}/sync`, {
      method: "POST",
      tenant: TENANT_B,
    });
    expect(again.status).toBe(200);
    const [next] = await database
      .select({ tenantId: personalMemories.tenantId })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.sourceId, SRC_B),
          eq(personalMemories.externalId, "w13-b-2"),
        ),
      );
    expect(next.tenantId).toBe(TENANT_B);

    // Company A's list of the same person never offers company B's new candidates.
    const listA = await requestAs(USER, "/", { tenant: TENANT_A });
    const contentsA = (
      (await listA.json()) as { memories: { content: string }[] }
    ).memories.map((memory) => memory.content);
    expect(contentsA).not.toContain(`W13 company B record ${run}`);
  });

  test("the background loop uses the source's own rule: attributed sources sync, isolated ones are skipped and deferred out of the due set", async () => {
    vendorText = A_RECORD;
    const [isoBefore] = await database
      .select({ nextSyncAt: memorySources.nextSyncAt })
      .from(memorySources)
      .where(eq(memorySources.id, SRC_ISO));
    await ingestion.syncDue();
    expect(connectorReads).toContain(SRC_BG);
    const [stamped] = await importedOf(SRC_BG);
    expect(stamped.tenantId).toBe(TENANT_A);
    // The isolated source sat in the same due set: not read, not claimed, not imported,
    // and no sync result stamped on it.
    expect(connectorReads).not.toContain(SRC_ISO);
    const [iso] = await database
      .select({
        syncStatus: memorySources.syncStatus,
        nextSyncAt: memorySources.nextSyncAt,
      })
      .from(memorySources)
      .where(eq(memorySources.id, SRC_ISO));
    expect(iso.syncStatus).toBe("idle");
    expect(await importedOf(SRC_ISO)).toEqual([]);
    /*
     * FIX-OCR1 (OCR-M4, #376) — the anti-starvation half: an isolated source never syncs in
     * this deployment, and one that stayed due forever would be re-read and re-logged by
     * every sweep while crowding the bounded, unordered due set away from the sources that
     * would have run. The skip defers its next due time with the failed-sync backoff, so it
     * leaves the due set until the deferral lapses — and the next sweep spends its window on
     * sources that can run.
     */
    expect(iso.nextSyncAt.getTime()).toBeGreaterThan(Date.now());
    expect(iso.nextSyncAt.getTime()).toBeGreaterThan(
      isoBefore.nextSyncAt.getTime(),
    );
    expect((await store.dueSources()).map((row) => row.id)).not.toContain(
      SRC_ISO,
    );
    await ingestion.syncDue();
    expect(connectorReads).not.toContain(SRC_ISO);
  });

  /*
   * FIX-OCR2 (O2-M2): the sync answer says what was actually KEPT. While the person's
   * learning switch is on, completeSync writes no candidate — the sync still completes, the
   * source's health advances — but the count used to echo `kept.length`, so the response
   * and the SyncBadge told the person "imported N" over zero rows written. It now echoes
   * the rows the upserts touched (0 while paused), and resume imports the same payload.
   */
  test("a paused learner's sync answers imported: 0, writes nothing, and still succeeds", async () => {
    const PAUSED_RECORD = `[{"id":"w13-b-3","text":"W13 paused record ${run}","title":"Notes"}]`;
    const importedRow = async () =>
      (
        await database
          .select({ id: personalMemories.id })
          .from(personalMemories)
          .where(
            and(
              eq(personalMemories.sourceId, SRC_B),
              eq(personalMemories.externalId, "w13-b-3"),
            ),
          )
      ).length;
    vendorText = PAUSED_RECORD;
    learningPausedUsers.add(USER);
    try {
      const paused = await requestAs(USER, `/sources/${SRC_B}/sync`, {
        method: "POST",
        tenant: TENANT_B,
      });
      expect(paused.status).toBe(200);
      expect(((await paused.json()) as { imported: number }).imported).toBe(0);
      // Nothing landed — the answer said so.
      expect(await importedRow()).toBe(0);
      // And the sync still completed: the connector was read, the source's health advanced.
      const [source] = await database
        .select({ syncStatus: memorySources.syncStatus })
        .from(memorySources)
        .where(eq(memorySources.id, SRC_B));
      expect(source.syncStatus).toBe("succeeded");
    } finally {
      learningPausedUsers.delete(USER);
    }
    // Resume: the same payload imports, and the count says one.
    const resumed = await requestAs(USER, `/sources/${SRC_B}/sync`, {
      method: "POST",
      tenant: TENANT_B,
    });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { imported: number }).imported).toBe(1);
    expect(await importedRow()).toBe(1);
  });

  /*
   * FIX-OCR2 (O2-M3): the background sync RE-PROVES the attribution instead of trusting the
   * stamp the row carries. The drift is reachable: a person who leaves the company leaves
   * behind a row whose tenant_id still says TENANT_A while resolveMemoryCompany can no
   * longer prove it — and because that person's source list is tenant-filtered, nobody can
   * stop or delete the source from any scope. Without the drift check the sweep would keep
   * reading the connector on that credential and writing rows no company could ever see or
   * manage; the drift is now skipped and deferred exactly like an isolated source, and the
   * authority returning is what resumes it.
   */
  test("the background sync re-proves attribution: a drifted source is skipped and deferred", async () => {
    const SRC_DRIFT = `${run}-src-drift`;
    await database.insert(memorySources).values({
      id: SRC_DRIFT,
      ownerUserId: USER,
      tenantId: TENANT_A,
      agentId: BOT_A,
      toolRef: SOURCE_TOOL.ref,
      title: "Notes drifted",
      enabled: true,
      nextSyncAt: new Date(Date.now() - 1_000),
    });
    boundIds.push(SRC_DRIFT);

    // The drift: the person's company-A membership lapses, so BOT_A's company is no longer
    // provable for them — while the row still says TENANT_A.
    const suspend = (status: "active" | "suspended") =>
      database
        .update(enterpriseMemberships)
        .set({ status })
        .where(
          and(
            eq(enterpriseMemberships.tenantId, TENANT_A),
            eq(enterpriseMemberships.principalId, PRIN),
          ),
        );
    await suspend("suspended");
    try {
      const [before] = await database
        .select({ nextSyncAt: memorySources.nextSyncAt })
        .from(memorySources)
        .where(eq(memorySources.id, SRC_DRIFT));
      const readsBefore = connectorReads.length;
      const skipped = await ingestion.sync(USER, SRC_DRIFT);
      expect(skipped.imported).toBe(0);
      // Not read, not imported, nothing stamped on the row.
      expect(connectorReads.length).toBe(readsBefore);
      expect(await importedOf(SRC_DRIFT)).toEqual([]);
      const [drifted] = await database
        .select({
          syncStatus: memorySources.syncStatus,
          nextSyncAt: memorySources.nextSyncAt,
        })
        .from(memorySources)
        .where(eq(memorySources.id, SRC_DRIFT));
      expect(drifted.syncStatus).not.toBe("succeeded");
      // Deferred out of the due set with the failed-sync backoff, so the sweep is not
      // crowded by a source that can never run — the isolated half's rule.
      expect(drifted.nextSyncAt.getTime()).toBeGreaterThan(
        before.nextSyncAt.getTime(),
      );
      expect(drifted.nextSyncAt.getTime()).toBeGreaterThan(Date.now());
      expect((await store.dueSources()).map((row) => row.id)).not.toContain(
        SRC_DRIFT,
      );
    } finally {
      await suspend("active");
    }
    // The authority returning is what resumes it: the same source now reads under its own
    // company again and stamps that company on what it imports.
    vendorText = A_RECORD;
    const resumed = await ingestion.sync(USER, SRC_DRIFT);
    expect(resumed.imported).toBe(1);
    expect(connectorReads).toContain(SRC_DRIFT);
    const [stamped] = await importedOf(SRC_DRIFT);
    expect(stamped.tenantId).toBe(TENANT_A);
  });

  test("binding reaches only the current company's Bots; the row carries its company from birth", async () => {
    const cross = await requestAs(USER, "/sources", {
      method: "POST",
      tenant: TENANT_B,
      body: JSON.stringify({
        agentId: BOT_A,
        toolRef: SOURCE_TOOL.ref,
        title: "Cross",
        args: {},
      }),
    });
    expect(cross.status).toBe(400);
    expect(await cross.json()).toEqual({
      error: "Choose one of this company's Bots for this source.",
    });
    // A personal Bot of a two-company person has no provable company either: fail closed.
    const ambiguous = await requestAs(USER, "/sources", {
      method: "POST",
      tenant: TENANT_A,
      body: JSON.stringify({
        agentId: PERSONAL_BOT,
        toolRef: SOURCE_TOOL.ref,
        title: "Ambiguous",
        args: {},
      }),
    });
    expect(ambiguous.status).toBe(400);

    // The same company's Bot binds, is stamped at binding, and imports under that stamp.
    vendorText = B_RECORD;
    const bound = await requestAs(USER, "/sources", {
      method: "POST",
      tenant: TENANT_B,
      body: JSON.stringify({
        agentId: BOT_B,
        toolRef: SOURCE_TOOL.ref,
        title: `Notes bound ${run}`,
        args: {},
      }),
    });
    expect(bound.status).toBe(201);
    const boundBody = (await bound.json()) as {
      source: { id: string; tenantId: string | null };
    };
    expect(boundBody.source.tenantId).toBe(TENANT_B);
    boundIds.push(boundBody.source.id);
  });

  test("enable, disable and delete reach only the current company's sources", async () => {
    const patched = await requestAs(USER, `/sources/${SRC_A}`, {
      method: "PATCH",
      tenant: TENANT_B,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(404);
    const [row] = await database
      .select({ enabled: memorySources.enabled })
      .from(memorySources)
      .where(eq(memorySources.id, SRC_A));
    expect(row.enabled).toBe(true);

    const removed = await requestAs(USER, `/sources/${SRC_A}`, {
      method: "DELETE",
      tenant: TENANT_B,
    });
    expect(removed.status).toBe(404);
    expect(
      (
        await database
          .select({ id: memorySources.id })
          .from(memorySources)
          .where(eq(memorySources.id, SRC_A))
      ).length,
    ).toBe(1);
    // An isolated source is nobody's to delete either.
    const isoDelete = await requestAs(USER, `/sources/${SRC_ISO}`, {
      method: "DELETE",
      tenant: TENANT_A,
    });
    expect(isoDelete.status).toBe(404);

    // The asking company's own source answers normally.
    const off = await requestAs(USER, `/sources/${SRC_B}`, {
      method: "PATCH",
      tenant: TENANT_B,
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    const on = await requestAs(USER, `/sources/${SRC_B}`, {
      method: "PATCH",
      tenant: TENANT_B,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
  });

  test("a wiring without the enterprise layer keeps the owner-global source behaviour unchanged", async () => {
    vendorText = B_RECORD;
    const created = await unscopedIngestion.createSource(USER, {
      agentId: BOT_B,
      toolRef: SOURCE_TOOL.ref,
      title: `Notes unscoped ${run}`,
      args: {},
    });
    expect(created.source.tenantId).toBeNull();
    expect(created.imported).toBe(1);
    const [row] = await importedOf(created.source.id);
    expect(row.tenantId).toBeNull();
    boundIds.push(created.source.id);
  });

  afterAll(async () => {
    // The imported memories cascade with their sources, the sources with their Bots.
    await database
      .delete(memorySources)
      .where(
        inArray(memorySources.id, [SRC_A, SRC_B, SRC_ISO, SRC_BG, ...boundIds]),
      );
    await database
      .delete(agents)
      .where(inArray(agents.id, [BOT_A, BOT_B, PERSONAL_BOT]));
  });
});

/*
 * Migration 0212's own rules, driven over a prepared pre-migration state — the replay
 * pattern the 0211 block above established: the chain has already applied 0212 to this
 * database (its DDL is in place), so this block reads the SHIPPED file, pins the DDL by
 * shape, and executes the state-based data statements again (each one idempotent).
 */
const SOURCE_BACKFILL_RUN = "0212-memory-sources-company-attribution";
const TENANT_C = `tn_ca-c-${run}`;
const WS_C = `ws_ca-c-${run}`;
const BOT_C = `bot_ca-c-${run}`;

describe("FIX-W13 — migration 0212 backfills proven source attribution and isolates the rest", () => {
  const ids = {
    botOwned: `${run}-src-mig-bot`,
    botNotMember: `${run}-src-mig-notmember`,
    personalAmbiguous: `${run}-src-mig-amb`,
    soloPersonal: `${run}-src-mig-solo`,
  };

  beforeAll(async () => {
    /*
     * A third company whose Bot this person's principal owns WITHOUT the person being an
     * active member — rule 1's membership leg, the case an ownership-only backfill would
     * get wrong. The ownership FK demands the (tenant, principal) membership row exist, so
     * the fixture creates it and then suspends it: the person left the company while their
     * Bot stayed behind, the exact shape resolveMemoryCompany refuses at runtime.
     */
    await database
      .insert(enterpriseTenants)
      .values({ id: TENANT_C, name: `Isolation C ${run}` });
    await database.insert(enterpriseWorkspaces).values({
      tenantId: TENANT_C,
      id: WS_C,
      name: `Isolation C ws ${run}`,
    });
    await database.insert(enterpriseMemberships).values({
      tenantId: TENANT_C,
      principalId: PRIN,
      role: "member",
    });
    await database.insert(enterpriseBotOwnership).values({
      tenantId: TENANT_C,
      agentId: BOT_C,
      workspaceId: WS_C,
      ownerPrincipalId: PRIN,
      displayName: `Isolation Bot C ${run}`,
      defaultConfig: {},
    });
    await database
      .update(enterpriseMemberships)
      .set({ status: "suspended" })
      .where(
        and(
          eq(enterpriseMemberships.tenantId, TENANT_C),
          eq(enterpriseMemberships.principalId, PRIN),
        ),
      );
    // The agent rows this block's sources point at (the route block deleted its own).
    await database.insert(agents).values(
      [BOT_A, BOT_C, PERSONAL_BOT, SOLO_BOT].map((id) => ({
        id,
        name: `Isolation agent ${id}`,
        type: "built_in" as const,
        configuration: {},
      })),
    );
    const row = (id: string, ownerUserId: string, agentId: string) => ({
      id,
      ownerUserId,
      tenantId: null,
      agentId,
      toolRef: SOURCE_TOOL.ref,
      title: `Migration ${id}`,
      enabled: true,
    });
    await database
      .insert(memorySources)
      .values([
        row(ids.botOwned, USER, BOT_A),
        row(ids.botNotMember, USER, BOT_C),
        row(ids.personalAmbiguous, USER, PERSONAL_BOT),
        row(ids.soloPersonal, SOLO, SOLO_BOT),
      ]);
    // The shipped file's data statements, after pinning the DDL shape in front of them.
    const file = await readFile(
      join(
        hereDir,
        "..",
        "drizzle",
        "0215_memory_sources_company_attribution.sql",
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
      /^ALTER TABLE "memory_sources" ADD COLUMN "tenant_id"/,
    );
    expect(statements[1]).toMatch(
      /^ALTER TABLE "memory_sources" ADD CONSTRAINT/,
    );
    expect(statements[2]).toMatch(/^CREATE INDEX "memory_sources_tenant_idx"/);
    for (const statement of statements.slice(3)) {
      await database.execute(sql.raw(statement));
    }
  });

  test("rule 1 backfills the Bot's company while the person is a live member of it; a Bot of a company the person left stays NULL", async () => {
    const rows = await database
      .select({ id: memorySources.id, tenantId: memorySources.tenantId })
      .from(memorySources)
      .where(inArray(memorySources.id, [ids.botOwned, ids.botNotMember]));
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.tenantId])),
    ).toEqual({
      [ids.botOwned]: TENANT_A,
      [ids.botNotMember]: null,
    });
  });

  test("rule 2 follows the person's one provable membership; ambiguity stays NULL, never guessed", async () => {
    const rows = await database
      .select({ id: memorySources.id, tenantId: memorySources.tenantId })
      .from(memorySources)
      .where(
        inArray(memorySources.id, [ids.personalAmbiguous, ids.soloPersonal]),
      );
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.tenantId])),
    ).toEqual({
      [ids.personalAmbiguous]: null,
      [ids.soloPersonal]: TENANT_A,
    });
  });

  test("the run row records what the pass decided, and no per-row isolation list was written", async () => {
    const [runRow] = await database
      .select()
      .from(hindsightMigrationRuns)
      .where(eq(hindsightMigrationRuns.id, SOURCE_BACKFILL_RUN));
    expect(runRow.state).toBe("succeeded");
    expect(runRow.quarantined).toBeGreaterThanOrEqual(2);
    expect(runRow.processed).toBeGreaterThanOrEqual(runRow.quarantined);
    // The isolation list stays the #394 reconciliation's own: source ids never land in it.
    const listed = await database
      .select({ oldRecordId: hindsightMigrationQuarantine.oldRecordId })
      .from(hindsightMigrationQuarantine)
      .where(
        inArray(hindsightMigrationQuarantine.oldRecordId, Object.values(ids)),
      );
    expect(listed).toEqual([]);
  });

  afterAll(async () => {
    await database
      .delete(memorySources)
      .where(inArray(memorySources.id, Object.values(ids)));
    await database
      .delete(hindsightMigrationRuns)
      .where(eq(hindsightMigrationRuns.id, SOURCE_BACKFILL_RUN));
    await database
      .delete(enterpriseMemberships)
      .where(
        and(
          eq(enterpriseMemberships.tenantId, TENANT_C),
          eq(enterpriseMemberships.principalId, PRIN),
        ),
      );
    await database.delete(agents).where(eq(agents.id, BOT_C));
    await database
      .delete(agents)
      .where(inArray(agents.id, [BOT_A, PERSONAL_BOT, SOLO_BOT]));
    await database
      .delete(enterpriseTenants)
      .where(eq(enterpriseTenants.id, TENANT_C));
  });
});

/*
 * FIX-OCR3 (O3-H2): the proactive engine's form_memory observes through a bare store call —
 * no company argument, because the engine has none. Where the enterprise layer is wired, the
 * store resolves the attribution itself (the production companyFor, resolveMemoryCompany) and
 * REFUSES what it cannot prove: the alternative was a tenant-less row no company-pinned face
 * could ever show, confirm or delete, whose per-person dedup would then suppress the same
 * fact's next company-scoped observation. The store here carries the production resolver.
 */
describe("FIX-OCR3 — a proactive observation attributes itself or is refused", () => {
  const enterpriseStore = createMemoryStore(database, {
    companyFor: (input) => resolveMemoryCompany(database, input),
  });

  beforeAll(async () => {
    // The observation row's formed_by_agent_id FK needs the observing Bots to exist.
    await database.insert(agents).values([
      {
        id: BOT_A,
        name: `O3 Bot A ${run}`,
        type: "built_in",
        configuration: {},
      },
      {
        id: PERSONAL_BOT,
        name: `O3 Personal Bot ${run}`,
        type: "built_in",
        configuration: {},
      },
    ]);
  });

  test("a resolvable run's observation lands stamped with the Bot's company", async () => {
    // The proactive call shape: an owner, an observing Bot, and no company argument.
    const formed = await enterpriseStore.formMemory(USER, {
      agentId: BOT_A,
      content: `o3 proactive attributed fact ${run}`,
      sourceApp: "notes",
    });
    expect(formed.duplicate).toBe(false);
    const [row] = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, formed.id));
    expect(row.tenantId).toBe(TENANT_A);
  });

  test("an unprovable attribution is refused and nothing is written", async () => {
    // A personal Bot with no ownership row, observed for a person whose two active
    // memberships cannot name one company: resolveMemoryCompany answers nothing, and the
    // store refuses rather than writing the invisible tenant-less row.
    await expect(
      enterpriseStore.formMemory(USER, {
        agentId: PERSONAL_BOT,
        content: `o3 proactive unprovable fact ${run}`,
        sourceApp: "notes",
      }),
    ).rejects.toThrow("cannot be attributed to a company");
    const rows = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(
        eq(personalMemories.content, `o3 proactive unprovable fact ${run}`),
      );
    expect(rows).toEqual([]);
  });

  test("a store without the enterprise layer keeps writing exactly what it always wrote", async () => {
    const bare = createMemoryStore(database);
    const formed = await bare.formMemory(SOLO, {
      agentId: PERSONAL_BOT,
      content: `o3 bare-store unprovable fact ${run}`,
      sourceApp: "notes",
    });
    const [row] = await database
      .select()
      .from(personalMemories)
      .where(eq(personalMemories.id, formed.id));
    expect(row.tenantId).toBeNull();
  });
});
