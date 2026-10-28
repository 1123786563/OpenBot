import {
  afterAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../src/db/client";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { deploymentExternalCustomerId } from "../src/billing/service";
import { payerKey, readPayerAccount } from "../src/billing/payer";
import {
  CompanyScopeRequiredError,
  resolveCompanyPayerAccount,
} from "../src/billing/payer-company";
import { createCreditWriter } from "../src/billing/credits-writer";
import { createDatabase } from "../src/db/client";
import { payerAccounts } from "../src/db/schema/billing";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The company branch against a real PostgreSQL, gated on TEST_DATABASE_URL the way the rest of
 * the integration suite is. The ticket's acceptance criteria live here: a company resolution is
 * idempotent per tenant (one row, race-arbitrated by the database's unique indexes), a born
 * account carries no balance, a replay over an already-funded account changes nothing, and a
 * refused resolution (untrusted scope) leaves the database untouched — no company row, no
 * personal account for the scope's user, no deployment key resurrected. The trust mint reuses
 * the controlled-directory-database technique: the marker is the point, not the storage; every
 * billing statement below runs against the real test database.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const run = randomUUID().slice(0, 8);

/** Every account key this run created or touched; the cleanup deletes exactly these. */
const createdKeys = new Set<string>();
/** The extra pools the concurrency test opens; closed alongside the main one. */
const extraDatabases: ReturnType<typeof createDatabase>[] = [];

function track(key: string): string {
  createdKeys.add(key);
  return key;
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

function controlledDirectoryDatabase(
  rows: readonly Record<string, unknown>[],
): Database {
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
        select: () => controlledQuery(() => rows),
      }),
  } as unknown as Database;
}

/**
 * Mint a genuinely trusted scope for a tenant/workspace pair: server-issued by the real
 * `createScopeResolver` (frozen, registered in the issued-scope marker) against a controlled
 * directory database answering one active membership.
 */
async function mintTrustedScope(input: {
  tenantId: string;
  workspaceId: string;
  actorId: string;
}): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase([
      {
        principalId: `prin_${input.actorId}`,
        tenantStatus: "active",
        principalStatus: "active",
        memberStatus: "active",
        memberEpoch: 3,
        // MT005: resolve() also checks workspace membership — the same controlled row
        // answers it (the unit fixture's twin fix, status rides along).
        status: "active",
      },
    ]),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: input.actorId, entrypoint: "web" }),
    selectTenant: () => input.tenantId,
    selectWorkspace: () => input.workspaceId,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

