import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "../../../tests/support/e2e-compat";
import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  createMigrationLockTimeoutError,
  errorChainContains,
  isConnectionFailure,
  migrateWithValidationBoundary,
  sqlStateFromError,
} from "../../scripts/migration-runner";
import { enterpriseTestDatabaseUrlFrom } from "../support/enterprise-database";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

type CleanupFailure = { step: string; error: unknown };

async function releaseTerminationBarrier(options: {
  unlock: () => Promise<boolean>;
  markReleased: () => void;
}) {
  if (!(await options.unlock())) {
    throw new Error("advisory unlock returned false");
  }
  options.markReleased();
}

async function withDeadline<T>(
  step: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${step} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runTerminationCleanup(options: {
  unlock: () => Promise<boolean>;
  settlements: Promise<unknown>[];
  closePools: Array<() => Promise<unknown>>;
  closeControl: () => Promise<unknown>;
  timeoutMs: number;
}): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  const attempt = async (step: string, operation: () => Promise<unknown>) => {
    try {
      await withDeadline(step, operation, options.timeoutMs);
      return true;
    } catch (error) {
      failures.push({ step, error });
      return false;
    }
  };
  const closeRunnerPools = async () => {
    for (const [index, closePool] of options.closePools.entries()) {
      await attempt(`runner pool ${index + 1} close`, closePool);
    }
  };

  const unlocked = await attempt("barrier unlock", async () => {
    if (!(await options.unlock())) throw new Error("advisory unlock returned false");
  });
  if (!unlocked) await closeRunnerPools();

  for (const [index, settlement] of options.settlements.entries()) {
    await attempt(`runner ${index + 1} settlement`, () => settlement);
  }
  if (unlocked) await closeRunnerPools();
  await attempt("control connection close", options.closeControl);
  return failures;
}

async function runBodyWithCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<CleanupFailure[]>,
): Promise<T> {
  let bodyFailed = false;
  let bodyError: unknown;
  let result: T;
  try {
    result = await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupFailures: CleanupFailure[];
  try {
    cleanupFailures = await cleanup();
  } catch (error) {
    cleanupFailures = [{ step: "cleanup orchestration", error }];
  }

  if (bodyFailed) {
    if (bodyError instanceof Error && cleanupFailures.length > 0) {
      try {
        Object.defineProperty(bodyError, "cleanupFailures", {
          configurable: true,
          value: cleanupFailures,
        });
      } catch {
        console.error("Secondary cleanup failures:", cleanupFailures);
      }
    }
    throw bodyError;
  }
  if (cleanupFailures.length > 0) {
    const error = new AggregateError(
      cleanupFailures.map(({ error: failure }) => failure),
      `Test cleanup failed: ${cleanupFailures.map(({ step }) => step).join(", ")}`,
    );
    Object.defineProperty(error, "cleanupFailures", { value: cleanupFailures });
    throw error;
  }
  return result!;
}

test("termination cleanup treats a false advisory unlock as failure", async () => {
  const events: string[] = [];
  let releaseSettlement!: () => void;
  const settlement = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  }).then(() => {
    events.push("settlement");
  });
  const failures = await runTerminationCleanup({
    unlock: async () => false,
    settlements: [settlement, Promise.resolve()],
    closePools: [
      async () => void events.push("close A"),
      async () => {
        events.push("close B");
        releaseSettlement();
      },
    ],
    closeControl: async () => {},
    timeoutMs: 25,
  });

  expect(events).toEqual(["close A", "close B", "settlement"]);
  expect(failures.map(({ step }) => step)).not.toContain("runner 1 settlement");
  expect(failures.map(({ step }) => step)).toContain("barrier unlock");
});

test("migration lock timeout options validate before reserving a connection", async () => {
  for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let reserveCalls = 0;
    const client = {
      reserve: async () => {
        reserveCalls += 1;
        throw new Error("reserve must not run for invalid options");
      },
    } as unknown as ReturnType<typeof postgres>;
    await expect(
      migrateWithValidationBoundary(client, "unused", { lockTimeoutMs }),
    ).rejects.toThrow("positive safe integer");
    expect(reserveCalls).toBe(0);
  }
});

test("connection loss recognizes PostgreSQL connection and shutdown SQLSTATEs", () => {
  for (const code of ["08006", "08003", "57P01", "57P02", "57P03"])
    expect(isConnectionFailure({ code })).toBe(true);
  expect(isConnectionFailure({ code: "55P03" })).toBe(false);
  expect(isConnectionFailure({ code: "23505" })).toBe(false);
});

test("SQLSTATE extraction and cause containment handle nested and cyclic errors", () => {
  const databaseError = { code: "55P03" };
  const wrapped = { cause: { cause: databaseError } };
  expect(sqlStateFromError(wrapped)).toBe("55P03");
  expect(errorChainContains(wrapped, databaseError)).toBe(true);
  expect(sqlStateFromError({ code: "23505" })).toBe("23505");
  expect(
    sqlStateFromError(
      { code: "ERR_QUERY", cause: { code: "23505", cause: databaseError } },
      "55P03",
    ),
  ).toBe("55P03");
  expect(sqlStateFromError({ code: 55_503 })).toBeUndefined();
  expect(errorChainContains(wrapped, new Error("not in the chain"))).toBe(false);

  const first: { cause?: unknown } = {};
  const second: { cause?: unknown } = { cause: first };
  first.cause = second;
  expect(sqlStateFromError(first)).toBeUndefined();
  expect(isConnectionFailure(first)).toBe(false);
  expect(errorChainContains(first, new Error("unreachable"))).toBe(false);

  const malformed = Object.defineProperty({}, "cause", {
    get() {
      throw new Error("malformed cause getter");
    },
  });
  expect(sqlStateFromError(malformed)).toBeUndefined();
  expect(errorChainContains(malformed, new Error("unreachable"))).toBe(false);
});

test("wrapped lock timeout keeps the Drizzle error and nested driver cause", () => {
  const driverError = Object.assign(new Error("could not obtain lock"), {
    code: "55P03",
  });
  const drizzleError = new Error("Drizzle query failed", {
    cause: driverError,
  });
  const timeoutError = createMigrationLockTimeoutError(drizzleError, 180);

  expect(timeoutError).toBeInstanceOf(Error);
  expect(timeoutError?.message).toContain("180ms");
  expect(timeoutError?.cause).toBe(drizzleError);
  expect(sqlStateFromError(timeoutError?.cause, "55P03")).toBe("55P03");
  expect(errorChainContains(timeoutError, driverError)).toBe(true);
  expect(
    createMigrationLockTimeoutError(
      Object.assign(new Error("duplicate"), { code: "23505" }),
      180,
    ),
  ).toBeUndefined();
});

test("normal barrier release checks false and cleanup retry owns held state", async () => {
  let held = true;
  let attempts = 0;
  const events: string[] = [];
  const unlock = async () => {
    attempts += 1;
    return attempts === 2;
  };

  const result = runBodyWithCleanup(
    async () => {
      await releaseTerminationBarrier({
        unlock,
        markReleased: () => {
          held = false;
        },
      });
    },
    async () => {
      events.push(held ? "held for cleanup" : "already released");
      const failures = await runTerminationCleanup({
        unlock: async () => {
          await releaseTerminationBarrier({
            unlock,
            markReleased: () => {
              held = false;
            },
          });
          events.push("cleanup released");
          return true;
        },
        settlements: [],
        closePools: [],
        closeControl: async () => {},
        timeoutMs: 25,
      });
      return failures;
    },
  );

  await expect(result).rejects.toThrow("advisory unlock returned false");
  expect(attempts).toBe(2);
  expect(held).toBe(false);
  expect(events).toEqual(["held for cleanup", "cleanup released"]);
});

