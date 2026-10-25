import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { readFileSync } from "node:fs";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import {
  RESEARCH_TOOLS as SHARED_RESEARCH_TOOLS,
  researchRoleOf,
} from "../../shared/research";
import { parse } from "yaml";
import { z } from "zod";
import {
  catalogueEntry,
  classifyTool,
  researchRoleFor,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import { listTools } from "../src/plugins/mcp";
import { selectTools } from "../src/plugins/selection";
import { deploymentTokenHeader } from "../src/plugins/store";
import { grantedToolGuidance } from "../src/plugins/tools";

const tool = (server: string, name: string): GrantedTool => ({
  name: `mcp__${server}__${name}`,
  ref: `${server}/${name}`,
  description: "Public web",
  parameters: z.object({}),
  execute: async () => "unused",
});

/**
 * The research tool names, restated from `RESEARCH_TOOLS` rather than imported, so a rename in the
 * shared table has to be read twice — here, where the guidance and the selection behaviour are
 * pinned against the exact spellings a vendor advertises.
 */
const RESEARCH_TOOLS: Record<string, [string, string]> = {
  parallel: ["web_search", "web_fetch"],
  "parallel-authenticated": ["web_search", "web_fetch"],
  exa: ["web_search_exa", "web_fetch_exa"],
  "exa-authenticated": ["web_search_exa", "web_fetch_exa"],
  firecrawl: ["firecrawl_search", "firecrawl_scrape"],
  "firecrawl-authenticated": ["firecrawl_search", "firecrawl_scrape"],
};
const pair = (server = "parallel") =>
  (RESEARCH_TOOLS[server] ?? []).map((name) => tool(server, name));

describe("research providers in the catalogue", () => {
  test("each is pinned to its vendor's official endpoint", () => {
    const urls: Record<string, string> = {
      parallel: "https://search.parallel.ai/mcp",
      "parallel-authenticated": "https://search.parallel.ai/mcp",
      exa: "https://mcp.exa.ai/mcp",
      "exa-authenticated": "https://mcp.exa.ai/mcp",
      firecrawl: "https://mcp.firecrawl.dev/v2/mcp",
      "firecrawl-authenticated": "https://mcp.firecrawl.dev/v2/mcp",
    };
    for (const [key, url] of Object.entries(urls)) {
      expect(resolveServerUrl(key, "https://attacker.example")?.url).toBe(url);
    }
  });

  test("names its search and fetch tools, and both read", () => {
    for (const [key, [search, fetch]] of Object.entries(RESEARCH_TOOLS)) {
      const entry = catalogueEntry(key)!;
      expect(SHARED_RESEARCH_TOOLS[key]).toMatchObject({ search, fetch });
      expect(classifyTool(entry, search, true)).toBe("read");
      expect(classifyTool(entry, fetch, true)).toBe("read");
      expect(classifyTool(entry, "not_advertised", false)).toBe("write");
      expect(classifyTool(entry, search, true, "write")).toBe("write");
      expect(researchRoleFor(`${key}/${search}`)).toBe("search");
      expect(researchRoleFor(`${key}/${fetch}`)).toBe("fetch");
    }
    expect(researchRoleFor("notion/notion-search")).toBeNull();
    // The app labels research from this table, so every key must be a real catalogue entry.
    for (const key of Object.keys(SHARED_RESEARCH_TOOLS))
      expect(catalogueEntry(key)).not.toBeNull();
    // Instructions are built from these, so a tool missing its ref must not throw.
    expect(researchRoleFor(undefined as never)).toBeNull();
    expect(
      grantedToolGuidance([{ name: "mcp__drive__search" } as GrantedTool]),
    ).toContain("drive: search");
  });

  test("a tool outside an entry's reads is a write, even one the vendor called a read", () => {
    const firecrawl = catalogueEntry("firecrawl")!;
    // Published as a family, so no write list could have named it.
    expect(classifyTool(firecrawl, "firecrawl_monitor_delete", true)).toBe(
      "write",
    );
    expect(
      classifyTool(firecrawl, "firecrawl_monitor_delete", true, "read"),
    ).toBe("write");
    expect(classifyTool(firecrawl, "firecrawl_crawl", true)).toBe("write");
    expect(classifyTool(firecrawl, "firecrawl_map", true)).toBe("read");
    expect(classifyTool(firecrawl, "firecrawl_parse", true)).toBe("read");
    // Spends credits on a multi-step run.
    expect(classifyTool(catalogueEntry("exa")!, "agent_run", true)).toBe(
      "write",
    );
  });

  test("says whose credential each uses, and where Exa's key goes", () => {
    expect(serverCredentialKind(catalogueEntry("parallel")!)).toBeNull();
    expect(serverCredentialKind(catalogueEntry("exa")!)).toBeNull();
    expect(serverCredentialKind(catalogueEntry("firecrawl")!)).toBeNull();
    for (const key of [
      "parallel-authenticated",
      "exa-authenticated",
      "firecrawl-authenticated",
    ])
      expect(serverCredentialKind(catalogueEntry(key)!)).toBe("mcp");
    expect(deploymentTokenHeader(catalogueEntry("exa-authenticated"))).toBe(
      "x-api-key",
    );
    // Everything else sends its deployment token in `Authorization`: Firecrawl names no header of
    // its own, a keyless server sends none, and an entry-less server has no header to name. The
    // live decision answers `undefined` for each — the shape that leaves a token riding
    // `Authorization` wherever one rides at all (wire-pinned in plugin-store.integration.test.ts).
    expect(
      deploymentTokenHeader(catalogueEntry("firecrawl-authenticated")),
    ).toBeUndefined();
    expect(deploymentTokenHeader(catalogueEntry("parallel"))).toBeUndefined();
    expect(deploymentTokenHeader(null)).toBeUndefined();
  });
});

describe("what a Bot is told about research", () => {
  test("a provider is described only while both of its tools are held", () => {
    for (const server of Object.keys(RESEARCH_TOOLS)) {
      const guidance = grantedToolGuidance(pair(server));
      expect(guidance).toContain("For public-web research you can use:");
      expect(guidance).toContain("do not connect a person's private account");
      // Described, not preferred: a Bot holding another search tool is not told to pass it over.
      expect(guidance).not.toContain("by default");
      // Searches unprompted for facts that change, and only a little.
      expect(guidance).toContain(
        "Search before answering when the answer depends on facts that change",
      );
      expect(guidance).toContain("a search or two");
      expect(grantedToolGuidance(pair(server).slice(0, 1))).not.toContain(
        "public-web research",
      );
    }
    expect(grantedToolGuidance([], ["exa"])).not.toContain(
      "public-web research",
    );
    expect(grantedToolGuidance([])).toBe("");
  });

  test("names each provider's own tools and adds only its own notes", () => {
    const exa = grantedToolGuidance(pair("exa"));
    expect(exa).toContain(
      "- Exa: mcp__exa__web_search_exa finds sources and mcp__exa__web_fetch_exa reads selected pages.",
    );
    // Exa carries no session: the note is Parallel's, and must not be injected on its behalf.
    expect(exa).not.toContain("session_id");
    expect(exa).toContain("Do not name the provider in your answer");
    expect(grantedToolGuidance(pair())).toContain(
      "Parallel: Generate one session_id",
    );
  });

  test("a vendor added twice is described once, with its key", () => {
    const guidance = grantedToolGuidance([
      ...pair(),
      ...pair("parallel-authenticated"),
    ]);
    expect(guidance).toContain(
      "- Parallel: mcp__parallel-authenticated__web_search finds sources",
    );
    expect(guidance).not.toContain("mcp__parallel__web_search");
  });

  test("two vendors are both described, and the person's choice decides", () => {
    const guidance = grantedToolGuidance([...pair(), ...pair("firecrawl")]);
    expect(guidance).toContain("- Parallel:");
    expect(guidance).toContain("- Firecrawl:");
    expect(guidance).toContain("Use the one the person asks for.");
  });

  test("a failure is reported, never routed around to another provider", () => {
    // There is no provider-fallback behaviour to test, so the instruction that could create one
    // must not exist either: nothing here may tell a model to try another vendor when one fails.
    for (const server of Object.keys(RESEARCH_TOOLS)) {
      const guidance = grantedToolGuidance(pair(server)).toLowerCase();
      expect(guidance).not.toContain("fallback");
      expect(guidance).not.toContain("switch to");
      expect(guidance).not.toContain("another provider");
      expect(guidance).toContain("do not invent evidence");
    }
  });
});

describe("a skill declaring research by role", () => {
  const others = Array.from({ length: 12 }, (_, index) => ({
    ref: `slack/tool_${index}`,
  }));
  const research = {
    slug: "research",
    title: "Research",
    summary: "Research the public web.",
    tools: ["@research/search", "@research/fetch"],
  };
  const slack = {
    slug: "slack",
    title: "Slack",
    summary: "Slack.",
    tools: others.map((entry) => entry.ref),
  };
  const choose = (slug: string) => async () =>
    JSON.stringify({ skills: [slug] });

  test("brings whichever provider's tools the Bot holds", async () => {
    const tools = [
      ...others,
      { ref: "exa/web_search_exa" },
      { ref: "exa/web_fetch_exa" },
      { ref: "exa/web_search_advanced_exa" },
    ];
    const selection = await selectTools({
      tools,
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("exa/web_search_exa");
    expect(offered).toContain("exa/web_fetch_exa");
    expect(offered).not.toContain("slack/tool_0");
    // Not a research role, and no skill declares it, so it is offered as any undeclared tool is.
    expect(offered).toContain("exa/web_search_advanced_exa");
  });

  test("never offers a provider the Bot was not granted", async () => {
    const selection = await selectTools({
      tools: [...others, { ref: "firecrawl/firecrawl_search" }],
      skills: [research, slack],
      text: "find recent coverage of this",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toEqual(["firecrawl/firecrawl_search"]);
  });

  test("the old real tool refs keep working beside the role refs", async () => {
    const legacy = {
      slug: "legacy-research",
      title: "Legacy research",
      summary: "Research the public web.",
      tools: ["parallel/web_search", "parallel/web_fetch"],
    };
    const selection = await selectTools({
      tools: [...others, ...pair()],
      skills: [legacy, slack],
      text: "find recent coverage of this",
      choose: choose("legacy-research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("parallel/web_search");
    expect(offered).toContain("parallel/web_fetch");
    expect(offered).not.toContain("slack/tool_0");
  });

  test("a role never widens into a ref the Bot does not hold, at either spelling", async () => {
    // The role declaration names both roles; the Bot holds only a search. The fetch role must not
    // invent a fetch tool, and neither spelling of the held server may grow.
    const selection = await selectTools({
      tools: [...others, { ref: "exa/web_search_exa" }],
      skills: [research, slack],
      text: "read this page for me",
      choose: choose("research"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toEqual(["exa/web_search_exa"]);
  });

  test("a role ref is only ever the two roles", () => {
    expect(researchRoleOf("@research/search")).toBe("search");
    expect(researchRoleOf("@research/fetch")).toBe("fetch");
    expect(researchRoleOf("@research/delete")).toBeNull();
    expect(researchRoleOf("@research/search/more")).toBeNull();
    expect(researchRoleOf("research/search")).toBeNull();
  });

  test("junk in a declaration or a holding is skipped, and never mistaken for a role", async () => {
    // Runtime data: a skill's tools come out of a database column and a held ref out of a row.
    // A ref that is not a string, or a server with no slash, plays no role and must not throw —
    // the guard lives at this side, because the shared table only answers for well-formed pairs.
    const junkSkills = [
      {
        slug: "junk",
        title: "Junk",
        summary: "Junk.",
        tools: [undefined, "@research/search", "parallel"] as never as string[],
      },
      slack,
    ];
    const selection = await selectTools({
      tools: [
        ...others,
        { ref: 42 as never as string },
        { ref: "exa/web_search_exa" },
        { ref: "exa/web_fetch_exa" },
      ],
      skills: junkSkills,
      text: "find recent coverage of this",
      choose: choose("junk"),
    });
    const offered = selection.offered.map((entry) => entry.ref);
    expect(offered).toContain("exa/web_search_exa");
    expect(offered).toContain("exa/web_fetch_exa");
  });

  test("the shipped Research Desk skill declares roles, not one provider", () => {
    const skills = parse(
      readFileSync(
        new URL("../../examples/fintech/skills.yaml", import.meta.url),
        "utf8",
      ),
    ).skills;
    const skill = skills.find(
      (item: { slug: string }) => item.slug === "research-public-web",
    );
    expect(skill.tools).toEqual(["@research/search", "@research/fetch"]);
    const desk = parse(
      readFileSync(
        new URL(
          "../../examples/fintech/catalog/research-desk.yaml",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(desk.skills).toContain("research-public-web");
  });
});

/**
 * The two providers with a public self-serve key, dialed for real.
 *
 * This is the live half of the contract, and it is deliberately NOT part of acceptance: the mock
 * suites above pin what our code does, and these pin what the vendor does. Without
 * `OPENBOT_LIVE_RESEARCH=1` and a real key in the environment the file skips with the variable
 * named in the title — a skipped live smoke is BLOCKED evidence, never a pass, and the run record
 * has to be read that way.
 *
 * Read-only: a listing spends at most the vendor's free allowance and touches nobody's data.
 */
const liveResearch = process.env.OPENBOT_LIVE_RESEARCH === "1";
const exaKey = process.env.EXA_API_KEY?.trim();
const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();

describe.skipIf(!liveResearch)("a real research provider, for real", () => {
  test.skipIf(!exaKey)(
    "Exa lists its research tools to the deployment's key (needs EXA_API_KEY)",
    async () => {
      const { listTools } = await import("../src/plugins/mcp");
      const listed = await listTools({
        url: "https://mcp.exa.ai/mcp",
        token: exaKey ?? "",
        tokenHeader: "x-api-key",
      });
      const names = listed.map((entry) => entry.name);
      expect(names).toContain("web_search_exa");
      expect(names).toContain("web_fetch_exa");
    },
  );

  test.skipIf(!firecrawlKey)(
    "Firecrawl lists its research tools to the deployment's key (needs FIRECRAWL_API_KEY)",
    async () => {
      const { listTools } = await import("../src/plugins/mcp");
      const listed = await listTools({
        url: "https://mcp.firecrawl.dev/v2/mcp",
        token: firecrawlKey ?? "",
      });
      const names = listed.map((entry) => entry.name);
      expect(names).toContain("firecrawl_search");
      expect(names).toContain("firecrawl_scrape");
    },
  );
});

describe("the header a deployment token is sent in", () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: Headers | undefined;
  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen ??= request.headers;
        return new Response("no", { status: 401 });
      },
    });
    // Bun's serve binds synchronously; the node-compatible shim binds through `server.listen`, so
    // the ephemeral port is only readable once the bind lands. Waiting here keeps the URLs below
    // off port 0, where every request would fail before the header under test is ever sent.
    for (let attempt = 0; server.port === 0 && attempt < 500; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (server.port === 0)
      throw new Error("the stub research server never bound an ephemeral port");
  });
  afterAll(() => server.stop(true));

  const listed = async (connection: {
    token: string;
    tokenHeader?: string;
  }) => {
    seen = undefined;
    await listTools({
      url: `http://127.0.0.1:${server.port}/mcp`,
      ...connection,
    }).catch(() => undefined);
    return seen;
  };

  test("is Authorization as a Bearer token by default", async () => {
    const headers = await listed({ token: "secret" });
    expect(headers?.get("authorization")).toBe("Bearer secret");
  });

  test("is the vendor's own header, as stored, when the entry names one", async () => {
    const headers = await listed({
      token: " secret ",
      tokenHeader: "x-api-key",
    });
    expect(headers?.get("x-api-key")).toBe("secret");
    expect(headers?.get("authorization")).toBeNull();
  });
});
