# Baseline gates — measured before dispatching the frontier wave

Measured 2026-10-15 so an implementer can tell its own failure from a pre-existing one.
Every line below is an actual command run and its actual result, not an expectation.

## Where it was measured

| Workspace | Branch | HEAD |
| --- | --- | --- |
| `/Users/wuyongjun/trea/OpenBot` (Orca `main`) | `refs/heads/main` | `bae1f0ff` |
| `/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration` | `refs/heads/1123786563/opik-integration` | `ad8ab81e` |

`main` is being advanced concurrently by the Bifrost and multitenancy workstreams, so
"current with main" is only ever true as of a specific sha. The opik branch contains all of
main as of `33df594a` (verified with `git merge-base --is-ancestor main HEAD`).

## GREEN gates — these must stay green

| Command | Result |
| --- | --- |
| `cd server && bun run typecheck` | exit 0, no diagnostics |
| `cd app && bun run typecheck` | exit 0, no diagnostics |
| `cd app && bun run build` | `✓ built in 17.05s`, exit 0 (chunk-size warning is pre-existing and not an error) |
| `bunx biome lint --error-on-warnings server/src/agents server/src/auth shared app/src/lib/i18n` | `Checked 81 files in 45ms. No fixes applied.` |
| `bun test app/src/components/settings/linked-accounts.test.tsx` | 31 pass, 0 fail |

## KNOWN RED — pre-existing, do NOT fix, do NOT count as yours

`server/tests/ready.test.ts` fails identically on `main` and on the opik branch:

```
0 pass, 3 fail
TypeError: undefined is not an object (evaluating 'app.routes.map')
  at route (node_modules/.bun/hono@4.13.4/.../hono-base.js:114:9)
  at createApp (server/src/app.ts)
```

It arrived on `main` with the concurrent workstreams' commits. It is out of scope for every
Opik ticket. If your change makes it fail *differently*, that is your regression; if it fails
the same way, record it as pre-existing and move on.

## Environment facts that change how you verify

- **No `.env` in Orca child worktrees.** `.env` is gitignored, so a fresh worktree does not
  have it. Verified that this does NOT block the gates above: `bun --env-file=.env` does not
  error when the file is absent, and `generate:app-config` (run by `pretest` /
  `pretypecheck` / `prebuild`) exits 0 without it. `cd app && bun run typecheck` and
  `bun run build` both pass with no `.env` present.
- **Do not copy `.env` into a child worktree.** It holds real credentials and the gates do
  not need it. If a test genuinely requires it, record the blocker instead of copying secrets.
- **`node_modules` is per-worktree and not installed by Orca setup.** This repo has
  `hookSettings: null` and `projectHostSetupMethod: null`, so `--setup run` has no repo hook
  to execute. If `bun test` cannot resolve modules, run `bun install` at the worktree root
  first and record that you did.
- **`TEST_DATABASE_URL` gates the real-PostgreSQL integration tests.** Without it they
  `describe.skipIf(...)` and report as skipped. Per the parent Spec and `failure_policy`,
  **skipped is not passed** — record it as unverified, never as green.
- **Direct `bun test <file>` does not run `pretest`.** The root `test` script does
  (`bun run generate:app-config` first). For app-side work prefer `cd app && bun run typecheck`,
  which chains `pretypecheck` correctly.

## What this means for the frontier wave

The five frontier tickets (#7 #8 #9 #11 #12) can each be verified with commands that are
green at baseline, so a RED they produce is genuinely their own:

| Ticket | Primary gate | Baseline |
| --- | --- | --- |
| #7 T01 | `bun test server/tests/opik-module-skeleton.test.ts` + `cd server && bun run typecheck` | file absent (new), typecheck green |
| #8 T02 | `bun test app/src/lib/i18n/ai-observability.test.ts` + `cd app && bun run typecheck` + `cd app && bun run build` | files absent (new), both gates green |
| #9 T03 | `bun test server/tests/opik-deployment.test.ts` + `docker compose ... config --quiet` | files absent (new); Docker availability is the worker's to confirm |
| #11 T05 | `bun test server/tests/opik-redaction.test.ts` | file absent (new) |
| #12 T06 | `bun test server/tests/opik-scope.test.ts` | file absent (new) |

## Checkpoint convention (avoids a shared-file write conflict)

`docs/tickets/opik-4/manifest.json` is owned by the coordinator, not by workers. Five
implementers editing it concurrently would conflict at integration. Each worker therefore
writes its own file:

```
docs/tickets/opik-4/checkpoints/T01.md   (T02.md, T03.md, T05.md, T06.md, ...)
```

containing: branch name, commit hashes, `git diff --name-only <base>..HEAD`, the exact
verification commands run with their real output, and any blocker. The coordinator folds
these into `manifest.json` `handoff.checkpoint` after review. An absent checkpoint file means
the ticket is not done, whatever the worker's prose says.
