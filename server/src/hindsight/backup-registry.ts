/**
 * The controlled-backup registration the cleanup-evidence leg reads (#391, the backup half of
 * the triple evidence claim, wired by the #376 r1 audit's RG5-1 tail item ⑥).
 *
 * The backup job (`deploy/hindsight/backup.sh`) runs outside OpenBot and writes one archive per
 * run. The cleanup claim may only name copies this deployment KNOWS about — an empty registry is
 * "no evidence", never "no backups" (`cleanup-evidence.ts` refuses the shortcut) — so the job
 * leaves one manifest beside each archive it adopted, and this module reconciles those manifests
 * into `hindsight_controlled_backups`:
 *
 *   - REGISTRATION. Every valid `hindsight-*.manifest.json` in the declared directory names one
 *     archive and the instant its dump began (the conservative "taken before" moment: content
 *     written before that instant can be in the copy). Registration is idempotent — the
 *     registry's own unique key folds a re-read.
 *   - PURGE EVIDENCE. The job's retention sweep deletes aged archives and deliberately keeps
 *     their manifests: manifest present + archive absent is this deployment's observable proof
 *     that the copy was deleted under the declared window, and it is recorded as the purge
 *     evidence. A registered copy whose archive is gone AND whose manifest is gone is not
 *     provable either way — it stays outstanding rather than being guessed cleared.
 *
 * The manifest is a plain JSON object, `{"backupId": "hindsight-<stamp>.sql.gz",
 * "takenAt": "<ISO 8601>"}`, one file per archive, written atomically after the archive passed
 * its integrity check. Nothing in it is memory content; the directory is declared to OpenBot via
 * `HINDSIGHT_BACKUP_MANIFEST_DIR` and is absent by default, which leaves this deployment's
 * registry exactly as it was before this module existed.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../db/client";
import { hindsightControlledBackups } from "../db/schema/hindsight-restore";
import type { CleanupEvidenceService } from "./cleanup-evidence";

/** The manifest suffix the backup job writes beside each archive it adopted. */
const MANIFEST_SUFFIX = ".manifest.json";
/** Archive names carry a UTC stamp; anything else is not this job's manifest. */
const ARCHIVE_NAME = /^hindsight-[A-Za-z0-9._-]+\.sql\.gz$/;
/** The backup id travels into a registry column and a path join; keep it to one segment. */
const BACKUP_ID_MAX = 256;

/** What one reconciliation pass found and did. */
export type BackupRegistrationReport = {
  /** The directory read; named so an operator's log shows what was actually consulted. */
  directory: string;
  /** Valid manifests read. */
  manifests: number;
  /** Files matching the manifest suffix that were not usable (unreadable, malformed, foreign). */
  skipped: number;
  /** Copies registered by THIS pass (an already-registered copy is counted below instead). */
  registered: number;
  alreadyRegistered: number;
  /** Registered copies this pass could prove deleted: manifest still present, archive gone. */
  purged: number;
};

/**
 * The manifest directory as this deployment declares it. Absent or blank means the deployment
 * has not made the backup job's output visible to OpenBot; nothing is guessed from a default
 * path, because a wrong directory would read somebody else's files as this deployment's backups.
 */
export function backupManifestDirFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.HINDSIGHT_BACKUP_MANIFEST_DIR?.trim();
  return raw ? raw : null;
}

type ManifestEntry = { backupId: string; takenAt: Date };

/** Parse one manifest file; null when it is not a manifest this deployment can trust. */
function parseManifest(raw: string): ManifestEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const { backupId, takenAt } = parsed as {
    backupId?: unknown;
    takenAt?: unknown;
  };
  if (
    typeof backupId !== "string" ||
    backupId.length === 0 ||
    backupId.length > BACKUP_ID_MAX ||
    backupId.includes("..") ||
    !ARCHIVE_NAME.test(backupId)
  )
    return null;
  if (typeof takenAt !== "string") return null;
  const taken = new Date(takenAt);
  if (Number.isNaN(taken.getTime())) return null;
  return { backupId, takenAt: taken };
}

/**
 * Read every manifest the backup job left in `directory`.
 *
 * A missing directory is NOT an error: a deployment that declared the key but whose backup
 * volume is not mounted here yet has no copies to register, and the leg must answer honestly
 * (uncleared) rather than fail the whole status read. An unreadable-but-present directory is an
 * operator error and throws, so a permissions mistake is visible instead of silent.
 */
async function readManifests(directory: string): Promise<{
  entries: ManifestEntry[];
  skipped: number;
}> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { entries: [], skipped: 0 };
    throw error;
  }
  const entries: ManifestEntry[] = [];
  let skipped = 0;
  for (const name of names.sort()) {
    if (!name.startsWith("hindsight-") || !name.endsWith(MANIFEST_SUFFIX))
      continue;
    let manifest: ManifestEntry | null = null;
    try {
      manifest = parseManifest(await readFile(join(directory, name), "utf8"));
    } catch {
      manifest = null;
    }
    if (manifest) entries.push(manifest);
    else skipped++;
  }
  return { entries, skipped };
}

async function archivePresent(
  directory: string,
  backupId: string,
): Promise<boolean> {
  try {
    await access(join(directory, backupId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile the manifests into the cleanup-evidence registry. Registration goes through the
 * cleanup service's own recorder (one policy for how a copy is written down); the read side
 * selects the registry's unpurged rows so purge proof is only ever noted once, and only for a
 * copy this pass can actually prove gone.
 */
export async function reconcileControlledBackups(input: {
  database: Database;
  manifestDirectory: string;
  registry: Pick<
    CleanupEvidenceService,
    "recordControlledBackup" | "noteControlledBackupPurged"
  >;
  now?: () => Date;
}): Promise<BackupRegistrationReport> {
  const now = input.now ?? (() => new Date());
  const { entries, skipped } = await readManifests(input.manifestDirectory);
  const byId = new Map<string, ManifestEntry>();
  for (const entry of entries) byId.set(entry.backupId, entry);

  let registered = 0;
  let alreadyRegistered = 0;
  for (const entry of byId.values()) {
    const { noted } = await input.registry.recordControlledBackup({
      backupId: entry.backupId,
      takenAt: entry.takenAt,
    });
    if (noted) registered++;
    else alreadyRegistered++;
  }

  let purged = 0;
  const registeredRows = await input.database
    .select()
    .from(hindsightControlledBackups);
  const purgedAt = now();
  for (const row of registeredRows) {
    if (row.purgedAt !== null) continue;
    // Only a copy whose manifest THIS pass read can be judged: the manifest is the registration
    // receipt, and its survival beside a missing archive is the retention sweep's fingerprint.
    if (!byId.has(row.backupId)) continue;
    if (await archivePresent(input.manifestDirectory, row.backupId)) continue;
    const { noted } = await input.registry.noteControlledBackupPurged({
      backupId: row.backupId,
      purgedAt,
      evidence: `archive absent from the controlled-backup directory while its manifest remains; the retention sweep deleted the copy (reconciled ${purgedAt.toISOString()})`,
    });
    if (noted) purged++;
  }

  return {
    directory: input.manifestDirectory,
    manifests: byId.size,
    skipped,
    registered,
    alreadyRegistered,
    purged,
  };
}
