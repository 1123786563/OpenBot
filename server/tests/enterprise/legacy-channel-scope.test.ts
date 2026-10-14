import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import type { Database } from "../../src/db/client";
import * as schema from "../../src/db/schema/core";
import { canReadLegacyChannel } from "../../src/enterprise/authz/legacy-channel-scope";

const input = {
  actorId: "actor-sentinel-47",
  channelId: "channel-sentinel-93",
};
const botId = "bot-sentinel-18";

type CapturedQuery = { sql: string; params: unknown[] };

function databaseReturning(
  rows: unknown[],
  queries: CapturedQuery[] = [],
): Database {
  return drizzleProxy(
    async (query, params) => {
      queries.push({ sql: query, params });
      return { rows };
    },
    { schema },
  ) as unknown as Database;
}

test("maps a nonempty query result to true", async () => {
  const queries: CapturedQuery[] = [];
  expect(
    await canReadLegacyChannel(
      databaseReturning([{ channelId: input.channelId }], queries),
      input,
    ),
  ).toBe(true);
  expect(queries).toHaveLength(1);
});

test("maps empty query results to false", async () => {
  for (const request of [input, { ...input, botId }]) {
    expect(await canReadLegacyChannel(databaseReturning([]), request)).toBe(
      false,
    );
  }
});

test("denies blank and malformed identifiers without querying", async () => {
  const queries: CapturedQuery[] = [];
  const database = databaseReturning([{ channelId: input.channelId }], queries);
  for (const request of [
    { ...input, actorId: "" },
    { ...input, actorId: "   " },
    { ...input, channelId: "\n" },
    { ...input, botId: " " },
    { ...input, actorId: 3 },
  ]) {
    expect(await canReadLegacyChannel(database, request as never)).toBe(false);
  }
  expect(queries).toHaveLength(0);
});

test("denies when the database query rejects", async () => {
  const database = drizzleProxy(
    async () => {
      throw new Error("database unavailable");
    },
    { schema },
  ) as unknown as Database;
  expect(await canReadLegacyChannel(database, input)).toBe(false);
});

test("emits exact membership and Bot predicates with bound identities", async () => {
  const queries: CapturedQuery[] = [];
  const database = databaseReturning([{ channelId: input.channelId }], queries);

  expect(await canReadLegacyChannel(database, { ...input, botId })).toBe(true);
  expect(queries).toHaveLength(1);
  const botQuery = queries[0]!;
  const botSql = new PgDialect()
    .sqlToQuery(sql.raw(botQuery.sql))
    .sql.toLowerCase();
  expect(botSql).toContain(
    '"channels"."id" = "channel_memberships"."channel_id"',
  );
  expect(botSql).toContain(
    '"channel_agents"."channel_id" = "channel_memberships"."channel_id"',
  );
  expect(botSql).toContain('"channel_agents"."agent_id" = $1');
  expect(botSql).toContain('"channel_memberships"."channel_id" = $2');
  expect(botSql).toContain('"channel_memberships"."user_id" = $3');
  expect(botSql).toContain('"channels"."deleted_at" is null');
  expect(botQuery.params).toEqual([botId, input.channelId, input.actorId, 1]);

  queries.length = 0;
  expect(await canReadLegacyChannel(database, input)).toBe(true);
  expect(queries).toHaveLength(1);
  const noBotQuery = queries[0]!;
  const noBotSql = new PgDialect()
    .sqlToQuery(sql.raw(noBotQuery.sql))
    .sql.toLowerCase();
  expect(noBotSql).toContain(
    '"channels"."id" = "channel_memberships"."channel_id"',
  );
  expect(noBotSql).toContain('"channel_memberships"."channel_id" = $1');
  expect(noBotSql).toContain('"channel_memberships"."user_id" = $2');
  expect(noBotSql).toContain('"channels"."deleted_at" is null');
  expect(noBotSql).not.toContain('"channel_agents"');
  expect(noBotQuery.params).toEqual([input.channelId, input.actorId, 1]);
});
