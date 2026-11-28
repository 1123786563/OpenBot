import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { type PaidCreditLedger, PaidLedgerError } from "./paid-ledger";

const receipt = z.object({
  invoiceId: z.string(),
  paymentId: z.string(),
  channel: z.enum(["alipay", "wechat"]),
  amountCents: z.number().int().positive(),
  state: z.enum(["confirmed", "failed", "unknown"]),
});

export function createFlexpricePackRefundRoutes(
  paid: PaidCreditLedger,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  settings: { baseUrl: string; apiKey: string; environmentId?: string },
) {
  const api = new Hono<{ Variables: AppVariables }>();
  const origin = new URL(settings.baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error("Flexprice URL must be an HTTP origin.");

  const path = "/accounts/:accountId/credit-pack-orders/:orderId/refund";
  for (const action of ["approve", "verify"]) {
    api.post(`${path}/${action}`, requireUser, async (context) => {
      const denied = requireAdmin(context);
      if (denied) return denied;
      context.header("Cache-Control", "no-store");
      const scope = z
        .object({ accountId: z.uuid(), orderId: z.uuid() })
        .safeParse(context.req.param());
      if (!scope.success)
        return context.json(
          { error: "Invalid billing account or order." },
          400,
        );
      try {
        if (action === "approve") {
          const refund = await paid.approveFlexpricePackRefund({
            ...scope.data,
            by: context.var.actor.id,
          });
          if (refund.state !== "requested")
            return context.json({
              refundId: refund.id,
              state: refund.state,
              reason: refund.reason,
            });
        }
        const dispatch = await paid.flexpricePackRefundDispatch(scope.data);
        if (!dispatch)
          return context.json(
            { error: "Unknown original-channel refund." },
            404,
          );
        const { refundId, invoiceId, paymentId, channel, amountCents, state } =
          dispatch;
        if (state !== "requested") return context.json({ refundId, state });

        const observed = await readOriginalRefund({
          invoiceId,
          paymentId,
          submit: action === "approve",
        }).catch(() => undefined);
        if (
          !observed ||
          observed.state === "unknown" ||
          observed.invoiceId !== invoiceId ||
          observed.paymentId !== paymentId ||
          observed.channel !== channel ||
          observed.amountCents !== amountCents
        )
          return context.json({ refundId, state: "unknown" }, 202);
        const settled = await paid.applyFlexpricePackRefund({
          ...scope.data,
          ...observed,
          refundId,
          state: observed.state,
        });
        return context.json({ refundId, state: settled.state });
      } catch (error) {
        if (error instanceof PaidLedgerError)
          return context.json(
            { code: error.code, error: error.message },
            error.code === "order_unknown" ? 404 : 409,
          );
        throw error;
      }
    });
  }
  return api;

  async function readOriginalRefund({
    invoiceId,
    paymentId,
    submit,
  }: {
    invoiceId: string;
    paymentId: string;
    submit: boolean;
  }) {
    const response = await fetch(
      `${origin.origin}/v1/invoices/${encodeURIComponent(invoiceId)}/payments/${encodeURIComponent(paymentId)}/original-refund`,
      {
        method: submit ? "POST" : "GET",
        headers: {
          "x-api-key": settings.apiKey,
          ...(settings.environmentId
            ? { "x-environment-id": settings.environmentId }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return receipt.parse(await response.json());
  }
}
