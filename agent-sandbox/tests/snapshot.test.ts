import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
    const archive = await createSnapshot({
      botWorkspace: workspace,
      botId: "snap-bot",
    });
    expect(archive.length).toBeGreaterThan(100); // A real gzip, not an empty stream.

    // The workspace drifts after the snapshot (a turn ran, files changed).
    await rm(join(workspace, "only.txt"));
    await writeFile(
      join(workspace, "new.txt"),
      "written after the snapshot",
      "utf8",
    );

    const restored = await restoreArchive(archive, workspace);
    expect(restored).toEqual({ ok: true });
    // The restored tree is the ARCHIVED one: only.txt back, new.txt gone (replace, not merge).
    expect(await readFile(join(workspace, "only.txt"), "utf8")).toBe(
      "only in the original",
    );
    expect(await readFile(join(workspace, "sub", "deep.txt"), "utf8")).toBe(
      "deep",
    );
    const newFile = await readFile(join(workspace, "new.txt"), "utf8").catch(
      () => null,
    );
    expect(newFile).toBeNull();
    // And the sentinel rides at the root, naming its bot.
    expect(
      (await readFile(join(workspace, SNAPSHOT_SENTINEL), "utf8")).startsWith(
        "snap-bot",
      ),
    ).toBe(true);
  });

  test("the sentinel check refuses a foreign archive", async () => {
    const foreignDir = await mkdtemp(join(tmpdir(), "snap-foreign-"));
    try {
      await writeFile(
        join(foreignDir, "innocent.txt"),
        "not a snapshot",
        "utf8",
      );
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

/**
 * THE PRUNE, AND THE CRASH IT ENDS.
 *
 * This module holds the whole workspace in memory three times over (walk → tar → gzip), which
 * its own head justifies as "the workshop's workspaces are small". A CRAFT workspace is not:
 * it hosts every session of a Bot, and a scaffolded Next.js app grows a ~700MB node_modules
 * each. Measured live: /workspace at 1.9GB, 1.43GB of it two sessions' node_modules — and the
 * craft idle reaper snapshots it every 60s. The container (mem_limit 2g) went from 57MB idle
 * to 2,145,910,784 bytes — its hard ceiling — within 5s of a sweep tick, died, and restarted:
 * RestartCount 84 → 120 in half an hour, a clean 60s period. The snapshot always failed, so
 * the session was never flipped idle and stayed a candidate forever. Every restart took every
 * session's dev server with it, which is what made the craft preview answer "The web app is
 * not running" permanently.
 *
 * The rule is not "node_modules is big". It is: a directory whose entire contents are
 * reproducible from files that ARE archived does not belong in the archive. package.json +
 * bun.lock regenerate node_modules (start-webapp.sh already reinstalls on a missing
 * node_modules/.bin/next); a Next.js build regenerates .next; requirements regenerate .venv.
 * Pruning them took the same live workspace from 1.9GB to 19MB.
 */
describe("snapshot prune: derived trees stay out of the archive", () => {
  /** A workspace with one scaffolded webapp; returns its dir and a restore target. */
  async function scaffolded(): Promise<{ dir: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "snap-prune-"));
    const out = await mkdtemp(join(tmpdir(), "snap-prune-out-"));
    const web = join(dir, "cs-1", "outputs", "web");
    await mkdir(join(web, "node_modules", "next", "dist"), { recursive: true });
    await mkdir(join(web, ".next", "cache"), { recursive: true });
    await mkdir(join(web, ".venv", "lib"), { recursive: true });
    await mkdir(join(web, "__pycache__"), { recursive: true });
    await mkdir(join(web, ".git", "objects"), { recursive: true });
    await mkdir(join(web, "app"), { recursive: true });
    // The manifests a restore regenerates the derived trees FROM — these must survive.
    await writeFile(join(web, "package.json"), '{"name":"web"}', "utf8");
    await writeFile(join(web, "bun.lock"), "lockfile", "utf8");
    await writeFile(
      join(web, "app", "page.tsx"),
      "export default () => null",
      "utf8",
    );
    // Derived content, at depth, in every pruned tree.
    await writeFile(
      join(web, "node_modules", "next", "dist", "index.js"),
      "module",
      "utf8",
    );
    await writeFile(join(web, ".next", "cache", "blob"), "cache", "utf8");
    await writeFile(join(web, ".venv", "lib", "python.so"), "venv", "utf8");
    await writeFile(join(web, "__pycache__", "mod.pyc"), "pyc", "utf8");
    // .git is REAL state, not derived: the prune must not take it.
    await writeFile(join(web, ".git", "objects", "thing"), "object", "utf8");
    return { dir, out };
  }

  /** The restored tree's relative paths, sorted. */
  async function restoredPaths(
    archive: Uint8Array,
    out: string,
  ): Promise<string[]> {
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    expect(await restoreArchive(archive, out)).toEqual({ ok: true });
    const paths: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else
          paths.push(
            full
              .slice(out.length + 1)
              .split("\\")
              .join("/"),
          );
      }
    };
    await walk(out);
    return paths.sort();
  }

  test("node_modules/.next/.venv/__pycache__ are pruned whole; the manifests that regenerate them survive", async () => {
    const { dir, out } = await scaffolded();
    try {
      const archive = await createSnapshot({ botWorkspace: dir, botId: "b" });
      const paths = await restoredPaths(archive, out);
      const rooted = paths.map((p) => p.replace(/^cs-1\/outputs\/web\//, ""));

      expect(rooted).toContain("package.json");
      expect(rooted).toContain("bun.lock");
      expect(rooted).toContain("app/page.tsx");
      // Real state survives: the prune is about derived trees, not hidden ones.
      expect(rooted).toContain(".git/objects/thing");

      for (const derived of [
        "node_modules/next/dist/index.js",
        ".next/cache/blob",
        ".venv/lib/python.so",
        "__pycache__/mod.pyc",
      ]) {
        expect(rooted).not.toContain(derived);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test("the pruned bytes never enter the archive — the point is memory, not tidiness", async () => {
    const { dir, out } = await scaffolded();
    try {
      // 4MB of genuinely incompressible noise inside a pruned tree: if the walk read
      // it, the archive would carry it (gzip cannot shrink random bytes) and the
      // process would have held it in memory three times over. A cheap arithmetic
      // pattern will not do — `(i * k) % 251` has period 251 and gzip eats it.
      const noise = new Uint8Array(4 * 1024 * 1024);
      crypto.getRandomValues(noise);
      await writeFile(
        join(dir, "cs-1", "outputs", "web", "node_modules", "big.bin"),
        noise,
      );

      const archive = await createSnapshot({ botWorkspace: dir, botId: "b" });
      expect(archive.length).toBeLessThan(64 * 1024);
      await restoredPaths(archive, out);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });

  test("a workspace over the input ceiling is refused, not allocated — the OOM as a bounded error", async () => {
    // Defense in depth for the same failure with a different cause: whatever fills a
    // workspace, the answer must be a logged refusal the reaper survives, never a
    // 2GB allocation that takes the container (and every session's dev server) down.
    const dir = await mkdtemp(join(tmpdir(), "snap-cap-"));
    try {
      await writeFile(join(dir, "a.txt"), "a".repeat(2048), "utf8");
      await writeFile(join(dir, "b.txt"), "b".repeat(2048), "utf8");
      await expect(
        createSnapshot({
          botWorkspace: dir,
          botId: "b",
          maxInputBytes: 3000,
        }),
      ).rejects.toThrow(/3000/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the ceiling counts what the archive will hold, so a prune keeps a big workspace under it", async () => {
    const { dir } = await scaffolded();
    try {
      await writeFile(
        join(dir, "cs-1", "outputs", "web", "node_modules", "big.bin"),
        new Uint8Array(64 * 1024),
      );
      // 32KB: under the pruned tree's real bytes, far under the unpruned ones.
      const archive = await createSnapshot({
        botWorkspace: dir,
        botId: "b",
        maxInputBytes: 32 * 1024,
      });
      expect(archive.length).toBeGreaterThan(0);
      expect((await stat(join(dir, SNAPSHOT_SENTINEL))).size).toBeGreaterThan(
        0,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
