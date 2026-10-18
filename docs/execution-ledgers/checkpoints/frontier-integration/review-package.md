# Frontier Integration — Review Package (for the independent read-only Pi reviewer)

## Object under review

Uncommitted workspace checkpoint of `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-frontier-integration` @ HEAD `f0520524f0faa2b453b9d2f1aa692c8f907ba71` (== BASE; `git diff --cached` empty; all changes unstaged/untracked). Scope = exactly: 6 modified tracked files + 31 untracked server files + this ledger + the plan copy (full list and hashes: `final-state/manifest.md`).

## Suggested verification path

1. **Transfer integrity**: recompute `shasum -a 256` for the 25 deliverables against `transfer.md`'s table and the source worktrees (`issue5-207-timeout`, `issue5-209`, `issue5-215`, `issue5-234`); confirm sources untouched.
2. **Shared merges**: `diff` child `config.ts` vs each source (expect 0 deletions each way); check `schema/index.ts` / `drizzle.config.ts` diffs vs BASE are the three additive lines.
3. **Migrations/snapshots**: read `migration-adjudication.md`; re-assert the chain invariants (prevId continuity 0121→0124; historical trees deep-equal; one new subtree each; journal idx/tag/when ↔ file names; `git diff HEAD -- server/drizzle/meta/` shows only `_journal.json` +21 lines).
4. **Runtime**: rerun the GREEN battery (`verification.md` §3) serially on the designated/dedicated DBs; optionally re-apply from scratch on a fresh dedicated DB and compare the last three `__drizzle_migrations.hash` values.
5. **Static**: `bun run typecheck`; `bunx biome lint --error-on-warnings <changed files>`; `bunx drizzle-kit check --config=drizzle.config.ts` (expect exit 0 + the two historical collision notes only).

## Review focus requested by the dispatch

- Both #207 and #209 config contracts survive the `config.ts` merge (no field/rule lost or reordered semantics).
- Migration numbering/journal/snapshot invariants; #215 review F1 properly closed; pre-existing collisions untouched.
- PayerRef sole payer identity; #234 registry grants nothing; no gateway enablement; no mount of gateway routes.
- No files outside the allowed list changed; nothing committed; sources unmodified.

## Pointers

- Plan: `docs/superpowers/plans/2026-10-15-issue5-frontier-integration.md`
- Ledger: `transfer.md`, `migration-adjudication.md`, `red.md`, `green.md`, `verification.md`, `final-state/manifest.md`, this file, `report.md`
- Source checkpoint docs & reviews (verbatim copies): `sources/207/` (incl. `f1-repair/final-review.md`), `sources/209/` (incl. `final-review.md`), `sources/215/`, `sources/234/`
- Parent context: `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-execution` (Specs/ADRs/CONTEXT/Issue snapshot)
