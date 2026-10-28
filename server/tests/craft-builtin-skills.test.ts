import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  builtinSkillFilesFor,
  renderConnectorSkillTemplate,
  serverBacksConnectorSkill,
} from "../src/craft/builtin-skills/index";
import {
  createCraftManagedContentResolver,
  type CraftManagedContentSources,
} from "../src/craft/managed-content";
import type { CraftConfig } from "../src/craft/config";
import { loadCraftConfig } from "../src/craft/config";
import type { CraftSessionRow } from "../src/craft/store";

const CONNECTOR_SKILLS = [
  "github",
  "gmail",
  "google-calendar",
  "google-drive",
  "hubspot",
  "linear",
  "notion",
  "slack",
] as const;

function session(): CraftSessionRow {
  return {
    id: "cs-bs",
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

function sources(
  overrides: Partial<CraftManagedContentSources> = {},
): CraftManagedContentSources {
  return {
    connectableAppsFor: async () => [],
    webTemplateFilesFor: async () => new Map<string, Uint8Array>(),
    skillFilesFor: async () => new Map<string, Uint8Array>(),
    ...overrides,
  };
}

const baseConfig: CraftConfig = loadCraftConfig({});

// ── the fileset ─────────────────────────────────────────────────────────────

describe("builtinSkillFilesFor", () => {
  test("unconditional skills ship verbatim: pptx tree + craft-documentation", async () => {
    const files = await builtinSkillFilesFor({ connectedServerIds: new Set() });
    expect(files.has("pptx/SKILL.md")).toBe(true);
    expect(files.has("pptx/charts.md")).toBe(true);
    expect(files.has("pptx/scripts/office/pack.py")).toBe(true);
    expect(files.has("craft-documentation/SKILL.md")).toBe(true);
    // The module's own source never ships (smoke: index.ts once landed in a
    // session's skills directory).
    expect(files.has("index.ts")).toBe(false);
    // The whole onyx pptx tree (83 files), not a trimmed stub.
    let pptxCount = 0;
    for (const path of files.keys()) if (path.startsWith("pptx/")) pptxCount++;
    expect(pptxCount).toBe(83);
  });

  test("no connections ship no connector skills", async () => {
    const files = await builtinSkillFilesFor({ connectedServerIds: new Set() });
    for (const skill of CONNECTOR_SKILLS) {
      expect(files.has(`${skill}/SKILL.md`)).toBe(false);
    }
  });

  test("a connection ships exactly its own connector skill", async () => {
    const files = await builtinSkillFilesFor({ connectedServerIds: new Set(["github"]) });
    expect(files.has("github/SKILL.md")).toBe(true);
    for (const skill of CONNECTOR_SKILLS) {
      if (skill !== "github") {
        expect(files.has(`${skill}/SKILL.md`)).toBe(false);
      }
    }
  });

  test("brokered ids (composio-github / open-connector-slack) back their skill", async () => {
    const files = await builtinSkillFilesFor({
      connectedServerIds: new Set(["composio-github", "open-connector-slack"]),
    });
    expect(files.has("github/SKILL.md")).toBe(true);
    expect(files.has("slack/SKILL.md")).toBe(true);
    expect(files.has("notion/SKILL.md")).toBe(false);
  });

  test("connector templates render on load: no .template suffix, no placeholder", async () => {
    const files = await builtinSkillFilesFor({ connectedServerIds: new Set([...CONNECTOR_SKILLS]) });
    for (const skill of CONNECTOR_SKILLS) {
      const rendered = new TextDecoder().decode(files.get(`${skill}/SKILL.md`));
      expect(rendered).not.toContain("{{");
      expect(rendered).toContain(`name: ${skill}`);
      // The divergence ledger the port-parity plan mandates travels with the file.
      expect(rendered).toContain("Ported from onyx");
    }
  });
});

// ── the gating seam ─────────────────────────────────────────────────────────

describe("serverBacksConnectorSkill", () => {
  test("matches catalogue keys, brokered prefixes, and nothing else", () => {
    expect(serverBacksConnectorSkill("github", "github")).toBe(true);
    expect(serverBacksConnectorSkill("composio-github", "github")).toBe(true);
    expect(serverBacksConnectorSkill("open-connector-slack", "slack")).toBe(
      true,
    );
    expect(serverBacksConnectorSkill("notion", "github")).toBe(false);
    expect(serverBacksConnectorSkill("my-custom-server", "github")).toBe(
      false,
    );
    // A slug must end on its own segment, not merely share characters.
    expect(serverBacksConnectorSkill("composio-hubspotx", "hubspot")).toBe(
      false,
    );
  });
});

// ── rendering ───────────────────────────────────────────────────────────────

describe("renderConnectorSkillTemplate", () => {
  test("strips the availability placeholder with its trailing blank line", () => {
    const rendered = renderConnectorSkillTemplate(
      "Intro\n\n{{ACTION_AVAILABILITY_SECTION}}\n\n## Usage\n",
    );
    expect(rendered).toBe("Intro\n\n## Usage\n");
  });

  test("any other unresolved markup fails loudly, not silently", () => {
    expect(() =>
      renderConnectorSkillTemplate("{{AVAILABLE_SOURCES_SECTION}}"),
    ).toThrow(/Unresolved skill-template markup/);
  });
});

// ── integration with the managed-content hash ────────────────────────────────

describe("managed-content skills leg integration", () => {
  test("builtin skills enter the skills hash (staleness reload rides on it)", async () => {
    const empty = await createCraftManagedContentResolver(sources())(session());
    const withSkills = await createCraftManagedContentResolver(
      sources({
        skillFilesFor: () => builtinSkillFilesFor({ connectedServerIds: new Set(["github"]) }),
      }),
    )(session());
    expect(withSkills?.skillFiles.has("github/SKILL.md")).toBe(true);
    expect(withSkills?.skillsHash).not.toBe(empty?.skillsHash);
  });

  test("a connection change flips the hash: the connector gate is hash-visible", async () => {
    const before = await createCraftManagedContentResolver(
      sources({ skillFilesFor: () => builtinSkillFilesFor({ connectedServerIds: new Set() }) }),
    )(session());
    const after = await createCraftManagedContentResolver(
      sources({
        skillFilesFor: () => builtinSkillFilesFor({ connectedServerIds: new Set(["slack"]) }),
      }),
    )(session());
    expect(after?.skillsHash).not.toBe(before?.skillsHash);
  });
});
