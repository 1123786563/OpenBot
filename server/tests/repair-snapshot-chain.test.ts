import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

const script = fileURLToPath(
  new URL("../scripts/repair-snapshot-chain.py", import.meta.url),
);
const migration = fileURLToPath(
  new URL("../drizzle/0140_reservation_locked_basis.sql", import.meta.url),
);

test("unhandled SQL in the replay scope fails loudly", async () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, runpy, sys",
        "module = runpy.run_path(sys.argv[1])",
        "state = json.loads((module['ROOT'] / 'meta' / '0139_snapshot.json').read_text())",
        "module['apply_sql'](state, sys.stdin.read())",
      ].join("\n"),
      script,
    ],
    {
      encoding: "utf8",
      input: await readFile(migration, "utf8"),
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unhandled SQL statement");
  expect(result.stderr).toContain("ADD CONSTRAINT");
});