test("failed cleanup retry keeps the barrier held and reports the failure", async () => {
  for (const retry of [
    async () => false,
    async () => {
      throw new Error("retry rejected");
    },
  ]) {
    let held = true;
    const bodyError = new Error("advisory unlock returned false");
    const bodyResult = runBodyWithCleanup(
      async () => {
        await releaseTerminationBarrier({
          unlock: async () => false,
          markReleased: () => {
            held = false;
          },
        });
      },
      async () =>
        runTerminationCleanup({
          unlock: async () => {
            await releaseTerminationBarrier({
              unlock: retry,
              markReleased: () => {
                held = false;
              },
            });
            return true;
          },
          settlements: [],
          closePools: [],
          closeControl: async () => {},
          timeoutMs: 25,
        }),
    );

    await expect(bodyResult).rejects.toMatchObject({
      message: bodyError.message,
      cleanupFailures: [
        { step: "barrier unlock" },
      ],
    });
    expect(held).toBe(true);
  }
});

test("termination cleanup handles a rejected unlock and still closes both pools", async () => {
  const closedPools: string[] = [];
  const failures = await runTerminationCleanup({
    unlock: async () => {
      throw new Error("unlock failed");
    },
    settlements: [Promise.resolve(), Promise.resolve()],
    closePools: [
      async () => void closedPools.push("A"),
      async () => void closedPools.push("B"),
    ],
    closeControl: async () => {},
    timeoutMs: 25,
  });

  expect(closedPools).toEqual(["A", "B"]);
  expect(failures.map(({ step }) => step)).toContain("barrier unlock");
});

test("termination cleanup bounds stalled settlement and closes runner pools", async () => {
  const closedPools: string[] = [];
  const failures = await runTerminationCleanup({
    unlock: async () => true,
    settlements: [new Promise<void>(() => {})],
    closePools: [
      async () => void closedPools.push("A"),
      async () => void closedPools.push("B"),
    ],
    closeControl: async () => {},
    timeoutMs: 25,
  });

  expect(closedPools).toEqual(["A", "B"]);
  expect(failures.map(({ step }) => step)).toContain("runner 1 settlement");
});

test("termination cleanup attempts independent pool closes after one close fails", async () => {
  const closedPools: string[] = [];
  const failures = await runTerminationCleanup({
    unlock: async () => false,
    settlements: [],
    closePools: [
      async () => {
        closedPools.push("A");
        throw new Error("A close failed");
      },
      async () => void closedPools.push("B"),
    ],
    closeControl: async () => {},
    timeoutMs: 25,
  });

  expect(closedPools).toEqual(["A", "B"]);
  expect(failures.map(({ step }) => step)).toContain("runner pool 1 close");
});

test("body failure remains primary when cleanup also fails", async () => {
  const bodyError = new Error("body assertion failed");
  const cleanupError = new Error("cleanup failed");

  const result = runBodyWithCleanup(
    async () => {
      throw bodyError;
    },
    async () => [{ step: "cleanup", error: cleanupError }],
  );

  await expect(result).rejects.toBe(bodyError);
  expect((bodyError as Error & { cleanupFailures?: unknown[] }).cleanupFailures)
    .toEqual([{ step: "cleanup", error: cleanupError }]);
});

test("cleanup failure fails a successful test body", async () => {
  const cleanupError = new Error("cleanup failed");

  await expect(
    runBodyWithCleanup(
      async () => "body passed",
      async () => [{ step: "cleanup", error: cleanupError }],
    ),
  ).rejects.toMatchObject({ errors: [cleanupError] });
});

const enabled = process.env.ENTERPRISE_TEST_R2_MIGRATION_MODE === "fresh";
const serverRoot = join(hereDir, "../..");
const migrationsRoot = join(serverRoot, "drizzle");
const fixtureNames: string[] = [];
const temporaryMigrationDirectories: string[] = [];

async function expectFixtureJournalMatchesCopiedMigrations(directory: string) {
  const files = await readdir(directory);
  const copiedIndexes = files
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((left, right) => left - right);
  const journal = JSON.parse(
    await readFile(join(directory, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  expect(journal.entries.map((entry) => entry.idx)).toEqual(copiedIndexes);
}

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
  await expectFixtureJournalMatchesCopiedMigrations(
    temporaryMigrationDirectory,
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
  const copiedIndexes = (await readdir(directory))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => Number(name.slice(0, 4)))
    .sort((left, right) => left - right);
  if (
    JSON.stringify(journal.entries.map((entry) => entry.idx)) !==
    JSON.stringify(copiedIndexes)
  )
    throw new Error(
      "Through-64 fixture journal does not match copied migrations.",
    );
  await mkdir(join(directory, "meta"), { recursive: true });
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  await expectFixtureJournalMatchesCopiedMigrations(directory);
  const migrationPath = join(directory, "0064_restore_schema_invariants.sql");
  const migrationSql = await readFile(migrationPath, "utf8");
  const legacyTargets = [
    "DO $migration$",
    "UPDATE mastra_message_intents\nSET attachment_ids = (attachment_ids #>> '{}')::jsonb\nWHERE jsonb_typeof(attachment_ids) = 'string';",
    'ALTER TABLE "mastra_message_intents" ADD CONSTRAINT "mastra_message_intents_attachment_ids_array_check"',
    'ALTER TABLE "enterprise_model_budget_reservations" DROP CONSTRAINT "enterprise_budget_reservation_tokens_check"',
    'ALTER TABLE "enterprise_runs" ALTER COLUMN "model_route_maximum_tokens" DROP DEFAULT',
    'ALTER TABLE "enterprise_model_budget_reservations" ADD CONSTRAINT "enterprise_budget_reservation_tokens_check"',
    'ALTER TABLE "enterprise_runs" ADD CONSTRAINT "enterprise_runs_model_route_maximum_tokens_check"',
  ];
  for (const target of legacyTargets) {
    const first = migrationSql.indexOf(target);
    if (first < 0 || migrationSql.indexOf(target, first + target.length) >= 0)
      throw new Error(
        `Expected exactly one 0063 legacy fixture target: ${target}`,
      );
  }
  await writeFile(
    migrationPath,
    'ALTER TABLE "enterprise_model_budget_reservations" DROP CONSTRAINT "enterprise_budget_reservation_tokens_check";\n',
  );
  return directory;
}

async function expectInvariantLocksBeforePreflightCounts() {
  for (const migrationName of [
    "0064_restore_schema_invariants.sql",
    "0066_restore_schema_invariant_guards.sql",
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
    if (migrationName.startsWith("0063")) {
      expect(intentScan).toBeGreaterThan(attachmentLock);
      expect(backfill).toBeGreaterThan(intentScan);
    } else {
      expect(intentScan).toBe(-1);
      expect((sql.match(/--> statement-breakpoint/g) ?? []).length).toBe(4);
      expect(
        (sql.match(/(?:FROM|JOIN) mastra_message_intent_attachments/g) ?? [])
          .length,
      ).toBe(2);
      expect(sql).not.toMatch(
        /SELECT count\(\*\) INTO (?:encoded_count|holder_count|matching_holder_count)/,
      );
      expect((sql.match(/NOT VALID/g) ?? []).length).toBe(3);
      expect(sql).not.toContain("FOR intent IN");
      expect(backfill).toBeGreaterThan(attachmentLock);
    }
  }
}

async function migrationFolderWithWindowBarrier(advisoryKey: number) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-r2-window-"));
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name)) {
      const index = Number(entry.name.slice(0, 4));
      if (index <= 64)
        await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
    }
  }
  await mkdir(join(directory, "meta"), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 64);
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  await expectFixtureJournalMatchesCopiedMigrations(directory);
  const migrationPath = join(directory, "0064_restore_schema_invariants.sql");
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

