import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "../tests/support/e2e-compat";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const createdDirectories: string[] = [];
const expectedTail =
  "SYNTHETIC_EXPECTED_TAIL: preserve the child failure details";

async function createProjectWithFailingTest() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-test-ci-"));
  createdDirectories.push(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ scripts: { test: "bun synthetic-child.ts" } }),
  );
  // The seams this script spawns, so the wrapper runs against the fixture rather
  // than against this checkout's audit and runner.
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "scripts", "e2e-coverage-audit.mjs"),
    "process.exit(0);\n",
  );
  await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
  await writeFile(
    join(directory, "node_modules", ".bin", "e2e"),
    `#!/bin/sh\necho "${expectedTail}" >&2\nexit 7\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, "synthetic-child.ts"),
    String.raw`
export {};

const stderr = [
  "start of child stderr",
  ...Array.from(
    { length: 5000 },
    (_, index) => "filler-" + String(index).padStart(5, "0") + ": " + "x".repeat(200),
  ),
  "SYNTHETIC_EXPECTED_TAIL: preserve the child failure details",
].join("\n") + "\n";

if (!process.stderr.write(stderr)) {
  await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
}
process.exitCode = 7;
`,
  );
  return directory;
}

async function runBun(directory: string, script: string) {
  const proc = Bun.spawn(["bun", script], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

async function runBunThroughLogPipe(directory: string, script: string) {
  const proc = Bun.spawn(
    ["bash", "-o", "pipefail", "-c", 'bun "$1" 2>&1 | cat', "bash", script],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("preserves the child stderr tail before returning the child status", async () => {
  const directory = await createProjectWithFailingTest();

  const child = await runBun(directory, "synthetic-child.ts");
  expect(child.exitCode).toBe(7);
  expect(child.stdout).toBe("");
  expect(child.stderr).toContain(expectedTail);

  const fixedWrapper = await runBunThroughLogPipe(
    directory,
    join(hereDir, "test-ci.ts"),
  );
  expect(fixedWrapper.exitCode).toBe(7);
  expect(fixedWrapper.stderr).toBe("");
  expect(fixedWrapper.stdout).toContain(expectedTail);
  // The wrapper's own complaint rides the same pipe, so a reader of the log sees
  // why the count was refused as well as what the child said. Its path comes from
  // E2E_UNIT_OUTPUT, which is the caller's — assert the sentence, not the path.
  expect(fixedWrapper.stdout).toContain("Refusing to report a pass");
});
