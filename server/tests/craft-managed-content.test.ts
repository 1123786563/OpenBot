import { describe, expect, test } from "../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
import {
  buildConnectableAppsList,
  type ConnectableApp,
} from "../src/craft/agent-instructions";
import type { CraftConfig } from "../src/craft/config";
import { loadCraftConfig } from "../src/craft/config";
import {
  type ConnectableAppServerRow,
  type CraftManagedContentSources,
  createCraftManagedContentResolver,
  materializeManagedContent,
  personalUnconnectedApps,
} from "../src/craft/managed-content";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import type { SandboxGateway } from "../src/craft/sandbox-gateway";
import { ensureSessionReady } from "../src/craft/session-ready";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { sessionDirectory } from "../src/craft/workspace";

/**
 * The managed-content layer — the port of onyx's build_managed_content_payload /
 * push_managed_content (session/sandbox_lifecycle.py) over OpenBot's app and
 * knowledge sources: the resolver (section + skills + MCP fingerprints) and the
 * workspace materialization (skills under .opencode/skills, library beside them),
 * with the session-create ordering AGENTS.md depends on.
 *
 * The hash formula is the fixture's reproducible one (agents-md-rendering.md,
 * onyx push.py:65-76): sha256 over u64be(len) || section || sorted len-prefixed
 * skill files.
 */

const encoder = new TextEncoder();
const USER_ID = "u1";

function u64be(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return buf;
}

/** The fixture-F2 hash, recomputed independently of skills.ts. */
function expectedSkillsHash(
  section: string,
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const digest = createHash("sha256");
  const sectionBytes = Buffer.from(section, "utf8");
  digest.update(u64be(sectionBytes.length));
  digest.update(sectionBytes);
  for (const path of [...files.keys()].sort()) {
    const pathBytes = Buffer.from(path, "utf8");
    const content = files.get(path)!;
    digest.update(u64be(pathBytes.length));
    digest.update(pathBytes);
    digest.update(u64be(content.length));
    digest.update(content);
  }
  return digest.digest("hex");
}

function sources(
  overrides: Partial<CraftManagedContentSources> = {},
): CraftManagedContentSources {
  return {
    connectableAppsFor: async () => [],
    // The template leg defaults to empty here so per-leg assertions (exact
    // file sets, hydration booleans) stay about their own leg; the bundled
    // default source has its own dedicated test.
    webTemplateFilesFor: async () => new Map<string, Uint8Array>(),
    ...overrides,
  };
}

function session(overrides: Partial<CraftSessionRow> = {}): CraftSessionRow {
  return {
    id: "cs-mc",
    userId: USER_ID,
    name: null,
    status: "initializing",
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
    ...overrides,
  };
}

// ── resolveCraftManagedContent (via the resolver factory) ─────────────────────

