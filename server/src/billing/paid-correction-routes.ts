import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { type PaidCreditLedger, PaidLedgerError } from "./paid-ledger";

const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const verifiedCase = z.strictObject({
  accountId: z.uuid(),
  amountMicrocredits: z.string().regex(/^[1-9]\d{0,17}$/),
  reason: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().min(1).max(512),
});
const correction = z.discriminatedUnion("kind", [
  verifiedCase.extend({ kind: z.literal("overcharge_refund"), operationId }),
  verifiedCase.extend({
    kind: z.literal("fault_compensation"),
    operationId: operationId.optional(),
  }),
]);

export function createPaidCorrectionRoutes(
  ledger: PaidCreditLedger,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const api = new Hono<{ Variables: AppVariables }>();
  api.post(
    "/corrections",
    requireUser,
    bodyLimit({ maxSize: 16_384 }),
    async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      context.header("Cache-Control", "no-store");
      const input = correction.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!input.success)
        return context.json(
          {
            error:
              "Provide a verified case reference, reason, and correction amount.",
          },
          400,
        );

      const audit = {
        ...input.data,
        by: context.var.actor.id,
        amountMicrocredits: BigInt(input.data.amountMicrocredits),
      };
      try {
        const row =
          input.data.kind === "overcharge_refund"
            ? await ledger.correctOvercharge({
                ...audit,
                operationId: input.data.operationId,
              })
            : await ledger.applyCompensation(audit);
        return context.json({
          ...row,
          amountMicrocredits: row.amountMicrocredits.toString(),
          availableBeforeMicrocredits:
            row.availableBeforeMicrocredits?.toString() ?? null,
          availableAfterMicrocredits:
            row.availableAfterMicrocredits?.toString() ?? null,
          correctionCreditsMicrocredits:
            row.correctionCreditsMicrocredits?.toString() ?? null,
        });
      } catch (error) {
        if (error instanceof PaidLedgerError) {
          return context.json(
            { error: error.message },
            error.code === "order_unknown" ? 404 : 409,
          );
        }
        throw error;
      }
    },
  );
  return api;
}
