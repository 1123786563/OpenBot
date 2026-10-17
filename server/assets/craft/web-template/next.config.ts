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

const configuredBasePath = (process.env.ONYX_WEBAPP_BASE_PATH ?? "").trim();

const allowedDevOrigins = (process.env.ONYX_WEBAPP_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// The preview's HMR websocket is relayed by the API server dialing the sandbox
// host, so the dev origin it presents (127.0.0.1) must be allowed or Next 16
// blocks /_next/webpack-hmr cross-origin and live reload dies silently.
allowedDevOrigins.push("127.0.0.1", "localhost");

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
