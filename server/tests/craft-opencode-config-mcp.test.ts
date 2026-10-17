import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  buildProviderOpencodeConfig,
  MCP_SESSION_TAG_HEADER,
  opencodeConfigJson,
  type CraftLLMProviderConfig,
  type CraftMCPServerConfig,
} from "../src/craft/opencode-config";

/**
 * Fixture F3 — per-user MCP servers + disabled MCP tools, as
 * `build_provider_opencode_config` (onyx opencode_config.py:218-254) renders
 * them into a session's opencode.json.
 */

const llm: CraftLLMProviderConfig = {
  provider: "onyx",
  modelName: "gpt-5",
  apiKey: "k",
  apiBase: "https://gw.example/v1",
  displayName: null,
  models: [
    {
      id: "gpt-5",
      displayName: "gpt-5",
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsReasoning: false,
      supportsToolCalls: true,
      supportsTemperature: false,
      supportsInterleavedReasoning: false,
    },
  ],
};

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const acme: CraftMCPServerConfig = {
  key: "acme-tools-42",
  url: "https://acme.example/mcp",
  disabledTools: ["delete_everything"],
};

describe("mcp block (F3)", () => {
  test("renders remote entries with type/url/enabled/oauth and the session tag header", () => {
    const config = buildProviderOpencodeConfig(llm, {
      mcpServers: [acme],
      sessionId: SESSION_ID,
    }) as Record<string, unknown>;
    expect(config.mcp).toEqual({
      "acme-tools-42": {
        type: "remote",
        url: "https://acme.example/mcp",
        enabled: true,
        oauth: false,
        headers: { "X-Onyx-Mcp-Session": SESSION_ID },
      },
    });
    expect(MCP_SESSION_TAG_HEADER).toBe("X-Onyx-Mcp-Session");
  });

  test("no mcp key when no servers are resolved", () => {
    const config = buildProviderOpencodeConfig(llm) as Record<string, unknown>;
    expect("mcp" in config).toBe(false);
    const empty = buildProviderOpencodeConfig(llm, {
      mcpServers: [],
      sessionId: SESSION_ID,
    }) as Record<string, unknown>;
    expect("mcp" in empty).toBe(false);
  });

  test("mcp servers without a session id are refused", () => {
    expect(() =>
      buildProviderOpencodeConfig(llm, { mcpServers: [acme] }),
    ).toThrow("session_id is required when mcp_servers are provided");
  });

  test("key order: $schema, model, provider, enabled_providers, permission, plugin, mcp", () => {
    const config = buildProviderOpencodeConfig(llm, {
      mcpServers: [acme],
      sessionId: SESSION_ID,
      plugins: ["./.opencode/plugin/turn-budget.ts"],
    }) as Record<string, unknown>;
    expect(Object.keys(config)).toEqual([
      "$schema",
      "model",
      "provider",
      "enabled_providers",
      "permission",
      "plugin",
      "mcp",
    ]);
  });
});

describe("mcp permissions (F3)", () => {
  test("wildcard allow precedes the named disabled-tool deny (findLast wins)", () => {
    const config = buildProviderOpencodeConfig(llm, {
      mcpServers: [acme],
      sessionId: SESSION_ID,
    });
    const permissions = config.permission as Record<string, string>;
    expect(permissions["acme-tools-42_*"]).toBe("allow");
    expect(permissions["acme-tools-42_delete_everything"]).toBe("deny");
    // JSON key order: the wildcard allow must be inserted BEFORE the named
    // deny — opencode's findLast evaluation makes the later rule win.
    const keys = Object.keys(permissions);
    expect(keys.indexOf("acme-tools-42_*")).toBeLessThan(
      keys.indexOf("acme-tools-42_delete_everything"),
    );
  });

  test("connect_app is ask in the permissions template, with or without servers", () => {
    const withServers = buildProviderOpencodeConfig(llm, {
      mcpServers: [acme],
      sessionId: SESSION_ID,
    });
    expect((withServers.permission as Record<string, string>).connect_app).toBe(
      "ask",
    );
    const plain = buildProviderOpencodeConfig(llm);
    expect((plain.permission as Record<string, string>).connect_app).toBe(
      "ask",
    );
  });

  test("the full template baseline stays intact beside the mcp additions", () => {
    const permissions = buildProviderOpencodeConfig(llm, {
      mcpServers: [acme],
      sessionId: SESSION_ID,
    }).permission as Record<string, unknown>;
    expect(permissions.bash).toEqual({
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
      "bash start-webapp.sh": "allow",
      "bash ./start-webapp.sh": "allow",
    });
    expect(permissions.list).toBe("allow");
    expect(permissions.lsp).toBe("allow");
    expect(permissions.question).toBe("allow");
    expect(permissions.webfetch).toBe("allow");
  });
});

describe("byte-stable serialization (F3 hot reload)", () => {
  test("identical inputs serialize to identical bytes; a changed disabled set changes them", () => {
    const a = opencodeConfigJson(
      buildProviderOpencodeConfig(llm, {
        mcpServers: [acme],
        sessionId: SESSION_ID,
      }),
    );
    const b = opencodeConfigJson(
      buildProviderOpencodeConfig(llm, {
        mcpServers: [acme],
        sessionId: SESSION_ID,
      }),
    );
    expect(a).toBe(b);

    const alsoDisabled = opencodeConfigJson(
      buildProviderOpencodeConfig(llm, {
        mcpServers: [
          { ...acme, disabledTools: ["delete_everything", "search"] },
        ],
        sessionId: SESSION_ID,
      }),
    );
    expect(alsoDisabled).not.toBe(a);
    expect(alsoDisabled).toContain('"acme-tools-42_search":"deny"');
  });
});
