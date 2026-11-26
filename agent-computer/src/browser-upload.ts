import type { Page } from "playwright";
import type { z } from "zod";
import {
  BROWSER_UPLOAD_LIMIT,
  type BrowserUploadResult,
  type browserUploadDispatch,
  browserUploadResult,
  unknownBrowserUpload,
} from "../../shared/browser-upload";

type Upload = z.output<typeof browserUploadDispatch>;

export async function uploadFromBrowser(
  page: Page,
  { content, field, name, url }: Upload,
  maySend: () => boolean,
): Promise<BrowserUploadResult> {
  const origin = new URL(url).origin;
  if (Buffer.from(content, "base64").length > BROWSER_UPLOAD_LIMIT)
    return { status: "not_sent", reason: "The file is too large." };
  if (new URL(page.url()).origin !== origin)
    return {
      status: "not_sent",
      reason: "The browser is no longer on the approved site.",
    };

  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send(
      "Page.createIsolatedWorld",
      {
        frameId: frameTree.frame.id,
        worldName: "openbot-browser-upload",
      },
    );
    if (!maySend())
      return {
        status: "not_sent",
        reason: "Browser control changed before the upload.",
      };
    const expression = `
      (async ({ url, field, name, content }, origin) => {
        if (globalThis.origin !== origin)
          return { status: "not_sent", reason: "The browser is no longer on the approved site." };
        const form = new FormData();
        const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
        form.append(field, new Blob([bytes], { type: "application/octet-stream" }), name);
        const response = await fetch(url, {
          method: "POST",
          body: form,
          mode: "same-origin",
          credentials: "same-origin",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        });
        void response.body?.cancel().catch(() => {});
        return { status: "accepted", httpStatus: response.status };
      })(${JSON.stringify({ content, field, name, url })}, ${JSON.stringify(origin)})
    `;
    const evaluation = await session.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = browserUploadResult.safeParse(evaluation.result.value);
    // A network error, redirect or non-success response can follow successful receipt.
    return result.success ? result.data : unknownBrowserUpload();
  } catch {
    return unknownBrowserUpload();
  } finally {
    await session.detach().catch(() => {});
  }
}
