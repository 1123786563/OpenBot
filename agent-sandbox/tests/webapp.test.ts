import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebappFile, startWebapp, stopWebapp } from "../src/webapp";

/**
 * The static road against a real temp tree: builds that exist, builds that don't, and paths
 * that try to leave. No process ever starts — that is the road's whole identity.
 */
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "webapp-test-"));
  await mkdir(join(root, "alpha", "webapp"), { recursive: true });
  await writeFile(
    join(root, "alpha", "webapp", "index.html"),
    "<html>built artifact</html>",
  );
  await mkdir(join(root, "alpha", "webapp", "assets"), { recursive: true });
  await writeFile(
    join(root, "alpha", "webapp", "assets", "app.js"),
    "console.log(1)",
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A getter, not a snapshot: `root` is assigned in beforeAll, after this line first runs. */
const ROOTS = {
  get workspaceRoot() {
    return root;
  },
};

describe("the static webapp road (S3)", () => {
  test("start succeeds for a Bot with a build, and refuses one without — 404-shaped", async () => {
    const built = await startWebapp(ROOTS, "alpha");
    expect(built).toMatchObject({
      ok: true,
      root: join(root, "alpha", "webapp"),
    });
    const empty = await startWebapp(ROOTS, "never-built");
    expect(empty).toEqual({ ok: false, reason: "not-built" });
  });

  test("stop is a no-op that keeps the verb symmetric", async () => {
    expect(await stopWebapp()).toEqual({ ok: true });
  });

  test("files serve with content types; the index is the empty path", async () => {
    const index = await readWebappFile(ROOTS, "alpha", "");
    expect(index?.contentType).toContain("text/html");
    expect(
      new TextDecoder().decode(index?.bytes ?? new Uint8Array()),
    ).toContain("built artifact");
    const script = await readWebappFile(ROOTS, "alpha", "assets/app.js");
    expect(script?.contentType).toContain("text/javascript");
  });

  test("an unbuilt route falls back to the SPA index; a total miss is null", async () => {
    const route = await readWebappFile(ROOTS, "alpha", "some/client/route");
    expect(route).not.toBeNull();
    expect(
      new TextDecoder().decode(route?.bytes ?? new Uint8Array()),
    ).toContain("built artifact");
    // A Bot with no build answers null for everything, including the index.
    expect(await readWebappFile(ROOTS, "never-built", "")).toBeNull();
  });

  test("a path that climbs out of the webapp root is null — not yours, not found", async () => {
    expect(await readWebappFile(ROOTS, "alpha", "../../etc/passwd")).toBeNull();
    expect(await readWebappFile(ROOTS, "alpha", "/etc/passwd")).toBeNull();
  });
});
