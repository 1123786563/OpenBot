import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";

/**
 * The static webapp service (S3): a Bot's BUILT artifact, served as files.
 *
 * NO CHILD PROCESS. Unlike the dev server (S8's vite, a live process), a webapp preview here
 * is the `dist/` that already exists in the Bot's workspace — the build happened during the
 * turn — so serving it is reading files, not running anything. That is the whole reason the
 * webapp road and the dev road are different doors: one serves what WAS built, the other runs
 * what is being written.
 *
 * CONTAINMENT, SAME RULE AS THE DEV SERVER: a path outside the Bot's webapp root is a 404,
 * not an error — the caller cannot distinguish "not built" from "not yours," and should not.
 *
 * PORTS ARE NAMED, NOT POOLED. The webapp pool (SANDBOX_WEBAPP_PORT_BASE) is a per-bot STATIC
 * assignment (bot slot → port) managed by the deployment's port mapping, not a lease pool:
 * a static file server holds no state worth leasing. This module answers "what bytes" and
 * leaves "which port" to the proxy that mounts it.
 */

export type WebappRoots = {
  /** The workspace root Bot dirs resolve against (the same one the dev server uses). */
  workspaceRoot: string;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * One static file from a Bot's webapp build. `null` is both "not built" and "not yours" —
 * see the head — and the index.html fallback serves the SPA case (every route is the app).
 */
export async function readWebappFile(
  roots: WebappRoots,
  botId: string,
  path: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  // The same containment arithmetic the dev server holds, restated for files: normalize,
  // refuse climbs, refuse absolutes, and the result must sit under the webapp root.
  // An absolute path is refused outright, the dev server's rule: slicing the slash off
  // makes it relative by accident, and a smuggled /etc/... then rides the SPA fallback.
  if (path.startsWith("/")) return null;
  // resolve() on BOTH sides: macOS's tempdir answers through a /var symlink that normalize()
  // keeps as written, so a real file at /private/var/... would fail a prefix check against
  // /var/... — resolved once, the comparison is about the path, not the alias it came by.
  const root = resolve(join(roots.workspaceRoot, botId, "webapp"));
  const target = resolve(join(root, path));
  if (target !== root && !target.startsWith(root + "/")) return null;

  const candidates =
    path === "" ? [join(root, "index.html"), target] : [target];
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    const bytes = await readFile(candidate).catch(() => null);
    if (!bytes) continue;
    return {
      bytes: new Uint8Array(bytes),
      contentType:
        CONTENT_TYPES[extname(candidate).toLowerCase()] ??
        "application/octet-stream",
    };
  }
  // The SPA fallback: a route the build does not hold as a file is the app's route — the
  // index answers it, exactly as a static host with try-files would.
  if (path !== "" && !path.startsWith("index.html")) {
    const index = await readWebappFile(roots, botId, "index.html");
    if (index) return index;
  }
  return null;
}

/**
 * Start/stop are no-ops with a shape: the static road has no process, but its callers (the
 * proxy's lifecycle verbs) want the same answers the dev road gives. `start` verifies the
 * build exists (a 404-shaped refusal when it does not); `stop` always succeeds.
 */
export async function startWebapp(
  roots: WebappRoots,
  botId: string,
): Promise<{ ok: true; root: string } | { ok: false; reason: "not-built" }> {
  const index = await readWebappFile(roots, botId, "");
  if (!index) return { ok: false, reason: "not-built" };
  return { ok: true, root: join(roots.workspaceRoot, botId, "webapp") };
}

export async function stopWebapp(): Promise<{ ok: true }> {
  // Nothing to stop — see the head. The shape exists so the proxy's verbs stay symmetric.
  return { ok: true };
}
