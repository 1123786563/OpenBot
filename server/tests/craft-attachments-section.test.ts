import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  appendAttachmentsSectionIfMissing,
  ATTACHMENTS_SECTION_CONTENT,
} from "../src/craft/agent-instructions";
import { loadCraftConfig } from "../src/craft/config";
import { createFileRoutes } from "../src/craft/file-routes";
import type {
  AgentSandboxFileApi,
  SandboxGateway,
} from "../src/craft/sandbox-gateway";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import { setupSessionWorkspace } from "../src/craft/workspace";

/**
 * The D7 gap: onyx appends "## Attachments (PRIORITY)" to AGENTS.md whenever the
 * session's attachments/ directory is non-empty (docker_sandbox_manager.py:1585-1589).
 * Covered seams: the workspace setup path, the upload success path, and idempotency.
 * The sandbox is the same in-memory file API shape as craft-file-routes.test.ts.
 */

const config = loadCraftConfig({
  OPENBOT_CRAFT_MAX_UPLOAD_FILE_SIZE_MB: "1",
  OPENBOT_CRAFT_MAX_UPLOAD_FILES_PER_SESSION: "3",
  OPENBOT_CRAFT_MAX_TOTAL_UPLOAD_SIZE_MB: "1",
});
const SESSION_ID = "cs-sess";
const DIRECTORY = `/workspace/sessions/${SESSION_ID}`;

const AGENTS_MD = "# Agent Instructions\n\nBase content.";
const ATTACHMENTS_HEADING = "## Attachments (PRIORITY)";

/** Same in-memory sandbox as craft-file-routes.test.ts (real gateway listing shape). */
function memoryFileApi(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(initial)) {
    files.set(
      path,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
  const api: AgentSandboxFileApi = {
    async listFiles(path: string) {
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const first = rest.split("/")[0];
        children.add(rest.includes("/") ? `${prefix}${first}` : key);
      }
      if (children.size === 0 && !files.has(path)) {
        throw new Error(`Sandbox /file answered 404 for ${path}.`);
      }
      return [...children];
    },
    async writeFile(path, content) {
      files.set(path, new TextEncoder().encode(content));
    },
    async writeFileBytes(path, bytes) {
      files.set(path, bytes);
    },
    async deletePath(path) {
      if (!files.has(path)) return false;
      files.delete(path);
      return true;
    },
    async readFile(path) {
      const bytes = files.get(path);
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    async readFileBytes(path) {
      return files.get(path) ?? null;
    },
  };
  return { api, files };
}

function fakeRequireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id: "u1", email: "u1@example.com", role: "user" });
    await next();
  };
}

function sessionRow(): CraftSessionRow {
  return {
    id: SESSION_ID,
    userId: "u1",
    name: null,
    status: "active",
    lastActivityAt: new Date(),
    createdAt: new Date(),
    nextjsPort: null,
    sharingScope: "private",
    origin: "INTERACTIVE",
    opencodeSessionId: null,
    agentProvider: null,
    agentModel: null,
    skillsHash: null,
    mcpConfigHash: null,
  };
}

const fakeStore = (): CraftStore =>
  ({
    async getSession(id: string, userId: string) {
      return id === SESSION_ID && userId === "u1" ? sessionRow() : undefined;
    },
    async updateSessionActivity() {},
  }) as unknown as CraftStore;

const llmConfig: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

const TEMPLATE =
  "# Craft\n\n{{USER_CONTEXT}}{{ORGANIZATION_INSTRUCTIONS_SECTION}}";

const setupInput = {
  sessionId: SESSION_ID,
  config,
  llmConfig,
  agentsTemplate: TEMPLATE,
};

async function readText(
  files: Map<string, Uint8Array>,
  path: string,
): Promise<string> {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`missing ${path}`);
  return new TextDecoder().decode(bytes);
}

