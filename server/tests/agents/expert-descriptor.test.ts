import {
  describe,
  expect,
  spyOn,
  test,
} from "../../../tests/support/bun-test-compat";
import { BunSQLPreparedQuery } from "drizzle-orm/bun-sql";
import type { PreparedQueryConfig } from "drizzle-orm/pg-core";
import { PROVENANCE_GUIDANCE } from "../../../shared/bot-prompt";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "../../src/agents/agent-resolver";
import {
  classifyExpertSource,
  createRuntimeAgentLoader,
} from "../../src/agents/runtime-agents";
import { createDatabase } from "../../src/db/client";

/** A roster row exactly as the production projection shapes it, with controlled provenance. */
const builtInRow = (row: {
  id: string;
  systemPrompt: string;
  packageId: string | null;
  ownerUserId: string | null;
  publicationAgentId: string | null;
}) => ({
  id: row.id,
  name: row.id,
  type: "built_in" as const,
  configuration: { systemPrompt: row.systemPrompt },
  packageId: row.packageId,
  ownerUserId: row.ownerUserId,
  publicationAgentId: row.publicationAgentId,
  title: row.id,
  roleDescription: `${row.id} role.`,
});

/**
 * Real query construction with only the SQL execution boundary replaced, as in
 * picked-harness-auth.test.ts; no database ever connects.
 */
function controlledLoader(active: unknown[], tombstones: unknown[]) {
  const database = createDatabase(
    "postgres://fixture:fixture@127.0.0.1:1/never-connect",
  );
  const queries: { sql: string; params: unknown[] }[] = [];
  const refuseDatabase = spyOn(database.$client, "unsafe").mockImplementation(
    () => {
      throw new Error("This fixture must never connect to a database");
    },
  );
  const execute = spyOn(
    BunSQLPreparedQuery.prototype,
    "execute",
  ).mockImplementation(async function (
    this: BunSQLPreparedQuery<PreparedQueryConfig>,
  ) {
    const { sql, params } = this.getQuery();
    queries.push({ sql, params });
    return sql.startsWith("select distinct ") ? tombstones : active;
  });
  return {
    queries,
    restore: async () => {
      execute.mockRestore();
      refuseDatabase.mockRestore();
      await database.$client.close();
    },
    loader: createRuntimeAgentLoader(database),
  };
}

