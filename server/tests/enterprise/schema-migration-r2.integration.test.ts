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
const temporaryMigrationDirectories: string[] = [];

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
  const temporaryMigrationDirectory = await mkdtemp(
    join(tmpdir(), "openbot-r2-migrations-"),
  );
  temporaryMigrationDirectories.push(temporaryMigrationDirectory);
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

async function migrationFolderThrough64WithoutIntentLocks() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-r2-legacy-0063-"));
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name)) {
      const index = Number(entry.name.slice(0, 4));
      if (index <= 64)
        await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
    }
  }
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 64);
  await mkdir(join(directory, "meta"), { recursive: true });
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  const migrationPath = join(directory, "0063_restore_schema_invariants.sql");
  const migrationSql = await readFile(migrationPath, "utf8");
  await writeFile(
    migrationPath,
    migrationSql.replaceAll(
      "\tLOCK TABLE mastra_message_intents IN SHARE ROW EXCLUSIVE MODE;\n\tLOCK TABLE mastra_message_intent_attachments IN SHARE ROW EXCLUSIVE MODE;\n",
      "",
    ),
  );
  return directory;
}

async function expectInvariantLocksBeforePreflightCounts() {
  for (const migrationName of [
    "0063_restore_schema_invariants.sql",
    "0065_restore_schema_invariant_guards.sql",
  ]) {
    const sql = await readFile(join(migrationsRoot, migrationName), "utf8");
    const runCount = sql.indexOf("SELECT count(*) INTO invalid_run_count");
    const reservationCount = sql.indexOf(
      "SELECT count(*) INTO invalid_reservation_count",
    );
    const runLock = sql.indexOf(
      "LOCK TABLE enterprise_runs IN SHARE ROW EXCLUSIVE MODE",
    );
    const reservationLock = sql.indexOf(
      "LOCK TABLE enterprise_model_budget_reservations IN SHARE ROW EXCLUSIVE MODE",
    );
    const intentLock = sql.indexOf("LOCK TABLE mastra_message_intents");
    const attachmentLock = sql.indexOf(
      "LOCK TABLE mastra_message_intent_attachments",
    );
    const intentScan = sql.indexOf("FOR intent IN");
    const backfill = sql.indexOf("UPDATE mastra_message_intents");
    expect(runLock).toBeGreaterThanOrEqual(0);
    expect(reservationLock).toBeGreaterThan(runLock);
    expect(runCount).toBeGreaterThan(reservationLock);
    expect(reservationCount).toBeGreaterThan(runCount);
    expect(intentLock).toBeGreaterThan(reservationCount);
    expect(attachmentLock).toBeGreaterThan(intentLock);
    expect(intentScan).toBeGreaterThan(attachmentLock);
    expect(backfill).toBeGreaterThan(intentScan);
  }
}

async function migrationFolderWithWindowBarrier(advisoryKey: number) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-r2-window-"));
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name)) {
      const index = Number(entry.name.slice(0, 4));
      if (index <= 63)
        await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
    }
  }
  await mkdir(join(directory, "meta"), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 63);
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  const migrationPath = join(directory, "0063_restore_schema_invariants.sql");
  const migrationSql = await readFile(migrationPath, "utf8");
  const postflight =
    "END\n$migration$;--> statement-breakpoint\n\nUPDATE mastra_message_intents";
  if (!migrationSql.includes(postflight))
    throw new Error(
      "Could not locate the 0063 post-preflight migration barrier point.",
    );
  await writeFile(
    migrationPath,
    migrationSql.replace(
      postflight,
      `END\n$migration$;--> statement-breakpoint\n\nSELECT pg_advisory_lock(${advisoryKey});--> statement-breakpoint\nSELECT pg_advisory_unlock(${advisoryKey});--> statement-breakpoint\n\nUPDATE mastra_message_intents`,
    ),
  );
  return directory;
}

