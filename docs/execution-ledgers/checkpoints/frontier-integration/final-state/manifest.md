# Final state — 2026-10-15T09:22:46Z · M1-refreshed 2026-10-15T11:10:00Z

## git identity
```
HEAD: f0520524f0faa2b4533b9d2f1aa692c8f907ba71
branch: 1123786563/issue5-frontier-integration
staged diff: EMPTY (0 lines)
```

## git status --porcelain -uall (re-captured at M1 refresh 2026-10-15T11:10:00Z)
```
 M server/drizzle.config.ts
 M server/drizzle/meta/_journal.json
 M server/src/app.ts
 M server/src/audit.ts
 M server/src/config.ts
 M server/src/db/schema/index.ts
?? docs/execution-ledgers/checkpoints/frontier-integration/final-state/manifest.md
?? docs/execution-ledgers/checkpoints/frontier-integration/green.md
?? docs/execution-ledgers/checkpoints/frontier-integration/independent-review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/m1-remediation-report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/migration-adjudication.md
?? docs/execution-ledgers/checkpoints/frontier-integration/red.md
?? docs/execution-ledgers/checkpoints/frontier-integration/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/review-package.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/checkpoint-report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/f1-repair/final-review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/f1-repair/green.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/f1-repair/red.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/f1-repair/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/f1-repair/transfer.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/207/file-hashes.txt
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/checkpoint.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/f1-repair/green.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/f1-repair/plan.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/f1-repair/red.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/f1-repair/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/final-review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/209/review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/215/green.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/215/plan.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/215/red.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/215/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/215/review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/234/file-scope.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/234/red-evidence.txt
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/234/report.md
?? docs/execution-ledgers/checkpoints/frontier-integration/sources/234/review.md
?? docs/execution-ledgers/checkpoints/frontier-integration/transfer.md
?? docs/execution-ledgers/checkpoints/frontier-integration/verification.md
?? docs/superpowers/plans/2026-10-15-issue5-frontier-integration.md
?? server/drizzle/0122_gateway_endpoint_config.sql
?? server/drizzle/0123_payer_accounts.sql
?? server/drizzle/0124_bot_services.sql
?? server/drizzle/meta/0122_snapshot.json
?? server/drizzle/meta/0123_snapshot.json
?? server/drizzle/meta/0124_snapshot.json
?? server/src/billing/payer-account.ts
?? server/src/billing/payer-ref.ts
?? server/src/bots/admin-routes.ts
?? server/src/bots/service-registry.ts
?? server/src/db/schema/bots.ts
?? server/src/db/schema/gateway.ts
?? server/src/db/schema/payer.ts
?? server/src/gateway/config-store.ts
?? server/src/gateway/conversion-rate-store.ts
?? server/src/gateway/conversion-rate.ts
?? server/src/gateway/endpoint.ts
?? server/src/gateway/routes.ts
?? server/tests/bot-service-registry.integration.test.ts
?? server/tests/gateway-conversion-rate.integration.test.ts
?? server/tests/gateway-conversion-rate.test.ts
?? server/tests/gateway-endpoint-config.integration.test.ts
?? server/tests/gateway-endpoint-config.test.ts
?? server/tests/payer-account.integration.test.ts
?? server/tests/payer-ref.test.ts
```

## git diff --stat (unstaged tracked changes)
```
 server/drizzle.config.ts          |  3 ++
 server/drizzle/meta/_journal.json | 21 +++++++++++++
 server/src/app.ts                 | 24 ++++++++++++++
 server/src/audit.ts               |  9 ++++++
 server/src/config.ts              | 66 +++++++++++++++++++++++++++++++++++++++
 server/src/db/schema/index.ts     |  3 ++
 6 files changed, 126 insertions(+)
```

