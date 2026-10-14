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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgres from "postgres";

// Session advisory-lock key pair reserved exclusively for openbot schema migrations.
// Arbitrary but stable: the pair identifies this project's migration mutex in the shared
// pg_advisory_lock namespace. Do not reuse for other purposes, and document any future
// key change so concurrent deployments cannot straddle two lock identities.
const migrationLockKey = [1330795348, 1296641874] as const;
const defaultLockTimeoutMs = 30_000;
type Journal = {
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};

function errorCauseChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  while (true) {
    chain.push(current);
    if (
      current === null ||
      (typeof current !== "object" && typeof current !== "function")
    )
      break;
    if (seen.has(current)) break;
    seen.add(current);
    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return chain;
}

export function sqlStateFromError(
  error: unknown,
  targetCode?: string,
): string | undefined {
  for (const current of errorCauseChain(error)) {
    if (current === null || typeof current !== "object") continue;
    try {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        if (targetCode === undefined || code === targetCode) return code;
      }
    } catch {}
  }
  return undefined;
}

export function createMigrationLockTimeoutError(
  error: unknown,
  lockTimeoutMs: number,
): Error | undefined {
  if (sqlStateFromError(error, "55P03") === undefined) return undefined;
  return new Error(
    `Timed out after ${lockTimeoutMs}ms waiting for the migration advisory lock.`,
    { cause: error },
  );
}

export function errorChainContains(error: unknown, expected: unknown): boolean {
  return errorCauseChain(error).some((current) => current === expected);
}

export function isConnectionFailure(error: unknown) {
  const connectionCodes = new Set([
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECTION_ENDED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "57P01",
    "57P02",
    "57P03",
  ]);
  for (const current of errorCauseChain(error)) {
    if (current === null || typeof current !== "object") continue;
    try {
      const code = (current as { code?: unknown }).code;
      if (
        typeof code === "string" &&
        (connectionCodes.has(code) || code.startsWith("08"))
      )
        return true;
    } catch {}
  }
  return false;
}

// The validation boundary: migrations through index 65 run first from a
// temporary prefix folder so they commit as one transaction, then 0066+ (the
// schema invariant guard validation) run in a second transaction. Both stages
// must stay on the same backend, hence the session-level advisory lock below.
const validationBoundaryIndex = 65;

function assertStrictlyIncreasing(
  entries: Journal["entries"],
  label: string,
): void {
  for (let position = 1; position < entries.length; position += 1) {
    const previous = entries[position - 1];
    const current = entries[position];
    if (
      typeof previous.when !== "number" ||
      typeof current.when !== "number" ||
      current.when <= previous.when
    ) {
      throw new Error(
        `Migration journal 'when' must strictly increase ${label} (idx ${previous.idx} -> ${current.idx}); both migrate passes apply entries against the last applied watermark, so a regression would be silently skipped.`,
      );
    }
  }
}

export function validateMigrationJournalBoundary(journal: Journal): void {
  const { position65, position66, prefixEntries } = journalBoundaryOf(journal);
  if (position65 < 0 || position66 < 0) return;
  if (position66 !== position65 + 1) {
    throw new Error(
      "Migration journal index 66 must immediately follow index 65.",
    );
  }
  // drizzle-orm's migrator (0.45.x, pinned by bun.lock) applies a journal entry
  // only when its 'when' is newer than the last applied created_at, so a prefix
  // entry whose 'when' reaches the index-66 timestamp would make the second
  // full-folder pass silently skip 0066+ on a fresh database — fail-open at the
  // exact boundary this runner exists to keep fail-closed.
  const validationWhen = journal.entries[position66].when;
  if (typeof validationWhen !== "number") {
    throw new Error(
      "Migration journal entries must carry numeric 'when' timestamps.",
    );
  }
  if (
    prefixEntries.some(
      (entry) => typeof entry.when !== "number" || entry.when >= validationWhen,
    )
  ) {
    throw new Error(
      "Migration journal 'when' timestamps through index 66 must be strictly ordered; drizzle's migrator skips entries whose 'when' is not newer than the last applied timestamp, so a boundary 'when' regression would silently skip migrations 0066+ on fresh databases.",
    );
  }
  // The FIRST pass is watermark-driven too: equal or regressed prefix whens
  // would be silently skipped there (OCR R8-M1), and the second pass applies
  // everything after the boundary against the same watermark semantics —
  // strict ordering must hold on both sides.
  assertStrictlyIncreasing(
    prefixEntries,
    `through index ${validationBoundaryIndex}`,
  );
  assertStrictlyIncreasing(
    journal.entries.filter((entry) => entry.idx >= validationBoundaryIndex + 1),
    `after index ${validationBoundaryIndex}`,
  );
}

