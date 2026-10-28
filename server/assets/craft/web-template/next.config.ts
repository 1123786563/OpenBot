import type { NextConfig } from "next";

// WHERE THIS APP IS MOUNTED, in one explicit env (F-2, #365):
//
// - dev-form preview: the session's start script (start-webapp.sh, generated
//   by the server) exports ONYX_WEBAPP_BASE_PATH=/<label> — the same label the
//   preview address http://127.0.0.1:<port>/<label> rides — so every resource
//   URL the app emits carries the label and resolves on the preview origin.
// - production host form (and any hand-run dev server): the env is unset, the
//   app serves at the origin's root (spec D3) — exactly the root-path behavior
//   #364 shipped.
//
// The env is injected by the controlled start side only. What #364 retired
// stays retired: no cwd-sniffing mount resolver, no session-id-in-cwd regex,
// no `/` → prefix redirect rules — a mount is never guessed from where the
// process happens to run.

// The CONSUMER-SIDE whitelist (fix-ocr12, the twin of nextjs-dev.ts's
// WEBAPP_BASE_PATH_PATTERN): the injection side's pattern only governs the
// value the controlled start script exports — a manual `export` in the
// shell, or an app-owned .env, reaches THIS module unfiltered. A value
// missing its leading slash crashes `next dev` outright; a trailing slash or
// a stray character silently mis-mounts every resource URL. The template is
// its own defense line and does not trust the process env's shape: anything
// outside the same /<label> alphabet falls back to the empty mount (root
// path, the production behavior). fix-ocr19 #5: the pattern is CASE-SENSITIVE
// in lockstep with the injection side (fix-ocr17 #3 dropped its `i` flag —
// the minter only ever mints lowercase hex), so a hand-supplied `/ABC123`
// takes the fallback here too instead of mounting an uppercase basePath the
// controlled side could never have produced. The label needs at least ONE
// character (fix-ocr15): a bare "/" matched the old `{0,64}` quantifier and
// mounted the app at basePath:"/" — every resource URL it then emits starts
// with `//`, which URL grammar reads as a protocol-relative address and
// dispatches to a foreign origin. A bare slash IS the root shape's spelling
// of "no mount", so it takes the empty fallback like any other malformed
// value.
const requestedBasePath = (process.env.ONYX_WEBAPP_BASE_PATH ?? "").trim();
const configuredBasePath = /^\/[0-9a-z-]{1,64}$/.test(requestedBasePath)
  ? requestedBasePath
  : "";
// fix-ocr17: a PRESENT-but-malformed value must not degrade silently. The
// preview proxy addresses this app at /<label> — falling back to the root
// shape without a trace used to mean a whole-origin 404 with nothing in any
// log. Warn with the raw value and the adopted form; an unset/blank env (the
// production root shape, spec D3) stays silent by design.
if (requestedBasePath !== "" && configuredBasePath === "") {
  console.warn(
    `ONYX_WEBAPP_BASE_PATH value "${requestedBasePath}" is not a /<label> mount; falling back to the root path (basePath unset)`,
  );
}

const allowedDevOrigins = (process.env.ONYX_WEBAPP_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => {
    if (!origin) return false;
    // Same doctrine as the basePath branch above: this env can arrive through
    // a manual export or an app-owned .env, so a present-but-malformed entry
    // (a scheme, a wildcard, bare whitespace) must not slip into Next's
    // dev-origin whitelist unjudged — drop it loudly.
    if (!/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(origin)) {
      console.warn(
        `ONYX_WEBAPP_ALLOWED_DEV_ORIGINS entry "${origin}" is not a host[:port] origin; dropping it`,
      );
      return false;
    }
    return true;
  });
// The preview's HMR websocket is relayed by the API server dialing the sandbox
// host, so the dev origin it presents (127.0.0.1) must be allowed or Next 16
// blocks /_next/webpack-hmr cross-origin and live reload dies silently.
for (const loopback of ["127.0.0.1", "localhost"]) {
  if (!allowedDevOrigins.includes(loopback)) allowedDevOrigins.push(loopback);
}

const nextConfig: NextConfig = {
  ...(configuredBasePath === ""
    ? {}
    : {
        // basePath prefixes <Link>, router pushes and assets; assetPrefix
        // keeps chunk/CSS URLs on the same mount — one env, one truth.
        basePath: configuredBasePath,
        assetPrefix: configuredBasePath,
      }),
  // The one mechanism Next inlines into BOTH the server and the client bundle:
  // lib/base-path.ts reads it so raw fetch()/EventSource/WebSocket URLs can
  // carry the prefix Next does not add for them. Always set ("" in the
  // root-path shape) so a stale env from a previous dev-form boot can never
  // leak a dead prefix into a root-mounted app.
  env: { NEXT_PUBLIC_BASE_PATH: configuredBasePath },
  allowedDevOrigins,
};

export default nextConfig;
