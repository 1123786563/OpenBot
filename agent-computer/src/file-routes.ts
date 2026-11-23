import { downloadHeaders } from "../../shared/file-download";
import {
  type Workspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "./workspace";

export async function handleFileRequest(
  request: Request,
  url: URL,
  workspace: () => Promise<Workspace>,
): Promise<Response | undefined> {
  if (url.pathname === "/files/download" && request.method === "GET") {
    try {
      const files = await workspace();
      const file = await files.download(url.searchParams.get("path") ?? "");
      return new Response(file.body, {
        headers: downloadHeaders(file.name, file.bytes),
      });
    } catch (error) {
      return json(
        { error: describe(error, "The file could not be downloaded.") },
        fileStatus(error),
      );
    }
  }
  if (url.pathname === "/files/read" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      path?: unknown;
    } | null;
    try {
      const files = await workspace();
      return json(await files.read(String(body?.path ?? "")));
    } catch (error) {
      return json(
        { error: describe(error, "The file could not be read.") },
        fileStatus(error),
      );
    }
  }
  if (url.pathname === "/files/list" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      path?: unknown;
    } | null;
    try {
      const files = await workspace();
      return json(
        await files.list(
          typeof body?.path === "string" ? body.path : undefined,
        ),
      );
    } catch (error) {
      return json(
        { error: describe(error, "The folder could not be listed.") },
        fileStatus(error),
      );
    }
  }
  if (url.pathname === "/files/write" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      path?: unknown;
      contents?: unknown;
      append?: unknown;
    } | null;
    if (typeof body?.contents !== "string") {
      return json({ error: "The contents to write are required." }, 400);
    }
    try {
      const files = await workspace();
      return json(
        await files.write(String(body?.path ?? ""), body.contents, {
          append: body.append === true,
        }),
      );
    } catch (error) {
      return json(
        { error: describe(error, "The file could not be written.") },
        fileStatus(error),
      );
    }
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing download is 404, an oversized
 * download is 413, and an ordinary bad file request is 400, because a different request could
 * succeed. Collapsing these into 500 would tell the caller the computer is broken and invite a retry
 * of the same request.
 */
function fileStatus(error: unknown): 400 | 403 | 404 | 413 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileTooLargeError) return 413;
  if (error instanceof WorkspaceFileNotFoundError) return 404;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}
