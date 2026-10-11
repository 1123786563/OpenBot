import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { PlanModelConfig } from "../../agents/plan-model";
import type { RuntimeModel } from "../../copilot";
import {
  type ModelCredentialSecretReader,
  resolveModelApiKey,
} from "../../credentials";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;

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
      _environment: Record<string, string | undefined>,
    ) {
      return route.model;
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
    createNativeModel(
      route: RuntimeModelRoute,
      apiKey: string,
      environment: Record<string, string | undefined>,
    ): LanguageModelV3 {
      const model: RuntimeModel = route.model;
      if (model.provider === "openai")
        return createOpenAI({
          apiKey,
          ...(environment.OPENAI_BASE_URL?.trim()
            ? { baseURL: environment.OPENAI_BASE_URL.trim() }
            : {}),
        }).chat(model.defaultModel);
      if (model.provider === "anthropic") {
        const base = environment.ANTHROPIC_BASE_URL?.trim().replace(/\/+$/, "");
        return createAnthropic({
          apiKey,
          ...(base
            ? { baseURL: /\/v\d+$/.test(base) ? base : `${base}/v1` }
            : {}),
        })(model.defaultModel);
      }
      throw new Error("UNSUPPORTED_MODEL_PROVIDER");
    },
  };
}

export type RuntimePlanModelConfig = PlanModelConfig;
