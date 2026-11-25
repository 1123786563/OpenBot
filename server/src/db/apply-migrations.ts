/**
 * Apply a migration folder to a database, or refuse before touching it.
 *
 * Separate from `scripts/migrate.ts` so that the refusal has a test. The script is an executable —
 * it reads the environment and exits — and the only way to find out what it does to a database that
 * is one journal out of step is to run it against such a database, which is what
 * `tests/migration-reach.integration.test.ts` does through this function.
 *
 * See `./migration-reach` for the check that refuses unrecognized histories. This runner can
 * reconcile known branch histories whose SQL is missing below Drizzle’s high-water mark.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql, TransactionSql } from "postgres";
import { reconcileBillingPilotMigrations } from "./billing-pilot-migrations";
import { reconcileCorsairPilotMigrations } from "./corsair-pilot-migrations";
import {
  canMergeMigrationHistories,
  isIntelligenceMigration,
} from "./merge-migration-histories";
import {
  type AppliedMigration,
  type FolderMigration,
  type MigrationsJournal,
  migrationsOutOfReach,
  migratorHighWaterMark,
  outOfReachRefusal,
  readMigrationFolder,
} from "./migration-reach";

/**
 * Where the migrator keeps its bookkeeping, named once.
 *
 * `migrate()` writes to whatever `migrationsSchema` / `migrationsTable` it is handed, and the
 * reach check below reads the same table to decide whether migrating is safe. If the two ever named
 * different tables the check would read an absent table, see nothing applied, and wave every
 * migration through — the refusal silently switched off. So both are handed this one object, and
 * nothing else in the server spells the name.
 *
 * The same object reaches the refusal's repair SQL (`outOfReachRefusal`), so the table an operator
 * is told to fix is the table the check read. The type is declared in `./migration-reach` and the
 * value here: that module is the dependency, not the dependent, and importing this value into it
 * would close a cycle.
 */
export type { MigrationsJournal };

export const MIGRATIONS_JOURNAL: MigrationsJournal = {
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

/**
 * What the migrator has already recorded here, or nothing at all.
 *
 * `to_regclass` rather than a query that may fail: a database the migrator has never touched has no
 * journal schema, and selecting from a table that is not there would be an error indistinguishable
 * from a database that cannot be read.
 */
async function appliedMigrations(
  client: TransactionSql,
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const [present] = await client<{ table: string | null }[]>`
    select to_regclass(format('%I.%I', ${migrationsSchema}::text, ${migrationsTable}::text))::text as table
  `;
  if (!present?.table) return [];

  const rows = await client<{ hash: string; created_at: string | null }[]>`
    select hash, created_at from ${client(migrationsSchema)}.${client(migrationsTable)}
  `;
  return rows.map((row) => ({
    hash: row.hash,
    /*
     * A NULL `created_at` is CARRIED, never coerced. `Number(null)` is 0, and 0 is a legitimate
     * stamp — so coercing here would hand `migratorHighWaterMark` a row indistinguishable from an
     * early migration and the guard would pass on exactly the database it exists to refuse. The
     * column is a bare `bigint` drizzle leaves nullable; see `./migration-reach`.
     */
    createdAt: row.created_at === null ? null : Number(row.created_at),
  }));
}

/** Thrown instead of migrating, when migrating would skip work and call it done. */
export class MigrationsOutOfReachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationsOutOfReachError";
  }
}

/**
 * One lock per database for every run of this function, whatever journal it carries.
 *
 * A constant rather than anything derived from the folder: the runs that must not overlap are
 * precisely the ones whose folders differ. Advisory locks are scoped to the database, so two
 * databases on one server never wait on each other.
 */
const MIGRATION_LOCK = "openbot:apply-migrations";

const DIRECT_CHAT_TAG = "0089_direct_chat_runs";
const FIRST_TRIAL_TAG = "0093_personal_saas_entry";

