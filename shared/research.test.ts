import { describe, expect, test } from "../tests/support/e2e-compat";
import {
  RESEARCH_TOOLS,
  type ResearchRole,
  type ResearchTools,
  researchRoleOf,
  researchRoleOfTool,
} from "./research";

/**
 * The shared research-role contract (I4).
 *
 * A skill declares `@research/search` and `@research/fetch` rather than one provider's tool names,
 * so this table is the whole surface the server and the app agree on. The keys are catalogue keys
 * and the tool names are the ones each vendor's server advertises; both halves are pinned here, and
 * `server/tests/plugin-catalogue.test.ts` pins the same keys against the catalogue itself so the two
 * lists cannot drift apart in either direction.
 */
describe("the research tool table", () => {
  test("holds exactly the six catalogue keys under the I4 contract", () => {
    expect(Object.keys(RESEARCH_TOOLS).sort()).toEqual([
      "exa",
      "exa-authenticated",
      "firecrawl",
      "firecrawl-authenticated",
      "parallel",
      "parallel-authenticated",
    ]);
  });

  test("pins each provider's search and fetch tool names", () => {
    expect(RESEARCH_TOOLS.parallel).toEqual({
      search: "web_search",
      fetch: "web_fetch",
      notes: RESEARCH_TOOLS.parallel?.notes,
    });
    expect(RESEARCH_TOOLS["parallel-authenticated"]?.search).toBe("web_search");
    expect(RESEARCH_TOOLS["parallel-authenticated"]?.fetch).toBe("web_fetch");
    expect(RESEARCH_TOOLS.exa?.search).toBe("web_search_exa");
    expect(RESEARCH_TOOLS.exa?.fetch).toBe("web_fetch_exa");
    expect(RESEARCH_TOOLS["exa-authenticated"]?.search).toBe("web_search_exa");
    expect(RESEARCH_TOOLS["exa-authenticated"]?.fetch).toBe("web_fetch_exa");
    expect(RESEARCH_TOOLS.firecrawl?.search).toBe("firecrawl_search");
    expect(RESEARCH_TOOLS.firecrawl?.fetch).toBe("firecrawl_scrape");
    expect(RESEARCH_TOOLS["firecrawl-authenticated"]?.search).toBe(
      "firecrawl_search",
    );
    expect(RESEARCH_TOOLS["firecrawl-authenticated"]?.fetch).toBe(
      "firecrawl_scrape",
    );
  });

  test("the two catalogue entries of one provider share one tool pair", () => {
    // The authenticated entry is the same vendor reached with the deployment's key, not a
    // different server surface: its tools must be spelled exactly as the anonymous one's.
    expect(RESEARCH_TOOLS["parallel-authenticated"]).toMatchObject(
      RESEARCH_TOOLS.parallel ?? {},
    );
    expect(RESEARCH_TOOLS["exa-authenticated"]).toMatchObject(
      RESEARCH_TOOLS.exa ?? {},
    );
    expect(RESEARCH_TOOLS["firecrawl-authenticated"]).toMatchObject(
      RESEARCH_TOOLS.firecrawl ?? {},
    );
  });

  test("every entry carries both roles, because links without reading are not evidence", () => {
    for (const research of Object.values(RESEARCH_TOOLS)) {
      const tools: ResearchTools = research;
      expect(typeof tools.search).toBe("string");
      expect(tools.search.length).toBeGreaterThan(0);
      expect(typeof tools.fetch).toBe("string");
      expect(tools.fetch.length).toBeGreaterThan(0);
    }
  });
});

describe("researchRoleOfTool", () => {
  test("names the role a tool plays on its own server", () => {
    expect(researchRoleOfTool("parallel", "web_search")).toBe("search");
    expect(researchRoleOfTool("parallel", "web_fetch")).toBe("fetch");
    expect(researchRoleOfTool("parallel-authenticated", "web_search")).toBe(
      "search",
    );
    expect(researchRoleOfTool("exa", "web_search_exa")).toBe("search");
    expect(researchRoleOfTool("exa", "web_fetch_exa")).toBe("fetch");
    expect(researchRoleOfTool("exa-authenticated", "web_fetch_exa")).toBe(
      "fetch",
    );
    expect(researchRoleOfTool("firecrawl", "firecrawl_search")).toBe("search");
    expect(researchRoleOfTool("firecrawl", "firecrawl_scrape")).toBe("fetch");
    expect(
      researchRoleOfTool("firecrawl-authenticated", "firecrawl_scrape"),
    ).toBe("fetch");
  });

  test("a tool another provider owns plays no role here", () => {
    // Cross-provider near misses. `web_search_exa` is Exa's name; on Parallel's entry it is a
    // name Parallel never advertised, so granting by role must never pick it up.
    expect(researchRoleOfTool("parallel", "web_search_exa")).toBeNull();
    expect(researchRoleOfTool("exa", "web_search")).toBeNull();
    expect(researchRoleOfTool("firecrawl", "web_fetch")).toBeNull();
  });

  test("a server with no research tools answers null rather than throwing", () => {
    expect(researchRoleOfTool("notion", "notion-search")).toBeNull();
    expect(researchRoleOfTool("not-a-server", "web_search")).toBeNull();
    // Read off the prototype rather than the table: the lookup is hasOwn, so an inherited name
    // cannot pose as a provider.
    expect(researchRoleOfTool("toString", "search")).toBeNull();
    expect(researchRoleOfTool("constructor", "fetch")).toBeNull();
  });

  test("a tool name is matched exactly, not by substring or case", () => {
    expect(researchRoleOfTool("parallel", "web_search_advanced")).toBeNull();
    expect(researchRoleOfTool("parallel", "WEB_SEARCH")).toBeNull();
    expect(researchRoleOfTool("exa", "web_search_extra")).toBeNull();
  });
});

describe("researchRoleOf", () => {
  test("resolves the two logical role refs", () => {
    expect(researchRoleOf("@research/search")).toBe("search");
    expect(researchRoleOf("@research/fetch")).toBe("fetch");
  });

  test("a misspelled role is null", () => {
    expect(researchRoleOf("@research/serch")).toBeNull();
    expect(researchRoleOf("@research/searches")).toBeNull();
    expect(researchRoleOf("@research/SEARCH")).toBeNull();
    expect(researchRoleOf("@research/scrape")).toBeNull();
  });

  test("a ref with more than one slash is null", () => {
    expect(researchRoleOf("@research/search/extra")).toBeNull();
    expect(researchRoleOf("@research//search")).toBeNull();
  });

  test("anything that is not a logical role ref is null", () => {
    // Real tool refs name a server, so they never carry the prefix and must stay exactly that:
    // a role is a claim a skill makes, and a grant is still something a person held.
    expect(researchRoleOf("parallel/web_search")).toBeNull();
    expect(researchRoleOf("research/search")).toBeNull();
    expect(researchRoleOf("@research")).toBeNull();
    expect(researchRoleOf("@research/")).toBeNull();
    expect(researchRoleOf("@research/search/")).toBeNull();
    expect(researchRoleOf("")).toBeNull();
    expect(researchRoleOf("@research/constructor")).toBeNull();
  });
});

describe("the shape other modules consume", () => {
  test("the table is frozen and its roles are only the two declared", () => {
    expect(Object.isFrozen(RESEARCH_TOOLS)).toBe(true);
    const roles: ResearchRole[] = ["search", "fetch"];
    expect(roles.length).toBe(2);
  });
});
