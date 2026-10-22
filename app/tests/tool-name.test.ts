import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./preload";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { RESEARCH_TOOLS, researchRoleOf } from "../../shared/research";
import { undeclaredElsewhere } from "@/lib/skills/form";
import { RESEARCH_ROLES, readToolName } from "../src/lib/plugins/tool-name";

/**
 * What the person watching is told a Bot just did.
 *
 * The names under test are the ones the model is offered, which carry the server and a separator
 * that exists to keep two vendors' `search` apart. A reader should never see either.
 */
describe("naming a tool call", () => {
  test("a research call says what it did and not which provider did it", () => {
    for (const name of [
      "mcp__exa__web_search_exa",
      "mcp__exa-authenticated__web_search_exa",
      "mcp__parallel__web_search",
      "mcp__firecrawl__firecrawl_search",
    ]) {
      expect(readToolName(name)).toEqual({ label: "Search the web" });
    }
    expect(readToolName("mcp__exa__web_fetch_exa")).toEqual({
      label: "Read web pages",
    });
    expect(readToolName("mcp__firecrawl__firecrawl_scrape")).toEqual({
      label: "Read web pages",
    });
    // Only the research pair is relabelled; a provider's other tools keep their own names.
    expect(readToolName("mcp__firecrawl__firecrawl_map").label).toBe(
      "Firecrawl map",
    );
  });

  test("an MCP tool reads as an action against a named server", () => {
    expect(readToolName("mcp__slack__post_message")).toEqual({
      label: "Post message",
      detail: "slack",
    });
  });

  test("the server is dropped when the action already names it", () => {
    // "Search notes notes" reads as a bug rather than a label.
    expect(readToolName("mcp__notes__search_notes")).toEqual({
      label: "Search notes",
    });
  });

  test("the server is dropped when the action names it in the singular", () => {
    // A vendor names the server for the collection and the tool for the one item it acts on, so the
    // label is singular where the server is plural. The reader should not be shown "Create routine
    // routines".
    expect(readToolName("mcp__routines__create_routine")).toEqual({
      label: "Create routine",
    });
  });

  test("camelCase from a vendor reads the same way", () => {
    // The server is dropped here too: the vendor put it in the tool name themselves.
    expect(readToolName("mcp__jira__searchJiraIssues")).toEqual({
      label: "Search jira issues",
    });
  });

  test("a tool name containing the separator keeps all of it", () => {
    // The server is the first segment and everything after it is the tool, however many
    // separators the vendor used.
    expect(readToolName("mcp__box__list__files")).toEqual({
      label: "List files",
      detail: "box",
    });
  });

  test("a component the app registered is left alone", () => {
    // These names were chosen by somebody and are already what the reader should see.
    expect(readToolName("showBarChart")).toEqual({ label: "showBarChart" });
  });

  test("the server is dropped when a hyphenated server's words are already in the label", () => {
    // The server is one token with a separator inside it, `google-drive`. A word-at-a-time compare
    // against the label's words never matches a token that never appears as a whole word itself, so
    // this needs the same splitting `humanise` already does for the tool name.
    expect(readToolName("mcp__google-drive__search_google_drive")).toEqual({
      label: "Search google drive",
    });
  });

  test("the server is dropped when an underscored server's words are already in the label", () => {
    // Same case as the hyphenated server, spelled with an underscore instead. Either separator has to
    // split into the same words.
    expect(readToolName("mcp__google_drive__search_google_drive")).toEqual({
      label: "Search google drive",
    });
  });

  test("a multi-token server the label does not name is kept as detail", () => {
    // "Search files" does not say "google" or "drive" anywhere, so the server still belongs on
    // screen. This is what proves the check was tightened rather than deleted.
    expect(readToolName("mcp__google-drive__search_files")).toEqual({
      label: "Search files",
      detail: "google-drive",
    });
  });

  test("the server is kept when the singular of its name only matches the label's verb", () => {
    // singular("posts") is "post", which is also the verb `humanise` put first in "Post message".
    // That is a coincidence with the verb, not the server being named as the thing acted upon, so
    // "posts" still belongs on screen.
    expect(readToolName("mcp__posts__post_message")).toEqual({
      label: "Post message",
      detail: "posts",
    });
  });

  test("the server is kept when the singular of its name only matches the label's verb, second case", () => {
    // Same shape as `posts`/`post_message`: singular("lists") is "list", which collides with the
    // verb in "List files" rather than naming the server as the thing acted upon.
    expect(readToolName("mcp__lists__list_files")).toEqual({
      label: "List files",
      detail: "lists",
    });
  });
});

