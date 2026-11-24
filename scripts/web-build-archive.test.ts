import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { archive, restore, verifyServedBuilds } from "./web-build-archive";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const OLD = {
  "index.html": '<script type="module" src="/assets/app-old11.js"></script>',
  "assets/app-old11.js": "console.log('old')",
  "assets/app-old22.css": "body{color:red}",
};
const CANDIDATE = {
  "index.html": '<script type="module" src="/assets/app-new33.js"></script>',
  "assets/app-new33.js": "console.log('new')",
};

async function writeBuild(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await Bun.write(join(dir, path), content);
  }
  return dir;
}

async function scratch() {
  return mkdtemp(join(tmpdir(), "web-build-archive-"));
}

const keep = { sanitizeResources: false, sanitizeErrors: false };

test(
  "archive records the release commit, the index digest and every static asset",
  async () => {
    const root = await scratch();
    const build = await writeBuild(join(root, "build"), OLD);
    const dist = join(root, "dist");
    await symlink(build, dist);
    const store = join(root, "archives");
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();

    const archived = await archive(dist, store);

    const manifest = JSON.parse(await readFile(`${archived}.json`, "utf8"));
    expect(manifest.commit).toBe(commit);
    expect(manifest.indexSha256).toBe(sha256(OLD["index.html"]));
    expect(manifest.assets).toEqual({
      "assets/app-old11.js": sha256(OLD["assets/app-old11.js"]),
      "assets/app-old22.css": sha256(OLD["assets/app-old22.css"]),
    });
    // The archive holds a copy, not the path it was taken from.
    await rm(build, { recursive: true });
    expect(await readFile(join(archived, "index.html"), "utf8")).toBe(
      OLD["index.html"],
    );
    await rm(root, { recursive: true, force: true });
  },
  keep,
);

test("archive keeps only the most recent builds", async () => {
  const root = await scratch();
  const build = await writeBuild(join(root, "build"), OLD);
  const store = join(root, "archives");
  await mkdir(join(store, "unrelated"), { recursive: true });
  const kept: string[] = [];
  for (let i = 0; i < 3; i++) {
    // Archives are named by the millisecond, so never two within one.
    await new Promise((done) => setTimeout(done, 5));
    kept.push(await archive(build, store, { keep: 2 }));
  }
  const names = kept.slice(1).map((dir) => dir.slice(store.length + 1));
  expect((await readdir(store)).sort()).toEqual(
    names.flatMap((name) => [name, `${name}.json`]).concat("unrelated"),
  );
  await rm(root, { recursive: true, force: true });
});

test("restore copies the build into an empty directory", async () => {
  const root = await scratch();
  const build = await writeBuild(join(root, "build"), OLD);
  const archived = await archive(build, join(root, "archives"));
  const target = join(root, "restored");

  await restore(archived, target);

  expect(await readFile(join(target, "index.html"), "utf8")).toBe(
    OLD["index.html"],
  );
  expect(await readFile(join(target, "assets/app-old11.js"), "utf8")).toBe(
    OLD["assets/app-old11.js"],
  );
  await rm(root, { recursive: true, force: true });
});

test("restore refuses a directory that already holds files", async () => {
  const root = await scratch();
  const build = await writeBuild(join(root, "build"), OLD);
  const archived = await archive(build, join(root, "archives"));
  const target = join(root, "restored");
  await Bun.write(join(target, "keep.txt"), "keep");

  await expect(restore(archived, target)).rejects.toThrow(
    `${target} is not empty`,
  );
  expect(await readdir(target)).toEqual(["keep.txt"]);
  await rm(root, { recursive: true, force: true });
});

test("restore rejects an archive whose index.html no longer matches", async () => {
  const root = await scratch();
  const build = await writeBuild(join(root, "build"), OLD);
  const archived = await archive(build, join(root, "archives"));
  await Bun.write(join(archived, "index.html"), "<html>replaced</html>");
  const target = join(root, "restored");

  await expect(restore(archived, target)).rejects.toThrow(
    `restored build differs from ${archived}.json: index.html`,
  );
  await rm(root, { recursive: true, force: true });
});

