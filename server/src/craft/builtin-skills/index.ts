/**
 * The built-in skills onyx ships inside its sandbox image ($ONYX/skills/builtin) —
 * OpenBot's image carries none, so they ship with the server instead and
 * materialize per session through the managed-content skills leg.
 *
 * Two kinds live here:
 *
 * - Verbatim ports (pptx, craft-documentation): the onyx bytes, untouched.
 * - Connector skills (github, gmail, …): onyx's operational guidance with the
 *   egress-proxy CLI/API sections rewritten for OpenBot's trust model —
 *   credentials attach server-side on the MCP relay and never enter the
 *   sandbox, so the agent drives the user's connected MCP server tools.
 *   Each file's header comment records the onyx source and the reason for
 *   every divergence (docs/craft-port/port-parity.md carries the roll-up).
 *
 * browser and image-generation stay BLOCKED (onyx parity gaps with no OpenBot
 * equivalent): browser needs the image's browser-cli.sh + Chromium, and
 * image-generation needs onyx's server-side image provider domain. See
 * port-parity.md for the unlock conditions.
 */

const ROOT = new URL("./", import.meta.url);

/** Connector skills ship only when the matching MCP server is connected. */
const CONNECTOR_SKILLS: ReadonlySet<string> = new Set([
  "github",
  "gmail",
  "google-calendar",
  "google-drive",
  "hubspot",
  "linear",
  "notion",
  "slack",
]);

/** The rendered extension; a connector template lands under this name. */
const TEMPLATE_SUFFIX = ".template";

/**
 * Whether a connected MCP server row (catalogue key, brokered
 * `composio-<slug>`/`open-connector-<slug>`, or an administrator's custom id)
 * backs the named connector skill. onyx ships a connector skill only when the
 * corresponding app is connected; OpenBot's fact for "connected" is the
 * user's personal connection to the server.
 */
export function serverBacksConnectorSkill(
  serverId: string,
  skill: string,
): boolean {
  return serverId === skill || serverId.endsWith(`-${skill}`);
}

/**
 * Render a connector SKILL.md.template. onyx's rendering.py resolved cloud
 * blocks and an action-availability section; OpenBot deployments are never
 * cloud-scope and have no admin per-action policy surface, so both pre-resolve
 * to their empty branch — leaving exactly one placeholder to strip. Any
 * unresolved markup fails loudly rather than shipping to the agent (onyx's
 * own rule).
 */
export function renderConnectorSkillTemplate(template: string): string {
  const rendered = template.replace("{{ACTION_AVAILABILITY_SECTION}}\n\n", "");
  return assertNoUnresolvedMarkup(rendered);
}

/**
 * Render the company-search SKILL.md — onyx's `render_company_search_skill`:
 * the sources section (the deployment's knowledge bases) fills the
 * placeholder; onyx's no-sources line is kept verbatim.
 */
export function renderCompanySearchSkill(
  template: string,
  sourcesSection: string,
): string {
  return assertNoUnresolvedMarkup(
    template.replace("{{AVAILABLE_SOURCES_SECTION}}", sourcesSection),
  );
}

/** onyx rendering.py's rule: unresolved markup never ships to the agent. */
function assertNoUnresolvedMarkup(rendered: string): string {
  if (rendered.includes("{{")) {
    const offending = rendered.split("\n").find((line) => line.includes("{{"));
    throw new Error(`Unresolved skill-template markup: ${offending ?? "}}"}`);
  }
  return rendered;
}

/** onyx's no-sources line (rendering.py build_available_sources_section). */
export const NO_SOURCES_SECTION =
  "No connected sources available for this user.";

/** The KB list → the sources section body (onyx's `- \`source\` — description` lines). */
export function buildAvailableSourcesSection(
  kbs: readonly { name: string; description?: string | null }[],
): string {
  if (kbs.length === 0) return NO_SOURCES_SECTION;
  return kbs
    .map((kb) =>
      kb.description
        ? `- \`${kb.name}\` — ${kb.description}`
        : `- \`${kb.name}\``,
    )
    .join("\n");
}

