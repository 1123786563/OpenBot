import type { NextConfig } from "next";

// The preview serves this app at the ROOT of its own origin (the host-routed
// preview origin): the app-relative path the browser asks for is the path Next
// serves, as-is. The old session-scoped mount prefix machinery — the cwd-regex
// session sniff, the config prefix pair, the "/" fallback rule and the env
// handoff to client code — is retired (spec D6, #364): on the preview origin
// nothing routes /api/craft/sessions/<id>/webapp/… anymore, so any surviving
// prefix would strand every asset URL off-origin and the preview iframe would
// never hydrate.

const allowedDevOrigins = (process.env.ONYX_WEBAPP_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
// The preview's HMR websocket is relayed by the API server dialing the sandbox
// host, so the dev origin it presents (127.0.0.1) must be allowed or Next 16
// blocks /_next/webpack-hmr cross-origin and live reload dies silently.
allowedDevOrigins.push("127.0.0.1", "localhost");

const nextConfig: NextConfig = {
  allowedDevOrigins,
};

export default nextConfig;
