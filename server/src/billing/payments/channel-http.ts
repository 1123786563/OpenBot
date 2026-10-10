/**
 * The one HTTP client both payment channels ride on, and the discipline it enforces.
 *
 * Inherited wholesale from the Lago client (../lago.ts), for the same reasons: `fetch` is
 * injectable so a test never opens a socket; `assertTarget` is required, so no assembly can build
 * a client that skips the outbound gate (../outbound.ts); every request goes out with
 * `redirect: "error"` and an abort timeout; the response is read with a 1 MiB cap; and every
 * failure maps to the billing seam's sentinels — transport errors, timeouts, refused redirects,
 * 429 and 5xx become the retryable `unreachable`, a status no caller was written to understand
 * becomes the terminal `invalid_response`. Error messages are built from the code alone, so no
 * URL, status line or credential reaches a log through this layer.
 */
import { BillingError } from "../types";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type ChannelHttpConfig = {
  /** Test seam; production uses the runtime's global fetch. */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /** The SSRF gate, run against every request URL immediately before it is opened. Required. */
  assertTarget: (url: URL) => Promise<void>;
};

/**
 * POST one form-encoded body, answer the raw text. Alipay's only shape: everything it speaks is a
 * form in and an envelope out.
 */
export async function postForm(
  config: ChannelHttpConfig,
  url: URL,
  body: string,
): Promise<string> {
  await config.assertTarget(url);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
  } catch {
    throw new BillingError("unreachable");
  }
  return (await readVerifiedResponse(response)).text;
}

/**
 * POST one JSON body with the given authorization header, answer the raw text. WeChat v3's only
 * shape.
 */
export async function postJson(
  config: ChannelHttpConfig,
  url: URL,
  authorization: string,
  body: string,
): Promise<string> {
  await config.assertTarget(url);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization,
      },
      body,
    });
  } catch {
    throw new BillingError("unreachable");
  }
  return (await readVerifiedResponse(response)).text;
}

/**
 * The status gate and capped read every channel response passes through. 404 is handed back to
 * the caller (a query that misses is a fact, not an error); every other unexpected status is
 * classified here.
 */
async function readVerifiedResponse(
  response: Response,
): Promise<{ status: number; text: string }> {
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    throw new BillingError("unreachable");
  }
  if (response.status >= 300 && response.status < 400) {
    // `redirect: "error"` already refuses these in a real fetch; a fetch that returns one anyway
    // gets the same answer, because a redirect is a detour nobody vetted.
    await response.body?.cancel().catch(() => {});
    throw new BillingError("unreachable");
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new BillingError("invalid_response");
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BillingError("invalid_response");
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(merged);
  }

  if (response.status === 404) {
    // Preserved for the caller: WeChat answers a closed or unknown order's query with it.
    return { status: response.status, text };
  }
  if (response.status >= 400) {
    throw new BillingError("invalid_response");
  }
  return { status: response.status, text };
}

/**
 * GET that answers the status line alongside the body — the query call's shape, because a 404 is
 * the channel's own "no such order" verdict, not a malfunction the caller may gloss over.
 */
export async function getJsonWithStatus(
  config: ChannelHttpConfig,
  url: URL,
  authorization: string,
): Promise<{ status: number; text: string }> {
  await config.assertTarget(url);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        authorization,
      },
    });
  } catch {
    throw new BillingError("unreachable");
  }
  return readVerifiedResponse(response);
}
