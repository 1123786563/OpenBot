import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { billingCustomers } from "../db/schema/billing";
import { payerAccounts } from "../db/schema/payer";

export type PayerKind = "personal" | "company" | "legacy_deployment" | "unknown_owner";
export type PayerRef = { kind: PayerKind; id: string };

/**
 * Idempotent account creation: ensure the billing customer row exists, then claim the
 * (kind, external_ref) mapping. Concurrent callers converge on one row because both writes are
 * ON CONFLICT DO NOTHING followed by a re-read — the unique indexes are the authority.
 * Never grants balance; never copies or moves any legacy amounts.
 */
export async function createPayerAccount(
  database: Database,
  ref: PayerRef,
  name?: string | null,
): Promise<{ externalCustomerId: string }> {
  const externalCustomerId = `${ref.kind}:${ref.id}`;
  await database
    .insert(billingCustomers)
    .values({ externalId: externalCustomerId, name: name ?? null })
    .onConflictDoNothing({ target: billingCustomers.externalId });
  await database
    .insert(payerAccounts)
    .values({ id: randomUUID(), payerKind: ref.kind, externalRef: ref.id, externalCustomerId })
    .onConflictDoNothing();
  const [row] = await database
    .select({ externalCustomerId: payerAccounts.externalCustomerId })
    .from(payerAccounts)
    .where(and(eq(payerAccounts.payerKind, ref.kind), eq(payerAccounts.externalRef, ref.id)))
    .limit(1);
  return { externalCustomerId: row.externalCustomerId };
}

export async function payerKey(database: Database, ref: PayerRef): Promise<string | undefined> {
  const [row] = await database
    .select({ externalCustomerId: payerAccounts.externalCustomerId })
    .from(payerAccounts)
    .where(and(eq(payerAccounts.payerKind, ref.kind), eq(payerAccounts.externalRef, ref.id)))
    .limit(1);
  return row?.externalCustomerId;
}
