import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSnapshot,
  restoreArchive,
  SNAPSHOT_SENTINEL,
  snapshotHasSentinel,
} from "../src/snapshot";

/**
 * The snapshot round trip against real tar and a real tree: what the archive holds, what the
 * sentinel proves, and what a foreign archive is refused for.
 */
let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "snap-test-"));
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(workspace, "only.txt"), "only in the original", "utf8");
  await writeFile(join(workspace, "sub", "deep.txt"), "deep", "utf8");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("workspace snapshots (S4)", () => {
  test("the round trip: snapshot → mutate → restore → the tree is the archived one", async () => {
    const archive = await createSnapshot({ botWorkspace: workspace, botId: "snap-bot" });
    expect(archive.length).toBeGreaterThan(100); // A real gzip, not an empty stream.

    // The workspace drifts after the snapshot (a turn ran, files changed).
    await rm(join(workspace, "only.txt"));
    await writeFile(join(workspace, "new.txt"), "written after the snapshot", "utf8");

    const restored = await restoreArchive(archive, workspace);
    expect(restored).toEqual({ ok: true });
    // The restored tree is the ARCHIVED one: only.txt back, new.txt gone (replace, not merge).
    expect(await readFile(join(workspace, "only.txt"), "utf8")).toBe("only in the original");
    expect(await readFile(join(workspace, "sub", "deep.txt"), "utf8")).toBe("deep");
    const newFile = await readFile(join(workspace, "new.txt"), "utf8").catch(() => null);
    expect(newFile).toBeNull();
    // And the sentinel rides at the root, naming its bot.
    expect((await readFile(join(workspace, SNAPSHOT_SENTINEL), "utf8")).startsWith("snap-bot")).toBe(
      true,
    );
  });

  test("the sentinel check refuses a foreign archive", async () => {
    const foreignDir = await mkdtemp(join(tmpdir(), "snap-foreign-"));
    try {
      await writeFile(join(foreignDir, "innocent.txt"), "not a snapshot", "utf8");
      // An archive this module never wrote: a valid EMPTY tar (the two zero blocks) that
      // gzip holds — structurally an archive, and carrying no sentinel, because nothing
      // does. (createSnapshot always plants one, so a real snapshot cannot play the
      // foreign role; the role belongs to an archive from anywhere else.)
      const { gzipSync } = await import("node:zlib");
      const foreign = new Uint8Array(gzipSync(Buffer.alloc(1024)));
      expect(await snapshotHasSentinel(foreign)).toBe(false);
      const restored = await restoreArchive(foreign, workspace);
      expect(restored).toEqual({ ok: false, reason: "no-sentinel" });
    } finally {
      await rm(foreignDir, { recursive: true, force: true });
    }
  });
});
