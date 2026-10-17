/**
 * Turning a run's collected files into gallery rows.
 *
 * The gateway remains the one writer of `code_runs` and the one collector of files; this module
 * is the second half of the pipeline — given the artifacts a run produced, decide what each one
 * IS (its gallery type) and write the `workshop_artifacts` rows. Pure classification lives in
 * {@link artifactTypeFor} so tests can drive it without a database.
 */
import type { SandboxArtifact } from "../codesandbox/types";
import type { WorkshopStore } from "./store";

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
const WEBAPP_SEGMENTS = ["index.html", "package.json", "vite.config"];

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
  if (WEBAPP_SEGMENTS.some((segment) => lower.endsWith(`/${segment}`))) {
    return "webapp";
  }
  if (lower === "package.json" || lower === "index.html") return "webapp";
  const extension = extensionOf(lower);
  for (const rule of EXTENSION_TYPES) {
    if (rule.extensions.includes(extension)) return rule.type;
  }
  return "file";
}

/** The part of a sandbox path the gallery shows: the file's own name, directories intact. */
export function displayName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

export type IndexArtifactsResult = {
  indexed: number;
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
  for (const artifact of capped) {
    try {
      await store.insertArtifact({
        sessionId,
        type: artifactTypeFor(artifact.path),
        name: displayName(artifact.path),
        path: artifact.path,
        sizeBytes: artifact.size,
        visibility: "private",
      });
      indexed += 1;
    } catch {
      // Counted, not thrown: see the docblock.
    }
  }
  return { indexed, capped: artifacts.length > capped.length };
}
