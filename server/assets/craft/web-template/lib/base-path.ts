/**
 * How this app reaches its OWN API routes.
 *
 * The preview serves the app under a session-scoped basePath (`/api/craft/sessions/<id>/webapp`),
 * and Next.js prefixes `<Link>`, `router.push` and assets with it — but not a raw `fetch()`.
 * So the URL you hand to `fetch` has to carry the prefix yourself:
 *
 *   import { apiUrl } from "@/lib/base-path";
 *   await fetch(apiUrl("/api/tasks"));            // ✅ reaches this app's route handler
 *   await fetch("/api/tasks");                    // ❌ hits the host product's /api/** instead
 *   await fetch("api/tasks");                     // ❌ drops the /webapp segment (no trailing slash)
 *
 * `apiUrl` accepts a leading slash or not, and collapses to the bare path when the app is
 * served at the root, so call sites never branch on where they are mounted.
 */
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}
