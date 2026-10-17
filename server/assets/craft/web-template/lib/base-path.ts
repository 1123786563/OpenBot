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
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}
