/**
 * The request-shaped refusal both preview surfaces share (review-367 L1): an
 * iframe-facing page for HTML callers, JSON otherwise.
 *
 * This is a deliberate LEAF module — it imports nothing from the craft graph —
 * because preview-origin.ts and webapp-proxy.ts both need it, and neither may
 * import the other: every cross-reference between those two used to sit in a
 * module cycle, safe only while it stayed inside function bodies (a top-level
 * reference to the other module's const would trip TDZ/initialization order,
 * and the cycle is fragile for bundlers and CJS interop besides). Hosting the
 * one shared refusal here breaks the cycle at its only functional edge.
 *
 * The preview pane gates on `ready`, but the proxy URL is handed to the client
 * unconditionally and a browser can still reach it (a stale frame, a reload
 * race, a shared link) — and raw JSON in an iframe is exactly the
 * `{"error":"The web app is not running…"}` page this used to show. A caller
 * that accepts HTML gets a readable page; a programmatic caller keeps the JSON
 * shape it parses. The preview origin's own gates (its 401 pass refusal) land
 * on iframes too and use the SAME dual shape (#362).
 */
export function refuseResponse(
  request: Request,
  message: string,
  status = 503,
): Response {
  const accepts = request.headers.get("accept") ?? "";
  const wantsHtml =
    accepts.includes("text/html") || accepts.includes("application/xhtml+xml");
  // fix-ocr18 #4: both branches answer no-store. A refusal describes a
  // TRANSIENT state; the JSON branch's statuses include default-cacheable
  // ones (a lost row's 404) and the HTML page can be heuristically stored —
  // a cached refusal keeps answering after the state has healed. The same
  // discipline the probe's 204 already holds.
  const noStore = { "cache-control": "no-store" } as const;
  if (!wantsHtml) {
    return Response.json({ error: message }, { status, headers: noStore });
  }
  // Escaped, because the message is server-authored today but this is an HTML
  // sink and a caller-supplied string must never become script here. Both
  // quote flavors are encoded (fix-ocr15): `"` alone left an asymmetric
  // defense — an apostrophe slides through unchanged and would break out of
  // (or inject into) any single-quoted attribute context the page grows.
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Web app unavailable</title>` +
      `<style>body{margin:0;display:flex;min-height:100vh;align-items:center;` +
      `justify-content:center;background:#fff;color:#18181b;` +
      `font:13px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}` +
      `p{max-width:34ch;margin:0;padding:24px;text-align:center}` +
      `@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}` +
      `}</style></head><body><p>${safe}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...noStore,
        // fix-ocr15: the hardening headers every other HTML surface here
        // carries. The CSP is the strictest shape that still renders this
        // page — `default-src 'none'` walls everything off, with the single
        // `style-src 'unsafe-inline'` exception the inline <style> above
        // needs — and nosniff keeps a browser from re-sniffing the page into
        // something executable. A refusal an iframe lands on is still a page
        // this platform serves; it holds the platform's lines.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
