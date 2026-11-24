import { readMigrationFiles } from "drizzle-orm/migrator";
import type { TransactionSql } from "postgres";
import type {
  AppliedMigration,
  FolderMigration,
  MigrationsJournal,
} from "./migration-reach";

const firstSharedSaas = "0093_personal_saas_entry";
const corsairTags = new Set([
  "0105_corsair_slack_personal",
  "0106_corsair_slack_shared",
  "0107_corsair_shared_storage",
  "0108_corsair_revocation",
]);
const marketTags = new Set([
  "0117_bifrost_market_reviews",
  "0118_skill_market_equivalences",
]);
const sharedCreditTags = [
  "0110_test_credit",
  "0111_test_credit_reconciliation",
  "0112_test_credit_cutoff_index",
];
// The original Approval migration was dated ahead of the deployment clock.
const futureApprovalStamp = 1795520000000;
const futureBillingStampShift = 104585266;
const priorSharedCreditStamps = [1795415414732, 1795415414733, 1795415414734];

// The stamps before the billing branch first incorporated the market migrations.
const originalBillingStamps = [
  1795189761200, 1795189761201, 1795189761202, 1795189761203, 1795274391980,
  1795342763927, 1795346151553, 1795347574512, 1795348424055, 1795350048022,
  1795350362484, 1795356091239, 1795356211989, 1795356576870, 1795359543713,
  1795362608388, 1795404290805, 1795408654519, 1795411279951, 1795414730431,
  1795414730432,
];

type PreviousEntry = { migration: FolderMigration; previousStamp: number };

function prefixMatches(
  previous: readonly PreviousEntry[],
  applied: readonly AppliedMigration[],
  byStamp: ReadonlyMap<number | null, string>,
  firstCreditStamp: number,
) {
  return (
    byStamp.has(firstCreditStamp) &&
    byStamp.size === applied.length &&
    previous.length === applied.length &&
    previous.every(
      ({ migration, previousStamp }) =>
        byStamp.get(previousStamp) === migration.hash,
    )
  );
}

/** Bring an exact previously deployed billing prefix onto main's canonical history. */
export async function reconcileBillingPilotMigrations(
  tx: TransactionSql,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  applied: AppliedMigration[],
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const sharedEnd = folder.findIndex(({ tag }) => tag === firstSharedSaas);
  const firstCredit = folder.findIndex(
    ({ tag }) => tag === sharedCreditTags[0],
  );
  const newBilling = folder.findIndex(
    ({ tag }) => tag === "0120_test_credit_execution_budgets",
  );
  const corsair = folder.filter(({ tag }) => corsairTags.has(tag));
  const market = folder.filter(({ tag }) => marketTags.has(tag));
  const sameCreditSql = folder.slice(firstCredit, firstCredit + 3);
  if (
    sharedEnd !== 93 ||
    newBilling !== 120 ||
    corsair.length !== corsairTags.size ||
    market.length !== marketTags.size ||
    sameCreditSql.length !== sharedCreditTags.length ||
    !sameCreditSql.every(({ tag }, index) => tag === sharedCreditTags[index])
  ) {
    return applied;
  }

  const shared = [...folder.slice(0, sharedEnd), ...corsair];
  const billingOnly = folder.slice(newBilling, 145);
  const billing = [...sameCreditSql, ...billingOnly];
  const appliedByStamp = new Map(
    applied.map(({ createdAt, hash }) => [createdAt, hash]),
  );
  const previousPrefix = (
    sharedEntries: readonly FolderMigration[],
    stamps: readonly number[],
    entries: readonly FolderMigration[],
  ) =>
    [
      ...sharedEntries.map((migration) => ({
        migration,
        previousStamp: migration.when,
      })),
      ...entries.map((migration, index) => ({
        migration,
        previousStamp: stamps[index] ?? migration.when,
      })),
    ].slice(0, applied.length);

  const prior = previousPrefix(
    [...shared, ...market],
    priorSharedCreditStamps,
    billing,
  );
  // The older pilot ended at background tool results, before the paid path policy.
  const original = previousPrefix(
    shared,
    originalBillingStamps,
    billing.slice(0, -1),
  );
  const previouslyMerged = previousPrefix(
    folder.slice(0, newBilling - 1),
    [],
    billingOnly,
  );
  const futureApproval = previousPrefix(
    folder.slice(0, newBilling - 1),
    [
      futureApprovalStamp,
      ...billingOnly.map(({ when }) => when + futureBillingStampShift),
    ],
    folder.slice(newBilling - 1, 145),
  );
  const previous = [
    { entries: prior, firstStamp: priorSharedCreditStamps[0] },
    { entries: original, firstStamp: originalBillingStamps[0] },
    { entries: previouslyMerged, firstStamp: billingOnly[0]?.when },
    { entries: futureApproval, firstStamp: futureApprovalStamp },
  ].find(
    ({ entries, firstStamp }) =>
      firstStamp !== undefined &&
      prefixMatches(entries, applied, appliedByStamp, firstStamp),
  )?.entries;
  if (!previous) return applied;

  const alreadyApplied = new Set(
    previous.map(({ migration }) => migration.tag),
  );
  const lastAppliedIndex = folder.findLastIndex(({ tag }) =>
    alreadyApplied.has(tag),
  );
  const throughLast = folder.slice(0, lastAppliedIndex + 1);
  const journal = tx`${tx(migrationsSchema)}.${tx(migrationsTable)}`;
  for (const {
    migration: { when, hash },
    previousStamp,
  } of previous) {
    if (previousStamp !== when) {
      await tx`update ${journal} set created_at = ${when}
        where created_at = ${previousStamp} and hash = ${hash}`;
    }
  }
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const [index, { when, hash, tag }] of throughLast.entries()) {
    if (alreadyApplied.has(tag)) continue;
    const migration = migrations[index];
    if (migration?.hash !== hash || migration.folderMillis !== when) {
      throw new Error(
        `Migration ${tag} changed while reconciling the billing pilot journal.`,
      );
    }
    for (const statement of migration.sql) await tx.unsafe(statement);
    await tx`insert into ${journal} (hash, created_at) values (${hash}, ${when})`;
  }
  return throughLast.map(({ when, hash }) => ({ createdAt: when, hash }));
}