/**
 * A research call is named for what it did, not for who did it.
 *
 * `web_search_exa` would read "Web search exa", which tells the person which vendor this
 * deployment buys search from and nothing about their answer. Which provider is granted is an
 * administrator's fact, on the Bot's access page. The matrix below walks every catalogue key of
 * `shared/research.ts` — both spellings of every provider — so a key added there without a label
 * here fails this file rather than shipping a vendor name to readers.
 */
describe("naming a research call by its role", () => {
  const KEYS = Object.keys(RESEARCH_TOOLS);

  test("a search on any research provider reads as searching the web", () => {
    for (const server of KEYS) {
      expect(
        readToolName(`mcp__${server}__${RESEARCH_TOOLS[server].search}`),
      ).toEqual({
        label: "Search the web",
        labelKey: "tools.researchSearch",
      });
    }
  });

  test("a fetch on any research provider reads the same way, whichever vendor reads the page", () => {
    for (const server of KEYS) {
      expect(
        readToolName(`mcp__${server}__${RESEARCH_TOOLS[server].fetch}`),
      ).toEqual({
        label: "Read web pages",
        labelKey: "tools.researchFetch",
      });
    }
  });

  test("the provider never leaks into the detail either", () => {
    // Research is the one place a connector is deliberately anonymous: the role label IS the whole
    // line, so there is no muted vendor name beside it.
    for (const server of KEYS) {
      expect(
        readToolName(`mcp__${server}__${RESEARCH_TOOLS[server].search}`).detail,
      ).toBeUndefined();
    }
  });

  test("a research server's other tools keep their own names", () => {
    // Only the reviewed pairs are roles. Anything else the vendor offers — even something that
    // sounds like search — stays humanised, never dressed up as a labelled read. This name embeds
    // the server, so the same server-drop rule as `search_notes` applies and no detail remains.
    expect(readToolName("mcp__exa__web_search_advanced_exa")).toEqual({
      label: "Web search advanced exa",
    });
    // And where the name says nothing about the server, the server stays beside it.
    expect(readToolName("mcp__exa__deep_research")).toEqual({
      label: "Deep research",
      detail: "exa",
    });
  });

  test("a tool on a server that plays no research role is untouched", () => {
    expect(readToolName("mcp__notes__search_notes")).toEqual({
      label: "Search notes",
    });
  });
});

/**
 * The role refs a skill declares, pinned against the shared parser.
 *
 * `shared/research.ts` exports the parser and not the constant (an R01 decision), so the picker's
 * refs are spelled on the app side. These tests are what keeps that from drifting: if the shared
 * prefix or role names ever move, `researchRoleOf` stops recognising what this file pins and the
 * suite goes red here — before a picker can offer a ref the server would refuse to save.
 */
describe("the role refs a skill declares", () => {
  test("every declared ref parses back to its own role", () => {
    for (const { role, ref } of RESEARCH_ROLES) {
      expect(researchRoleOf(ref)).toBe(role);
    }
  });

  test("there is exactly one ref per role, in picker order", () => {
    expect(RESEARCH_ROLES.map((entry) => entry.ref)).toEqual([
      "@research/search",
      "@research/fetch",
    ]);
  });

  test("a real server/tool ref is never a role ref", () => {
    // The old declarations keep meaning exactly what they meant: one provider's one tool.
    expect(researchRoleOf("parallel/web_search")).toBeNull();
    expect(researchRoleOf("exa/web_fetch_exa")).toBeNull();
  });
});

