/**
 * How this app reaches its OWN API routes.
 *
 * The preview serves this app on its own origin in two shapes: the dev form
 * under an injected `/<label>` prefix (the start script exports
 * NEXT_PUBLIC_BASE_PATH alongside ONYX_WEBAPP_BASE_PATH, and next.config.ts
 * mirrors the latter into `basePath`/`assetPrefix`), the production host form
 * at the origin's root. Next.js prefixes `<Link>`, `router.push` and assets
 * with the base path — but NOT a raw `fetch()` — so the URL you hand to fetch
 * has to carry the prefix yourself:
 *
 *   import { apiUrl } from "@/lib/base-path";
 *   await fetch(apiUrl("/api/tasks"));   // ✅ reaches this app's route handler
 *
 * `apiUrl` accepts a leading slash or not, and collapses to the bare path
 * when the app is served at the root (no env → empty prefix), so call sites
 * never branch on where the app is mounted — one code shape is correct in
 * both forms.
 */
export const BASE_PATH: string = (() => {
  // fix-ocr22 #4: the consumer-side whitelist, the twin of next.config.ts's
  // own (the minter only ever writes lowercase-hex labels). The `env` field
  // inlining normally sanitizes this value — but a manual export or an
  // app-owned .env reaches THIS module unfiltered, so the module applies the
  // SAME `^\/[0-9a-z-]{1,64}$` shape check: anything outside it (a stale
  // shell residue, an uppercase mount, a bare "/") folds to the empty prefix
  // and apiUrl() stays the identity, exactly like the no-env root shape.
  // The parity lock in tests/craft-webapp-template.test.ts keeps this regex
  // byte-identical to next.config.ts's and nextjs-dev.ts's.
  // fix-ocr25 #4: TRIM before the check, like both twins do — this module is
  // the one unfiltered entry (manual export, app-owned .env), and testing the
  // raw value folded `" /label "` to the empty prefix here while the same
  // value on ONYX_WEBAPP_BASE_PATH mounted "/label": basePath and BASE_PATH
  // disagreeing, raw fetch() missing the prefix. Trim, then judge — the two
  // faces cannot split on whitespace alone.
  const requested = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").trim();
  const safeBasePath = /^\/[0-9a-z-]{1,64}$/.test(requested) ? requested : "";
  return safeBasePath;
})();

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}
