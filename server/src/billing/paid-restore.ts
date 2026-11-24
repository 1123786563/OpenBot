import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  billingRestore,
  paidOrders,
  paidProducts,
  testCreditAccounts,
} from "../db/schema";
import { PaidLedgerError } from "./paid-ledger-error";

type PaidTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createPaidRestore(database: Database, now: () => Date) {
  // ── Restore from backup (#108) ───────────────────────────────────────

  /**
   * Restore mode: from a restore from backup until each account has been
   * reconciled and resumed on its own, new charges and entitlement grants
   * stay paused for the accounts still held. Calling it again while a restore
   * is under way keeps the earlier start, so accounts already reconciled
   * stay resumed.
   */
  async function beginRestore(by: string) {
    const [row] = await database
      .insert(billingRestore)
      .values({ id: "ledger", restoringSince: now(), updatedBy: by })
      .onConflictDoUpdate({
        target: billingRestore.id,
        set: {
          restoringSince: sql`coalesce(${billingRestore.restoringSince}, excluded.restoring_since)`,
          updatedBy: by,
          updatedAt: now(),
        },
      })
      .returning({ since: billingRestore.restoringSince });
    return row?.since ?? null;
  }

  /**
   * Puts back an order the backup predates, by the ID the channel knows it
   * by (#108 按原 ID…重建), so its payment can then be verified as any
   * other. Only while a restore is under way, and only once.
   */
  async function restoreOrder(input: {
    id: string;
    accountId: string;
    productCode: string;
    // What the channel's record says the order was placed for.
    priceCents: number;
    channel: "wechat" | "alipay";
  }) {
    return database.transaction(async (tx) => {
      const restoring = await restoreInProgress(tx);
      if (!restoring)
        throw new PaidLedgerError(
          "not_restoring",
          "The ledger is not being restored.",
        );
      const [product] = await tx
        .select({ version: paidProducts.version })
        .from(paidProducts)
        .where(eq(paidProducts.code, input.productCode));
      if (!product)
        throw new PaidLedgerError("product_unavailable", "Unknown product.");
      return (
        await tx
          .insert(paidOrders)
          .values({
            id: input.id,
            accountId: input.accountId,
            productCode: input.productCode,
            productVersion: product.version,
            priceCents: input.priceCents,
            channel: input.channel,
          })
          .onConflictDoNothing()
          .returning()
      )[0];
    });
  }

  /**
   * An account whose records were reconciled against the channel and the
   * trusted usage evidence resumes on its own. One with an unresolved
   * difference is simply not resumed, and stays paused.
   */
  async function resumeAccount(accountId: string) {
    const [restore] = await database
      .select({ since: billingRestore.restoringSince })
      .from(billingRestore)
      .where(eq(billingRestore.id, "ledger"));
    if (!restore?.since) return undefined;
    const [account] = await database
      .update(testCreditAccounts)
      .set({ reconciledAt: now() })
      .where(eq(testCreditAccounts.id, accountId))
      .returning({ reconciledAt: testCreditAccounts.reconciledAt });
    return account?.reconciledAt;
  }

  async function endRestore() {
    await database
      .update(billingRestore)
      .set({ restoringSince: null, updatedBy: null, updatedAt: now() })
      .where(eq(billingRestore.id, "ledger"));
  }

  return { beginRestore, restoreOrder, resumeAccount, endRestore };
}

async function restoreInProgress(tx: PaidTx) {
  const [restore] = await tx
    .select({ since: billingRestore.restoringSince })
    .from(billingRestore)
    .where(eq(billingRestore.id, "ledger"));
  return restore?.since;
}

export async function restoreHolds(tx: PaidTx, accountId: string) {
  const since = await restoreInProgress(tx);
  if (!since) return false;
  const [account] = await tx
    .select({ reconciledAt: testCreditAccounts.reconciledAt })
    .from(testCreditAccounts)
    .where(eq(testCreditAccounts.id, accountId));
  return !(account?.reconciledAt && account.reconciledAt >= since);
}
