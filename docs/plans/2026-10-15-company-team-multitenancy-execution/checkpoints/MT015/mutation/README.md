# MT015 mutation checks (all captured, pristine SHA 8249a979… restored each time)

Target: server/src/enterprise/tenancy/scoped-keys.ts (pristine sha256
7a0867cbedefa4c093f99d35bc86cc4ec2a167891112fec0e3b51aeaabcaef95).
Focused suite = server/tests/multitenancy/scoped-keys.test.ts (30 cases,
dedicated test PostgreSQL env sourced — a skipped run would be a false
run; none of the five runs shows skips).

| MUT | Mutation (what broke) | Result | Captured by |
| --- | --- | --- | --- |
| MUT1 | ownership stripped from cache key (kind/version only) | exit 1, 14 fail | 验收 1 cross-scope (incl. DB case), key-grammar, validation |
| MUT2 | config version frozen out of readable keys (c=0/o=-) | exit 1, 8 fail | 验收 2 version-change (incl. both DB cases), adapter test |
| MUT3 | logical key embedded raw instead of one-way digest | exit 1, 4 fail | 验收 3 canary + digest-opacity + grammar |
| MUT4 | ownership dropped from vector-namespace digest input | exit 1, 3 fail | 验收 1 namespace distinctness, 验收 2 version tests |
| MUT5 | shared builder loses domain validation | exit 1, 2 fail | 验收 4 label rules, rejection-message battery |

Process notes (honest record):
- First MUT5 attempt was a FALSE RUN: the runner restored the pristine file
  *before* invoking the suite, so the mutant never ran (exit 0, meaningless).
  Detected immediately, runner fixed (mutate → run → restore → hash-verify),
  MUT5 re-run properly and captured. Same lesson as MT014 D5 / MT112 §7.5:
  exit 0 from a run that did not exercise the mutant is not a pass.
- MUT1 first application died on a perl interpolation error and MUT2's first
  replacement produced syntactically invalid code (module-load error = crash,
  not capture); both were redone as valid mutants. Guards now in the runner:
  mutation must diff non-empty against pristine before the run.
- After every restore, sha256 was re-verified equal to pristine
  (7a0867cbedefa4c093f99d35bc86cc4ec2a167891112fec0e3b51aeaabcaef95) — the
  final focused suite and the full regression ran on the pristine bytes.

## Post-rename re-check on final bytes

After the header-only issue-number correction (Issue #58, from the real
GitHub ticket; the initial header had guessed a wrong number) and the rename
of the test to cache-keys.test.ts (matching Issue #58's verification command
verbatim), the production file's bytes changed hash (pristine now
7a0867cb…). MUT3 was re-applied and re-run on the final bytes:
MUT3-final-bytes-recheck-TEST-FAILS.log — exit 1, 26 pass / 4 fail
(canary, digest-opacity, grammar, rejection-battery lines), restore
re-verified by hash. MUT1/MUT2/MUT4/MUT5 captures above were produced on
bytes differing from the final ones only in that one header comment line;
the mutated regions are untouched by that comment.
