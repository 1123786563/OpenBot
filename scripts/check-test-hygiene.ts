/**
 * A suite file must not take a port for itself at import time.
 *
 * Collection runs every file a group selects, so a `serve({ port: 4600 })` bound while a file is
 * merely loaded is a claim on that port for the whole process. Two runs then disagree about their
 * own result: the one that arrives second dies on EADDRINUSE and its verdict stops at "unjudged",
 * which reads as a broken migration rather than as a port nobody can share. It is not the file's
 * fault and not the compat layer's to hide — making Node quietly fall back to another port would
 * erase the one fact worth keeping, that this suite assumes a fixed port.
 *
 * The fix is the one `.archive/runs/legacy-plans/2026-10-18-e2e-tester-army/2026-10-18-e2e-tester-army-migration-status.md` already records:
 * ask for port 0 and read back what was bound. `serve()` in tests/support/bun-compat.ts answers
 * with `server.port` for exactly that, and its own comment says a snapshot of the requested value
 * would hand back `http://127.0.0.1:0`.
 *
 *     bun scripts/check-test-hygiene.ts
 */

/**
 * Files carrying a fixed port on purpose, with the reason still owed a fix.
 *
 * Listed rather than silenced, so removing an entry is the same act as fixing the file.
 */
const KNOWN_FIXED_PORT_FILES = new Set([
  // Bound at module scope and asserted by literal downstream (`ses_4600`, `served: "4600"`), so
  // converting it means re-running the suite, not just editing: see the status doc's F-G note.
  "agent-sandbox/tests/proxy.test.ts",
]);

// `--others` is the point: a violation is written before it is staged, and a check that only reads
// the index passes the run that introduced it. Ignored paths stay out via `--exclude-standard`.
const files = Bun.spawnSync(
  [
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.ts",
    "*.tsx",
  ],
  { stdout: "pipe" },
);
if (files.exitCode !== 0) {
  console.error(
    "::error::git ls-files failed; this check enumerates tracked and unstaged files, not a directory walk.",
  );
  process.exit(2);
}

/** Every top-level `const x = serve({ … })`, located so the reported line is the port's own. */
function topLevelServeCalls(
  source: string,
): { body: string; bodyAt: number }[] {
  const found: { body: string; bodyAt: number }[] = [];
  for (const match of source.matchAll(
    /^const\s+\w+\s*=\s*(?:await\s+)?serve\(\s*\{/gm,
  )) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      const character = source[cursor];
      if (character === "{" || character === "(" || character === "[")
        depth += 1;
      else if (character === "}" || character === ")" || character === "]")
        depth -= 1;
      cursor += 1;
    }
    found.push({ bodyAt: open + 1, body: source.slice(open + 1, cursor - 1) });
  }
  return found;
}

let bad = 0;
for (const file of new TextDecoder()
  .decode(files.stdout)
  .split("\0")
  .filter(
    (path) => /(^|\/)tests?\//.test(path) && /\.test\.tsx?$/.test(path),
  )) {
  if (KNOWN_FIXED_PORT_FILES.has(file)) continue;
  const source = await Bun.file(file).text();
  for (const { body, bodyAt } of topLevelServeCalls(source)) {
    const literal = /port:\s*(\d{2,5})\b/.exec(body);
    if (!literal) continue;
    const line = source
      .slice(0, bodyAt + (literal.index ?? 0))
      .split("\n").length;
    console.error(
      `::error::${file}:${line} binds port ${literal[1]} at module scope, so any run that loads this file owns that port.`,
    );
    bad += 1;
  }
}

if (bad === 0) {
  console.log(
    `No test file binds a fixed port at import time (${KNOWN_FIXED_PORT_FILES.size} known exception(s), listed in the script).`,
  );
}
process.exit(bad === 0 ? 0 : 1);
