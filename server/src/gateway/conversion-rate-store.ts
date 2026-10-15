import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { gatewayConversionRates } from "../db/schema/gateway";
import type { ConversionRate } from "./conversion-rate";

export type ConversionRateRecord = ConversionRate & { rateVersion: number; createdBy: string; createdAt: Date };

export async function saveConversionRate(database: Database, rate: ConversionRate, by: string): Promise<ConversionRateRecord> {
  return database.transaction(async (tx) => {
    const [last] = await tx.select().from(gatewayConversionRates).orderBy(desc(gatewayConversionRates.rateVersion)).limit(1);
    const nextVersion = (last?.rateVersion ?? 0) + 1;
    await tx.update(gatewayConversionRates).set({ isCurrent: false }).where(eq(gatewayConversionRates.isCurrent, true));
    const [row] = await tx
      .insert(gatewayConversionRates)
      .values({ rateVersion: nextVersion, numerator: rate.numerator, denominator: rate.denominator, isCurrent: true, createdBy: by })
      .returning();
    return row as ConversionRateRecord;
  });
}

export async function currentConversionRate(database: Database): Promise<ConversionRateRecord | undefined> {
  const [row] = await database.select().from(gatewayConversionRates).where(eq(gatewayConversionRates.isCurrent, true)).limit(1);
  return row as ConversionRateRecord | undefined;
}
