import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createAuditStore } from "../../src/audit";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  type AccessGrantService,
  createAccessGrantService,
} from "../../src/bot-services/access-grants";
import { botServiceRoutes } from "../../src/bot-services/auth";
import { createBindingOfferIssuer } from "../../src/bot-services/binding-codes";
import { createBotServiceRegistry } from "../../src/bot-services/registry";
import { createCredentialStore } from "../../src/credentials";
import { createDatabase } from "../../src/db/client";
import { accessGrants } from "../../src/db/schema";
import { gatewayVirtualKeys } from "../../src/db/schema/gateway";
import { createGatewayCustomerProvisioner } from "../../src/gateway/customer";
import {
  createGatewayKeyIssuer,
  createGatewayVirtualKeyClient,
  createKeyIssuanceRoutes,
} from "../../src/gateway/key-issuance";
import {
  createGatewayKeyRenewalService,
  createGatewayVirtualKeyDeactivationClient,
} from "../../src/gateway/key-renewal";
import type {
  GatewayReadiness,
  GatewayReadinessService,
} from "../../src/gateway/readiness";

/*
 * T05.11 (#567, original task P12, defect F1) — the mounted Bot Service claim
 * and renew surfaces carry no identity bypass: the person behind the grant is
 * re-verified live, and the final local issuance transaction re-verifies
 * User/Principal/status/generation/Bot/Grant under the principal→grant→key
 * lock order before anything commits. Remote key operations run outside the
 * locks; when the final verdict is an invalidation, the minted key is never
 * disclosed and is idempotently reclaimed at the gateway.
 *
 * The two named behaviors, as facts:
 *
 * - `global_disable_blocks_mounted_bot_claim_and_renew_without_outbox`: with
 *   the identity suspended (committed), the two real mounted routes —
 *   POST /keys and POST /keys/renew behind the real 04.2 service guard —
 *   both refuse (expect(status).not.toBe(200)) with no new key born, and no
 *   outbox machinery exists or drains in this suite: the block is the live
 *   read, never a delivered event.
 * - `disable_during_remote_create_never_discloses_key`: a disable that
 *   commits while the gateway is minting the key still refuses the claim;
 *   the minted secret appears nowhere in the answer
 *   (expect(disclosedKeys).toHaveLength(0)), no local record is born, and
 *   the gateway receives the idempotent compensating deactivation for the
 *   minted virtual key.
 *
 * Supporting pins: a restore does not revive the old grant (generation moved)
 * while a fresh re-authorization claims a NEW key that pins the grant's
 * sourceIdentityGeneration and bills the SAME customer (the original payer);
 * the renewal arm of the mid-create barrier (old versions retired gateway
 * first, the newly minted key compensated, the secret never disclosed); and
 * the M0/M1 legacy arm — a registry-less assembly — keeps its exact
 * capability, principal state notwithstanding.
 *
 * Fixture philosophy (T05.10's disclosure): the suspended status and the
 * advanced generation are written directly on the principal — the producer
 * path (disable/restore advancing the generation in one transaction) is
 * pinned by global-identity-routes.test.ts; this suite pins what claim/renew
 * read. The principal itself is ensured by the real PrincipalRegistry inside
 * the confirmation's transaction; the mounted routes, the service guard, the
 * issuer, the renewal and the provisioner are the real ones, and only the
 * Bifrost management surface is a test fake whose virtual-key create can be
 * armed to commit a disable mid-mint.
 */
const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const MIGRATION_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
  "0215_better_auth_company_lifecycle",
  "0216_better_auth_invitation_resend",
  "0218_better_auth_company_auth_challenge",
  "0219_better_auth_company_auth_complete",
  "0220_better_auth_company_auth_policy_read",
] as const;
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);

const SUITE_TABLES = [
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_organizations",
  "auth_teams",
  "auth_team_bindings",
  "auth_members",
  "auth_team_members",
  "auth_invitations",
  "auth_eligibility_clocks",
  "auth_company_auth_challenges",
  "auth_company_session_assurances",
  "auth_company_auth_policies",
] as const;

const PREFIX = "t0511";
const EMAIL_DOMAIN = "@t0511.example.test";

function shapeOf(variable: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return `${host}:${url.port || "5432"}/${database}`;
}

