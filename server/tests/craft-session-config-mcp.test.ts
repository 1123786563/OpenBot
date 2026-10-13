import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import type { ResolvedCraftManagedContent } from "../src/craft/managed-content";
import { CraftSessionManager } from "../src/craft/manager";
import {
  buildProviderOpencodeConfig,
  type CraftLLMProviderConfig,
  opencodeConfigJson,
} from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import {
  computeSkillRuntimeHash,
  craftMcpFingerprint,
} from "../src/craft/skills";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { setupSessionWorkspace } from "../src/craft/workspace";

/**
 * The per-session config snapshot rule (the plan's binding constraint): the
 * resolved MCP server list and the session id feed `buildProviderOpencodeConfig`
 * identically at workspace creation and at every reconcile — one resolved
 * snapshot per pass, byte-identical config — and a changed permission set
 * disposes the running OpenCode instance so a fresh one picks it up.
 */

const SESSION_ID = "cs-mcp";
const USER_ID = "u1";
const config = loadCraftConfig({});
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;

const encoder = new TextEncoder();

const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

const ACME = {
  key: "acme-tools-42",
  url: "https://openbot.example/api/craft/mcp/42",
  disabledTools: ["delete_everything"],
};
const EXTRA = {
  key: "another-srv-7",
  url: "https://openbot.example/api/craft/mcp/srv-7",
  disabledTools: [],
};

function contentWith(
  mcpServers: ResolvedCraftManagedContent["mcpServers"],
): ResolvedCraftManagedContent {
  const skillFiles = new Map<string, Uint8Array>();
  return {
    connectableAppsSection: "No connectable apps available.",
    skillFiles,
    mcpServers,
    skillsHash: computeSkillRuntimeHash({}, "No connectable apps available."),
    mcpConfigHash: craftMcpFingerprint(mcpServers),
    libraryFiles: new Map(),
    webTemplateFiles: new Map(),  };
}

function expectedConfigBytes(
  mcpServers: ResolvedCraftManagedContent["mcpServers"],
): string {
  return opencodeConfigJson(
    buildProviderOpencodeConfig(llm, {
      disabledTools: config.opencodeDisabledTools,
      gatedTools: config.approvalGatedTools,
      plugins: [
        "./.opencode/plugin/turn-budget.ts",
        "./.opencode/plugin/connect-app.ts",
        "./.opencode/plugin/webapp.ts",
      ],
      mcpServers,
      sessionId: SESSION_ID,
    }),
  );
}

// ---------------------------------------------------------------------------
// workspace creation
// ---------------------------------------------------------------------------

describe("setupSessionWorkspace with MCP servers", () => {
  test("opencode.json carries the mcp block + both plugins; the connect-app plugin file lands", async () => {
    const files = new Map<string, string>();
    await setupSessionWorkspace(
      {
        writeFile: async (path, content) => files.set(path, content),
        mkdir: async () => undefined,
      },
      {
        sessionId: SESSION_ID,
        config,
        llmConfig: llm,
        agentsTemplate: "",
        managedContent: {
          connectableAppsSection: "No connectable apps available.",
          companySearchSkillAvailable: false,
          mcpServers: [ACME],
        },
      },
    );

    const opencodeJson = files.get(`${DIRECTORY}/opencode.json`);
    expect(opencodeJson).toBe(expectedConfigBytes([ACME]));
    const parsed = JSON.parse(opencodeJson as string);
    expect(parsed.mcp).toEqual({
      "acme-tools-42": {
        type: "remote",
        url: ACME.url,
        enabled: true,
        oauth: false,
        headers: { "X-Onyx-Mcp-Session": SESSION_ID },
      },
    });
    expect(parsed.permission["acme-tools-42_*"]).toBe("allow");
    expect(parsed.permission["acme-tools-42_delete_everything"]).toBe("deny");
    expect(parsed.permission.connect_app).toBe("ask");

    // Both managed plugins ride the workspace (the image cannot bake them).
    const connectAppPlugin = files.get(
      `${DIRECTORY}/.opencode/plugin/connect-app.ts`,
    );
    expect(typeof connectAppPlugin).toBe("string");
    expect(connectAppPlugin).toContain("connect_app");
  });
});

// ---------------------------------------------------------------------------
// reconcile: identical snapshots + dispose on change
// ---------------------------------------------------------------------------

function sessionRow(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: "ses_1",
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

function memoryGateway() {
  const files = new Map<string, string>();
  const disposals: string[] = [];
  const writeFile = async (path: string, content: string) => {
    files.set(path, content);
  };
  const gateway = {
    fileApiFor: () => ({
      async listFiles(path: string) {
        return [...files.keys()].filter((key) => key.startsWith(`${path}/`));
      },
      writeFile,
      writeFileBytes: async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      },
      async deletePath(path: string) {
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
        return true;
      },
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes() {
        return null;
      },
    }),
    workspaceApiFor: () => ({ writeFile, mkdir: async () => undefined }),
    serveClientFor: ({ directory }: { directory: string }) => ({
      disposeInstance: async () => {
        disposals.push(directory);
      },
    }),
  } as unknown as SandboxGateway;
  return { gateway, files, disposals };
}

