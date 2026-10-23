import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { IntelligenceSettings } from "./config";
import { createIntelligenceClient } from "./intelligence-client";

/*
 * ME15 (#487): Intelligence is an OPTIONAL service, not a boot requirement.
 *
 * Before this module, config.ts refused to boot without the full Intelligence
 * contract and index.ts constructed four clients at boot regardless. A
 * deployment that has not configured Intelligence now boots and serves the
 * governed enterprise path — and every remaining Intelligence consumer takes
 * its client from one of the lazy accessors built here, so a client is
 * constructed only when a feature that actually needs one runs.
 *
 * Two honesties hold everywhere:
 *   - a feature that needs Intelligence without it configured refuses BY NAME
 *     (`IntelligenceUnconfiguredError`) — never a silent no-permission
 *     in-memory fallback; and
 *   - a deployment with learning disabled and the governed path serving
 *     constructs ZERO Intelligence clients at import, boot or run.
 */

/** The three settings a client needs, named for refusals and health copy. */
export const INTELLIGENCE_SETTING_NAMES =
  "INTELLIGENCE_API_URL, INTELLIGENCE_GATEWAY_WS_URL, INTELLIGENCE_API_KEY";

/** The enterprise database settings the governed path composes from. */
export const ENTERPRISE_SETTING_NAMES =
  "ENTERPRISE_DIRECTORY_DATABASE_URL, ENTERPRISE_DATA_DATABASE_URL, OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL";

/**
 * The named refusal every deferred Intelligence consumer raises.
 *
 * Named for the audit trail: a run failing with this name has hit a deployment
 * that has not configured Intelligence, and the message says what to configure
 * instead of pretending the feature ran.
 */
export class IntelligenceUnconfiguredError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(
      `INTELLIGENCE_UNCONFIGURED: ${feature} needs Intelligence, and this deployment has not configured it (missing ${INTELLIGENCE_SETTING_NAMES}). Configure Intelligence or serve this entrance from the governed enterprise path; there is no in-memory fallback.`,
    );
    this.name = "IntelligenceUnconfiguredError";
    this.feature = feature;
  }
}

/**
 * A memoized accessor in place of an eager client construction.
 *
 * The first call constructs; every later call returns the same client. With no
 * settings, every call throws the named refusal and nothing is ever
 * constructed. Passing the returned accessor — not calling it — is what keeps
 * a boot-time assembly (a turn runner, a delivery, a banner) client-free until
 * the feature actually runs.
 */
export function lazyIntelligenceClient(options: {
  settings: IntelligenceSettings | undefined;
  feature: string;
  /** Defaults to the shared factory; a call site may wrap or observe. */
  build?: (settings: IntelligenceSettings) => CopilotKitIntelligence;
}): () => CopilotKitIntelligence {
  const build = options.build ?? createIntelligenceClient;
  let client: CopilotKitIntelligence | undefined;
  return () => {
    if (!client) {
      if (!options.settings) {
        throw new IntelligenceUnconfiguredError(options.feature);
      }
      client = build(options.settings);
    }
    return client;
  };
}

/**
 * The first boot gate: whether EITHER engine a chat or background turn runs on
 * is configured.
 *
 * The governed enterprise path needs its three databases wired; the legacy
 * path needs the full Intelligence contract. Neither configured means no
 * engine exists to serve a turn — boot refuses with the named refusal instead
 * of starting a server whose every conversation would fail. A PARTIAL wiring
 * (one of the three enterprise URLs, or two of the three Intelligence
 * settings) is also a refusal: a deployment that set some of the values made
 * a mistake the missing-name message can point at.
 *
 * Config-layer only: URL presence, not verification. The VERIFIED gate (a
 * configured enterprise database that failed its capability check) is the
 * composition site's refusal, which names the failed verification instead.
 */
export function agentRuntimeConfigRefusal(input: {
  intelligenceConfigured: boolean;
  enterpriseDirectoryUrl?: string;
  enterpriseDataUrl?: string;
  tenantStorageRuntimeUrl?: string;
}): string | undefined {
  if (input.intelligenceConfigured) return undefined;
  const enterprise = {
    directory: Boolean(input.enterpriseDirectoryUrl),
    data: Boolean(input.enterpriseDataUrl),
    tenantStorage: Boolean(input.tenantStorageRuntimeUrl),
  };
  const allWired = Object.values(enterprise).every(Boolean);
  if (allWired) return undefined;
  const missing = [
    ...(!enterprise.directory ? ["ENTERPRISE_DIRECTORY_DATABASE_URL"] : []),
    ...(!enterprise.data ? ["ENTERPRISE_DATA_DATABASE_URL"] : []),
    ...(!enterprise.tenantStorage
      ? ["OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL"]
      : []),
  ];
  return `AGENT_RUNTIME_UNCONFIGURED: no chat or background engine is available, so boot refuses rather than degrade to an in-memory runner. Intelligence is not configured (missing ${INTELLIGENCE_SETTING_NAMES}) and the governed enterprise path is not fully wired (missing ${missing.join(", ")}). Configure Intelligence (${INTELLIGENCE_SETTING_NAMES}) or all of ${ENTERPRISE_SETTING_NAMES}.`;
}
