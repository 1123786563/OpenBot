import { readMigrationFiles } from "drizzle-orm/migrator";
import type { TransactionSql } from "postgres";
import type {
  AppliedMigration,
  FolderMigration,
  MigrationsJournal,
} from "./migration-reach";

const directChatHash =
  "2d552c3475153bd86a04b0d069be6fe8702724ce3833efbcb043d9beaef4e540";
const pilotMigrations = [
  [
    1795157336453,
    "cda199b476797d2552d5123303409e90ceab5b87437ddd567113ea3e9f6c94b2",
  ],
  [
    1795159221383,
    "f03767a64a4768e2256e020d76c7d2a5e20608f92935b96088701838bcfb56d9",
  ],
  [
    1795160228166,
    "0fe600ccaf52160a9f5607156dc8dba98be0afb92209ce2da320f05c2ee9b183",
  ],
  [
    1795161386423,
    "76ca9115951d9864c7d112887d8f8c328469b5ee963090bdba6e8ee95f101d51",
  ],
  [
    1795166247870,
    "a600a5b4cbcda9db067ba15e1d0bba133949835c47a8235ba87dfb59eaf3a0a6",
  ],
  [
    1795172289661,
    "4e35182f8e6d0840f2b3d1c844bf5c86a3cadcc96a80d354032c1297c3af31bc",
  ],
  [
    1795175780566,
    "03e6f7b1b1310145476d48e49680121114639963cd2a163afc12789c3bd4c48e",
  ],
] as const;

/** Reconcile only a recorded prefix of the b490a546 Corsair pilot history. */
export async function reconcileCorsairPilotMigrations(
  tx: TransactionSql,
  migrationsFolder: string,
  folder: readonly FolderMigration[],
  applied: AppliedMigration[],
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const [firstPilotStamp] = pilotMigrations[0];
  if (!applied.some((row) => row.createdAt === firstPilotStamp)) return applied;

  const shared = folder.slice(0, 89);
  const directChat = folder[89];
  const shiftedPilot = folder.slice(90, 97);
  const pilotPrefix = pilotMigrations.slice(0, applied.length - shared.length);
  const expected = [
    ...shared.map(({ when, hash }) => ({ createdAt: when, hash })),
    ...pilotPrefix.map(([createdAt, hash]) => ({ createdAt, hash })),
  ];
  const ordered = [...applied].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
  if (
    directChat?.hash !== directChatHash ||
    directChat.when !== 1795157993281 ||
    shiftedPilot.length !== pilotMigrations.length ||
    !shiftedPilot.every(
      ({ hash, when }, index) =>
        hash === pilotMigrations[index]?.[1] && when === 1795175780567 + index,
    ) ||
    expected.length !== applied.length ||
    !expected.every(
      ({ createdAt, hash }, index) =>
        createdAt === ordered[index]?.createdAt &&
        hash === ordered[index]?.hash,
    )
  )
    return applied;

  const migration = readMigrationFiles({ migrationsFolder })[89];
  if (
    migration?.hash !== directChatHash ||
    migration.folderMillis !== directChat.when
  ) {
    throw new Error(
      "Published direct chat migration changed during Corsair pilot upgrade",
    );
  }

  const journal = tx`${tx(migrationsSchema)}.${tx(migrationsTable)}`;
  for (const statement of migration.sql) await tx.unsafe(statement);
  await tx`insert into ${journal} (hash, created_at) values (${directChat.hash}, ${directChat.when})`;
  for (const [index, [oldStamp, hash]] of pilotPrefix.entries()) {
    const newStamp = 1795175780567 + index;
    await tx`update ${journal} set created_at = ${newStamp} where created_at = ${oldStamp} and hash = ${hash}`;
  }

  return [
    ...expected.slice(0, shared.length),
    { createdAt: directChat.when, hash: directChat.hash },
    ...shiftedPilot
      .slice(0, pilotPrefix.length)
      .map(({ when, hash }) => ({ createdAt: when, hash })),
  ];
}