async function servedScratch() {
  const root = await scratch();
  const dirs = {
    old: join(root, "old"),
    candidate: join(root, "candidate"),
  };
  await writeBuild(dirs.old, OLD);
  await writeBuild(dirs.candidate, CANDIDATE);
  const store = join(root, "archives");
  const manifests = {
    old: `${await archive(dirs.old, store)}.json`,
    candidate: `${await archive(dirs.candidate, store)}.json`,
  };
  // Serves the pointed build like app/serve.ts: the file, else the client route.
  let current = dirs.old;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const file = Bun.file(join(current, pathname));
      if (await file.exists()) return new Response(file);
      const route = Bun.file(join(current, "index.html"));
      return pathname.includes(".") || !(await route.exists())
        ? new Response("not found", { status: 404 })
        : new Response(route);
    },
  });
  return {
    dirs,
    manifests,
    origin: `http://127.0.0.1:${server.port}`,
    pointTo: (dir: string) => {
      current = dir;
    },
    dispose: async () => {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a switch passes once the old assets are kept beside the candidate", async () => {
  const drill = await servedScratch();
  // Same-name files are identical in a hashed build, so a plain copy keeps both sets.
  await cp(
    join(drill.dirs.old, "assets"),
    join(drill.dirs.candidate, "assets"),
    { recursive: true },
  );
  drill.pointTo(drill.dirs.candidate);

  const { checked, problems } = await verifyServedBuilds(
    drill.origin,
    drill.manifests.old,
    drill.manifests.candidate,
  );

  expect(problems).toEqual([]);
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path.localeCompare(b.path);
  expect(checked.sort(byPath)).toEqual(
    [
      {
        path: "assets/app-new33.js",
        sha256: sha256(CANDIDATE["assets/app-new33.js"]),
      },
      {
        path: "assets/app-old11.js",
        sha256: sha256(OLD["assets/app-old11.js"]),
      },
      {
        path: "assets/app-old22.css",
        sha256: sha256(OLD["assets/app-old22.css"]),
      },
      { path: "index.html", sha256: sha256(CANDIDATE["index.html"]) },
    ].sort(byPath),
  );
  await drill.dispose();
});

test("a switch that drops the old assets is reported", async () => {
  const drill = await servedScratch();
  drill.pointTo(drill.dirs.candidate);

  const { problems } = await verifyServedBuilds(
    drill.origin,
    drill.manifests.old,
    drill.manifests.candidate,
  );

  expect(problems).toEqual([
    `${drill.manifests.old}: /assets/app-old11.js served 404, recorded ${sha256(
      OLD["assets/app-old11.js"],
    )}`,
    `${drill.manifests.old}: /assets/app-old22.css served 404, recorded ${sha256(
      OLD["assets/app-old22.css"],
    )}`,
  ]);
  await drill.dispose();
});

test("a rollback checks the restored index.html and its assets", async () => {
  const drill = await servedScratch();
  // The restored build is served as archived, with the candidate's chunks beside it.
  const restored = join(drill.dirs.candidate, "..", "restored");
  await restore(drill.manifests.old.slice(0, -".json".length), restored);
  await cp(join(drill.dirs.candidate, "assets"), join(restored, "assets"), {
    recursive: true,
  });
  drill.pointTo(restored);

  expect(
    (
      await verifyServedBuilds(
        drill.origin,
        drill.manifests.candidate,
        drill.manifests.old,
      )
    ).problems,
  ).toEqual([]);

  // Serving the candidate's index under the old name is the failure rollback exists to catch.
  await Bun.write(join(restored, "index.html"), CANDIDATE["index.html"]);
  expect(
    (
      await verifyServedBuilds(
        drill.origin,
        drill.manifests.candidate,
        drill.manifests.old,
      )
    ).problems,
  ).toEqual([
    `${drill.manifests.old}: /index.html served ${sha256(
      CANDIDATE["index.html"],
    )}, recorded ${sha256(OLD["index.html"])}`,
  ]);
  await drill.dispose();
});

test("a retained asset whose bytes changed is reported", async () => {
  const drill = await servedScratch();
  await cp(
    join(drill.dirs.old, "assets"),
    join(drill.dirs.candidate, "assets"),
    { recursive: true },
  );
  await Bun.write(
    join(drill.dirs.candidate, "assets/app-old11.js"),
    "console.log('changed')",
  );
  drill.pointTo(drill.dirs.candidate);

  expect(
    (
      await verifyServedBuilds(
        drill.origin,
        drill.manifests.old,
        drill.manifests.candidate,
      )
    ).problems,
  ).toEqual([
    `${drill.manifests.old}: /assets/app-old11.js served ${sha256(
      "console.log('changed')",
    )}, recorded ${sha256(OLD["assets/app-old11.js"])}`,
  ]);
  await drill.dispose();
});