function readBaUrls(): string {
  let reference: string | undefined;
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: the personal-model-identity suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    const shape = shapeOf(variable, raw);
    reference ??= shape;
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance and database as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

/**
 * Returns the island to the pre-suite shape, the T05.10 recipe extended with
 * this suite's own artifacts: gateway virtual keys and customers (the
 * mounted claim path mints both), bot credentials, and the auth_ function
 * family the leak check probes. Idempotent; also recovers a crashed run.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM gateway_virtual_keys WHERE bot_id LIKE ${`${PREFIX}-%`}
    OR grant_id IN (SELECT grant_id FROM access_grants WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}))`;
  await sql`DELETE FROM gateway_customers WHERE payer_id LIKE ${`openbot-personal-${PREFIX}-%`}`;
  await sql`DELETE FROM access_grants WHERE bot_id LIKE ${`${PREFIX}-%`}
    OR user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM bot_binding_offers WHERE bot_id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM credentials WHERE key_id LIKE ${`${PREFIX}-%`}`;
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${SUITE_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The migration chain this suite applies creates the auth_* controlled
  // function family; leaving them behind fails the T02.06.01 whole-database
  // leak check for every suite that runs afterwards.
  await sql.unsafe(`
    DO $$
    DECLARE target text;
    BEGIN
      FOR target IN SELECT proname::text FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND position('auth_' in proname) = 1
      LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I CASCADE', target);
      END LOOP;
    END $$;
  `);
  await sql`DELETE FROM enterprise_memberships WHERE tenant_id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM enterprise_principals WHERE user_id IN (
    SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}`;
  await sql`DELETE FROM enterprise_workspaces WHERE tenant_id LIKE ${`${PREFIX}%`}`;
  await sql`DELETE FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}%`}`;
  // Earlier suites' ALTERs (migration-expand and friends) leave columns and
  // constraints the migrations this suite replays would collide with; the
  // island is shared, so the residue is dropped before replay.
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" DROP CONSTRAINT IF EXISTS "enterprise_tenant_status"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_tenants" ADD CONSTRAINT "enterprise_tenant_status" CHECK ("status" in ('active','suspended'))`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credentials" DROP COLUMN IF EXISTS "owner_company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "enterprise_credential_actions" DROP COLUMN IF EXISTS "source_team_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "billing_company_finance_grants" DROP COLUMN IF EXISTS "company_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "principal_id"`,
  );
  await sql.unsafe(
    `ALTER TABLE "access_grants" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  await sql.unsafe(
    `ALTER TABLE "gateway_virtual_keys" DROP COLUMN IF EXISTS "source_identity_generation"`,
  );
}

type Database = ReturnType<typeof createDatabase>;
type MountedApp = ReturnType<typeof botServiceRoutes>;

/** The fake Bifrost management surface, with an armable mid-mint hook. */
function startFakeBifrost() {
  const customers = new Map<string, { id: string }>();
  const minted = new Map<string, { id: string; value: string; name: string }>();
  /** Every PUT (is_active:false) this fake answered, by virtual key id. */
  const deactivations: string[] = [];
  let onVkCreate: (() => Promise<void>) | undefined;

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== "Bearer test-admin-key") {
        return json(401, { error: "unauthorized" });
      }
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/customers"
      ) {
        const name = ((await request.json()) as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) {
          return json(400, { error: "Customer name is required" });
        }
        if (customers.has(name)) {
          return json(409, {
            error: "A customer with this name already exists",
          });
        }
        const id = crypto.randomUUID();
        customers.set(name, { id });
        return json(200, { message: "ok", customer: { id, name } });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/governance/customers"
      ) {
        const search = url.searchParams.get("search") ?? "";
        const matched = [...customers.entries()]
          .filter(([name]) => name.includes(search))
          .map(([name, entry]) => ({ id: entry.id, name }));
        return json(200, { customers: matched, count: matched.length });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/governance/virtual-keys"
      ) {
        const body = (await request.json()) as {
          name?: unknown;
          customer_id?: unknown;
        };
        if (typeof body.name !== "string" || body.name.length === 0) {
          return json(400, { error: "Virtual key name is required" });
        }
        // The fault barrier: whatever the test armed runs while the gateway
        // is minting — a disable committed on another connection lands AFTER
        // the issuer's pre-checks and BEFORE the create answers.
        const hook = onVkCreate;
        onVkCreate = undefined;
        await hook?.();
        const id = crypto.randomUUID();
        const value = `sk-bf-${crypto.randomUUID()}`;
        minted.set(id, { id, value, name: body.name });
        return json(200, {
          message: "Virtual key created successfully",
          virtual_key: { id, name: body.name, value },
        });
      }
      const virtualKeyMatch = url.pathname.match(
        /^\/api\/governance\/virtual-keys\/(.+)$/,
      );
      if (request.method === "PUT" && virtualKeyMatch) {
        const id = decodeURIComponent(virtualKeyMatch[1]!);
        // A 404 is the deletion answer; this fake never 404s so the
        // compensating deactivation is always observable.
        deactivations.push(id);
        return json(200, { message: "ok" });
      }
      return json(404, { error: "not found" });
    },
  });

  return {
    server,
    deactivations,
    mintedValues: () => [...minted.values()].map((entry) => entry.value),
    mintedIds: () => [...minted.keys()],
    lastMintedId: () => [...minted.keys()].at(-1),
    /** Arm the mid-mint fault; consumed by exactly one create. */
    armOnVkCreate(hook: () => Promise<void>) {
      onVkCreate = hook;
    },
    stop: () => server.stop(true),
  };
}

