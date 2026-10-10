/**
 * Reading an unauthenticated request body, exactly once, with a hard cap.
 *
 * Raised from ./service so the two signatures-over-bytes audiences — the billing provider's
 * webhook and the payment channels' anonymous callbacks — cannot drift apart: both verify against
 * the exact bytes that arrived, so the body cannot be re-read or transformed, and both are
 * unauthenticated input at the point of reading, so neither is ever buffered beyond 1 MiB.
 * `content-length` is checked first and the stream is cut mid-read when it lies. Over the cap the
 * caller answers 413: a sender that retries a bounded delivery is tolerated, and nobody allocates
 * for an attacker.
 */

/** The request body a signature-verified endpoint may carry. A bigger one is answered 413. */
export const MAX_RAW_BODY_BYTES = 1024 * 1024;

/** `null` means over the cap: refuse before verifying or buffering anything further. */
export async function readBodyCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RAW_BODY_BYTES) {
    return null;
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RAW_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
