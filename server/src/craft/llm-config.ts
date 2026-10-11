/**
 * The craft LLM selection model — ported from onyx `session/llm_config.py`, reduced to
 * OpenBot's single-gateway shape.
 *
 * onyx resolves a provider row + model from a catalog of configured providers, with a gateway
 * ("onyx") provider wrapping them. OpenBot's craft reaches the model through one OpenAI-
 * compatible endpoint (the Intelligence gateway or a configured proxy), so the selection is a
 * wire id — `<providerId>/<modelName>` — plus the catalog that feeds opencode.json. The
 * re-validation-on-every-use contract (a stored pick may no longer be accessible or visible)
 * is preserved: `parseAgentSelection` decodes, callers re-check against the live catalog.
 */

import type {
  CraftLLMProviderConfig,
  CraftModelDescriptor,
} from "./opencode-config";

/**
 * A gateway model pick: a specific accessible provider + model name. Its `wireId` is the id
 * the gateway routes on.
 */
export type GatewaySelection = {
  providerId: string;
  modelName: string;
};

/** A pre-gateway pick, keyed by provider type (no gateway routing). */
export type LegacySelection = {
  providerType: string;
  modelName: string;
};

/** The OpenBot gateway provider id, standing where onyx used "onyx". */
export const CRAFT_GATEWAY_PROVIDER_ID = "openbot";

export type AgentSelection = GatewaySelection | LegacySelection;

export function selectionWireId(selection: GatewaySelection): string {
  return `${selection.providerId}/${selection.modelName}`;
}

/**
 * Decode the persisted (agentProvider, agentModel) columns. Gateway rows store
 * ("openbot", "<providerId>/<modelName>"); legacy rows store (providerType, modelName). Model
 * names may contain slashes, so the gateway id splits on the FIRST separator only.
 */
export function parseAgentSelection(
  agentProvider: string | null,
  agentModel: string | null,
): AgentSelection | null {
  if (!agentModel) return null;
  if (agentProvider === CRAFT_GATEWAY_PROVIDER_ID) {
    const separatorIndex = agentModel.indexOf("/");
    if (separatorIndex > 0 && separatorIndex < agentModel.length - 1) {
      const providerId = agentModel.slice(0, separatorIndex);
      const modelName = agentModel.slice(separatorIndex + 1);
      if (providerId.length > 0) {
        return { providerId, modelName };
      }
    }
    return null;
  }
  if (agentProvider) {
    return { providerType: agentProvider, modelName: agentModel };
  }
  return null;
}

/** Resolve a persisted selection against the live catalog; null = not (or no longer) usable. */
export function matchingVisibleModel(
  catalog: readonly CraftModelDescriptor[],
  selection: AgentSelection | null,
): CraftModelDescriptor | null {
  if (selection === null) return null;
  const wanted =
    "providerId" in selection
      ? selectionWireId(selection)
      : `${selection.providerType}/${selection.modelName}`;
  // Wire-id match first (gateway rows), then bare model-name match (legacy rows
  // whose catalog carries no provider prefix).
  return (
    catalog.find((model) => model.id === wanted) ??
    catalog.find((model) => model.id === selection.modelName) ??
    null
  );
}

export type BuildGatewayConfigInput = {
  /** The models the deployment exposes to this user, catalog form. */
  catalog: readonly CraftModelDescriptor[];
  /** The session's persisted selection, if any (re-validated, never trusted). */
  selection?: AgentSelection | null;
  /** Admin-configured defaults in priority order (craft default, then chat default). */
  configuredDefaults?: readonly GatewaySelection[];
  apiBase: string;
  apiKey?: string | null;
};

/**
 * Resolve the provider config a session's opencode.json carries: the selection if it still
 * resolves, else the first usable configured default, else the catalog's first entry. Null
 * when nothing is usable — the caller surfaces "no accessible model" rather than guessing.
 */
export function buildGatewayConfig(
  input: BuildGatewayConfigInput,
): CraftLLMProviderConfig | null {
  if (input.catalog.length === 0) return null;

  const resolved =
    matchingVisibleModel(input.catalog, input.selection ?? null) ??
    input.configuredDefaults
      ?.map((fallback) => matchingVisibleModel(input.catalog, fallback))
      .find((match): match is CraftModelDescriptor => match !== null) ??
    input.catalog[0];

  return {
    provider: CRAFT_GATEWAY_PROVIDER_ID,
    modelName: resolved.id,
    apiKey: input.apiKey ?? null,
    apiBase: input.apiBase,
    displayName: "OpenBot",
    models: [...input.catalog],
  };
}