// Original Personal SaaS journal stamps, in order through workspace reprovision.
const TRIAL_STAMPS = [
  1795158327499, 1795160662134, 1795162001225, 1795173234015, 1795174523931,
  1795174795281, 1795176012983, 1795177502282, 1795178829465, 1795181383402,
  1795184138210, 1795184939036, 1795231535117,
];

/** Move a verified trial prefix onto the merged journal and apply the independent main migrations. */
async function reconcileTrialJournal(
  tx: TransactionSql,
  journal: MigrationsJournal,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): Promise<boolean> {
  const mark = migratorHighWaterMark(applied);
  // biome-ignore lint/complexity/useIndexOf: the mark may be undefined, which indexOf cannot take.
  const trialLength = TRIAL_STAMPS.findIndex((when) => when === mark) + 1;
  if (trialLength === 0) return false;

  const directChatIndex = folder.findIndex(
    ({ tag }) => tag === DIRECT_CHAT_TAG,
  );
  const trialIndex = folder.findIndex(({ tag }) => tag === FIRST_TRIAL_TAG);
  if (directChatIndex < 0 || trialIndex !== directChatIndex + 4) return false;

  const directChat = folder[directChatIndex];
  if (!directChat) return false;
  const appliedByStamp = new Map(
    applied.map(({ createdAt, hash }) => [createdAt, hash]),
  );
  const hasDirectChat = appliedByStamp.get(directChat.when) === directChat.hash;
  const shared = folder.slice(0, directChatIndex + Number(hasDirectChat));
  const trial = folder.slice(trialIndex, trialIndex + trialLength);
  if (
    trial.length !== trialLength ||
    appliedByStamp.size !== applied.length ||
    applied.length !== shared.length + trial.length ||
    shared.some(({ when, hash }) => appliedByStamp.get(when) !== hash) ||
    trial.some(({ hash }, index) => {
      const stamp = TRIAL_STAMPS[index];
      return stamp === undefined || appliedByStamp.get(stamp) !== hash;
    })
  ) {
    return false;
  }

  const { migrationsSchema, migrationsTable } = journal;
  const table = tx`${tx(migrationsSchema)}.${tx(migrationsTable)}`;
  const missingMain = folder.slice(
    directChatIndex + Number(hasDirectChat),
    trialIndex,
  );
  for (const migration of missingMain)
    await applyJournalEntry(tx, journal, migrationsFolder, migration);
  for (const [index, { hash, when }] of trial.entries()) {
    const original = TRIAL_STAMPS[index];
    if (original !== undefined && original !== when) {
      await tx`update ${table} set created_at = ${when}
        where hash = ${hash} and created_at = ${original}`;
    }
  }
  return true;
}

async function applyJournalEntry(
  tx: TransactionSql,
  { migrationsSchema, migrationsTable }: MigrationsJournal,
  migrationsFolder: string,
  { tag, hash, when }: FolderMigration,
) {
  const sql = await readFile(join(migrationsFolder, `${tag}.sql`), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== hash)
    throw new Error(`Migration ${tag} changed while reconciling the journal.`);
  for (const statement of sql.split("--> statement-breakpoint"))
    await tx.unsafe(statement);
  await tx`insert into ${tx(migrationsSchema)}.${tx(migrationsTable)}
    (hash, created_at) values (${hash}, ${when})`;
}

