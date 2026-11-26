import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The package directory of a 1Panel app, by name. It is named for the release it ships, so a
 * version bump must not break the tests that read it; exactly one such directory is expected.
 */
export function packageDir(
  app: string,
  appsRoot = join(import.meta.dir, "../../deploy/1panel/apps"),
) {
  const versions = readdirSync(join(appsRoot, app), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  if (versions.length !== 1)
    throw new Error(
      `${app} should ship exactly one version directory, found ${versions.length}`,
    );
  return join(appsRoot, app, versions[0].name);
}
