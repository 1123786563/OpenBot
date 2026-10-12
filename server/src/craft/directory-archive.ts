/**
 * Directory download — the port of onyx `manager.download_directory` (a recursive workspace
 * walk packed as an archive), expressed against OpenBot's sandbox channel: the gateway lists
 * and reads files one HTTP call at a time, so the archive is assembled in-process.
 *
 * FORMAT (restored to onyx parity in T5, per fixtures/zip-download.md F6 + onyx-contract §2.8
 * ruling C6): onyx answers `application/zip` — deflate, file entries only (`_zip_files`,
 * manager.py:1273-1290) — and OpenBot now answers the same, via the zero-dependency ZIP
 * writer in zip-archive.ts. The tar.gz this route used to serve was a port-phase stand-in.
 */

import type { AgentSandboxFileApi } from "./sandbox-gateway";
import { zipEntries } from "./zip-archive";

/**
 * Hidden directories/files to filter from listings — onyx `manager.py:141-153`, verbatim:
 * the workspace's own managed droppings plus the build trees a scaffolded webapp grows.
 */
export const HIDDEN_PATTERNS = new Set([
  ".venv",
  ".git",
  ".next",
  "__pycache__",
  "node_modules",
  ".DS_Store",
  "opencode.json",
  ".env",
  ".gitignore",
  "nextjs.log",
  "nextjs.pid",
]);

/** onyx `_is_hidden_workspace_entry` (manager.py:166-167): a pattern hit or any dot name. */
export function isHiddenWorkspaceEntry(name: string): boolean {
  return HIDDEN_PATTERNS.has(name) || name.startsWith(".");
}

/**
 * The same verdict over a whole path — onyx prunes a hidden directory's subtree whole
 * (`_walk_sandbox_dir` never recurses into one), and over the gateway's flat recursive
 * listing that is exactly "no segment may be hidden". The files listing (artifacts.ts)
 * filters with the same predicate, so the file tree UI and the archive can never
 * disagree about what exists (fixture F6 §C).
 */
export function isHiddenWorkspacePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment.length > 0 && isHiddenWorkspaceEntry(segment));
}

/**
 * Walk one session-workspace directory through the gateway's listing and pack its files as a
 * ZIP. Hidden entries are skipped (onyx's `_walk_sandbox_dir` + `_is_hidden_workspace_entry`
 * — which also keeps the upload ledger out of downloads), unreadable files are skipped
 * rather than failing the whole download (onyx's `_zip_files` does the same), and the
 * arcnames are relative to the requested directory exactly as onyx's `arcname_for` strip.
 *
 * A listing that THROWS propagates — an unreachable directory is the caller's 404, not an
 * empty archive that would read as "this directory exists and holds nothing".
 */
export async function packDirectoryZip(
  fileApi: AgentSandboxFileApi,
  fullPath: string,
): Promise<Uint8Array> {
  const anchor = fullPath.endsWith("/") ? fullPath : `${fullPath}/`;
  const listing = await fileApi.listFiles(fullPath);
  const entries: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of listing) {
    if (!entry.startsWith(anchor)) continue;
    const rel = entry.slice(anchor.length);
    if (!rel || isHiddenWorkspacePath(rel)) continue;
    const bytes = await fileApi.readFileBytes(entry).catch(() => null);
    if (bytes === null) continue; // unreadable: skipped, not fatal (onyx parity)
    entries.push({ path: rel, bytes });
  }
  return zipEntries(entries);
}
