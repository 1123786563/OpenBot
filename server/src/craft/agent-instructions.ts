/**
 * AGENTS.md generation — ported from onyx `sandbox/util/agent_instructions.py`.
 *
 * Placeholder substitution with a deliberately ordered pipeline: `{{ORGANIZATION_INSTRUCTIONS_SECTION}}`
 * is replaced LAST so admin-authored text containing literal `{{…}}` tokens (copy-pasted from
 * the base template) is never expanded. The template is the onyx original verbatim except for
 * the ported infrastructure wording (egress-proxy Hard rules, the webapp tool entry — Task 4's
 * restore) and the one environment fact that cannot be true in OpenBot (the "numeric" app-id
 * qualifier: OpenBot connector ids are string keys).

 */

import { getLogger } from "../../../shared/logger";
import type { CraftConfig } from "./config";
import type { AgentSandboxFileApi } from "./sandbox-gateway";

const logger = getLogger("server");

/**
 * The attachments section appended to AGENTS.md when the session's attachments/
 * directory is non-empty — onyx `ATTACHMENTS_SECTION_CONTENT`
 * (sandbox/util/agent_instructions.py:46-75), verbatim including the heading.
 */
export const ATTACHMENTS_SECTION_CONTENT = `## Attachments (PRIORITY)

The \`attachments/\` directory contains files that the user has explicitly
uploaded during this session. **These files are critically important** and
should be treated as high-priority context.

### Why Attachments Matter

- The user deliberately chose to upload these files, signaling they are directly relevant to the task
- These files often contain the specific data, requirements, or examples the user wants you to work with
- They may include spreadsheets, documents, images, or code that should inform your work

### Required Actions

**At the start of every task, you MUST:**

1. **Check for attachments**: List the contents of \`attachments/\` to see what the user has provided
2. **Read and analyze each file**: Thoroughly examine every attachment to understand its contents and relevance
3. **Reference attachment content**: Use the information from attachments to inform your responses and outputs

### File Handling

- Uploaded files may be in various formats: CSV, JSON, PDF, images, text files, etc.
- For spreadsheets and data files, examine the structure, columns, and sample data
- For documents, extract key information and requirements
- For images, analyze and describe their content
- For code files, understand the logic and patterns

**Do NOT ignore user uploaded files.** They are there for a reason and likely
contain exactly what you need to complete the task successfully.`;

const ATTACHMENTS_SECTION_HEADING = "## Attachments (PRIORITY)";

/**
 * onyx's post-write step (docker_sandbox_manager.py:1585-1589): when the session's
 * attachments/ directory is non-empty, AGENTS.md gains "\n\n" + ATTACHMENTS_SECTION_CONTENT.
 * Idempotent — an AGENTS.md already carrying the heading is left alone. An absent
 * attachments directory (the gateway's 404) or an absent AGENTS.md means "nothing to do",
 * not an error. Returns whether the section was appended.
 */
export async function appendAttachmentsSectionIfMissing(
  api: Pick<AgentSandboxFileApi, "listFiles" | "readFile" | "writeFile">,
  directory: string,
  attachmentsDir = "attachments",
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await api.listFiles(`${directory}/${attachmentsDir}`);
  } catch (error) {
    // An absent directory answers [] from the gateway, so a throw here is a real fault
    // (permissions, a transport failure): say so rather than read it as "no attachments".
    logger.warn(
      { err: error, directory: `${directory}/${attachmentsDir}` },
      "Could not list the attachments directory.",
    );
    return false;
  }
  if (entries.length === 0) return false;
  const path = `${directory}/AGENTS.md`;
  const current = await api.readFile(path);
  if (current === null || current.includes(ATTACHMENTS_SECTION_HEADING)) {
    return false;
  }
  await api.writeFile(path, `${current}\n\n${ATTACHMENTS_SECTION_CONTENT}`);
  return true;
}

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
  // Own properties only: a provider named like an Object member ("constructor") must not
  // read the prototype chain and stringify a built-in function into the instructions.
  return (
    (Object.hasOwn(PROVIDER_DISPLAY_NAMES, provider)
      ? PROVIDER_DISPLAY_NAMES[provider]
      : undefined) ?? titleCase(provider)
  );
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

  const template = input.template;

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
