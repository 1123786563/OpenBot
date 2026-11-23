import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";

import {
  type CoordinationToolSpec,
  type CreditToolMessage,
  readProviderCoordinationCalls,
} from "./coordination-model-call";

type Route = Pick<
  ReleasedBifrostRoute,
  | "gatewayRevision"
  | "meteringRevision"
  | "provider"
  | "model"
  | "maxInputTokens"
  | "maxOutputTokens"
> &
  Partial<Pick<ReleasedBifrostRoute, "tools">>;
export function bifrostRouteProof(route: ReleasedBifrostRoute) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.revision,
        route.provider,
        route.model,
        route.gatewayRevision,
        route.meteringRevision,
        route.verification.report.gatewayImageDigest,
      ]),
    )
    .digest("hex");
}

type Messages = readonly (
  | { role: "system" | "user" | "assistant"; content: string }
  | CreditToolMessage
)[];

const tokens = z.number().int().nonnegative();
const completion = z.object({
  choices: z.unknown(),
  usage: z.object({ prompt_tokens: tokens, completion_tokens: tokens }),
});

const completionText = z.tuple([
  z.object({ message: z.object({ content: z.string().trim().min(1) }) }),
]);

const toolResponse = z.tuple([
  z.object({
    finish_reason: z.literal("tool_calls"),
    message: z.object({
      tool_calls: readProviderCoordinationCalls,
    }),
  }),
]);

export class UnsentBifrostRequest extends Error {
  constructor(readonly reason: "route_unavailable" | "execution_limit") {
    super(reason);
  }
}

export function createBifrostCreditExecutor({
  endpoint,
  gatewayRevision,
  meteringRevision,
  gatewayToken,
  countInputTokens,
  limitField = "max_tokens",
}: {
  endpoint: URL;
  gatewayRevision: string;
  meteringRevision: string;
  gatewayToken?: string;
  // Use the verified model's chat template and include all provider-side framing.
  countInputTokens(
    route: Route,
    messages: Messages,
    request: {
      body: string;
      digest: string;
      requestId: string;
      operationId?: string;
    },
  ): Promise<number>;
  limitField?: "max_tokens" | "max_completion_tokens";
}) {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error("Invalid Test Credit gateway endpoint.");
  }

  return async ({
    route,
    messages,
    coordinationTools,
    operationId,
    recheckRoute,
    bindGatewayRequest,
    routeProof,
  }: {
    route: Route;
    messages: Messages;
    coordinationTools?: readonly CoordinationToolSpec[];
    operationId?: string;
    recheckRoute?: () => Promise<boolean>;
    bindGatewayRequest?: (request: {
      requestId: string;
      digest: string;
    }) => Promise<boolean>;
    routeProof?: string;
  }) => {
    if (
      route.gatewayRevision !== gatewayRevision ||
      route.meteringRevision !== meteringRevision ||
      (coordinationTools?.length && !route.tools)
    ) {
      throw new UnsentBifrostRequest("route_unavailable");
    }
    const body = JSON.stringify({
      model: `${route.provider}/${route.model}`,
      messages,
      [limitField]: route.maxOutputTokens,
      stream: false,
      ...(coordinationTools?.length
        ? {
            tools: coordinationTools.map((spec) => ({
              type: "function",
              function: spec,
            })),
          }
        : {}),
    });
    const digest = createHash("sha256").update(body).digest("hex");
    const requestId = crypto.randomUUID();
    const counted = tokens.safeParse(
      await countInputTokens(route, messages, {
        body,
        digest,
        requestId,
        operationId,
      }).catch(() => undefined),
    );
    if (!counted.success) throw new UnsentBifrostRequest("route_unavailable");
    if (counted.data > route.maxInputTokens) {
      throw new UnsentBifrostRequest("execution_limit");
    }

    if (recheckRoute && !(await recheckRoute().catch(() => false))) {
      throw new UnsentBifrostRequest("route_unavailable");
    }

    // The isolated gateway deployment for this revision must disable retries, routing fallbacks
    // and request transformations. The adapter sends one explicit provider/model request.
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-bf-lh-openbot-request-sha256": digest,
    });
    if (gatewayToken) headers.set("authorization", `Bearer ${gatewayToken}`);
    if (operationId) {
      headers.set("x-openbot-operation-id", operationId);
      headers.set("x-bf-lh-openbot-operation-id", operationId);
    }
    if (routeProof) headers.set("x-bf-lh-openbot-route-proof", routeProof);
    if (
      bindGatewayRequest &&
      !(await bindGatewayRequest({ requestId, digest }))
    )
      throw new Error("Test Credit gateway dispatch binding unavailable.");

    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(85_000),
      headers,
      body,
    });
    if (!response.ok) throw new Error("Test Credit gateway request failed.");

    const { choices, usage } = completion.parse(await response.json());
    const metered = {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    };
    if (coordinationTools?.length) {
      const response = toolResponse.safeParse(choices);
      if (response.success)
        return { calls: response.data[0].message.tool_calls, usage: metered };
    }
    const text = completionText.safeParse(choices);
    return text.success
      ? { text: text.data[0].message.content, usage: metered }
      : { outcome: "partial" as const, usage: metered };
  };
}
