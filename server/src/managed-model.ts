import { createHash } from "node:crypto";
import { z } from "zod";

const denial = z.enum([
  "insufficient_credits",
  "execution_limit",
  "not_authorized",
  "route_unavailable",
  "pilot_closed",
  "unavailable",
]);
const denied = z.object({ state: z.literal("denied"), reason: denial });
const reservation = z.discriminatedUnion("state", [
  z.object({ state: z.literal("reserved"), permit: z.string().min(1) }),
  denied,
  z.object({
    state: z.literal("existing"),
    permit: z.string().min(1).optional(),
  }),
]);
const dispatch = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), text: z.string().trim().min(1) }),
  denied,
  z.object({ state: z.literal("reconciling") }),
  z.object({ state: z.enum(["settled", "released"]) }),
  z.object({ state: z.literal("existing") }),
]);
const publication = z.object({
  route: z.string().min(1),
  priceVersion: z.uuid(),
});
const operationReceipt = z.object({
  operationId: z.string(),
  state: z.enum(["settled", "released"]),
  outcome: z.string().nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
  resultText: z.string().nullable(),
});
const settlement = z.enum(["pending", "settled", "released", "absent"]);
const reconciliation = z.union([
  z.object({
    state: z.literal("settled"),
    outcome: z.literal("executed"),
    text: z.string().trim().min(1),
  }),
  z.object({
    state: z.enum(["released", "absent"]),
    outcome: z.literal("not_dispatched"),
  }),
  z.object({
    state: settlement,
    outcome: z.undefined().optional(),
    operation: z.unknown().optional(),
  }),
]);

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
      state: z.infer<typeof denial> | "reconciling" | "settled" | "released";
    };

export function createManagedModel({
  url,
  credentials,
}: {
  url: URL;
  credentials: ReadonlyMap<string, string>;
}) {
  const credentialsByPerson = new Map(credentials);

  async function post(
    token: string,
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

  async function readPriceVersion(token: string) {
    const response = await fetch(new URL("v1/quote", url), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Managed model quote unavailable.");
    // The quote describes the default route. Its Price Version covers the
    // publication, and reserve checks the configured route against it.
    return publication.parse(await response.json()).priceVersion;
  }

  async function reconcileOutcome(operation: ModelOperation) {
    const token = credentialsByPerson.get(operation.scope.personId);
    if (!token) throw new Error("Managed model execution identity required.");
    const id = operationId(operation);
    const result = reconciliation.parse(
      await post(token, "reconcile", { operationId: id }, 5_000),
    );
    if (!("operation" in result)) return result;
    const receipt = operationReceipt.safeParse(result.operation);
    if (
      receipt.success &&
      receipt.data.operationId === id &&
      receipt.data.state === result.state
    ) {
      const { state, outcome, dispatchedAt, resultText } = receipt.data;
      const text = resultText?.trim();
      if (
        state === "settled" &&
        outcome === "completed" &&
        dispatchedAt &&
        text
      )
        return { state, outcome: "executed" as const, text };
      if (state === "released" && outcome === null && dispatchedAt === null)
        return { state, outcome: "not_dispatched" as const };
    }
    return { state: result.state, outcome: undefined };
  }

  async function reconcile(operation: ModelOperation) {
    return (await reconcileOutcome(operation)).state;
  }

  return {
    reconcile,
    reconcileOutcome,
    async complete(
      input: ModelOperation & {
        route: string;
        messages: readonly ModelMessage[];
        beforeDispatch?: () => Promise<boolean | readonly ModelMessage[]>;
      },
    ): Promise<ManagedModelResult> {
      const token = credentialsByPerson.get(input.scope.personId);
      if (!token) return { state: "not_authorized" };
      const id = operationId(input);
      let priceVersion: string;
      try {
        priceVersion = await readPriceVersion(token);
      } catch {
        return { state: "unavailable" };
      }

      let admission: z.infer<typeof reservation>;
      try {
        admission = reservation.parse(
          await post(
            token,
            "reserve",
            {
              operationId: id,
              applicationId: "openbot",
              creditType: "test",
              route: input.route,
              priceVersion,
              resumable: false,
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
        const prepared = await input.beforeDispatch?.();
        if (prepared === false) return { state: "not_authorized" };
        const messages =
          prepared === undefined || prepared === true
            ? input.messages
            : prepared;
        const result = dispatch.parse(
          await post(
            token,
            "dispatch",
            {
              operationId: id,
              permit: admission.permit,
              messages,
            },
            90_000,
          ),
        );
        if (result.state === "denied") return { state: result.reason };
        if (result.state === "existing") {
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
      } finally {
        // The authoritative ledger also reconciles orphaned operations after a process crash.
        await reconcile(input).catch(() => undefined);
      }
    },
  };
}

export type ManagedModel = ReturnType<typeof createManagedModel>;
