import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCorsairDatabase } from "corsair/db";
import { createCorsairOrm } from "corsair/orm";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
afterAll(() => database.$client.close());

test("Corsair uses the five upstream tables and has no provider pilot tables", async () => {
  const tables = await database.execute<{ name: string }>(sql`
    select tablename as name from pg_tables
    where schemaname = 'public'
      and (tablename like 'corsair_%' or tablename ~ '^(github_pilot|slack_pilot|slack_shared)_')
    order by tablename
  `);
  expect(tables.map(({ name }) => name)).toEqual([
    "corsair_account_defaults",
    "corsair_accounts",
    "corsair_entities",
    "corsair_event_dispatches",
    "corsair_events",
    "corsair_integrations",
    "corsair_oauth_states",
    "corsair_permissions",
    "corsair_shared_access",
  ]);
});

test("pinned Corsair can write and read its core PostgreSQL records", async () => {
  const client = postgres(testDatabaseUrl(), { max: 1 });
  const { db } = createCorsairDatabase(client);
  const orm = createCorsairOrm({ db });
  const name = `compatibility-${randomUUID()}`;
  const tenant = randomUUID();
  try {
    const integration = await orm.integrations.upsertByName(name, {
      config: { enabled: true },
    });
    expect(integration.config).toEqual({ enabled: true });
    const account = await orm.accounts.upsertByTenantAndIntegration(
      tenant,
      integration.id,
      { config: { scope: "read" } },
    );
    expect(
      (await orm.accounts.findByTenantAndIntegration(tenant, name))?.id,
    ).toBe(account.id);
    const entity = {
      accountId: account.id,
      entityType: "ticket",
      entityId: "ext-1",
      version: "1.0.0",
    };
    const first = await orm.entities.upsertByEntityId({
      ...entity,
      data: { title: "First" },
    });
    const second = await orm.entities.upsertByEntityId({
      ...entity,
      data: { title: "Updated" },
    });
    expect(second.id).toBe(first.id);
    expect((await orm.entities.findByEntityId(entity))?.data).toEqual({
      title: "Updated",
    });
    const event = await orm.events.create({
      account_id: account.id,
      event_type: "ticket.updated",
      payload: { id: entity.entityId },
    });
    expect(event.status).toBe("pending");
    expect((await orm.events.updateStatus(event.id, "completed"))?.status).toBe(
      "completed",
    );
    const now = new Date();
    const permission = await db
      .insertInto("corsair_permissions")
      .values({
        id: randomUUID(),
        created_at: now,
        updated_at: now,
        tenant_id: tenant,
        plugin: name,
        endpoint: "tickets.update",
        token: randomUUID(),
        args: "{}",
        status: "pending",
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(permission).toMatchObject({
      tenant_id: tenant,
      status: "pending",
      args: "{}",
    });
  } finally {
    try {
      await db
        .deleteFrom("corsair_permissions")
        .where("tenant_id", "=", tenant)
        .execute();
      await orm.accounts.deleteMany({ tenant_id: tenant });
      const integration = await orm.integrations.findByName(name);
      if (integration) await orm.integrations.delete(integration.id);
    } finally {
      await db.destroy();
    }
  }
});
