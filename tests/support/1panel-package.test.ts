import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageDir } from "./1panel-package";

/** The package directory is named for the release it ships, so the tests find it rather than name it. */
test("finds the one version directory of every packaged app, with the file the tests read", () => {
  for (const [app, file] of [
    ["hindsight", "data.yml"],
    ["openobserve", "docker-compose.yml"],
    ["openbot", "docker-compose.yml"],
  ] as const)
    expect(existsSync(join(packageDir(app), file))).toBe(true);
});

test("refuses an app that does not ship exactly one version directory", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-1panel-packages-"));
  try {
    mkdirSync(join(root, "two", "1.0.0"), { recursive: true });
    mkdirSync(join(root, "two", "1.1.0"), { recursive: true });
    expect(() => packageDir("two", root)).toThrow(
      "exactly one version directory",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
