import { describe, expect, test } from "bun:test";
import type { CraftMCPServerConfig } from "../src/craft/opencode-config";
import {
  computeSkillRuntimeHash,
  craftMcpFingerprint,
  sessionRuntimeStale,
} from "../src/craft/skills";

type StalenessSession = Parameters<typeof sessionRuntimeStale>[0];

/** A session shaped to pass (or fail) the runtime-intact guards onyx checks first. */
function activeInteractiveSession(
  overrides: Partial<StalenessSession> = {},
): StalenessSession {
  return {
    status: "active",
    origin: "INTERACTIVE",
    opencodeSessionId: "opencode-1",
    skillsHash: null,
    mcpConfigHash: null,
    ...overrides,
  };
}

describe("sessionRuntimeStale", () => {
  test("a different skills hash makes a live runtime stale", () => {
    const session = activeInteractiveSession({ skillsHash: "abc" });
    expect(sessionRuntimeStale(session, "def", null)).toBe(true);
  });

  test("a matching skills hash is not stale", () => {
    const session = activeInteractiveSession({ skillsHash: "abc" });
    expect(sessionRuntimeStale(session, "abc", null)).toBe(false);
  });

  test("a different mcp_config hash makes a live runtime stale", () => {
    const session = activeInteractiveSession({ mcpConfigHash: "m1" });
    expect(sessionRuntimeStale(session, null, "m2")).toBe(true);
  });

  test("either signal alone triggers staleness", () => {
    const session = activeInteractiveSession({
      skillsHash: "abc",
      mcpConfigHash: "m1",
    });
    expect(sessionRuntimeStale(session, "abc", "m2")).toBe(true);
    expect(sessionRuntimeStale(session, "def", "m1")).toBe(true);
  });

  test("a null current hash never makes a runtime stale (nothing pushed)", () => {
    const session = activeInteractiveSession({ skillsHash: "abc" });
    expect(sessionRuntimeStale(session, null, null)).toBe(false);
  });

  test("non-active, non-interactive, or id-less sessions are never stale", () => {
    expect(
      sessionRuntimeStale(
        activeInteractiveSession({ status: "idle" }),
        "x",
        null,
      ),
    ).toBe(false);
    expect(
      sessionRuntimeStale(
        activeInteractiveSession({ origin: "SCHEDULED" }),
        "x",
        null,
      ),
    ).toBe(false);
    expect(
      sessionRuntimeStale(
        activeInteractiveSession({ opencodeSessionId: null }),
        "x",
        null,
      ),
    ).toBe(false);
  });
});

describe("computeSkillRuntimeHash", () => {
  const files: Record<string, Uint8Array> = {
    "search/SKILL.md": new TextEncoder().encode("do a search"),
    "company/SKILL.md": new TextEncoder().encode("org facts"),
  };

  test("is order-independent over the file map", () => {
    const reversed = Object.fromEntries(
      Object.entries(files)
        .reverse()
        .map(([k, v]) => [k, v]),
    );
    expect(computeSkillRuntimeHash(files, "apps")).toBe(
      computeSkillRuntimeHash(reversed, "apps"),
    );
  });

  test("reacts to a content change", () => {
    const changed = {
      ...files,
      "search/SKILL.md": new TextEncoder().encode("x"),
    };
    expect(computeSkillRuntimeHash(changed, "apps")).not.toBe(
      computeSkillRuntimeHash(files, "apps"),
    );
  });

  test("reacts to the connectable-apps section", () => {
    expect(computeSkillRuntimeHash(files, "apps")).not.toBe(
      computeSkillRuntimeHash(files, "other apps"),
    );
  });
});

describe("craftMcpFingerprint", () => {
  const srv = (
    key: string,
    url = "https://example.test",
    disabledTools: string[] = [],
  ): CraftMCPServerConfig => ({ key, url, disabledTools });

  test("is order-independent", () => {
    expect(craftMcpFingerprint([srv("a"), srv("b")])).toBe(
      craftMcpFingerprint([srv("b"), srv("a")]),
    );
  });

  test("reacts to each input", () => {
    const baseline = craftMcpFingerprint([srv("a")]);
    expect(craftMcpFingerprint([srv("a"), srv("b")])).not.toBe(baseline);
    expect(craftMcpFingerprint([])).not.toBe(baseline);
    expect(craftMcpFingerprint([srv("a", "https://other.test")])).not.toBe(
      baseline,
    );
    expect(
      craftMcpFingerprint([srv("a", "https://example.test", ["t"])]),
    ).not.toBe(baseline);
  });
});
