import { z } from "zod";
import {
  createBifrostCreditExecutor,
  UnsentBifrostRequest,
} from "../billing/test-credit-bifrost";

import type { TestCreditExecutor } from "../billing/test-credit-routes";

const setting = z.string().trim().min(1);
const settings = z.object({
  OPENBOT_TEST_CREDIT_CONVERSATIONS: z.literal("enabled"),
  TEST_CREDIT_BIFROST_URL: z.url(),
  TEST_CREDIT_BIFROST_TOKEN: setting,
  TEST_CREDIT_GATEWAY_REVISION: setting,
  TEST_CREDIT_GATEWAY_IMAGE_DIGEST: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  TEST_CREDIT_INPUT_METER_URL: z.url(),
  TEST_CREDIT_INPUT_METER_TOKEN: setting,
  TEST_CREDIT_METERING_REVISION: setting,
});

const measurement = z.object({
  gatewayRevision: setting,
  meteringRevision: setting,
  inputTokenUpperBound: z.number().int().nonnegative(),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export function loadPersonalTestCreditExecutor(
  environment: Record<string, string | undefined>,
  { allowLoopbackHttp = false } = {},
) {
  const mode = environment.OPENBOT_TEST_CREDIT_CONVERSATIONS;
  if (mode === undefined || mode === "" || mode === "disabled")
    return undefined;
  const parsed = settings.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid Test Credit Conversation configuration: ${parsed.error.issues.map(({ path }) => path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  const endpoint = (
    name: "TEST_CREDIT_BIFROST_URL" | "TEST_CREDIT_INPUT_METER_URL",
  ) => {
    const url = new URL(config[name]);
    const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (
      (url.protocol !== "https:" && !(allowLoopbackHttp && loopback)) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(`Invalid endpoint for ${name}.`);
    return url;
  };
  const meter = endpoint("TEST_CREDIT_INPUT_METER_URL");
  const execute = createBifrostCreditExecutor({
    endpoint: endpoint("TEST_CREDIT_BIFROST_URL"),
    gatewayRevision: config.TEST_CREDIT_GATEWAY_REVISION,
    gatewayToken: config.TEST_CREDIT_BIFROST_TOKEN,
    meteringRevision: config.TEST_CREDIT_METERING_REVISION,
    async countInputTokens(
      { gatewayRevision, meteringRevision },
      { body, digest, requestId, operationId },
      signal,
    ) {
      const timeout = AbortSignal.timeout(5_000);
      const headers = new Headers({
        authorization: `Bearer ${config.TEST_CREDIT_INPUT_METER_TOKEN}`,
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-openbot-bifrost-gateway-revision": gatewayRevision,
        "x-openbot-bifrost-metering-revision": meteringRevision,
      });
      if (operationId) headers.set("x-openbot-operation-id", operationId);
      const response = await fetch(meter, {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers,
        body,
      });
      if (!response.ok) throw new Error("Test Credit input meter unavailable.");
      const measured = measurement.parse(await response.json());
      if (
        measured.gatewayRevision !== gatewayRevision ||
        measured.meteringRevision !== meteringRevision ||
        measured.requestSha256 !== digest
      )
        throw new Error(
          "Test Credit input meter returned an invalid request proof.",
        );
      return measured.inputTokenUpperBound;
    },
  });
  return (input: Parameters<TestCreditExecutor>[0]) => {
    if (
      input.route.verification.report.gatewayImageDigest !==
      config.TEST_CREDIT_GATEWAY_IMAGE_DIGEST
    )
      throw new UnsentBifrostRequest("route_unavailable");
    return execute(input);
  };
}
