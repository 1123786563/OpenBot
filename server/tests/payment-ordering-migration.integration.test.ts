import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TransactionSQL } from "bun";
import { createDatabase } from "../src/db/client";
import { testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), { max: 1 }).$client;
// The craft wave renumbered this migration again (0077 -> 0087); keep the pin on the file it tests.
const migration = readFileSync(
  new URL("../drizzle/0087_productive_nextwave.sql", import.meta.url),
  "utf8",
).split("--> statement-breakpoint");

afterAll(() => database.close());

class RollbackFixture extends Error {}

async function withLegacyOrders(
  pendingCount: number,
  check: (transaction: TransactionSQL) => Promise<void>,
) {
  const schema = `payment_upgrade_${randomUUID().replaceAll("-", "")}`;
  try {
    await database.begin(async (transaction) => {
      await transaction.unsafe(`CREATE SCHEMA "${schema}"`);
      await transaction`SELECT set_config('search_path', ${schema}, true)`;
      await transaction`
        CREATE TABLE payment_orders (
          id text PRIMARY KEY,
          plan_code text NOT NULL,
          provider text NOT NULL,
          status text NOT NULL,
          amount_cents integer NOT NULL
        )
      `;
      await transaction`
        CREATE UNIQUE INDEX payment_orders_pending_pair_unique_idx
        ON payment_orders (plan_code, provider) WHERE status = 'pending'
      `;
      for (let index = 0; index < pendingCount; index += 1) {
        await transaction`
          INSERT INTO payment_orders VALUES (
            ${`legacy-${index}`}, ${`plan-${index}`},
            ${index % 2 === 0 ? "alipay" : "wechat"}, 'pending', 8800
          )
        `;
      }
      await check(transaction);
      throw new RollbackFixture();
    });
  } catch (error) {
    if (!(error instanceof RollbackFixture)) throw error;
  } finally {
    const [result] = await database`
      SELECT to_regnamespace(${schema})::text AS remaining_schema
    `;
    expect(result?.remaining_schema).toBeNull();
  }
}

test("legacy competing purchases fail preflight before the first destructive migration statement", async () => {
  await withLegacyOrders(2, async (transaction) => {
    await transaction`SAVEPOINT preflight`;
    await expect(
      Promise.resolve(transaction.unsafe(migration[0]!)),
    ).rejects.toMatchObject({
      errno: "P0001",
      message:
        "Payment purchase migration refused: conflicting legacy pending orders.",
      hint: expect.stringContaining("reconcile"),
    });
    await transaction`ROLLBACK TO SAVEPOINT preflight`;
    const [index] = await transaction`
      SELECT to_regclass('payment_orders_pending_pair_unique_idx')::text AS name
    `;
    expect(index?.name).toBe("payment_orders_pending_pair_unique_idx");
    const columns = await transaction`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'payment_orders'
        AND column_name = 'deployment_scope'
    `;
    expect(columns).toHaveLength(0);
    const orders = await transaction`
      SELECT id, status, amount_cents FROM payment_orders ORDER BY id
    `;
    expect(orders).toEqual([
      { id: "legacy-0", status: "pending", amount_cents: 8800 },
      { id: "legacy-1", status: "pending", amount_cents: 8800 },
    ]);
  });
});

test("a reconciled legacy deployment upgrades and preserves its remaining order snapshot", async () => {
  await withLegacyOrders(1, async (transaction) => {
    for (const statement of migration) {
      await transaction.unsafe(statement);
    }
    const orders = await transaction`
      SELECT id, status, amount_cents, deployment_scope FROM payment_orders
    `;
    expect(orders).toEqual([
      {
        id: "legacy-0",
        status: "pending",
        amount_cents: 8800,
        deployment_scope: "default",
      },
    ]);
    const [indexes] = await transaction`
      SELECT
        to_regclass('payment_orders_pending_pair_unique_idx')::text AS old_index,
        to_regclass('payment_orders_pending_scope_unique_idx')::text AS new_index
    `;
    expect(indexes?.old_index).toBeNull();
    expect(indexes?.new_index).toBe("payment_orders_pending_scope_unique_idx");
  });
});
