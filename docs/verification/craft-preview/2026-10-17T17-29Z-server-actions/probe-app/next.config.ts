import type { NextConfig } from "next";

// Mirrors server/assets/craft/web-template/next.config.ts for the parts this
// measurement needs: env-only /<label> mount, consumer-side pattern, and
// allowedDevOrigins. serverActions.allowedOrigins is toggled by env so the
// matrix can compare "ship config" vs "票面 asks for it".
const requestedBasePath = (process.env.ONYX_WEBAPP_BASE_PATH ?? "").trim();
const configuredBasePath = /^\/[0-9a-z-]{1,64}$/.test(requestedBasePath)
  ? requestedBasePath
  : "";

const allowedDevOrigins = ["127.0.0.1", "localhost"];

const allowedOrigins = (process.env.PROBE_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  ...(configuredBasePath === ""
    ? {}
    : { basePath: configuredBasePath, assetPrefix: configuredBasePath }),
  env: { NEXT_PUBLIC_BASE_PATH: configuredBasePath },
  allowedDevOrigins,
  ...(allowedOrigins.length
    ? { experimental: { serverActions: { allowedOrigins } } }
    : {}),
};

export default nextConfig;