test.skipIf(!enabled)(
  "Postgres.js reserved runtime shape requires the migration adapter",
  async () => {
    const client = postgres(enterpriseTestDatabaseUrlFrom(), { max: 1 });
    try {
      const reserved = await client.reserve();
      try {
        expect((reserved as unknown as { options?: unknown }).options).toBe(
          undefined,
        );
        expect((reserved as unknown as { begin?: unknown }).begin).toBe(
          undefined,
        );
      } finally {
        reserved.release();
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  },
);

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
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 65);
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  await expectFixtureJournalMatchesCopiedMigrations(directory);
  const migrationPath = join(
    directory,
    "0066_restore_schema_invariant_guards.sql",
  );
  const migrationSql = await readFile(migrationPath, "utf8");
  const postflight =
    "END\n$migration$;--> statement-breakpoint\n\nDROP FUNCTION pg_temp.try_parse_legacy_attachment_ids(text);";
  if (!migrationSql.includes(postflight))
    throw new Error(
      "Could not locate the 0065 post-preflight migration barrier point.",
    );
  await writeFile(
    migrationPath,
    migrationSql.replace(
      postflight,
      `END\n$migration$;--> statement-breakpoint\n\nSELECT pg_advisory_lock(${advisoryKey});--> statement-breakpoint\nSELECT pg_advisory_unlock(${advisoryKey});--> statement-breakpoint\n\nDROP FUNCTION pg_temp.try_parse_legacy_attachment_ids(text);`,
    ),
  );
  return directory;
}

async function migrationFolderThrough65() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-r2-through-65-"));
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
  const journal = JSON.parse(
    await readFile(join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 65);
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  await expectFixtureJournalMatchesCopiedMigrations(directory);
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

async function migrationFolderWithValidationBarrier(advisoryKey: number) {
  const directory = await mkdtemp(
    join(tmpdir(), "openbot-r2-validation-barrier-"),
  );
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name))
      await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
  }
  await mkdir(join(directory, "meta"), { recursive: true });
  await cp(
    join(migrationsRoot, "meta/_journal.json"),
    join(directory, "meta/_journal.json"),
  );
  const path = join(
    directory,
    "0067_validate_enterprise_schema_invariant_guards.sql",
  );
  const source = await readFile(path, "utf8");
  const firstValidation =
    'ALTER TABLE "mastra_message_intents"\n\tVALIDATE CONSTRAINT';
  if (!source.includes(firstValidation))
    throw new Error("Could not locate the first 0066 validation statement.");
  await writeFile(
    path,
    source.replace(
      firstValidation,
      `SELECT pg_advisory_lock(${advisoryKey}, 66);--> statement-breakpoint\nSELECT pg_advisory_unlock(${advisoryKey}, 66);--> statement-breakpoint\n\n${firstValidation}`,
    ),
  );
  return directory;
}

async function migrationFolderWithLifetimeBarriers(
  prefixBarrierKey: number,
  validationBarrierKey: number,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "openbot-r2-lifetime-barriers-"),
  );
  temporaryMigrationDirectories.push(directory);
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /^\d{4}_.*\.sql$/.test(entry.name))
      await cp(join(migrationsRoot, entry.name), join(directory, entry.name));
  }
  await mkdir(join(directory, "meta"), { recursive: true });
  await cp(
    join(migrationsRoot, "meta/_journal.json"),
    join(directory, "meta/_journal.json"),
  );

  const prefixPath = join(directory, "0066_restore_schema_invariant_guards.sql");
  const prefixSource = await readFile(prefixPath, "utf8");
  const finalPrefixTarget = prefixSource.trimEnd();
  await writeFile(
    prefixPath,
    `${finalPrefixTarget}--> statement-breakpoint\nSELECT pg_advisory_lock(${prefixBarrierKey}, 65);--> statement-breakpoint\nSELECT pg_advisory_unlock(${prefixBarrierKey}, 65);--> statement-breakpoint\n`,
  );

  const validationPath = join(
    directory,
    "0067_validate_enterprise_schema_invariant_guards.sql",
  );
  const validationSource = await readFile(validationPath, "utf8");
  const firstValidation =
    'ALTER TABLE "mastra_message_intents"\n\tVALIDATE CONSTRAINT';
  if (!validationSource.includes(firstValidation))
    throw new Error("Could not locate the first 0066 validation statement.");
  await writeFile(
    validationPath,
    validationSource.replace(
      firstValidation,
      `SELECT pg_advisory_lock(${validationBarrierKey}, 66);--> statement-breakpoint\nSELECT pg_advisory_unlock(${validationBarrierKey}, 66);--> statement-breakpoint\n\n${firstValidation}`,
    ),
  );
  return directory;
}

async function migrationFolderFailingAt66() {
  const directory = await migrationFolderWithValidationBarrier(20261011);
  const path = join(
    directory,
    "0067_validate_enterprise_schema_invariant_guards.sql",
  );
  const source = await readFile(path, "utf8");
  await writeFile(path, `${source}\nSELECT 1 / 0;\n`);
  return directory;
}

async function migrationBoundaryHashes(folder: string) {
  const journal = JSON.parse(
    await readFile(join(folder, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const hashes: string[] = [];
  for (const entry of journal.entries.filter(
    (item) => item.idx === 65 || item.idx === 66,
  )) {
    const text = await readFile(join(folder, `${entry.tag}.sql`), "utf8");
    hashes.push(createHash("sha256").update(text).digest("hex"));
  }
  return hashes;
}

async function migrationJournalBoundary(databaseUrl: string, hashes: string[]) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations
      WHERE hash = ANY(${hashes}) ORDER BY created_at
    `;
    return rows.map((row) => row.hash);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function validationConstraintState(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_constraint
      WHERE conname IN (
        'mastra_message_intents_attachment_ids_array_check',
        'enterprise_budget_reservation_tokens_check',
        'enterprise_runs_model_route_maximum_tokens_check'
      ) AND convalidated
    `;
    return row?.count ?? 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function temporaryRunnerDirectories() {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("openbot-migration-prefix-"))
    .sort();
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
    await migrateWithValidationBoundary(client, folder);
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

function failReservedTransactionStatement(
  client: ReturnType<typeof postgres>,
  statement: "COMMIT" | "ROLLBACK",
) {
  const reserve = client.reserve.bind(client);
  const injected = new Error(`injected ${statement} failure`);
  Object.defineProperty(client, "reserve", {
    value: async () => {
      const reserved = await reserve();
      const unsafe = reserved.unsafe.bind(reserved);
      reserved.unsafe = ((query, parameters, options) => {
        if (query.trim().toUpperCase() === statement) throw injected;
        return unsafe(query, parameters, options);
      }) as typeof reserved.unsafe;
      return reserved;
    },
  });
  return injected;
}

async function waitForAdvisoryWaiter(
  control: ReturnType<typeof postgres>,
  keyClass: number,
  keyObject: number,
  excludePid?: number,
) {
  return waitForActivity(async () => {
    const [activity] = await control<{ pid: number }[]>`
      SELECT activity.pid FROM pg_stat_activity activity
      JOIN pg_locks lock ON lock.pid = activity.pid
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND (${excludePid ?? 0} = 0 OR activity.pid <> ${excludePid ?? 0})
        AND lock.locktype = 'advisory' AND NOT lock.granted
        AND lock.classid::bigint = ${keyClass}
        AND lock.objid::bigint = ${keyObject} AND lock.objsubid = 2
    `;
    return activity;
  }, `advisory lock waiter (${keyClass}, ${keyObject})`);
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

async function migrationFolderWithLockTimeoutProbe(tableName: string) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-lock-timeout-"));
  temporaryMigrationDirectories.push(directory);
  await mkdir(join(directory, "meta"), { recursive: true });
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: Date.now(),
          tag: "0000_lock_timeout_probe",
          breakpoints: true,
        },
      ],
    }),
  );
  await writeFile(
    join(directory, "0000_lock_timeout_probe.sql"),
    `CREATE TABLE public.${tableName} AS SELECT current_setting('lock_timeout') AS value;`,
  );
  return directory;
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

