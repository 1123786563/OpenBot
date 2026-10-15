import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * THE SCAFFOLD'S CONTRACT WITH THE CODE IT GENERATES.
 *
 * The preview serves every session's app under the session's own basePath
 * (`/api/craft/sessions/<id>/webapp`, set by the template's next.config.ts), because without
 * it the asset URLs escape to the host origin and the iframe never hydrates.
 *
 * THAT basePath IS ALSO A TRAP for the code the agent writes: Next.js prefixes `<Link>`,
 * `router.push` and assets with it, but a raw `fetch()` is NOT prefixed. So the natural thing
 * an agent writes — `fetch("/api/tasks")` — resolves against the HOST origin and lands in
 * OpenBot's own `/api/**`, authenticated with the person's cookie; and the relative
 * `fetch("api/tasks")` drops the `webapp` segment entirely, because the document URL has no
 * trailing slash. Measured live: the first silently hits the host product's API, the second
 * 404s. Neither reaches the app the agent just built, so the preview renders but nothing in
 * it can be operated.
 *
 * These tests pin the escape hatch the scaffold hands the agent — a base-path helper the
 * generated code is TOLD to use — against the shipped template files, so the contract cannot
 * silently drift the way the HMR relay's did (see craft-webapp-hmr.test.ts).
 */

const TEMPLATE = join(import.meta.dir, "../assets/craft/web-template");

const read = (rel: string) => readFile(join(TEMPLATE, rel), "utf8");

describe("the scaffold hands the agent a working API base path", () => {
  test("next.config.ts publishes the basePath to client code via env", async () => {
    const source = await read("next.config.ts");
    // `env` is the one mechanism Next inlines into BOTH the server and the client
    // bundle regardless of when it is set — the agent's fetch calls are client code.
    expect(source).toContain("nextConfig.env");
    expect(source).toContain("NEXT_PUBLIC_BASE_PATH");
  });

  test("lib/base-path.ts exists and defaults to the root when there is no basePath", async () => {
    const source = await read("lib/base-path.ts");
    expect(source).toContain("NEXT_PUBLIC_BASE_PATH");
    expect(source).toContain("export");
    // Forward-compatible with a preview origin that serves the app at "/" (the
    // independent-origin design): an absent basePath must not yield "undefined/…" URLs.
    expect(source).toContain('?? ""');
  });

  test("AGENTS.md tells the agent to route API calls through it", async () => {
    const agents = await read("AGENTS.md");
    // The note has to name the mechanism, not just the fact: "the app serves under a base
    // path" alone leaves the agent to invent a URL scheme, and every variant it invents is
    // wrong in a different way.
    expect(agents).toContain("@/lib/base-path");
    expect(agents).toContain("apiUrl");
    expect(agents).toContain("fetch");
  });
});
