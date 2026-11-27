import { constants } from "node:fs";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_DOWNLOAD_ID,
  browserDownloadPath,
  readBrowserDownload,
} from "../../shared/browser-download";

// The execution service owns a single workspace. The recipient takes only an opaque
// id and bytes, so a browser filename can never select or overwrite a workspace path.
export async function receiveBrowserDownload(request: Request, root: string) {
  const prefix = "/files/browser-downloads/";
  const path = new URL(request.url).pathname;
  if (request.method !== "PUT" || !path.startsWith(prefix)) return;
  const id = path.slice(prefix.length);
  if (!BROWSER_DOWNLOAD_ID.test(id))
    return Response.json(
      { error: "Unknown browser download." },
      { status: 404 },
    );
  const length = request.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length))
    return Response.json(
      { error: "A sized browser download is required." },
      { status: 400 },
    );

  let bytes: Buffer;
  try {
    if (request.body) {
      bytes = Buffer.from(
        await readBrowserDownload(request.body, Number(length)),
      );
    } else {
      if (Number(length) !== 0)
        throw new Error("Missing browser download body.");
      bytes = Buffer.alloc(0);
    }
  } catch {
    return Response.json(
      { error: "Invalid browser download body." },
      { status: 400 },
    );
  }

  const name = browserDownloadPath(id);
  const destination = join(root, name);
  try {
    await mkdir(root, { recursive: true });
    const temporary = join(
      root,
      `.browser-download-${crypto.randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        // Publish the whole file in one operation, with no overwrite. Concurrent
        // retries and retries after a lost response converge on the same path.
        await link(temporary, destination);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
        const existing = await open(
          destination,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = await existing.stat();
          const contents = Buffer.alloc(bytes.length);
          let offset = 0;
          if (info.isFile() && info.size === bytes.length) {
            while (offset < contents.length) {
              const { bytesRead } = await existing.read(
                contents,
                offset,
                contents.length - offset,
                offset,
              );
              if (bytesRead === 0) break;
              offset += bytesRead;
            }
          }
          if (
            !info.isFile() ||
            info.size !== bytes.length ||
            offset !== contents.length ||
            !bytes.equals(contents)
          )
            return Response.json(
              { error: "The download path already holds a different file." },
              { status: 409 },
            );
        } finally {
          await existing.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return Response.json({ path: name, bytes: bytes.length });
  } catch {
    return Response.json(
      { error: "The workspace could not save the browser download." },
      { status: 500 },
    );
  }
}