interface Harness {
  sql: postgres.Sql;
  database: Database;
  /** The BA-mode service: the principal registry wired (T05.10's seam). */
  service: AccessGrantService;
  /** The M0/M1 service: exactly today's assembly, no registry. */
  legacy: AccessGrantService;
  fake: ReturnType<typeof startFakeBifrost>;
  /** The mounted claim/renew routes with the BA-wired issuer and renewal. */
  baApp: MountedApp;
  /** The mounted routes on the legacy (registry-less) assembly. */
  legacyApp: MountedApp;
  newUser(label: string): Promise<string>;
  credentialedBot(suffix: string): Promise<{ botId: string; secret: string }>;
  /** A confirmed personal grant on the BA service. */
  baGrant(userId: string, botId: string): Promise<{ grantId: string }>;
  /** A confirmed grant on the legacy (registry-less) service. */
  legacyGrant(userId: string, botId: string): Promise<{ grantId: string }>;
  claim(app: MountedApp, secret: string, grantId: string): Promise<Response>;
  renew(app: MountedApp, secret: string, grantId: string): Promise<Response>;
  /** The identity security event T05.07 pins, as the T05.10 fixture writes it. */
  advanceIdentity(
    userId: string,
    status?: "active" | "suspended",
  ): Promise<void>;
  close(): Promise<void>;
}

let harness: Harness | undefined;