## Full SHA-256 of every delivered production/test/migration file
```
862310a5448474f162d35d20b7fa0dfca2a1c01e44d4196b29dc78ed0b6b9ec5  server/src/config.ts
672f238a5b28f1bfb9dd0c44e588b38e714f493198db3e82c2fdd86ba91e7d22  server/src/app.ts
0da2068da4dec90692a56bba4e8b3acbdb9aea600cc8a9368d96b909daaa75c0  server/src/audit.ts
ad8ae818e2d3ae24f774da69184611dd83df2fc92d5615e66c9f37d970577d72  server/src/db/schema/index.ts
a810103c1c5ebc8f28ace0b8e2c3568fcae663abe0c196443a1dac495c726c27  server/drizzle.config.ts
70d06c6dc5ab995b27d6a6af8178f92651fc3afd355c126c3b1b28791e842670  server/drizzle/meta/_journal.json
849f91868518de0f3651676ae3428ee3c8e747429a98a13df3ae166714128f2d  server/src/db/schema/gateway.ts
400b037abee54b7eaa265fd7a2100b57785e4ae794e9c696a796e58859b0db4a  server/src/db/schema/payer.ts
b9b7b557292c9aec6bac8bb2e2eb837e302dfcc673194862f1212d37a954338f  server/src/db/schema/bots.ts
45032acb713a05b02ba26f0cd9d9deccbb34adc9e526a40d8de99cd277891624  server/src/gateway/endpoint.ts
963f082e066142c8efc5191dc31352348331c84840a52e53dbf0e5db362b77c3  server/src/gateway/config-store.ts
da7e54dec6b9f12f90eccf3a56e225462834ea889c0c7910a42374993fbcc2f0  server/src/gateway/routes.ts
d43dbb35470fc705aae1f3a51dbab21a14c1dd770beff066cf0fce6997d33034  server/src/gateway/conversion-rate.ts
eda84eb8d7613ab55ac3259bc6af42ff51a60f099b299a8f4d9b81150e9d00fc  server/src/gateway/conversion-rate-store.ts
a31df1f4c871e699ec9fc29e5c9df665fe882e503d302de4d5caaeeee341109e  server/src/bots/service-registry.ts
26cf1dfbb99d8799ab52cb2c16ad537f435e64e24fa70b63f8d71d5dd8a795b7  server/src/bots/admin-routes.ts
774c3591f2d5cf9a265dffa47b1336fbb8d987909290d478e6046fab30ed499f  server/src/billing/payer-ref.ts
315e33e540b9a71d48897fc9cf582866472c10071c4366bc7c572dc19c3f0b60  server/src/billing/payer-account.ts
e452ae4f93086d2ca3d10a8b50e3a3db983e7d62ce8e3260811ac1e12da758d1  server/drizzle/0122_gateway_endpoint_config.sql
b3913af40da6fdacd716ba5fa10aac0d35513f8d1da9d137dd2ed94c4f4ae6ad  server/drizzle/0123_payer_accounts.sql
90bb0b592931641715a3e846c05a2ae171f37a087be47ffc55fd6a0081bbfc01  server/drizzle/0124_bot_services.sql
31b406c9d58917e6da33276120e4e59fe477bd40f90fd54fba50737f5f714ff9  server/drizzle/meta/0122_snapshot.json
e80086af7e658a160fb73c657b194dffab2603f5893001848fcbc7d66020a402  server/drizzle/meta/0123_snapshot.json
b84e9e7d12b558c54307382cbaa8887824ba29590d92817fc4e9c8ea69384779  server/drizzle/meta/0124_snapshot.json
9f027dc2a4cd5a29cb420b952565e8fd646d3438dafcc3af122fb0de7ee9cdc4  server/tests/gateway-endpoint-config.test.ts
c29326eea42388b66c42dd076508ab3d04bdb60a2f3e4d107bf3ec6ea7eae506  server/tests/gateway-endpoint-config.integration.test.ts
89813d5a4c0e7e39fa3ee0f7d20b5781a17f35285856fe66e0a8f94003af3b38  server/tests/gateway-conversion-rate.test.ts
50165a1c5ec6952962214fd92e37e8e754c9c9d017f810fbaae552850eea8357  server/tests/gateway-conversion-rate.integration.test.ts
461beb3a6abbc50c2864b1663898afd0a5041f44c28cbb07685a037e548c782d  server/tests/payer-ref.test.ts
3775308fc9366c376b19c75422adb72f3b3d6fdcf511c14d46080e16e9359f54  server/tests/payer-account.integration.test.ts
866f2979a7bb9d6b7e12aa085fac9037b6c821a707622a95e3bf186f972a53b4  server/tests/bot-service-registry.integration.test.ts
0234ed9fd7b52909ccacdc6112386230ba1e7ac5909548b41f698558d551cd3f  docs/superpowers/plans/2026-10-15-issue5-frontier-integration.md
05ec2b3505fba55a078217c97b61ce678e0d29b597b6d710ffa741226caacc67  docs/execution-ledgers/checkpoints/frontier-integration/transfer.md
d475c0d64e0b8a07342c533603a8c339265910fbede597312044bf92509b9e02  docs/execution-ledgers/checkpoints/frontier-integration/migration-adjudication.md
4c6aa5b05afb751176443c1236642c6dc35e66f3a4b127481a3f920f5dce5da4  docs/execution-ledgers/checkpoints/frontier-integration/red.md
016aad7451a44d018c64e025117510e194fe985f398c713c6f88a37c69990f35  docs/execution-ledgers/checkpoints/frontier-integration/green.md
095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87  docs/execution-ledgers/checkpoints/frontier-integration/verification.md
a9225575029f7e5caefed7d10ff82d031a2c66a8bb78010467cf9e4bb71df201  docs/execution-ledgers/checkpoints/frontier-integration/report.md
ab6a2c5df0a2c17e686c0271bf5ee11a9fb84ccc6a967a9a59efab37e86375e3  docs/execution-ledgers/checkpoints/frontier-integration/review-package.md
```

