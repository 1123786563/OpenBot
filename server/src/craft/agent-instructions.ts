/**
 * AGENTS.md generation — ported from onyx `sandbox/util/agent_instructions.py`.
 *
 * Placeholder substitution with a deliberately ordered pipeline: `{{ORGANIZATION_INSTRUCTIONS_SECTION}}`
 * is replaced LAST so admin-authored text containing literal `{{…}}` tokens (copy-pasted from
 * the base template) is never expanded. The template is the onyx original verbatim except for
 * the ported infrastructure wording (egress-proxy Hard rules, the webapp tool entry — Task 4's
 * restore) and the one environment fact that cannot be true in OpenBot (the "numeric" app-id
 * qualifier: OpenBot connector ids are string keys).
 *
 * The company-knowledge section is the one deliberate cut that remains: onyx backs its
 * `company-search` skill with an in-sandbox CLI over the permissioned corpus, and OpenBot has
 * no backed delivery path from the craft sandbox to its knowledge domain yet — a prompt must
 * not promise a missing tool. `companySearchSkillAvailable` splices the pinned, byte-exact
 * onyx section back in the day the managed-content seam delivers the skill.
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

/** One org app the user could still connect (OpenBot: a connector server row). */
export type ConnectableApp = {
  /** The id the agent will pass to the `connect_app` tool (onyx: ExternalApp.id). */
  id: string;
  name: string;
};

/**
 * Render the connectable-apps bullet list — org apps the user hasn't set up yet
 * (onyx `build_connectable_apps_list`). The heading and explanatory prose live in
 * AGENTS.template.md; this only supplies the dynamic `{{CONNECTABLE_APPS_LIST}}`
 * value, with a fallback line when there are no apps. Already-connected apps
 * never reach this function — the app source filters them (onyx
 * `get_connectable_apps_for_user`).
 */
export function buildConnectableAppsList(
  apps: Iterable<ConnectableApp>,
): string {
  const entries = [...apps]
    .map((app) => [app.id, app.name] as const)
    .sort(([leftId, leftName], [rightId, rightName]) =>
      leftId < rightId
        ? -1
        : leftId > rightId
          ? 1
          : leftName < rightName
            ? -1
            : leftName > rightName
              ? 1
              : 0,
    );
  if (entries.length === 0) {
    return "No connectable apps available.";
  }
  return entries
    .map(([id, name]) => `- External app ID \`${id}\`: **${name}**`)
    .join("\n");
}

/**
 * onyx's Company knowledge section, byte-exact (`AGENTS.template.md:81-88`) —
 * spliced in at onyx's position only when the managed-content seam delivers a
 * backed company-search skill. Note the single leading space on " or label…"
 * (onyx verbatim).
 */
export const COMPANY_KNOWLEDGE_SECTION =
  "## Company knowledge\n\n" +
  "When the request relates to the user's work, use the `company-search` skill to search their\n" +
  "permissioned company corpus. Reformulate and re-search if results are weak, and stop once you\n" +
  "can answer. Cite every source by title and URL.\n" +
  "\n" +
  "If results are empty or weak, say so and name what you searched. Then ask the user for guidance,\n" +
  " or label any non-grounded content as general knowledge.";

/** Where the company-knowledge section sits in onyx's template: before Files. */
const COMPANY_KNOWLEDGE_ANCHOR = "## Files & attachments";

function buildOrganizationInstructionsSection(
  instructions: string | null,
): string {
  if (!instructions?.trim()) return "";
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
  /**
   * The pre-rendered connectable-apps list (onyx passes `build_connectable_apps_list`'s
   * output; the default answers for a deployment whose app source is empty).
   */
  connectableAppsSection?: string | null;
  /**
   * Whether a backed company-search skill ships in the managed fileset — gates the
   * Company knowledge section. False while that skill has no backed implementation.
   */
  companySearchSkillAvailable?: boolean;
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

  let template = input.template;
  if (input.companySearchSkillAvailable) {
    const at = template.indexOf(COMPANY_KNOWLEDGE_ANCHOR);
    if (at >= 0) {
      template =
        template.slice(0, at) +
        COMPANY_KNOWLEDGE_SECTION +
        "\n\n" +
        template.slice(at);
    }
  }

  const connectableAppsSection =
    input.connectableAppsSection ?? "No connectable apps available.";

  let content = template;
  content = content.replaceAll("{{USER_CONTEXT}}", userContext);
  content = content.replaceAll(
    "{{LLM_PROVIDER_NAME}}",
    providerDisplay ?? "Unknown",
  );
  content = content.replaceAll(
    "{{LLM_MODEL_NAME}}",
    input.modelName ?? "Unknown",
  );
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
  content = content.replaceAll(
    "{{DISABLED_TOOLS_SECTION}}",
    disabledToolsSection,
  );
  content = content.replaceAll(
    "{{CONNECTABLE_APPS_LIST}}",
    connectableAppsSection,
  );
  // Last, so admin-authored text containing literal {{...}} tokens is never expanded.
  content = content.replaceAll(
    "{{ORGANIZATION_INSTRUCTIONS_SECTION}}",
    buildOrganizationInstructionsSection(
      input.organizationInstructions ?? null,
    ),
  );
  return content;
}