describe("appendAttachmentsSectionIfMissing", () => {
  test("no attachments → no append (and an absent attachments dir is not an error)", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
    });
    const appended = await appendAttachmentsSectionIfMissing(api, DIRECTORY);
    expect(appended).toBe(false);
    expect(await readText(files, `${DIRECTORY}/AGENTS.md`)).toBe(AGENTS_MD);
  });

  test("attachments present → appends verbatim with onyx's blank-line separator", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
      [`${DIRECTORY}/attachments/data.csv`]: "a,b\n1,2\n",
    });
    const appended = await appendAttachmentsSectionIfMissing(api, DIRECTORY);
    expect(appended).toBe(true);
    expect(await readText(files, `${DIRECTORY}/AGENTS.md`)).toBe(
      `${AGENTS_MD}\n\n${ATTACHMENTS_SECTION_CONTENT}`,
    );
  });

  test("idempotent: a second call does not duplicate the section", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
      [`${DIRECTORY}/attachments/data.csv`]: "a,b\n1,2\n",
    });
    expect(await appendAttachmentsSectionIfMissing(api, DIRECTORY)).toBe(true);
    expect(await appendAttachmentsSectionIfMissing(api, DIRECTORY)).toBe(false);
    const content = await readText(files, `${DIRECTORY}/AGENTS.md`);
    expect(content).toBe(`${AGENTS_MD}\n\n${ATTACHMENTS_SECTION_CONTENT}`);
    expect(content.split(ATTACHMENTS_HEADING).length - 1).toBe(1);
  });

  test("the constant carries the onyx heading and the required-actions core verbatim", () => {
    expect(ATTACHMENTS_SECTION_CONTENT.startsWith(ATTACHMENTS_HEADING)).toBe(
      true,
    );
    expect(ATTACHMENTS_SECTION_CONTENT).toContain(
      "**At the start of every task, you MUST:**",
    );
    expect(ATTACHMENTS_SECTION_CONTENT).toContain(
      "**Do NOT ignore user uploaded files.** They are there for a reason and likely\ncontain exactly what you need to complete the task successfully.",
    );
  });
});

describe("setupSessionWorkspace attachments section", () => {
  test("a session with pre-existing attachments gets the section at setup", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/attachments/existing.pdf`]: new Uint8Array([1, 2, 3]),
    });
    await setupSessionWorkspace(
      { ...api, mkdir: async () => undefined },
      setupInput,
    );
    const agentsMd = await readText(files, `${DIRECTORY}/AGENTS.md`);
    expect(agentsMd.endsWith(`\n\n${ATTACHMENTS_SECTION_CONTENT}`)).toBe(true);
  });

  test("a session without attachments keeps the plain AGENTS.md", async () => {
    const { api, files } = memoryFileApi();
    await setupSessionWorkspace(
      { ...api, mkdir: async () => undefined },
      setupInput,
    );
    const agentsMd = await readText(files, `${DIRECTORY}/AGENTS.md`);
    expect(agentsMd.includes(ATTACHMENTS_HEADING)).toBe(false);
  });

  test("an append failure does not fail the setup", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/attachments/existing.pdf`]: new Uint8Array([1, 2, 3]),
    });
    const original = api.readFile;
    api.readFile = async (path) => {
      if (path.endsWith("/AGENTS.md")) throw new Error("read blew up");
      return original(path);
    };
    await setupSessionWorkspace(
      { ...api, mkdir: async () => undefined },
      setupInput,
    ); // must not throw
    expect(files.has(`${DIRECTORY}/opencode.json`)).toBe(true);
  });
});

describe("upload success path appends the section", () => {
  const routes = (api: AgentSandboxFileApi) =>
    createFileRoutes(fakeRequireUser(), {
      config,
      store: fakeStore(),
      gateway: { fileApiFor: () => api } as unknown as SandboxGateway,
      botIdFor: async () => "craft",
    });

  async function upload(api: AgentSandboxFileApi, name: string) {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], name));
    return routes(api).fetch(
      new Request(`http://test/sessions/${SESSION_ID}/upload`, {
        method: "POST",
        body: form,
      }),
    );
  }

  test("the first upload appends the section to AGENTS.md", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
    });
    const response = await upload(api, "data.csv");
    expect(response.status).toBe(200);
    expect(await readText(files, `${DIRECTORY}/AGENTS.md`)).toBe(
      `${AGENTS_MD}\n\n${ATTACHMENTS_SECTION_CONTENT}`,
    );
  });

  test("a second upload does not duplicate the section", async () => {
    const { api, files } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
    });
    expect((await upload(api, "a.csv")).status).toBe(200);
    expect((await upload(api, "b.csv")).status).toBe(200);
    const agentsMd = await readText(files, `${DIRECTORY}/AGENTS.md`);
    expect(agentsMd.split(ATTACHMENTS_HEADING).length - 1).toBe(1);
  });

  test("an append failure does not fail the upload", async () => {
    const { api } = memoryFileApi({
      [`${DIRECTORY}/AGENTS.md`]: AGENTS_MD,
    });
    const original = api.readFile;
    api.readFile = async (path) => {
      if (path.endsWith("/AGENTS.md")) throw new Error("read blew up");
      return original(path);
    };
    const response = await upload(api, "data.csv");
    expect(response.status).toBe(200);
  });
});
