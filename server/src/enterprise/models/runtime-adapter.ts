import type { PlanModelConfig } from "../../agents/plan-model";
import type { RuntimeModel } from "../../copilot";
import { runtimeModelForEnvironment } from "../../copilot";
import {
  type ModelCredentialSecretReader,
  resolveModelApiKey,
} from "../../credentials";

/** Platform-selected route facts. These values never come from the model request body. */
export type RuntimeModelRoute = {
  model: RuntimeModel;
  credentialSecretRef: string;
  planBotId?: string;
};

export function createRuntimeModelAdapter(input: {
  encryptionKey: string;
  reader: ModelCredentialSecretReader;
  selectModel(routeRef: string): Promise<RuntimeModelRoute | null>;
}) {
  return {
    selectModel: input.selectModel,
    runtimeModel(
      route: RuntimeModelRoute,
      environment: Record<string, string | undefined>,
    ) {
      return runtimeModelForEnvironment(route.model, environment);
    },
    async resolveApiKey(
      route: RuntimeModelRoute,
      provider: "openai" | "anthropic",
      environment: Record<string, string | undefined>,
    ) {
      return resolveModelApiKey({
        encryptionKey: input.encryptionKey,
        reader: input.reader,
        provider,
        keyId: route.credentialSecretRef,
        environment,
      });
    },
  };
}

export type RuntimePlanModelConfig = PlanModelConfig;