test("0063 window fixture journal matches its copied migration files", async () => {
  const directory = await migrationFolderWithWindowBarrier(202610110063);
  const files = await readdir(directory);
  const copiedIndexes = files
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((left, right) => left - right);
  const journal = JSON.parse(
    await readFile(join(directory, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };

  expect(journal.entries.map((entry) => entry.idx)).toEqual(copiedIndexes);
});

async function migrationFolderWithForwardWindowBarrier(advisoryKey: number) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-r2-forward-window-"));
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name)) {
      const index = Number(entry.name.slice(0, 4));
      if (index <= 65)
        await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
    }
  }
  await mkdir(join(directory, "meta"), { recursive: true });
  await cp(
    join(migrationsRoot, "meta/_journal.json"),
    join(directory, "meta/_journal.json"),
  );
  const migrationPath = join(
    directory,
    "0065_restore_schema_invariant_guards.sql",
  );
  const migrationSql = await readFile(migrationPath, "utf8");
  const postflight =
    "END\n$migration$;--> statement-breakpoint\n\nUPDATE mastra_message_intents";
  if (!migrationSql.includes(postflight))
    throw new Error(
      "Could not locate the 0065 post-preflight migration barrier point.",
    );
  await writeFile(
    migrationPath,
    migrationSql.replace(
      postflight,
      `END\n$migration$;--> statement-breakpoint\n\nSELECT pg_advisory_lock(${advisoryKey});--> statement-breakpoint\nSELECT pg_advisory_unlock(${advisoryKey});--> statement-breakpoint\n\nUPDATE mastra_message_intents`,
    ),
  );
  return directory;
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
          ${encodedIntent ?? "[]"}::text::jsonb
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