function journalBoundaryOf(journal: Journal): {
  position65: number;
  position66: number;
  prefixEntries: Journal["entries"];
} {
  return {
    position65: journal.entries.findIndex(
      (entry) => entry.idx === validationBoundaryIndex,
    ),
    position66: journal.entries.findIndex(
      (entry) => entry.idx === validationBoundaryIndex + 1,
    ),
    prefixEntries: journal.entries.filter(
      (entry) => entry.idx <= validationBoundaryIndex,
    ),
  };
}

async function migrationPrefixThrough65(sourceFolder: string) {
  const journalPath = join(sourceFolder, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as Journal;
  validateMigrationJournalBoundary(journal);
  const { position65, position66, prefixEntries } = journalBoundaryOf(journal);
  if (position65 < 0 || position66 < 0) return undefined;
  const sqlFiles = (await readdir(sourceFolder)).filter((name) =>
    /^\d{4}_.*\.sql$/.test(name),
  );
  const indexedFiles = sqlFiles
    .map((name) => ({ name, index: Number(name.slice(0, 4)) }))
    .filter((file) => file.index <= validationBoundaryIndex)
    .sort((left, right) => left.index - right.index);
  const expected = prefixEntries
    .map((entry) => ({ index: entry.idx, name: `${entry.tag}.sql` }))
    .sort((left, right) => left.index - right.index);
  if (
    JSON.stringify(indexedFiles.map((file) => file.index)) !==
      JSON.stringify(expected.map((file) => file.index)) ||
    JSON.stringify(indexedFiles.map((file) => file.name)) !==
      JSON.stringify(expected.map((file) => file.name))
  ) {
    throw new Error(
      "Migration journal entries through index 65 do not exactly match their SQL files.",
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "openbot-migration-prefix-"));
  try {
    for (const file of indexedFiles)
      await cp(join(sourceFolder, file.name), join(directory, file.name));
    await mkdir(join(directory, "meta"), { recursive: true });
    await writeFile(
      join(directory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: prefixEntries }),
    );
    const copied = (await readdir(directory))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort();
    const expectedNames = indexedFiles.map((file) => file.name).sort();
    const copiedJournal = JSON.parse(
      await readFile(join(directory, "meta/_journal.json"), "utf8"),
    ) as Journal;
    const copiedIndexes = copiedJournal.entries
      .map((entry) => entry.idx)
      .sort((a, b) => a - b);
    if (
      JSON.stringify(copied) !== JSON.stringify(expectedNames) ||
      JSON.stringify(copiedIndexes) !==
        JSON.stringify(indexedFiles.map((file) => file.index))
    ) {
      throw new Error(
        "Temporary migration prefix journal does not match its copied SQL files.",
      );
    }
    return {
      directory,
      remove: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function assertReserveOmitsTransactionApi(reserved: object): void {
  // `in`, not Object.hasOwn: a future postgres.js that hangs the transaction API off the
  // prototype must still stop the pinning rather than silently shadow it.
  if ("options" in reserved || "begin" in reserved) {
    throw new Error(
      "postgres.js reserve() no longer omits options/begin; the manual BEGIN/COMMIT shim in this runner targets 3.4.9 and must be re-evaluated against the installed version.",
    );
  }
}

export async function migrateWithValidationBoundary(
  client: ReturnType<typeof postgres>,
  migrationsFolder: string,
  options: { lockTimeoutMs?: number } = {},
): Promise<void> {
  const lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeoutMs;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
    throw new RangeError("lockTimeoutMs must be a positive safe integer.");
  }
  const reserved = await client.reserve();
  let prefix: Awaited<ReturnType<typeof migrationPrefixThrough65>>;
  let database!: ReturnType<typeof drizzle>;
  let transactionClean = true;
  let lockAttempted = false;
  let lockAcquired = false;
  let unlockConfirmed = false;
  let settingsSafe = true;
  let operationError: unknown;
  let operationFailed = false;
  let pinned: typeof reserved;

  // Postgres.js 3.4.9's runtime reserve() wrapper omits options and begin even
  // though its declaration extends Sql. Drizzle needs options at construction
  // and calls begin for each migration transaction. Keep both operations on
  // the reserved handler so the lock and migration work stay on one backend.
  try {
    // Fail fast if a caret-range upgrade gave reserve() its own options/begin:
    // the manual shim must then be re-evaluated, not silently overridden.
    assertReserveOmitsTransactionApi(reserved);
    pinned = Object.assign(reserved, {
      options: client.options,
      begin: async <T>(
        callback: (transactionClient: typeof reserved) => Promise<T> | T,
      ) => {
        try {
          await reserved.unsafe("BEGIN");
        } catch (error) {
          transactionClean = false;
          throw error;
        }

        let result: T;
        try {
          result = await callback(pinned);
        } catch (error) {
          if (isConnectionFailure(error)) {
            transactionClean = false;
            throw error;
          }
          try {
            await reserved.unsafe("ROLLBACK");
            transactionClean = true;
          } catch (rollbackError) {
            transactionClean = false;
            throw new AggregateError(
              [error, rollbackError],
              "Migration transaction failed and rollback also failed.",
            );
          }
          throw error;
        }

        try {
          await reserved.unsafe("COMMIT");
          transactionClean = true;
        } catch (error) {
          transactionClean = false;
          throw error;
        }
        return result;
      },
    });
    database = drizzle(pinned);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    if (operationFailed) throw operationError;
    settingsSafe = false;
    try {
      await database.execute(
        sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, false)`,
      );
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      if (!operationFailed) {
        lockAttempted = true;
        await database.execute(
          sql`SELECT pg_advisory_lock(${migrationLockKey[0]}, ${migrationLockKey[1]})`,
        );
        lockAcquired = true;
      }
    } catch (error) {
      operationFailed = true;
      operationError =
        createMigrationLockTimeoutError(error, lockTimeoutMs) ?? error;
    }
    try {
      await database.execute(sql.raw("RESET lock_timeout"));
      settingsSafe = true;
    } catch (resetError) {
      operationFailed = true;
      if (operationError === undefined) operationError = resetError;
      else {
        operationError = new AggregateError(
          [operationError, resetError],
          "Migration lock setup failed and lock_timeout could not be reset.",
          { cause: operationError },
        );
      }
    }
    if (operationFailed) throw operationError;
    prefix = await migrationPrefixThrough65(migrationsFolder);
    if (prefix) {
      await migrate(database, { migrationsFolder: prefix.directory });
      await migrate(database, { migrationsFolder });
    } else {
      await migrate(database, { migrationsFolder });
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  const postCommitCleanupFailure = (error: unknown) => {
    if (!operationFailed) {
      // Both migrate stages already committed: the forced client.end below
      // releases the session lock regardless, so a cleanup blip must not
      // fail an otherwise successful deployment (OCR R10).
      console.warn(
        JSON.stringify({
          type: "migration-cleanup-warning",
          error: String(error),
        }),
      );
      return;
    }
    cleanupErrors.push(error);
  };
  try {
    await prefix?.remove();
  } catch (error) {
    postCommitCleanupFailure(error);
  }
  if (transactionClean && lockAttempted && lockAcquired) {
    try {
      const result = await database.execute(
        sql`SELECT pg_advisory_unlock(${migrationLockKey[0]}, ${migrationLockKey[1]}) AS unlocked`,
      );
      const rows = result as unknown as Array<{ unlocked: boolean }>;
      if (rows[0]?.unlocked !== true)
        throw new Error("Migration advisory lock was not held at unlock.");
      unlockConfirmed = true;
    } catch (error) {
      postCommitCleanupFailure(error);
    }
  }

  const safeToRelease =
    transactionClean &&
    settingsSafe &&
    (!lockAttempted || (lockAcquired && unlockConfirmed));
  if (safeToRelease) {
    try {
      reserved.release();
    } catch (error) {
      cleanupErrors.push(error);
      try {
        await client.end({ timeout: 0 });
      } catch (endError) {
        cleanupErrors.push(endError);
      }
    }
  } else {
    try {
      await client.end({ timeout: 0 });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (operationFailed && cleanupErrors.length > 0)
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Migration failed and one or more cleanup steps also failed.",
    );
  if (operationFailed) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, "Migration cleanup failed.");
}
