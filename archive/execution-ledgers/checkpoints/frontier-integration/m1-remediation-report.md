# M1 Remediation Report — `final-state/manifest.md` refresh (verification.md / §8)

- **Task**: `task_087e5ca564c4` (dispatch `ctx_fe25de835e0d`), medium M1 remediation from `independent-review.md` §7.
- **Worktree**: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-frontier-integration`, branch `1123786563/issue5-frontier-integration`, HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (== BASE), staged diff empty — unchanged before, during, and after this remediation. No commit made.
- **Root cause (M1 as found)**: the integrator appended §8 "Final on-disk rerun (post-ledger, before worker_done)" to `verification.md` at 2026-10-15 18:56:09 CST — 94 min after the manifest snapshot (17:22:46 CST / 09:22:46Z) — leaving the manifest's `verification.md` hash row stale. Every other binding (38/39 rows, git identity, diff stat) was still exact.

## 1. Before / after (the affected hash row)

| Item | Value |
|---|---|
| Row | `docs/execution-ledgers/checkpoints/frontier-integration/verification.md` |
| Manifest row **before** (stale, pre-§8 file) | `678b5c686bddeefc711fee68fa46ebe6fc6260f93511798587b5be5e14a7a138` |
| On-disk / manifest row **after** (current, incl. §8) | `095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87` |
| Snapshot timestamp before | `2026-10-15T09:22:46Z` (original) |
| Snapshot timestamp after | `2026-10-15T11:10:00Z` (M1 refresh; original preserved in header & addendum) |
| `final-state/manifest.md` whole-file SHA-256 before → after | `380415f25382e356baced55bd1b730e8c25c3d60b4fc4edfc751b80332637c55` → `2c95b5bdfe905b7579c7e719b308878bfc15308865cbe4a1b286837aadcae111` (post-edit, §5) |

All 38 other hash rows are preserved byte-identically; only the `verification.md` row was recomputed.

## 2. Commands and results (pre-edit reproduction of M1)

```
$ shasum -a 256 docs/execution-ledgers/checkpoints/frontier-integration/verification.md
095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87  docs/.../verification.md

$ bash /tmp/verify-manifest.sh docs/execution-ledgers/checkpoints/frontier-integration/final-state/manifest.md
MISMATCH  path=docs/execution-ledgers/checkpoints/frontier-integration/verification.md
  manifest: 678b5c686bddeefc711fee68fa46ebe6fc6260f93511798587b5be5e14a7a138
  on-disk : 095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87
rows=39 match=38 mismatch=1        # exactly the reviewer's M1; no other drift

$ git rev-parse HEAD && git diff --cached | wc -l
f0520524f0faa2b4533b9d2f1aa692c8f907ba71
0                                  # git identity section still exact

$ git diff --stat
(6 files changed, 126 insertions(+) — byte-identical to the manifest's recorded section)
```

`/tmp/verify-manifest.sh` greps every `^[0-9a-f]{64}  ` row out of the manifest and `shasum -a 256`s each recorded path.

## 3. Edits made (scope: this checkpoint directory only)

1. `final-state/manifest.md`:
   - header now carries original snapshot `2026-10-15T09:22:46Z` **plus** M1-refresh timestamp `2026-10-15T11:10:00Z`;
   - `verification.md` hash row recomputed to `095ad5cb…` (the §8-bearing file); other 38 rows untouched;
   - `git status --porcelain -uall` section re-captured at refresh time (now also listing `independent-review.md`, this report, and the pre-existing entries; 6 modified tracked + 60 untracked = 66 rows);
   - appended dated **M1 remediation addendum** section (per the reviewer's recommended follow-up) recording before/after hash, reason, re-verification, and the SHA-256 of `independent-review.md` (`78d02ffb…`) so the review evidence is bound in prose without altering the 39-row table's scope;
   - git identity and `git diff --stat` sections unchanged (re-verified still exact).
2. `m1-remediation-report.md` (this file): created.

Not edited: production code, tests, migrations, `verification.md` and all other source evidence / ledger docs, source worktrees. Nothing staged, nothing committed.

## 4. I1 note (deliberate non-change)

`independent-review.md` I1 suggests *considering* hash-binding the 24 `sources/` copies. Out of M1 scope: the 39-row table keeps its original scope ("delivered production/test/migration file" + plan + 7 ledger docs); `sources/` remain git-status-listed only. The addendum records `independent-review.md`'s hash; this report is intentionally not hash-bound anywhere (it is the remediation record itself).

## 5. Post-edit focused verification

All commands run from the worktree root after the manifest refresh:

```
$ bash /tmp/verify-manifest.sh docs/execution-ledgers/checkpoints/frontier-integration/final-state/manifest.md
rows=39 match=39 mismatch=0

$ diff <(manifest's recorded git-status listing) <(git status --porcelain -uall)   # blank-stripped
STATUS-LISTING-IDENTICAL (66 rows)

$ git rev-parse HEAD && git diff --cached | wc -l
f0520524f0faa2b4533b9d2f1aa692c8f907ba71
0

$ git diff --stat
(6 files changed, 126 insertions(+) — still byte-identical to the manifest section; no tracked file touched by this remediation)

$ shasum -a 256 final-state/manifest.md verification.md independent-review.md
2c95b5bdfe905b7579c7e719b308878bfc15308865cbe4a1b286837aadcae111  …/final-state/manifest.md      (refreshed manifest)
095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87  …/verification.md              (== refreshed manifest row)
78d02ffb5294d35f1c3fc7080fe69805bdf4de60adc03e028286e594e8c7716b  …/independent-review.md        (== addendum prose binding)
```

**Result: PASS — M1 closed.** The refreshed manifest binds the current §8-bearing `verification.md`
exactly (39/39 rows), its git-status listing matches the live 66-row `git status --porcelain -uall`,
git identity and diff-stat remain exact, and every claim in the addendum is verified above. The
manifest can now be used as the canonical final-state reference the reviewer condition asked for
("before this manifest is used as the canonical reference").
