/**
 * opencode.json builders — ported from onyx `sandbox/util/opencode_config.py`.
 *
 * opencode-serve loads config once at startup and does not hot-reload (sst/opencode#22213).
 * The per-session `opencode.json` carries the gateway provider catalog + default model, which
 * opencode deep-merges over the pod-global config and re-reads when the session's instance is
 * disposed — so a model change hot-reloads without a sandbox re-provision.
 *
 * The MCP block is phase 2 (no egress-proxy semantics here yet); `mcpServers` stays an empty
 * sequence so the builder is already shaped for it.
 */

/** Model catalog entry for the opencode provider block. */
export type CraftModelDescriptor = {
  id: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportsReasoning: boolean;
  supportsToolCalls: boolean;
  supportsTemperature: boolean;
  supportsInterleavedReasoning: boolean;
};

/** The gateway provider config a session's opencode.json is built from. */
export type CraftLLMProviderConfig = {
  provider: string;
  modelName: string;
  apiKey: string | null;
  apiBase: string | null;
  displayName: string | null;
  models: CraftModelDescriptor[] | null;
};

/** A craft-enabled MCP server (phase 2; the shape ships so the builder needs no surgery then). */
export type CraftMCPServerConfig = {
  key: string;
  url: string;
  disabledTools: string[];
};

// The gateway is an OpenAI-compatible endpoint, wired via opencode's
// openai-compatible SDK package.
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

/** Header carrying the originating session id on opencode's MCP client requests. */
export const MCP_SESSION_TAG_HEADER = "X-Onyx-Mcp-Session";

const PROTECTED_FILE_RULES: Record<string, string> = {
  // OpenCode uses the last matching rule, so specific denies must follow the
  // catch-all allow.
  "*": "allow",
  "opencode.json": "deny",
  "**/opencode.json": "deny",
  "start-webapp.sh": "deny",
  "**/start-webapp.sh": "deny",
};

const PERMISSIONS_TEMPLATE: Record<string, unknown> = {
  bash: {
    rm: "deny",
    ssh: "deny",
    scp: "deny",
    sftp: "deny",
    ftp: "deny",
    telnet: "deny",
    nc: "deny",
    netcat: "deny",
    tac: "deny",
    nl: "deny",
    od: "deny",
    xxd: "deny",
    hexdump: "deny",
    strings: "deny",
    base64: "deny",
    "*": "allow",
    "*start-webapp.sh*": "deny",
    // The webapp plugin starts the script via child_process, not the bash tool.
    // These are the two documented direct fallbacks for the agent.
    "bash start-webapp.sh": "allow",
    "bash ./start-webapp.sh": "allow",
  },
  edit: PROTECTED_FILE_RULES,
  write: PROTECTED_FILE_RULES,
  read: {
    "*": "allow",
    "opencode.json": "deny",
    "**/opencode.json": "deny",
  },
  grep: {
    "*": "allow",
    "opencode.json": "deny",
    "**/opencode.json": "deny",
  },
  glob: {
    "*": "allow",
    "opencode.json": "deny",
    "**/opencode.json": "deny",
  },
  list: "allow",
  lsp: "allow",
  patch: PROTECTED_FILE_RULES,
  // Deny opencode's built-in customize-opencode skill (edits opencode.json via
  // the skill tool, bypassing our edit/write denies). "*" must precede the
  // named deny — opencode evaluates skill rules with findLast().
  skill: { "*": "allow", "customize-opencode": "deny" },
  question: "allow",
  webfetch: "allow",
};

const TMP_EXTERNAL_DIRECTORY_RULES: Record<string, string> = {
  // OpenCode applies granular permission objects by pattern match with the
  // last matching rule winning. Keep the catch-all first so the /tmp allow
  // rules override it without opening any other external paths.
  "*": "deny",
  "/tmp": "allow", // sandbox-local scratch path
  "/tmp/**": "allow", // sandbox-local scratch path
};

