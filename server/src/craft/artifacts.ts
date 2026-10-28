/**
 * Artifact + file walking for craft sessions — the phase-2 port of onyx
 * `session/manager.py` `list_artifacts` / `list_directory` / `_walk_sandbox_dir`,
 * minus the container `ls -la`.
 *
 * onyx ran `ls -la --time-style=+%s` inside a pod and parsed per-entry
 * size/mtime/is-directory. The agent-sandbox gateway's only listing verb is
 * opencode's own `GET /file?path=…`, which the gateway normalizes to bare path
 * strings (see sandbox-gateway.ts listFiles). A bare path cannot answer size or
 * mtime, so those fields carry honest defaults (`sizeBytes: 0`, `updatedAt: ""`)
 * and directory-ness is inferred from path prefixes. This trades metadata the
 * phase-2 acceptance (V1–V3) does not need for zero new sandbox surface.
 */

import { type ArtifactType, artifactTypeFor } from "../workshop/artifacts";
import { isHiddenWorkspacePath } from "./directory-archive";
import type { AgentSandboxFileApi } from "./sandbox-gateway";

export type FileEntry = {
  /** Relative to the session directory (e.g. "outputs/report.html"). */
  path: string;
  name: string;
  kind: "file" | "dir";
  sizeBytes: number;
  /** ISO 8601; "" when the gateway's listing cannot answer it. */
  updatedAt: string;
};

export type ArtifactEntry = FileEntry & {
  type: ArtifactType;
};

const basename = (path: string): string => {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
};

/** Strip a directory anchor prefix (with or without a trailing slash) from a path. */
function stripAnchor(path: string, anchor: string): string {
  if (anchor === "") return path;
  const prefix = anchor.endsWith("/") ? anchor : `${anchor}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * onyx's `_is_hidden_workspace_entry` over a whole path (see directory-archive.ts) — the
 * SAME predicate the download archives filter with (fixture F6 §C), so the Files tab and
 * a downloaded ZIP can never disagree about what exists.
 */
const isHiddenOrTemp = isHiddenWorkspacePath;

/**
 * Read a workspace file's text, or null when absent/non-text — the phase-2
 * replacement for the manager's stub. Backed by the gateway's `/file/content`.
 */
export async function readWorkspaceFile(
  _botId: string,
  path: string,
  fileApi: AgentSandboxFileApi,
): Promise<string | null> {
  return fileApi.readFile(path);
}

/**
 * Scan `outputs/` for artifacts, classifying each by its gallery type. The
 * gateway lists workspace-rooted paths; each is made session-relative and the
 * hidden/temp entries (dotfiles, emacs droppings, the pptx-preview cache) are
 * dropped, mirroring onyx's `_is_hidden_workspace_entry` filter.
 */
export async function listArtifacts(
  _botId: string,
  directory: string,
  fileApi: AgentSandboxFileApi,
): Promise<ArtifactEntry[]> {
  const raw = await fileApi.listFiles(`${directory}/outputs`).catch(() => []);
  const seen = new Set<string>();
  const artifacts: ArtifactEntry[] = [];
  for (const item of raw) {
    const rel = stripAnchor(item, directory);
    if (!rel || rel.startsWith("/")) continue;
    if (isHiddenOrTemp(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    artifacts.push({
      path: rel,
      name: basename(rel),
      kind: "file",
      sizeBytes: 0,
      updatedAt: "",
      type: artifactTypeFor(rel),
    });
  }
  return artifacts;
}

/** List one directory's immediate children (directories first, then files). */
export async function listFiles(
  _botId: string,
  directory: string,
  relPath: string,
  fileApi: AgentSandboxFileApi,
): Promise<FileEntry[]> {
  const anchor = relPath ? `${directory}/${relPath}` : directory;
  const raw = await fileApi.listFiles(anchor).catch(() => []);
  const dirs = new Map<string, FileEntry>();
  const files = new Map<string, FileEntry>();

  for (const item of raw) {
    const rel = stripAnchor(item, directory);
    if (!rel || rel.startsWith("/")) continue;
    if (isHiddenOrTemp(rel)) continue;

    // The entry's position under the requested directory; a path that still
    // carries a "/" after this level names a descendant, so the first segment
    // is a directory.
    const base = relPath.replace(/^\/+|\/+$/g, "");
    // An entry that is not under the requested subtree (a sibling, or the directory
    // itself) is not a child of it: folding it into `rest` would invent a childPath
    // that reads back 404, so it is skipped.
    if (base !== "" && (rel === base || !rel.startsWith(`${base}/`))) continue;
    const rest = base === "" ? rel : rel.slice(base.length + 1);
    const name = rest.split("/")[0];
    if (!name || name === "") continue;
    const childPath = base === "" ? name : `${base}/${name}`;

    if (rest.includes("/")) {
      if (!dirs.has(childPath)) {
        dirs.set(childPath, {
          path: childPath,
          name,
          kind: "dir",
          sizeBytes: 0,
          updatedAt: "",
        });
      }
    } else if (!files.has(childPath)) {
      files.set(childPath, {
        path: childPath,
        name,
        kind: "file",
        sizeBytes: 0,
        updatedAt: "",
      });
    }
  }

  return [...dirs.values(), ...files.values()];
}
