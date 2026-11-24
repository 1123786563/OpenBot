import { z } from "zod";
import type { TestCreditLedger } from "../billing/test-credit";

export const routingCreditConfirmation = z.object({
  route: z.string().min(1).max(64),
  priceVersion: z.uuid(),
});

export type RoutingCreditConfirmation = z.infer<
  typeof routingCreditConfirmation
>;

export class RoutingCreditQuoteRequired extends Error {
  constructor(
    readonly quote: NonNullable<Awaited<ReturnType<TestCreditLedger["quote"]>>>,
  ) {
    super("Confirm the Test Credit quote before automatic routing.");
  }
}
