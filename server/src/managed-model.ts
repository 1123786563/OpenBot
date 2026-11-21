import { createHash } from "node:crypto";
import { z } from "zod";

const denial = z.enum([
  "insufficient_credits",
  "execution_limit",
  "not_authorized",
  "route_unavailable",
]);
const denied = z.object({ state: z.literal("denied"), reason: denial });
const reservation = z.discriminatedUnion("state", [
  z.object({ state: z.literal("reserved"), permit: z.string().min(1) }),
  denied,
  z.object({ state: z.literal("existing"), permit: z.uuid().optional() }),
]);
const dispatch = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), text: z.string().trim().min(1) }),
  denied,
  z.object({ state: z.literal("reconciling") }),
  z.object({
    state: z.literal("existing"),
    operation: z
      .object({ resultText: z.string().nullable().optional() })
      .optional(),
  }),
  z.object({ state: z.enum(["settled", "released"]) }),
]);
const reconciliation = z.object({
  state: z.enum(["pending", "settled", "released", "absent"]),
});

type ModelScope = {
  source:
    | "direct-chat"
    | "learning"
    | "hindsight"
    | "routing"
    | "tool-selection"
    | "approval"
    | "admin";
  personId: string;
  runId: string;
  conversationId: string;
  botId: string;
};
export type ModelOperation = {
  scope: ModelScope;
  step: string;
  budget?: { id: string; stepId?: string };
};
type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function operationId({ scope, step, budget }: ModelOperation) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "openbot-model-v1",
        scope.source,
        scope.personId,
        scope.conversationId,
        scope.botId,
        scope.runId,
        step,
        budget?.id ?? null,
        budget?.stepId ?? null,
      ]),
    )
    .digest("hex");
}

export type ManagedModelResult =
  | { state: "completed"; text: string }
  | {
      state:
        | z.infer<typeof denial>
        | "reconciling"
        | "unavailable"
        | "settled"
        | "released";
    };

export function createManagedModel({
  url,
  executionHeaders,
}: {
  url: URL;
  // Supply credentials bound to the verified owner of this persisted execution.
  executionHeaders(operation: ModelOperation): Promise<HeadersInit>;
}) {
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("The managed model entry point requires HTTPS.");

  async function post(
    operation: ModelOperation,
    path: string,
    body: object,
    timeout: number,
  ): Promise<unknown> {
    const headers = new Headers(await executionHeaders(operation));
    headers.set("content-type", "application/json");
    const response = await fetch(new URL(`v1/${path}`, url), {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok)
      throw new Error("Managed model control plane unavailable.");
    return response.json();
  }

  async function reconcile(operation: ModelOperation) {
    return reconciliation.parse(
      await post(
        operation,
        "reconcile",
        { operationId: operationId(operation) },
        5_000,
      ),
    ).state;
  }

  return {
    reconcile,
    async complete(
      input: ModelOperation & {
        rerunOf?: ModelOperation;
        route: string;
        priceVersion: string;
        messages: readonly ModelMessage[];
      },
    ): Promise<ManagedModelResult> {
      const id = operationId(input);
      let admission: z.infer<typeof reservation>;
      try {
        admission = reservation.parse(
          await post(
            input,
            "reserve",
            {
              operationId: id,
              rerunOfOperationId: input.rerunOf && operationId(input.rerunOf),
              route: input.route,
              priceVersion: input.priceVersion,
              ...(input.budget
                ? { budgetId: input.budget.id, stepId: input.budget.stepId }
                : {}),
            },
            5_000,
          ),
        );
      } catch {
        await reconcile(input).catch(() => undefined);
        return { state: "unavailable" };
      }
      if (admission.state === "denied") return { state: admission.reason };
      if (!admission.permit) {
        const state = await reconcile(input).catch(() => undefined);
        return {
          state:
            state === "settled" || state === "released" ? state : "reconciling",
        };
      }

      try {
        const result = dispatch.parse(
          await post(
            input,
            "dispatch",
            {
              operationId: id,
              permit: admission.permit,
              messages: input.messages,
            },
            90_000,
          ),
        );
        if (result.state === "denied") return { state: result.reason };
        if (result.state === "existing") {
          if (result.operation?.resultText)
            return { state: "completed", text: result.operation.resultText };
          const state = await reconcile(input);
          return {
            state:
              state === "settled" || state === "released"
                ? state
                : "reconciling",
          };
        }
        return result;
      } catch {
        return { state: "reconciling" };
      }
    },
  };
}

export type ManagedModel = ReturnType<typeof createManagedModel>;
