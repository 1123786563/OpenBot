/**
 * Public-web research by role rather than by provider, shared by the server and the app.
 *
 * A skill declares `@research/search` and `@research/fetch` instead of one provider's tool names,
 * and the server matches each to that role's tool on every research connector. So a research skill
 * keeps working when a deployment switches provider, and the transcript can say "Search the web"
 * instead of naming whichever vendor answered.
 */
export type ResearchRole = "search" | "fetch";

/**
 * One provider's public-web research tools.
 *
 * `search` finds sources for a query and `fetch` reads pages by URL. Both are required, because a
 * Bot that can find a page and cannot read it has links and no evidence.
 */
export type ResearchTools = {
  search: string;
  fetch: string;
  /** How this provider's own parameters are best used, added to the shared guidance verbatim. */
  notes?: readonly string[];
};

const PARALLEL: ResearchTools = Object.freeze({
  search: "web_search",
  fetch: "web_fetch",
  notes: Object.freeze([
    "Generate one session_id for the conversation and reuse it on related search and fetch calls.",
    "Omit model_name unless the exact configured model identifier is known.",
  ]),
});

const EXA: ResearchTools = Object.freeze({
  search: "web_search_exa",
  fetch: "web_fetch_exa",
});

const FIRECRAWL: ResearchTools = Object.freeze({
  search: "firecrawl_search",
  fetch: "firecrawl_scrape",
});

/**
 * The research tools on each catalogue entry, by the entry's key.
 *
 * Here rather than on the entries in `server/src/plugins/catalogue.ts` because the app labels these
 * tools too, and it cannot import the server. The keys are catalogue keys — both entries of every
 * provider name the same tool pair, because the keyed entry is the same vendor reached with the
 * deployment's credential and not a different tool surface. A key here that is not a catalogue
 * entry is a test failure (`server/tests/plugin-catalogue.test.ts`), so the two lists cannot drift.
 */
export const RESEARCH_TOOLS: Readonly<Record<string, ResearchTools>> =
  Object.freeze({
    parallel: PARALLEL,
    "parallel-authenticated": PARALLEL,
    exa: EXA,
    "exa-authenticated": EXA,
    firecrawl: FIRECRAWL,
    "firecrawl-authenticated": FIRECRAWL,
  });

/** The research role a tool on this server plays, or null when it plays none. */
export function researchRoleOfTool(
  server: string,
  tool: string,
): ResearchRole | null {
  // hasOwn rather than a bare index, so a name inherited from Object's prototype cannot pose as a
  // provider — `researchRoleOfTool("toString", "search")` is a question about no server at all.
  const research = Object.hasOwn(RESEARCH_TOOLS, server)
    ? RESEARCH_TOOLS[server]
    : undefined;
  if (research?.search === tool) return "search";
  if (research?.fetch === tool) return "fetch";
  return null;
}

/**
 * Shaped like a `serverId/toolName` ref so a declaration passes the same check as any other, and
 * starting with a character no server id may contain, so it can never be mistaken for one.
 */
const RESEARCH_ROLE_PREFIX = "@research";

/**
 * The research role a skill's tool ref names, or null when it names a server's own tool.
 *
 * A logical role is a claim a skill makes; a grant is still a real `serverId/toolName` ref a person
 * held. The two meet at selection time and nowhere before it, so this function reads the ref and
 * nothing else: a misspelling, a second slash or a real tool ref all answer null rather than
 * guessing at a role nobody wrote.
 */
export function researchRoleOf(ref: string): ResearchRole | null {
  const [prefix, role, extra] = ref.split("/");
  if (prefix !== RESEARCH_ROLE_PREFIX || extra !== undefined) return null;
  return role === "search" || role === "fetch" ? role : null;
}
