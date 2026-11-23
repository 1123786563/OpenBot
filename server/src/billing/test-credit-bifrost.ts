import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";

type Route = Pick<
  ReleasedBifrostRoute,
  | "gatewayRevision"
  | "meteringRevision"
  | "provider"
  | "model"
  | "maxInputTokens"
  | "maxOutputTokens"
>;
type Messages = readonly {
  role: "system" | "user" | "assistant";
  content: string;
}[];

const tokens = z.number().int().nonnegative();
const completion = z.object({
  choices: z.unknown(),
  usage: z.object({ prompt_tokens: tokens, completion_tokens: tokens }),
});

const completionText = z.tuple([
  z.object({ message: z.object({ content: z.string().trim().min(1) }) }),
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
    operationId,
    recheckRoute,
  }: {
    route: Route;
    messages: Messages;
    operationId?: string;
    recheckRoute?: () => Promise<boolean>;
  }) => {
    if (
      route.gatewayRevision !== gatewayRevision ||
      route.meteringRevision !== meteringRevision
    ) {
      throw new UnsentBifrostRequest("route_unavailable");
    }
    const body = JSON.stringify({
      model: `${route.provider}/${route.model}`,
      messages,
      [limitField]: route.maxOutputTokens,
      stream: false,
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
    const text = completionText.safeParse(choices);
    return text.success
      ? { text: text.data[0].message.content, usage: metered }
      : { outcome: "partial" as const, usage: metered };
  };
}
