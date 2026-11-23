import { z } from "zod";
import type { CasdoorBillingProvider } from "./direct-chat-test-credit";
import {
  createBifrostCreditExecutor,
  UnsentBifrostRequest,
} from "./test-credit-bifrost";
import type { TestCreditExecutor } from "./test-credit-routes";

const required = z.string().trim().min(1);
const endpoint = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
  );
const provider = z.object({
  TEST_CREDIT_CASDOOR_ISSUER: required.refine(
    (value) => endpoint.safeParse(value).success,
  ),
  TEST_CREDIT_CASDOOR_PROVIDER_ID: required,
});
const settings = z.object({
  TEST_CREDIT_BIFROST_URL: endpoint,
  TEST_CREDIT_BIFROST_TOKEN: required,
  TEST_CREDIT_GATEWAY_REVISION: required,
  TEST_CREDIT_GATEWAY_IMAGE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  TEST_CREDIT_INPUT_METER_URL: endpoint,
  TEST_CREDIT_INPUT_METER_TOKEN: required,
  TEST_CREDIT_METERING_REVISION: required,
});
const proof = z.object({
  gatewayRevision: required,
  meteringRevision: required,
  inputTokenUpperBound: z.number().int().nonnegative(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export function directChatCasdoorProvider(
  environment: Record<string, string | undefined>,
): CasdoorBillingProvider | undefined {
  const mode = environment.OPENBOT_TEST_CREDIT_CONVERSATIONS?.trim();
  if (!mode || mode === "disabled") return undefined;
  if (mode !== "enabled")
    throw new Error("Invalid OPENBOT_TEST_CREDIT_CONVERSATIONS mode.");
  const parsed = provider.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      "Test Credit Conversations require a Casdoor issuer and provider ID.",
    );
  return {
    issuer: parsed.data.TEST_CREDIT_CASDOOR_ISSUER,
    providerId: parsed.data.TEST_CREDIT_CASDOOR_PROVIDER_ID,
  };
}

export function loadDirectChatTestCredit(
  environment: Record<string, string | undefined>,
):
  | { casdoor: CasdoorBillingProvider; execute: TestCreditExecutor }
  | undefined {
  const casdoor = directChatCasdoorProvider(environment);
  if (!casdoor) return undefined;
  const parsed = settings.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid Test Credit Conversation settings: ${parsed.error.issues.map(({ path }) => path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  const execute = createBifrostCreditExecutor({
    endpoint: config.TEST_CREDIT_BIFROST_URL,
    gatewayRevision: config.TEST_CREDIT_GATEWAY_REVISION,
    gatewayToken: config.TEST_CREDIT_BIFROST_TOKEN,
    meteringRevision: config.TEST_CREDIT_METERING_REVISION,
    limitField: "max_completion_tokens",
    async countInputTokens(route, _messages, request) {
      const headers = new Headers({
        authorization: `Bearer ${config.TEST_CREDIT_INPUT_METER_TOKEN}`,
        "content-type": "application/json",
        "x-request-id": request.requestId,
        "x-openbot-bifrost-gateway-revision": route.gatewayRevision,
        "x-openbot-bifrost-metering-revision": route.meteringRevision,
      });
      if (request.operationId)
        headers.set("x-openbot-operation-id", request.operationId);
      const response = await fetch(config.TEST_CREDIT_INPUT_METER_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers,
        body: request.body,
      });
      if (!response.ok) throw new Error("Test Credit input meter unavailable.");
      const measured = proof.parse(await response.json());
      if (
        measured.gatewayRevision !== route.gatewayRevision ||
        measured.meteringRevision !== route.meteringRevision ||
        measured.requestSha256 !== request.digest
      )
        throw new Error(
          "Test Credit input meter returned an invalid request proof.",
        );
      return measured.inputTokenUpperBound;
    },
  });
  return {
    casdoor,
    execute: async (input) => {
      if (
        input.route.verification.report.gatewayImageDigest !==
        config.TEST_CREDIT_GATEWAY_IMAGE_DIGEST
      )
        throw new UnsentBifrostRequest("route_unavailable");
      return execute(input);
    },
  };
}
