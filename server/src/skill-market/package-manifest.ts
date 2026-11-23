import { createHash } from "node:crypto";

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byPath(
  { path: left }: { path: string },
  { path: right }: { path: string },
) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function manifestFingerprint(
  files: readonly { path: string; sha256: string }[],
) {
  const entries = [...files].sort(byPath);
  return `sha256:${sha256(entries.map((file) => `${file.path}:${file.sha256}\n`).join(""))}`;
}

export function packageManifest(files: ReadonlyMap<string, Uint8Array>) {
  const entries = [...files]
    .map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    }))
    .sort(byPath);
  return { files: entries, fingerprint: manifestFingerprint(entries) };
}
