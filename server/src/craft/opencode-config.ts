/**
 * opencode.json builders — ported from onyx `sandbox/util/opencode_config.py`.
 *
 * opencode-serve loads config once at startup and does not hot-reload (sst/opencode#22213).
 * The per-session `opencode.json` carries the gateway provider catalog + default model, which
 * opencode deep-merges over the pod-global config and re-reads when the session's instance is
 * disposed — so a model change hot-reloads without a sandbox re-provision.
 *
 * The per-session `mcp` block carries the user's craft MCP servers, each stamped with the
 * session-tag header the credential-attaching relay attributes a tool call by (mcp-relay.ts —
 * OpenBot's environment-equivalent of onyx's egress-proxy injection). No credential bytes ever
 * enter this config: the urls point at the relay, and only the relay side holds the tokens.
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

/**
 * A craft-enabled MCP server as the session's config consumes it. The url points at the
 * deployment's credential-attaching relay (see mcp-relay.ts), never at the vendor endpoint —
 * opencode's in-sandbox client dials the relay, which attaches the owner's credential on the
 * server side (onyx: the egress proxy does this; the header set is exactly one: the session tag).
 */
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
  // The workspace-born plugins are managed content (the image cannot bake
  // them): the agent may read them but never rewrite the tool schemas the
  // server shipped (turn-budget steer, connect-app handshake).
  "**/.opencode/plugin/**": "deny",
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
  // The connect-app tool: a no-op tool the agent calls to request connecting
  // an external app it isn't set up for (onyx opencode_config.py:87-89).
  connect_app: "ask",
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
  gatedTools: readonly string[] = [],
): Record<string, unknown> {
  const permissions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(PERMISSIONS_TEMPLATE)) {
    permissions[key] =
      value instanceof Object && !Array.isArray(value) ? { ...value } : value;
  }
  permissions.external_directory = devMode
    ? "allow"
    : { ...TMP_EXTERNAL_DIRECTORY_RULES };
  // Gated tools ask instead of allow: the catch-all rule flips to "ask" (whole
  // tool — bash granularity is the tool, not the command). Named denies keep
  // denying (opencode's findLast evaluation makes the later specific rule win),
  // and a tool outside the template gets a bare "ask". Applied BEFORE the
  // disabled override so "deny" still wins over "ask".
  for (const tool of gatedTools) {
    const rules = permissions[tool];
    if (rules instanceof Object && !Array.isArray(rules)) {
      (rules as Record<string, string>)["*"] = "ask";
    } else {
      permissions[tool] = "ask";
    }
  }
  for (const tool of disabledTools ?? []) {
    permissions[tool] = "deny";
  }
  // MCP tool ids are `<serverKey>_<toolName>`. The wildcard allow covers tools
  // discovered at runtime — the credential-attaching relay is the boundary a
  // dialed call answers through, and disabled tools deny before any dial.
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
 * The session's remote `mcp` entries (onyx `_build_session_mcp_block`): each server
 * carries the session-tag header stamped with the session id — how the relay attributes
 * a tool call to its session. `oauth: false` keeps opencode from running its own
 * discovery against paths that would never authenticate (the relay holds credentials).
 */
function buildSessionMcpBlock(
  mcpServers: readonly CraftMCPServerConfig[],
  sessionId: string,
): Record<string, unknown> {
  const block: Record<string, unknown> = {};
  for (const server of mcpServers) {
    block[server.key] = {
      type: "remote",
      url: server.url,
      enabled: true,
      oauth: false,
      headers: { [MCP_SESSION_TAG_HEADER]: sessionId },
    };
  }
  return block;
}

/**
 * Per-session `opencode.json`: the gateway provider catalog + default model, the craft
 * MCP servers (session-tagged, per-tool permission gates), and the local plugin specs —
 * opencode deep-merges this over the pod-global base. Key order is part of the contract:
 * the reconcile path byte-compares serialized configs, so the order here is frozen
 * (onyx's dict order: schema, model, provider, enabled_providers, permission, plugin, mcp).
 */
export function buildProviderOpencodeConfig(
  llmProviderConfig: CraftLLMProviderConfig,
  options: {
    disabledTools?: readonly string[] | null;
    devMode?: boolean;
    mcpServers?: readonly CraftMCPServerConfig[];
    /**
     * The craft session id — required when mcpServers are provided (the session-tag
     * header each entry carries); onyx raises without it (opencode_config.py:250-252).
     */
    sessionId?: string;
    /** Tools whose catch-all permission becomes "ask" (the approval rendezvous). */
    gatedTools?: readonly string[];
    /**
     * Local plugin specs (paths relative to the session directory) opencode loads for
     * this session — the turn-budget steer (onyx emits the same field when its image
     * bakes plugins; here the plugin files ride in the workspace itself).
     */
    plugins?: readonly string[];
  } = {},
): Record<string, unknown> {
  if (
    llmProviderConfig.models !== null &&
    !llmProviderConfig.models.some(
      (model) => model.id === llmProviderConfig.modelName,
    )
  ) {
    throw new Error(
      `default model '${llmProviderConfig.modelName}' is not in the provider catalog`,
    );
  }

  const config: Record<string, unknown> = {
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
      options.gatedTools ?? [],
    ),
  };
  if (options.plugins && options.plugins.length > 0) {
    config.plugin = [...options.plugins];
  }
  if (options.mcpServers && options.mcpServers.length > 0) {
    if (!options.sessionId) {
      throw new Error("session_id is required when mcp_servers are provided");
    }
    config.mcp = buildSessionMcpBlock(options.mcpServers, options.sessionId);
  }
  return config;
}

/** The session's opencode.json as the workspace bytes (stable key order for byte-compare). */
export function opencodeConfigJson(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}
