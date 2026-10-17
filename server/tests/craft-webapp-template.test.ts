import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * THE SCAFFOLD'S CONTRACT WITH THE CODE IT GENERATES. (#364, spec D6)
 *
 * The preview serves every session's app at the ROOT of its own preview
 * origin (#362's host routing): the app-relative path the browser asks for is
 * the path the dev server sees. The session-scoped mount prefix mechanism —
 * the cwd-regex session sniff, the `basePath`/`assetPrefix` pair, the "/"
 * fallback rule and the NEXT_PUBLIC_BASE_PATH env handoff — is retired from
 * the scaffold: on the preview origin nothing routes
 * /api/craft/sessions/<id>/webapp/… anymore, so any surviving prefix would
 * strand every asset URL off-origin and the iframe would never hydrate.
 *
 * With the app at the origin root, a root-absolute `fetch("/api/tasks")` IS
 * the correct way to call the app's own API — the old trap (a raw fetch
 * resolving against the host product's /api/** with the person's cookie)
 * cannot happen on a separate origin. These tests pin that retirement against
 * the shipped template files so the foot-gun cannot silently come back (the
 * HMR seam the same retirement touches is pinned in craft-webapp-hmr.test.ts,
 * which #363's host-routed upgrade rewrites).
 */

const TEMPLATE = join(import.meta.dir, "../assets/craft/web-template");

const read = (rel: string) => readFile(join(TEMPLATE, rel), "utf8");

describe("the scaffold serves the app at the preview origin's root", () => {
  test("next.config.ts carries no mount-prefix machinery", async () => {
    const source = await read("next.config.ts");
    // The retired segments, by name: any one of them resurfacing puts
    // resource URLs back under /api/craft/sessions/<id>/webapp/_next/… on the
    // preview origin (AC: 预览内资源 URL 全部落在 preview origin 根下) — where
    // no route answers and the preview renders as an empty shell.
    expect(source).not.toContain("basePath");
    expect(source).not.toContain("assetPrefix");
    expect(source).not.toContain("redirects");
    expect(source).not.toContain("resolveWebappBasePath");
    expect(source).not.toContain("NEXT_PUBLIC_BASE_PATH");
    expect(source).not.toContain("ONYX_WEBAPP_BASE_PATH");
  });

  test("next.config.ts keeps the HMR relay's allowed dev origins", async () => {
    const source = await read("next.config.ts");
    // The preview's HMR websocket is relayed by the API server dialing the
    // sandbox host; without these entries Next 16 blocks /_next/webpack-hmr
    // cross-origin and live reload dies silently (see craft-webapp-hmr.test.ts).
    expect(source).toContain("allowedDevOrigins");
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("localhost");
  });

  test("lib/base-path.ts still exports apiUrl — the identity on paths", async () => {
    // The export is kept so apps already generated in the mount-prefix era
    // keep importing it. On the root-path scaffold it must return the input
    // path verbatim (normalized to one leading slash) — never "undefined/…"
    // and never a stale prefixed URL (AC: 返回值与传入路径一致).
    const module = await import(join(TEMPLATE, "lib/base-path.ts"));
    expect(module.BASE_PATH).toBe("");
    expect(module.apiUrl("/api/tasks")).toBe("/api/tasks");
    expect(module.apiUrl("api/tasks")).toBe("/api/tasks");
    expect(module.apiUrl("/api/tasks")).not.toContain("undefined");
  });

  test("AGENTS.md teaches the root-path contract, not the retired trap", async () => {
    const agents = await read("AGENTS.md");
    // The guidance has to name the mechanism, not just the fact: where the
    // app serves and how to call its own API — root-absolute paths on the
    // app's own origin.
    expect(agents).toContain("ROOT");
    expect(agents).toContain('fetch("/api/');
    // The retired foot-gun text must be gone: any surviving prefix/apiUrl
    // instruction would tell the agent to wrap URLs for a mechanism that no
    // longer exists, re-teaching the very trap D6 retires.
    expect(agents).not.toContain("basePath");
    expect(agents).not.toContain("base-path");
    expect(agents).not.toContain("apiUrl");
    expect(agents).not.toContain("BASE_PATH");
  });
});
