import { readMigrationFiles } from "drizzle-orm/migrator";
import type { TransactionSql } from "postgres";
import type {
  AppliedMigration,
  FolderMigration,
  MigrationsJournal,
} from "./migration-reach";

const mainAdditions = [
  [
    1795410635032,
    "8b27189a3b516e22a7be0a9d56f89bb3b707a66824f8841f41241f14b729abe0",
  ],
  [
    1795415414731,
    "3ef8a33465c6a3813284e1c4a7a4cfc6b50690f0813815d9bed9a528618060a9",
  ],
] as const;

// The changed timestamps in PR #117 at 531852556. The other billing migrations
// keep their stamps. The merge preserves every original SQL file byte for byte.
const originalBillingStamps = [
  1795189761200, 1795189761201, 1795189761202, 1795189761203, 1795274391980,
  1795342763927, 1795346151553, 1795347574512, 1795348424055, 1795350048022,
  1795350362484, 1795356091239, 1795356211989, 1795356576870, 1795359543713,
  1795362608388, 1795404290805, 1795408654519, 1795411279951, 1795414730431,
  1795414730432,
];

/** Add main's independent migrations to a verified prefix of the billing pilot journal. */
export async function reconcileBillingPilotMigrations(
  tx: TransactionSql,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  applied: AppliedMigration[],
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const billingStart = 99;
  const billingEnd = 126;
  const sharedCount = billingStart - mainAdditions.length;
  if (!applied.some(({ createdAt }) => createdAt === originalBillingStamps[0]))
    return applied;

  const main = folder.slice(sharedCount, billingStart);
  const billing = folder.slice(billingStart, billingEnd);
  if (
    billing.length !== billingEnd - billingStart ||
    billing[0]?.hash !==
      "1719112c1fe16df66b2164291536105ad9d88a08e9661c84df5d0bc4c6ff30ea" ||
    !mainAdditions.every(
      ([when, hash], index) =>
        main[index]?.when === when && main[index]?.hash === hash,
    ) ||
    !originalBillingStamps.every(
      (_, index) => billing[index]?.when === mainAdditions[1][0] + index + 1,
    )
  )
    return applied;

  const prefix = billing.slice(0, applied.length - sharedCount);
  const expected = [
    ...folder
      .slice(0, sharedCount)
      .map(({ when, hash }) => ({ createdAt: when, hash })),
    ...prefix.map(({ when, hash }, index) => ({
      createdAt: originalBillingStamps[index] ?? when,
      hash,
    })),
  ];
  const ordered = [...applied].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
  if (
    expected.length !== ordered.length ||
    !expected.every(
      ({ createdAt, hash }, index) =>
        createdAt === ordered[index]?.createdAt &&
        hash === ordered[index]?.hash,
    )
  )
    return applied;

  const journal = tx`${tx(migrationsSchema)}.${tx(migrationsTable)}`;
  const migrations = readMigrationFiles({ migrationsFolder });
  for (const [index, { when, hash }] of main.entries()) {
    const migration = migrations[sharedCount + index];
    if (migration?.hash !== hash || migration.folderMillis !== when)
      throw new Error(
        "Published main migration changed during billing pilot upgrade",
      );
    for (const statement of migration.sql) await tx.unsafe(statement);
    await tx`insert into ${journal} (hash, created_at) values (${hash}, ${when})`;
  }
  for (const [index, { when, hash }] of prefix.entries()) {
    const oldStamp = originalBillingStamps[index];
    if (oldStamp !== undefined)
      await tx`update ${journal} set created_at = ${when} where created_at = ${oldStamp} and hash = ${hash}`;
  }
  return [...folder.slice(0, sharedCount), ...main, ...prefix].map(
    ({ when, hash }) => ({
      createdAt: when,
      hash,
    }),
  );
}
