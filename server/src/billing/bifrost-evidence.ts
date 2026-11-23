import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  providerCoordinationCalls,
  readProviderCoordinationCalls,
} from "./coordination-model-call";
import type { TestCreditLedger } from "./test-credit";
import { bifrostRouteProof } from "./test-credit-bifrost";

const bifrostLogOrigin = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))) &&
      url.href === `${url.origin}/`,
  );

const bearer = z.string().regex(/^[A-Za-z0-9._~-]+$/);
const settings = z.object({
  TEST_CREDIT_BIFROST_LOG_ORIGIN: bifrostLogOrigin,
  TEST_CREDIT_BIFROST_LOG_TOKEN: bearer,
  TEST_CREDIT_GATEWAY_REVISION: z.string().min(1),
  TEST_CREDIT_METERING_REVISION: z.string().min(1),
  TEST_CREDIT_GATEWAY_IMAGE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const tokens = z.number().int().nonnegative();
const logEnvelope = z.object({
  id: z.uuid(),
  object: z.literal("chat_completion"),
  status: z.literal("success"),
  stream: z.literal(false),
  provider: z.string(),
  alias: z.undefined().optional(),
  is_large_payload_request: z.literal(false).optional(),
  is_large_payload_response: z.literal(false).optional(),
  model: z.string(),
  parent_request_id: z.null(),
  number_of_retries: z.literal(0),
  fallback_index: z.literal(0),
  attempt_trail: z
    .array(
      z.object({
        attempt: z.literal(0),
        triggered_rotation: z.literal(false),
        fail_reason: z.undefined().optional(),
        failure_class: z.undefined().optional(),
        status_code: z.undefined().optional(),
      }),
    )
    .max(1)
    .optional(),
  cache_debug: z.undefined().optional(),
  error_details: z.undefined().optional(),
  metadata: z.object({
    "openbot-operation-id": z.string(),
    "openbot-request-sha256": z.string(),
    "openbot-route-proof": z.string(),
  }),
  token_usage: z.object({
    prompt_tokens: tokens,
    completion_tokens: tokens,
    total_tokens: tokens,
  }),
});
const log = z.union([
  logEnvelope.extend({
    stop_reason: z.enum(["stop", "length"]),
    output_message: z.object({
      role: z.literal("assistant"),
      content: z.string().trim().min(1),
    }),
  }),
  logEnvelope.extend({
    stop_reason: z.literal("tool_calls"),
    output_message: z.object({
      role: z.literal("assistant"),
      tool_calls: providerCoordinationCalls,
    }),
  }),
]);

const maxLogBytes = 256 * 1024;

async function readBoundedBifrostLog(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      size += value.byteLength;
      if (size > maxLogBytes) return undefined;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Read-only ingress for an isolated gateway's management listener. */
export function createBifrostLogProxy(
  environment: Record<string, string | undefined>,
) {
  const config = z
    .object({
      BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: bifrostLogOrigin.refine((url) =>
        ["127.0.0.1", "[::1]"].includes(url.hostname),
      ),
      TEST_CREDIT_BIFROST_LOG_TOKEN: bearer,
    })
    .safeParse(environment);
  if (!config.success) throw new Error("Invalid Bifrost log proxy settings.");
  const {
    BIFROST_LOG_PROXY_UPSTREAM_ORIGIN: gateway,
    TEST_CREDIT_BIFROST_LOG_TOKEN: token,
  } = config.data;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = hash(`Bearer ${token}`);

  return async (request: Request) => {
    if (
      !timingSafeEqual(
        expected,
        hash(request.headers.get("authorization") ?? ""),
      )
    )
      return new Response(null, { status: 401 });
    const url = new URL(request.url);
    const id = z.uuid().safeParse(url.pathname.slice("/api/logs/".length));
    if (
      request.method !== "GET" ||
      url.search ||
      !id.success ||
      url.pathname !== `/api/logs/${id.data}`
    )
      return new Response(null, { status: 404 });
    try {
      const response = await fetch(new URL(url.pathname, gateway), {
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return new Response(null, {
          status: response.status === 404 ? 404 : 502,
        });
      }
      const parsed = log.safeParse(await readBoundedBifrostLog(response));
      if (!parsed.success || parsed.data.id !== id.data)
        return new Response(null, { status: 404 });
      return Response.json(parsed.data, {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}

type Candidate = Awaited<
  ReturnType<TestCreditLedger["claimGatewayEvidenceChecks"]>
>[number];

export function loadBifrostEvidenceReader(
  environment: Record<string, string | undefined>,
) {
  if (
    environment.TEST_CREDIT_BIFROST_LOG_ORIGIN === undefined &&
    environment.TEST_CREDIT_BIFROST_LOG_TOKEN === undefined
  )
    return undefined;
  const parsed = settings.safeParse(environment);
  if (!parsed.success)
    throw new Error("Invalid Test Credit Bifrost log reader settings.");
  const config = parsed.data;

  return async ({ operationId, route, requestId, digest }: Candidate) => {
    if (
      route.gatewayRevision !== config.TEST_CREDIT_GATEWAY_REVISION ||
      route.meteringRevision !== config.TEST_CREDIT_METERING_REVISION ||
      route.verification.report.gatewayImageDigest !==
        config.TEST_CREDIT_GATEWAY_IMAGE_DIGEST
    )
      return undefined;
    const response = await fetch(
      new URL(`/api/logs/${requestId}`, config.TEST_CREDIT_BIFROST_LOG_ORIGIN),
      {
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
        headers: {
          authorization: `Bearer ${config.TEST_CREDIT_BIFROST_LOG_TOKEN}`,
        },
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 404) return undefined;
      throw new Error("Test Credit Bifrost log read failed.");
    }
    const parsed = log.safeParse(await readBoundedBifrostLog(response));
    if (!parsed.success) return undefined;
    const entry = parsed.data;
    const {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: total,
    } = entry.token_usage;
    if (
      entry.id !== requestId ||
      entry.provider !== route.provider ||
      entry.model !== route.model ||
      entry.metadata["openbot-operation-id"] !== operationId ||
      entry.metadata["openbot-request-sha256"] !== digest ||
      entry.metadata["openbot-route-proof"] !== bifrostRouteProof(route) ||
      input === 0 ||
      output === 0 ||
      total !== input + output ||
      input > route.maxInputTokens ||
      output > route.maxOutputTokens
    )
      return undefined;

    const evidence = {
      evidenceId: `bifrost:${requestId}`,
      gatewayRequestId: requestId,
      outcome: "completed" as const,
      inputTokens: BigInt(input),
      outputTokens: BigInt(output),
    };
    if (entry.stop_reason === "tool_calls") {
      if (!route.tools) return undefined;
      const calls = readProviderCoordinationCalls.safeParse(
        entry.output_message.tool_calls,
      );
      return calls.success
        ? { ...evidence, resultCalls: calls.data }
        : undefined;
    }
    return { ...evidence, resultText: entry.output_message.content };
  };
}

type ReadEvidence = NonNullable<ReturnType<typeof loadBifrostEvidenceReader>>;

export async function recoverBifrostEvidence(
  ledger: TestCreditLedger,
  read: ReadEvidence,
) {
  const candidates = await ledger.claimGatewayEvidenceChecks();
  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const evidence = await read(candidate);
      if (!evidence) return;
      const { accountId, operationId } = candidate;
      if (await ledger.recordEvidence(accountId, operationId, evidence))
        await ledger.settleRecorded(accountId, operationId);
    }),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Test Credit Bifrost evidence recovery failed.");
}
