/**
 * Directory download — the port of onyx `manager.download_directory` (a recursive workspace
 * walk packed as an archive), expressed against OpenBot's sandbox channel: the gateway lists
 * and reads files one HTTP call at a time, so the archive is assembled in-process.
 *
 * FORMAT (deliberate, recorded in the port docs): onyx answers `application/zip`; OpenBot
 * answers `application/gzip` (tar.gz) — the same in-process ustar+gzip writer the existing
 * `webapp-download` endpoint established (`tarGzip` in webapp-proxy.ts), per the port plan's
 * no-new-dependencies rule. One download format across the file surface, not two.
 */

import type { AgentSandboxFileApi } from "./sandbox-gateway";
import { tarGzip } from "./webapp-proxy";

const basename = (path: string): string =>
  path
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1) ?? "";

/** A safe archive stem for the download's filename (onyx's `_sanitize_zip_basename` cut down). */
export function archiveBasename(path: string): string {
  const raw = basename(path) || "directory";
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[.\s]+/, "");
  return safe || "directory";
}

/**
 * Walk one session-workspace directory through the gateway's listing and pack its files as a
 * tar.gz. Hidden entries are skipped (onyx's `_is_hidden_workspace_entry` — which also keeps the
 * upload ledger out of downloads), unreadable files are skipped rather than failing the whole
 * download (onyx's `_zip_files` does the same), and the arcnames are relative to the requested
 * directory exactly as onyx's `arcname_for` strip.
 *
 * A listing that THROWS propagates — an unreachable directory is the caller's 404, not an
 * empty archive that would read as "this directory exists and holds nothing".
 */
export async function packDirectoryTarGz(
  fileApi: AgentSandboxFileApi,
  fullPath: string,
): Promise<Uint8Array> {
  const anchor = fullPath.endsWith("/") ? fullPath : `${fullPath}/`;
  const listing = await fileApi.listFiles(fullPath);
  const entries: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of listing) {
    if (!entry.startsWith(anchor)) continue;
    const rel = entry.slice(anchor.length);
    if (!rel || rel.split("/").some((segment) => segment.startsWith(".")))
      continue; // hidden at any depth, or the entry escaped the anchor's shape
    const bytes = await fileApi.readFileBytes(entry).catch(() => null);
    if (bytes === null) continue; // unreadable: skipped, not fatal (onyx parity)
    entries.push({ path: rel, bytes });
  }
  return tarGzip(entries);
}