describe("createCraftManagedContentResolver", () => {
  test("resolves for the session's user, not a deployment-wide id", async () => {
    const seen: string[] = [];
    const resolver = createCraftManagedContentResolver(
      sources({
        connectableAppsFor: async (userId) => {
          seen.push(userId);
          return [{ id: "7", name: "Slack" }];
        },
      }),
    );
    const content = await resolver(session());
    expect(seen).toEqual([USER_ID]);
    expect(content?.connectableAppsSection).toBe(
      "- External app ID `7`: **Slack**",
    );
  });

  test("empty sources render the no-app fallback and hash it (fixture F1)", async () => {
    const resolver = createCraftManagedContentResolver(sources());
    const content = await resolver(session());
    expect(content?.connectableAppsSection).toBe(
      "No connectable apps available.",
    );
    expect(content?.skillsHash).toBe(
      expectedSkillsHash("No connectable apps available.", new Map()),
    );
    expect(content?.skillFiles.size).toBe(0);
    expect(content?.mcpServers).toEqual([]);
  });

  test("fixture F2: the section alone determines the hash over an empty fileset", async () => {
    const apps: ConnectableApp[] = [{ id: "7", name: "Slack" }];
    const resolver = createCraftManagedContentResolver(
      sources({ connectableAppsFor: async () => apps }),
    );
    const content = await resolver(session());
    const section = buildConnectableAppsList(apps);
    expect(content?.skillsHash).toBe(expectedSkillsHash(section, new Map()));
  });

  test("a delivered skill file changes the hash (the formula covers both inputs)", async () => {
    const files = new Map([["search/SKILL.md", encoder.encode("do a search")]]);
    const resolver = createCraftManagedContentResolver(
      sources({ skillFilesFor: async () => files }),
    );
    const content = await resolver(session());
    expect(content?.skillsHash).toBe(
      expectedSkillsHash("No connectable apps available.", files),
    );
    const empty = await createCraftManagedContentResolver(sources())(session());
    expect(content?.skillsHash).not.toBe(empty?.skillsHash);
  });

  test("mcpServers enter the fingerprint hash, not the skills hash", async () => {
    const resolver = createCraftManagedContentResolver(
      sources({
        mcpServersFor: async () => [
          {
            key: "notion",
            url: "https://mcp.notion.test/mcp",
            disabledTools: [],
          },
        ],
      }),
    );
    const content = await resolver(session());
    const empty = await createCraftManagedContentResolver(sources())(session());
    expect(content?.mcpConfigHash).not.toBe(empty?.mcpConfigHash);
    expect(content?.skillsHash).toBe(empty?.skillsHash);
  });

  test("library files ride along un-hashed", async () => {
    const library = new Map([["notes.md", encoder.encode("hello")]]);
    const resolver = createCraftManagedContentResolver(
      sources({ libraryFilesFor: async () => library }),
    );
    const content = await resolver(session());
    expect(content?.libraryFiles).toBe(library);
    const without = await createCraftManagedContentResolver(sources())(
      session(),
    );
    expect(content?.skillsHash).toBe(without?.skillsHash);
  });

  test("web template files ride along un-hashed (not part of the agent-visible skill surface)", async () => {
    const template = new Map([
      ["package.json", encoder.encode('{"name":"web"}')],
      ["app/page.tsx", encoder.encode("export default () => null;")],
    ]);
    const resolver = createCraftManagedContentResolver(
      sources({ webTemplateFilesFor: async () => template }),
    );
    const content = await resolver(session());
    expect(content?.webTemplateFiles).toBe(template);
    // The template is static server content: it must not enter the skills
    // hash, or a template bump would hot-reload every live session.
    const without = await createCraftManagedContentResolver(
      sources({ webTemplateFilesFor: async () => new Map() }),
    )(session());
    expect(content?.skillsHash).toBe(without?.skillsHash);
  });

  test("the default web template source reads the server-bundled onyx tree (dotfiles included)", async () => {
    // Explicit undefined override: the sources() factory injects an empty
    // template leg by default (see its comment), so this test must opt out
    // to exercise the bundled default.
    const content = await createCraftManagedContentResolver(
      sources({ webTemplateFilesFor: undefined }),
    )(session());
    expect(content?.webTemplateFiles.has("package.json")).toBe(true);
    expect(content?.webTemplateFiles.has("bun.lock")).toBe(true);
    expect(content?.webTemplateFiles.has(".oxlintrc.json")).toBe(true);
    // The tree is much larger than a stub — the ported onyx template.
    expect(content?.webTemplateFiles.size).toBeGreaterThan(50);
    // Cached: a second resolution answers the same map instance.
    const again = await createCraftManagedContentResolver(
      sources({ webTemplateFilesFor: undefined }),
    )(session());
    expect(again?.webTemplateFiles).toBe(content?.webTemplateFiles);
  });

  test("a failing app source propagates (resolution must succeed before AGENTS.md)", async () => {
    const resolver = createCraftManagedContentResolver(
      sources({
        connectableAppsFor: async () => {
          throw new Error("app store down");
        },
      }),
    );
    await expect(resolver(session())).rejects.toThrow("app store down");
  });
});

// ── personalUnconnectedApps (the boot file's connectableAppsFor filter) ──────

describe("personalUnconnectedApps", () => {
  test("answers personal unconnected apps only (shared and already-connected never appear)", () => {
    const servers = [
      { id: "slack", title: "Slack", accountMode: "personal" },
      { id: "notion", title: "Notion", accountMode: "personal" },
      // A shared/deployment-account app answers for everybody — never advice to connect.
      { id: "teamdrive", title: "Team Drive", accountMode: "shared" },
      // A row that acts in no account at all.
      { id: "shell", title: "Shell", accountMode: null },
    ] satisfies ConnectableAppServerRow[];
    // The connected set merges both shapes index.ts reads (the person's own vault
    // credential and their brokered account) — under either, the app is connected.
    expect(personalUnconnectedApps(servers, new Set(["notion"]))).toEqual([
      { id: "slack", name: "Slack" },
    ]);
    expect(personalUnconnectedApps(servers, new Set())).toEqual([
      { id: "slack", name: "Slack" },
      { id: "notion", name: "Notion" },
    ]);
  });
});

