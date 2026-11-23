import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReleasedBifrostRoute } from "../admin/bifrost-catalog";
import { bifrostRouteProof, UnsentBifrostRequest } from "./test-credit-bifrost";

const tokens = z.number().int().nonnegative();
const messages = z
  .array(
    z.strictObject({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string().min(1),
    }),
  )
  .min(1)
  .max(100);

export const workInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat"), messages }),
  z.strictObject({ kind: z.literal("maintenance"), messages }),
  z.strictObject({
    kind: z.literal("rerank"),
    query: z.string().min(1),
    documents: z.array(z.string().min(1)).min(1).max(100),
  }),
]);

type WorkInput = z.infer<typeof workInput>;
export const workResult = z.union([
  z.strictObject({ text: z.string().trim().min(1) }),
  z.strictObject({
    scores: z
      .array(
        z.object({
          index: tokens,
          relevance_score: z.number(),
        }),
      )
      .min(1),
  }),
]);

function endpoint(value: string, suffix?: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (suffix && !url.pathname.endsWith(suffix))
  )
    throw new Error("Invalid WeKnora model endpoint.");
  return url;
}

export function createWeKnoraWorkExecutor(config: {
  gateway: string;
  meter: string;
  gatewayToken: string;
  meterToken: string;
  imageDigest: string;
  gatewayRevision: string;
  meteringRevision: string;
  kind: WorkInput["kind"];
}) {
  const gateway = endpoint(
    config.gateway,
    config.kind === "rerank" ? "/rerank" : "/chat/completions",
  );
  const meter = endpoint(config.meter);
  return async ({
    route,
    input,
    operationId,
    bind,
  }: {
    route: ReleasedBifrostRoute;
    input: WorkInput;
    operationId: string;
    bind(request: { requestId: string; digest: string }): Promise<boolean>;
  }) => {
    if (
      config.kind !== input.kind ||
      route.verification.report.gatewayImageDigest !== config.imageDigest ||
      route.gatewayRevision !== config.gatewayRevision ||
      route.meteringRevision !== config.meteringRevision
    )
      throw new UnsentBifrostRequest("route_unavailable");
    const model = `${route.provider}/${route.model}`;
    const body = JSON.stringify(
      input.kind === "rerank"
        ? {
            model,
            query: input.query,
            documents: input.documents.map((text) => ({ text })),
          }
        : {
            model,
            messages: input.messages,
            max_completion_tokens: route.maxOutputTokens,
            stream: false,
          },
    );
    const digest = createHash("sha256").update(body).digest("hex");
    const requestId = crypto.randomUUID();
    const headers = {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-openbot-operation-id": operationId,
    };
    const reply = await fetch(meter, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...headers,
        authorization: `Bearer ${config.meterToken}`,
        "x-openbot-bifrost-gateway-revision": route.gatewayRevision,
        "x-openbot-bifrost-metering-revision": route.meteringRevision,
      },
    })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined);
    const proof = z
      .object({
        requestId: z.literal(requestId),
        requestSha256: z.literal(digest),
        gatewayRevision: z.literal(route.gatewayRevision),
        meteringRevision: z.literal(route.meteringRevision),
        inputTokenUpperBound: tokens,
      })
      .safeParse(reply);
    if (!proof.success) throw new UnsentBifrostRequest("route_unavailable");
    if (proof.data.inputTokenUpperBound > route.maxInputTokens)
      throw new UnsentBifrostRequest("execution_limit");
    if (!(await bind({ requestId, digest })))
      throw new UnsentBifrostRequest("route_unavailable");
    const response = await fetch(gateway, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(85000),
      headers: {
        ...headers,
        authorization: `Bearer ${config.gatewayToken}`,
        "x-bf-lh-openbot-request-sha256": digest,
        "x-bf-lh-openbot-operation-id": operationId,
        "x-bf-lh-openbot-route-proof": bifrostRouteProof(route),
      },
    });
    if (!response.ok) throw new Error("WeKnora model gateway failed.");
    const terminal = z
      .object({
        model: z.union([z.literal(model), z.literal(route.model)]),
        usage: z.object({
          prompt_tokens: tokens,
          completion_tokens: tokens.optional(),
        }),
        choices: z
          .array(
            z.object({
              finish_reason: z.string().optional(),
              message: z.object({ content: z.string().nullish() }),
            }),
          )
          .optional(),
        results: z.unknown().optional(),
      })
      .parse(await response.json());
    const inputTokens = terminal.usage.prompt_tokens;
    const outputTokens =
      terminal.usage.completion_tokens ?? (input.kind === "rerank" ? 0 : -1);
    if (
      inputTokens <= 0 ||
      inputTokens > proof.data.inputTokenUpperBound ||
      outputTokens < 0 ||
      outputTokens > route.maxOutputTokens
    )
      throw new Error("WeKnora model terminal usage is invalid.");
    const result = workResult.safeParse(
      input.kind === "rerank"
        ? { scores: terminal.results }
        : {
            text:
              terminal.choices?.[0]?.finish_reason === "stop"
                ? terminal.choices[0].message.content
                : undefined,
          },
    );
    return {
      inputTokens: BigInt(inputTokens),
      outputTokens: BigInt(outputTokens),
      result:
        result.success &&
        (input.kind !== "rerank" ||
          ("scores" in result.data &&
            result.data.scores.length === input.documents.length &&
            new Set(result.data.scores.map(({ index }) => index)).size ===
              input.documents.length &&
            result.data.scores.every(
              ({ index }) => index < input.documents.length,
            )))
          ? result.data
          : undefined,
    };
  };
}