/**
 * The skill picker's leftovers, when a declaration names a research role.
 *
 * These live beside the ref pins above rather than beside the other `undeclaredElsewhere` cases
 * because the role vocabulary this file pins is what selection consumes: the ref list and the
 * not-a-dead-tool rule have to move together or the picker reports a legal declaration as a
 * missing tool.
 */
describe("skill selection over research role refs", () => {
  test("a role ref is never reported as a tool no server offers", () => {
    // A role names no server, so there is nothing for a server to offer and nothing missing when
    // none does. It resolves, at selection time, to whichever provider the Bot holds.
    expect(
      undeclaredElsewhere(["@research/search", "@research/fetch"], []),
    ).toEqual([]);
  });

  test("an old real ref still reports when no connected server offers it", () => {
    // Compat: `parallel/web_search` is a claim about one server, and when that server is absent
    // the person governing the skill still gets told.
    expect(
      undeclaredElsewhere(["parallel/web_search"], ["exa/web_search_exa"]),
    ).toEqual(["parallel/web_search"]);
  });

  test("real offered refs and role refs coexist in one declaration", () => {
    expect(
      undeclaredElsewhere(
        ["parallel/web_search", "@research/search"],
        ["parallel/web_search"],
      ),
    ).toEqual([]);
  });

  test("a misspelled role is a dead ref and still says so", () => {
    // Fail-closed the other way: only the two exact role spellings are exempt, so a typo cannot
    // hide behind the exemption.
    expect(undeclaredElsewhere(["@research/serch"], [])).toEqual([
      "@research/serch",
    ]);
  });
});

/**
 * The research vocabulary on screen, in both languages the app ships.
 *
 * `readToolName` answers without a translator, so its label for a research tool IS the English
 * phrase the reader sees when no translation happens — it must be the same string the English
 * locale renders, or the two surfaces disagree. The zh entries are pinned to exist and to differ,
 * so a dropped key fails here rather than falling back to English in a Chinese transcript.
 */
describe("the research vocabulary on screen", () => {
  const read = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, `../src/locales/${locale}/channels.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
  const skills = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, `../src/locales/${locale}/skills.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;

  test("the English fallback labels are the English locale's labels", () => {
    const en = read("en") as { tools: Record<string, string> };
    expect(readToolName("mcp__parallel__web_search").label).toBe(
      en.tools.researchSearch,
    );
    expect(readToolName("mcp__parallel__web_fetch").label).toBe(
      en.tools.researchFetch,
    );
  });

  test("both languages carry the two role labels and they differ", () => {
    for (const locale of ["en", "zh-CN"]) {
      const tools = (read(locale) as { tools: Record<string, string> }).tools;
      expect(tools.researchSearch).toBeTruthy();
      expect(tools.researchFetch).toBeTruthy();
      expect(tools.researchSearch).not.toBe(tools.researchFetch);
    }
    const en = read("en") as { tools: Record<string, string> };
    const zh = read("zh-CN") as { tools: Record<string, string> };
    expect(zh.tools.researchSearch).not.toBe(en.tools.researchSearch);
  });

  test("both languages carry the summary phrases, with plurals where English needs them", () => {
    const en = read("en") as { tools: Record<string, string> };
    expect(en.tools.searchedTimes_one).toBeTruthy();
    expect(en.tools.searchedTimes_other).toBeTruthy();
    expect(en.tools.readPages_one).toBeTruthy();
    expect(en.tools.readPages_other).toBeTruthy();
    const zh = read("zh-CN") as { tools: Record<string, string> };
    expect(zh.tools.searchedTimes_other).toBeTruthy();
    expect(zh.tools.readPages_other).toBeTruthy();
  });

  test("the skill picker carries its research entries in both languages", () => {
    for (const locale of ["en", "zh-CN"]) {
      const tools = (skills(locale) as { tools: Record<string, string> }).tools;
      expect(tools.researchHeading).toBeTruthy();
      expect(tools.researchSearch).toBeTruthy();
      expect(tools.researchFetch).toBeTruthy();
      expect(tools.researchTitle).toBeTruthy();
    }
  });
});
