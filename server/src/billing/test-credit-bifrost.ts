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
}: {
  endpoint: URL;
  gatewayRevision: string;
  meteringRevision: string;
  gatewayToken?: string;
  // Use the verified model's chat template and include all provider-side framing.
  countInputTokens(route: Route, messages: Messages): Promise<number>;
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
  }: {
    route: Route;
    messages: Messages;
    operationId?: string;
  }) => {
    if (
      route.gatewayRevision !== gatewayRevision ||
      route.meteringRevision !== meteringRevision
    ) {
      throw new UnsentBifrostRequest("route_unavailable");
    }
    const counted = tokens.safeParse(
      await countInputTokens(route, messages).catch(() => undefined),
    );
    if (!counted.success) throw new UnsentBifrostRequest("route_unavailable");
    if (counted.data > route.maxInputTokens) {
      throw new UnsentBifrostRequest("execution_limit");
    }

    // The isolated gateway deployment for this revision must disable retries, routing fallbacks
    // and request transformations. The adapter sends one explicit provider/model request.
    const headers = new Headers({ "content-type": "application/json" });
    if (gatewayToken) headers.set("authorization", `Bearer ${gatewayToken}`);
    if (operationId) headers.set("x-openbot-operation-id", operationId);
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(85_000),
      headers,
      body: JSON.stringify({
        model: `${route.provider}/${route.model}`,
        messages,
        max_tokens: route.maxOutputTokens,
        stream: false,
      }),
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
