import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./support/e2e-compat";

/*
 * scripts/test-db.ts --down must remove only containers this checkout created (#707). The name
 * prefix alone proved nothing: two closure runs deleted other checkouts' databases because every
 * checkout names its containers `openbot-test-db-<port>`. Ownership is now proven twice — a
 * `openbot.test-db.checkout` label naming the creating checkout, and the checkout's manifest —
 * and a container that fails either check is left alone.
 */
const hereDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(hereDir, ".."));
const script = join(repoRoot, "scripts", "test-db.ts");
const manifestPath = join(repoRoot, ".test-db-containers.json");
const CHECKOUT_LABEL = "openbot.test-db.checkout";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

function containerExists(name: string): boolean {
  try {
    docker(["inspect", name]);
    return true;
  } catch {
    return false;
  }
}

function remove(name: string): void {
  if (containerExists(name)) docker(["rm", "-f", name]);
}

test("test-db --down removes only containers this checkout created", () => {
  const stamp = Date.now().toString(36);
  const owned = `openbot-test-db-t${stamp}o`;
  const foreign = `openbot-test-db-t${stamp}f`;
  const legacy = `openbot-test-db-t${stamp}l`;
  // The manifest belongs to the script; this test must not eat a real checkout's record.
  const hadManifest = existsSync(manifestPath);
  const previousManifest = hadManifest
    ? readFileSync(manifestPath, "utf8")
    : null;
  try {
    docker([
      "run",
      "-d",
      "--name",
      owned,
      "--label",
      `${CHECKOUT_LABEL}=${repoRoot}`,
      "busybox:1.37",
      "sleep",
      "120",
    ]);
    // Another checkout's database: right prefix, wrong owner.
    docker([
      "run",
      "-d",
      "--name",
      foreign,
      "--label",
      `${CHECKOUT_LABEL}=/another/checkout/entirely`,
      "busybox:1.37",
      "sleep",
      "120",
    ]);
    // A pre-label container this checkout cannot prove: no label, not in the manifest.
    docker(["run", "-d", "--name", legacy, "busybox:1.37", "sleep", "120"]);
    writeFileSync(manifestPath, `${JSON.stringify([owned], null, 2)}\n`);

    execFileSync("bun", [script, "--down"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(containerExists(owned)).toBe(false);
    expect(containerExists(foreign)).toBe(true);
    expect(containerExists(legacy)).toBe(true);
  } finally {
    for (const name of [owned, foreign, legacy]) remove(name);
    if (previousManifest === null) rmSync(manifestPath, { force: true });
    else writeFileSync(manifestPath, previousManifest);
  }
});