describe("authorized built-in Expert descriptor", () => {
  test("classifies only trusted, unambiguous provenance facts", () => {
    expect(
      classifyExpertSource({
        packageId: "package-1",
        ownerUserId: null,
        published: false,
      }),
    ).toBe("tenant_package");
    expect(
      classifyExpertSource({
        packageId: null,
        ownerUserId: "owner-1",
        published: true,
      }),
    ).toBe("team_bot");
    expect(
      classifyExpertSource({
        packageId: null,
        ownerUserId: "owner-1",
        published: false,
      }),
    ).toBe("user_profile");

    for (const facts of [
      { packageId: null, ownerUserId: null, published: false },
      { packageId: "package-1", ownerUserId: "owner-1", published: false },
      { packageId: "package-1", ownerUserId: null, published: true },
    ]) {
      expect(() => classifyExpertSource(facts)).toThrow();
    }
  });

  test("returns an exact-prompt descriptor only after the actor roster authorizes a built-in", async () => {
    const actor = { id: "actor-1", role: "user" as const };
    const seenActors: (typeof actor)[] = [];
    const resolver = createActorAgentResolver({
      loadAgents: async (seenActor) => {
        seenActors.push(seenActor);
        return [
          {
            id: "risk",
            name: "Risk",
            type: "built_in" as const,
            systemPrompt: "Assess operational risk.",
            expertSource: "user_profile" as const,
          },
        ];
      },
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
    });

    const resolved = await resolver.resolveBuiltInBotForActor(actor, "risk");
    expect(seenActors).toEqual([actor]);
    expect(resolved.definitionFacts).toEqual({
      agentId: "risk",
      source: "user_profile",
      systemPrompt: "Assess operational risk.",
    });
  });

  test("refuses absent, remote, unavailable, promptless, or unclassified entries", async () => {
    const actor = { id: "actor-1", role: "user" as const };
    const entries = [
      [],
      [
        {
          id: "risk",
          name: "Risk",
          type: "built_in" as const,
          systemPrompt: "Work.",
        },
      ],
      [
        {
          id: "risk",
          name: "Risk",
          type: "built_in" as const,
          systemPrompt: "  ",
          expertSource: "user_profile" as const,
        },
      ],
      [
        {
          id: "risk",
          name: "Risk",
          type: "built_in" as const,
          systemPrompt: " Work. ",
          expertSource: "user_profile" as const,
        },
      ],
      [
        {
          id: "risk",
          name: "Risk",
          type: "built_in" as const,
          systemPrompt: "Work.",
          expertSource: "untrusted" as never,
        },
      ],
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui" as const,
          endpoint: "https://agent.example",
          standingMessage: {
            id: "role",
            role: "system" as const,
            content: "Work.",
          },
          expertSource: "user_profile" as const,
        },
      ],
      [
        {
          id: "risk",
          name: "Risk",
          type: "unavailable" as const,
          reason: "Deleted",
          expertSource: "user_profile" as const,
        },
      ],
    ];

    for (const registered of entries) {
      const resolver = createActorAgentResolver({
        loadAgents: async () => registered,
        model: { provider: "openai", defaultModel: "unused" },
        resolveModelApiKey: async () => "synthetic-key",
      });
      await expect(
        resolver.resolveBuiltInBotForActor(actor, "risk"),
      ).rejects.toThrow();
    }
  });

  test("refuses a requested id outside the roster even when another authorized Bot is present", async () => {
    const actor = { id: "actor-1", role: "user" as const };
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "risk",
          name: "Risk",
          type: "built_in" as const,
          systemPrompt: "Assess operational risk.",
          expertSource: "user_profile" as const,
        },
      ],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
    });

    await expect(
      resolver.resolveBuiltInBotForActor(actor, "not-in-roster"),
    ).rejects.toThrow(CoworkerUnavailableError);
  });

  test("the production loader maps trusted provenance columns and keeps the actor predicates", async () => {
    const active = [
      builtInRow({
        id: "package-expert",
        systemPrompt: "Read the tenant package.",
        packageId: "package-1",
        ownerUserId: null,
        publicationAgentId: null,
      }),
      builtInRow({
        id: "owned-expert",
        systemPrompt: "Assess your own profile.",
        packageId: null,
        ownerUserId: "actor-1",
        publicationAgentId: null,
      }),
      builtInRow({
        id: "published-expert",
        systemPrompt: "Answer for the whole team.",
        packageId: null,
        ownerUserId: "somebody-else",
        publicationAgentId: "published-expert",
      }),
      builtInRow({
        id: "ambiguous",
        systemPrompt: "Still an ordinary Bot.",
        packageId: "package-1",
        ownerUserId: "owner-1",
        publicationAgentId: null,
      }),
    ];
    const { loader, queries, restore } = controlledLoader(active, [
      { id: "removed-coworker", name: "Removed Coworker" },
    ]);
    try {
      const loaded = await loader({ id: "actor-1", role: "user" });
      const byId = new Map(loaded.map((agent) => [agent.id, agent]));
      expect(byId.get("package-expert")).toMatchObject({
        type: "built_in",
        expertSource: "tenant_package",
      });
      expect(byId.get("owned-expert")).toMatchObject({
        type: "built_in",
        expertSource: "user_profile",
      });
      expect(byId.get("published-expert")).toMatchObject({
        type: "built_in",
        expertSource: "team_bot",
      });
      // Overlapping origins fail closed for the Expert bridge; the Bot itself stays runnable.
      const ambiguous = byId.get("ambiguous");
      expect(ambiguous).toMatchObject({
        type: "built_in",
        systemPrompt: "Still an ordinary Bot.",
      });
      expect(ambiguous?.expertSource).toBeUndefined();
      expect(byId.get("removed-coworker")).toMatchObject({
        type: "unavailable",
      });

      expect(queries).toHaveLength(2);
      const rosterQuery = queries.find(
        (query) => !query.sql.startsWith("select distinct "),
      );
      const tombstoneQuery = queries.find((query) =>
        query.sql.startsWith("select distinct "),
      );
      if (!rosterQuery || !tombstoneQuery)
        throw new Error("Expected one roster and one tombstone query");
      const rosterSql = rosterQuery.sql;

      // Provenance is projected from the intended columns, with publication from the trusted
      // table joined on its primary key so one agent row cannot fan out.
      expect(
        rosterSql.startsWith(
          'select "agents"."id", "agents"."name", "agents"."type", "agents"."configuration", "agents"."package_id", "agent_profiles"."owner_user_id", "team_bot_publications"."agent_id"',
        ),
      ).toBe(true);
      expect(rosterSql).toContain(
        'left join "team_bot_publications" on "team_bot_publications"."agent_id" = "agents"."id"',
      );
      // The actor boundary stayed in the query rather than moving into JavaScript afterwards.
      expect(rosterSql).toContain('"agent_profiles"."deleted_at" is null');
      expect(rosterSql).toContain(
        '"agent_profiles"."visibility" = $1 or "agent_profiles"."owner_user_id" = $2',
      );
      expect(rosterQuery.params.slice(0, 2)).toEqual(["public", "actor-1"]);
      // The Team Bot rule stays an exists over the trusted publication tables, bound to the actor.
      expect(rosterSql).toContain('from "team_bot_audience"');
      expect(rosterSql).toContain('from "team_bot_assignments"');
      expect(rosterQuery.params).toContain("actor-1");

      // Tombstones keep their membership predicate: history, not visibility, is what authorizes.
      expect(tombstoneQuery.sql).toContain(
        '"agent_profiles"."deleted_at" is not null',
      );
      expect(tombstoneQuery.sql).toContain(
        '"channel_memberships"."user_id" = $1',
      );
      expect(tombstoneQuery.params).toContain("actor-1");

      // An administrator keeps the tombstone guard but carries no visibility predicate.
      await loader({ id: "admin-1", role: "admin" });
      expect(queries).toHaveLength(4);
      const adminSql = queries
        .map((query) => query.sql)
        .filter((sql) => !sql.startsWith("select distinct "))[1];
      if (!adminSql) throw new Error("Expected an admin roster query");
      expect(adminSql).toContain('"agent_profiles"."deleted_at" is null');
      expect(adminSql).not.toContain('"agent_profiles"."visibility"');
    } finally {
      await restore();
    }
  });

  test("the constructed built-in execution prompt begins with the descriptor's exact prompt bytes", async () => {
    const actor = { id: "actor-1", role: "user" as const };
    const { loader, restore } = controlledLoader(
      [
        builtInRow({
          id: "published-expert",
          systemPrompt: "  Answer for the whole team.  ",
          packageId: null,
          ownerUserId: "somebody-else",
          publicationAgentId: "published-expert",
        }),
      ],
      [],
    );
    try {
      const resolver = createActorAgentResolver({
        loadAgents: loader,
        model: { provider: "openai", defaultModel: "unused" },
        resolveModelApiKey: async () => "synthetic-key",
      });
      const resolved = await resolver.resolveBuiltInBotForActor(
        actor,
        "published-expert",
      );
      // The production row mapper trimmed the stored prompt; the descriptor carries those bytes.
      expect(resolved.definitionFacts).toEqual({
        agentId: "published-expert",
        source: "team_bot",
        systemPrompt: "Answer for the whole team.",
      });
      const constructed = (
        resolved.agent as unknown as {
          configuration: { prompt?: string };
        }
      ).configuration;
      expect(typeof constructed.prompt).toBe("string");
      const prompt = constructed.prompt ?? "";
      expect(
        prompt.startsWith(`${resolved.definitionFacts.systemPrompt}\n\n`),
      ).toBe(true);
      // Generated guidance is appended for the run, never part of the Expert identity.
      expect(prompt).toContain(PROVENANCE_GUIDANCE);
      expect(prompt).not.toBe(resolved.definitionFacts.systemPrompt);
      expect(resolved.definitionFacts.systemPrompt).not.toContain(
        PROVENANCE_GUIDANCE,
      );
    } finally {
      await restore();
    }
  });
});

test("expert_classification_failure_is_logged_and_agent_survives", async () => {
  const fixture = controlledLoader(
    [
      builtInRow({
        id: "bot-ambiguous",
        systemPrompt: "Follow the registered Bot instructions.",
        packageId: "package-1",
        ownerUserId: "owner-1",
        publicationAgentId: null,
      }),
    ],
    [],
  );
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const loaded = await fixture.loader({ id: "actor-a", role: "admin" });
    // The runtime resolution survives (fail-closed Expert bridge), and the
    // swallowed classification failure leaves exactly one structured log.
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.expertSource).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect((logs[0]?.[0] as { error?: unknown })?.error).toBe(
      "EXPERT_SOURCE_CLASSIFICATION_FAILED",
    );
  } finally {
    console.error = originalError;
    await fixture.restore();
  }
});
