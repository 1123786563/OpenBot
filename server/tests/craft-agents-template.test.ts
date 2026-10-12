import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  generateAgentInstructions,
  type GenerateAgentInstructionsInput,
} from "../src/craft/agent-instructions";
import { loadCraftConfig } from "../src/craft/config";

/**
 * The shipped template — the calibration target. It must be the onyx original
 * (`features/build/AGENTS.template.md`) verbatim except for the ported infrastructure
 * wording (egress-proxy Hard rules, webapp tool entry) and the cut sections OpenBot has
 * no counterpart for (connectable apps, company-search).
 */
const template = readFileSync(
  new URL("../src/craft/AGENTS.template.md", import.meta.url),
  "utf8",
);

/** onyx's placeholder set minus the cut `{{CONNECTABLE_APPS_LIST}}`. */
const RENDERED_PLACEHOLDERS = [
  "USER_CONTEXT",
  "DISABLED_TOOLS_SECTION",
  "ORGANIZATION_INSTRUCTIONS_SECTION",
  "LLM_PROVIDER_NAME",
  "LLM_MODEL_NAME",
  "APPROVAL_WAIT_TIMEOUT_SECONDS",
  "APPROVAL_CLIENT_TIMEOUT_SECONDS",
] as const;

function render(
  overrides: Partial<GenerateAgentInstructionsInput> = {},
): string {
  return generateAgentInstructions({
    template,
    config: loadCraftConfig({}),
    provider: "anthropic",
    modelName: "claude-test-1",
    disabledTools: ["question"],
    userName: "Ada",
    organizationInstructions: "Prefer concise replies.",
    ...overrides,
  });
}

describe("AGENTS.template.md calibration", () => {
  test("carries exactly onyx's seven placeholders", () => {
    for (const name of RENDERED_PLACEHOLDERS) {
      expect(template).toContain(`{{${name}}}`);
    }
    // Seven occurrences total: each placeholder exactly once, nothing extra.
    expect(template.match(/\{\{/g)?.length ?? 0).toBe(
      RENDERED_PLACEHOLDERS.length,
    );
    // The connectable-apps placeholder is cut with its section (no external-app domain).
    expect(template).not.toContain("{{CONNECTABLE_APPS_LIST}}");
  });

  test("renders every placeholder — no residue left", () => {
    const rendered = render();
    expect(rendered).not.toContain("{{");
    expect(rendered).toContain("You are assisting **Ada** with their work.");
    expect(rendered).toContain("Your LLM is Anthropic / claude-test-1.");
    expect(rendered).toContain("**Disabled Tools**: question");
    expect(rendered).toContain("## Organization instructions");
    expect(rendered).toContain("Prefer concise replies.");
  });

  test("renders clean for a bare session too (no name, no org text)", () => {
    const rendered = render({
      userName: null,
      organizationInstructions: null,
      disabledTools: null,
    });
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("You are assisting");
    expect(rendered).not.toContain("## Organization instructions");
    expect(rendered).not.toContain("Disabled Tools");
  });

  test("renders the approval window with onyx's numbers (180 / 200)", () => {
    const rendered = render();
    expect(rendered).toContain("**180 seconds**");
    expect(rendered).toContain("**at least 200 seconds**");
  });

  test("derives both numbers from the configured wait window", () => {
    const rendered = render({
      config: loadCraftConfig({
        OPENBOT_CRAFT_SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS: "60",
      }),
    });
    expect(rendered).toContain("**60 seconds**");
    expect(rendered).toContain("**at least 80 seconds**"); // wait + fixed 20s margin
  });

  test("keeps onyx Hard rule 4 verbatim", () => {
    expect(render()).toContain(
      "- **Never** state a fact that isn't grounded in a retrieved source or an attachment. If you\n" +
        "  don't have the data, search again or say so. Do not guess or fabricate.",
    );
  });

  test("keeps the onyx turn-budget notice marker verbatim", () => {
    expect(render()).toContain("`[Onyx turn budget]` notices to tool results");
  });

  test("the cut sections stay cut", () => {
    const rendered = render();
    expect(rendered).not.toContain("## Connectable apps");
    expect(rendered).not.toContain("{{CONNECTABLE_APPS_LIST}}");
    expect(rendered).not.toContain("connect_app");
    expect(rendered).not.toContain("## Company knowledge");
    expect(rendered).not.toContain("company-search");
  });

  test("admin text with literal {{…}} tokens is never expanded (last-substitution order)", () => {
    const rendered = render({
      organizationInstructions: "Literal {{USER_CONTEXT}} stays put.",
    });
    expect(rendered).toContain("Literal {{USER_CONTEXT}} stays put.");
  });
});
