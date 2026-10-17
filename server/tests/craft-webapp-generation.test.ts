import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import {
  buildWebappBootstrapScript,
  writeWebappBootstrapScript,
} from "../src/craft/nextjs-dev";
import {
  generationGatedWebappBasePathFor,
  readWebappGeneration,
  WEBAPP_GENERATION_CURRENT,
  WEBAPP_GENERATION_MARKER,
} from "../src/craft/webapp-generation";

/**
 * #367 — the legacy-session judgment (spec D10: 存量不迁移).
 *
 * THE SIGNAL, and why it is an assembly-time marker rather than anything else:
 *
 * The ticket's original suggestion ("does outputs/web/next.config.ts mention
 * basePath") is DEAD: since F-2 (#365) BOTH template generations carry basePath
 * logic (the old one is env-first with a cwd fallback, the new one env-only), so
 * the source cannot tell old from new. Session creation time is also wrong: a
 * pre-deployment session that (re)builds its webapp AFTER the deployment gets a
 * CURRENT-shape app (the template on disk is the new one), and routing it to the
 * old path by creation date would 404 a working app — the exact silent-404
 * middle state AC2 forbids. The start script's own text (does it export
 * ONYX_WEBAPP_BASE_PATH?) measures the SERVER's code, not the app's vintage:
 * every provisioning/regenerate refresh rewrites the script, so in the dev form
 * every session would read "current" (legacy apps 404 at the new address) and in
 * the host form none would (new apps misrouted to the old path).
 *
 * The marker is written by the server-authored start script at the ONE moment an
 * app's generation is decided — the template copy into outputs/web — so absence
 * means precisely "assembled before the new scaffold regime", which is exactly
 * the population D10 addresses. Reading it is one file-API call on the surface
 * webapp-info already pays for; unavailability degrades to "legacy", the
 * conservative answer for the population the AC protects.
 */

const DIRECTORY = "/workspace/sessions/cs-367gen";
const MARKER_PATH = `${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`;

/** Minimal readFile-only view of a session workspace. */
function fileApiWith(
  files: Record<string, string>,
  options: { throws?: boolean } = {},
) {
  return {
    async readFile(path: string) {
      if (options.throws) throw new Error("gateway down");
      return files[path] ?? null;
    },
  };
}

describe("readWebappGeneration — the D10 judgment signal", () => {
  test(`marker content ${WEBAPP_GENERATION_CURRENT} answers "current"`, async () => {
    const generation = await readWebappGeneration(
      fileApiWith({ [MARKER_PATH]: `${WEBAPP_GENERATION_CURRENT}\n` }),
      DIRECTORY,
    );
    expect(generation).toBe("current");
  });

  test("no marker answers legacy — the pre-marker apps D10 protects", async () => {
    const generation = await readWebappGeneration(fileApiWith({}), DIRECTORY);
    expect(generation).toBe("legacy");
  });

  test("an unreadable marker (gateway failure) degrades to legacy", async () => {
    const generation = await readWebappGeneration(
      fileApiWith(
        { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
        { throws: true },
      ),
      DIRECTORY,
    );
    expect(generation).toBe("legacy");
  });

  test("any other marker content answers legacy (never guess forward)", async () => {
    const generation = await readWebappGeneration(
      fileApiWith({ [MARKER_PATH]: "1" }),
      DIRECTORY,
    );
    expect(generation).toBe("legacy");
  });

  test("no file API at all answers legacy (conservative: the no-sandbox reads)", async () => {
    const generation = await readWebappGeneration(null, DIRECTORY);
    expect(generation).toBe("legacy");
  });
});

describe("generationGatedWebappBasePathFor — D10 branches the dev-form mount", () => {
  const LABEL = "/abc123label";

  function gated(
    files: Record<string, string>,
    delegate?: (sessionId: string) => Promise<string | null> | string | null,
    options: { noFileApi?: boolean } = {},
  ) {
    return generationGatedWebappBasePathFor({
      webappBasePathFor: delegate,
      fileApiFor: () =>
        options.noFileApi ? null : (fileApiWith(files) as never),
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => DIRECTORY,
    });
  }

  test("a legacy session mounts at NOTHING: the script stays on the old cwd-fallback mount", async () => {
    const resolve = gated({}, () => LABEL);
    // The old app self-mounts /api/craft/sessions/<id>/webapp via its cwd regex
    // when no env is exported — the old same-origin path serves it (D10). Had
    // this returned the label, a refreshed script would re-mount the legacy app
    // under /<label> while the pane points at the old path: the inverse 404.
    expect(await resolve("cs-x")).toBeNull();
  });

  test("a current session passes the dev-form derivation through (async delegate)", async () => {
    const resolve = gated(
      { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
      async () => LABEL,
    );
    expect(await resolve("cs-x")).toBe(LABEL);
  });

  test("a current session with a sync delegate still resolves", async () => {
    const resolve = gated(
      { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
      () => LABEL,
    );
    expect(await resolve("cs-x")).toBe(LABEL);
  });

  test("an unreadable workspace degrades to legacy (null), never to a guessed mount", async () => {
    const resolve = gated(
      { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
      () => LABEL,
      {
        noFileApi: true,
      },
    );
    expect(await resolve("cs-x")).toBeNull();
  });

  test("no delegate wired (host form / closed origin) stays null either way", async () => {
    const resolve = gated({ [MARKER_PATH]: WEBAPP_GENERATION_CURRENT });
    expect(await resolve("cs-x")).toBeNull();
  });
});

describe("the start script stamps the generation at assembly time", () => {
  test("the template copy writes the marker into the session root", () => {
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: "/abc123label",
    });
    const stamp = `echo ${WEBAPP_GENERATION_CURRENT} > "$SESSION_PATH/${WEBAPP_GENERATION_MARKER}"`;
    expect(script).toContain(stamp);
    // The stamp belongs to the COPY branch (the moment the app's generation is
    // decided), not to the spawn path: an app that already exists must never be
    // re-stamped — its generation is whatever assembled it, and re-stamping a
    // pre-marker app would flip it to "current" and route it to the preview
    // origin it is not mounted for.
    const copyBranch = script.indexOf("Copying outputs template");
    const stampIndex = script.indexOf(stamp);
    const spawn = script.indexOf("Starting Next.js dev server");
    expect(copyBranch).toBeGreaterThan(-1);
    expect(stampIndex).toBeGreaterThan(copyBranch);
    expect(stampIndex).toBeLessThan(spawn);
  });

  test("writeWebappBootstrapScript awaits an async basePath resolver", async () => {
    const written: Record<string, string> = {};
    await writeWebappBootstrapScript(
      {
        writeFile: async (path, content) => {
          written[path] = content;
        },
      },
      "cs-367",
      loadCraftConfig({}),
      3011,
      async () => "/abc123label",
    );
    const script = written[`/workspace/sessions/cs-367/start-webapp.sh`];
    expect(script).toContain(`export ONYX_WEBAPP_BASE_PATH="/abc123label"`);
    expect(script).toContain(`export NEXT_PUBLIC_BASE_PATH="/abc123label"`);
  });

  test("an async resolver answering null writes the root-path script (no exports)", async () => {
    const written: Record<string, string> = {};
    await writeWebappBootstrapScript(
      {
        writeFile: async (path, content) => {
          written[path] = content;
        },
      },
      "cs-367",
      loadCraftConfig({}),
      3011,
      async () => null,
    );
    const script = written[`/workspace/sessions/cs-367/start-webapp.sh`];
    expect(script).not.toContain("ONYX_WEBAPP_BASE_PATH=");
  });
});
