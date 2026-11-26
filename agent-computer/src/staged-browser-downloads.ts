import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Download, Page } from "playwright";
import {
  BROWSER_DOWNLOAD_ID,
  BROWSER_DOWNLOAD_LIMIT,
} from "../../shared/browser-download";
import { profileDirectoryFor } from "./bot-id";

type Capture = { status: "ready"; id: string } | { status: "failed" };
const RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPLETION_MS = 12_000;
const EVENT_GRACE_MS = 250;

export function stageBrowserDownloads(profileRoot: string) {
  const directoryFor = (botId: string) =>
    join(profileDirectoryFor(profileRoot, botId), ".openbot-downloads");

  async function stage(
    botId: string,
    download: Download,
    caller: AbortSignal,
  ): Promise<Capture> {
    const signal = AbortSignal.any([
      caller,
      AbortSignal.timeout(COMPLETION_MS),
    ]);
    const interrupted = Promise.withResolvers<never>();
    const cancel = () => {
      interrupted.reject(signal.reason);
      void download.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      // path() waits for a successful completion and rejects on browser failure/cancellation.
      const file = await Promise.race([download.path(), interrupted.promise]);
      signal.throwIfAborted();
      if ((await stat(file)).size > BROWSER_DOWNLOAD_LIMIT)
        return { status: "failed" };
      const directory = directoryFor(botId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const oldest = Date.now() - RETENTION_MS;
      for (const name of await readdir(directory)) {
        const previous = join(directory, name);
        const info = await stat(previous).catch(() => undefined);
        if (info && info.mtimeMs < oldest) await rm(previous, { force: true });
      }

      const id = crypto.randomUUID();
      const temporary = join(directory, `${id}.tmp`);
      try {
        await copyFile(file, temporary, constants.COPYFILE_EXCL);
        signal.throwIfAborted();
        await rename(temporary, join(directory, id));
      } finally {
        await rm(temporary, { force: true });
      }
      return { status: "ready", id };
    } catch {
      return { status: "failed" };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  return {
    async read(botId: string, id: string): Promise<Response> {
      if (BROWSER_DOWNLOAD_ID.test(id)) {
        const path = join(directoryFor(botId), id);
        const info = await stat(path).catch(() => undefined);
        if (
          info?.isFile() &&
          info.mtimeMs >= Date.now() - RETENTION_MS &&
          info.size <= BROWSER_DOWNLOAD_LIMIT
        ) {
          return new Response(Bun.file(path), {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(info.size),
              "cache-control": "no-store",
            },
          });
        }
      }
      return Response.json(
        { error: "Browser download not found." },
        { status: 404 },
      );
    },

    // The dispatcher holds the page turn and keeps human input out for the whole
    // action. Only downloads emitted by this page during that turn are candidates.
    async capture<T>(options: {
      botId: string;
      page: Page;
      kind: "navigation" | "gesture";
      signal: AbortSignal;
      run: () => Promise<T>;
    }): Promise<
      { result: T; browserDownload?: Capture } | { browserDownload: Capture }
    > {
      let first: Download | undefined;
      let multiple = false;
      const listen = (download: Download) => {
        if (first) multiple = true;
        else first = download;
      };
      options.page.on("download", listen);
      let action: { result: T } | undefined;
      try {
        try {
          action = { result: await options.run() };
        } catch (error) {
          if (
            options.kind !== "navigation" ||
            !(error instanceof Error) ||
            !error.message.includes("Download is starting")
          )
            throw error;
        }
        if (action && options.kind === "navigation") return action;
        // Chromium may report an attachment just after the action reply.
        if (!first || options.kind === "gesture")
          await Bun.sleep(EVENT_GRACE_MS);
      } finally {
        options.page.off("download", listen);
      }

      if (action && !first) return action;
      const browserDownload =
        first && !multiple
          ? await stage(options.botId, first, options.signal)
          : ({ status: "failed" } satisfies Capture);
      return { ...action, browserDownload };
    },
  };
}
