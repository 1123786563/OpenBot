# T05 independent validation

**Status: DONE_WITH_CONCERNS**  
**Revision:** `203d0f0244b2f898218fa12027089c631e8448d9` (`feat/heroui-v3-migration`), dirty worktree.  
**Scope:** T05 brief only; PRE/POST integrity, delta package, driven evidence, and P08–P15 static acceptance. No browser claims.

## Checkpoint validation

- Recomputed all 28 PRE/POST manifest entries and hashed POST snapshot bytes: all paths, byte lengths, and SHA-256 values match PRE. No missing or extra manifest path.
- PRE and POST staged patch (0 bytes), unstaged patch (601,561 bytes), status (7,456 bytes), and HEAD (41 bytes) are byte-identical. The large unstaged patch and dirty status are the already-present workspace baseline; their identity across the task corroborates no task delta.
- Delta summary says `PRE paths: 28 / Changed from PRE: 0`; `changed-paths.txt` contains only its newline. No patch file exists because there are no changes to package.
- Recalculated POST manifest SHA-256: `cbea14a5265998455b61bac8235c5babd35c3c31fb74e85f70f59ea91fcb8e3b`, matching T05 implementation report.

## Driven evidence

`docs/verification/workspace-redesign/t05/impl/driven/report.json` reports runner `e2e 0.20.0`, `bun`-driven project `openbot-unit`, commit above, dirty worktree, status passed, exit 0; 7,947 discovered, 6 selected/executed, 6 passed, 0 failed, 0 interrupted, 0 flaky, 0 skipped. The six executed groups match the implementation report's assertion. The run output is consistent with the recorded command:

```sh
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t05/impl/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

The report JSON does not embed the literal shell command. It contains only the selected outer suite file in test result metadata, so the mapping of six groups to the seven listed test files is supported by the implementation report, not independently derivable from this JSON alone. Native partition and Biome were not run; this is reasonable for an unchanged task checkpoint and no changed T05 source/test paths.

## Static acceptance spot check

Inspected the T05-owned `BotSubpage` and `PageShell` source at this revision. `BotSubpage` keeps a common back link, pending/error/content branches (`role="alert"` on unreachable error), and delegates layout to `PageShell`; `PageShell` defaults to `prose`, whose class is `max-w-2xl` (42rem/672px with 16px root). This supports the brief's shared 672px configuration group and consistent resource-error shell at source level. The eight distinct route files and seven listed behavior tests are present in the exact unchanged checkpoint.

No independent claim is made that each P08–P15 requirement passes. Since all 28 owned paths are unchanged from PRE, this validation establishes no-change integrity and reuses existing driven evidence; source-level behavior assertions, visual state, responsive rendering, accessibility interaction, and browser outcomes are not newly observed. The brief defers rendered browser testing, and T05 implementation report explicitly marks those limits. Treat them as acceptance gaps for eventual controlled browser validation, not as passed criteria.

## Commands

```sh
git rev-parse HEAD
git status --short
python3 - <<'PY'
# Compared all 28 PRE/POST manifest path/hash/byte tuples and SHA-256 of every POST snapshot.
PY
cmp PRE/status.txt POST/status.txt
cmp PRE/head.txt POST/head.txt
jq '.run.summary, .run.vcs, .run.status, .run.exitCode' docs/verification/workspace-redesign/t05/impl/driven/report.json
```

All checkpoint comparisons passed. No source, test, or remote issue was modified; no test command was rerun.