## M1 remediation addendum (2026-10-15T11:10:00Z)

The independent review (`independent-review.md`, §7 finding M1, recorded ~19:1x CST) found this
manifest stale for exactly one file: the integrator appended §8 "Final on-disk rerun
(post-ledger, before worker_done)" to `verification.md` at 18:56:09 CST — 94 min after the
original 09:22:46Z snapshot — so the table's `verification.md` row bound the pre-§8 file.

Remediation applied in this refresh:

- `verification.md` hash row recomputed:
  `678b5c686bddeefc711fee68fa46ebe6fc6260f93511798587b5be5e14a7a138` →
  `095ad5cbf7f22bc6c847e9efe8fa7f5f81eb3554fe352f6ed1a1dc5e4f595b87`
  (the current §8-bearing file; §8 content untouched — its claims were independently re-verified
  true by the review: 108/0 tests, typecheck exit 0, HEAD/scope unchanged).
- All other 38 hash rows preserved byte-identically; `git identity` and `git diff --stat`
  sections unchanged (re-verified exact at refresh time: HEAD `f0520524…`, staged diff empty,
  6 files changed, 126 insertions).
- The `git status` listing above was re-captured at refresh time: identical to the 09:22:46Z
  snapshot except +2 untracked rows — `independent-review.md` and `m1-remediation-report.md`
  (both created after the original snapshot). 6 modified tracked + 60 untracked = 66 rows.
- Review-evidence binding recorded here in prose (hash-table scope unchanged, per M1/I1 pairing):
  SHA-256 of `independent-review.md` =
  `78d02ffb5294d35f1c3fc7080fe69805bdf4de60adc03e028286e594e8c7716b`.
  `m1-remediation-report.md` (this remediation's own record) is git-status-listed only and
  intentionally not hash-bound here, since it records this manifest's refresh.

Focused verification after this refresh: all 39 hash rows match the on-disk files (39/39);
commands and output in `m1-remediation-report.md` §5. No commit and no stage was made;
production code, tests, migrations, source evidence, and source worktrees are untouched.
