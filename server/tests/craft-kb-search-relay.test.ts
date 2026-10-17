import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  createCraftKbSearchRelayApp,
  projectKbSearchResults,
  type CraftKbSearch,
} from "../src/craft/kb-search-relay";
import type { CraftStore } from "../src/craft/store";
import type { KnowledgeSearchResult } from "../src/knowledge/types";

function sessionRow(
  overrides: Partial<{ id: string; status: string }> = {},
): {
  id: string;
  userId: string;
  name: string | null;
  status: string;
  lastActivityAt: Date;
  createdAt: Date;
  nextjsPort: number | null;
  sharingScope: string;
  origin: string;
  opencodeSessionId: string | null;
  agentProvider: string | null;
  agentModel: string | null;
  skillsHash: string | null;
  mcpConfigHash: string | null;
} {
  return {
    id: overrides.id ?? "cs-relay",
    userId: "u1",
    name: null,
    status: overrides.status ?? "active",
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

function storeWith(
  sessions: Record<string, { status: string }>,
): Pick<CraftStore, "findSessionById"> {
  return {
    async findSessionById(id: string) {
      const entry = sessions[id];
      return entry
        ? (sessionRow({ id, status: entry.status }) as never)
        : null;
    },
  };
}

function app(
  store: Pick<CraftStore, "findSessionById">,
  search: CraftKbSearch,
) {
  return createCraftKbSearchRelayApp({ store, search });
}

async function call(
  relayApp: ReturnType<typeof app>,
  options: {
    tag?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<Response> {
  return relayApp.fetch(
    new Request("http://craft/kb-search", {
      method: "POST",
      headers: {
        ...(options.tag !== null
          ? { "X-Onyx-Mcp-Session": options.tag ?? "cs-relay" }
          : {}),
        "content-type": "application/json",
      },
      body: options.rawBody ?? JSON.stringify(options.body ?? { queries: ["q"] }),
    }),
  );
}

const okSearch: CraftKbSearch = async () => ({
  status: "ok",
  results: [
    {
      title: "Doc",
      url: "https://example.com/doc",
      source_type: "url",
      content: "body",
      updated_at: new Date().toISOString(),
    },
  ],
});

// ── attribution (the mcp-relay contract) ────────────────────────────────────

describe("POST /api/craft/kb-search — attribution", () => {
  test("no session tag: 403 not_authorized, the search never runs", async () => {
    let ran = false;
    const response = await call(
      app(storeWith({ "cs-relay": { status: "active" } }), async () => {
        ran = true;
        return { status: "ok", results: [] };
      }),
      { tag: null },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
    expect(ran).toBe(false);
  });

  test("unknown tag: 403 not_authorized", async () => {
    const response = await call(
      app(storeWith({}), okSearch),
      { tag: "nope" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not_authorized" });
  });

  test("a non-active session (failed/initializing) is refused too", async () => {
    const response = await call(
      app(storeWith({ "cs-relay": { status: "failed" } }), okSearch),
    );
    expect(response.status).toBe(403);
  });

  test("an attributed ACTIVE session's search runs", async () => {
    const response = await call(
      app(storeWith({ "cs-relay": { status: "active" } }), okSearch),
    );
    expect(response.status).toBe(200);
  });
});

// ── body shape ──────────────────────────────────────────────────────────────

describe("request body", () => {
  const active = { "cs-relay": { status: "active" } };

  test("invalid JSON: 400", async () => {
    const response = await call(app(storeWith(active), okSearch), {
      rawBody: "not json",
    });
    expect(response.status).toBe(400);
  });

  test("empty/non-array queries: 400", async () => {
    for (const queries of [[], "q", undefined]) {
      const response = await call(app(storeWith(active), okSearch), {
        body: { queries },
      });
      expect(response.status).toBe(400);
    }
  });

  test("more than 3 queries: 400 (onyx-cli's cap)", async () => {
    const response = await call(app(storeWith(active), okSearch), {
      body: { queries: ["a", "b", "c", "d"] },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "at most 3",
    );
  });

  test("blank query strings: 400", async () => {
    const response = await call(app(storeWith(active), okSearch), {
      body: { queries: ["  "] },
    });
    expect(response.status).toBe(400);
  });

  test("bad days / source shapes: 400", async () => {
    for (const body of [
      { queries: ["q"], days: 0 },
      { queries: ["q"], days: "7" },
      { queries: ["q"], source: "url" },
    ]) {
      const response = await call(app(storeWith(active), okSearch), { body });
      expect(response.status).toBe(400);
    }
  });
});

// ── the onyx-cli JSON contract ──────────────────────────────────────────────

describe("response shape", () => {
  const active = { "cs-relay": { status: "active" } };

  test("single query: top-level results with onyx-cli's fields", async () => {
    const response = await call(app(storeWith(active), okSearch));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(1);
    for (const field of [
      "title",
      "url",
      "source_type",
      "content",
      "updated_at",
    ]) {
      expect(field in body.results[0]!).toBe(true);
    }
  });

  test("multiple queries: searches in argument order, results per query", async () => {
    const seen: string[] = [];
    const response = await call(
      app(
        storeWith(active),
        async ({ query }) => {
          seen.push(query);
          return {
            status: "ok" as const,
            results: [
              {
                title: query,
                url: "",
                source_type: "text",
                content: `for ${query}`,
                updated_at: new Date().toISOString(),
              },
            ],
          };
        },
      ),
      { body: { queries: ["first", "second"] } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      searches: Array<{ query: string; results: unknown[] }>;
    };
    expect(body.searches.map((s) => s.query)).toEqual(["first", "second"]);
    expect(seen.sort()).toEqual(["first", "second"]);
  });

  test("partial failure: the failed query carries error + null results, HTTP 200", async () => {
    const response = await call(
      app(
        storeWith(active),
        async ({ query }) =>
          query === "bad"
            ? { status: "unavailable" as const }
            : {
                status: "ok" as const,
                results: [],
              },
      ),
      { body: { queries: ["good", "bad"] } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      searches: Array<{
        query: string;
        results: unknown[] | null;
        error?: string;
      }>;
    };
    expect(body.searches[0]).toEqual({ query: "good", results: [] });
    expect(body.searches[1]!.results).toBeNull();
    expect(body.searches[1]!.error).toBeDefined();
  });

  test("single query failure: 503, not a null-results 200", async () => {
    const response = await call(
      app(storeWith(active), async () => ({ status: "unavailable" as const })),
    );
    expect(response.status).toBe(503);
  });

  test("a throwing search degrades to the unavailable shape", async () => {
    const response = await call(
      app(storeWith(active), async () => {
        throw new Error("boom");
      }),
    );
    expect(response.status).toBe(503);
  });
});

// ── the projection (merge / filter / cut) ───────────────────────────────────

describe("projectKbSearchResults", () => {
  const result = (overrides: Partial<KnowledgeSearchResult>): KnowledgeSearchResult => ({
    chunk_id: "c1",
    doc_id: "d1",
    content: "body",
    score: 1,
    source: "https://example.com",
    metadata: {
      title: "T",
      source_type: "url",
      updated_at: new Date().toISOString(),
    },
    ...overrides,
  });

  test("dedups on (doc, chunk) and orders by score descending", () => {
    const projected = projectKbSearchResults([
      result({ score: 0.1, doc_id: "d2", chunk_id: "c2", source: "b" }),
      result({ score: 0.9 }),
      result({ score: 0.9 }),
    ]);
    expect(projected).toHaveLength(2);
    expect(projected[0]!.score ?? projected[0]!.title).toBeDefined();
    expect(projected[0]!.url).toBe("https://example.com");
    expect(projected[1]!.url).toBe("b");
  });

  test("--days keeps only results inside the window", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const projected = projectKbSearchResults(
      [result({}), result({ metadata: { title: "T", source_type: "url", updated_at: old } })],
      { days: 30 },
    );
    expect(projected).toHaveLength(1);
  });

  test("--source filters on the KB domain's source types", () => {
    const projected = projectKbSearchResults(
      [
        result({ metadata: { title: "T", source_type: "url", updated_at: new Date().toISOString() } }),
        result({ doc_id: "d2", metadata: { title: "T", source_type: "text", updated_at: new Date().toISOString() } }),
      ],
      { sourceTypes: ["text"] },
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]!.source_type).toBe("text");
  });

  test("caps at the top-N ceiling", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      result({ doc_id: `d${i}`, chunk_id: `c${i}`, score: 1 - i / 100 }),
    );
    expect(projectKbSearchResults(many)).toHaveLength(20);
  });
});
