import { constants } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Download, Page } from "playwright";
import {
  BROWSER_DOWNLOAD_ID,
  BROWSER_DOWNLOAD_LIMIT,
  manualBrowserDownloads,
} from "../../shared/browser-download";

// This directory belongs to the CubeSandbox owner and survives browser profile resets.
export function storeManualBrowserDownloads(profileRoot: string) {
  const root = join(profileRoot, ".manual-downloads");

  async function save(download: Download) {
    const source = await download.path();

    const id = crypto.randomUUID();
    const temporary = join(root, `${id}.tmp`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      await copyFile(source, join(temporary, "file"), constants.COPYFILE_EXCL);
      await Bun.write(
        join(temporary, "name.json"),
        JSON.stringify(
          download.suggestedFilename().slice(0, 255) || "Download",
        ),
      );
      await rename(temporary, join(root, id));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function fileInfo(id: string) {
    if (!BROWSER_DOWNLOAD_ID.test(id)) return;
    const path = join(root, id, "file");
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile())
      return { path, bytes: info.size, downloadedAt: info.mtime.toISOString() };
  }

  return {
    watch(page: Page) {
      page.on("download", (download) => {
        void save(download).catch(() => {
          console.warn(
            JSON.stringify({ type: "computer-manual-download-failed" }),
          );
        });
      });
    },
    async list(): Promise<Response> {
      const entries = await readdir(root).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return [];
        throw error;
      });
      const completed = await Promise.all(
        entries.map(async (id) => {
          const info = await fileInfo(id);
          if (!info) return;
          const name: unknown = await Bun.file(
            join(root, id, "name.json"),
          ).json();
          return {
            id,
            name,
            bytes: info.bytes,
            downloadedAt: info.downloadedAt,
          };
        }),
      );
      const { downloads } = manualBrowserDownloads.parse({
        downloads: completed.filter((file) => file !== undefined),
      });
      downloads.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
      return Response.json(
        { downloads },
        { headers: { "cache-control": "no-store" } },
      );
    },
    async read(id: string): Promise<Response> {
      const info = await fileInfo(id);
      if (!info)
        return Response.json(
          { error: "Browser download not found." },
          { status: 404 },
        );
      if (info.bytes > BROWSER_DOWNLOAD_LIMIT)
        return Response.json(
          { error: "This download exceeds the delivery size limit." },
          { status: 413 },
        );
      return new Response(Bun.file(info.path), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(info.bytes),
          "cache-control": "no-store",
        },
      });
    },
  };
}
