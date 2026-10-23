# Public-web research

OpenBot ships three public-web research providers in the plugin catalogue: **Parallel**, **Exa** and **Firecrawl**. Each one gives a Bot a search tool, which finds sources for a query, and a fetch tool, which reads pages by URL. A Bot holding both tools from one provider is told how to research with them. None of this uses the Bot's browser, and no existing Bot gets new access automatically: nothing is enabled by default, and a Bot holds a provider's tools only when an administrator granted them.

| Catalogue entry           | Search tool        | Fetch tool         | Credential                                           |
| ------------------------- | ------------------ | ------------------ | ---------------------------------------------------- |
| Parallel Search           | `web_search`       | `web_fetch`        | None; provider-managed limits for light use          |
| Parallel Search (API key) | `web_search`       | `web_fetch`        | Deployment API key, sent as a Bearer token           |
| Exa Search                | `web_search_exa`   | `web_fetch_exa`    | None; free, rate-limited                             |
| Exa Search (API key)      | `web_search_exa`   | `web_fetch_exa`    | Deployment API key, sent in Exa's `x-api-key` header |
| Firecrawl                 | `firecrawl_search` | `firecrawl_scrape` | None; free access offers search, scrape and parse    |
| Firecrawl (API key)       | `firecrawl_search` | `firecrawl_scrape` | Deployment API key, sent as a Bearer token           |

## Enable research

1. As an administrator, open Plugins and add a provider from the catalogue. For the keyed entries, enter the provider's API key; it is stored in the server-side credential vault. There is no environment variable for any of this — see `.env.example`.
2. Grant that provider's search and fetch tools to the Bots that should research the public web. For the shipped fintech package, select **Research Desk**.
3. Ask the Bot to research a topic. It searches, reads selected sources and cites their URLs. Run `/research-public-web` to select the example skill explicitly if your deployment has many tools.

For production or higher limits, use a keyed entry and remove the grants on the free one. If a Bot holds a vendor's free and keyed entries, it is told about the keyed one.

## Skills declare roles, not providers

A skill names the research tools it needs as `@research/search` and `@research/fetch`, instead of one provider's tool names. Each role matches that role's tool on every research provider the Bot was actually granted — a role declaration is intersected with the grant at selection time and grants nothing by itself, so a skill can never bring in a provider the Bot does not hold. The old spellings keep working too: a skill declaring `parallel/web_search` and `parallel/web_fetch` selects exactly as it did before, and the shipped fintech skill still does.

## Choice and controls

The Bot's guidance is written per provider it holds — "Exa: `mcp__exa__web_search_exa` finds sources …" — and a Bot holding more than one provider is told about each and uses the one the person asks for. Nothing in the guidance tells the model to switch providers when one fails: a missing key, a rejected credential, a revocation, a timeout and a policy refusal each surface as their own visible answer, and none of them is routed around.

Every call goes through `PluginStore.callTool`, with the usual grants, action policies and audit records naming the actual provider key, tool and credential — no raw MCP server is added to the agent configuration, and there is no research-shaped second door.

Exa and Firecrawl name the tools that only read (`readTools` in the catalogue), and every other tool they advertise counts as a write. Firecrawl publishes tool families such as `firecrawl_monitor_*`, and Exa's agent tools spend credits, so neither can be safely described by a list of writes alone. A provider's name never downgrades anything: an unknown or unlisted capability is a write, and writes go through the same policy every other connector answers to.

The provider receives model-selected objectives, search queries, requested public URLs and, for Parallel, a conversation session identifier. These can contain information from the person's request, so the Bot is told not to send private context public research does not need. Full conversations are not forwarded. Source URLs are kept and the summary's page counts are the results that actually came back.

## Costs stay in their own columns

A provider's API credits are not model tokens. Research calls run on the deployment's own key and produce no token billing of their own; what is metered stays what was metered before — the model's usage, through the existing meter. Failures are never retried against another provider to spend a cheaper one.

## Adding a provider

A provider is a catalogue entry in `server/src/plugins/catalogue.ts`, plus its two tools in `RESEARCH_TOOLS` in `shared/research.ts` (`{ search, fetch, notes? }`, keyed by the entry's key). The table is shared because the app labels these tools too. Add `readTools` to the entry when its write tools cannot be listed exhaustively. A vendor that reads its key from its own header names it in `auth: { kind: "deployment-bearer", header }`; the key then goes out in exactly that header, as stored. The Bot guidance, the skill roles and the selection intersection pick the new entry up with no other change.

Provider documentation: [Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp), [Exa](https://exa.ai/docs/reference/exa-mcp), [Firecrawl](https://docs.firecrawl.dev/mcp-server).
