import { createHash } from "node:crypto";
import { z } from "zod";

const denial = z.enum([
  "insufficient_credits",
  "execution_limit",
  "not_authorized",
  "route_unavailable",
  // The wind-down switch: no new reservation of either Credit type.
  "pilot_closed",
]);
const denied = z.object({ state: z.literal("denied"), reason: denial });
const reservation = z.discriminatedUnion("state", [
  z.object({ state: z.literal("reserved"), permit: z.string().min(1) }),
  denied,
  z.object({ state: z.literal("existing") }),
]);
const dispatch = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), text: z.string().trim().min(1) }),
  denied,
  z.object({ state: z.literal("reconciling") }),
]);
const reconciliation = z.object({
  state: z.enum(["pending", "settled", "released", "absent"]),
});
// What the ledger publishes, for the Price Version a reservation pins.
const publication = z.object({
  route: z.string().min(1),
  priceVersion: z.string().min(1),
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

export function managedModelOperationId({
  scope,
  step,
  budget,
}: ModelOperation) {
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
  token,
}: {
  url: URL;
  token: string;
}) {
  const headers = { authorization: `Bearer ${token}` };

  async function post(
    path: string,
    body: object,
    timeout: number,
  ): Promise<unknown> {
    const response = await fetch(new URL(`v1/${path}`, url), {
      method: "POST",
      redirect: "error",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok)
      throw new Error("Managed model control plane unavailable.");
    return response.json();
  }

  // The Price Version is read here, not configured, so a reservation made
  // after a new publication pins that one and is never refused as stale.
  async function priceVersion() {
    const response = await fetch(new URL("v1/quote", url), {
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok)
      throw new Error("Managed model control plane unavailable.");
    return publication.parse(await response.json()).priceVersion;
  }

  async function reconcile(operation: ModelOperation) {
    return reconciliation.parse(
      await post(
        "reconcile",
        { operationId: managedModelOperationId(operation) },
        5_000,
      ),
    ).state;
  }

  return {
    reconcile,
    async complete(
      input: ModelOperation & {
        route: string;
        messages: readonly ModelMessage[];
      },
    ): Promise<ManagedModelResult> {
      const id = managedModelOperationId(input);
      // Nothing has been asked of the ledger until the publication is read,
      // so a control plane that cannot serve it leaves nothing to reconcile.
      let price: string;
      try {
        price = await priceVersion();
      } catch {
        return { state: "unavailable" };
      }
      let admission: z.infer<typeof reservation>;
      try {
        admission = reservation.parse(
          await post(
            "reserve",
            {
              operationId: id,
              route: input.route,
              priceVersion: price,
              // The trial entry: Test Credit only (#107).
              creditType: "test",
              // The bill names the app this step ran for.
              applicationId: "openbot",
              // Nothing retries a chat turn or an auxiliary call by its
              // operation ID, so a refusal must not wait as a resume point.
              resumable: false,
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
      if (admission.state === "existing") {
        const state = await reconcile(input).catch(() => undefined);
        return {
          state:
            state === "settled" || state === "released" ? state : "reconciling",
        };
      }

      try {
        const result = dispatch.parse(
          await post(
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
        return result;
      } catch {
        return { state: "reconciling" };
      } finally {
        // The authoritative ledger also reconciles orphaned operations after a process crash.
        await reconcile(input).catch(() => undefined);
      }
    },
  };
}

export type ManagedModel = ReturnType<typeof createManagedModel>;
