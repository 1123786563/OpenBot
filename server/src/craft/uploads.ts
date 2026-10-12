/**
 * The upload half of the craft file surface — the port of onyx `build/utils.py`'s
 * `sanitize_filename` / `validate_file` plus the upload-limit accounting onyx answered with
 * `find | wc -l` and `du -sb` inside the pod.
 *
 * OpenBot's sandbox listing is the agent-sandbox gateway's `GET /file`, which answers bare path
 * strings — no size, no mtime. The per-file limit is exact (the bytes are in hand), the count
 * limit is exact (the listing names every file), and the total-size limit rides a persisted
 * ledger (`.openbot-uploads.json` under attachments/) that the upload/delete endpoints keep in
 * step: the ledger lives INSIDE the workspace, so snapshot/restore carries it with the very files
 * it describes. A file the agent itself drops into attachments/ counts toward the file-count
 * limit (onyx counts it too) but its bytes cannot — the channel has no size verb. That is the
 * one honest divergence, recorded in the port docs.
 *
 * Extension and MIME type are intentionally unrestricted, exactly as onyx: uploads only ever
 * execute inside the locked-down sandbox, which is the real security boundary.
 */

import type { AgentSandboxFileApi } from "./sandbox-gateway";

// ── sanitize_filename (utils.py:38-75, verbatim semantics) ───────────────────

/** Allowed filename characters: alphanumeric, dash, underscore, period (utils.py:35). */
const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9._-]/g;

/**
 * Sanitize a client-supplied filename: strip any path component, drop null bytes, replace
 * unsafe characters with underscore, refuse hidden/empty results, cap at 255 characters while
 * preserving the extension. Returns a name that is always safe to join under attachments/.
 */
export function sanitizeFilename(filename: string): string {
  // Remove any path components (prevent path traversal) — both separators, so a Windows-style
  // name loses its "directory" the same way a POSIX one does.
  let name = filename.split(/[\\/]/).at(-1) ?? "";

  // Remove null bytes (split/join, not a regex — the byte never appears in a regex literal).
  name = name.split("\0").join("");

  // Replace unsafe characters with underscore.
  name = name.replace(SAFE_FILENAME_PATTERN, "_");

  // Remove leading/trailing dots and spaces (Python's strip(". ")).
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

  // Ensure filename is not empty.
  if (!name) name = "unnamed_file";

  // Ensure filename doesn't start with a dot (hidden file) — unreachable after the strip in
  // practice, kept for the original's belt-and-braces.
  if (name.startsWith(".")) name = `_${name.slice(1)}`;

  // Limit length, preserving the extension (a leading dot is not an extension separator,
  // matching pathlib's stem/suffix split).
  const max_length = 255;
  if (name.length > max_length) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    const stem = (dot > 0 ? name.slice(0, dot) : name).slice(
      0,
      max_length - ext.length,
    );
    name = stem + ext;
  }

  return name;
}

// ── per-file size validation (utils.py validate_file) ────────────────────────

/** One validated size: null when the size is legal, else the refusal sentence (onyx's). */
export function validateFileSize(
  sizeBytes: number,
  maxBytes: number,
): string | null {
  if (sizeBytes <= 0) return "File is empty";
  if (sizeBytes > maxBytes) {
    return `File size exceeds maximum allowed size of ${maxBytes} bytes`;
  }
  return null;
}

// ── upload-limit accounting (manager.get_upload_stats, gateway-shaped) ───────

/** The ledger's filename, hidden inside attachments/ so listings and walks skip it. */
export const UPLOAD_LEDGER_FILENAME = ".openbot-uploads.json";

/** filename → uploaded bytes. Absent/corrupt reads degrade to empty, never block an upload. */
export type UploadLedger = Record<string, number>;

function ledgerPath(directory: string, attachmentsDir: string): string {
  return `${directory}/${attachmentsDir}/${UPLOAD_LEDGER_FILENAME}`;
}

async function readLedger(
  fileApi: AgentSandboxFileApi,
  directory: string,
  attachmentsDir: string,
): Promise<UploadLedger> {
  const raw = await fileApi
    .readFile(ledgerPath(directory, attachmentsDir))
    .catch(() => null);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ledger: UploadLedger = {};
    for (const [name, bytes] of Object.entries(parsed)) {
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
        ledger[name] = bytes;
      }
    }
    return ledger;
  } catch {
    return {};
  }
}

async function writeLedger(
  fileApi: AgentSandboxFileApi,
  directory: string,
  attachmentsDir: string,
  ledger: UploadLedger,
): Promise<void> {
  await fileApi.writeFile(
    ledgerPath(directory, attachmentsDir),
    JSON.stringify(ledger, null, 2),
  );
}

const basename = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1) ?? "";

/**
 * The session's current upload usage: file count from the live listing (every non-hidden file,
 * agent-authored ones included — onyx's `find -maxdepth 1 -type f`), total bytes from the
 * ledger, counting only files the listing still sees (a stale ledger entry cannot inflate the
 * limit after its file is gone by any path). The non-hidden names ride along so the caller can
 * resolve upload collisions from the same listing, not a second round-trip.
 */
export async function getUploadStats(
  fileApi: AgentSandboxFileApi,
  directory: string,
  attachmentsDir: string,
): Promise<{ fileCount: number; totalBytes: number; names: Set<string> }> {
  const listing = await fileApi
    .listFiles(`${directory}/${attachmentsDir}`)
    .catch(() => [] as string[]);
  const names = new Set(
    listing.map(basename).filter((name) => name && !name.startsWith(".")),
  );
  const ledger = await readLedger(fileApi, directory, attachmentsDir);
  let totalBytes = 0;
  for (const [name, bytes] of Object.entries(ledger)) {
    if (names.has(name)) totalBytes += bytes;
  }
  return { fileCount: names.size, totalBytes, names };
}

/** Record a completed upload in the ledger (idempotent overwrite by filename). */
export async function recordUpload(
  fileApi: AgentSandboxFileApi,
  directory: string,
  attachmentsDir: string,
  filename: string,
  sizeBytes: number,
): Promise<void> {
  const ledger = await readLedger(fileApi, directory, attachmentsDir);
  ledger[filename] = sizeBytes;
  await writeLedger(fileApi, directory, attachmentsDir, ledger);
}

/** Drop a deleted file from the ledger, if it was ever recorded. */
export async function forgetUpload(
  fileApi: AgentSandboxFileApi,
  directory: string,
  attachmentsDir: string,
  filename: string,
): Promise<void> {
  const ledger = await readLedger(fileApi, directory, attachmentsDir);
  if (!(filename in ledger)) return;
  delete ledger[filename];
  await writeLedger(fileApi, directory, attachmentsDir, ledger);
}

/**
 * The upload channel overwrites, so a name collision is resolved before the write with onyx's
 * deterministic `stem_N.ext` scheme (the shell loop in onyx's sandbox managers). Exhausting the
 * first thousand suffixes falls back to a millisecond stamp rather than clobbering.
 */
export function collisionFreeName(
  existing: ReadonlySet<string>,
  desired: string,
): string {
  if (!existing.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const ext = dot > 0 ? desired.slice(dot) : "";
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  for (let i = 1; i <= 1000; i += 1) {
    const candidate = `${stem}_${i}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}${ext}`;
}
