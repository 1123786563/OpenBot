import { z } from "zod";

// The pilot bounds both hops independently of the advertised Content-Length.
export const BROWSER_DOWNLOAD_LIMIT = 16 * 1024 * 1024;
export const BROWSER_DOWNLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const manualBrowserDownloads = z.object({
  downloads: z.array(
    z.object({
      id: z.string().regex(BROWSER_DOWNLOAD_ID),
      name: z.string().min(1).max(255),
      bytes: z.number().int().nonnegative(),
      downloadedAt: z.iso.datetime(),
    }),
  ),
});

export type ManualBrowserDownloads = z.infer<typeof manualBrowserDownloads>;

export function browserDownloadPath(id: string): string {
  return `download-${id}`;
}

export type BrowserDownloadResult =
  | { status: "delivered"; id: string; path: string; bytes: number }
  | { status: "failed"; id: string; retryable: true; error: string }
  | { status: "failed"; retryable: false; error: string };

export async function readBrowserDownload(
  body: ReadableStream<Uint8Array>,
  expected: number,
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > BROWSER_DOWNLOAD_LIMIT
  ) {
    await body.cancel().catch(() => undefined);
    throw new Error("Invalid browser download size.");
  }

  const bytes = new Uint8Array(expected);
  let offset = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > expected)
        throw new Error("Browser download exceeded its declared size.");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== expected)
      throw new Error("Browser download was incomplete.");
    return bytes.buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
