/**
 * Turning a run's collected files into gallery rows.
 *
 * The gateway remains the one writer of `code_runs` and the one collector of files; this module
 * is the second half of the pipeline — given the artifacts a run produced, decide what each one
 * IS (its gallery type) and write the `workshop_artifacts` rows. Pure classification lives in
 * {@link artifactTypeFor} so tests can drive it without a database.
 */
import { getLogger } from "../../../shared/logger";
import type { SandboxArtifact } from "../codesandbox/types";
import type { WorkshopStore } from "./store";

const log = getLogger("server");

/** The gallery's ceiling for one run: more files are collected by the gateway's own caps, this
 *  keeps a pathological run from flooding the table (and the gallery) with hundreds of rows. */
export const MAX_ARTIFACT_ROWS = 100;

export type ArtifactType =
  | "csv"
  | "chart"
  | "report"
  | "webapp"
  | "file"
  | "dataset";

const EXTENSION_TYPES: Array<{ extensions: string[]; type: ArtifactType }> = [
  { extensions: [".csv", ".tsv"], type: "csv" },
  { extensions: [".png", ".jpg", ".jpeg", ".svg", ".webp"], type: "chart" },
  { extensions: [".md", ".pdf", ".docx", ".txt", ".html"], type: "report" },
  {
    extensions: [".parquet", ".feather", ".h5", ".hdf5", ".npz", ".arrow"],
    type: "dataset",
  },
];

/** Path shapes that name a web app regardless of extension. */
const WEBAPP_SEGMENTS = ["index.html", "package.json", "/vite.config"];

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return "";
  return path.slice(dot).toLowerCase();
}

/**
 * What a produced file is, for the gallery's rendering and filtering.
 *
 * Extension first, because extensions are honest about what a file is; then the webapp shapes,
 * because an app is a directory shape rather than a type; everything else is a plain file. The
 * order is the contract: a `data/index.html` inside an app directory is a webapp, not a report.
 */
export function artifactTypeFor(path: string): ArtifactType {
  const lower = path.toLowerCase();
  // A dependency tree is full of package.json and index.html files that are not this app.
  if (lower.includes("node_modules/")) {
    const extension = extensionOf(lower);
    for (const rule of EXTENSION_TYPES) {
      if (rule.extensions.includes(extension)) return rule.type;
    }
    return "file";
  }
  const isViteConfig = lower
    .split("/")
    .some((segment) => /^vite\.config\.[a-z]+$/.test(segment));
  if (
    isViteConfig ||
    WEBAPP_SEGMENTS.some((segment) => lower.endsWith(`/${segment}`))
  ) {
    return "webapp";
  }
  if (lower === "package.json" || lower === "index.html") return "webapp";
  const extension = extensionOf(lower);
  for (const rule of EXTENSION_TYPES) {
    if (rule.extensions.includes(extension)) return rule.type;
  }
  return "file";
}

/**
 * Normalize a sandbox-produced path to a safe workspace-relative form, or undefined when
 * it is not one: absolute roots, `..` segments, backslashes and control characters never
 * reach a stored row.
 */
function safeArtifactPath(path: string): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the rule's whole point
  const hasControlCharacter = /[\u0000-\u001f\u007f]/.test(path);
  if (path.length === 0 || path.includes("\\") || hasControlCharacter)
    return undefined;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  )
    return undefined;
  return segments.join("/");
}

/** The part of a sandbox path the gallery shows: the file's own name, directories intact. */
export function displayName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

export type IndexArtifactsResult = {
  indexed: number;
  /** Rows the store refused; the gap between this and the cap is where outages hide. */
  failed: number;
  capped: boolean;
};

/**
 * Write one `workshop_artifacts` row per collected file, newest-run-last, capped at
 * {@link MAX_ARTIFACT_ROWS}.
 *
 * Failure here must never fail the run: the run completed, its `code_runs` row is written, and a
 * gallery that missed a row is a degraded view rather than a broken run — so an insert error is
 * swallowed after being counted in the result, not thrown.
 */
export async function indexArtifacts(
  store: WorkshopStore,
  sessionId: string,
  artifacts: SandboxArtifact[],
): Promise<IndexArtifactsResult> {
  const capped = artifacts.slice(0, MAX_ARTIFACT_ROWS);
  let indexed = 0;
  let failed = 0;
  for (const artifact of capped) {
    // A produced path is data, not an address: absolute roots, `..` hops, backslashes and
    // control characters are refused here, so no stored row — and nothing reading rows as
    // paths later — can be walked out of the workspace.
    const path = safeArtifactPath(artifact.path);
    if (!path) {
      failed += 1;
      log.warn(
        {
          type: "workshop-artifact-insert-failed",
          sessionId,
          path: artifact.path,
          error: "path is not a safe workspace-relative path",
        },
        "workshop-artifact-insert-failed",
      );
      continue;
    }
    try {
      await store.insertArtifact({
        sessionId,
        type: artifactTypeFor(path),
        name: displayName(path),
        path,
        sizeBytes: artifact.size,
        visibility: "private",
      });
      indexed += 1;
    } catch (error) {
      // Counted, not thrown — and named: `indexed` short of the cap was the only trace a
      // persistent insert failure left, which no operator could tell from "no artifacts".
      failed += 1;
      log.warn(
        {
          type: "workshop-artifact-insert-failed",
          sessionId,
          path: artifact.path,
          error: error instanceof Error ? error.message : String(error),
        },
        "workshop-artifact-insert-failed",
      );
    }
  }
  return { indexed, failed, capped: artifacts.length > capped.length };
}