/** Apply the independent SaaS migrations to a verified billing trial prefix. */
async function reconcileBillingJournal(
  tx: TransactionSql,
  journal: MigrationsJournal,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): Promise<boolean> {
  const stamps = [1795189760197, 1795189760198, 1795189760199];
  const tags = [
    "0110_test_credit",
    "0111_test_credit_reconciliation",
    "0112_test_credit_cutoff_index",
  ];
  const mark = migratorHighWaterMark(applied);
  // biome-ignore lint/complexity/useIndexOf: the mark may be undefined, which indexOf cannot take.
  const billingLength = stamps.findIndex((stamp) => stamp === mark) + 1;
  if (!billingLength) return false;

  const firstBilling = folder.findIndex(({ tag }) => tag === tags[0]);
  const firstSaas = folder.findIndex(({ tag }) => tag === FIRST_TRIAL_TAG);
  if (firstSaas < 0 || firstBilling <= firstSaas) return false;

  const shared = folder.slice(0, firstSaas);
  const billing = folder.slice(firstBilling, firstBilling + billingLength);
  const appliedByStamp = new Map(
    applied.map(({ createdAt, hash }) => [createdAt, hash]),
  );
  if (
    billing.length !== billingLength ||
    appliedByStamp.size !== applied.length ||
    applied.length !== shared.length + billingLength ||
    shared.some(({ hash, when }) => appliedByStamp.get(when) !== hash) ||
    billing.some(
      ({ hash, tag }, index) =>
        tag !== tags[index] ||
        appliedByStamp.get(stamps[index] ?? null) !== hash,
    )
  )
    return false;

  for (const migration of folder.slice(firstSaas, firstBilling))
    await applyJournalEntry(tx, journal, migrationsFolder, migration);

  const table = tx`${tx(journal.migrationsSchema)}.${tx(journal.migrationsTable)}`;
  for (const [index, { hash, when }] of billing.entries())
    await tx`update ${table} set created_at = ${when}
      where hash = ${hash} and created_at = ${stamps[index] ?? null}`;
  return true;
}

const CORSAIR_TAGS = new Set([
  "0105_corsair_slack_personal",
  "0106_corsair_slack_shared",
  "0107_corsair_shared_storage",
  "0108_corsair_revocation",
]);

const BIFROST_MARKET_TAGS = new Set([
  "0117_bifrost_market_reviews",
  "0118_skill_market_equivalences",
]);

/** Fill gaps only for an exact applied prefix of one of the two parent journals. */
async function reconcileParentJournal(
  tx: TransactionSql,
  journal: MigrationsJournal,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  saasFolder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
) {
  const trialIndex = folder.findIndex(({ tag }) => tag === FIRST_TRIAL_TAG);
  const corsair = folder.filter(({ tag }) => CORSAIR_TAGS.has(tag));
  const lastSaasIndex = saasFolder.findIndex(
    ({ tag }) => tag === "0116_test_credit_embedding_replay",
  );
  if (
    trialIndex < 0 ||
    corsair.length !== CORSAIR_TAGS.size ||
    lastSaasIndex < 0
  )
    return;

  const mainFolder = [
    ...folder.slice(0, trialIndex),
    ...corsair,
    ...folder.filter(({ tag }) => BIFROST_MARKET_TAGS.has(tag)),
  ];
  const appliedByStamp = new Map(
    applied.map(({ createdAt, hash }) => [createdAt, hash]),
  );
  if (appliedByStamp.size !== applied.length) return;

  const matchesPrefix = (parent: readonly FolderMigration[]) =>
    applied.length <= parent.length &&
    parent
      .slice(0, applied.length)
      .every(({ when, hash }) => appliedByStamp.get(when) === hash);
  if (
    !matchesPrefix(mainFolder) &&
    !matchesPrefix(saasFolder.slice(0, lastSaasIndex + 1))
  )
    return;

  const mark = migratorHighWaterMark(applied);
  if (mark === undefined) return;
  for (const migration of folder) {
    if (migration.when <= mark && !appliedByStamp.has(migration.when))
      await applyJournalEntry(tx, journal, migrationsFolder, migration);
  }
}

