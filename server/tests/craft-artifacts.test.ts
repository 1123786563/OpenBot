import { describe, expect, test } from "bun:test";
import {
  listArtifacts,
  listFiles,
  readWorkspaceFile,
} from "../src/craft/artifacts";
import type { AgentSandboxFileApi } from "../src/craft/sandbox-gateway";

const DIRECTORY = "/workspace/sessions/cs-test";

/** A bare file API whose listing is the flat path array opencode's /file returns. */
function fileApi(
  overrides: Partial<AgentSandboxFileApi> = {},
): AgentSandboxFileApi {
  return {
    listFiles: async () => [],
    writeFile: async () => undefined,
    writeFileBytes: async () => undefined,
    deletePath: async () => false,
    readFile: async () => null,
    readFileBytes: async () => null,
    ...overrides,
  };
}

describe("listArtifacts (outputs/ gallery scan)", () => {
  test("classifies each output and drops hidden/temp entries", async () => {
    const api = fileApi({
      listFiles: async (path: string) => {
        expect(path).toBe(`${DIRECTORY}/outputs`);
        return [
          `${DIRECTORY}/outputs/report.html`,
          `${DIRECTORY}/outputs/data.csv`,
          `${DIRECTORY}/outputs/app/index.html`,
          `${DIRECTORY}/outputs/._preview.ppt.parts`,
          `${DIRECTORY}/outputs/.DS_Store`,
        ];
      },
    });
    const artifacts = await listArtifacts("bot-1", DIRECTORY, api);
    expect(artifacts).toHaveLength(3);
    const byPath = new Map(artifacts.map((a) => [a.path, a.type]));
    expect(byPath.get("outputs/report.html")).toBe("report");
    expect(byPath.get("outputs/data.csv")).toBe("csv");
    expect(byPath.get("outputs/app/index.html")).toBe("webapp");
  });

  test("an unreachable sandbox degrades to an empty gallery", async () => {
    const api = fileApi({
      listFiles: async () => {
        throw new Error("gateway down");
      },
    });
    const artifacts = await listArtifacts("bot-1", DIRECTORY, api);
    expect(artifacts).toEqual([]);
  });
});

describe("listFiles (Files tab, one directory)", () => {
  test("dirs-first listing with the anchor stripped", async () => {
    const api = fileApi({
      listFiles: async (path: string) => {
        expect(path).toBe(`${DIRECTORY}/outputs`);
        return [
          `${DIRECTORY}/outputs/report.html`,
          `${DIRECTORY}/outputs/app/index.html`,
          `${DIRECTORY}/outputs/app/main.tsx`,
        ];
      },
    });
    const entries = await listFiles("bot-1", DIRECTORY, "outputs", api);
    expect(entries.map((e) => [e.path, e.kind])).toEqual([
      ["outputs/app", "dir"],
      ["outputs/report.html", "file"],
    ]);
  });

  test("filters with onyx's HIDDEN_PATTERNS, the same predicate the ZIP walk uses (F6 §C)", async () => {
    const api = fileApi({
      listFiles: async () => [
        `${DIRECTORY}/outputs/report.md`,
        `${DIRECTORY}/outputs/node_modules/pkg/index.js`, // HIDDEN_PATTERNS dir
        `${DIRECTORY}/outputs/.env`, // dot file
        `${DIRECTORY}/outputs/nextjs.log`, // HIDDEN_PATTERNS file name
        `${DIRECTORY}/outputs/src/app/page.tsx`,
      ],
    });
    const entries = await listFiles("bot-1", DIRECTORY, "outputs", api);
    // The file tree a user browses and the archive a user downloads can never
    // disagree about what exists — onyx runs both through _is_hidden_workspace_entry.
    expect(entries.map((e) => e.path)).toEqual([
      "outputs/src",
      "outputs/report.md",
    ]);
  });
});

describe("readWorkspaceFile", () => {
  test("returns the gateway's text verbatim", async () => {
    const api = fileApi({ readFile: async () => "a,b\nc,d" });
    const text = await readWorkspaceFile(
      "bot-1",
      `${DIRECTORY}/opencode.json`,
      api,
    );
    expect(text).toBe("a,b\nc,d");
  });

  test("null flows through (absent/non-text)", async () => {
    const api = fileApi({ readFile: async () => null });
    const text = await readWorkspaceFile(
      "bot-1",
      `${DIRECTORY}/opencode.json`,
      api,
    );
    expect(text).toBeNull();
  });
});