// ── materializeManagedContent ─────────────────────────────────────────────────

type WriteLog = Array<
  | { kind: "delete"; path: string }
  | { kind: "bytes"; path: string; bytes: Uint8Array }
>;

function memoryFileApi(
  input: {
    failPaths?: RegExp;
    failDelete?: boolean;
    /** Rejects listings whose path matches, with the given error (the gateway's throw shape). */
    failListWith?: (path: string) => Error | null;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const log: WriteLog = [];
  return {
    files,
    log,
    async writeFileBytes(path: string, bytes: Uint8Array) {
      log.push({ kind: "bytes", path, bytes });
      if (input.failPaths?.test(path)) throw new Error("sandbox down");
      files.set(path, bytes);
    },
    async listFiles(path: string) {
      const failure = input.failListWith?.(path);
      if (failure) throw failure;
      return [...files.keys()].filter((key) => key.startsWith(`${path}/`));
    },
    async deletePath(path: string) {
      log.push({ kind: "delete", path });
      if (input.failDelete) throw new Error("sandbox down");
      // The gateway's delete verb is files-only: one path, gone.
      files.delete(path);
      return true;
    },
  };
}

async function contentWith(
  overrides: Partial<
    Parameters<typeof createCraftManagedContentResolver>[0]
  > = {},
) {
  const resolver = createCraftManagedContentResolver(sources(overrides));
  return (await resolver(session()))!;
}

describe("materializeManagedContent", () => {
  test("delivers skill files under .opencode/skills and library under user_library", async () => {
    const api = memoryFileApi();
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([
          ["search/SKILL.md", encoder.encode("search!")],
          ["search/extra.md", encoder.encode("extra")],
        ]),
      libraryFilesFor: async () =>
        new Map([["notes/todo.md", encoder.encode("buy milk")]]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    expect(hydrated).toBe(true);
    expect(api.files.get("cs-mc/.opencode/skills/search/SKILL.md")).toEqual(
      encoder.encode("search!"),
    );
    expect(api.files.get("cs-mc/.opencode/skills/search/extra.md")).toEqual(
      encoder.encode("extra"),
    );
    expect(api.files.get("cs-mc/user_library/notes/todo.md")).toEqual(
      encoder.encode("buy milk"),
    );
  });

  test("delivers web template files under .openbot/web-template (the start-webapp.sh scaffold source)", async () => {
    const api = memoryFileApi();
    const content = await contentWith({
      webTemplateFilesFor: async () =>
        new Map([
          ["package.json", encoder.encode('{"name":"web"}')],
          [".oxlintrc.json", encoder.encode("{}")],
          ["app/page.tsx", encoder.encode("page")],
        ]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    expect(hydrated).toBe(true);
    expect(api.files.get("cs-mc/.openbot/web-template/package.json")).toEqual(
      encoder.encode('{"name":"web"}'),
    );
    expect(
      api.files.get("cs-mc/.openbot/web-template/.oxlintrc.json"),
    ).toEqual(encoder.encode("{}"));
    expect(
      api.files.get("cs-mc/.openbot/web-template/app/page.tsx"),
    ).toEqual(encoder.encode("page"));
  });

  test("rejects path-escaping web template entries; a failed template write never fails hydration", async () => {
    const api = memoryFileApi({ failPaths: /page\.tsx$/ });
    const content = await contentWith({
      webTemplateFilesFor: async () =>
        new Map([
          ["../escape.tsx", encoder.encode("no")],
          ["package.json", encoder.encode("{}")],
          ["app/page.tsx", encoder.encode("doomed")],
        ]),
    });
    // The template leg is the library's contract: pushed best-effort, never
    // hashed — a failed write degrades to "no scaffold", not a retry loop.
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    expect(hydrated).toBe(true);
    expect([...api.files.keys()]).toEqual([
      "cs-mc/.openbot/web-template/package.json",
    ]);
  });

  test("clears the skills tree before writing (a removed skill must not linger)", async () => {
    const api = memoryFileApi();
    api.files.set(
      "cs-mc/.opencode/skills/old/SKILL.md",
      encoder.encode("stale"),
    );
    const content = await contentWith();
    await materializeManagedContent(api, "cs-mc", content);
    expect([...api.files.keys()].some((key) => key.includes("/old/"))).toBe(
      false,
    );
    // Cleared file-by-file (the gateway's delete verb refuses directories).
    expect(api.log[0]).toEqual({
      kind: "delete",
      path: "cs-mc/.opencode/skills/old/SKILL.md",
    });
  });

  test("rejects path-escaping entries without writing them (containment)", async () => {
    const api = memoryFileApi();
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([
          ["../escape.md", encoder.encode("no")],
          ["/absolute.md", encoder.encode("no")],
          ["ok/SKILL.md", encoder.encode("yes")],
        ]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    expect(hydrated).toBe(false);
    expect([...api.files.keys()]).toEqual([
      "cs-mc/.opencode/skills/ok/SKILL.md",
    ]);
  });

  test("a failing write fails hydration (the hash must not ack a failed push)", async () => {
    const api = memoryFileApi({ failPaths: /SKILL\.md$/ });
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([["search/SKILL.md", encoder.encode("doomed")]]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    expect(hydrated).toBe(false);
  });

  test("an empty fileset hydrates trivially (nothing to fail)", async () => {
    const api = memoryFileApi();
    const content = await contentWith();
    expect(await materializeManagedContent(api, "cs-mc", content)).toBe(true);
  });

  test("a stale skill file that refuses to delete fails hydration (it would linger under the acked hash)", async () => {
    const api = memoryFileApi({ failDelete: true });
    api.files.set(
      "cs-mc/.opencode/skills/old/SKILL.md",
      encoder.encode("undeletable"),
    );
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([["search/SKILL.md", encoder.encode("fresh")]]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    // The new file still landed, but the push cannot claim the hash while the
    // old skill it could not clear still sits in the tree.
    expect(hydrated).toBe(false);
    expect(
      api.files.get("cs-mc/.opencode/skills/search/SKILL.md"),
    ).toBeDefined();
    expect(api.files.has("cs-mc/.opencode/skills/old/SKILL.md")).toBe(true);
  });

  // ── the listing contract (finding F-C's family, OCR bug·medium) ───────────────
  // The gateway's listing 404s for an absent directory — a FRESH workspace, where
  // there is simply nothing stale to clear; every other listing failure is real and
  // must fail hydration so the skills hash is never acked over an unknown tree.

  test("a 404 listing is a fresh workspace: nothing to clear, hydration succeeds", async () => {
    const api = memoryFileApi({
      failListWith: (path) =>
        path.endsWith("/.opencode/skills")
          ? new Error(`Sandbox /file?path=${path} answered 404.`)
          : null,
    });
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([["search/SKILL.md", encoder.encode("hi")]]),
    });
    expect(await materializeManagedContent(api, "cs-mc", content)).toBe(true);
    expect(
      api.files.get("cs-mc/.opencode/skills/search/SKILL.md"),
    ).toBeDefined();
  });

  test("a real listing failure fails hydration — no skills ack over an unreconciled tree", async () => {
    const api = memoryFileApi({
      failListWith: (path) =>
        path.endsWith("/.opencode/skills")
          ? new Error(`Sandbox /file?path=${path} answered 500.`)
          : null,
    });
    // A stale skill IS on disk, but the listing could not see it — the old code
    // swallowed the failure (stale=[]), skipped the clear, and still acked.
    api.files.set(
      "cs-mc/.opencode/skills/old/SKILL.md",
      encoder.encode("would linger"),
    );
    const content = await contentWith({
      skillFilesFor: async () =>
        new Map([["search/SKILL.md", encoder.encode("fresh")]]),
    });
    const hydrated = await materializeManagedContent(api, "cs-mc", content);
    // The push still lands what it can (writes are independent legs), but the
    // ack must not claim a tree whose stale state was never reconciled.
    expect(hydrated).toBe(false);
    expect(
      api.files.get("cs-mc/.opencode/skills/search/SKILL.md"),
    ).toBeDefined();
  });
});

// ── ensureSessionReady ordering: resolve → push → AGENTS.md → finalize ────────

const config: CraftConfig = loadCraftConfig({
  sessionDirectoryMode: undefined,
});
const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

function readyHarness(input: {
  failSkillWrite?: boolean;
  failAgentsWrite?: boolean;
  workspaceExists?: boolean;
}) {
  const files = new Map<string, Uint8Array | string>();
  const writeOrder: string[] = [];
  const finalized: unknown[] = [];
  const updated: Array<Record<string, unknown>> = [];
  const store = {
    async updateSession(_id: string, patch: Record<string, unknown>) {
      updated.push(patch);
      return session({ ...patch } as Partial<CraftSessionRow>);
    },
    async finalizeSessionInitialization(input2: {
      sessionId: string;
      toStatus: string;
      opencodeSessionId?: string | null;
      skillsHash?: string | null;
      mcpConfigHash?: string | null;
    }) {
      finalized.push({ ...input2 });
      return true;
    },
  } as unknown as CraftStore;
  const gateway = {
    fileApiFor: () => ({
      async listFiles(path: string) {
        // The ready marker under .opencode is the completion sentinel; an intact
        // workspace answers with it (the /outputs listing is not the gate anymore).
        if (
          input.workspaceExists &&
          path.endsWith("/.opencode")
        ) {
          return [`${path}/craft-workspace-ready`];
        }
        // The real gateway's answer for an absent directory — the 404 shape the
        // materializer normalizes to a fresh workspace (finding F-C's family).
        throw new Error(`Sandbox /file?path=${path} answered 404.`);
      },
      async writeFile(path: string, content: string) {
        if (input.failAgentsWrite && path.endsWith("AGENTS.md")) {
          throw new Error("sandbox down");
        }
        writeOrder.push(path);
        files.set(path, content);
      },
      async writeFileBytes(path: string, bytes: Uint8Array) {
        if (input.failSkillWrite && path.endsWith("SKILL.md")) {
          throw new Error("sandbox down");
        }
        writeOrder.push(path);
        files.set(path, bytes);
      },
      async deletePath(path: string) {
        writeOrder.push(`delete:${path}`);
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${path}/`)) files.delete(key);
        }
        return true;
      },
      async readFile() {
        return null;
      },
      async readFileBytes() {
        return null;
      },
    }),
    workspaceApiFor: () => null,
    serveClientFor: () => ({
      async ensureSession() {
        return "ses_1";
      },
      async disposeInstance() {},
    }),
  } as unknown as SandboxGateway;
  return { files, writeOrder, finalized, updated, store, gateway };
}

describe("ensureSessionReady with managed content", () => {
  test("resolves first: a failed resolution writes no AGENTS.md and fails the session", async () => {
    const harness = readyHarness({});
    await expect(
      ensureSessionReady({
        db: {} as never,
        store: harness.store,
        gateway: harness.gateway,
        session: session(),
        botId: "craft",
        config,
        userName: "Ada",
        llmConfigFor: async () => llm,
        managedContentResolver: async () => {
          throw new Error("app store down");
        },
      }),
    ).rejects.toThrow("app store down");
    expect([...harness.files.keys()].some((k) => k.endsWith("AGENTS.md"))).toBe(
      false,
    );
    expect(harness.finalized).toEqual([
      { sessionId: "cs-mc", toStatus: "failed" },
    ]);
  });

  test("pushes skills before AGENTS.md; AGENTS.md carries the section; finalize acks after a successful push", async () => {
    const harness = readyHarness({});
    const resolver = createCraftManagedContentResolver(
      sources({
        connectableAppsFor: async () => [{ id: "7", name: "Slack" }],
        skillFilesFor: async () =>
          new Map([["search/SKILL.md", encoder.encode("do a search")]]),
      }),
    );
    await ensureSessionReady({
      db: {} as never,
      store: harness.store,
      gateway: harness.gateway,
      session: session(),
      botId: "craft",
      config,
      userName: "Ada",
      llmConfigFor: async () => llm,
      managedContentResolver: resolver,
    });
    const root = sessionDirectory("cs-mc", config.sessionDirectoryMode);
    // Push order: the skill file lands before AGENTS.md is written.
    expect(
      harness.writeOrder.indexOf(`${root}/.opencode/skills/search/SKILL.md`),
    ).toBeLessThan(harness.writeOrder.indexOf(`${root}/AGENTS.md`));
    // AGENTS.md renders the resolved connectable-apps section.
    expect(String(harness.files.get(`${root}/AGENTS.md`))).toContain(
      "- External app ID `7`: **Slack**",
    );
    // Finalize acks both hashes — the push succeeded.
    const content = await resolver(session());
    expect(harness.finalized).toEqual([
      {
        sessionId: "cs-mc",
        toStatus: "active",
        opencodeSessionId: "ses_1",
        skillsHash: content?.skillsHash,
        mcpConfigHash: content?.mcpConfigHash,
      },
    ]);
  });

  test("a failed skills push still finishes setup but acks no skills hash (retryable)", async () => {
    const harness = readyHarness({ failSkillWrite: true });
    const resolver = createCraftManagedContentResolver(
      sources({
        skillFilesFor: async () =>
          new Map([["search/SKILL.md", encoder.encode("doomed")]]),
      }),
    );
    await ensureSessionReady({
      db: {} as never,
      store: harness.store,
      gateway: harness.gateway,
      session: session(),
      botId: "craft",
      config,
      userName: "Ada",
      llmConfigFor: async () => llm,
      managedContentResolver: resolver,
    });
    const root = sessionDirectory("cs-mc", config.sessionDirectoryMode);
    // Setup completed around the failed push...
    expect(String(harness.files.get(`${root}/AGENTS.md`))).toContain(
      "AGENTS.md",
    );
    expect(harness.finalized).toEqual([
      {
        sessionId: "cs-mc",
        toStatus: "active",
        opencodeSessionId: "ses_1",
        // mcpConfigHash rides along (onyx records it regardless); the skills
        // hash is absent — only a successful push may ack it.
        skillsHash: undefined,
        mcpConfigHash: (await resolver(session()))?.mcpConfigHash,
      },
    ]);
  });

  test("an intact workspace re-pushes, re-renders AGENTS.md, and records hashes through the light path", async () => {
    const harness = readyHarness({ workspaceExists: true });
    const resolver = createCraftManagedContentResolver(
      sources({
        connectableAppsFor: async () => [{ id: "7", name: "Slack" }],
        skillFilesFor: async () =>
          new Map([["search/SKILL.md", encoder.encode("do a search")]]),
      }),
    );
    await ensureSessionReady({
      db: {} as never,
      store: harness.store,
      gateway: harness.gateway,
      session: session(),
      botId: "craft",
      config,
      userName: "Ada",
      llmConfigFor: async () => llm,
      managedContentResolver: resolver,
    });
    const root = sessionDirectory("cs-mc", config.sessionDirectoryMode);
    expect(
      harness.files.get(`${root}/.opencode/skills/search/SKILL.md`),
    ).toBeDefined();
    // The light path re-renders AGENTS.md from the resolved content: the skills
    // hash fingerprints the connectable-apps section, so a workspace whose
    // AGENTS.md predates the restored section must not be acked current over a
    // stale prompt (fixture F2's 注入面断言 — the workspace-setup write point).
    expect(String(harness.files.get(`${root}/AGENTS.md`))).toContain(
      "- External app ID `7`: **Slack**",
    );
    expect(harness.updated).toEqual([
      {
        status: "active",
        skillsHash: (await resolver(session()))?.skillsHash,
        mcpConfigHash: (await resolver(session()))?.mcpConfigHash,
      },
    ]);
  });

  test("the light path acks the hashes only after the AGENTS.md write landed", async () => {
    const harness = readyHarness({
      workspaceExists: true,
      failAgentsWrite: true,
    });
    const resolver = createCraftManagedContentResolver(
      sources({
        connectableAppsFor: async () => [{ id: "7", name: "Slack" }],
      }),
    );
    await expect(
      ensureSessionReady({
        db: {} as never,
        store: harness.store,
        gateway: harness.gateway,
        session: session(),
        botId: "craft",
        config,
        userName: "Ada",
        llmConfigFor: async () => llm,
        managedContentResolver: resolver,
      }),
    ).rejects.toThrow("sandbox down");
    // A failed render fails provisioning through the envelope — no hash ack, so
    // the retry re-renders instead of sitting current on a stale prompt.
    expect(harness.updated).toEqual([]);
    expect(harness.finalized).toEqual([
      { sessionId: "cs-mc", toStatus: "failed" },
    ]);
  });
});
