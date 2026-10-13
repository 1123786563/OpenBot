import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildConnectableAppsList,
  type GenerateAgentInstructionsInput,
  generateAgentInstructions,
} from "../src/craft/agent-instructions";
import { loadCraftConfig } from "../src/craft/config";

/**
 * The shipped template — the calibration target. It must be the onyx original
 * (`features/build/AGENTS.template.md`) verbatim except for the ported
 * infrastructure wording (egress-proxy Hard rules, webapp tool entry — Task 4's
 * restore) and the environment facts that cannot be true in OpenBot (the
 * "numeric" app-id qualifier: OpenBot connector ids are string keys).
 *
 * The company-knowledge section is the one deliberate cut that remains: onyx
 * backs its `company-search` skill with an in-sandbox CLI over the permissioned
 * corpus, and OpenBot has no backed delivery path to the craft sandbox yet — a
 * prompt must not promise a missing tool. The section renders (byte-exact, from
 * the pinned constant) the day the managed-content seam delivers the skill.
 */
const template = readFileSync(
  new URL("../src/craft/AGENTS.template.md", import.meta.url),
  "utf8",
);

/** onyx's full placeholder set, restored with `{{CONNECTABLE_APPS_LIST}}`. */
const RENDERED_PLACEHOLDERS = [
  "USER_CONTEXT",
  "DISABLED_TOOLS_SECTION",
  "ORGANIZATION_INSTRUCTIONS_SECTION",
  "LLM_PROVIDER_NAME",
  "LLM_MODEL_NAME",
  "APPROVAL_WAIT_TIMEOUT_SECONDS",
  "APPROVAL_CLIENT_TIMEOUT_SECONDS",
  "CONNECTABLE_APPS_LIST",
] as const;

/**
 * onyx's rendered Connectable apps prose (fixture agents-md-rendering.md, from
 * `AGENTS.template.md:51-55`) with the one OpenBot substitution applied: "numeric
 * external app ID" → "external app ID" (OpenBot connector ids are string keys,
 * not numbers).
 */
const CONNECTABLE_PROSE =
  "Some org apps aren't set up for this user yet, so you can't call them until they're connected. " +
  "When the task needs one, call the `connect_app` tool with its external app ID from the list below; " +
  "once connected, it works like any other app. Never ask for or handle credentials yourself.";

function connectableSection(list: string): string {
  return `## Connectable apps\n\n${CONNECTABLE_PROSE}\n\n${list}`;
}

/**
 * onyx's Company knowledge section, byte-exact (`AGENTS.template.md:81-88`) —
 * the pinned constant the renderer splices in once a backed company-search
 * skill ships. Note the single leading space on " or label…" (onyx verbatim).
 */
