import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createCreditWriter } from "../src/billing/credits-writer";
import {
  CreditInsufficientError,
  PayerBindingConflictError,
  assertSamePayer,
  bindPayer,
  currentPayerBinding,
  ensureDeploymentPayerBinding,
  restorePayerBinding,
  resolveConsumptionPayerBinding,
  withPayerBinding,
  type PayerBinding,
} from "../src/billing/payer-binding";
import {
  createPayerAccount,
  readPayerAccountForKey,
} from "../src/billing/payer";
import { deploymentExternalCustomerId } from "../src/billing/service";
import { USAGE_IDEMPOTENCY_KEY_PREFIX } from "../src/billing/types";
import { createCreditUsageTarget } from "../src/billing/usage-delivery";
import { isConfirmedNoCost } from "../src/billing/usage-evidence";
import {
  countChatInputTokens,
  fitChatInputRequest,
} from "../src/billing/input-bound";
import {
  CreditGateFailureError,
  CreditPolicyUnconfiguredError,
  ModelNotPricedError,
  ModelUsageSettlementError,
} from "../src/copilot";
import {
  UsageChargeError,
  calculateExactModelUsageCharge,
} from "../src/workshop/metering";
import {
  creditChargeRemainders,
  creditReservations,
} from "../src/db/schema/credit-reservations";
import { creditLedger } from "../src/db/schema/credits";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * B5-219 (Bifrost 02.5): one request, one payer. The consumption entry binds a PayerBinding
 * once; an insufficient balance on the bound account is a refusal that names the account type
 * and its own available amount — never a second resolution, never a charge on another account,
 * never a switch to the deployment's subscription account. Settlement and the carried remainder
 * land on the same account the admission reserved, and a recovered process restores the binding
 * from the persisted payer-account mapping (never by guessing from the key's shape).
 *
 * Unit section: the binding module's pure contract. Integration section: the same contract
 * against the real ledger in the dedicated test database. The static section is the call-site
 * inventory the acceptance criteria demand: the deployment-level key has exactly its legacy
 * call sites — the definition, the payer layer's legacy branch, the 02.2 attribution pass and
 * the boot/entry wiring — and none may grow.
 */

const run = randomUUID().slice(0, 8);

describe("bindPayer resolves the payer ref to one account key, once", () => {
  test("a personal ref binds to the personal key", () => {
    const binding = bindPayer({ kind: "personal", id: `usr_${run}` });
    expect(binding.payer).toEqual({ kind: "personal", id: `usr_${run}` });
    expect(binding.externalCustomerId).toBe(`openbot-personal-usr_${run}`);
  });

  test("a legacy_deployment ref binds to the deployment key spelling exactly", () => {
    const binding = bindPayer({ kind: "legacy_deployment", id: `dep_${run}` });
    expect(binding.externalCustomerId).toBe(
      deploymentExternalCustomerId(`dep_${run}`),
    );
  });

  test("a quarantined unknown_owner ref can never bind", () => {
    expect(() =>
      bindPayer({ kind: "unknown_owner", id: `ghost_${run}` }),
    ).toThrow(TypeError);
  });

  test("an empty or whitespace-padded id is a caller bug, refused", () => {
    expect(() => bindPayer({ kind: "personal", id: "" })).toThrow(TypeError);
    expect(() => bindPayer({ kind: "personal", id: " usr_1" })).toThrow(
      TypeError,
    );
  });
});

describe("assertSamePayer fences settlement to the bound account", () => {
  const binding = bindPayer({ kind: "personal", id: `usr_${run}` });

  test("the same ref passes", () => {
    expect(() =>
      assertSamePayer(binding, { kind: "personal", id: `usr_${run}` }),
    ).not.toThrow();
  });

  test("a different id or kind is a binding conflict, named without the foreign id", () => {
    for (const foreign of [
      { kind: "personal", id: `other_${run}` },
      { kind: "company", id: `usr_${run}` },
    ] as const) {
      try {
        assertSamePayer(binding, foreign);
        throw new Error("expected PayerBindingConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(PayerBindingConflictError);
        expect((error as PayerBindingConflictError).code).toBe(
          "payer_binding_conflict",
        );
        expect((error as Error).message).not.toContain(foreign.id);
      }
    }
  });
});

describe("restorePayerBinding rebuilds the binding from the mapping row", () => {
  test("a mapping row restores kind, id and key", () => {
    const binding = restorePayerBinding({
      id: `pa_${run}`,
      kind: "personal",
      payerId: `usr_${run}`,
      externalCustomerId: `openbot-personal-usr_${run}`,
      createdAt: new Date(0).toISOString(),
    });
    expect(binding.payer).toEqual({ kind: "personal", id: `usr_${run}` });
    expect(binding.externalCustomerId).toBe(`openbot-personal-usr_${run}`);
  });

  test("an unknown_owner row is quarantined: it can never become a binding", () => {
    expect(() =>
      restorePayerBinding({
        id: `pa_${run}`,
        kind: "unknown_owner",
        payerId: `openbot-deployment-ghost_${run}`,
        externalCustomerId: `openbot-deployment-ghost_${run}`,
        createdAt: new Date(0).toISOString(),
      }),
    ).toThrow(PayerBindingConflictError);
  });
});

describe("the request context carries exactly one binding", () => {
  test("no binding outside a request", async () => {
    expect(currentPayerBinding()).toBeUndefined();
    await withPayerBinding(
      bindPayer({ kind: "personal", id: `usr_${run}` }),
      async () => {
        expect(currentPayerBinding()?.payer.id).toBe(`usr_${run}`);
      },
    );
    expect(currentPayerBinding()).toBeUndefined();
  });

  test("the innermost binding wins, and the outer one survives the inner scope", async () => {
    const outer = bindPayer({ kind: "personal", id: `outer_${run}` });
    const inner = bindPayer({ kind: "company", id: `inner_${run}` });
    await withPayerBinding(outer, async () => {
      await withPayerBinding(inner, async () => {
        expect(currentPayerBinding()).toBe(inner);
      });
      expect(currentPayerBinding()).toBe(outer);
    });
  });
});

describe("the consumption entry resolves the payer once, or refuses a forged binding", () => {
  const deploymentBinding = bindPayer({
    kind: "legacy_deployment",
    id: `dep_${run}`,
  });

  test("a bound request keeps its binding untouched — the deployment default is never consulted", () => {
    const requestBinding = bindPayer({ kind: "company", id: `ten_${run}` });
    const resolved = resolveConsumptionPayerBinding({
      requestBinding,
      deploymentBinding,
    });
    expect(resolved).toBe(requestBinding);
    // And again on the same request: the same object, no re-resolution.
    expect(
      resolveConsumptionPayerBinding({ requestBinding, deploymentBinding }),
    ).toBe(requestBinding);
  });

  test("an unbound request resolves to the deployment binding, the one explicit default", () => {
    expect(
      resolveConsumptionPayerBinding({
        requestBinding: undefined,
        deploymentBinding,
      }),
    ).toBe(deploymentBinding);
  });

  test("a forged binding whose key does not derive from its ref is refused", () => {
    const forged = {
      payer: { kind: "company" as const, id: `ten_${run}` },
      externalCustomerId: `openbot-personal-someone_else_${run}`,
      boundAt: new Date(0).toISOString(),
    };
    expect(() =>
      resolveConsumptionPayerBinding({
        requestBinding: forged,
        deploymentBinding,
      }),
    ).toThrow(PayerBindingConflictError);
  });
});

describe("the insufficient-balance refusal names its own account, and nobody else's", () => {
  test("the error carries the account type and the available amount", () => {
    const error = new CreditInsufficientError({
      payerKind: "personal",
      availableCents: 123,
    });
    expect(error.code).toBe("credits_exhausted");
    expect(error.payerKind).toBe("personal");
    expect(error.availableCents).toBe(123);
    expect(error.message).toContain("personal");
    expect(error.message).toContain("1.23");
  });

  test("the message carries no account keys and no foreign identity", () => {
    const error = new CreditInsufficientError({
      payerKind: "company",
      availableCents: 50,
    });
    expect(error.message).not.toContain("openbot-");
    expect(error.message).not.toContain(`ten_${run}`);
  });

  test("a quarantined kind is never displayable", () => {
    expect(
      () =>
        new CreditInsufficientError({
          payerKind: "unknown_owner",
          availableCents: 0,
        }),
    ).toThrow();
  });
});

/*
 * Integration: the same contract against the real ledger.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const writer = createCreditWriter(database);

/** Every account key this run created; cleanup removes the mapping and the money together. */
const createdKeys = new Set<string>();

function track(key: string): string {
  createdKeys.add(key);
  return key;
}

async function fundedPersonalAccount(
  userId: string,
  grantCents: number,
): Promise<{ id: string; key: string }> {
  const ref = { kind: "personal" as const, id: userId };
  await createPayerAccount(database, ref);
  if (grantCents > 0) {
    await writer.grantCredits({
      externalCustomerId: `openbot-personal-${userId}`,
      source: "promo",
      totalCents: grantCents,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }
  track(`openbot-personal-${userId}`);
  return { id: userId, key: `openbot-personal-${userId}` };
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
  await database.$client.close();
});

describe("an insufficient balance refuses the bound request and touches nothing else", () => {
  // DB-bound (real ledger, real locking) on a Postgres that serves other workloads: these two
  // run far under the limit on an idle server but must not flake when it is busy.
  test("the hold is refused on the bound account only, with no second resolution", async () => {
    const short = await fundedPersonalAccount(`short_${run}`, 50);
    const other = await fundedPersonalAccount(`other_${run}`, 9999);
    const binding = bindPayer({ kind: "personal", id: short.id });

    // The admission decision the gate makes, driven through the same binding the
    // request context carries: exactly one resolution, exactly one reserve attempt.
    const resolved = withPayerBinding(binding, () =>
      resolveConsumptionPayerBinding({
        requestBinding: currentPayerBinding(),
        deploymentBinding: bindPayer({
          kind: "legacy_deployment",
          id: `dep_${run}`,
        }),
      }),
    );
    expect(resolved).toBe(binding);

    const reservation = await writer.reserveCredits({
      externalCustomerId: resolved.externalCustomerId,
      idempotencyKey: `evt_${run}_refused`,
      maximumCents: 100,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(reservation).toEqual({ reserved: false, availableCents: 50 });

    // The refusal semantics: own type, own available, nobody else's data.
    const refusal = new CreditInsufficientError({
      payerKind: resolved.payer.kind,
      availableCents: reservation.availableCents,
    });
    expect(refusal.message).toContain("personal");
    expect(refusal.message).toContain("0.50");
    expect(refusal.message).not.toContain(other.id);
    expect(refusal.message).not.toContain(other.key);
    expect(refusal.message).not.toContain("99.99");
    expect(refusal.message).not.toContain("openbot-");

    // No second resolution: one mapping row for the bound account, none created for
    // anyone else, and the other account's money untouched.
    const mapping = await readPayerAccountForKey(database, short.key);
    expect(mapping?.payerId).toBe(short.id);
    const otherBalance = await writer.availableBalance(other.key);
    expect(otherBalance).toBe(9999);

    // No reservation and no ledger row exists for any key of this run: the refusal
    // wrote nothing, on the bound account or anywhere else.
    const rows = await database.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_reservations
      WHERE idempotency_key = ${`evt_${run}_refused`}
    `);
    expect(rows[0]?.n).toBe("0");
    const ledgerRows = await database.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_ledger
      WHERE external_customer_id IN (${short.key}, ${other.key})
    `);
    expect(ledgerRows[0]?.n).toBe("0");
  }, 20_000);
});

describe("settlement and the carried remainder land on the bound account", () => {
  test("reserve, settle and remainder all carry the same external customer id", async () => {
    const bound = await fundedPersonalAccount(`bound_${run}`, 1000);
    const bystander = await fundedPersonalAccount(`bystander_${run}`, 1000);
    const binding = await withPayerBinding(
      bindPayer({ kind: "personal", id: bound.id }),
      async () =>
        resolveConsumptionPayerBinding({
          requestBinding: currentPayerBinding(),
          deploymentBinding: bindPayer({
            kind: "legacy_deployment",
            id: `dep_${run}`,
          }),
        }),
    );

    const reservation = await writer.reserveCredits({
      externalCustomerId: binding.externalCustomerId,
      idempotencyKey: `evt_${run}_settled`,
      maximumCents: 500,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (!reservation.reserved) {
      throw new Error("expected the funded bound account to reserve");
    }

    // The consumption record (outbox row shape) carries the binding's own key; the
    // credit target settles through it in whatever process picks the row up.
    const chargeCredits = createCreditUsageTarget(writer);
    await chargeCredits({
      eventId: `evt_${run}_settled`,
      source: "llm",
      externalCustomerId: binding.externalCustomerId,
      transactionId: `evt_${run}_settled`,
      inputTokens: 10,
      outputTokens: 10,
      model: "test-model",
      client: "web",
      occurredAt: new Date(),
      reservationId: reservation.reservationId,
      actualCostNumerator: "333",
      actualCostDenominator: "100",
      lagoStatus: "pending",
      creditsStatus: "pending",
      lagoAttempts: 0,
      creditsAttempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Parameters<typeof chargeCredits>[0]);

    // The settlement's ledger row and the account's carried remainder are both on the
    // bound account's key — never the bystander's, never the deployment's.
    const [ledgerRow] = await database
      .select({
        customer: creditLedger.externalCustomerId,
        credits: creditLedger.credits,
      })
      .from(creditLedger)
      .where(
        eq(
          creditLedger.idempotencyKey,
          `reservation:${reservation.reservationId}`,
        ),
      )
      .limit(1);
    expect(ledgerRow?.customer).toBe(bound.key);

    const [remainderRow] = await database
      .select({
        customer: creditChargeRemainders.externalCustomerId,
        numerator: creditChargeRemainders.numerator,
        denominator: creditChargeRemainders.denominator,
      })
      .from(creditChargeRemainders)
      .where(eq(creditChargeRemainders.externalCustomerId, bound.key))
      .limit(1);
    expect(remainderRow?.numerator).toBe("33");
    expect(remainderRow?.denominator).toBe("100");

    // The bystander's money and records are exactly as they were.
    expect(await writer.availableBalance(bystander.key)).toBe(1000);
    const bystanderLedger = await database.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_ledger
      WHERE external_customer_id = ${bystander.key}
    `);
    expect(bystanderLedger[0]?.n).toBe("0");
  }, 20_000);
});

describe("cross-process recovery restores the binding from the mapping, never a guess", () => {
  test("the persisted mapping row restores kind and id", async () => {
    const subject = await fundedPersonalAccount(`recover_${run}`, 0);
    const mapping = await readPayerAccountForKey(database, subject.key);
    if (!mapping) throw new Error("expected the mapping row to exist");
    const binding = restorePayerBinding(mapping);
    expect(binding.payer).toEqual({ kind: "personal", id: subject.id });
    expect(binding.externalCustomerId).toBe(subject.key);
  });

  test("an unmapped key has no binding: the recovery answer is a refusal, not a guess", async () => {
    const unmapped = await readPayerAccountForKey(
      database,
      `openbot-personal-never_mapped_${run}`,
    );
    expect(unmapped).toBeNull();
  });
});

describe("the deployment's own payer binding is made once, explicitly", () => {
  test("ensure creates the mapping idempotently and answers the same binding", async () => {
    const deploymentId = `dep_${run}`;
    const first = await ensureDeploymentPayerBinding(database, {
      id: deploymentId,
    });
    track(first.externalCustomerId);
    expect(first.payer).toEqual({
      kind: "legacy_deployment",
      id: deploymentId,
    });
    expect(first.externalCustomerId).toBe(
      deploymentExternalCustomerId(deploymentId),
    );

    const second = await ensureDeploymentPayerBinding(database, {
      id: deploymentId,
    });
    expect(second.externalCustomerId).toBe(first.externalCustomerId);
  });

  test("a key quarantined as unknown_owner is a loud conflict, never a borrowed account", async () => {
    const ghostKey = deploymentExternalCustomerId(`ghost_${run}`);
    track(ghostKey);
    // The mapping's foreign key needs the customer floor, exactly as every real path lays it.
    await database.execute(sql`
      INSERT INTO billing_customers (external_id) VALUES (${ghostKey})
      ON CONFLICT DO NOTHING
    `);
    await database.execute(sql`
      INSERT INTO payer_accounts (id, kind, payer_id, external_customer_id)
      VALUES (${`pa_ghost_${run}`}, 'unknown_owner', ${ghostKey}, ${ghostKey})
      ON CONFLICT DO NOTHING
    `);
    await expect(
      ensureDeploymentPayerBinding(database, { id: `ghost_${run}` }),
    ).rejects.toBeInstanceOf(PayerBindingConflictError);
  });
});

/*
 * F1 (review b5-219, Medium) — the behavior half of the fix. Everything above proves the
 * SEAM's contract; nothing before this block ever executed the gate itself — the
 * `setModelUsageGate(async (input) => {…})` closure index.ts registers — so an
 * AC13-forbidden fallback living inside that closure had no behavioral oracle (the
 * review's M6 mutation: re-reserve on the deployment binding inside the refusal branch
 * survived every earlier case). Here the gate's REAL source is extracted from index.ts,
 * transpiled and executed against the REAL collaborators: the real
 * resolveConsumptionPayerBinding/currentPayerBinding (so withPayerBinding drives the
 * request binding through the real AsyncLocalStorage), the REAL credit writer on the
 * real test database — a hold anywhere is an observable row on some key — and capture
 * stubs only where the assertion IS the capture (which account the outbox and evidence
 * writes name). The database is the oracle; any account switch leaves a fingerprint.
 */
describe("the consumption gate itself: extracted from index.ts and executed", () => {
  const gateModelId = "gate-model";
  const gateModelPolicy = {
    input: {
      rate: { numerator: 1n, denominator: 100n },
      maximumTokens: 1000n,
      maximumCostUnits: 1000n,
    },
    output: {
      rate: { numerator: 1n, denominator: 50n },
      maximumTokens: 1000n,
      maximumCostUnits: 1000n,
    },
    maximumReservationUnits: 100n,
  };

  /**
   * The gate's enclosing scope, answered by a proxy that knows EXACTLY these names: a
   * free identifier outside this list is a genuine ReferenceError the moment the gate
   * touches it, so the closure can never silently inherit a test-scope name, and a new
   * dependency the gate grows fails loudly until this list widens deliberately.
   */
  const gateScope = (deploymentBinding: PayerBinding) => {
    const outboxRecords: Array<Record<string, unknown>> = [];
    const unsettledRecords: Array<Record<string, unknown>> = [];
    const warned: Array<Record<string, unknown>> = [];
    const values: Record<string, unknown> = {
      creditPolicy: {
        configured: true as const,
        mode: "hard_cap" as const,
        models: new Map([[gateModelId, gateModelPolicy]]),
      },
      runtimeModel: { defaultModel: gateModelId },
      /*
       * The billing assembly's real shape (index.ts returns service/client/externalCustomerKey/
       * customerName/deploymentPayerBinding/creditWriter): the stub carries every field a
       * fallback mutation could reach for, so a forbidden second reserve cannot vanish into an
       * undefined property read — with `externalCustomerKey` present, the M6b variant (fallback
       * through the billing-held key, the shape the old inventory was blind to) leaves a real
       * observable hold row on the deployment account, exactly as it would in production.
       */
      billing: {
        creditWriter: writer,
        deploymentPayerBinding: deploymentBinding,
        externalCustomerKey: deploymentBinding.externalCustomerId,
      },
      usageOutbox: {
        record: async (row: Record<string, unknown>) => {
          outboxRecords.push(row);
        },
      },
      recordUnsettledUsage: async (row: Record<string, unknown>) => {
        unsettledRecords.push(row);
      },
      log: {
        warn: (fields: Record<string, unknown>) => {
          warned.push(fields);
        },
        error: () => {},
      },
      USAGE_IDEMPOTENCY_KEY_PREFIX,
      MODEL_RESERVATION_WINDOW_MS: 15 * 60_000,
      resolveConsumptionPayerBinding,
      currentPayerBinding,
      CreditPolicyUnconfiguredError,
      ModelNotPricedError,
      CreditGateFailureError,
      CreditInsufficientError,
      ModelUsageSettlementError,
      countChatInputTokens,
      fitChatInputRequest,
      calculateExactModelUsageCharge,
      UsageChargeError,
      usageOutboxWriteFailureCode: (error: unknown) =>
        (error as { code?: string } | null)?.code ?? "outbox_write_failed",
      logUsageOutboxWriteFailure: () => {},
      logReservationReleaseFailure: () => {},
      isConfirmedNoCost,
    };
    const accessed = new Set<string>();
    const deps = new Proxy(values, {
      has: (target, key) => Reflect.has(target, key),
      get: (target, key) => {
        if (typeof key === "string") accessed.add(key);
        return Reflect.get(target, key);
      },
    });
    return { deps, accessed, outboxRecords, unsettledRecords, warned };
  };

  /** A funded legacy_deployment account, bound exactly the way boot binds it. */
  async function fundedDeploymentAccount(
    id: string,
  ): Promise<{ binding: PayerBinding; key: string }> {
    const binding = await ensureDeploymentPayerBinding(database, { id });
    await writer.grantCredits({
      externalCustomerId: binding.externalCustomerId,
      source: "promo",
      totalCents: 9999,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    track(binding.externalCustomerId);
    return { binding, key: binding.externalCustomerId };
  }

  /*
   * Load the gate ONCE: the arrow body after `setModelUsageGate(` in index.ts, cut on the
   * RAW source with a mode-aware walker (strings, both comment forms and template
   * literals with nested `${…}` cannot unbalance the brace matching), then transpiled —
   * the body is TypeScript like the rest of the file — and evaluated inside a sloppy-mode
   * AsyncFunction under `with (deps)`. The extracted code is the code that runs in
   * production, byte for byte; only its enclosing scope is the test's.
   */
  let gateRunnerPromise:
    | Promise<
        (
          deps: unknown,
          input: unknown,
        ) => Promise<{
          finish: (usage: {
            inputTokens?: number;
            outputTokens?: number;
          }) => Promise<void>;
          fail: (failure: {
            reason: string;
            inputTokens?: number;
            outputTokens?: number;
            occurredAt?: Date;
          }) => Promise<void>;
        }>
      >
    | undefined;
  const gateRunner = () =>
    (gateRunnerPromise ??= (async () => {
      const { readFile } = await import("node:fs/promises");
      const join = (await import("node:path")).join;
      const source = await readFile(
        join(import.meta.dir, "..", "src", "index.ts"),
        "utf8",
      );

      const anchor = "setModelUsageGate(async";
      const at = source.indexOf(anchor);
      if (at < 0 || source.indexOf(anchor, at + 1) >= 0) {
        throw new Error(
          "setModelUsageGate(async …) must appear exactly once in index.ts",
        );
      }
      let i = at + anchor.length;
      while (source[i] !== "{") i += 1; // the arrow's parameter list has no braces
      const open = i;
      let depth = 0;
      let close = -1;
      while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === "/" && next === "/") {
          while (i < source.length && source[i] !== "\n") i += 1;
          continue;
        }
        if (c === "/" && next === "*") {
          i += 2;
          while (
            i < source.length &&
            !(source[i] === "*" && source[i + 1] === "/")
          )
            i += 1;
          i += 2;
          continue;
        }
        if (c === '"' || c === "'") {
          i += 1;
          while (i < source.length && source[i] !== c)
            i += source[i] === "\\" ? 2 : 1;
          i += 1;
          continue;
        }
        if (c === "`") {
          i += 1;
          let inner = 0; // interpolation depth; 0 = the template's own literal text
          while (i < source.length) {
            if (inner === 0 && source[i] === "`") break;
            if (inner === 0 && source[i] === "\\") {
              i += 2;
              continue;
            }
            if (source[i] === "$" && source[i + 1] === "{") {
              inner += 1;
              i += 2;
              continue;
            }
            if (inner > 0 && source[i] === "{") inner += 1;
            else if (inner > 0 && source[i] === "}") inner -= 1;
            i += 1;
          }
          i += 1;
          continue;
        }
        if (c === "{") depth += 1;
        else if (c === "}") {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
        i += 1;
      }
      if (close < 0) {
        throw new Error(
          "the gate's arrow body never closes; index.ts changed shape",
        );
      }
      const body = source.slice(open + 1, close);

      const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(
        `const gate = async (input) => {\n${body}\n};`,
      );
      const AsyncFunction = Object.getPrototypeOf(async () => {})
        .constructor as new (
        ...args: string[]
      ) => (
        deps: unknown,
        input: unknown,
      ) => Promise<{
        finish: (usage: {
          inputTokens?: number;
          outputTokens?: number;
        }) => Promise<void>;
        fail: (failure: {
          reason: string;
          inputTokens?: number;
          outputTokens?: number;
          occurredAt?: Date;
        }) => Promise<void>;
      }>;
      return new AsyncFunction(
        "deps",
        "input",
        `with (deps) {\n${transpiled}\nreturn gate(input);\n}`,
      );
    })());

  /** Every identifier the executed gate read through the scope proxy, across all cases. */
  const accessedUnion = new Set<string>();
  const gateCall = async (
    scope: ReturnType<typeof gateScope>,
    input: Record<string, unknown>,
  ) => {
    const run = await gateRunner();
    try {
      return await run(scope.deps, input);
    } finally {
      // Merge even when the gate refused (threw): the refusal path's reads are exactly
      // the seam identifiers this union exists to pin.
      for (const key of scope.accessed) accessedUnion.add(key);
    }
  };

  test("a bound short account is refused on itself: no hold anywhere, the deployment account untouched", async () => {
    const short = await fundedPersonalAccount(`gateshort_${run}`, 50);
    const deployment = await fundedDeploymentAccount(`gatedepA_${run}`);
    const scope = gateScope(deployment.binding);
    const eventId = `evt_${run}_gate_refused`;

    let thrown: unknown;
    await withPayerBinding(
      bindPayer({ kind: "personal", id: short.id }),
      async () => {
        try {
          await gateCall(scope, {
            eventId,
            occurredAt: new Date(),
            modelId: null,
            client: "web",
          });
        } catch (error) {
          thrown = error;
        }
      },
    );

    // The refusal is the billing-owned error, on the bound account's own facts.
    expect(thrown).toBeInstanceOf(CreditInsufficientError);
    const refusal = thrown as CreditInsufficientError;
    expect(refusal.code).toBe("credits_exhausted");
    expect(refusal.payerKind).toBe("personal");
    expect(refusal.availableCents).toBe(50);
    expect(refusal.message).toContain("personal");
    expect(refusal.message).toContain("0.50");
    expect(refusal.message).not.toContain("openbot-");

    /*
     * ONE hold attempt, on the bound account, and the refusal wrote nothing: no
     * reservation row exists for this event under ANY idempotency spelling — the M6
     * shape (a second reserve on the deployment binding, `…:m6`) would leave exactly
     * such a row on a foreign key, and would also drain the deployment account.
     */
    const holds = await database.execute<{ customer: string }>(sql`
      SELECT external_customer_id AS customer FROM credit_reservations
      WHERE idempotency_key LIKE ${`usage:${eventId}%`}
    `);
    expect(holds).toHaveLength(0);
    expect(await writer.availableBalance(deployment.key)).toBe(9999);
    const deploymentLedger = await database.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM credit_ledger
      WHERE external_customer_id = ${deployment.key}
    `);
    expect(deploymentLedger[0]?.n).toBe("0");

    // The refusal log names the bound account's kind — the deployment default was
    // never consulted for this request.
    expect(scope.warned.at(-1)?.payerKind).toBe("personal");
  }, 20_000);

  test("a bound funded account holds, settles and evidences on the bound account only", async () => {
    const bound = await fundedPersonalAccount(`gatebound_${run}`, 1000);
    const deployment = await fundedDeploymentAccount(`gatedepB_${run}`);
    const scope = gateScope(deployment.binding);
    const eventId = `evt_${run}_gate_settled`;

    const lifecycle = await withPayerBinding(
      bindPayer({ kind: "personal", id: bound.id }),
      () =>
        gateCall(scope, {
          eventId,
          occurredAt: new Date(),
          modelId: gateModelId,
          client: "web",
        }),
    );

    // The hold is a real row on the bound account, for the ceiling the policy derived.
    const [hold] = await database
      .select({
        id: creditReservations.id,
        customer: creditReservations.externalCustomerId,
        status: creditReservations.status,
        maximum: creditReservations.maximum,
      })
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
      .limit(1);
    expect(hold?.customer).toBe(bound.key);
    expect(hold?.status).toBe("reserved");
    expect(hold?.maximum).toBe(100);

    // Settlement names the same account: one outbox fact carrying the hold's id and
    // the exact rational charge 10·(1/100) + 10·(1/50) = 3/10.
    await lifecycle.finish({ inputTokens: 10, outputTokens: 10 });
    expect(scope.outboxRecords).toHaveLength(1);
    expect(scope.outboxRecords[0]).toMatchObject({
      externalCustomerId: bound.key,
      reservationId: hold?.id,
      actualCostNumerator: "3",
      actualCostDenominator: "10",
    });

    // An unknown-outcome failure keeps the hold and leaves evidence on the SAME account.
    await lifecycle.fail({
      reason: "stream_error",
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(scope.unsettledRecords.at(-1)).toMatchObject({
      externalCustomerId: bound.key,
      reason: "stream_error",
    });
    const [stillHeld] = await database
      .select({ status: creditReservations.status })
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
      .limit(1);
    // The hold is kept, never released or fallen back — it moves to the audit
    // quarantine state the unknown-outcome wave (0141) added for exactly this.
    expect(stillHeld?.status).toBe("unknown");

    // Every write this gate made named the bound account; the deployment account was
    // never read for a hold, never named by a write.
    expect(
      [...scope.outboxRecords, ...scope.unsettledRecords].every(
        (row) => row.externalCustomerId === bound.key,
      ),
    ).toBe(true);
    expect(await writer.availableBalance(deployment.key)).toBe(9999);
  }, 20_000);

  test("a request with no binding of its own resolves to the deployment binding — the one explicit default", async () => {
    const deployment = await fundedDeploymentAccount(`gatedepC_${run}`);
    const bystander = await fundedPersonalAccount(`gatebystander_${run}`, 1000);
    const scope = gateScope(deployment.binding);
    const eventId = `evt_${run}_gate_default`;

    const lifecycle = await gateCall(scope, {
      eventId,
      occurredAt: new Date(),
      modelId: null,
      client: "web",
    });

    // The hold landed on the deployment account — the documented default, not on any
    // personal account an implicit key spelling might have guessed.
    const [hold] = await database
      .select({
        customer: creditReservations.externalCustomerId,
        status: creditReservations.status,
      })
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
      .limit(1);
    expect(hold?.customer).toBe(deployment.key);
    expect(hold?.status).toBe("reserved");

    // A confirmed no-cost failure releases the deployment's own hold and nothing else.
    await lifecycle.fail({ reason: "provider_error" });
    const [released] = await database
      .select({
        status: creditReservations.status,
        releaseReason: creditReservations.releaseReason,
      })
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `usage:${eventId}`))
      .limit(1);
    expect(released?.status).toBe("released");
    expect(released?.releaseReason).toBe("provider_error");
    expect(await writer.availableBalance(deployment.key)).toBe(9999);
    expect(await writer.availableBalance(bystander.key)).toBe(1000);
  }, 20_000);

  test("the executed gate read the real seam through the pinned scope, and nothing else", async () => {
    // The cases above drove refusal, settlement, evidence, default and release. The
    // identifiers the gate actually read must include the payer seam — proof the
    // extracted code is the wired one — and the union can never exceed the pinned list:
    // an identifier outside it is a ReferenceError the moment the gate touches it.
    for (const core of [
      "resolveConsumptionPayerBinding",
      "currentPayerBinding",
      "billing",
      "creditPolicy",
      "USAGE_IDEMPOTENCY_KEY_PREFIX",
      "MODEL_RESERVATION_WINDOW_MS",
      "CreditInsufficientError",
      "log",
    ]) {
      expect(accessedUnion.has(core)).toBe(true);
    }
  });
});

describe("the call-site inventory: the deployment key has no new paths", () => {
  test("deploymentExternalCustomerId appears in exactly the legacy files, and the entry is binding-wired", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const join = (await import("node:path")).join;

    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    const srcRoot = join(import.meta.dir, "..", "src");
    await walk(srcRoot);

    const referencing: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes("deploymentExternalCustomerId")) {
        referencing.push(file);
      }
    }
    const names = referencing
      .map((file) => file.replace(`${srcRoot}/`, ""))
      .sort();
    expect(names).toEqual([
      "app.ts", // assembly comment only (the key arrives derived)
      "billing/payer-legacy.ts", // 02.2 legacy attribution
      "billing/payer.ts", // the payer layer's legacy_deployment branch
      "billing/routes.ts", // admin route comment only
      "billing/service.ts", // the definition
      "index.ts", // boot derivation + the consumption entry's binding wiring
    ]);

    // The consumption entry is binding-wired: the gate resolves a PayerBinding and
    // refuses through the billing-owned insufficient error — no bare deployment key.
    const entry = await readFile(join(srcRoot, "index.ts"), "utf8");
    expect(entry).toContain("resolveConsumptionPayerBinding(");
    expect(entry).toContain("currentPayerBinding()");
    expect(entry).toContain("new CreditInsufficientError(");
  });

  /*
   * F1 (review b5-219, Medium): the inventory above measures the `deploymentExternalCustomerId`
   * identifier's file set, so a fallback that grows INSIDE a whitelisted file — reaching the
   * same deployment key through `billing.externalCustomerKey` or `billing.deploymentPayerBinding`
   * — was invisible to it (the review's M6 mutation: a second reserve on the deployment binding
   * inside the refusal branch left all 23 cases green). This test closes that blind spot on the
   * gate itself: it extracts the consumption-entry gate's function body from index.ts and pins
   * the structural shape AC13 demands — the ONE payer-identity source is the single
   * `resolveConsumptionPayerBinding` call, and the ONE hold attempt is the single `reserveCredits`
   * call, so a refusal has nowhere to re-resolve to and nothing to retry on.
   *
   * The extraction is a small scanner (not a full AST) that tracks strings, template literals
   * with their `${…}` interpolations, and both comment forms, so the assertions below see CODE,
   * not prose: a comment mentioning "deployment" can never satisfy them, and neither can a
   * string literal smuggle an identifier past the word-boundary match.
   */
  test("the gate body itself has no second payer resolution: one resolve, one reserve, no foreign key identifier", async () => {
    const { readFile } = await import("node:fs/promises");
    const join = (await import("node:path")).join;
    const source = await readFile(
      join(import.meta.dir, "..", "src", "index.ts"),
      "utf8",
    );

    // Anchor on the raw source first (unique), then scan ONLY from there: the scanner
    // below is string/comment aware but not regex-literal aware, and the file above the
    // gate is 3800 lines of assembly that owes the test nothing.
    const anchor = "setModelUsageGate(async";
    const anchorAt = source.indexOf(anchor);
    if (anchorAt < 0)
      throw new Error(
        "setModelUsageGate(async (input) => {…) not found in index.ts",
      );
    if (source.indexOf(anchor, anchorAt + 1) >= 0)
      throw new Error(
        "setModelUsageGate(async appears more than once in index.ts",
      );

    /*
     * Scan text emitting only code: string-literal contents and comments become spaces,
     * template-literal text is dropped while `${…}` interpolations are kept (they are
     * code). The scanner is deliberately total — it does not throw on anything, it just
     * neutralizes non-code regions, so what remains is exactly the identifiers and
     * punctuation the runtime could act on.
     */
    const codeOnly = (text: string): string => {
      let out = "";
      let i = 0;
      const blank = (c: string) => {
        out += c === "\n" ? "\n" : " ";
      };
      while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (c === "/" && next === "/") {
          while (i < text.length && text[i] !== "\n") blank(text[i++]);
          continue;
        }
        if (c === "/" && next === "*") {
          blank(text[i++]);
          blank(text[i++]);
          while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
            blank(text[i++]);
          blank(text[i++]);
          blank(text[i++]);
          continue;
        }
        if (c === '"' || c === "'") {
          const quote = c;
          blank(text[i++]);
          while (i < text.length && text[i] !== quote) {
            if (text[i] === "\\") blank(text[i++]);
            blank(text[i++]);
          }
          blank(text[i++]);
          continue;
        }
        if (c === "`") {
          blank(text[i++]);
          let depth = 0; // brace depth inside the template; 0 = literal text
          while (i < text.length) {
            if (depth === 0 && text[i] === "`") break;
            if (depth === 0 && text[i] === "\\") {
              blank(text[i++]);
              blank(text[i++]);
              continue;
            }
            if (text[i] === "$" && text[i + 1] === "{") {
              out += "${";
              i += 2;
              depth += 1;
              continue;
            }
            /*
             * Interpolation code must be emitted with BALANCED braces: every brace the
             * depth counter sees is also written, so `${…}` pairs cannot leave an
             * unmatched `{` behind. (An earlier version blanked the `}` that closes an
             * interpolation while keeping its "${" opener; the gate's idempotency-key
             * template alone — two interpolations — made every brace-matched assertion
             * below die with "unbalanced block".)
             */
            if (depth > 0 && text[i] === "{") {
              depth += 1;
              out += text[i++];
              continue;
            }
            if (depth > 0 && text[i] === "}") {
              depth -= 1;
              out += text[i++];
              continue;
            }
            if (depth > 0) {
              out += text[i++];
              continue;
            }
            blank(text[i++]);
          }
          blank(text[i++]);
          continue;
        }
        out += c;
        i += 1;
      }
      return out;
    };

    /*
     * Find `anchor {` and return the brace-matched block's contents, scanned on the
     * code-only text so strings/comments cannot unbalance the depth.
     */
    const blockAfter = (code: string, anchor: string): string => {
      const start = code.indexOf(anchor);
      if (start < 0) throw new Error(`anchor not found: ${anchor}`);
      if (code.indexOf(anchor, start + 1) >= 0)
        throw new Error(`anchor is ambiguous: ${anchor}`);
      const open = code.indexOf("{", start + anchor.length);
      if (open < 0) throw new Error(`no block follows anchor: ${anchor}`);
      let depth = 0;
      for (let i = open; i < code.length; i++) {
        if (code[i] === "{") depth += 1;
        else if (code[i] === "}") {
          depth -= 1;
          if (depth === 0) return code.slice(open + 1, i);
        }
      }
      throw new Error(`unbalanced block after anchor: ${anchor}`);
    };

    const code = codeOnly(source.slice(anchorAt));
    const gateBody = blockAfter(code, anchor);

    // ONE payer decision: the gate resolves the binding exactly once and reads the
    // request binding exactly once. A gate that resolved twice would have two chances
    // to switch accounts between them.
    expect(gateBody.match(/resolveConsumptionPayerBinding\(/g)).toHaveLength(1);
    expect(gateBody.match(/currentPayerBinding\(\)/g)).toHaveLength(1);

    // ONE hold attempt: `reserveCredits` is called exactly once in the whole gate. The
    // AC13-forbidden shape is "insufficient → reserve again on another account" — a second
    // call site is that shape, whatever key it names.
    expect(gateBody.match(/\.reserveCredits\(/g)).toHaveLength(1);

    // Excise the single resolve wiring (from the call's opening paren to its match),
    // because that wiring is the ONE legitimate place `billing.deploymentPayerBinding`
    // may appear — it is the explicit boot-time default the seam receives, BEFORE any
    // hold is attempted. Everything else the gate does must name the payer only through
    // the `payerBinding` the seam returned.
    const resolveAt = gateBody.indexOf("resolveConsumptionPayerBinding(");
    let depth = 0;
    let resolveEnd = -1;
    for (
      let i = resolveAt + "resolveConsumptionPayerBinding".length;
      i < gateBody.length;
      i++
    ) {
      if (gateBody[i] === "(") depth += 1;
      else if (gateBody[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          resolveEnd = i;
          break;
        }
      }
    }
    if (resolveEnd < 0)
      throw new Error("unbalanced resolveConsumptionPayerBinding call");
    const gateOutsideResolve =
      gateBody.slice(0, resolveAt) + gateBody.slice(resolveEnd + 1);

    /*
     * Tier 1 — identifiers that have NO legitimate occurrence anywhere in the gate
     * body: `externalCustomerKey` (the deployment key the billing service holds — the
     * same key `deploymentExternalCustomerId` derives, and the one the M6 fallback
     * reached for through `billing.`), the derivation itself, and every constructor or
     * restorer of a payer identity from the payer layer. Word boundaries match after a
     * dot on purpose: `billing.externalCustomerKey` is the shape the blind spot had.
     *
     * Tier 2 — `deploymentPayerBinding`, whose single legitimate appearance is inside
     * the excised resolve wiring; anywhere else in the gate it is a fallback holding
     * the deployment account ready.
     *
     * If a future change genuinely needs one of these inside the gate, that change is
     * a new payer decision inside the consumption entry and must widen this list
     * deliberately, with the spec's no-fallback ruling answered first.
     */
    const neverInGate = [
      "externalCustomerKey",
      "deploymentExternalCustomerId",
      "payerKey",
      "bindPayer",
      "restorePayerBinding",
      "readPayerAccountForKey",
      "createPayerAccount",
    ];
    for (const identifier of neverInGate) {
      expect(new RegExp(`\\b${identifier}\\b`).test(gateBody)).toBe(false);
    }
    expect(/\bdeploymentPayerBinding\b/.test(gateOutsideResolve)).toBe(false);

    // The refusal branch is terminal: it logs and throws the billing-owned error, and
    // holds and writes nothing of its own — the mutation this test exists for grew
    // exactly there.
    const refusalAt = gateOutsideResolve.indexOf("if (!reservation.reserved)");
    if (refusalAt < 0) throw new Error("refusal branch not found in gate body");
    const refusalBlock = blockAfter(
      gateOutsideResolve.slice(refusalAt),
      "if (!reservation.reserved)",
    );
    expect(refusalBlock.match(/\.reserveCredits\(/g)).toBe(null);
    expect(refusalBlock).toContain("throw new CreditInsufficientError(");
  });
});
