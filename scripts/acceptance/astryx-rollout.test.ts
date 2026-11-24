import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archive } from "../web-build-archive";

// The drill's own port (34920) may be in use by a rehearsal, so the harness is pointed elsewhere.
const harness = "scripts/acceptance/astryx-rollout.mjs";
const env = { ...process.env, ISSUE17_DIR: "" };

test("the drill stops when the origin no longer serves an archived asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "astryx-rollout-"));
  try {
    await mkdir(join(root, "old/assets"), { recursive: true });
    await Bun.write(join(root, "old/index.html"), "<html>old</html>");
    await Bun.write(
      join(root, "old/assets/app-old11.js"),
      "console.log('old')",
    );
    await mkdir(join(root, "candidate/assets"), { recursive: true });
    await Bun.write(
      join(root, "candidate/index.html"),
      "<html>candidate</html>",
    );
    await Bun.write(
      join(root, "candidate/assets/app-new33.js"),
      "console.log('new')",
    );
    const store = join(root, "archives");
    const old = `${await archive(join(root, "old"), store)}.json`;
    const candidate = `${await archive(join(root, "candidate"), store)}.json`;
    // Only the candidate is served: a symlink swap with nothing carried over.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const file = Bun.file(
          join(root, "candidate", new URL(request.url).pathname),
        );
        return (await file.exists())
          ? new Response(file)
          : new Response("not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;

    const failed = Bun.spawn(["bun", harness, "personal", "enabled"], {
      env: {
        ...env,
        ISSUE17_ORIGIN: origin,
        ISSUE17_BUILDS: [old, candidate].join(","),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(failed.stderr).text();

    expect(await failed.exited).not.toBe(0);
    expect(stderr).toContain(`${old}: /assets/app-old11.js served 404`);
    server.stop(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the drill refuses a switch or rollback without recorded builds", async () => {
  for (const phase of ["enabled", "rollback", "retired"]) {
    const failed = Bun.spawn(["bun", harness, "personal", phase], {
      env: { ...env, ISSUE17_BUILDS: "", ISSUE17_ORIGIN: "http://127.0.0.1:1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(failed.stderr).text();
    expect(await failed.exited).not.toBe(0);
    expect(stderr).toContain("ISSUE17_BUILDS is required");
  }
}, 30_000);
