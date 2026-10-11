import { afterAll, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { enterpriseTestDatabaseUrlFrom } from "../support/enterprise-database";

const enabled = process.env.ENTERPRISE_TEST_R2_MIGRATION_MODE === "fresh";
const serverRoot = join(import.meta.dir, "../..");
const migrationsRoot = join(serverRoot, "drizzle");
const fixtureNames: string[] = [];
let temporaryMigrationDirectory: string | undefined;

function fixtureUrl(baseUrl: string, databaseName: string) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createDatabaseFrom(
  setup: ReturnType<typeof postgres>,
  template: string | null = null,
) {
  const name = `openbot_r2_${crypto.randomUUID().replaceAll("-", "")}`;
  fixtureNames.push(name);
  await setup.unsafe(
    template
      ? `CREATE DATABASE "${name}" TEMPLATE "${template}"`
      : `CREATE DATABASE "${name}"`,
  );
  return name;
}

async function migrationFolderThrough62() {
  temporaryMigrationDirectory = await mkdtemp(
    join(tmpdir(), "openbot-r2-migrations-"),
  );
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name)) {
      const index = Number(entry.name.slice(0, 4));
      if (index <= 62)
        await cp(
          join(migrationsRoot, entry.name),
          join(temporaryMigrationDirectory, entry.name),
        );
    }
  }
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 62);
  await mkdir(join(temporaryMigrationDirectory, "meta"), { recursive: true });
  await writeFile(
    join(temporaryMigrationDirectory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  return temporaryMigrationDirectory;
}

async function migrateDatabase(databaseUrl: string, folder: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function bootstrapCapabilityRoles(databaseUrl: string) {
  const rolesSql = await readFile(
    join(serverRoot, "ops/enterprise/roles.sql"),
    "utf8",
  );
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(`BEGIN;\n${rolesSql}\nCOMMIT;`).simple();
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function seedLegacyValue(
  databaseUrl: string,
  kind: string,
  encodedIntent: string | undefined,
  attachments: string[] = [],
) {
  const client = postgres(databaseUrl, { max: 1 });
  const tenant = `${kind}-tenant`;
  const workspace = `${kind}-workspace`;
  const principal = `${kind}-principal`;
  const runId = crypto.randomUUID();
  const thread = `${kind}-thread`;
  const clientKey = `${kind}-client-key`;
  try {
    await client.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = 'replica'`;
      if (kind === "zero-run") {
        await transaction`
          INSERT INTO enterprise_runs (
            id, tenant_id, workspace_id, principal_id, thread_id,
            client_message_key, expert_version_ref, model_route_ref,
            model_route_maximum_tokens, lease_expires_at
          ) VALUES (
            ${runId}, ${tenant}, ${workspace}, ${principal}, ${thread},
            ${clientKey}, 'legacy-expert', 'legacy-route', 0, now() + interval '1 hour'
          )
        `;
        return;
      }
      if (kind === "over-limit-reservation") {
        await transaction`
          INSERT INTO enterprise_runs (
            id, tenant_id, workspace_id, principal_id, thread_id,
            client_message_key, expert_version_ref, model_route_ref,
            model_route_maximum_tokens, lease_expires_at
          ) VALUES (
            ${runId}, ${tenant}, ${workspace}, ${principal}, ${thread},
            ${`${clientKey}-run`}, 'legacy-expert', 'legacy-route', 1, now() + interval '1 hour'
          )
        `;
        await transaction`
          INSERT INTO enterprise_model_budget_reservations (
            tenant_id, workspace_id, principal_id, run_id, idempotency_key,
            model_route_ref, token_limit, confirmed_tokens, expires_at
          ) VALUES (
            ${tenant}, ${workspace}, ${principal}, ${runId}, ${clientKey},
            'legacy-route', 1, 2, now() + interval '1 hour'
          )
        `;
        return;
      }

      await transaction`
        INSERT INTO mastra_message_intents (
          tenant_id, thread_id, client_message_key, message_id, digest,
          reserved_seq, actor_id, principal_id, backend_version, attachment_ids
        ) VALUES (
          ${tenant}, ${thread}, ${clientKey}, ${`${kind}-message`}, ${kind},
          1, ${`${kind}-actor`}, ${principal}, 1,
          ${encodedIntent ?? "[]"}::jsonb
        )
      `;
      for (const attachmentId of attachments) {
        await transaction`
          INSERT INTO mastra_message_intent_attachments (
            tenant_id, thread_id, client_message_key, attachment_id
          ) VALUES (${tenant}, ${thread}, ${clientKey}, ${attachmentId}::uuid)
        `;
      }
    });
    return { tenant, workspace, principal, runId, thread, clientKey };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function migrationState(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [journal] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    const [intent] = await client<{ attachment_ids: unknown }[]>`
      SELECT attachment_ids FROM mastra_message_intents LIMIT 1
    `;
    const [runs] = await client<{ ceilings: number[] | null }[]>`
      SELECT array_agg(model_route_maximum_tokens ORDER BY id) AS ceilings
      FROM enterprise_runs
    `;
    const [reservations] = await client<{ totals: string[] | null }[]>`
      SELECT array_agg(token_limit || ':' || confirmed_tokens ORDER BY id) AS totals
      FROM enterprise_model_budget_reservations
    `;
    return {
      migrationCount: journal?.count ?? 0,
      attachmentIds: intent?.attachment_ids,
      runCeilings: runs?.ceilings,
      reservationTotals: reservations?.totals,
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function runMigration(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsRoot });
    return { failed: false, message: "" };
  } catch (error) {
    return { failed: true, message: String(error) };
  } finally {
    await client.end({ timeout: 5 });
  }
}

test.skipIf(!enabled)(
  "0063 blocks unresolved legacy values atomically and upgrades validated intents",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const endpoint = new URL(setupUrl);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(endpoint.hostname);
    expect(endpoint.port).toBe("5434");
    const setup = postgres(setupUrl, { max: 1 });
    let template: string | undefined;
    try {
      template = await createDatabaseFrom(setup);
      const templateUrl = fixtureUrl(setupUrl, template);
      await bootstrapCapabilityRoles(templateUrl);
      await migrateDatabase(templateUrl, await migrationFolderThrough62());

      const blockedCases = [
        {
          kind: "zero-run",
          encoded: undefined,
          expected: "invalid_run_ceiling_count=1",
        },
        {
          kind: "over-limit-reservation",
          encoded: undefined,
          expected: "invalid_reservation_count=1",
        },
        {
          kind: "malformed-json",
          encoded: JSON.stringify("not-json"),
          expected: "malformed_intent_json_count=1",
        },
        {
          kind: "non-array",
          encoded: JSON.stringify(JSON.stringify({ nope: true })),
          expected: "non_array_intent_count=1",
        },
        {
          kind: "duplicate",
          encoded: JSON.stringify(
            JSON.stringify([
              "11111111-1111-4111-8111-111111111111",
              "11111111-1111-4111-8111-111111111111",
            ]),
          ),
          expected: "invalid_uuid_or_duplicate_intent_count=1",
        },
        {
          kind: "holder-mismatch",
          encoded: JSON.stringify(
            JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
          ),
          expected: "holder_mismatch_intent_count=1",
        },
      ];

      for (const blocked of blockedCases) {
        const databaseName = await createDatabaseFrom(setup, template);
        const databaseUrl = fixtureUrl(setupUrl, databaseName);
        const original = await seedLegacyValue(
          databaseUrl,
          blocked.kind,
          blocked.encoded,
        );
        const before = await migrationState(databaseUrl);
        const result = await runMigration(databaseUrl);
        expect(result.failed).toBe(true);
        expect(result.message).toContain(blocked.expected);
        expect(await migrationState(databaseUrl)).toEqual(before);
        if (original && blocked.encoded) {
          const client = postgres(databaseUrl, { max: 1 });
          try {
            const [source] = await client<{ attachment_ids: unknown }[]>`
              SELECT attachment_ids FROM mastra_message_intents
              WHERE tenant_id = ${original.tenant}
                AND thread_id = ${original.thread}
                AND client_message_key = ${original.clientKey}
            `;
            expect(source?.attachment_ids).toBe(JSON.parse(blocked.encoded));
          } finally {
            await client.end({ timeout: 5 });
          }
        }
      }

      const successName = await createDatabaseFrom(setup, template);
      const successUrl = fixtureUrl(setupUrl, successName);
      const ids = [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ];
      const successIntent = JSON.stringify(JSON.stringify(ids));
      const source = await seedLegacyValue(
        successUrl,
        "valid-encoded-array",
        successIntent,
        ids,
      );
      const native = await seedLegacyValue(
        successUrl,
        "native-array",
        JSON.stringify(ids),
        ids,
      );
      const upgraded = await runMigration(successUrl);
      expect(upgraded.failed).toBe(false);
      const client = postgres(successUrl, { max: 1 });
      try {
        const validRunId = crypto.randomUUID();
        await client.begin(async (transaction) => {
          await transaction`SET LOCAL session_replication_role = 'replica'`;
          await transaction`
            INSERT INTO enterprise_runs (
              id, tenant_id, workspace_id, principal_id, thread_id,
              client_message_key, expert_version_ref, model_route_ref,
              model_route_maximum_tokens, lease_expires_at
            ) VALUES (
              ${validRunId}, 'valid-tenant', 'valid-workspace', 'valid-principal',
              'valid-thread', 'valid-client-key', 'expert', 'route', 5,
              now() + interval '1 hour'
            )
          `;
        });
        const [converted] = await client<{ attachment_ids: string[] }[]>`
          SELECT attachment_ids FROM mastra_message_intents
          WHERE tenant_id = ${source?.tenant}
        `;
        const [preserved] = await client<{ attachment_ids: string[] }[]>`
          SELECT attachment_ids FROM mastra_message_intents
          WHERE tenant_id = ${native?.tenant}
        `;
        expect(converted?.attachment_ids).toEqual(ids);
        expect(preserved?.attachment_ids).toEqual(ids);
        const [holderRows] = await client<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM mastra_message_intent_attachments
          WHERE (tenant_id, thread_id, client_message_key) IN (
            (${source?.tenant}, ${source?.thread}, ${source?.clientKey}),
            (${native?.tenant}, ${native?.thread}, ${native?.clientKey})
          )
        `;
        expect(holderRows?.count).toBe(4);
        await expect(client`
          UPDATE enterprise_runs SET model_route_maximum_tokens = 0
          WHERE id = ${validRunId}
        `).rejects.toThrow();
        await client.begin(async (transaction) => {
          await transaction`SET LOCAL session_replication_role = 'replica'`;
          await transaction`
            INSERT INTO enterprise_model_budget_reservations (
              tenant_id, workspace_id, principal_id, run_id, idempotency_key,
              model_route_ref, token_limit, confirmed_tokens, expires_at
            ) VALUES (
              'valid-tenant', 'valid-workspace', 'valid-principal', ${validRunId},
              'valid-reservation', 'route', 1, 0, now() + interval '1 hour'
            )
          `;
        });
        await expect(client`
          UPDATE enterprise_model_budget_reservations
          SET confirmed_tokens = 2 WHERE idempotency_key = 'valid-reservation'
        `).rejects.toThrow();
        await expect(
          client.begin(async (transaction) => {
            await transaction`SET LOCAL session_replication_role = 'replica'`;
            await transaction`INSERT INTO mastra_message_intents (
              tenant_id, thread_id, client_message_key, message_id, digest,
              reserved_seq, actor_id, principal_id, backend_version, attachment_ids
            ) VALUES ('x','x','x','x','x',1,'x','x',1,'not-an-array'::jsonb)`;
          }),
        ).rejects.toThrow();
      } finally {
        await client.end({ timeout: 5 });
      }
    } finally {
      await setup.end({ timeout: 5 });
      const cleanup = postgres(setupUrl, { max: 1 });
      try {
        for (const name of fixtureNames.reverse())
          await cleanup.unsafe(
            `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
          );
      } finally {
        await cleanup.end({ timeout: 5 });
      }
      if (temporaryMigrationDirectory)
        await rm(temporaryMigrationDirectory, { recursive: true, force: true });
    }
  },
);

afterAll(async () => {
  if (fixtureNames.length === 0 && temporaryMigrationDirectory)
    await rm(temporaryMigrationDirectory, { recursive: true, force: true });
});