function managerHarness(input: {
  row: CraftSessionRow;
  content: ResolvedCraftManagedContent | null;
  resolveCalls?: { count: number };
}) {
  const sandbox = memoryGateway();
  const store = {
    async getSession(id: string, userId: string) {
      return id === SESSION_ID && userId === USER_ID
        ? { ...input.row }
        : undefined;
    },
    async updateSession() {
      return { ...input.row };
    },
  } as unknown as CraftStore;
  const manager = new CraftSessionManager({
    config,
    store,
    gateway: sandbox.gateway,
    llmConfigFor: async () => llm,
    botIdFor: async () => "craft",
    managedContentFor: async () => {
      if (input.resolveCalls) input.resolveCalls.count += 1;
      if (input.content === null) throw new Error("resolver down");
      return input.content;
    },
  });
  return { manager, ...sandbox };
}

describe("reconcileSessionLlmConfig MCP snapshots", () => {
  test("a changed MCP set regenerates from one snapshot and disposes the instance", async () => {
    const content = contentWith([ACME]);
    const row = sessionRow({
      skillsHash: content.skillsHash,
      mcpConfigHash: content.mcpConfigHash,
    });
    const resolveCalls = { count: 0 };
    // The workspace still carries the OLD config (no mcp block).
    const { manager, files, disposals } = managerHarness({
      row,
      content: contentWith([ACME]),
      resolveCalls,
    });
    await manager.reconcileSessionLlmConfig({} as never, row, null);

    // The rewritten config is byte-identical to the builder's snapshot...
    expect(files.get(`${DIRECTORY}/opencode.json`)).toBe(
      expectedConfigBytes([ACME]),
    );
    // ...the running instance is disposed so a fresh one re-reads it...
    expect(disposals).toEqual([DIRECTORY]);

    // Now the permission set CHANGES: a second server appears.
    const content2 = contentWith([ACME, EXTRA]);
    const row2 = sessionRow({
      skillsHash: content2.skillsHash,
      mcpConfigHash: content2.mcpConfigHash,
    });
    const second = managerHarness({
      row: row2,
      content: content2,
    });
    await second.manager.reconcileSessionLlmConfig(
      {} as never,
      row2 as CraftSessionRow,
      null,
    );
    expect(second.files.get(`${DIRECTORY}/opencode.json`)).toBe(
      expectedConfigBytes([ACME, EXTRA]),
    );
    expect(second.disposals).toEqual([DIRECTORY]);

    // One resolver snapshot per pass (byte-compare and rewrite agree by construction).
    expect(resolveCalls.count).toBeGreaterThan(0);
  });

  test("an unchanged snapshot converges: no rewrite, but a pending instance still disposes", async () => {
    const content = contentWith([ACME]);
    const row = sessionRow({ mcpConfigHash: content.mcpConfigHash });
    const { manager, files, disposals } = managerHarness({ row, content });
    // First pass writes the file.
    await manager.reconcileSessionLlmConfig({} as never, row, null);
    expect(files.get(`${DIRECTORY}/opencode.json`)).toBe(
      expectedConfigBytes([ACME]),
    );
    // Second pass: byte-identical → no further change (same expected bytes,
    // no error), and the reconcile still re-disposes a live instance id.
    await manager.reconcileSessionLlmConfig({} as never, row, null);
    expect(files.get(`${DIRECTORY}/opencode.json`)).toBe(
      expectedConfigBytes([ACME]),
    );
    expect(disposals.length).toBeGreaterThanOrEqual(1);
  });

  test("a resolver failure does not strip the session's mcp config", async () => {
    const content = contentWith([ACME]);
    const row = sessionRow({ mcpConfigHash: content.mcpConfigHash });
    // The workspace already carries the mcp-bearing config...
    const { manager: writer, files } = managerHarness({ row, content });
    await writer.reconcileSessionLlmConfig({} as never, row, null);
    const withMcp = files.get(`${DIRECTORY}/opencode.json`);
    expect(JSON.parse(withMcp as string).mcp).toBeDefined();

    // ...and a reconcile whose resolver fails must leave those bytes alone:
    // rewriting without the snapshot would silently strip the session's MCP
    // servers on a transient outage.
    const failing = managerHarness({ row, content: null });
    failing.files.set(`${DIRECTORY}/opencode.json`, withMcp as string);
    await failing.manager.reconcileSessionLlmConfig({} as never, row, null);
    expect(failing.files.get(`${DIRECTORY}/opencode.json`)).toBe(withMcp);
  });
});