const COMPANY_KNOWLEDGE_SECTION =
  "## Company knowledge\n\n" +
  "When the request relates to the user's work, use the `company-search` skill to search their\n" +
  "permissioned company corpus. Reformulate and re-search if results are weak, and stop once you\n" +
  "can answer. Cite every source by title and URL.\n" +
  "\n" +
  "If results are empty or weak, say so and name what you searched. Then ask the user for guidance,\n" +
  " or label any non-grounded content as general knowledge.";

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
  test("carries exactly onyx's eight placeholders", () => {
    for (const name of RENDERED_PLACEHOLDERS) {
      expect(template).toContain(`{{${name}}}`);
    }
    // Eight occurrences total: each placeholder exactly once, nothing extra.
    expect(template.match(/\{\{/g)?.length ?? 0).toBe(
      RENDERED_PLACEHOLDERS.length,
    );
  });

  test("the connectable-apps section is restored between layout and credentials", () => {
    expect(template).toContain(connectableSection("{{CONNECTABLE_APPS_LIST}}"));
  });

  test("renders every placeholder — no residue left", () => {
    const rendered = render({
      connectableAppsSection: "- External app ID `7`: **Slack**",
    });
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

  // ── fixture F5 + contract §4.1 #3/#4/#7: the webapp tool entry (Task 4 restore) ─

  test("Hard rule 5 directs at the webapp tool with the fallback script", () => {
    const rendered = render();
    // onyx's restored shape: the tool call first, both documented fallbacks,
    // and the no-own-server tail verbatim.
    expect(rendered).toContain("call the `webapp`");
    expect(rendered).toContain('tool with `action: "start"`');
    expect(rendered).toContain("safe to call repeatedly, and `status`/`logs`");
    expect(rendered).toContain(
      "(If the tool is unavailable, run `bash start-webapp.sh` from the session",
    );
    expect(rendered).toContain(
      "Never run `bun run dev` or start your own server.",
    );
  });

  test("environment substitution: onyx's scaffold semantics restored (the tool scaffolds)", () => {
    const rendered = render();
    // onyx's "It scaffolds outputs/web" is TRUE again: the template ships with
    // the server and materializes into the session (.openbot/web-template), so
    // the webapp tool scaffolds on start exactly as onyx's image template did.
    // The paragraph is onyx's lines 20-24 verbatim.
    expect(rendered).toContain(
      "- No web server is running initially. If your deliverable is a web app, call the `webapp`\n" +
        '  tool with `action: "start"` FIRST. It scaffolds `outputs/web`, installs deps, starts the\n' +
        "  dev server, and reports the port; safe to call repeatedly, and `status`/`logs` diagnose\n" +
        "  problems. (If the tool is unavailable, run `bash start-webapp.sh` from the session root.)\n" +
        "  Never run `bun run dev` or start your own server.",
    );
    expect(rendered).not.toContain("scaffold it under");
  });

  test("workspace layout names start-webapp.sh as the tool's fallback", () => {
    expect(render()).toContain(
      '├── start-webapp.sh    # fallback: use the `webapp` tool (action: "start") instead',
    );
  });

  test("the Outputs paragraph routes web apps through the tool + fallback", () => {
    const rendered = render();
    // onyx's lines 112-118 verbatim: the tool scaffolds.
    expect(rendered).toContain(
      'A web app requires calling the `webapp` tool with `action: "start"` before building. It\n' +
        "scaffolds `outputs/web`, installs deps, and starts the dev server (fallback: `bash\n" +
        "start-webapp.sh`). Once running, it renders live (Next.js 16.1.1, React 19, Tailwind,\n" +
        "Recharts, shadcn/ui); read `outputs/web/AGENTS.md` for its specs and styling before\n" +
        "building.",
    );
    expect(rendered).toContain("Once running, it renders live");
    expect(rendered).not.toContain("scaffolding `outputs/web` (Next.js");
  });

  test("keeps the onyx turn-budget notice marker verbatim", () => {
    expect(render()).toContain("`[Onyx turn budget]` notices to tool results");
  });

  test("admin text with literal {{…}} tokens is never expanded (last-substitution order)", () => {
    const rendered = render({
      organizationInstructions: "Literal {{USER_CONTEXT}} stays put.",
    });
    expect(rendered).toContain("Literal {{USER_CONTEXT}} stays put.");
  });

  // ── fixture F1: bare user, no connectable apps ──────────────────────────────

  test("F1: renders the no-app fallback section byte-exact", () => {
    const rendered = render({
      userName: "Ada Lovelace",
      organizationInstructions: null,
      connectableAppsSection: buildConnectableAppsList([]),
    });
    expect(rendered).toContain(
      connectableSection("No connectable apps available."),
    );
    expect(rendered).toContain(
      "You are assisting **Ada Lovelace** with their work.",
    );
  });

  test("F1: a null user name renders an empty context line", () => {
    const rendered = render({
      userName: null,
      connectableAppsSection: buildConnectableAppsList([]),
    });
    expect(rendered).not.toContain("You are assisting");
  });

  test("an unset section defaults to the no-app fallback (no residue)", () => {
    const rendered = render();
    expect(rendered).toContain("No connectable apps available.");
    expect(rendered).not.toContain("{{");
  });

  // ── fixture F2: one connected + one connectable app ─────────────────────────

  test("F2: renders the connectable list byte-exact", () => {
    const rendered = render({
      connectableAppsSection: buildConnectableAppsList([
        { id: "7", name: "Slack" },
      ]),
    });
    expect(rendered).toContain(
      connectableSection("- External app ID `7`: **Slack**"),
    );
  });

  test("substituted sentence: the numeric app-id qualifier is dropped (OpenBot ids are string keys)", () => {
    const rendered = render({
      connectableAppsSection: buildConnectableAppsList([]),
    });
    expect(rendered).not.toContain("numeric");
    expect(rendered).toContain(
      "call the `connect_app` tool with its external app ID from the list below",
    );
  });

  // ── company knowledge (BLOCKED: no backed company-search skill yet) ─────────

  test("the company-knowledge section stays out while no backed skill ships", () => {
    const rendered = render({
      connectableAppsSection: buildConnectableAppsList([]),
    });
    expect(rendered).not.toContain("## Company knowledge");
    expect(rendered).not.toContain("company-search");
  });

  test("a delivered company-search skill renders onyx's section byte-exact, in onyx's position", () => {
    const rendered = render({
      connectableAppsSection: buildConnectableAppsList([]),
      companySearchSkillAvailable: true,
    });
    expect(rendered).toContain(COMPANY_KNOWLEDGE_SECTION);
    // onyx's position: directly between the credentials tail and Files.
    expect(rendered).toContain(
      "`error` of `user_rejected`, `not_authorized`, or `policy_denied`. Surface the issue and don't retry.\n\n" +
        COMPANY_KNOWLEDGE_SECTION +
        "\n\n## Files & attachments",
    );
  });

  test("a template missing the Files anchor splices nothing and says so (the no-op is observable)", () => {
    // The skill ships but the anchor is gone: the splice must not crash or
    // half-render, and the renderer warns (one logger line) so the missing
    // anchor is a diagnosable template drift, not a silent no-op.
    const rendered = render({
      template: "# Bare template\n\n{{CONNECTABLE_APPS_LIST}}\n",
      connectableAppsSection: buildConnectableAppsList([]),
      companySearchSkillAvailable: true,
    });
    expect(rendered).toContain("No connectable apps available.");
    expect(rendered).not.toContain("## Company knowledge");
  });
});

// ── buildConnectableAppsList (onyx agent_instructions.py:78-89) ───────────────

describe("buildConnectableAppsList", () => {
  test("empty input renders the fallback line", () => {
    expect(buildConnectableAppsList([])).toBe("No connectable apps available.");
  });

  test("renders one bullet per app, sorted by (id, name)", () => {
    expect(
      buildConnectableAppsList([
        { id: "7", name: "Slack" },
        { id: "2", name: "GitHub" },
      ]),
    ).toBe(
      "- External app ID `2`: **GitHub**\n- External app ID `7`: **Slack**",
    );
  });

  test("already-connected apps never reach the list (the source filters them)", () => {
    // The list renders exactly what it is given — connected apps are filtered
    // by the resolver's app source (get_connectable_apps_for_user parity).
    expect(buildConnectableAppsList([{ id: "3", name: "Linear" }])).toBe(
      "- External app ID `3`: **Linear**",
    );
  });

  test("ties on id fall through to the name (onyx's tuple sort)", () => {
    expect(
      buildConnectableAppsList([
        { id: "5", name: "Zeta" },
        { id: "5", name: "Alpha" },
      ]),
    ).toBe("- External app ID `5`: **Alpha**\n- External app ID `5`: **Zeta**");
  });
});

// ── provider display fallbacks (fixture F1 notes) ─────────────────────────────

describe("provider display fallbacks", () => {
  test("a null provider renders Unknown", () => {
    const rendered = render({ provider: null });
    expect(rendered).toContain("Your LLM is Unknown / claude-test-1.");
  });

  test("an unmapped provider renders its title-cased name", () => {
    const rendered = render({ provider: "mistral-small" });
    expect(rendered).toContain("Your LLM is Mistral Small / claude-test-1.");
  });
});
