import { z } from "zod";
import { requireBillingCasdoorProvider } from "./direct-chat-test-credit-config";
import { createBifrostEmbeddingExecutor } from "./test-credit-embedding-bifrost";
import type { WeKnoraRuntime } from "./weknora-routes";
import { createWeKnoraWorkExecutor } from "./weknora-work";

const secret = z.string().trim().min(1);
const routeId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const executionBudgetId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const settings = z.object({
  OPENBOT_WEKNORA_ROUTE: routeId.optional(),
  OPENBOT_WEKNORA_CHAT_ROUTE: routeId.optional(),
  OPENBOT_WEKNORA_RERANK_ROUTE: routeId.optional(),
  OPENBOT_WEKNORA_MAINTENANCE_ROUTE: routeId.optional(),
  // Funds periodic maintenance from a confirmed Test Credit budget on the
  // platform Billing Account instead of a person's grant (#110 平台预算).
  TEST_CREDIT_WEKNORA_MAINTENANCE_BUDGET_ID: executionBudgetId.optional(),
  TEST_CREDIT_BIFROST_URL: z.url().optional(),
  TEST_CREDIT_RERANK_BIFROST_URL: z.url().optional(),
  OPENBOT_WEKNORA_SERVICE_TOKEN: secret.min(32),
  TEST_CREDIT_EMBEDDINGS_BIFROST_URL: z.url().optional(),
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
  const shared = {
    gatewayToken: value.TEST_CREDIT_BIFROST_TOKEN,
    meterToken: value.TEST_CREDIT_INPUT_METER_TOKEN,
    gatewayRevision: value.TEST_CREDIT_GATEWAY_REVISION,
    meteringRevision: value.TEST_CREDIT_METERING_REVISION,
  };
  const work: NonNullable<WeKnoraRuntime["work"]> = {};
  for (const [kind, routeId, gateway] of [
    ["chat", value.OPENBOT_WEKNORA_CHAT_ROUTE, value.TEST_CREDIT_BIFROST_URL],
    [
      "rerank",
      value.OPENBOT_WEKNORA_RERANK_ROUTE,
      value.TEST_CREDIT_RERANK_BIFROST_URL,
    ],
    [
      "maintenance",
      value.OPENBOT_WEKNORA_MAINTENANCE_ROUTE,
      value.TEST_CREDIT_BIFROST_URL,
    ],
  ] as const) {
    if (!routeId) continue;
    if (!gateway) throw new Error(`Missing WeKnora ${kind} gateway endpoint.`);
    work[kind] = {
      routeId,
      execute: createWeKnoraWorkExecutor({
        ...shared,
        kind,
        gateway,
        meter: value.TEST_CREDIT_INPUT_METER_URL,
        imageDigest: value.TEST_CREDIT_GATEWAY_IMAGE_DIGEST,
      }),
    };
  }
  const embedding = value.TEST_CREDIT_EMBEDDINGS_BIFROST_URL;
  if (value.OPENBOT_WEKNORA_ROUTE && !embedding)
    throw new Error("Missing WeKnora embeddings gateway endpoint.");
  return {
    casdoor,
    issuer: casdoor.issuer,
    routeId: value.OPENBOT_WEKNORA_ROUTE,
    serviceToken: value.OPENBOT_WEKNORA_SERVICE_TOKEN,
    maintenanceBudgetId: value.TEST_CREDIT_WEKNORA_MAINTENANCE_BUDGET_ID,
    work,
    execute:
      value.OPENBOT_WEKNORA_ROUTE && embedding
        ? createBifrostEmbeddingExecutor({
            ...shared,
            endpoint: new URL(embedding),
            meterEndpoint: new URL(value.TEST_CREDIT_INPUT_METER_URL),
            gatewayImageDigest: value.TEST_CREDIT_GATEWAY_IMAGE_DIGEST,
          })
        : undefined,
  };
}