async function runMigration(databaseUrl: string, folder = migrationsRoot) {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
    return { failed: false, message: "" };
  } catch (error) {
    const details: string[] = [];
    let current: unknown = error;
    while (current && typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") details.push(value.message);
      current = value.cause;
    }
    if (details.length === 0) details.push(String(error));
    return { failed: true, message: details.join("\n") };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function waitForActivity(
  predicate: () => Promise<{ pid: number } | undefined>,
  description: string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = await predicate();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PostgreSQL activity: ${description}`);
}

async function intentAttachmentValue(
  databaseUrl: string,
  tenantId: string,
  threadId: string,
  clientMessageKey: string,
) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<{ attachment_ids: unknown; raw: string }[]>`
      SELECT attachment_ids, attachment_ids::text AS raw
      FROM mastra_message_intents
      WHERE tenant_id = ${tenantId}
        AND thread_id = ${threadId}
        AND client_message_key = ${clientMessageKey}
    `;
    return row;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function expectConstraintFailure(
  query: PromiseLike<unknown>,
  constraint: string,
) {
  const outcome = await Promise.resolve(query).then(
    () => ({ rejected: false as const }),
    (error: { code?: string; constraint_name?: string }) => ({
      rejected: true as const,
      error,
    }),
  );
  expect(outcome.rejected).toBe(true);
  if (outcome.rejected) {
    expect(outcome.error.code).toBe("23514");
    expect(outcome.error.constraint_name).toBe(constraint);
  }
}

async function seedValidRunAndReservation(databaseUrl: string, prefix: string) {
  const client = postgres(databaseUrl, { max: 1 });
  const runId = crypto.randomUUID();
  const tenant = `${prefix}-tenant`;
  const workspace = `${prefix}-workspace`;
  const principal = `${prefix}-principal`;
  try {
    await client.begin(async (transaction) => {
      await transaction`SET LOCAL session_replication_role = 'replica'`;
      await transaction`
        INSERT INTO enterprise_runs (
          id, tenant_id, workspace_id, principal_id, thread_id,
          client_message_key, expert_version_ref, model_route_ref,
          model_route_maximum_tokens, lease_expires_at
        ) VALUES (
          ${runId}, ${tenant}, ${workspace}, ${principal}, ${`${prefix}-thread`},
          ${`${prefix}-run-key`}, 'writer-window-expert', 'writer-window-route',
          400, now() + interval '1 hour'
        )
      `;
      await transaction`
        INSERT INTO enterprise_model_budget_reservations (
          tenant_id, workspace_id, principal_id, run_id, idempotency_key,
          model_route_ref, token_limit, confirmed_tokens, expires_at
        ) VALUES (
          ${tenant}, ${workspace}, ${principal}, ${runId},
          ${`${prefix}-reservation-key`}, 'writer-window-route', 300, 120,
          now() + interval '1 hour'
        )
      `;
    });
    return {
      runId,
      reservationKey: `${prefix}-reservation-key`,
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function startInvalidRunAndReservationWriters(
  databaseUrl: string,
  control: ReturnType<typeof postgres>,
  migrationPid: number,
  rows: Awaited<ReturnType<typeof seedValidRunAndReservation>>,
) {
  const runWriter = postgres(databaseUrl, { max: 1 });
  const reservationWriter = postgres(databaseUrl, { max: 1 });
  let runSettled = false;
  let reservationSettled = false;
  const runPromise = runWriter
    .begin(
      (transaction) => transaction`
        UPDATE enterprise_runs
        SET model_route_maximum_tokens = 0
        WHERE id = ${rows.runId}
      `,
    )
    .then(
      () => ({ code: undefined, constraint_name: undefined }),
      (error: { code?: string; constraint_name?: string }) => ({
        code: error.code,
        constraint_name: error.constraint_name,
      }),
    )
    .finally(() => {
      runSettled = true;
    });
  const reservationPromise = reservationWriter
    .begin(
      (transaction) => transaction`
        UPDATE enterprise_model_budget_reservations
        SET token_limit = 0
        WHERE idempotency_key = ${rows.reservationKey}
      `,
    )
    .then(
      () => ({ code: undefined, constraint_name: undefined }),
      (error: { code?: string; constraint_name?: string }) => ({
        code: error.code,
        constraint_name: error.constraint_name,
      }),
    )
    .finally(() => {
      reservationSettled = true;
    });

  try {
    const writerActivities = await waitForActivity(async () => {
      const activities = await control<{ pid: number; query: string }[]>`
        SELECT pid, query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND pid <> ${migrationPid}
          AND wait_event_type = 'Lock'
          AND (
            query ILIKE '%UPDATE enterprise_runs%'
            OR query ILIKE '%UPDATE enterprise_model_budget_reservations%'
          )
      `;
      return activities.length === 2 ? activities[0] : undefined;
    }, "Run and reservation writers blocked by migration locks");
    expect(writerActivities.pid).not.toBe(migrationPid);
    expect(runSettled).toBe(false);
    expect(reservationSettled).toBe(false);
    const blockedWriters = await control<{ pid: number; query: string }[]>`
      SELECT pid, query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND pid <> ${migrationPid}
        AND wait_event_type = 'Lock'
        AND (
          query ILIKE '%UPDATE enterprise_runs%'
          OR query ILIKE '%UPDATE enterprise_model_budget_reservations%'
        )
    `;
    expect(blockedWriters).toHaveLength(2);
    return {
      async expectRejected() {
        const [runResult, reservationResult] = await Promise.all([
          runPromise,
          reservationPromise,
        ]);
        expect(runResult).toEqual({
          code: "23514",
          constraint_name: "enterprise_runs_model_route_maximum_tokens_check",
        });
        expect(reservationResult).toEqual({
          code: "23514",
          constraint_name: "enterprise_budget_reservation_tokens_check",
        });
      },
      async close() {
        await Promise.all([
          runWriter.end({ timeout: 5 }),
          reservationWriter.end({ timeout: 5 }),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([
      runPromise,
      reservationPromise,
      runWriter.end({ timeout: 5 }),
      reservationWriter.end({ timeout: 5 }),
    ]);
    throw error;
  }
}

async function exerciseMigrationWriterWindow(
  setup: ReturnType<typeof postgres>,
  setupUrl: string,
  template: string,
) {
  const databaseName = await createDatabaseFrom(setup, template);
  const databaseUrl = fixtureUrl(setupUrl, databaseName);
  const invariantRows = await seedValidRunAndReservation(
    databaseUrl,
    "0063-window",
  );
  const barrierKey = 202610110063;
  const migrationFolder = await migrationFolderWithWindowBarrier(barrierKey);
  const control = postgres(databaseUrl, { max: 1 });
  const writer = postgres(databaseUrl, { max: 1 });
  let invariantWriters:
    | Awaited<ReturnType<typeof startInvalidRunAndReservationWriters>>
    | undefined;
  let migrationPromise: ReturnType<typeof runMigration> | undefined;
  let writerPromise:
    | Promise<{ committed: boolean; message: string }>
    | undefined;
  let barrierHeld = false;
  try {
    await control`SELECT pg_advisory_lock(${barrierKey})`;
    barrierHeld = true;
    migrationPromise = runMigration(databaseUrl, migrationFolder);

    const migrationActivity = await waitForActivity(async () => {
      const [activity] = await control<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND query ILIKE ${`%pg_advisory_lock(${barrierKey})%`}
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
        `;
      return activity;
    }, "migration waiting at the post-preflight barrier");

    const relationLocks = await control<
      { relation_name: string; mode: string }[]
    >`
      SELECT relation.relname AS relation_name, lock.mode
      FROM pg_locks lock
      JOIN pg_class relation ON relation.oid = lock.relation
      WHERE lock.pid = ${migrationActivity.pid}
        AND lock.granted
        AND relation.relname IN (
          'enterprise_runs', 'enterprise_model_budget_reservations',
          'mastra_message_intents', 'mastra_message_intent_attachments'
        )
    `;
    invariantWriters = await startInvalidRunAndReservationWriters(
      databaseUrl,
      control,
      migrationActivity.pid,
      invariantRows,
    );
    expect(relationLocks).toEqual(
      expect.arrayContaining([
        {
          relation_name: "enterprise_runs",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "enterprise_model_budget_reservations",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "mastra_message_intents",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "mastra_message_intent_attachments",
          mode: "ShareRowExclusiveLock",
        },
      ]),
    );

    let writerSettled = false;
    const writerIntent = {
      tenant: "window-race-tenant",
      thread: "window-race-thread",
      key: "window-race-client-key",
      message: "window-race-message",
      encoded: JSON.stringify(
        JSON.stringify(["77777777-7777-4777-8777-777777777777"]),
      ),
    };
    writerPromise = writer
      .begin(async (transaction) => {
        await transaction`SET LOCAL session_replication_role = 'replica'`;
        await transaction`
          INSERT INTO mastra_message_intents (
            tenant_id, thread_id, client_message_key, message_id, digest,
            reserved_seq, actor_id, principal_id, backend_version, attachment_ids
          ) VALUES (
            ${writerIntent.tenant}, ${writerIntent.thread}, ${writerIntent.key},
            ${writerIntent.message}, 'window-race', 1, 'window-race-actor',
            'window-race-principal', 1, ${writerIntent.encoded}::text::jsonb
          )
        `;
      })
      .then(
        () => ({ committed: true, message: "writer committed" }),
        (error) => ({ committed: false, message: String(error) }),
      )
      .finally(() => {
        writerSettled = true;
      });

    const writerActivity = await waitForActivity(async () => {
      const [activity] = await control<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND query ILIKE '%INSERT INTO mastra_message_intents%'
            AND wait_event_type = 'Lock'
        `;
      return activity;
    }, "concurrent intent writer blocked by migration locks");
    expect(writerActivity.pid).not.toBe(migrationActivity.pid);
    expect(writerSettled).toBe(false);

    await control`SELECT pg_advisory_unlock(${barrierKey})`;
    barrierHeld = false;
    const migrationResult = await migrationPromise;
    expect(migrationResult).toEqual({ failed: false, message: "" });
    const writerResult = await writerPromise;
    expect(writerResult.committed).toBe(false);
    expect(writerResult.message).toContain(
      "mastra_message_intents_attachment_ids_array_check",
    );
    await invariantWriters.expectRejected();

    const [lateIntent] = await control<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mastra_message_intents
      WHERE tenant_id = ${writerIntent.tenant}
        AND thread_id = ${writerIntent.thread}
        AND client_message_key = ${writerIntent.key}
    `;
    expect(lateIntent?.count).toBe(0);
  } finally {
    if (barrierHeld) {
      await control`SELECT pg_advisory_unlock(${barrierKey})`.catch(() => {});
    }
    await Promise.all([
      migrationPromise?.then(() => undefined),
      writerPromise?.then(() => undefined),
    ]);
    await Promise.all([
      control.end({ timeout: 5 }),
      writer.end({ timeout: 5 }),
      invariantWriters?.close(),
    ]);
  }
}

