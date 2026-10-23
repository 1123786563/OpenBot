import { describe, expect, test } from "../../tests/support/e2e-compat";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { RESEARCH_TOOLS, researchRoleOf } from "../../shared/research";
import {
  catalogueEntry,
  classifyTool,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import { type GrantedTool, grantedToolGuidance } from "../src/plugins/tools";

const tool = (server: string, name: string): GrantedTool => ({
  name: `mcp__${server}__${name}`,
  ref: `${server}/${name}`,
  description: "Public web",
  parameters: z.object({}),
  execute: async () => "unused",
});
const pair = (server = "parallel") => [
  tool(server, "web_search"),
  tool(server, "web_fetch"),
];
describe("Parallel public-web research", () => {
  test("pins anonymous and authenticated configurations to the official endpoint", () => {
    for (const key of ["parallel", "parallel-authenticated"]) {
      const resolved = resolveServerUrl(key, "https://attacker.example");
      expect(resolved?.url).toBe("https://search.parallel.ai/mcp");
      expect(classifyTool(resolved!.entry, "web_search", true)).toBe("read");
      expect(classifyTool(resolved!.entry, "web_fetch", true)).toBe("read");
      expect(classifyTool(resolved!.entry, "not_advertised", false)).toBe(
        "write",
      );
      expect(classifyTool(resolved!.entry, "web_search", true, "write")).toBe(
        "write",
      );
    }
    expect(catalogueEntry("parallel")?.auth.kind).toBe("none");
    expect(serverCredentialKind(catalogueEntry("parallel")!)).toBeNull();
    expect(
      serverCredentialKind(catalogueEntry("parallel-authenticated")!),
    ).toBe("mcp");
  });
  test("describes Parallel research only while both tools are actually offered", () => {
    expect(grantedToolGuidance(pair())).toContain(
      "For public-web research you can use:",
    );
    expect(grantedToolGuidance(pair())).toContain(
      "- Parallel: mcp__parallel__web_search finds sources and mcp__parallel__web_fetch reads selected pages.",
    );
    // Described, not preferred: a Bot holding another search tool is not told to pass it over.
    expect(grantedToolGuidance(pair())).not.toContain("by default");
    expect(grantedToolGuidance([tool("parallel", "web_search")])).not.toContain(
      "public-web research",
    );
    expect(grantedToolGuidance([], ["parallel"])).not.toContain(
      "public-web research",
    );
    expect(grantedToolGuidance([])).toBe("");
  });
  test("uses deployment-authenticated research when both connectors are authorized", () => {
    const guidance = grantedToolGuidance([
      ...pair(),
      ...pair("parallel-authenticated"),
    ]);
    expect(guidance).toContain(
      "- Parallel: mcp__parallel-authenticated__web_search finds sources and mcp__parallel-authenticated__web_fetch reads selected pages.",
    );
    expect(guidance).not.toContain("mcp__parallel__web_search");
    expect(guidance).toContain("do not connect a person's private account");
  });
  test("keeps Parallel's own session guidance, injected as its note and nowhere else", () => {
    const guidance = grantedToolGuidance(pair("parallel-authenticated"));
    expect(guidance).toContain("Parallel: Generate one session_id");
    expect(guidance).toContain("Parallel: Omit model_name");
  });
  test("ships a Research Desk declaration referencing research roles without granting access", () => {
    const skills = parse(
      readFileSync(
        new URL("../../examples/fintech/skills.yaml", import.meta.url),
        "utf8",
      ),
    ).skills;
    const skill = skills.find(
      (item: { slug: string }) => item.slug === "research-public-web",
    );
    // The shipped skill declares the two research roles and nothing else. A declaration is a
    // claim about which roles a Bot needs, intersected with the tools it already holds at
    // selection time (pinned in web-research.test.ts), so it grants nobody anything by existing.
    expect(skill.tools).toEqual(["@research/search", "@research/fetch"]);
    for (const ref of skill.tools as string[])
      expect(researchRoleOf(ref)).not.toBeNull();
    // The roles still resolve onto Parallel's own real tool names at both catalogue spellings, so
    // grants of the original real refs keep working beside role declarations.
    expect(RESEARCH_TOOLS.parallel).toMatchObject({
      search: "web_search",
      fetch: "web_fetch",
    });
    expect(RESEARCH_TOOLS["parallel-authenticated"]).toMatchObject({
      search: "web_search",
      fetch: "web_fetch",
    });
    for (const key of ["parallel", "parallel-authenticated"])
      expect(catalogueEntry(key)).not.toBeNull();
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
