import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCraftConfig } from "../src/craft/config";
import {
  buildWebappBootstrapScript,
  writeWebappBootstrapScript,
  WEBAPP_MOUNT_MARKER,
} from "../src/craft/nextjs-dev";
import {
  generationGatedWebappBasePathFor,
  readWebappGeneration,
  WEBAPP_APP_BODY_SENTINEL,
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
 * the population D10 addresses. Degraded reads split by KIND (fix-ocr26 #8):
 * no file API at all is a PERMANENT fact (no sandbox) and answers "legacy";
 * a read that THREW is a transient flake and answers "unknown" — no
 * generational verdict at all (folding it into "legacy" used to rewrite a
 * current session's address to a path the dev server 404s). At the
 * start-script gate unknown degrades like legacy (no mount), the one failure
 * mode there the .webapp-mount cross-check catches.
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

  test("the app-body probe runs FIRST: an unassembled app answers current WITHOUT reading the marker (fix-ocr17 TOCTOU)", async () => {
    // Marker-then-body leaves a window BETWEEN two gateway round trips: an
    // app assembled in between (copy + stamp) is misjudged. Body-first shrinks
    // the window to the script's own cp/echo lines: app ABSENT already answers
    // "current" — the next start rebuilds and re-stamps — so the marker is
    // never even consulted for an unassembled app.
    const reads: string[] = [];
    const generation = await readWebappGeneration(
      {
        async readFile(path: string) {
          reads.push(path);
          return null;
        },
      },
      DIRECTORY,
    );
    expect(generation).toBe("current");
    expect(reads).toEqual([APP_BODY]); // RED pre-fix: the marker was read first
  });

  test("the deployed gateway's absent shape — 200 envelope with content:\"\", never a 404 — answers current for a fresh session (live repro 2026-10-18)", async () => {
    // The REAL sandbox /file/content answers 200 {"type":"text","content":""}
    // for a MISSING path — the readFile 404→null branch never fires against it
    // (sandbox-gateway.ts). Under that wire shape a brand-new session read ""
    // for BOTH the sentinel and the marker, fell through the null check, and
    // the marker comparison `"" !== "2"` invented "legacy" — provisioning then
    // wrote a root-path start script beside a /<label> preview address: the
    // F-2 silent first-build 404, reproduced live three times (audit run
    // 2026-10-17T13-45Z isolated_run_2 and the 2026-10-18 clean-stack rerun
    // twice). The sentinel's absent-treatment must accept the empty-string
    // shape: a zero-byte package.json is not an assembled app, and the next
    // start WILL copy the template and stamp current — the same H1 reasoning
    // as the null case above, now pinned against the observed wire semantics.
    const generation = await readWebappGeneration(
      {
        async readFile() {
          return ""; // the deployed envelope's "absent"
        },
      },
      DIRECTORY,
    );
    expect(generation).toBe("current");
  });

  test("an empty-content body overrules a foreign marker exactly like an absent one (fix-ocr17 parity under the envelope shape)", async () => {
    // Under the envelope shape the sentinel's empty string IS the absent
    // population — the gateway cannot answer 404, so "" and missing are the
    // same wire fact. The fix-ocr17 marker-overrule parity must therefore
    // hold for it too: no assembled app, so the next start rebuilds from the
    // current template and re-stamps — the stale "1" marker must not win.
    const generation = await readWebappGeneration(
      fileApiWith({ [APP_BODY]: "", [MARKER_PATH]: "1" }),
      DIRECTORY,
    );
    expect(generation).toBe("current");
  });

  test("a marker present but the app ABSENT answers current — the next start rebuilds and re-stamps (fix-ocr17)", async () => {
    // The semantic divergence the reorder buys: the app body's absence proves
    // the copy branch WILL run on the next start, stamping current over
    // whatever the stale marker says. The pre-fix order let the stale marker
    // (or its gateway error) overrule the body — a foreign marker on an
    // unassembled app answered legacy against an app that will be born
    // current.
    const generation = await readWebappGeneration(
      fileApiWith({ [MARKER_PATH]: "1" }),
      DIRECTORY,
    );
    expect(generation).toBe("current");
  });

  // ── fix-ocr26 #8: a gateway FAILURE is not a generation VERDICT ──────────
  // The three-state answer: "legacy" and "current" are the two populations,
  // "unknown" is the read that could not be made. Folding a flaky read into
  // "legacy" rewrote a CURRENT session's answer to the old same-origin path
  // (webapp_url → /api/... → the dev server 404s it) and made preview-ticket
  // refuse 409 with a legacy-race sentence that describes nothing true. A
  // failed read now answers "unknown" — the conservative answer for the
  // CONSUMERS (webapp-info keeps the current-shape address it already minted,
  // the mint refuses 503 with a retryable sentence), never a fabricated
  // generational fact.
  test("an unreadable app body (gateway failure on the probe) answers unknown — a flake is not a verdict (fix-ocr26 #8)", async () => {
    // The probe threw: nothing here distinguishes the two absent-marker
    // populations — and nothing here may INVENT "legacy" either. RED: the
    // catch folded the flake into "legacy".
    const generation = await readWebappGeneration(
      fileApiWith({}, { throwsOn: { [APP_BODY]: true } }),
      DIRECTORY,
    );
    expect(generation).toBe("unknown");
  });

  test("an unreadable marker on a current session (marker '2' present, read flakes) answers unknown (fix-ocr26 #8)", async () => {
    // The exact harm shape: the marker IS current's own value and would read
    // "current" on a healthy gateway — the flake must not demote the session
    // to legacy. RED: the catch folded the flake into "legacy".
    const generation = await readWebappGeneration(
      fileApiWith(
        { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
        { throws: true },
      ),
      DIRECTORY,
    );
    expect(generation).toBe("unknown");
  });

  test("any other marker content on an ASSEMBLED app answers legacy (never guess forward)", async () => {
    // fix-ocr17 moved the probe order (body first): the foreign-marker rule
    // now governs exactly the population it was written for — an app that
    // EXISTS was assembled by something this code cannot see, so any marker
    // but current's own reads legacy. (An ABSENT app is the divergence case
    // above: the next start rebuilds and re-stamps, so it answers current.)
    const generation = await readWebappGeneration(
      fileApiWith({ [MARKER_PATH]: "1", [APP_BODY]: '{"name":"web"}' }),
      DIRECTORY,
    );
    expect(generation).toBe("legacy");
  });

  test("no file API at all answers legacy (conservative: the no-sandbox reads)", async () => {
    // NOT "unknown": a missing file API is a PERMANENT fact (no sandbox), not
    // a transient read failure — there is nothing to retry, and the surfaces
    // that consume it have their own no-sandbox shapes.
    const generation = await readWebappGeneration(null, DIRECTORY);
    expect(generation).toBe("legacy");
  });

  test("an unreadable workspace (the read flakes) gates the mount to null — unknown degrades like legacy at the script write (fix-ocr26 #8)", async () => {
    // The script write's conservative arm is null (no mount), not the label
    // derivation: deriving for an actually-legacy app would EXPORT the env and
    // silently re-mount it under /<label> while the pane answers the old path
    // (a non-self-healing 404, undetectable there — legacy has no mount
    // cross-check). Null for an actually-current app is CAUGHT downstream by
    // webapp-info's .webapp-mount cross-check, which withholds the address
    // behind the repair sentence. RED: the flake answered "legacy" and the
    // gate reached the same null for the wrong reason — now unknown is its
    // own answer, and the gate still refuses the mount for it.
    const resolve = generationGatedWebappBasePathFor({
      webappBasePathFor: () => "/abc123label",
      fileApiFor: () =>
        fileApiWith(
          { [MARKER_PATH]: WEBAPP_GENERATION_CURRENT },
          { throws: true },
        ) as never,
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => DIRECTORY,
    });
    expect(await resolve("cs-x")).toBeNull();
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

  test("a bare '/' mount falls back to the root-path script — a mount needs a label (fix-ocr15)", () => {
    // fix-ocr15: `/` matched the old `{0,64}` quantifier (a label of zero
    // characters) and the script exported a slash-only mount — the twin of
    // the template-side bug: the app mounted at basePath:"/" emits
    // `//api/...` resource URLs, which URL grammar reads as protocol-relative
    // and dispatches to a foreign origin. The empty label is the ROOT shape:
    // a bare slash degrades to it, exactly like an undefined or malformed
    // mount, and the .webapp-mount record follows the sanitized value.
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: "/",
    });
    expect(script).not.toContain("ONYX_WEBAPP_BASE_PATH=");
    expect(script).not.toContain("NEXT_PUBLIC_BASE_PATH=");
    // The record mirrors the script: the empty mount, not the rejected slash.
    expect(script).toContain(
      `printf '%s' '' > "$SESSION_PATH/${WEBAPP_MOUNT_MARKER}"`,
    );
  });

  test("an uppercase /<LABEL> mount is rejected — the minter only ever mints lowercase hex (fix-ocr17)", () => {
    // The whitelist carried a case-insensitive flag while the values it
    // guards are server-minted HMAC labels — always lowercase hex. With the
    // flag, a hand-supplied uppercase value slipped into the exported mount
    // that the derivation side can never produce; the case-sensitive pattern
    // keeps the accepted set exactly the minted shape.
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: "/ABC123",
    });
    expect(script).not.toContain("ONYX_WEBAPP_BASE_PATH=");
    expect(script).not.toContain("NEXT_PUBLIC_BASE_PATH=");
    // The record mirrors the script: the rejected uppercase value leaves the
    // empty mount, never the value itself.
    expect(script).toContain(
      `printf '%s' '' > "$SESSION_PATH/${WEBAPP_MOUNT_MARKER}"`,
    );
  });

  test("the app-body sentinel is single-sourced between the probe and the script template (fix-ocr15)", async () => {
    // The D10 judgment probes `<session>/outputs/web/package.json` to tell an
    // unassembled app from a pre-marker one; the start script's copy branch
    // checks the SAME file. Those two spellings were hand-mirrored literals —
    // drift between them silently misjudges current vs legacy — so the path
    // now lives in ONE exported constant and the script template interpolates
    // it. The value itself stays pinned (it names a real file), and the
    // template module may no longer carry its own copy of the literal: a
    // second spelling is the drift this constant exists to kill.
    expect(WEBAPP_APP_BODY_SENTINEL).toBe("outputs/web/package.json");
    const script = buildWebappBootstrapScript({
      sessionDirectory: DIRECTORY,
      port: 3011,
      basePath: null,
    });
    // The copy branch's existence check rides the constant.
    expect(script).toContain(
      `[ ! -f "$SESSION_PATH/${WEBAPP_APP_BODY_SENTINEL}" ]`,
    );
    // ...and the module sources the path from nowhere else.
    const source = await readFile(
      join(import.meta.dir, "../src/craft/nextjs-dev.ts"),
      "utf8",
    );
    expect(source).not.toContain("outputs/web/package.json");
  });

  test("a botIdFor rejection degrades to null — every gated read's failure answers legacy (fix-ocr15)", async () => {
    // The module header promises that every DEGRADED read of the gate falls
    // back the conservative way; a botId resolver rejection used to pierce
    // the gate and propagate — a caller scripting against the documented
    // fallback contract would see a throw for a merely-unavailable resolver.
    const resolve = generationGatedWebappBasePathFor({
      webappBasePathFor: () => "/abc123label",
      fileApiFor: () => fileApiWith({}) as never,
      botIdFor: async () => {
        throw new Error("resolver down");
      },
      sessionDirectoryFor: () => DIRECTORY,
    });
    expect(await resolve("cs-x")).toBeNull();
  });

  test("a webappBasePathFor rejection degrades to null — the shape derivation is a gated read too (fix-ocr17)", async () => {
    // The twin of the botIdFor fallback above: the async shape derivation is
    // the gate's LAST read, and a rejection there used to propagate straight
    // through `await` — provisioning (the start-script write) failed as a
    // whole for a merely-unavailable derivation, violating the module header's
    // "every degraded read answers conservatively" contract. Null (legacy: no
    // mount) is the conservative answer, exactly like every other failure.
    const resolve = generationGatedWebappBasePathFor({
      webappBasePathFor: async () => {
        throw new Error("origin derivation down");
      },
      fileApiFor: () =>
        fileApiWith({ [MARKER_PATH]: WEBAPP_GENERATION_CURRENT }) as never,
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => DIRECTORY,
    });
    expect(await resolve("cs-x")).toBeNull();
  });

  test("a throwing fileApiFor degrades to null — the SYNC injections are gated reads too (fix-ocr28 #10)", async () => {
    // fix-ocr15/#17 wrapped the async seams (botIdFor, webappBasePathFor)
    // but left the two SYNC injections bare: a throwing fileApiFor pierced
    // the returned async function and rode writeWebappBootstrapScript's
    // `await webappBasePathFor?.(sessionId)` up into provisioning as a
    // whole — the exact pattern the module header's "every degraded read
    // falls back conservatively" promise exists to prevent. Null (legacy:
    // no mount) is the conservative answer, mirroring the async twins.
    const resolve = generationGatedWebappBasePathFor({
      webappBasePathFor: () => "/abc123label",
      fileApiFor: () => {
        throw new Error("gateway wiring down");
      },
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => DIRECTORY,
    });
    expect(await resolve("cs-x")).toBeNull();
  });

  test("a throwing sessionDirectoryFor degrades to null — the second sync injection, same contract (fix-ocr28 #10)", async () => {
    const resolve = generationGatedWebappBasePathFor({
      webappBasePathFor: () => "/abc123label",
      fileApiFor: () =>
        fileApiWith({ [MARKER_PATH]: WEBAPP_GENERATION_CURRENT }) as never,
      botIdFor: async () => "craft-bot",
      sessionDirectoryFor: () => {
        throw new Error("config wiring down");
      },
    });
    expect(await resolve("cs-x")).toBeNull();
  });
});
