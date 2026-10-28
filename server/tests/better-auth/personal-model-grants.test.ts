import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { principalRegistry } from "../../src/auth/directory/principal-registry";
import {
  AccessGrantUseError,
  createAccessGrantService,
  WORKBENCH_BOT_ID,
  WorkbenchGrantRevokedError,
} from "../../src/bot-services/access-grants";
import {
  bindingCodeHash,
  createBindingOfferIssuer,
} from "../../src/bot-services/binding-codes";
import { createBotServiceStore } from "../../src/bot-services/store";
import { AccessGrantIdentityInactiveError } from "../../src/bot-services/types";
import { createDatabase } from "../../src/db/client";
import { accessGrants, botBindingOffers } from "../../src/db/schema";

/*
 * T05.10 (#566, original task P12) — the personal model grant saves the live
 * identity source and re-authorizes safely, on the real 0209–0216/0218–0220
 * stack of the isolated BA_TEST_* island (design §5.3, interfaces §5.3).
 *
 * The three named behaviors, as facts:
 *
 * - `explicit_reauthorization_replaces_stale_active_grant_with_new_id`: a
 *   confirmation binds the user's one principal (no company required) with the
 *   generation it was confirmed against; when the identity's security
 *   generation moves, the old grant is refused by the Bot-side resolve door,
 *   and the person's NEXT explicit confirmation revokes the stale-active row
 *   and creates a NEW grantId against the current generation in the same
 *   transaction — the old row keeps its own generation and grantId
 *   (expect(newId).not.toBe(oldId)).
 * - `concurrent_reauthorization_has_one_active_grant`: two confirmations of
 *   the same authorization racing after a generation change converge on
 *   exactly one active row (expect(activeGrants).toHaveLength(1)) — the
 *   principal lock serializes the decision and the one-active-per-identity
 *   partial unique index stays the last line.
 * - `company_removal_preserves_personal_grant`: deleting the company the user
 *   belonged to leaves the personal grant active, resolvable and at the same
 *   generation (expect(personalActive).toBe(true)) — a company membership is
 *   not the authorization; only a global identity event can stale one.
 *
 * Fixture philosophy, disclosed: the identity security events that advance
 * `identity_generation` (disable/restore/role change, same-transaction with the
 * status flip) are applied here as direct principal state writes — the
 * producer path is global-identity-routes.test.ts's pinned contract, and this
 * suite pins the grant side against exactly that state. The principal itself
 * is ensured by the REAL PrincipalRegistry inside the service's own
 * transaction; nothing is stubbed on the code under test.
 *
 * The legacy arm is pinned too: a service assembled WITHOUT the principal
 * registry (M0/M1's wiring) writes no principal, compares no generation and
 * keeps every pre-T05.10 capability, DTO and row shape.
 *
 * The five BA_TEST_* URLs are all required and must name one isolated
 * openbot_enterprise_* database. No DSN is ever printed.
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

const PREFIX = "t0510";
const EMAIL_DOMAIN = "@t0510.example.test";

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
        `${variable} is required: the personal-model-grants suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
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
 * Returns the island to the pre-suite shape: this suite's rows gone, the BA
 * tables gone, and the shared-table columns the migrations re-add normalized
 * (the T05.07 recipe, including the auth_* function family the leak check
 * probes). Idempotent; also recovers a crashed run.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  // Grants name bots (FK), offers name bots (FK): children first, then the
  // bots themselves — exactly the 04.5 suite's order.
  // Grants first (children of both bots and principals): the workbench grants
  // name the well-known bot id, so they are located by this suite's users, not
  // by the bot prefix.
  await sql`DELETE FROM access_grants WHERE bot_id LIKE ${`${PREFIX}-%`}
    OR user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}-%${EMAIL_DOMAIN}`})`;
  await sql`DELETE FROM bot_binding_offers WHERE bot_id LIKE ${`${PREFIX}-%`}`;
  await sql`DELETE FROM bot_services WHERE bot_id LIKE ${`${PREFIX}-%`}`;
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

interface Harness {
  sql: postgres.Sql;
  database: Database;
  /** The BA-mode service: the principal registry wired (T05.10's seam). */
  service: ReturnType<typeof createAccessGrantService>;
  /** The M0/M1 service: exactly today's assembly, no registry. */
  legacy: ReturnType<typeof createAccessGrantService>;
  newUser(label: string): Promise<string>;
  registeredBot(suffix: string): Promise<string>;
  liveOffer(
    suffix: string,
    externalIdentityHint: string,
  ): Promise<{ bindingCode: string; codeHash: string }>;
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
    const botStore = createBotServiceStore(database);
    const issuer = createBindingOfferIssuer({ database });
    const service = createAccessGrantService({
      database,
      botServices: botStore,
      principalRegistry,
    });
    const legacy = createAccessGrantService({
      database,
      botServices: botStore,
    });

    const newUser = async (label: string): Promise<string> => {
      const userId = `${PREFIX}-${label}-${randomUUID().slice(0, 8)}`;
      await sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}${EMAIL_DOMAIN}`})`;
      return userId;
    };

    // Get-or-register, exactly the 04.5 suite's shape: the well-known workbench
    // identity may already stand on the island (a sibling suite's residue this
    // suite never created and never cleans), and re-registering a botId is the
    // registry's own terminal conflict.
    const registeredBot = async (suffix: string): Promise<string> => {
      const botId =
        suffix === WORKBENCH_BOT_ID ? suffix : `${PREFIX}-${suffix}`;
      const existing = await botStore.getBotService(botId);
      if (existing) {
        if (suffix === WORKBENCH_BOT_ID) expect(existing.kind).toBe("builtin");
        return botId;
      }
      await botStore.register({
        botId,
        displayName: `T05.10 Bot ${suffix}`,
        kind: suffix === WORKBENCH_BOT_ID ? "builtin" : "external",
        capabilities: ["chat"],
      });
      return botId;
    };

    const liveOffer = async (suffix: string, externalIdentityHint: string) => {
      const botId = await registeredBot(suffix);
      const offer = await issuer.issue(
        { botId, status: "active" },
        { externalIdentityHint },
      );
      return {
        bindingCode: offer.bindingCode,
        codeHash: bindingCodeHash(offer.bindingCode),
      };
    };

    return {
      sql,
      database,
      service,
      legacy,
      newUser,
      registeredBot,
      liveOffer,
      close: async () => {
        await cleanupFixture(sql);
        await database.$client.close();
        await sql.end({ timeout: 5 });
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
      SELECT 'tenants:' || id FROM enterprise_tenants WHERE id LIKE ${`${PREFIX}%`}`;
    expect(leaked).toEqual([]);
  } finally {
    await probe.end({ timeout: 5 }).catch(() => {});
  }
});

/* ---------------------------------------------------------------------- */
/* Test helpers against the real rows.                                     */
/* ---------------------------------------------------------------------- */

/** The one identity this suite confirms under: one hint per user, reused across re-authorizations. */
function hintOf(userId: string): string {
  return `slack:${userId}`;
}

/** The identity security event T05.07 pins: the generation advances (with the status flip when the event is disable/restore). */
async function advanceIdentity(
  userId: string,
  status?: "active" | "suspended",
): Promise<void> {
  if (status) {
    await harness!.sql`UPDATE enterprise_principals
        SET identity_generation = identity_generation + 1, status = ${status}
      WHERE user_id = ${userId}`;
  } else {
    await harness!.sql`UPDATE enterprise_principals
        SET identity_generation = identity_generation + 1
      WHERE user_id = ${userId}`;
  }
}

async function activeGrantRows(
  userId: string,
  botId: string,
  externalIdentity: string,
) {
  return harness!.database
    .select()
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.botId, botId),
        eq(accessGrants.externalIdentity, externalIdentity),
        eq(accessGrants.status, "active"),
      ),
    );
}

async function grantRow(grantId: string) {
  const [row] = await harness!.database
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.grantId, grantId));
  if (!row) throw new Error(`grant ${grantId} vanished`);
  return row;
}

async function principalRow(userId: string) {
  const rows = await harness!
    .sql`SELECT id, status::text AS status, identity_generation::int AS generation
        FROM enterprise_principals WHERE user_id = ${userId}`;
  return rows[0] as
    | { id: string; status: string; generation: number }
    | undefined;
}

describe("personal model grants bind the live identity source (T05.10)", () => {
  test("explicit_reauthorization_replaces_stale_active_grant_with_new_id", async () => {
    const userId = await harness!.newUser("replace");
    const botId = await harness!.registeredBot("replace-bot");
    const identity = hintOf(userId);

    const first = await harness!.liveOffer("replace-bot", identity);
    const { grant: original } = await harness!.service.confirm(
      userId,
      first.bindingCode,
    );

    // The personal source: the confirmation ensured the user's one principal
    // — no company anywhere — and saved its generation on the grant.
    const principal = await principalRow(userId);
    expect(principal?.status).toBe("active");
    expect(original.principalId).toBe(principal?.id);
    expect(original.identityGeneration).toBe(1);
    const memberships = await harness!
      .sql`SELECT count(*)::int AS n FROM enterprise_memberships WHERE principal_id = ${principal!.id}`;
    expect(memberships[0].n).toBe(0);

    // The identity's security generation moves; the old grant is refused by
    // the Bot-side door and by the user-side door alike.
    await advanceIdentity(userId);
    await expect(
      harness!.service.resolveForBot(original.grantId, {
        botId,
        status: "active",
      }),
    ).rejects.toBeInstanceOf(AccessGrantUseError);
    await expect(
      harness!.service.resolveForUser(original.grantId, userId),
    ).rejects.toBeInstanceOf(AccessGrantUseError);

    // The person's next explicit confirmation is the re-authorization: a NEW
    // grantId at the current generation, in the same transaction.
    const second = await harness!.liveOffer("replace-bot", identity);
    const { grant: renewed } = await harness!.service.confirm(
      userId,
      second.bindingCode,
    );
    expect(renewed.grantId).not.toBe(original.grantId);
    expect(renewed.identityGeneration).toBe(2);
    expect(renewed.principalId).toBe(principal?.id);

    // The old row keeps its own generation and grantId — nothing is rewritten
    // — and exactly one active grant holds.
    const old = await grantRow(original.grantId);
    expect(old.status).toBe("revoked");
    expect(old.identityGeneration).toBe(1);
    const active = await activeGrantRows(userId, botId, identity);
    expect(active).toHaveLength(1);
    expect(active[0].grantId).toBe(renewed.grantId);

    // And the renewed grant is usable again, through the same door that
    // refused the stale one.
    const resolved = await harness!.service.resolveForBot(renewed.grantId, {
      botId,
      status: "active",
    });
    expect(resolved.grantId).toBe(renewed.grantId);
  });

  test("concurrent_reauthorization_has_one_active_grant", async () => {
    const userId = await harness!.newUser("concurrent");
    await harness!.registeredBot("concurrent-bot");
    const identity = hintOf(userId);

    const first = await harness!.liveOffer("concurrent-bot", identity);
    await harness!.service.confirm(userId, first.bindingCode);
    await advanceIdentity(userId);
    await advanceIdentity(userId);

    // Two live codes for the same authorization, confirmed at once: the
    // principal lock serializes the two decisions and the partial unique
    // index is the last line, so exactly one active grant survives.
    const left = await harness!.liveOffer("concurrent-bot", identity);
    const right = await harness!.liveOffer("concurrent-bot", identity);
    const [leftOutcome, rightOutcome] = await Promise.all([
      harness!.service.confirm(userId, left.bindingCode),
      harness!.service.confirm(userId, right.bindingCode),
    ]);
    const created = [leftOutcome.created, rightOutcome.created].filter(Boolean);
    expect(created).toHaveLength(1);

    const active = await activeGrantRows(
      userId,
      `${PREFIX}-concurrent-bot`,
      identity,
    );
    expect(active).toHaveLength(1);
    expect(active[0].identityGeneration).toBe(3);
    // The losing confirmation answered the winner's grant, not an error.
    expect([leftOutcome.grant.grantId, rightOutcome.grant.grantId]).toContain(
      active[0].grantId,
    );
  });

  test("company_removal_preserves_personal_grant", async () => {
    const userId = await harness!.newUser("company");
    const botId = await harness!.registeredBot("company-bot");
    const identity = hintOf(userId);

    const offer = await harness!.liveOffer("company-bot", identity);
    const { grant } = await harness!.service.confirm(userId, offer.bindingCode);
    const principal = await principalRow(userId);

    // A real company tie for the principal, the shape a directory membership
    // projects; removing the company cascades it away.
    const tenantId = `${PREFIX}-tenant-${randomUUID().slice(0, 8)}`;
    await harness!
      .sql`INSERT INTO enterprise_tenants (id, name) VALUES (${tenantId}, ${"T05.10 Removal Co"})`;
    await harness!
      .sql`INSERT INTO enterprise_memberships (tenant_id, principal_id, role, status, epoch)
        VALUES (${tenantId}, ${principal!.id}, 'tenant_admin', 'active', 1)`;
    await harness!.sql`DELETE FROM enterprise_tenants WHERE id = ${tenantId}`;
    const remaining = await harness!
      .sql`SELECT count(*)::int AS n FROM enterprise_memberships WHERE principal_id = ${principal!.id}`;
    expect(remaining[0].n).toBe(0);

    // The personal grant survives the company: active, resolvable, and at the
    // same generation — a company membership was never the authorization.
    const row = await grantRow(grant.grantId);
    const personalActive = row.status === "active";
    expect(personalActive).toBe(true);
    const afterRemoval = await principalRow(userId);
    expect(afterRemoval?.status).toBe("active");
    expect(afterRemoval?.generation).toBe(1);
    const resolved = await harness!.service.resolveForBot(grant.grantId, {
      botId,
      status: "active",
    });
    expect(resolved.grantId).toBe(grant.grantId);
  });

  test("suspended_identity_is_refused_and_restore_does_not_revive_old_grants", async () => {
    const userId = await harness!.newUser("suspended");
    const botId = await harness!.registeredBot("suspended-bot");
    const identity = hintOf(userId);

    const first = await harness!.liveOffer("suspended-bot", identity);
    const { grant } = await harness!.service.confirm(userId, first.bindingCode);

    // A global disable: suspended, generation advanced.
    await advanceIdentity(userId, "suspended");
    const second = await harness!.liveOffer("suspended-bot", identity);
    await expect(
      harness!.service.confirm(userId, second.bindingCode),
    ).rejects.toBeInstanceOf(AccessGrantIdentityInactiveError);
    // The refusal is whole: the code is unspent and no grant row appeared.
    const [offerRow] = await harness!.database
      .select()
      .from(botBindingOffers)
      .where(eq(botBindingOffers.codeHash, second.codeHash));
    expect(offerRow.status).toBe("pending");
    const active = await activeGrantRows(userId, botId, identity);
    expect(active).toHaveLength(1); // the pre-disable grant only
    await expect(
      harness!.service.resolveForBot(grant.grantId, {
        botId,
        status: "active",
      }),
    ).rejects.toBeInstanceOf(AccessGrantUseError);

    // The restore is its own security event: the generation advances again
    // and the old grant stays refused — restoring never refreshes old rows,
    // and no read path re-authorizes implicitly.
    await advanceIdentity(userId, "active");
    await expect(
      harness!.service.resolveForUser(grant.grantId, userId),
    ).rejects.toBeInstanceOf(AccessGrantUseError);

    // Only the explicit act mints a grant at the restored generation.
    const third = await harness!.liveOffer("suspended-bot", identity);
    const { grant: restored } = await harness!.service.confirm(
      userId,
      third.bindingCode,
    );
    expect(restored.grantId).not.toBe(grant.grantId);
    expect(restored.identityGeneration).toBe(3);
  });

  test("workbench_stale_grant_requires_explicit_reauthorization", async () => {
    await harness!.registeredBot(WORKBENCH_BOT_ID);
    const userId = await harness!.newUser("workbench");

    const first = await harness!.service.ensureWorkbenchGrant(userId);
    expect(first.created).toBe(true);
    expect(first.grant.principalId).not.toBeNull();
    expect(first.grant.identityGeneration).toBe(1);

    // The generation moves: the stale-active implicit grant is as dead to
    // every Bot door as a revoked one, and plain asking must not quietly
    // re-authorize what the identity's own security event killed.
    await advanceIdentity(userId);
    await expect(
      harness!.service.ensureWorkbenchGrant(userId),
    ).rejects.toBeInstanceOf(WorkbenchGrantRevokedError);

    // The explicit act creates the new grant beside the dead one.
    const renewed = await harness!.service.ensureWorkbenchGrant(userId, {
      reauthorize: true,
    });
    expect(renewed.grant.grantId).not.toBe(first.grant.grantId);
    expect(renewed.grant.identityGeneration).toBe(2);

    // Exactly one active workbench grant, and the old row keeps its history.
    const old = await grantRow(first.grant.grantId);
    expect(old.status).toBe("revoked");
    expect(old.identityGeneration).toBe(1);
    const active = await activeGrantRows(
      userId,
      WORKBENCH_BOT_ID,
      `openbot:${userId}`,
    );
    expect(active).toHaveLength(1);

    // Asking again at the current generation is the same grant, not a churn.
    const again = await harness!.service.ensureWorkbenchGrant(userId);
    expect(again.grant.grantId).toBe(renewed.grant.grantId);
    expect(again.created).toBe(false);
  });

  test("legacy_arm_without_registry_writes_no_principal_and_stays_usable", async () => {
    const userId = await harness!.newUser("legacy");
    const identity = hintOf(userId);

    // The M0/M1 assembly, exactly as today: no registry, and a user id no
    // principal exists for — the legacy path asks nothing of the principal
    // layer and its rows keep their pre-T05.10 shape.
    const offer = await harness!.liveOffer("legacy-bot", identity);
    const { grant, created } = await harness!.legacy.confirm(
      userId,
      offer.bindingCode,
    );
    expect(created).toBe(true);
    expect(grant.principalId).toBeNull();
    expect(grant.identityGeneration).toBeNull();
    expect(await principalRow(userId)).toBeUndefined();

    // The use doors answer exactly as before — no generation to compare, no
    // refusal added: the legacy capability is unchanged.
    const resolved = await harness!.legacy.resolveForBot(grant.grantId, {
      botId: `${PREFIX}-legacy-bot`,
      status: "active",
    });
    expect(resolved.grantId).toBe(grant.grantId);
    const forUser = await harness!.legacy.resolveForUser(grant.grantId, userId);
    expect(forUser.grantId).toBe(grant.grantId);
  });
});
