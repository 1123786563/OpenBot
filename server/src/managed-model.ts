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

type ModelScope = {
  source: "direct-chat" | "learning" | "hindsight";
  personId: string;
  runId: string;
  conversationId: string;
  botId: string;
};
type ModelOperation = { scope: ModelScope; step: string };
type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

function operationId({ scope, step }: ModelOperation) {
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
  async function post(
    path: string,
    body: object,
    timeout: number,
  ): Promise<unknown> {
    const response = await fetch(new URL(`v1/${path}`, url), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok)
      throw new Error("Managed model control plane unavailable.");
    return response.json();
  }

  async function reconcile(operation: ModelOperation) {
    return reconciliation.parse(
      await post("reconcile", { operationId: operationId(operation) }, 5_000),
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
      const id = operationId(input);
      let admission: z.infer<typeof reservation>;
      try {
        admission = reservation.parse(
          await post(
            "reserve",
            {
              operationId: id,
              application: "openbot",
              creditType: "test",
              scope: input.scope,
              step: input.step,
              route: input.route,
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