async function blockedRunAndReservationWriterActivities(
  control: ReturnType<typeof postgres>,
  migrationPid: number,
) {
  return control<{ pid: number; query: string }[]>`
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
      const activities = await blockedRunAndReservationWriterActivities(
        control,
        migrationPid,
      );
      return activities.length === 2 ? activities[0] : undefined;
    }, "Run and reservation writers blocked by migration locks");
    expect(writerActivities.pid).not.toBe(migrationPid);
    expect(runSettled).toBe(false);
    expect(reservationSettled).toBe(false);
    const blockedWriters = await blockedRunAndReservationWriterActivities(
      control,
      migrationPid,
    );
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
      runWriter.end({ timeout: 5 }),
      reservationWriter.end({ timeout: 5 }),
    ]);
    await Promise.all([runPromise, reservationPromise]);
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
      control.end({ timeout: 5 }),
      writer.end({ timeout: 5 }),
      invariantWriters?.close(),
    ]);
    await Promise.all([
      migrationPromise?.then(() => undefined),
      writerPromise?.then(() => undefined),
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
      control.end({ timeout: 5 }),
      writer.end({ timeout: 5 }),
      invariantWriters?.close(),
    ]);
    await Promise.all([
      migrationPromise?.then(() => undefined),
      writerPromise?.then(() => undefined),
    ]);
  }
}

test.skipIf(!enabled)(
  "lock timeout SET and RESET failures preserve errors and reservation safety",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const setup = postgres(setupUrl, { max: 1 });
    const fixtureName = await createDatabaseFrom(setup);
    await setup.end({ timeout: 5 });
    const databaseUrl = fixtureUrl(setupUrl, fixtureName);
    const folder = await migrationFolderWithLockTimeoutProbe(
      `lock_timeout_fault_${crypto.randomUUID().replaceAll("-", "")}`,
    );

    const setClient = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const setFailure = new Error("injected lock_timeout SET failure");
    const setReserve = setClient.reserve.bind(setClient);
    Object.defineProperty(setClient, "reserve", {
      value: async () => {
        const reserved = await setReserve();
        const unsafe = reserved.unsafe.bind(reserved);
        reserved.unsafe = ((query, parameters, queryOptions) => {
          if (String(query).includes("set_config('lock_timeout'"))
            throw setFailure;
          return unsafe(query, parameters, queryOptions);
        }) as typeof reserved.unsafe;
        return reserved;
      },
    });
    try {
      const setError = await migrateWithValidationBoundary(setClient, folder).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorChainContains(setError, setFailure)).toBe(true);
      const [reused] = await setClient<{ value: number }[]>`SELECT 1 AS value`;
      expect(reused?.value).toBe(1);
    } finally {
      await setClient.end({ timeout: 5 });
    }

    const resetClient = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const resetFailure = new Error("injected lock_timeout RESET failure");
    const resetReserve = resetClient.reserve.bind(resetClient);
    Object.defineProperty(resetClient, "reserve", {
      value: async () => {
        const reserved = await resetReserve();
        const unsafe = reserved.unsafe.bind(reserved);
        reserved.unsafe = ((query, parameters, queryOptions) => {
          if (String(query).trim().toUpperCase() === "RESET LOCK_TIMEOUT")
            throw resetFailure;
          return unsafe(query, parameters, queryOptions);
        }) as typeof reserved.unsafe;
        return reserved;
      },
    });
    const probe = postgres(databaseUrl, { max: 1 });
    try {
      const resetError = await migrateWithValidationBoundary(
        resetClient,
        folder,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(errorChainContains(resetError, resetFailure)).toBe(true);
      await expect(resetClient`SELECT 1`).rejects.toThrow();
      const [lock] = await probe<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(1330795348, 1296641874) AS acquired
      `;
      expect(lock?.acquired).toBe(true);
      await probe`SELECT pg_advisory_unlock(1330795348, 1296641874)`;
    } finally {
      await Promise.all([
        resetClient.end({ timeout: 5 }).catch(() => {}),
        probe.end({ timeout: 5 }),
      ]);
    }
  },
  20_000,
);

