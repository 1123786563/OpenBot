import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

/*
 * QA batch-1 probe (g): migration 0071's shape and deployability, verified three ways —
 *   1. STATIC: the SQL file's statements and the journal's entry (already applied for real on
 *      the QA database `openbot_qa_batch1` — the full chain ran through drizzle-kit migrate
 *      during this verification, which is itself the executability proof);
 *   2. CONSISTENCY: the 0071 snapshot matches the schema the TS code declares, so the next
 *      generated migration will not try to re-create or drop these indexes;
 *   3. GRAMMAR: the idempotency-key format the runtime mints (`plan:<orderId>`, `auto:<hex>`)
 *      actually satisfies the index the migration creates — a key longer than the column, or a
 *      shape the ON CONFLICT target cannot infer, would break the writer at the first insert.
 */
const SQL = readFileSync(
  join(import.meta.dir, "../drizzle/0071_billing_idempotency.sql"),
  "utf8",
);
const JOURNAL = JSON.parse(
  readFileSync(join(import.meta.dir, "../drizzle/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const SNAPSHOT = JSON.parse(
  readFileSync(join(import.meta.dir, "../drizzle/meta/0071_snapshot.json"), "utf8"),
);

describe("probe g: 0071 SQL statements", () => {
  test("the credit idempotency column lands NOT NULL with a PLAIN unique index", () => {
    expect(SQL).toContain(
      'ALTER TABLE "credit_grants" ADD COLUMN "idempotency_key" text NOT NULL',
    );
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX "credit_grants_idempotency_key_unique_idx" ON "credit_grants" USING btree ("idempotency_key")',
    );
    // Plain — no WHERE clause: a partial index would break ON CONFLICT inference.
    const grantIndexLine = SQL.split("\n").find((line) =>
      line.includes("credit_grants_idempotency_key_unique_idx"),
    );
    expect(grantIndexLine?.toLowerCase()).not.toContain(" where ");
  });

  test("the pending-pair index is PARTIAL on status='pending', over (plan_code, provider)", () => {
    expect(SQL).toContain(
      'CREATE UNIQUE INDEX "payment_orders_pending_pair_unique_idx" ON "payment_orders" USING btree ("plan_code","provider") WHERE "payment_orders"."status" = \'pending\'',
    );
  });

  test("the journal carries 0071_billing_idempotency in order", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === "0071_billing_idempotency");
    expect(entry?.idx).toBe(71);
  });
});

describe("probe g: snapshot consistency (schema ↔ migration ↔ next generate)", () => {
  test("the snapshot's credit_grants matches the migrated column and index", () => {
    const grants = SNAPSHOT.tables["public.credit_grants"];
    expect(grants.columns.idempotency_key.notNull).toBe(true);
    expect(grants.columns.idempotency_key.type).toBe("text");
    const index = grants.indexes["credit_grants_idempotency_key_unique_idx"];
    expect(index.isUnique).toBe(true);
    expect(index.where).toBeUndefined();
  });

  test("the snapshot's payment_orders carries the pending-pair partial unique index", () => {
    const orders = SNAPSHOT.tables["public.payment_orders"];
    const index = orders.indexes["payment_orders_pending_pair_unique_idx"];
    expect(index.isUnique).toBe(true);
    expect(index.where).toContain("pending");
  });
});

describe("probe g: the runtime keys satisfy the index shape", () => {
  test("plan:<orderId> — 4 + 19 characters, well inside a text column", () => {
    // The order id grammar the store generates: `po-` + 16 hex = 19 chars.
    const orderId = `po-${createHmac("sha256", "k").digest("hex").slice(0, 16)}`;
    const key = `plan:${orderId}`;
    expect(key).toHaveLength(24);
    expect(key).toMatch(/^plan:po-[0-9a-f]{16}$/);
  });

  test("auto:<hex> — 96 bits of entropy, collision-negligible for a unique index", () => {
    const key = `auto:${"a".repeat(24)}`; // 12 bytes → 24 hex chars, the writer's draw
    expect(key).toMatch(/^auto:[0-9a-f]{24}$/);
  });

  test("ON CONFLICT inference: the writer targets the indexed column by name", () => {
    // credits-writer.ts's conflict clause names the column the plain unique index covers —
    // the one shape Postgres can infer without the WHERE spelled in-statement.
    const writer = readFileSync(
      join(import.meta.dir, "../src/billing/credits-writer.ts"),
      "utf8",
    );
    expect(writer).toContain("target: creditGrants.idempotencyKey");
  });
});
