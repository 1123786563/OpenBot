import { posix } from "node:path";
import type { ComputerNames } from "./names";

export type WorkspaceStorage = { root: string; bytes: number };

export function workspaceStorageConfig(
  root: string | undefined,
  bytes: string | undefined,
): WorkspaceStorage | undefined {
  const limit = Number(bytes);
  if (
    !root ||
    !posix.isAbsolute(root) ||
    posix.resolve(root) === "/" ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  )
    return undefined;
  return { root: posix.resolve(root), bytes: limit };
}

// The mount is examined inside the Docker engine's filesystem view. Require the
// root of a dedicated ext4 filesystem, with its identity outside both writable
// directories. Reject nested mounts, even when they have the same device number.
export const workspaceStorageProbe = `
awk '
  $5 == "/storage" {
    for (i = 7; i <= NF; i++)
      if ($i == "-") {
        if ($4 == "/" && $(i+1) == "ext4" && $(i+3) ~ /^rw(,|$)/) roots++
        break
      }
  }
  $5 ~ /^\\/storage\\// { nested++ }
  END { exit !(roots == 1 && !nested) }
' /proc/self/mountinfo
test -f /storage/.openbot-workspace
test ! -L /storage/.openbot-workspace
test "$(cat /storage/.openbot-workspace)" = "$1"
for path in /storage/workspace /storage/profiles; do
  test -d "$path"
  test ! -L "$path"
done
stat -f -c '%S %b %f' /storage
`;

export function workspaceStoragePath(
  names: ComputerNames,
  storage: WorkspaceStorage,
) {
  return posix.join(storage.root, names.workspaceVolume);
}

export function parseWorkspaceStorageUsage(output: string, limit: number) {
  const fields = output.trim().split(/\s+/);
  if (fields.length !== 3 || fields.some((field) => !/^\d+$/.test(field)))
    return null;
  const [blockSize, blocks, freeBlocks] = fields.map(Number);
  const capacity = blockSize * blocks;
  const used = blockSize * (blocks - freeBlocks);
  if (
    !Number.isSafeInteger(capacity) ||
    capacity <= 0 ||
    capacity > limit ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    used > capacity
  )
    return null;
  return { used, capacity };
}