/** The company-search skill's files, kept apart from the gated connector set. */
const COMPANY_SEARCH_SKILL = "company-search";

type BuiltinSkillTree = ReadonlyMap<string, Uint8Array>;

let builtinSkillTreeCache: BuiltinSkillTree | null = null;
let companySearchTemplate: string | null = null;

/**
 * The whole builtin-skills tree, read once per process. pptx and
 * craft-documentation pass through verbatim; a connector's
 * `<skill>/SKILL.md.template` renders (see above) and lands as
 * `<skill>/SKILL.md`. The company-search SKILL.md.template is kept raw —
 * its sources section is per-deployment and renders at delivery time.
 * An absent directory resolves to an empty map so a deployment without the
 * tree degrades to "no builtin skills", never a crash.
 */
async function loadBuiltinSkillTree(): Promise<BuiltinSkillTree> {
  if (builtinSkillTreeCache !== null) return builtinSkillTreeCache;
  const { readdir, readFile } = await import("node:fs/promises");
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const walk = async (dir: URL, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Top-level files are this module's own source (index.ts), not skill
      // content — every shipped file lives under a skill directory.
      if (prefix === "" && !entry.isDirectory()) continue;
      const child = new URL(`${entry.name}/`, dir);
      if (entry.isDirectory()) {
        await walk(child, rel);
      } else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(new URL(entry.name, dir)));
        if (rel === `${COMPANY_SEARCH_SKILL}/SKILL.md.template`) {
          companySearchTemplate = new TextDecoder().decode(bytes);
        } else if (rel.endsWith(TEMPLATE_SUFFIX)) {
          const rendered = renderConnectorSkillTemplate(
            new TextDecoder().decode(bytes),
          );
          files.set(
            rel.slice(0, -TEMPLATE_SUFFIX.length),
            encoder.encode(rendered),
          );
        } else {
          files.set(rel, bytes);
        }
      }
    }
  };
  await walk(ROOT, "").catch(() => undefined);
  builtinSkillTreeCache = files;
  return files;
}

/** The per-user builtin skill fileset inputs. */
export type BuiltinSkillFilesInput = {
  /**
   * Catalogue keys / brokered slugs of the MCP servers this user has
   * connected — the connector skills' gate.
   */
  connectedServerIds: ReadonlySet<string>;
  /**
   * The rendered sources section for company-search, or undefined to hold the
   * skill back entirely (knowledge domain not wired — the AGENTS.md Company
   * knowledge section stays out with it, onyx's no-backed-skill rule).
   */
  companySearchSourcesSection?: string;
};

/**
 * The per-user builtin skill fileset for the managed-content skills leg:
 * pptx and craft-documentation unconditionally, a connector skill only when
 * the user has connected the matching MCP server (onyx ships a connector
 * skill only for connected apps), and company-search only when the knowledge
 * domain backs it (its sources section renders here, per deployment).
 */
export async function builtinSkillFilesFor(
  input: BuiltinSkillFilesInput,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const tree = await loadBuiltinSkillTree();
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of tree) {
    const skill = path.split("/", 1)[0];
    if (skill === COMPANY_SEARCH_SKILL) {
      // Held back as a unit: the SKILL.md renders only with a sources section
      // (the branch below), and the CLI ships with it or not at all.
      continue;
    }
    if (
      CONNECTOR_SKILLS.has(skill) &&
      ![...input.connectedServerIds].some((id) =>
        serverBacksConnectorSkill(id, skill),
      )
    ) {
      continue;
    }
    files.set(path, bytes);
  }
  if (
    input.companySearchSourcesSection !== undefined &&
    companySearchTemplate !== null
  ) {
    const encoder = new TextEncoder();
    files.set(
      `${COMPANY_SEARCH_SKILL}/SKILL.md`,
      encoder.encode(
        renderCompanySearchSkill(
          companySearchTemplate,
          input.companySearchSourcesSection,
        ),
      ),
    );
    const cli = tree.get(`${COMPANY_SEARCH_SKILL}/onyx-cli`);
    if (cli !== undefined) files.set(`${COMPANY_SEARCH_SKILL}/onyx-cli`, cli);
  }
  return files;
}
