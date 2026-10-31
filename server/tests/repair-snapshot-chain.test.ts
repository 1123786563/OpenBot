import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

const script = fileURLToPath(
  new URL("../scripts/repair-snapshot-chain.py", import.meta.url),
);
/*
 * The rebuild models tables, columns, indexes and constraints it knows how to fold, and skips the
 * statement shapes the journal test cannot see. Anything else must stop the rebuild rather than
 * pass through unmodelled — a snapshot that quietly omits a statement is the drift this script
 * exists to remove. A sequence is such a shape: nothing in the replay scope creates one.
 */
test("unhandled SQL in the replay scope fails loudly", () => {
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
      input: 'CREATE SEQUENCE "probe_sequence";',
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unhandled SQL statement");
  expect(result.stderr).toContain("CREATE SEQUENCE");
});
