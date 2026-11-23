import { z } from "zod";
import { requireBillingCasdoorProvider } from "./direct-chat-test-credit-config";
import { createBifrostEmbeddingExecutor } from "./test-credit-embedding-bifrost";

const secret = z.string().trim().min(1);
const settings = z.object({
  OPENBOT_WEKNORA_ROUTE: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  OPENBOT_WEKNORA_SERVICE_TOKEN: secret.min(32),
  TEST_CREDIT_EMBEDDINGS_BIFROST_URL: z.url(),
  TEST_CREDIT_BIFROST_TOKEN: secret,
  TEST_CREDIT_GATEWAY_REVISION: secret,
  TEST_CREDIT_METERING_REVISION: secret,
  TEST_CREDIT_GATEWAY_IMAGE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  TEST_CREDIT_INPUT_METER_URL: z.url(),
  TEST_CREDIT_INPUT_METER_TOKEN: secret,
});

export function loadWeKnoraBilling(
  environment: Record<string, string | undefined>,
) {
  const mode = environment.OPENBOT_TEST_CREDIT_WEKNORA?.trim();
  if (!mode || mode === "disabled") return undefined;
  if (mode !== "enabled") throw new Error("Invalid Test Credit WeKnora mode.");
  const config = settings.safeParse(environment);
  if (!config.success)
    throw new Error(
      `Invalid Test Credit WeKnora settings: ${config.error.issues.map(({ path }) => path.join(".")).join(", ")}`,
    );
  const value = config.data;
  const casdoor = requireBillingCasdoorProvider(environment);
  return {
    casdoor,
    issuer: casdoor.issuer,
    routeId: value.OPENBOT_WEKNORA_ROUTE,
    serviceToken: value.OPENBOT_WEKNORA_SERVICE_TOKEN,
    execute: createBifrostEmbeddingExecutor({
      endpoint: new URL(value.TEST_CREDIT_EMBEDDINGS_BIFROST_URL),
      meterEndpoint: new URL(value.TEST_CREDIT_INPUT_METER_URL),
      gatewayToken: value.TEST_CREDIT_BIFROST_TOKEN,
      meterToken: value.TEST_CREDIT_INPUT_METER_TOKEN,
      gatewayRevision: value.TEST_CREDIT_GATEWAY_REVISION,
      meteringRevision: value.TEST_CREDIT_METERING_REVISION,
      gatewayImageDigest: value.TEST_CREDIT_GATEWAY_IMAGE_DIGEST,
    }),
  };
}