afterAll(async () => {
  const keys = [...createdKeys];
  if (keys.length > 0) {
    await database.execute(
      sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    // billing_customers cascades to the grants, ledger, reservations and remainders.
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
  }
  for (const extra of extraDatabases) await extra.$client.close();
  await database.$client.close();
});

describe("resolveCompanyPayerAccount is idempotent per trusted tenant", () => {
  test("a second resolution answers the same account, one row in the database", async () => {
    const tenantId = `tn_company-1-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_team-1-${run}`,
      actorId: `usr_member-1-${run}`,
    });
    track(payerKey({ kind: "company", id: tenantId }));

    const first = await resolveCompanyPayerAccount(database, scope);
    expect(first.externalCustomerId).toBe(
      payerKey({ kind: "company", id: tenantId }),
    );
    expect(first.kind).toBe("company");
    expect(first.payerId).toBe(tenantId);

    const again = await resolveCompanyPayerAccount(database, scope);
    expect(again.id).toBe(first.id);

    const rows = await database
      .select({ id: payerAccounts.id })
      .from(payerAccounts)
      .where(
        and(
          eq(payerAccounts.kind, "company"),
          eq(payerAccounts.payerId, tenantId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(
      await readPayerAccount(database, { kind: "company", id: tenantId }),
    ).toEqual(first);
  });
});

describe("concurrent first resolutions leave exactly one company account", () => {
  test("six connections racing one tenant all answer the one account row", async () => {
    const tenantId = `tn_company-race-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_team-race-${run}`,
      actorId: `usr_member-race-${run}`,
    });
    // Separate database instances = separate connection pools: the inserts genuinely land on
    // different connections, so the unique index — not event-loop luck — decides the winner.
    const lanes = Array.from({ length: 6 }, () => {
      const lane = createDatabase(testDatabaseUrl(), { max: 1 });
      extraDatabases.push(lane);
      return lane;
    });

    const answers = await Promise.all(
      lanes.map((lane) => resolveCompanyPayerAccount(lane, scope)),
    );
    track(answers[0].externalCustomerId);

    const ids = new Set(answers.map((answer) => answer.id));
    expect(ids.size).toBe(1);
    const rows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE kind = 'company' AND payer_id = ${tenantId}`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

describe("a company resolution creates the account and no balance", () => {
  test("no grant, no ledger row, and the writer answers a zero balance", async () => {
    const tenantId = `tn_company-born-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_team-born-${run}`,
      actorId: `usr_member-born-${run}`,
    });
    const account = await resolveCompanyPayerAccount(database, scope);
    track(account.externalCustomerId);

    const rows = await database.execute(
      sql`SELECT (SELECT count(*) FROM credit_grants WHERE external_customer_id = ${account.externalCustomerId}) AS grants,
                 (SELECT count(*) FROM credit_ledger WHERE external_customer_id = ${account.externalCustomerId}) AS ledger`,
    );
    expect(Number(rows[0].grants)).toBe(0);
    expect(Number(rows[0].ledger)).toBe(0);
    expect(await writer.availableBalance(account.externalCustomerId)).toBe(0);
  });

  test("a replay over an already-funded company account changes no balance", async () => {
    const tenantId = `tn_company-funded-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_team-funded-${run}`,
      actorId: `usr_member-funded-${run}`,
    });
    const account = await resolveCompanyPayerAccount(database, scope);
    track(account.externalCustomerId);

    await writer.grantCredits({
      externalCustomerId: account.externalCustomerId,
      source: "plan",
      totalCents: 5000,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idempotencyKey: `company-funded-${run}`,
    });
    const before = await writer.availableBalance(account.externalCustomerId);
    expect(before).toBe(5000);

    await resolveCompanyPayerAccount(database, scope);
    expect(await writer.availableBalance(account.externalCustomerId)).toBe(
      before,
    );
  });
});

describe("a refused company resolution leaves no account behind", () => {
  test("an untrusted scope creates nothing and no personal or deployment fallback row", async () => {
    const actorId = `usr_refused-${run}`;
    const tenantId = `tn_company-refused-${run}`;
    // A hand-built scope with a complete, plausible PlatformScope shape — the forgery a client
    // cannot actually send but a careless caller could pass. Refused before any database write.
    const forged: PlatformScope = {
      tenantId,
      workspaceId: `ws_refused-${run}`,
      principalId: `prin_${actorId}`,
      actorId,
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    };
    await expect(resolveCompanyPayerAccount(database, forged)).rejects.toThrow(
      CompanyScopeRequiredError,
    );

    const rows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE payer_id = ${tenantId}`,
    );
    expect(Number(rows[0].n)).toBe(0);
    // No fallback subject was opened either: not the user's personal key, not the deployment
    // key for the actor or the (forged) tenant — the refusal answered with an error and
    // wrote nothing anywhere.
    const fallbackKeys = [
      `openbot-personal-${actorId}`,
      deploymentExternalCustomerId(actorId),
      deploymentExternalCustomerId(tenantId),
    ];
    const fallbackRows = await database.execute(
      sql`SELECT count(*) AS n FROM payer_accounts WHERE external_customer_id IN (${sql.join(
        fallbackKeys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    expect(Number(fallbackRows[0].n)).toBe(0);
  });
});