/**
 * Check, then migrate, with nothing able to commit in between.
 *
 * THE GAP THIS CLOSES. The reach check reads the journal table; the migrator then reads it AGAIN to
 * find its high-water mark. Run as two steps, a second migrator could commit between
 * those reads — and if it carries a different journal (an operator's `db:migrate` from a checkout,
 * or a second release's Job started while the first is still running) its stamp can land above a
 * migration this run still has pending. The check passed before that stamp existed; the migrator
 * reads it afterwards, walks past the migration, and the run reports success over a table that is
 * not there: the exact outcome the check exists to prevent, arrived at through the gap between the
 * two reads. A rival with the SAME journal (a Job pod the controller started twice) is the lesser
 * case: both read the same mark, both run the same SQL, and one dies on a duplicate `CREATE`.
 *
 * So both run inside one transaction that first takes a transaction-scoped advisory lock. Every
 * other run of this function queues behind it and, once admitted, checks a table the previous run
 * has already committed. The lock goes with the transaction — on commit, on the refusal's rollback,
 * or when the connection dies — so there is no unlock to forget and no session to leak it into.
 *
 * WHAT IT DOES NOT COVER. A migrator that is not this function (`drizzle-kit migrate`, or an image
 * built before this lock) does not take it, and can still interleave. Every path this repository
 * runs goes through here; see `scripts/migrate.ts`.
 */
export async function applyMigrations(
  client: Sql,
  migrationsFolder: string,
  journal: MigrationsJournal = MIGRATIONS_JOURNAL,
): Promise<void> {
  const folder = await readMigrationFolder(migrationsFolder);

  await client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))`;

    const corsair = await reconcileCorsairPilotMigrations(
      tx,
      migrationsFolder,
      folder,
      await appliedMigrations(tx, journal),
      journal,
    );
    const mainFolder = folder.filter(
      (entry) => !isIntelligenceMigration(entry),
    );
    let applied = await reconcileBillingPilotMigrations(
      tx,
      migrationsFolder,
      folder,
      mainFolder,
      corsair,
      journal,
    );
    let outOfReach = migrationsOutOfReach(folder, applied);
    if (outOfReach.length > 0) {
      const saasFolder = mainFolder.filter(({ tag }) => !CORSAIR_TAGS.has(tag));
      if (
        (await reconcileTrialJournal(
          tx,
          journal,
          migrationsFolder,
          saasFolder,
          applied,
        )) ||
        (await reconcileBillingJournal(
          tx,
          journal,
          migrationsFolder,
          saasFolder,
          applied,
        ))
      ) {
        applied = await appliedMigrations(tx, journal);
      }
      await reconcileParentJournal(
        tx,
        journal,
        migrationsFolder,
        mainFolder,
        saasFolder,
        applied,
      );
      applied = await appliedMigrations(tx, journal);
      outOfReach = migrationsOutOfReach(folder, applied);
    }
    if (
      outOfReach.length > 0 &&
      !canMergeMigrationHistories(folder, applied, outOfReach)
    ) {
      throw new MigrationsOutOfReachError(
        outOfReachRefusal(outOfReach, folder, applied, journal),
      );
    }

    for (const migration of outOfReach)
      await applyJournalEntry(tx, journal, migrationsFolder, migration);

    await migrate(drizzle(withinTransaction(client, tx)), {
      migrationsFolder,
      ...journal,
    });
  });
}

/**
 * The open transaction, in the shape `drizzle()` takes a client in.
 *
 * Drizzle's migrator reads its high-water mark and runs the migrations through the client it is
 * given, and opens its own transaction with `client.begin`. A postgres.js transaction has no
 * `begin` — only `savepoint` — and no `options`, which `drizzle()` writes its type parsers into. So
 * this hands it exactly those three things: `unsafe` and `savepoint` from the transaction, so every
 * statement the migrator sends is inside the lock, and `options` from the pool the transaction
 * belongs to, which is where postgres.js reads parsers from. Its transaction becomes a savepoint in
 * ours, with the same all-or-nothing effect it always had.
 *
 * If a later drizzle-orm reaches for anything else on its client, it fails here with a TypeError at
 * the first migration rather than migrating outside the lock — and
 * `tests/migration-reach.integration.test.ts` runs exactly this path.
 */
function withinTransaction(client: Sql, tx: TransactionSql): Sql {
  const adapter = {
    options: client.options,
    unsafe: tx.unsafe.bind(tx),
    begin: <T>(fn: (sql: TransactionSql) => T | Promise<T>) => tx.savepoint(fn),
  };
  // The cast is the claim above: drizzle uses these three members and no others.
  return adapter as unknown as Sql;
}
