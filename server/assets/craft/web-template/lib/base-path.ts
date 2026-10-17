/**
 * How this app reaches its OWN API routes.
 *
 * The preview serves the app at the ROOT of its own origin (the host-routed
 * preview origin), so the correct — and only — way to call this app's own API
 * is a root-absolute path:
 *
 *   await fetch("/api/tasks");   // ✅ reaches this app's own route handler
 *
 * The app's origin is its own (the preview host), separate from the platform's,
 * so a same-origin `fetch` cannot reach any other server's API and no platform
 * cookie is in scope.
 *
 * `BASE_PATH`/`apiUrl` stay exported for apps generated when the scaffold
 * served under a session-scoped mount: `BASE_PATH` is now always the empty
 * string, so `apiUrl` returns the input path with a single leading slash —
 * code that already routes through it keeps working unchanged.
 */
export const BASE_PATH: string = "";

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${suffix}`;
}