test.skipIf(!enabled)(
  "omitted migration lock timeout binds 30000ms on the reserved session",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const setup = postgres(setupUrl, { max: 1 });
    const fixtureName = await createDatabaseFrom(setup);
    await setup.end({ timeout: 5 });
    const runner = postgres(fixtureUrl(setupUrl, fixtureName), {
      max: 1,
      onnotice: () => {},
    });
    let observedValue: unknown;
    const injectedTimeout = Object.assign(new Error("injected lock timeout"), {
      code: "55P03",
    });
    const reserve = runner.reserve.bind(runner);
    Object.defineProperty(runner, "reserve", {
      value: async () => {
        const reserved = await reserve();
        const unsafe = reserved.unsafe.bind(reserved);
        reserved.unsafe = ((query, parameters, queryOptions) => {
          const text = typeof query === "string" ? query : String(query);
          if (text.includes("set_config('lock_timeout'")) {
            observedValue = Array.isArray(parameters)
              ? parameters[0]
              : parameters;
          }
          if (text.includes("pg_advisory_lock"))
            return Promise.reject(injectedTimeout) as ReturnType<
              typeof reserved.unsafe
            >;
          return unsafe(query, parameters, queryOptions);
        }) as typeof reserved.unsafe;
        return reserved;
      },
    });
    const probe = postgres(fixtureUrl(setupUrl, fixtureName), { max: 1 });
    try {
      const failure = await migrateWithValidationBoundary(
        runner,
        migrationsRoot,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("30000ms");
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(sqlStateFromError(failure, "55P03")).toBe("55P03");
      expect(errorChainContains(failure, injectedTimeout)).toBe(true);
      expect(observedValue).toBe("30000ms");
      await expect(runner`SELECT 1`).rejects.toThrow();
      const [migration] = await probe<{ exists: string | null }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations') AS exists
      `;
      expect(migration?.exists).toBeNull();
    } finally {
      await Promise.all([
        runner.end({ timeout: 5 }).catch(() => {}),
        probe.end({ timeout: 5 }),
      ]);
    }
  },
  15_000,
);

test.skipIf(!enabled)(
  "migration advisory lock timeout is bounded and reset before migration SQL",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const setup = postgres(setupUrl, { max: 1 });
    const fixtureName = await createDatabaseFrom(setup);
    const databaseUrl = fixtureUrl(setupUrl, fixtureName);
    const tableName = `lock_timeout_probe_${crypto.randomUUID().replaceAll("-", "")}`;
    const folder = await migrationFolderWithLockTimeoutProbe(tableName);
    const keyClass = 1330795348;
    const keyObject = 1296641874;
    const control = postgres(databaseUrl, { max: 1 });
    const runner = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let held = false;
    try {
      await control`SELECT pg_advisory_lock(${keyClass}, ${keyObject})`;
      held = true;
      const timed = migrateWithValidationBoundary(runner, folder, {
        lockTimeoutMs: 180,
      });
      const failure = await timed.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("180ms");
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(sqlStateFromError(failure, "55P03")).toBe("55P03");
      expect(
        errorChainContains(failure, (failure as Error).cause),
      ).toBe(true);
      await expect(runner`SELECT 1`).rejects.toThrow();
      const [migration] = await control<{ exists: string | null }[]>`
        SELECT to_regclass(${`public.${tableName}`}) AS exists
      `;
      expect(migration?.exists).toBeNull();
    } finally {
      if (held)
        await control`SELECT pg_advisory_unlock(${keyClass}, ${keyObject})`.catch(
          () => {},
        );
      await Promise.all([
        runner.end({ timeout: 5 }).catch(() => {}),
        control.end({ timeout: 5 }),
        setup.end({ timeout: 5 }),
      ]);
    }

    const earlyControl = postgres(databaseUrl, { max: 1 });
    const earlyRunner = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let earlyHeld = false;
    try {
      await earlyControl`SELECT pg_advisory_lock(${keyClass}, ${keyObject})`;
      earlyHeld = true;
      const migration = migrateWithValidationBoundary(earlyRunner, folder, {
        lockTimeoutMs: 2_000,
      });
      await waitForAdvisoryWaiter(earlyControl, keyClass, keyObject);
      await earlyControl`SELECT pg_advisory_unlock(${keyClass}, ${keyObject})`;
      earlyHeld = false;
      await migration;
      const [observed] = await earlyControl.unsafe<{ value: string }[]>(
        `SELECT value FROM public.${tableName}`,
      );
      expect(observed?.value).toBe("0");
    } finally {
      if (earlyHeld)
        await earlyControl`SELECT pg_advisory_unlock(${keyClass}, ${keyObject})`.catch(
          () => {},
        );
      await Promise.all([
        earlyRunner.end({ timeout: 5 }).catch(() => {}),
        earlyControl.end({ timeout: 5 }),
      ]);
    }
  },
  30_000,
);

test.skipIf(!enabled)(
  "0063 blocks unresolved legacy values atomically and upgrades validated intents",
  async () => {
    const setupUrl = enterpriseTestDatabaseUrlFrom();
    const endpoint = new URL(setupUrl);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(endpoint.hostname);
    const constructionClient = postgres(setupUrl, { max: 1 });
    try {
      const adapterConstructionClient = postgres(setupUrl, { max: 1 });
      await runBodyWithCleanup(
        async () => {
          const adapterConstructionFailure = new Error(
            "injected reserved adapter construction failure",
          );
          Object.defineProperty(adapterConstructionClient, "options", {
            configurable: true,
            get() {
              throw adapterConstructionFailure;
            },
          });
          await expect(
            migrateWithValidationBoundary(
              adapterConstructionClient,
              migrationsRoot,
            ),
          ).rejects.toThrow(adapterConstructionFailure.message);
          const adapterReuse = await withDeadline(
            "adapter construction pool reuse",
            async () => {
              const rows = await adapterConstructionClient<{ value: number }[]>`
                SELECT 1 AS value
              `;
              return rows[0]?.value;
            },
            2_000,
          );
          expect(adapterReuse).toBe(1);
        },
        async () => {
          try {
            await withDeadline(
              "adapter construction client close",
              () => adapterConstructionClient.end({ timeout: 5 }),
              5_500,
            );
            return [];
          } catch (error) {
            return [{ step: "adapter construction client close", error }];
          }
        },
      );

      const reserveForConstructionFailure =
        constructionClient.reserve.bind(constructionClient);
      Object.defineProperty(constructionClient, "reserve", {
        value: async () => {
          const reserved = await reserveForConstructionFailure();
          Object.freeze(constructionClient.options.parsers);
          return reserved;
        },
      });
      await expect(
        migrateWithValidationBoundary(constructionClient, migrationsRoot),
      ).rejects.toThrow();
      const [reused] = await constructionClient<{ value: number }[]>`
        SELECT 1 AS value
      `;
      expect(reused?.value).toBe(1);
    } finally {
      await constructionClient.end({ timeout: 5 });
    }
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
          kind: "native-object",
          encoded: JSON.stringify({ nope: true }),
          expected: "non_array_intent_count=1",
        },
        {
          kind: "native-scalar",
          encoded: JSON.stringify(17),
          expected: "non_array_intent_count=1",
        },
        {
          kind: "encoded-non-array",
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
        let repairableBefore:
          | Awaited<ReturnType<typeof intentAttachmentValue>>
          | undefined;
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
            expect(source?.attachment_ids).toEqual(JSON.parse(blocked.encoded));
            expect(JSON.parse(source?.raw ?? "null")).toEqual(
              JSON.parse(blocked.encoded),
            );
          } finally {
            await client.end({ timeout: 5 });
          }
        }
        if (repairable && repairableBefore) {
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

      const legacyTemplate = await createDatabaseFrom(setup, template);
      const legacyTemplateUrl = fixtureUrl(setupUrl, legacyTemplate);
      const legacyFolder = await migrationFolderThrough64WithoutIntentLocks();
      await migrateDatabase(legacyTemplateUrl, legacyFolder);
      const through65Folder = await migrationFolderThrough65();

      // A 0065 commit can return an expired pool connection before the full-folder
      // 0066 migrate call. Keep an independent witness for both boundaries.
      const lifetimeName = await createDatabaseFrom(setup, legacyTemplate);
      const lifetimeUrl = fixtureUrl(setupUrl, lifetimeName);
      const lifetimeFolder = await migrationFolderWithLifetimeBarriers(
        20261012,
        20261013,
      );
      const lifetimeControl = postgres(lifetimeUrl, { max: 1 });
      const lifetimeWriter = postgres(lifetimeUrl, { max: 1 });
      const lifetimeRun = await seedValidRunAndReservation(
        lifetimeUrl,
        "r5-3-f1-b-lifetime",
      );
      const lifetimeRunnerA = postgres(lifetimeUrl, {
        max: 1,
        max_lifetime: 1,
        onnotice: () => {},
      });
      const lifetimeRunnerB = postgres(lifetimeUrl, {
        max: 1,
        onnotice: () => {},
      });
      let prefixBarrierHeld = false;
      let validationBarrierHeld = false;
      let lifetimeA: Promise<unknown> | undefined;
      let lifetimeB: Promise<unknown> | undefined;
      let lifetimeObservations:
        | {
            samePid: boolean;
            runnerLockHeldByA: boolean;
            runnerBStillWaiting: boolean;
          }
        | undefined;
      let lifetimeJournal: string[] | undefined;
      let lifetimeHashes: string[] | undefined;
      try {
        const [warmPid] = await lifetimeRunnerA<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `;
        expect(warmPid?.pid).toBeDefined();
        await lifetimeControl`SELECT pg_advisory_lock(20261012, 65)`;
        prefixBarrierHeld = true;
        await lifetimeControl`SELECT pg_advisory_lock(20261013, 66)`;
        validationBarrierHeld = true;
        lifetimeA = migrateWithValidationBoundary(
          lifetimeRunnerA,
          lifetimeFolder,
        );
        const prefixWait = await waitForAdvisoryWaiter(
          lifetimeControl,
          20261012,
          65,
        );
        const [prefixPid] = await lifetimeControl<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE pid = ${prefixWait.pid}
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        `;
        expect(prefixPid?.pid).toBe(prefixWait.pid);

        lifetimeB = migrateWithValidationBoundary(
          lifetimeRunnerB,
          lifetimeFolder,
        );
        const runnerBWait = await waitForAdvisoryWaiter(
          lifetimeControl,
          1330795348,
          1296641874,
          prefixWait.pid,
        );
        expect(runnerBWait.pid).not.toBe(prefixWait.pid);
        await lifetimeControl`SELECT pg_sleep(1.5)`;
        await lifetimeControl`SELECT pg_advisory_unlock(20261012, 65)`;
        prefixBarrierHeld = false;

        const validationWait = await waitForAdvisoryWaiter(
          lifetimeControl,
          20261013,
          66,
        );
        const samePid = validationWait.pid === prefixWait.pid;
        const [runnerLockHeld] = await lifetimeControl<{ pid: number }[]>`
          SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND classid::bigint = 1330795348
            AND objid::bigint = 1296641874 AND objsubid = 2
            AND pid = ${prefixWait.pid}
        `;
        const [runnerBStillWaiting] = await lifetimeControl<{ pid: number }[]>`
          SELECT pid FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid::bigint = 1330795348
            AND objid::bigint = 1296641874 AND objsubid = 2
            AND pid = ${runnerBWait.pid}
        `;
        lifetimeObservations = {
          samePid,
          runnerLockHeldByA: runnerLockHeld?.pid === prefixWait.pid,
          runnerBStillWaiting: runnerBStillWaiting?.pid === runnerBWait.pid,
        };

        const [beforeWrite] = await lifetimeControl<{ lease_expires_at: Date }[]>`
          SELECT lease_expires_at FROM enterprise_runs WHERE id = ${lifetimeRun.runId}
        `;
        await lifetimeWriter.begin(async (transaction) => {
          await transaction`SET LOCAL lock_timeout = '1s'`;
          await transaction`
            UPDATE enterprise_runs
            SET lease_expires_at = lease_expires_at + interval '1 second'
            WHERE id = ${lifetimeRun.runId}
          `;
        });
        const [afterWrite] = await lifetimeControl<{ lease_expires_at: Date }[]>`
          SELECT lease_expires_at FROM enterprise_runs WHERE id = ${lifetimeRun.runId}
        `;
        expect(afterWrite?.lease_expires_at).not.toEqual(
          beforeWrite?.lease_expires_at,
        );

        await lifetimeControl`SELECT pg_advisory_unlock(20261013, 66)`;
        validationBarrierHeld = false;
        await Promise.all([lifetimeA, lifetimeB]);
        lifetimeHashes = await migrationBoundaryHashes(lifetimeFolder);
        lifetimeJournal = await migrationJournalBoundary(
          lifetimeUrl,
          lifetimeHashes,
        );
        expect(await validationConstraintState(lifetimeUrl)).toBe(3);
      } finally {
        if (prefixBarrierHeld)
          await lifetimeControl`SELECT pg_advisory_unlock(20261012, 65)`.catch(
            () => {},
          );
        if (validationBarrierHeld)
          await lifetimeControl`SELECT pg_advisory_unlock(20261013, 66)`.catch(
            () => {},
          );
        await Promise.all([
          lifetimeControl.end({ timeout: 5 }),
          lifetimeWriter.end({ timeout: 5 }),
          lifetimeRunnerA.end({ timeout: 5 }),
          lifetimeRunnerB.end({ timeout: 5 }),
        ]);
        await Promise.all(
          [lifetimeA, lifetimeB].map((promise) =>
            promise?.then(() => undefined, () => undefined),
          ),
        );
      }

      // Exercise the production helper from a through-64 database.  The test-only
      // barrier pauses 0066 after the helper has committed the 0065 prefix.
      const boundaryName = await createDatabaseFrom(setup, legacyTemplate);
      const boundaryUrl = fixtureUrl(setupUrl, boundaryName);
      const boundaryRun = await seedValidRunAndReservation(
        boundaryUrl,
        "r5-3-f1-b",
      );
      const validationBarrier =
        await migrationFolderWithValidationBarrier(20261011);
      const migrationLockControl = postgres(boundaryUrl, { max: 1 });
      const validationWriter = postgres(boundaryUrl, { max: 1 });
      const [runBeforeValidation] = await migrationLockControl<
        { lease_expires_at: Date }[]
      >`
        SELECT lease_expires_at FROM enterprise_runs WHERE id = ${boundaryRun.runId}
      `;
      let barrierHeld = false;
      let runnerA: ReturnType<typeof runMigration> | undefined;
      let runnerB: ReturnType<typeof runMigration> | undefined;
      const prefixDirectoriesBefore = await temporaryRunnerDirectories();
      try {
        await migrationLockControl`SELECT pg_advisory_lock(20261011, 66)`;
        barrierHeld = true;
        runnerA = runMigration(boundaryUrl, validationBarrier);
        const blockedAtValidation = await waitForActivity(async () => {
          const [activity] = await migrationLockControl<{ pid: number }[]>`
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN pg_locks lock ON lock.pid = activity.pid
            WHERE activity.datname = current_database()
              AND activity.pid <> pg_backend_pid()
              AND lock.locktype = 'advisory' AND NOT lock.granted
              AND lock.classid::bigint = 20261011
              AND lock.objid::bigint = 66 AND lock.objsubid = 2
          `;
          return activity;
        }, "runner A paused immediately before the first 0066 validation");

        runnerB = runMigration(boundaryUrl, validationBarrier);
        const runnerBWait = await waitForActivity(async () => {
          const [activity] = await migrationLockControl<{ pid: number }[]>`
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN pg_locks lock ON lock.pid = activity.pid
            WHERE activity.datname = current_database()
              AND activity.pid <> pg_backend_pid()
              AND activity.pid <> ${blockedAtValidation.pid}
              AND lock.locktype = 'advisory' AND NOT lock.granted
              AND lock.classid::bigint = 1330795348
              AND lock.objid::bigint = 1296641874 AND lock.objsubid = 2
          `;
          return activity;
        }, "runner B waiting on the migration-wide advisory lock");
        expect(runnerBWait.pid).not.toBe(blockedAtValidation.pid);

        await validationWriter.begin(async (transaction) => {
          await transaction`SET LOCAL lock_timeout = '1s'`;
          await transaction`
            UPDATE enterprise_runs
            SET lease_expires_at = lease_expires_at + interval '1 second'
            WHERE id = ${boundaryRun.runId}
          `;
        });
        const [writtenBeforeRelease] = await migrationLockControl<
          { lease_expires_at: string }[]
        >`
          SELECT lease_expires_at FROM enterprise_runs WHERE id = ${boundaryRun.runId}
        `;
        expect(writtenBeforeRelease?.lease_expires_at).toBeDefined();
        expect(writtenBeforeRelease?.lease_expires_at).not.toEqual(
          runBeforeValidation?.lease_expires_at,
        );
        // The successful transaction above completed while 0066 still held at the barrier.
        const [activityStillBlocked] = await migrationLockControl<
          { pid: number }[]
        >`
          SELECT pid FROM pg_stat_activity WHERE pid = ${blockedAtValidation.pid}
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'
        `;
        expect(activityStillBlocked?.pid).toBe(blockedAtValidation.pid);

        await migrationLockControl`SELECT pg_advisory_unlock(20261011, 66)`;
        barrierHeld = false;
        expect(await runnerA).toEqual({ failed: false, message: "" });
        expect(await runnerB).toEqual({ failed: false, message: "" });
        const expectedHashes = await migrationBoundaryHashes(validationBarrier);
        expect(
          await migrationJournalBoundary(boundaryUrl, expectedHashes),
        ).toEqual(expectedHashes);
        expect(await validationConstraintState(boundaryUrl)).toBe(3);
        expect(await temporaryRunnerDirectories()).toEqual(
          prefixDirectoriesBefore,
        );
      } finally {
        if (barrierHeld)
          await migrationLockControl`SELECT pg_advisory_unlock(20261011, 66)`.catch(
            () => {},
          );
        await Promise.all([
          migrationLockControl.end({ timeout: 5 }),
          validationWriter.end({ timeout: 5 }),
        ]);
        await Promise.all(
          [runnerA, runnerB].map((promise) => promise?.then(() => undefined)),
        );
      }

      // Terminating A while its 0066 transaction waits must dispose A's pool.
      // Keep the shared barrier locked until A has rejected and its journal
      // boundary is observed, then let the already-waiting B finish 0066.
      const terminatedName = await createDatabaseFrom(setup, legacyTemplate);
      const terminatedUrl = fixtureUrl(setupUrl, terminatedName);
      const terminationBarrier = 20261014;
      const terminationFolder =
        await migrationFolderWithValidationBarrier(terminationBarrier);
      const terminationControl = postgres(terminatedUrl, { max: 1 });
      const terminationRunnerA = postgres(terminatedUrl, {
        max: 1,
        onnotice: () => {},
      });
      const terminationRunnerB = postgres(terminatedUrl, {
        max: 1,
        onnotice: () => {},
      });
      let terminationBarrierHeld = false;
      let terminationA:
        | Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }>
        | undefined;
      let terminationB:
        | Promise<{ status: "fulfilled" } | { status: "rejected"; error: unknown }>
        | undefined;
      await runBodyWithCleanup(
        async () => {
        const [controlPid] = await terminationControl<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `;
        await terminationControl`SELECT pg_advisory_lock(${terminationBarrier}, 66)`;
        terminationBarrierHeld = true;
        terminationA = migrateWithValidationBoundary(
          terminationRunnerA,
          terminationFolder,
        ).then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        const aAtBarrier = await waitForActivity(async () => {
          const [activity] = await terminationControl<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> ${controlPid?.pid}
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'
              AND query ILIKE ${`%pg_advisory_lock(${terminationBarrier}, 66)%`}
          `;
          return activity;
        }, "runner A paused inside 0066");

        terminationB = migrateWithValidationBoundary(
          terminationRunnerB,
          terminationFolder,
        ).then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        const bWaitingForRunner = await waitForAdvisoryWaiter(
          terminationControl,
          1330795348,
          1296641874,
          aAtBarrier.pid,
        );
        expect(bWaitingForRunner.pid).not.toBe(aAtBarrier.pid);

        const [termination] = await terminationControl<{ terminated: boolean }[]>`
          SELECT pg_terminate_backend(${aAtBarrier.pid}) AS terminated
        `;
        expect(termination?.terminated).toBe(true);
        await waitForActivity(async () => {
          const [activity] = await terminationControl<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity WHERE pid = ${aAtBarrier.pid}
          `;
          return activity ? undefined : { pid: aAtBarrier.pid };
        }, "runner A backend termination");
        const aOutcome = await Promise.race([
          terminationA,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("runner A did not reject after termination")),
              5_000,
            ),
          ),
        ]);
        expect(aOutcome.status).toBe("rejected");
        if (aOutcome.status === "rejected") {
          expect(aOutcome.error).not.toBeInstanceOf(AggregateError);
          expect(isConnectionFailure(aOutcome.error)).toBe(true);
        }
        const aPoolResult = await Promise.race([
          terminationRunnerA`SELECT 1`.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), 3_000),
          ),
        ]);
        expect(aPoolResult).toBe("rejected");

        const bAtBarrier = await waitForActivity(async () => {
          const [activity] = await terminationControl<{ pid: number }[]>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> ${controlPid?.pid}
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'
              AND query ILIKE ${`%pg_advisory_lock(${terminationBarrier}, 66)%`}
          `;
          return activity;
        }, "runner B entered 0066 after runner A stopped");
        expect(bAtBarrier.pid).toBe(bWaitingForRunner.pid);
        const terminationHashes = await migrationBoundaryHashes(terminationFolder);
        const [journalBeforeRelease] = await terminationControl<
          { count: number }[]
        >`
          SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
          WHERE hash = ${terminationHashes[1]}
        `;
        expect(journalBeforeRelease?.count).toBe(0);

        await releaseTerminationBarrier({
          unlock: async () => {
            const [result] = await terminationControl<{ released: boolean }[]>`
              SELECT pg_advisory_unlock(${terminationBarrier}, 66) AS released
            `;
            return result?.released === true;
          },
          markReleased: () => {
            terminationBarrierHeld = false;
          },
        });
        const bOutcome = await Promise.race([
          terminationB,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("runner B did not finish after barrier release")),
              15_000,
            ),
          ),
        ]);
        expect(bOutcome.status).toBe("fulfilled");
        const [journalAfterRelease] = await terminationControl<
          { count: number }[]
        >`
          SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
          WHERE hash = ${terminationHashes[1]}
        `;
        expect(journalAfterRelease?.count).toBe(1);
        },
        () =>
          runTerminationCleanup({
            unlock: async () => {
              if (!terminationBarrierHeld) return true;
              await releaseTerminationBarrier({
                unlock: async () => {
                  const [result] = await terminationControl<
                    { released: boolean }[]
                  >`
                    SELECT pg_advisory_unlock(${terminationBarrier}, 66) AS released
                  `;
                  return result?.released === true;
                },
                markReleased: () => {
                  terminationBarrierHeld = false;
                },
              });
              return true;
            },
            settlements: [
              terminationA ?? Promise.resolve(),
              terminationB ?? Promise.resolve(),
            ],
            closePools: [
              () => terminationRunnerA.end({ timeout: 5 }),
              () => terminationRunnerB.end({ timeout: 5 }),
            ],
            closeControl: () => terminationControl.end({ timeout: 5 }),
            timeoutMs: 5_500,
          }),
      );

      // A failing 0066 cannot roll back the already committed 0065 prefix, and a
      // subsequent run with the source migrations retries and validates it.
      const retryName = await createDatabaseFrom(setup, legacyTemplate);
      const retryUrl = fixtureUrl(setupUrl, retryName);
      const failingFolder = await migrationFolderFailingAt66();
      const retryPrefixBefore = await temporaryRunnerDirectories();
      const retryBaseClient = postgres(retryUrl, {
        max: 1,
        onnotice: () => {},
      });
      const cleanupProbe = postgres(retryUrl, { max: 1 });
      try {
        await expect(
          migrateWithValidationBoundary(retryBaseClient, failingFolder),
        ).rejects.toThrow();
        const failedHashes = await migrationBoundaryHashes(failingFolder);
        expect(await migrationJournalBoundary(retryUrl, failedHashes)).toEqual([
          failedHashes[0],
        ]);
        const boundedPoolQuery = await Promise.race([
          retryBaseClient`SELECT 1 AS reusable`.then((rows) => rows[0]?.reusable),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("original max:1 pool was not reusable")),
              3_000,
            ),
          ),
        ]);
        expect(boundedPoolQuery).toBe(1);
        const [lockAcquired] = await cleanupProbe<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_lock(1330795348, 1296641874) AS acquired
        `;
        expect(lockAcquired?.acquired).toBe(true);
        const [lockReleased] = await cleanupProbe<{ released: boolean }[]>`
          SELECT pg_advisory_unlock(1330795348, 1296641874) AS released
        `;
        expect(lockReleased?.released).toBe(true);
        expect(await temporaryRunnerDirectories()).toEqual(retryPrefixBefore);
        await migrateWithValidationBoundary(retryBaseClient, migrationsRoot);
        expect(await validationConstraintState(retryUrl)).toBe(3);
      } finally {
        await Promise.all([
          cleanupProbe.end({ timeout: 5 }),
          retryBaseClient.end({ timeout: 5 }),
        ]);
      }

      const commitFailureName = await createDatabaseFrom(setup, legacyTemplate);
      const commitFailureUrl = fixtureUrl(setupUrl, commitFailureName);
      const commitFailureClient = postgres(commitFailureUrl, { max: 1 });
      const commitFailure = failReservedTransactionStatement(
        commitFailureClient,
        "COMMIT",
      );
      await expect(
        migrateWithValidationBoundary(commitFailureClient, through65Folder),
      ).rejects.toThrow(commitFailure.message);
      await expect(
        Promise.race([
          commitFailureClient`SELECT 1`,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("uncertain commit pool was not disposed")),
              3_000,
            ),
          ),
        ]),
      ).rejects.toThrow();
      expect(
        await migrationJournalBoundary(
          commitFailureUrl,
          await migrationBoundaryHashes(through65Folder),
        ),
      ).toEqual([]);

      const rollbackFailureName = await createDatabaseFrom(
        setup,
        legacyTemplate,
      );
      const rollbackFailureUrl = fixtureUrl(setupUrl, rollbackFailureName);
      const rollbackFailureClient = postgres(rollbackFailureUrl, { max: 1 });
      const rollbackFailure = failReservedTransactionStatement(
        rollbackFailureClient,
        "ROLLBACK",
      );
      const rollbackError = await migrateWithValidationBoundary(
        rollbackFailureClient,
        failingFolder,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rollbackError).toBeInstanceOf(AggregateError);
      const rollbackMessages = (rollbackError as AggregateError).errors.map(
        (error) => (error as Error).message,
      );
      expect(rollbackMessages.join("\n")).toContain(rollbackFailure.message);
      expect(rollbackMessages.join("\n")).toContain("Failed query");
      const rollbackProbe = postgres(rollbackFailureUrl, { max: 1 });
      try {
        expect(
          await migrationJournalBoundary(
            rollbackFailureUrl,
            await migrationBoundaryHashes(failingFolder),
          ),
        ).toEqual([(await migrationBoundaryHashes(failingFolder))[0]]);
        const [lockAcquired] = await rollbackProbe<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_lock(1330795348, 1296641874) AS acquired
        `;
        expect(lockAcquired?.acquired).toBe(true);
        await rollbackProbe`SELECT pg_advisory_unlock(1330795348, 1296641874)`;
      } finally {
        await rollbackProbe.end({ timeout: 5 });
      }

      expect(lifetimeObservations?.samePid).toBe(true);
      expect(lifetimeObservations?.runnerLockHeldByA).toBe(true);
      expect(lifetimeObservations?.runnerBStillWaiting).toBe(true);
      expect(lifetimeJournal).toEqual(lifetimeHashes);

      // A directory with neither side of the 0065/0066 boundary uses ordinary
      // single-pass migration behavior and cleans its temporary prefix on success.
      const ordinaryName = await createDatabaseFrom(setup, template);
      const ordinaryUrl = fixtureUrl(setupUrl, ordinaryName);
      const ordinaryPrefixBefore = await temporaryRunnerDirectories();
      expect(await runMigration(ordinaryUrl, legacyFolder)).toEqual({
        failed: false,
        message: "",
      });
      const ordinaryClient = postgres(ordinaryUrl, { max: 1 });
      try {
        const [ordinaryJournal] = await ordinaryClient<{ count: number }[]>`
          SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
        `;
        expect(ordinaryJournal?.count).toBe(65);
      } finally {
        await ordinaryClient.end({ timeout: 5 });
      }
      expect(await temporaryRunnerDirectories()).toEqual(ordinaryPrefixBefore);

      const legacyBlockedCases = [
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
          kind: "native-object",
          encoded: JSON.stringify({ nope: true }),
          expected: "non_array_intent_count=1",
        },
        {
          kind: "native-scalar",
          encoded: JSON.stringify(17),
          expected: "non_array_intent_count=1",
        },
        {
          kind: "encoded-non-array",
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
      for (const blocked of legacyBlockedCases) {
        const databaseName = await createDatabaseFrom(setup, legacyTemplate);
        const databaseUrl = fixtureUrl(setupUrl, databaseName);
        const seeded = await seedLegacyValue(
          databaseUrl,
          blocked.kind,
          blocked.encoded,
        );
        const before = await migrationState(databaseUrl);
        const result = await runMigration(databaseUrl, through65Folder);
        expect(result.failed).toBe(true);
        expect(result.message).toContain("0065 preflight blocked:");
        expect(result.message).toContain(blocked.expected);
        expect(await migrationState(databaseUrl)).toEqual(before);
        if (blocked.encoded && seeded) {
          const unchanged = await intentAttachmentValue(
            databaseUrl,
            seeded.tenant,
            seeded.thread,
            seeded.clientKey,
          );
          expect(unchanged?.attachment_ids).toEqual(
            JSON.parse(blocked.encoded),
          );
        }
      }

      const nativeArrayName = await createDatabaseFrom(setup, legacyTemplate);
      const nativeArrayUrl = fixtureUrl(setupUrl, nativeArrayName);
      const nativeArrayValue = ["not-a-uuid", "not-a-uuid"];
      const nativeArrayIntent = await seedLegacyValue(
        nativeArrayUrl,
        "native-array-with-invalid-members",
        JSON.stringify(nativeArrayValue),
      );
      const nativeArrayResult = await runMigration(
        nativeArrayUrl,
        through65Folder,
      );
      expect(nativeArrayResult.failed).toBe(false);
      const nativeArrayClient = postgres(nativeArrayUrl, { max: 1 });
      try {
        const [preserved] = await nativeArrayClient<
          { attachment_ids: unknown }[]
        >`
          SELECT attachment_ids FROM mastra_message_intents
          WHERE tenant_id = ${nativeArrayIntent?.tenant}
        `;
        expect(preserved?.attachment_ids).toEqual(nativeArrayValue);
      } finally {
        await nativeArrayClient.end({ timeout: 5 });
      }

      const recordedName = await createDatabaseFrom(setup, template);
      const recordedUrl = fixtureUrl(setupUrl, recordedName);
      await migrateDatabase(recordedUrl, legacyFolder);
      const forwardIds = ["33333333-3333-4333-8333-333333333333"];
      const forwardIntent = await seedLegacyValue(
        recordedUrl,
        "valid-encoded-array",
        JSON.stringify(JSON.stringify(forwardIds)),
        forwardIds,
      );
      await exerciseForwardMigrationWriterWindow(recordedUrl);
      const forwardClient = postgres(recordedUrl, { max: 1 });
      try {
        const [journal] = await forwardClient<{ applied: string[] }[]>`
          SELECT array_agg(hash ORDER BY created_at) AS applied
          FROM drizzle.__drizzle_migrations
        `;
        expect(journal?.applied).toHaveLength(66);
        const [constraints] = await forwardClient<
          { names: string[]; validated: boolean[] }[]
        >`
          SELECT array_agg(conname ORDER BY conname) AS names,
            array_agg(convalidated ORDER BY conname) AS validated
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
        expect(constraints?.validated).toEqual([false, false, false]);
        const [converted] = await forwardClient<{ attachment_ids: string[] }[]>`
          SELECT attachment_ids FROM mastra_message_intents
          WHERE tenant_id = ${forwardIntent?.tenant}
        `;
        expect(converted?.attachment_ids).toEqual(forwardIds);
        await expectConstraintFailure(
          forwardClient`UPDATE enterprise_runs SET model_route_maximum_tokens = 0`,
          "enterprise_runs_model_route_maximum_tokens_check",
        );
        await expectConstraintFailure(
          forwardClient`UPDATE enterprise_model_budget_reservations SET confirmed_tokens = token_limit + 1`,
          "enterprise_budget_reservation_tokens_check",
        );
        await expectConstraintFailure(
          forwardClient`INSERT INTO mastra_message_intents (
            tenant_id, thread_id, client_message_key, message_id, digest,
            reserved_seq, actor_id, principal_id, backend_version, attachment_ids
          ) VALUES ('x','x','x','x','x',1,'x','x',1,'"not-an-array"'::jsonb)`,
          "mastra_message_intents_attachment_ids_array_check",
        );
      } finally {
        await forwardClient.end({ timeout: 5 });
      }
      await migrateDatabase(recordedUrl, migrationsRoot);
      const validationClient = postgres(recordedUrl, { max: 1 });
      try {
        const [validation] = await validationClient<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_constraint
          WHERE conname IN (
            'mastra_message_intents_attachment_ids_array_check',
            'enterprise_budget_reservation_tokens_check',
            'enterprise_runs_model_route_maximum_tokens_check'
          ) AND convalidated
        `;
        expect(validation?.count).toBe(3);
      } finally {
        await validationClient.end({ timeout: 5 });
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
