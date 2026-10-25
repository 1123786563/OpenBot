/**
 * Directory download — the port of onyx `manager.download_directory` (a recursive workspace
 * walk packed as an archive), expressed against OpenBot's sandbox channel: the gateway lists
 * and reads files one HTTP call at a time, so the archive is assembled in-process.
 *
 * FORMAT (restored to onyx parity in T5, per fixtures/zip-download.md F6 + onyx-contract §2.8
 * ruling C6): onyx answers `application/zip` — deflate, file entries only (`_zip_files`,
 * manager.py:1273-1290) — and OpenBot now answers the same, via the zero-dependency ZIP
 * writer in zip-archive.ts. The tar.gz this route used to serve was a port-phase stand-in.
 *
 * WALK (finding F-C): the gateway's listing is FLAT — one level per call (a directory's
 * immediate children as full paths, subdirectories among them) — so the recursion onyx got
 * from a pod-side `os.walk` is rebuilt here as repeated listFiles calls: files are read,
 * unreadable-as-file entries are walked as directories. A single flat listing used to
 * answer a 200 with a zero-entry ZIP whenever the requested directory's top level held
 * only subdirectories — nested files silently dropped.
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
 * (`_walk_sandbox_dir` never recurses into one), and over a workspace path that is
 * exactly "no segment may be hidden". The files listing (artifacts.ts) filters with the
 * same predicate, so the file tree UI and the archive can never disagree about what
 * exists (fixture F6 §C).
 */
export function isHiddenWorkspacePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => segment.length > 0 && isHiddenWorkspaceEntry(segment));
}

/**
 * The REQUESTED directory's own listing is unreachable — the one failure callers map to
 * their 404 (onyx's None). Everything the walk meets below the root is contained: a
 * subdirectory that vanishes mid-walk or refuses to list is skipped, never fatal.
 */
export class WorkspaceListingError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(
      `The workspace listing for ${path} is unreachable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      // Keep the original error as the structured cause (#618 OCR r2): the scope
      // refusal the craft routes must recognize survives any rewrite of the text
      // above only through this chain, never through the embedded sentence.
      { cause },
    );
    this.name = "WorkspaceListingError";
  }
}

/** One collected workspace file: its path RELATIVE to the walk root (the ZIP arcname). */
export type WorkspaceFileEntry = { path: string; bytes: Uint8Array };

/**
 * The walk's depth ceiling. Real workspace trees sit far shallower; the cap exists for
 * the one thing a flat listing cannot defend against on its own — a symlink loop grows
 * paths without bound, and each longer path is a fresh listing call.
 */
const MAX_WALK_DEPTH = 32;

/**
 * Recursively collect one workspace directory's readable, non-hidden files through the
 * gateway's flat one-level listing — the rebuild of onyx's `_walk_sandbox_dir`.
 *
 * Hidden entries are pruned whole (never recursed into, onyx's cut), unreadable files are
 * skipped rather than failing the walk (onyx's `_zip_files` does the same), and an entry
 * that answers no file bytes is walked as a directory: the flat listing cannot say
 * file-or-dir, and a file that will not read and a directory that will not list both
 * degrade to "nothing here" — exactly onyx's silent skip.
 *
 * Entries are collected depth-first in listing order, so the archive's member order is
 * the fixture's tree order (F6: `report.md` before `web/package.json` before
 * `web/src/app/page.tsx`).
 *
 * @throws WorkspaceListingError when the ROOT directory's own listing is unreachable —
 *   the callers' 404, never an empty archive that would read as "exists and holds nothing".
 */
export async function collectWorkspaceFiles(
  fileApi: AgentSandboxFileApi,
  root: string,
): Promise<WorkspaceFileEntry[]> {
  const rootDir = root.replace(/\/+$/, "");
  const anchor = `${rootDir}/`;
  const entries: WorkspaceFileEntry[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    let listing: string[];
    try {
      listing = await fileApi.listFiles(dir);
    } catch (error) {
      if (dir === rootDir) throw new WorkspaceListingError(rootDir, error);
      return; // a subtree that vanished mid-walk: skipped, not fatal (onyx parity)
    }
    for (const raw of listing) {
      const entry = raw.replace(/\/+$/, ""); // a directory entry may carry its slash
      if (!entry.startsWith(anchor)) continue; // containment: the anchor-prefix discipline
      const rel = entry.slice(anchor.length);
      if (!rel || rel.startsWith("/")) continue;
      // The same segment verdicts safeJoin holds: no dot-dot climbs, no empty or
      // current segments smuggled in by a listing that disagrees with its query.
      if (
        rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
      )
        continue;
      if (isHiddenWorkspacePath(rel)) continue; // hidden subtree pruned whole
      const bytes = await fileApi.readFileBytes(entry).catch(() => null);
      if (bytes !== null) {
        entries.push({ path: rel, bytes });
        continue;
      }
      // No file bytes: a directory (or an unreadable file — skipped either way).
      if (depth + 1 < MAX_WALK_DEPTH) await walk(entry, depth + 1);
    }
  };

  await walk(rootDir, 0);
  return entries;
}

/**
 * Walk one session-workspace directory through the gateway's listing and pack its files as a
 * ZIP — `collectWorkspaceFiles` plus the onyx-pinned writer. See the walk's contract for
 * the failure shape: only an unreachable ROOT listing throws (the caller's 404).
 */
export async function packDirectoryZip(
  fileApi: AgentSandboxFileApi,
  fullPath: string,
): Promise<Uint8Array> {
  return zipEntries(await collectWorkspaceFiles(fileApi, fullPath));
}