async function buildHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the BA directory model this suite pins is the integrated target behavior, not an environment problem.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }

    const database = createDatabase(setupUrl, { max: 6 });
    const auditStore = createAuditStore(database);
    const encryptionKey = randomBytes(32).toString("base64");
    const credentialStore = createCredentialStore(database);
    const registry = createBotServiceRegistry(database, {
      encryptionKey,
      credentialStore,
      auditStore,
    });
    const service = createAccessGrantService({
      database,
      botServices: registry,
      principalRegistry,
    });
    const legacy = createAccessGrantService({
      database,
      botServices: registry,
    });

    const fake = startFakeBifrost();
    const endpoint = {
      baseUrl: `http://127.0.0.1:${fake.server.port}`,
      requestTimeoutMs: 2_000,
      configVersion: 1,
    };
    const readiness: GatewayReadiness = {
      ready: true,
      blockingReasons: [],
      configVersion: endpoint.configVersion,
      checkedAt: new Date().toISOString(),
    };
    const gate: GatewayReadinessService = {
      evaluateGatewayReadiness: async () => readiness,
      assertGatewayReadyForBilling: async () => readiness,
    };
    const provisionCustomer = createGatewayCustomerProvisioner({
      database,
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
      gate,
    }).provisionCustomer;
    const createClient = createGatewayVirtualKeyClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    });
    const deactivationClient = createGatewayVirtualKeyDeactivationClient({
      readGatewayEndpoint: async () => endpoint,
      resolveGatewayAdminCredential: async () => ({
        adminKey: "test-admin-key",
      }),
    });
    const listSelectableModels = async () => [
      {
        provider: "fake-provider",
        model: "t0511-chat",
        capability: "chat" as const,
      },
    ];

    /*
     * T05.11's locked re-verify seam, read off the service the way the
     * deployment composition will. The indirection keeps the RED run
     * behavioral: the issuer treats an absent seam as unwired (today's
     * inline checks, byte-exact), so the counterexamples below fail on the
     * missing target behavior, not on an import.
     */
    const seamsOf = (grantService: AccessGrantService) =>
      grantService as unknown as {
        resolveForBot: AccessGrantService["resolveForBot"];
        reverifyForIssuance?: Parameters<
          typeof createGatewayKeyIssuer
        >[0]["reverifyForIssuance"];
      };

    const routesFor = (seams: ReturnType<typeof seamsOf>): MountedApp =>
      botServiceRoutes({
        authenticate: registry.authenticate,
        keys: createKeyIssuanceRoutes({
          issue: createGatewayKeyIssuer({
            database,
            resolveForBot: seams.resolveForBot,
            reverifyForIssuance: seams.reverifyForIssuance,
            provisionCustomer,
            client: createClient,
            deactivationClient,
            keyTtlMinutes: 15,
            auditStore,
          }).issueKeyForGrant,
          renew: createGatewayKeyRenewalService({
            database,
            resolveForBot: seams.resolveForBot,
            reverifyForIssuance: seams.reverifyForIssuance,
            provisionCustomer,
            listSelectableModels,
            assertCatalogFresh: async () => ({
              fresh: true as const,
              lastSuccessfulSyncAt: new Date().toISOString(),
              ageMs: 0,
              windowMs: 15 * 60_000,
            }),
            createClient,
            deactivationClient,
            keyTtlMinutes: 15,
            auditStore,
          }).renewKeyForGrant,
          bundle: {
            readGatewayEndpoint: async () => endpoint,
            listSelectableModels,
          },
        }),
      });

    const newUser = async (label: string): Promise<string> => {
      const userId = `${PREFIX}-${label}-${randomUUID().slice(0, 8)}`;
      await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}${EMAIL_DOMAIN}`})`;
      return userId;
    };

    const offerIssuer = createBindingOfferIssuer({ database, auditStore });
    const credentialedBot = async (suffix: string) => {
      const botId = `${PREFIX}-${suffix}`;
      await registry.register({
        botId,
        displayName: `T05.11 Bot ${suffix}`,
        kind: "external",
        capabilities: ["chat"],
      });
      const issued = await registry.credentials.issue(botId);
      return { botId, secret: issued.secret };
    };

    const grantOn = async (
      grantService: AccessGrantService,
      userId: string,
      botId: string,
    ) => {
      const offer = await offerIssuer.issue(
        { botId, status: "active" },
        { externalIdentityHint: `slack:${userId}` },
      );
      const { grant } = await grantService.confirm(userId, offer.bindingCode);
      return { grantId: grant.grantId };
    };

    const advanceIdentity = async (
      userId: string,
      status?: "active" | "suspended",
    ) => {
      if (status) {
        await sql`UPDATE enterprise_principals
            SET identity_generation = identity_generation + 1, status = ${status}
          WHERE user_id = ${userId}`;
      } else {
        await sql`UPDATE enterprise_principals
            SET identity_generation = identity_generation + 1
          WHERE user_id = ${userId}`;
      }
    };

    const mountedCall =
      (path: string) =>
      (app: MountedApp, secret: string, grantId: string): Promise<Response> =>
        app.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({ grantId }),
        });

    return {
      sql,
      database,
      service,
      legacy,
      fake,
      baApp: routesFor(seamsOf(service)),
      legacyApp: routesFor(seamsOf(legacy)),
      newUser,
      credentialedBot,
      baGrant: (userId, botId) => grantOn(service, userId, botId),
      legacyGrant: (userId, botId) => grantOn(legacy, userId, botId),
      claim: mountedCall("/keys"),
      renew: mountedCall("/keys/renew"),
      advanceIdentity,
      close: async () => {
        await cleanupFixture(sql);
        await database.$client.close();
        await sql.end({ timeout: 5 });
        fake.stop();
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

beforeAll(async () => {
  harness = await buildHarness();
}, 180_000);

afterAll(async () => {
  if (!harness) return;
  const probe = postgres(readBaUrls(), { max: 1, idle_timeout: 5 });
  await harness.close();
  try {
    const leaked = await probe`
      SELECT 'users:' || id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`}
      UNION ALL
      SELECT 'bots:' || bot_id FROM bot_services WHERE bot_id LIKE ${`${PREFIX}-%`}
      UNION ALL
      SELECT 'keys:' || id FROM gateway_virtual_keys WHERE bot_id LIKE ${`${PREFIX}-%`}
      UNION ALL
      SELECT 'customers:' || payer_id FROM gateway_customers WHERE payer_id LIKE ${`openbot-personal-${PREFIX}-%`}
      UNION ALL
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}%`}`;
    expect(leaked).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

/* ---------------------------------------------------------------------- */
/* Test helpers against the real rows.                                     */
/* ---------------------------------------------------------------------- */

/** Every secret the fake gateway ever minted, found in the response text. */
function secretsDisclosedIn(text: string): string[] {
  return harness!.fake.mintedValues().filter((secret) => text.includes(secret));
}

async function keyRows(grantId: string) {
  return harness!.database
    .select()
    .from(gatewayVirtualKeys)
    .where(eq(gatewayVirtualKeys.grantId, grantId));
}

/* ---------------------------------------------------------------------- */
/* The named behaviors.                                                    */
/* ---------------------------------------------------------------------- */

describe("T05.11 mounted claim/renew identity continuation", () => {
  test("global_disable_blocks_mounted_bot_claim_and_renew_without_outbox", async () => {
    const {
      baApp,
      newUser,
      credentialedBot,
      baGrant,
      claim,
      renew,
      advanceIdentity,
    } = harness!;
    const userId = await newUser("disable");
    const bot = await credentialedBot("disable");
    const { grantId } = await baGrant(userId, bot.botId);

    // The mounted path works before the disable: the pre-disable claim mints
    // one active version the renew below would rotate.
    const healthy = await claim(baApp, bot.secret, grantId);
    expect(healthy.status).toBe(200);

    // The committed disable. No outbox exists in this suite and nothing
    // drains: whatever blocks below is the live read, never an event.
    await advanceIdentity(userId, "suspended");

    const claimRefusal = await claim(baApp, bot.secret, grantId);
    expect(claimRefusal.status).not.toBe(200);
    expect(secretsDisclosedIn(await claimRefusal.text())).toHaveLength(0);
    const renewRefusal = await renew(baApp, bot.secret, grantId);
    expect(renewRefusal.status).not.toBe(200);
    expect(secretsDisclosedIn(await renewRefusal.text())).toHaveLength(0);

    // Nothing new was born for the dead identity: the one pre-disable row.
    const rows = await keyRows(grantId);
    expect(rows).toHaveLength(1);
  });

  test("disable_during_remote_create_never_discloses_key", async () => {
    const {
      baApp,
      newUser,
      credentialedBot,
      baGrant,
      claim,
      fake,
      advanceIdentity,
    } = harness!;
    const userId = await newUser("midcreate");
    const bot = await credentialedBot("midcreate");
    const { grantId } = await baGrant(userId, bot.botId);

    // The fault barrier: the disable commits while the gateway is minting —
    // after the issuer's pre-checks read a live identity, before the create
    // answers. A separate connection, so the issuer's own transaction never
    // sees the write until its final re-verification.
    fake.armOnVkCreate(async () => {
      await advanceIdentity(userId, "suspended");
    });

    const refusal = await claim(baApp, bot.secret, grantId);
    expect(refusal.status).not.toBe(200);

    const disclosedKeys = secretsDisclosedIn(await refusal.text());
    expect(disclosedKeys).toHaveLength(0);

    // No local record is born for the disabled identity.
    const rows = await keyRows(grantId);
    expect(rows).toHaveLength(0);

    // The minted virtual key was idempotently reclaimed at the gateway: the
    // compensating deactivation addressed exactly the key the mint created.
    expect(fake.deactivations).toContain(fake.lastMintedId());
  });

  test("restored_old_grant_refused_reauthorization_claims_new_key_pinned_to_source_generation_and_original_payer", async () => {
    const {
      baApp,
      newUser,
      credentialedBot,
      baGrant,
      claim,
      advanceIdentity,
      database,
    } = harness!;
    const userId = await newUser("restore");
    const bot = await credentialedBot("restore");
    const { grantId: oldGrantId } = await baGrant(userId, bot.botId);
    const first = await claim(baApp, bot.secret, oldGrantId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      key: { customerId: string };
    };

    // Disable, then restore: the generation moved twice and never resets, so
    // the old grant's pinned pair is stale forever — restoring the identity
    // does not revive the ability it had.
    await advanceIdentity(userId, "suspended");
    await advanceIdentity(userId, "active");

    const oldGrantRefusal = await claim(baApp, bot.secret, oldGrantId);
    expect(oldGrantRefusal.status).not.toBe(200);

    // The person's next explicit confirmation is a NEW grant against the
    // current generation, and only that grant claims a new key.
    const { grantId: newGrantId } = await baGrant(userId, bot.botId);
    expect(newGrantId).not.toBe(oldGrantId);
    const reclaimed = await claim(baApp, bot.secret, newGrantId);
    expect(reclaimed.status).toBe(200);

    const [newGrantRow] = await database
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.grantId, newGrantId));
    const activeRows = (await keyRows(newGrantId)).filter(
      (row) => row.status === "active",
    );
    expect(activeRows).toHaveLength(1);
    // The new key PINS the grant's verified source generation (never the
    // live one re-read at mint time) and bills the SAME customer — the
    // original payer the person's every key bills.
    expect(activeRows[0]?.sourceIdentityGeneration).toBe(
      newGrantRow?.identityGeneration,
    );
    const reclaimedBody = (await reclaimed.json()) as {
      key: { customerId: string };
    };
    expect(reclaimedBody.key.customerId).toBe(firstBody.key.customerId);
  });

  test("renewal_disable_during_remote_create_never_discloses_and_compensates", async () => {
    const {
      baApp,
      newUser,
      credentialedBot,
      baGrant,
      claim,
      renew,
      fake,
      advanceIdentity,
    } = harness!;
    const userId = await newUser("renewmid");
    const bot = await credentialedBot("renewmid");
    const { grantId } = await baGrant(userId, bot.botId);
    const first = await claim(baApp, bot.secret, grantId);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      key: { gatewayVirtualKeyId: string };
    };
    const mintedBefore = fake.mintedIds().length;

    fake.armOnVkCreate(async () => {
      await advanceIdentity(userId, "suspended");
    });

    const refusal = await renew(baApp, bot.secret, grantId);
    expect(refusal.status).not.toBe(200);
    const disclosedKeys = secretsDisclosedIn(await refusal.text());
    expect(disclosedKeys).toHaveLength(0);

    // The rotation retired the old version gateway-side first, and the newly
    // minted key — the one created after the disable committed — was
    // compensated, never recorded.
    expect(fake.mintedIds().length).toBe(mintedBefore + 1);
    expect(fake.deactivations).toContain(firstBody.key.gatewayVirtualKeyId);
    expect(fake.deactivations).toContain(fake.lastMintedId());
    const rows = await keyRows(grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gatewayVirtualKeyId).toBe(
      firstBody.key.gatewayVirtualKeyId,
    );
  });

  test("legacy_arm_without_registry_keeps_claim_capability", async () => {
    const { legacyApp, newUser, credentialedBot, legacyGrant, sql } = harness!;
    const userId = await newUser("legacy");
    const bot = await credentialedBot("legacy");
    const { grantId } = await legacyGrant(userId, bot.botId);

    // A suspended principal with an advanced generation exists on the island
    // (written by this suite, as the BA arm's fixtures write it); the
    // registry-less M0/M1 assembly never asks about it.
    await sql`INSERT INTO enterprise_principals (id, user_id, status, identity_generation)
        VALUES (${"t0511-legacy-principal"}, ${userId}, 'suspended', 7)`;

    const answer = await legacyApp.request("/keys", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bot.secret}`,
      },
      body: JSON.stringify({ grantId }),
    });
    expect(answer.status).toBe(200);
    expect(secretsDisclosedIn(await answer.text())).toHaveLength(1);
    // The legacy arm pins no generation: nothing was verified, so nothing is
    // stamped — a row without a version stays exactly as it was.
    const rows = await keyRows(grantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceIdentityGeneration).toBeNull();
  });
});
