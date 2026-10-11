/**
 * AGENTS.md generation — ported from onyx `sandbox/util/agent_instructions.py`.
 *
 * Placeholder substitution with a deliberately ordered pipeline: `{{ORGANIZATION_INSTRUCTIONS_SECTION}}`
 * is replaced LAST so admin-authored text containing literal `{{…}}` tokens (copy-pasted from
 * the base template) is never expanded. The template itself is rewritten for the OpenBot
 * context (no egress proxy, no connectable apps, no user library — the corresponding sections
 * were dropped, not stubbed).
 */

import type { CraftConfig } from "./config";

/** Provider display name mapping (onyx parity). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  google: "Google AI",
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex AI",
};

export function getProviderDisplayName(provider: string | null): string | null {
  if (!provider) return null;
  return PROVIDER_DISPLAY_NAMES[provider] ?? titleCase(provider);
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .map((word) =>
      word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

function buildOrganizationInstructionsSection(instructions: string | null): string {
  if (!instructions || !instructions.trim()) return "";
  return (
    "\n## Organization instructions\n\n" +
    "Your organization's admins set these workspace-wide instructions. " +
    "Follow them in every session; the Hard rules above still win on any conflict.\n\n" +
    `${instructions.trim()}\n`
  );
}

export type GenerateAgentInstructionsInput = {
  template: string;
  config: CraftConfig;
  provider?: string | null;
  modelName?: string | null;
  disabledTools?: readonly string[] | null;
  userName?: string | null;
  organizationInstructions?: string | null;
};

/**
 * Generate AGENTS.md content by populating the template with dynamic values.
 * Returns a fallback stub when the template is empty (onyx logs and degrades).
 */
export function generateAgentInstructions(
  input: GenerateAgentInstructionsInput,
): string {
  if (!input.template) {
    return "# Agent Instructions\n\nNo custom instructions provided.";
  }

  const userContext = input.userName
    ? `You are assisting **${input.userName}** with their work.`
    : "";

  const providerDisplay = getProviderDisplayName(input.provider ?? null);

  let disabledToolsSection = "";
  if (input.disabledTools && input.disabledTools.length > 0) {
    disabledToolsSection = `\n**Disabled Tools**: ${input.disabledTools.join(", ")}\n`;
  }

  let content = input.template;
  content = content.replaceAll("{{USER_CONTEXT}}", userContext);
  content = content.replaceAll(
    "{{LLM_PROVIDER_NAME}}",
    providerDisplay ?? "Unknown",
  );
  content = content.replaceAll("{{LLM_MODEL_NAME}}", input.modelName ?? "Unknown");
  content = content.replaceAll(
    "{{APPROVAL_WAIT_TIMEOUT_SECONDS}}",
    String(input.config.sandboxApprovalWaitTimeoutSeconds),
  );
  content = content.replaceAll(
    "{{APPROVAL_CLIENT_TIMEOUT_SECONDS}}",
    String(
      input.config.sandboxApprovalWaitTimeoutSeconds +
        input.config.sandboxApprovalWaitMarginSeconds,
    ),
  );
  content = content.replaceAll("{{DISABLED_TOOLS_SECTION}}", disabledToolsSection);
  // Last, so admin-authored text containing literal {{...}} tokens is never expanded.
  content = content.replaceAll(
    "{{ORGANIZATION_INSTRUCTIONS_SECTION}}",
    buildOrganizationInstructionsSection(input.organizationInstructions ?? null),
  );
  return content;
}