async function exerciseForwardMigrationWriterWindow(databaseUrl: string) {
  const invariantRows = await seedValidRunAndReservation(
    databaseUrl,
    "0065-window",
  );
  const barrierKey = 202610110065;
  const migrationFolder =
    await migrationFolderWithForwardWindowBarrier(barrierKey);
  const control = postgres(databaseUrl, { max: 1 });
  const writer = postgres(databaseUrl, { max: 1 });
  let invariantWriters:
    | Awaited<ReturnType<typeof startInvalidRunAndReservationWriters>>
    | undefined;
  let migrationPromise: ReturnType<typeof runMigration> | undefined;
  let writerPromise:
    | Promise<{ committed: boolean; message: string }>
    | undefined;
  let barrierHeld = false;
  try {
    await control`SELECT pg_advisory_lock(${barrierKey})`;
    barrierHeld = true;
    migrationPromise = runMigration(databaseUrl, migrationFolder);

    const migrationActivity = await waitForActivity(async () => {
      const [activity] = await control<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND query ILIKE ${`%pg_advisory_lock(${barrierKey})%`}
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `;
      return activity;
    }, "0065 waiting at the post-preflight barrier");

    const relationLocks = await control<
      { relation_name: string; mode: string }[]
    >`
      SELECT relation.relname AS relation_name, lock.mode
      FROM pg_locks lock
      JOIN pg_class relation ON relation.oid = lock.relation
      WHERE lock.pid = ${migrationActivity.pid}
        AND lock.granted
        AND relation.relname IN (
          'enterprise_runs', 'enterprise_model_budget_reservations',
          'mastra_message_intents', 'mastra_message_intent_attachments'
        )
    `;
    invariantWriters = await startInvalidRunAndReservationWriters(
      databaseUrl,
      control,
      migrationActivity.pid,
      invariantRows,
    );
    expect(relationLocks).toEqual(
      expect.arrayContaining([
        {
          relation_name: "enterprise_runs",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "enterprise_model_budget_reservations",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "mastra_message_intents",
          mode: "ShareRowExclusiveLock",
        },
        {
          relation_name: "mastra_message_intent_attachments",
          mode: "ShareRowExclusiveLock",
        },
      ]),
    );

    let writerSettled = false;
    const writerIntent = {
      tenant: "forward-window-tenant",
      thread: "forward-window-thread",
      key: "forward-window-client-key",
      message: "forward-window-message",
      attachmentId: "88888888-8888-4888-8888-888888888888",
    };
    writerPromise = writer
      .begin(async (transaction) => {
        await transaction`SET LOCAL session_replication_role = 'replica'`;
        await transaction`
          INSERT INTO mastra_message_intents (
            tenant_id, thread_id, client_message_key, message_id, digest,
            reserved_seq, actor_id, principal_id, backend_version, attachment_ids
          ) VALUES (
            ${writerIntent.tenant}, ${writerIntent.thread}, ${writerIntent.key},
            ${writerIntent.message}, 'forward-window', 1,
            'forward-window-actor', 'forward-window-principal', 1,
            ${JSON.stringify([writerIntent.attachmentId])}::text::jsonb
          )
        `;
        await transaction`
          INSERT INTO mastra_message_intent_attachments (
            tenant_id, thread_id, client_message_key, attachment_id
          ) VALUES (
            ${writerIntent.tenant}, ${writerIntent.thread}, ${writerIntent.key},
            ${writerIntent.attachmentId}::uuid
          )
        `;
      })
      .then(
        () => ({ committed: true, message: "writer committed" }),
        (error) => ({ committed: false, message: String(error) }),
      )
      .finally(() => {
        writerSettled = true;
      });

    const writerActivity = await waitForActivity(async () => {
      const [activity] = await control<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND query ILIKE '%INSERT INTO mastra_message_intents%'
          AND wait_event_type = 'Lock'
      `;
      return activity;
    }, "valid intent/attachment writer blocked by 0065 locks");
    expect(writerActivity.pid).not.toBe(migrationActivity.pid);
    expect(writerSettled).toBe(false);

    await control`SELECT pg_advisory_unlock(${barrierKey})`;
    barrierHeld = false;
    const migrationResult = await migrationPromise;
    expect(migrationResult).toEqual({ failed: false, message: "" });
    const writerResult = await writerPromise;
    expect(writerResult.committed).toBe(true);
    await invariantWriters.expectRejected();

    const [written] = await control<{ intents: number; attachments: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mastra_message_intents
          WHERE tenant_id = ${writerIntent.tenant}
            AND thread_id = ${writerIntent.thread}
            AND client_message_key = ${writerIntent.key}) AS intents,
        (SELECT count(*)::int FROM mastra_message_intent_attachments
          WHERE tenant_id = ${writerIntent.tenant}
            AND thread_id = ${writerIntent.thread}
            AND client_message_key = ${writerIntent.key}) AS attachments
    `;
    expect(written).toEqual({ intents: 1, attachments: 1 });
    const [storedIntent] = await control<
      { attachment_ids: string[]; attachment_ids_type: string }[]
    >`
      SELECT attachment_ids, jsonb_typeof(attachment_ids) AS attachment_ids_type
      FROM mastra_message_intents
      WHERE tenant_id = ${writerIntent.tenant}
        AND thread_id = ${writerIntent.thread}
        AND client_message_key = ${writerIntent.key}
    `;
    expect(storedIntent).toEqual({
      attachment_ids: [writerIntent.attachmentId],
      attachment_ids_type: "array",
    });
  } finally {
    if (barrierHeld) {
      await control`SELECT pg_advisory_unlock(${barrierKey})`.catch(() => {});
    }
    await Promise.all([
      migrationPromise?.then(() => undefined),
      writerPromise?.then(() => undefined),
    ]);
    await Promise.all([
      control.end({ timeout: 5 }),
      writer.end({ timeout: 5 }),
      invariantWriters?.close(),
    ]);
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
          kind: "non-uuid",
          encoded: JSON.stringify(JSON.stringify(["not-a-uuid"])),
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
        let repairable: Awaited<ReturnType<typeof seedLegacyValue>> | undefined;
        let repairableBefore: Awaited<ReturnType<typeof intentAttachmentValue>>;
        if (blocked.kind === "non-uuid") {
          const validIds = [
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666",
          ];
          repairable = await seedLegacyValue(
            databaseUrl,
            "repairable-before-invalid",
            JSON.stringify(JSON.stringify(validIds)),
            validIds,
          );
          repairableBefore = await intentAttachmentValue(
            databaseUrl,
            repairable.tenant,
            repairable.thread,
            repairable.clientKey,
          );
        }
        const before = await migrationState(databaseUrl);
        const result = await runMigration(databaseUrl);
        expect(result.failed).toBe(true);
        expect(result.message).toContain(blocked.expected);
        expect(await migrationState(databaseUrl)).toEqual(before);
        if (original && blocked.encoded) {
          const client = postgres(databaseUrl, { max: 1 });
          try {
            const [source] = await client<
              {
                attachment_ids: unknown;
                raw: string;
              }[]
            >`
              SELECT attachment_ids, attachment_ids::text AS raw
              FROM mastra_message_intents
              WHERE tenant_id = ${original.tenant}
                AND thread_id = ${original.thread}
                AND client_message_key = ${original.clientKey}
            `;
            expect(source?.attachment_ids).toBe(JSON.parse(blocked.encoded));
            expect(source?.raw).toBe(
              JSON.stringify(JSON.parse(blocked.encoded)),
            );
          } finally {
            await client.end({ timeout: 5 });
          }
        }
        if (repairable) {
          const repairedCandidateAfter = await intentAttachmentValue(
            databaseUrl,
            repairable.tenant,
            repairable.thread,
            repairable.clientKey,
          );
          expect(repairedCandidateAfter).toEqual(repairableBefore);
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
      const legacyRun = await seedLegacyValue(
        successUrl,
        "zero-run",
        undefined,
      );
      const legacyReservation = await seedLegacyValue(
        successUrl,
        "over-limit-reservation",
        undefined,
      );
      const fixtureEvidenceValues = {
        runCeiling: 321,
        tokenLimit: 900,
        confirmedTokens: 271,
      };
      const reconcile = postgres(successUrl, { max: 1 });
      try {
        await reconcile.begin(async (transaction) => {
          const [run] = await transaction`
            UPDATE enterprise_runs
            SET model_route_maximum_tokens = ${fixtureEvidenceValues.runCeiling}
            WHERE id = ${legacyRun?.runId}
            RETURNING id
          `;
          const [reservation] = await transaction`
            UPDATE enterprise_model_budget_reservations
            SET token_limit = ${fixtureEvidenceValues.tokenLimit},
                confirmed_tokens = ${fixtureEvidenceValues.confirmedTokens}
            WHERE idempotency_key = ${legacyReservation?.clientKey}
            RETURNING id
          `;
          expect(run?.id).toBe(legacyRun?.runId);
          expect(reservation?.id).toBeDefined();
        });
      } finally {
        await reconcile.end({ timeout: 5 });
      }
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
        const [reconciledRun] = await client<
          {
            model_route_maximum_tokens: number;
          }[]
        >`
          SELECT model_route_maximum_tokens FROM enterprise_runs
          WHERE id = ${legacyRun?.runId}
        `;
        const [reconciledReservation] = await client<
          {
            token_limit: number;
            confirmed_tokens: number;
          }[]
        >`
          SELECT token_limit, confirmed_tokens
          FROM enterprise_model_budget_reservations
          WHERE idempotency_key = ${legacyReservation?.clientKey}
        `;
        expect(reconciledRun?.model_route_maximum_tokens).toBe(
          fixtureEvidenceValues.runCeiling,
        );
        expect(reconciledReservation).toMatchObject({
          token_limit: fixtureEvidenceValues.tokenLimit,
          confirmed_tokens: fixtureEvidenceValues.confirmedTokens,
        });
        const [holderRows] = await client<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM mastra_message_intent_attachments
          WHERE (tenant_id, thread_id, client_message_key) IN (
            (${source?.tenant}, ${source?.thread}, ${source?.clientKey}),
            (${native?.tenant}, ${native?.thread}, ${native?.clientKey})
          )
        `;
        expect(holderRows?.count).toBe(4);
        await expectConstraintFailure(
          client`
          UPDATE enterprise_runs SET model_route_maximum_tokens = 0
          WHERE id = ${validRunId}
        `,
          "enterprise_runs_model_route_maximum_tokens_check",
        );
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
        await expectConstraintFailure(
          client`
          UPDATE enterprise_model_budget_reservations
          SET confirmed_tokens = 2 WHERE idempotency_key = 'valid-reservation'
        `,
          "enterprise_budget_reservation_tokens_check",
        );
        await expectConstraintFailure(
          client.begin(async (transaction) => {
            await transaction`SET LOCAL session_replication_role = 'replica'`;
            await transaction`INSERT INTO mastra_message_intents (
              tenant_id, thread_id, client_message_key, message_id, digest,
              reserved_seq, actor_id, principal_id, backend_version, attachment_ids
            ) VALUES ('x','x','x','x','x',1,'x','x',1,'"not-an-array"'::jsonb)`;
          }),
          "mastra_message_intents_attachment_ids_array_check",
        );
      } finally {
        await client.end({ timeout: 5 });
      }

      await exerciseMigrationWriterWindow(setup, setupUrl, template);
      await expectInvariantLocksBeforePreflightCounts();

      const recordedName = await createDatabaseFrom(setup, template);
      const recordedUrl = fixtureUrl(setupUrl, recordedName);
      await migrateDatabase(
        recordedUrl,
        await migrationFolderThrough64WithoutIntentLocks(),
      );
      await exerciseForwardMigrationWriterWindow(recordedUrl);
      const forwardClient = postgres(recordedUrl, { max: 1 });
      try {
        const [journal] = await forwardClient<{ applied: string[] }[]>`
          SELECT array_agg(hash ORDER BY created_at) AS applied
          FROM drizzle.__drizzle_migrations
        `;
        expect(journal?.applied).toHaveLength(66);
        const [constraints] = await forwardClient<{ names: string[] }[]>`
          SELECT array_agg(conname ORDER BY conname) AS names
          FROM pg_constraint
          WHERE conname IN (
            'mastra_message_intents_attachment_ids_array_check',
            'enterprise_budget_reservation_tokens_check',
            'enterprise_runs_model_route_maximum_tokens_check'
          )
        `;
        expect(constraints?.names).toEqual([
          "enterprise_budget_reservation_tokens_check",
          "enterprise_runs_model_route_maximum_tokens_check",
          "mastra_message_intents_attachment_ids_array_check",
        ]);
      } finally {
        await forwardClient.end({ timeout: 5 });
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
      for (const directory of temporaryMigrationDirectories)
        await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

afterAll(async () => {
  if (fixtureNames.length === 0) {
    for (const directory of temporaryMigrationDirectories)
      await rm(directory, { recursive: true, force: true });
  }
});
