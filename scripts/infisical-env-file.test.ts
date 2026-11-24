import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { renderEnv } from "./infisical-env-file";

const VALUES = {
  PLAIN: "postgres://u:p@h:5432/db,a=b-c",
  DOLLAR: "a$HOME.b`id`",
  HASH: "a#b",
  QUOTES: `a'"b`,
  MULTILINE: "first line\nsecond line",
  BACKSLASH: "a\\b",
  EMPTY: "",
};

// What OpenBot's own loader makes of the file, read back the way the server and scripts read it.
function reload(values: Record<string, string>): Record<string, string> {
  const file = join(tmpdir(), `env-file-${crypto.randomUUID()}`);
  writeFileSync(file, renderEnv(values));
  const env = JSON.parse(
    spawnSync(
      "bun",
      [`--env-file=${file}`, "-e", "console.log(JSON.stringify(process.env))"],
      {
        cwd: tmpdir(),
      },
    ).stdout.toString(),
  );
  return Object.fromEntries(Object.keys(values).map((key) => [key, env[key]]));
}

test("every value survives being loaded back by bun", () => {
  expect(reload(VALUES)).toEqual(VALUES);
});

test("a value with nothing to escape stays bare and the rest is quoted", () => {
  const lines = renderEnv({ PLAIN: VALUES.PLAIN, HASH: VALUES.HASH })
    .trimEnd()
    .split("\n");
  expect(lines[0]).toBe(`PLAIN=${VALUES.PLAIN}`);
  expect(lines[1]).toBe('HASH="a#b"');
});

test("a backslash beside a character that needs quoting is refused, not mangled", () => {
  expect(() => renderEnv({ KEY: "a\\b$c" })).toThrow("KEY holds a backslash");
});
