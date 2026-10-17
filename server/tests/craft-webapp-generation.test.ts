import { describe, expect, test } from "bun:test";
import { loadCraftConfig } from "../src/craft/config";
import {
  buildWebappBootstrapScript,
  writeWebappBootstrapScript,
  WEBAPP_MOUNT_MARKER,
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
 * app's generation is decided — the template copy into outputs/web. A marker
 * present and equal to "2" therefore reads "current"; a marker present with any
 * other content reads "legacy" (never guess forward). An ABSENT marker is read
 * against the app body (outputs/web/package.json — the exact file the script's
 * copy branch checks): app absent ⇒ the app is NOT YET ASSEMBLED and will be
 * born from the CURRENT disk template, so it answers "current" (the H1 fix —
 * the script written before the first start must already carry the mount the
 * preview address rides); app present ⇒ the app predates the marker regime,
 * the population D10 addresses. Unavailability (no file API, gateway failure)
 * cannot distinguish the two absent-marker populations and degrades to
 * "legacy", the conservative answer for the population the AC protects.
 */

const DIRECTORY = "/workspace/sessions/cs-367gen";
const MARKER_PATH = `${DIRECTORY}/${WEBAPP_GENERATION_MARKER}`;
// The app-body probe: the exact file the start script's copy branch checks to
// decide whether an app exists (nextjs-dev.ts: `[ ! -f .../outputs/web/package.json ]`).
const APP_BODY = `${DIRECTORY}/outputs/web/package.json`;

/** Minimal readFile-only view of a session workspace. */
function fileApiWith(
  files: Record<string, string>,
  options: { throws?: boolean; throwsOn?: Record<string, boolean> } = {},
) {
  return {
    async readFile(path: string) {
      if (options.throws || options.throwsOn?.[path])
        throw new Error("gateway down");
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

  test("marker absent + app assembled answers legacy — the pre-marker apps D10 protects", async () => {
    const generation = await readWebappGeneration(
      fileApiWith({ [APP_BODY]: '{"name":"web"}' }),
      DIRECTORY,
    );
    expect(generation).toBe("legacy");
  });

  test("marker absent + NO app answers current — an unassembled app will be born from the current template (H1)", async () => {
    // The provisioning-time read: outputs/web does not exist yet, so the first
    // `webapp start` WILL copy the current template and stamp current. The
    // script written at this moment must already carry the dev-form mount the
    // preview address rides — the pre-H1 answer (legacy) shipped a root-path
    // script beside a panel pointing at /<label>: the silent first-build 404.
    const generation = await readWebappGeneration(fileApiWith({}), DIRECTORY);
    expect(generation).toBe("current");
  });

  test("an unreadable app body (gateway failure on the probe) degrades to legacy", async () => {
    // The absent marker cannot be distinguished from the pre-marker population
    // if the probe itself fails — the conservative answer protects D10's crowd.
    const generation = await readWebappGeneration(
      fileApiWith({}, { throwsOn: { [APP_BODY]: true } }),
      DIRECTORY,
    );
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

  test("a legacy session (marker absent, app assembled) mounts at NOTHING: the script stays on the old cwd-fallback mount", async () => {
    const resolve = gated(
      { [`${DIRECTORY}/outputs/web/package.json`]: '{"name":"web"}' },
      () => LABEL,
    );
    // The old app self-mounts /api/craft/sessions/<id>/webapp via its cwd regex
    // when no env is exported — the old same-origin path serves it (D10). Had
    // this returned the label, a refreshed script would re-mount the legacy app
    // under /<label> while the pane points at the old path: the inverse 404.
    expect(await resolve("cs-x")).toBeNull();
  });

  test("an UNASSEMBLED session (no marker, no app) passes the dev mount through — the script pre-answers the birth (H1)", async () => {
    // The first-build window: no outputs/web, no marker. The app the first
    // start will assemble is born current, so the script written NOW must
    // carry the /<label> mount the pane's address rides. The pre-H1 gate
    // answered legacy here and shipped a root-path script: the app mounted at
    // "/" while webapp-info (reading the fresh marker) handed out /<label> —
    // a silent, non-self-healing 404 on every dev-form first build.
    const resolve = gated({}, () => LABEL);
    expect(await resolve("cs-x")).toBe(LABEL);
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

  test("the script records the mount it actually carries, beside the reserved-port record (review-367 H)", () => {
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: "/abc123label",
    });
    // The second signal the rebuild window needs: the generation marker is
    // stamped at template-copy time by WHATEVER script ran, so marker=current
    // alone cannot tell WHICH script's mount the dev server inherited. This
    // record rides the same channel as .nextjs-port — written by every run of
    // THIS script, naming the mount the server it spawns answers on — so
    // webapp-info can cross-check the address it hands out against it.
    const record = `printf '%s' '/abc123label' > "$SESSION_PATH/${WEBAPP_MOUNT_MARKER}"`;
    expect(script).toContain(record);
    // Beside the port record, not inside the copy branch: a rebuilt app (the
    // copy branch skipped) and a reused server (the spawn branch skipped) must
    // both leave a record that mirrors the script that ran.
    const recordAt = script.indexOf(record);
    const portRecordAt = script.indexOf(
      `echo $PORT > "$SESSION_PATH/.nextjs-port"`,
    );
    expect(portRecordAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(portRecordAt);
  });

  test("a root-path script records the EMPTY mount — the record always mirrors the script", () => {
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: null,
    });
    // An empty record is the honest "this script serves the port root" — the
    // shape every legacy-era (no-env) script must leave behind so a mismatch
    // against a /<label> address is detectable.
    expect(script).toContain(
      `printf '%s' '' > "$SESSION_PATH/${WEBAPP_MOUNT_MARKER}"`,
    );
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
    // Single-quoted exports (review-367 L2): bash double quotes do not neutralize
    // $, backticks or embedded double quotes — the line stays inert only because
    // the value is a server-derived /<20-hex> today. Single quotes make the
    // defense the shell's, not the value discipline's.
    expect(script).toContain(`export ONYX_WEBAPP_BASE_PATH='/abc123label'`);
    expect(script).toContain(`export NEXT_PUBLIC_BASE_PATH='/abc123label'`);
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
