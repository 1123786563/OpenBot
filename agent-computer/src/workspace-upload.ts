import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { BROWSER_UPLOAD_LIMIT } from "../../shared/browser-upload";
import type { Workspace } from "./workspace";

export async function snapshotWorkspaceUpload(
  workspace: Pick<Workspace, "resolvePath">,
  root: string,
  path: string,
  includeContent = false,
) {
  const full = await workspace.resolvePath(path, false);
  if (full !== join(await realpath(root), path))
    throw new Error("Select the workspace file itself.");
  // A workspace writer could swap a directory for a symlink between resolution and open.
  // The process holds this descriptor until it has captured the bytes and identity.
  const handle = await open(
    full,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const descriptor = `/proc/self/fd/${handle.fd}`;
    if ((await readlink(descriptor)) !== full)
      throw new Error("The file moved before it could be opened.");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BROWSER_UPLOAD_LIMIT)
      throw new Error("Select one regular workspace file up to 4 MiB.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      length !== Number(before.size) ||
      before.ctimeNs !== after.ctimeNs ||
      (await readlink(descriptor)) !== full ||
      (await workspace.resolvePath(path, false)) !== full
    )
      throw new Error("The file changed while it was being read.");
    const content = bytes.subarray(0, length);
    return {
      identity: `${before.dev}:${before.ino}:${before.ctimeNs}`,
      sha256: createHash("sha256").update(content).digest("hex"),
      ...(includeContent ? { content: content.toString("base64") } : {}),
    };
  } finally {
    await handle.close();
  }
}
