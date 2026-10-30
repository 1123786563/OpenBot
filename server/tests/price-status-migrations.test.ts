import { expect, test } from "../../tests/support/e2e-compat";
import { readFile } from "node:fs/promises";
import { WIRE_PRICED_DIMENSIONS } from "../src/gateway/price-snapshot";

const migrations = new URL("../drizzle/", import.meta.url);

function expectDerivedStatusBackfill(source: string) {
  const disabled = source.indexOf(
    'ALTER TABLE "gateway_price_snapshots" DISABLE TRIGGER "gateway_price_snapshots_append_only"',
  );
  const update = source.indexOf('UPDATE "gateway_price_snapshots"');
  const statement = source.lastIndexOf("--> statement-breakpoint", update);
  const enabled = source.indexOf(
    'ALTER TABLE "gateway_price_snapshots" ENABLE TRIGGER "gateway_price_snapshots_append_only"',
  );
  const backfill = source.slice(statement, enabled);

  expect(disabled).toBeGreaterThanOrEqual(0);
  expect(statement).toBeGreaterThan(disabled);
  expect(disabled).toBeLessThan(update);
  expect(update).toBeGreaterThan(disabled);
  expect(enabled).toBeGreaterThan(update);
  for (const column of [
    "price_status",
    "price_status_reason",
    "price_status_missing_dims",
  ]) {
    expect(backfill).toContain(`"${column}" =`);
  }
  for (const dimension of WIRE_PRICED_DIMENSIONS) {
    expect(backfill).toContain(`'${dimension}'`);
  }
  expect(backfill).toContain("price_dim_unreadable");
  expect(backfill).toContain("price_status_dims_unreadable");
  expect(backfill).toContain("price_status_dims_missing");
  expect(backfill).toContain("WITH ORDINALITY");
}

test("0134 backfills all price status columns inside its append-only exception", async () => {
  const source = await readFile(
    new URL("0134_price_status_classification.sql", migrations),
    "utf8",
  );
  expectDerivedStatusBackfill(source);
});

test("0218 reapplies the derived backfill for databases that already ran 0134", async () => {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  expect(
    journal.entries.find((entry) => entry.idx === 218),
  ).toMatchObject({
    idx: 218,
    tag: "0218_price_status_backfill_repair",
  });

  const source = await readFile(
    new URL("0218_price_status_backfill_repair.sql", migrations),
    "utf8",
  );
  expectDerivedStatusBackfill(source);
});
