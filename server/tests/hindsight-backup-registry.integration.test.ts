import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../src/db/client";
import { hindsightControlledBackups } from "../src/db/schema/hindsight-restore";
import { reconcileControlledBackups } from "../src/hindsight/backup-registry";
import { createCleanupEvidenceService } from "../src/hindsight/cleanup-evidence";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * FIX-OCR2 (O2-M6, #391): what `archivePresent` may read as "the copy is gone". The purge
 * evidence stands on this one answer — manifest present, archive absent — and the route and
 * ops suites already pin its happy paths (registration, the ENOENT purge, the withdrawal on
 * a copy that came back). This file pins the failure half the OCR finding names: an access
 * error that is NOT "file not found" (EACCES on the directory, EIO, ESTALE, and here a
 * component past the filesystem's NAME_MAX, which fails before permission is even asked)
 * must never be folded into "absent", or the leg would answer a controlled-copy purge the
 * deployment never witnessed. Such an error goes up instead: the caller isolates it, and
 * the copy stays outstanding.
 */

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const registry = createCleanupEvidenceService(database, {
  apiUrl: "http://127.0.0.1:1/",
  serviceApiKey: "unused",
  assertionSecret: "unused",
  requestTimeoutMs: 100,
});
const tempDirs: string[] = [];
const backupIds = [
  `hindsight-enoent-${run}.sql.gz`,
  `hindsight-err-${run}.sql.gz`,
];

/** One manifest beside its archive, the backup job's shape. */
async function writePair(
  directory: string,
  backupId: string,
  takenAt: Date,
  withArchive: boolean,
): Promise<void> {
  await writeFile(
    join(directory, `${backupId}.manifest.json`),
    `${JSON.stringify({ backupId, takenAt: takenAt.toISOString() })}\n`,
    "utf8",
  );
  if (withArchive)
    await writeFile(join(directory, backupId), "not-a-real-dump", "utf8");
}

async function rowOf(backupId: string) {
  const [row] = await database
    .select({
      purgedAt: hindsightControlledBackups.purgedAt,
      purgeEvidence: hindsightControlledBackups.purgeEvidence,
    })
    .from(hindsightControlledBackups)
    .where(eq(hindsightControlledBackups.backupId, backupId));
  return row;
}

describe("FIX-OCR2 O2-M6 — only a provable absence is purge evidence", () => {
  beforeAll(async () => {
    for (const suffix of ["enoent", "err"]) {
      const dir = await mkdtemp(join(tmpdir(), `h376-fixocr2-${suffix}-`));
      tempDirs.push(dir);
    }
  });

  afterAll(async () => {
    await database
      .delete(hindsightControlledBackups)
      .where(eq(hindsightControlledBackups.backupId, backupIds[0]));
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  test("ENOENT purges; any other access error throws and leaves the copy outstanding", async () => {
    const [presentDir, errorDir] = tempDirs;
    const past = new Date(Date.now() - 172_800_000);

    // The positive control: manifest present, archive gone — the sweep's deletion, and the
    // only shape that may be written down as a purge.
    await writePair(presentDir, backupIds[0], past, false);
    const purged = await reconcileControlledBackups({
      database,
      manifestDirectory: presentDir,
      registry,
    });
    expect(purged.registered).toBe(1);
    expect(purged.purged).toBe(1);
    expect((await rowOf(backupIds[0]))?.purgedAt).not.toBeNull();

    /*
     * The error half. A backup id one byte past the filesystem's NAME_MAX passes the
     * manifest's own validation (BACKUP_ID_MAX is 256; APFS and ext4 cap a component at
     * 255) and makes access() fail with ENAMETOOLONG — a stand-in for every access error
     * that means "the check could not see" rather than "the name is not there". The
     * manifest's own FILE name stays short, so the read side still reaches the check.
     */
    const longId = `hindsight-${"a".repeat(239)}.sql.gz`;
    expect(longId).toHaveLength(256);
    await writeFile(
      join(errorDir, "hindsight-long.manifest.json"),
      `${JSON.stringify({ backupId: longId, takenAt: past.toISOString() })}\n`,
      "utf8",
    );
    // The probe's own sanity: the failing check is in place before the seam is asked.
    await expect(access(join(errorDir, longId))).rejects.toMatchObject({
      code: "ENAMETOOLONG",
    });

    // On BASE this resolved with purged: 1 — a purge written for an archive nobody could
    // see. It must reject instead, and the registry row it already registered must keep
    // its purge columns empty: outstanding, never guessed cleared.
    await expect(
      reconcileControlledBackups({
        database,
        manifestDirectory: errorDir,
        registry,
      }),
    ).rejects.toMatchObject({ code: "ENAMETOOLONG" });
    const [registered] = await database
      .select({
        purgedAt: hindsightControlledBackups.purgedAt,
        purgeEvidence: hindsightControlledBackups.purgeEvidence,
      })
      .from(hindsightControlledBackups)
      .where(eq(hindsightControlledBackups.backupId, longId));
    expect(registered).toBeDefined();
    expect(registered.purgedAt).toBeNull();
    expect(registered.purgeEvidence).toBeNull();
    await database
      .delete(hindsightControlledBackups)
      .where(eq(hindsightControlledBackups.backupId, longId));
  });
});
