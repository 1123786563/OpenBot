import type { NextConfig } from "next";

// The cwd fallback lets a dev server the agent starts by hand still serve
// under the path the preview proxy expects.
function resolveWebappBasePath(): string | undefined {
  if (process.env.ONYX_WEBAPP_BASE_PATH) {
    return process.env.ONYX_WEBAPP_BASE_PATH;
  }
  // The session id sits right before outputs/web in both directory shapes the
  // server scaffolds: OpenBot's bot-relative `/workspace/bots/<bot>/<id>/…`
  // and the absolute sessions root. The mount the preview proxy serves is
  // /api/craft/sessions/<id>/webapp — without a basePath every asset URL
  // escapes to the host origin and the preview iframe never hydrates.
  const match = process.cwd().match(/\/([^/]+)\/outputs\/web\/?$/);
  return match ? `/api/craft/sessions/${match[1]}/webapp` : undefined;
}

const webappBasePath = resolveWebappBasePath();
const allowedDevOrigins = (process.env.ONYX_WEBAPP_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// The preview's HMR websocket is relayed by the API server dialing the sandbox
// host, so the dev origin it presents (127.0.0.1) must be allowed or Next 16
// blocks /_next/webpack-hmr cross-origin and live reload dies silently.
allowedDevOrigins.push("127.0.0.1", "localhost");

const nextConfig: NextConfig = {};

if (webappBasePath) {
  nextConfig.basePath = webappBasePath;
  nextConfig.assetPrefix = webappBasePath;
  // Point naive probes of "/" (which otherwise 404) at the real app.
  nextConfig.redirects = async () => [
    {
      source: "/",
      destination: webappBasePath,
      basePath: false,
      permanent: false,
    },
  ];
}

// basePath prefixes <Link>, router pushes and assets — and NOTHING else. A raw
// fetch("/api/tasks") in a client component is not prefixed, so it resolves against the HOST
// origin and lands in OpenBot's own /api/** (authenticated with the person's cookie), while
// the relative fetch("api/tasks") drops the /webapp segment because the document URL has no
// trailing slash. Measured live: neither reaches the app the agent just built, so the preview
// renders but nothing in it can be operated. `env` is the one mechanism Next inlines into both
// the server and the client bundle, which is what lets the app build correct URLs at all —
// lib/base-path.ts reads it and AGENTS.md tells the agent to route its API calls through it.
nextConfig.env = { NEXT_PUBLIC_BASE_PATH: webappBasePath ?? "" };

if (allowedDevOrigins.length > 0) {
  nextConfig.allowedDevOrigins = allowedDevOrigins;
}

export default nextConfig;
