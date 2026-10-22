import { afterAll, describe, expect, test } from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Database } from "../src/db/client";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { createPayerAccount, payerKey, type PayerRef } from "../src/billing/payer";
import {
  currentPayerBinding,
  resolveConsumptionPayerBinding,
  withPayerBinding,
} from "../src/billing/payer-binding";
import { createCreditWriter, type CreditAmount } from "../src/billing/credits-writer";
import { createUsageOutbox } from "../src/billing/usage-outbox";
import {
  createWorkbenchPayerMiddleware,
  currentWorkbenchScope,
  resolveWorkbenchPayerBinding,
} from "../src/billing/workbench-payer";
import { createDatabase } from "../src/db/client";
import { creditChargeRemainders } from "../src/db/schema/credit-reservations";
import { payerAccounts } from "../src/db/schema/billing";
import { usageOutbox as usageOutboxTable } from "../src/db/schema/usage-outbox";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Bifrost 09.2 (#287): the company workbench call's payer runs through the whole chain.
 *
 * The questions here are the ticket's own acceptance criteria, answered against the real
 * PostgreSQL the rest of the billing suite uses:
 *  - a workbench request under a company scope binds the COMPANY payer, and the chain a
 *    model call actually performs under that binding (the consumption entry's resolution,
 *    the admission reserve, the usage fact, the settlement, the carried remainder) names
 *    exactly that one account — the person's own account never moves;
 *  - the usage fact records the team and the person (workspaceId from the scope beside
 *    the owner), while the payer stays the company no matter what they read;
 *  - a short company balance is refused on the company account — no second resolution, no
 *    switch to a personal or deployment account.
 *
 * The gate's money steps are re-enacted here call for call (resolve → reserve → fact →
 * settle, index.ts's modelUsageGate closure): that closure is assembly, not a unit, and
 * these ARE its moves, performed inside the binding the workbench middleware established —
 * which is exactly the wiring this ticket adds.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);
const outbox = createUsageOutbox(database);
const run = randomUUID().slice(0, 8);

/** Every account key this run created; the cleanup deletes exactly these. */
const createdKeys = new Set<string>();

function track(key: string): string {
  createdKeys.add(key);
  return key;
}

async function openAccount(ref: PayerRef): Promise<string> {
  const { account } = await createPayerAccount(database, ref);
  track(account.externalCustomerId);
  return account.externalCustomerId;
}

function farFuture(): Date {
  return new Date(Date.now() + 365 * 24 * 3600 * 1000);
}

/**
 * Mint a genuinely trusted scope for a tenant/workspace pair: server-issued by the real
 * `createScopeResolver` against a controlled directory database answering one active
 * membership — the same technique payer-company-resolution.integration.test.ts uses.
 */
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
 * `createScopeResolver` against a controlled directory database answering one active
 * membership — the same technique payer-company-resolution.integration.test.ts uses.
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

/** Fund an account with `units` scaled cents the way a real grant would. */
async function fund(key: string, units: number): Promise<void> {
  await writer.grantCredits({
    externalCustomerId: key,
    source: "promo",
    totalCents: units,
    expiresAt: farFuture(),
  });
}

afterAll(async () => {
  const keys = [...createdKeys];
  if (keys.length > 0) {
    // billing_customers cascades to the grants, ledger, reservations and remainders.
    await database.execute(
      sql`DELETE FROM billing_customers WHERE external_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    await database.execute(
      sql`DELETE FROM payer_accounts WHERE external_customer_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
    await database.execute(
      sql`DELETE FROM usage_outbox WHERE external_customer_id IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})`,
    );
  }
  await database.$client.close();
});

describe("the workbench middleware binds the company payer and the scope facts", () => {
  test("a company scope request runs bound to the company account with its attribution", async () => {
    const tenantId = `tn_mw-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_mw-${run}`,
      actorId: `usr_mw-${run}`,
    });
    const companyKey = track(payerKey({ kind: "company", id: tenantId }));

    // The middleware stack the workbench surface mounts, in order: the tenancy layer's
    // entry business (established ahead of the payer seam), then 09.2's binding.
    const app = new Hono();
    app.use("*", async (context, next) => {
      (
        context as unknown as {
          set: (key: "entryBusiness", value: unknown) => void;
        }
      ).set("entryBusiness", { scope });
      return next();
    });
    app.use("*", createWorkbenchPayerMiddleware({ database }));
    app.get("/probe", async (context) =>
      context.json({
        binding: currentPayerBinding() ?? null,
        scope: currentWorkbenchScope() ?? null,
      }),
    );

    const response = await app.request("/probe");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      binding: { payer: { kind: string; id: string }; externalCustomerId: string } | null;
      scope: { tenantId: string; workspaceId: string; principalId: string } | null;
    };
    expect(body.binding?.payer.kind).toBe("company");
    expect(body.binding?.payer.id).toBe(tenantId);
    expect(body.binding?.externalCustomerId).toBe(companyKey);
    expect(body.scope).toEqual({
      tenantId,
      workspaceId: `ws_mw-${run}`,
      principalId: `prin_usr_mw-${run}`,
    });
  });

  test("a request with no entry business passes through unbound", async () => {
    const app = new Hono();
    app.use("*", createWorkbenchPayerMiddleware({ database }));
    app.get("/probe", async (context) =>
      context.json({ binding: currentPayerBinding() ?? null }),
    );

    const response = await app.request("/probe");
    const body = (await response.json()) as { binding: unknown };
    // Nothing bound: the personal/legacy surfaces keep their existing resolution.
    expect(body.binding).toBeNull();
  });
});

