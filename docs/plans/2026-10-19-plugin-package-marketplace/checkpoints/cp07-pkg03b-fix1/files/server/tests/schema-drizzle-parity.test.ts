import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

/**
 * OCR round 1, F1. The drizzle generator lists schemas explicitly, and its own
 * comment warns that a schema file missing from that list is invisible to
 * `generate` — the next generation would treat those tables as absent and could
 * emit destructive DDL. The enterprise package tables ride the MT-task track for
 * their DDL, but their typed schema is barrel-exported, so the generator must
 * still know the file exists. This pins that decision so a future edit cannot
 * silently drop it.
 */

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the enterprise package schema stays visible to the drizzle generator", () => {
  const barrel = readFileSync(
    join(serverRoot, "src/db/schema/index.ts"),
    "utf8",
  );
  expect(barrel).toContain('export * from "./enterprise-plugin-packages";');

  const config = readFileSync(join(serverRoot, "drizzle.config.ts"), "utf8");
  expect(config).toContain('"./src/db/schema/enterprise-plugin-packages.ts"');
});