function buildPermissions(
  disabledTools: readonly string[] | null,
  devMode: boolean,
  mcpServers: readonly CraftMCPServerConfig[] = [],
): Record<string, unknown> {
  const permissions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(PERMISSIONS_TEMPLATE)) {
    permissions[key] =
      value instanceof Object && !Array.isArray(value) ? { ...value } : value;
  }
  permissions.external_directory = devMode
    ? "allow"
    : { ...TMP_EXTERNAL_DIRECTORY_RULES };
  for (const tool of disabledTools ?? []) {
    permissions[tool] = "deny";
  }
  // MCP tool ids are `<serverKey>_<toolName>`. The wildcard allow covers tools
  // discovered at runtime (phase 2 gates them at the proxy, as onyx does).
  for (const server of mcpServers) {
    permissions[`${server.key}_*`] = "allow";
    for (const toolName of server.disabledTools) {
      permissions[`${server.key}_${toolName}`] = "deny";
    }
  }
  return permissions;
}

function buildProviderBlock(
  llmProviderConfig: CraftLLMProviderConfig,
): Record<string, unknown> {
  // The gateway is an openai-compatible provider with no models.dev entry, so
  // its baseURL goes in `options` and its model list must be explicit.
  const options: Record<string, unknown> = {};
  if (llmProviderConfig.apiKey) options.apiKey = llmProviderConfig.apiKey;
  if (llmProviderConfig.apiBase) options.baseURL = llmProviderConfig.apiBase;
  const block: Record<string, unknown> = {
    npm: OPENAI_COMPATIBLE_NPM,
    options,
  };
  if (llmProviderConfig.displayName) block.name = llmProviderConfig.displayName;
  const models: Record<string, unknown> = {};
  for (const model of llmProviderConfig.models ?? []) {
    const entry: Record<string, unknown> = {
      name: model.displayName,
      attachment: model.inputModalities.includes("image"),
      reasoning: model.supportsReasoning,
      temperature: model.supportsTemperature,
      tool_call: model.supportsToolCalls,
      modalities: {
        input: [...model.inputModalities],
        output: [...model.outputModalities],
      },
    };
    if (model.supportsInterleavedReasoning) entry.interleaved = true;
    if (model.maxInputTokens !== null && model.maxOutputTokens !== null) {
      // OpenCode 1.15.x subtracts output from context when input is absent;
      // include input explicitly to keep compaction from collapsing to zero.
      entry.limit = {
        context: model.maxInputTokens,
        input: model.maxInputTokens,
        output: model.maxOutputTokens,
      };
    }
    models[model.id] = entry;
  }
  block.models = models;
  return block;
}

/**
 * Per-session `opencode.json`: the gateway provider catalog + default model, plus (phase 2)
 * the craft MCP servers (session-tagged) and their per-tool permission gates. opencode
 * deep-merges this over the pod-global base.
 */
export function buildProviderOpencodeConfig(
  llmProviderConfig: CraftLLMProviderConfig,
  options: {
    disabledTools?: readonly string[] | null;
    devMode?: boolean;
    mcpServers?: readonly CraftMCPServerConfig[];
  } = {},
): Record<string, unknown> {
  if (
    llmProviderConfig.models !== null &&
    !llmProviderConfig.models.some((model) => model.id === llmProviderConfig.modelName)
  ) {
    throw new Error(
      `default model '${llmProviderConfig.modelName}' is not in the provider catalog`,
    );
  }

  return {
    $schema: "https://opencode.ai/config.json",
    model: `${llmProviderConfig.provider}/${llmProviderConfig.modelName}`,
    provider: {
      [llmProviderConfig.provider]: buildProviderBlock(llmProviderConfig),
    },
    enabled_providers: [llmProviderConfig.provider],
    permission: buildPermissions(
      options.disabledTools ?? null,
      options.devMode ?? false,
      options.mcpServers ?? [],
    ),
  };
}

/** The session's opencode.json as the workspace bytes (stable key order for byte-compare). */
export function opencodeConfigJson(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}