describe("a company workbench call bills the company account through the whole chain", () => {
  test("admission, fact, settlement and remainder all name the company; the person's account never moves", async () => {
    const tenantId = `tn_chain-${run}`;
    const workspaceId = `ws_chain-${run}`;
    const personId = `usr_chain-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId,
      actorId: personId,
    });
    const companyKey = await openAccount({ kind: "company", id: tenantId });
    // The person's own account exists and is funded — the fact it never moves is the test.
    const personalKey = await openAccount({ kind: "personal", id: personId });
    await fund(personalKey, 500_000);
    await fund(companyKey, 500_000);

    const binding = await resolveWorkbenchPayerBinding(database, scope);
    const eventId = `evt-092-chain-${run}`;
    const reservation = await withPayerBinding(binding, async () => {
      // The gate's first move: ONE resolution, request-bound payer used as-is.
      const resolved = resolveConsumptionPayerBinding({
        requestBinding: currentPayerBinding(),
        deploymentBinding: { ...binding, externalCustomerId: "deployment-should-not-win" },
      });
      expect(resolved.externalCustomerId).toBe(companyKey);

      // The admission reserve — on the company account only.
      const held = await writer.reserveCredits({
        externalCustomerId: resolved.externalCustomerId,
        idempotencyKey: `adm-${eventId}`,
        maximumCents: 400_000,
        expiresAt: farFuture(),
      });
      expect(held).toMatchObject({ reserved: true });

      // The usage fact — company payer, team and person recorded, no secret anywhere.
      await outbox.record({
        eventId,
        source: "llm",
        externalCustomerId: resolved.externalCustomerId,
        transactionId: eventId,
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
        client: "web",
        occurredAt: new Date(),
        reservationId:
          held.reserved === true ? held.reservationId : null,
        actualCostNumerator: "15033",
        actualCostDenominator: "100",
        botId: null,
        ownerUserId: personId,
        workspaceId,
      });

      return held;
    });
    expect(reservation).toMatchObject({ reserved: true });

    // The settlement — a fractional actual (150.33 scaled units) leaves a carried remainder.
    const settled = await writer.settleReservation({
      reservationId:
        reservation.reserved === true ? reservation.reservationId : "",
      actual: { numerator: 15033n, denominator: 100n } satisfies CreditAmount,
      title: "company workbench model call",
      model: "test-model",
      client: "web",
    });
    expect(settled.chargedCents).toBeGreaterThan(0);

    // The company account paid; the person's account did not move a unit.
    const companyBalance = await writer.availableBalance(companyKey);
    const personalBalance = await writer.availableBalance(personalKey);
    expect(companyBalance).toBeLessThan(500_000);
    expect(personalBalance).toBe(500_000);

    // The remainder the settlement carried is the COMPANY's fraction — same account key,
    // not the person's, not a fresh one.
    const remainders = await database
      .select({
        numerator: creditChargeRemainders.numerator,
        denominator: creditChargeRemainders.denominator,
      })
      .from(creditChargeRemainders)
      .where(eq(creditChargeRemainders.externalCustomerId, companyKey));
    expect(remainders.length).toBeGreaterThan(0);

    // The fact on record: company payer, team and person attributed.
    const [fact] = await database
      .select()
      .from(usageOutboxTable)
      .where(eq(usageOutboxTable.eventId, eventId));
    expect(fact.externalCustomerId).toBe(companyKey);
    expect(fact.workspaceId).toBe(workspaceId);
    expect(fact.ownerUserId).toBe(personId);
  });
});

describe("a short company balance is refused on the company account", () => {
  test("no switch to a personal or deployment account, and nothing moves anywhere else", async () => {
    const tenantId = `tn_refuse-${run}`;
    const personId = `usr_refuse-${run}`;
    const scope = await mintTrustedScope({
      tenantId,
      workspaceId: `ws_refuse-${run}`,
      actorId: personId,
    });
    // The company account exists with NO funding; the person's is flush.
    const companyKey = await openAccount({ kind: "company", id: tenantId });
    const personalKey = await openAccount({ kind: "personal", id: personId });
    await fund(personalKey, 500_000);

    const binding = await resolveWorkbenchPayerBinding(database, scope);
    const refusal = await withPayerBinding(binding, async () => {
      const resolved = resolveConsumptionPayerBinding({
        requestBinding: currentPayerBinding(),
        deploymentBinding: { ...binding, externalCustomerId: "deployment-should-not-win" },
      });
      const held = await writer.reserveCredits({
        externalCustomerId: resolved.externalCustomerId,
        idempotencyKey: `adm-refuse-${run}`,
        maximumCents: 400_000,
        expiresAt: farFuture(),
      });
      expect(held).toEqual({ reserved: false, availableCents: 0 });
      // The gate's own next move on this answer (B5-219/AC13): refuse on the bound account —
      // its kind and its own available amount; no re-resolution, no switch.
      expect(resolved.payer.kind).toBe("company");
      expect(resolved.externalCustomerId).toBe(companyKey);
      return held;
    });
    expect(refusal).toEqual({ reserved: false, availableCents: 0 });

    // The person's account is untouched; the company has no holds; nothing was written.
    expect(await writer.availableBalance(personalKey)).toBe(500_000);
    expect(await writer.availableBalance(companyKey)).toBe(0);
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
  });
});
