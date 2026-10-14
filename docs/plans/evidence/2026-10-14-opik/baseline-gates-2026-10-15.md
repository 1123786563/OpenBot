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

Measured **on this branch** after merging main and running `bun install` (see the correction below):

| Command | Result |
| --- | --- |
| `cd server && bun run typecheck` | exit 0, no diagnostics |
| `cd app && bun run typecheck` | exit 0, no diagnostics |
| `cd app && bun run build` | `✓ built in 17.05s`, exit 0 (chunk-size warning is pre-existing and not an error) |
| `bunx biome lint --error-on-warnings <your own changed files>` | clean |
| `bunx biome format <your own changed files>` | clean |
| `bun test app/src/components/settings/linked-accounts.test.tsx` | 31 pass, 0 fail |

### Correction: two gates I originally recorded wrong

The first version of this file claimed `cd server && bun run typecheck` was green and implied a
repo-wide biome run was a usable gate. **Both claims were wrong**, and three frontier workers
(T01, T05, T06) independently caught it, proved it was pre-existing rather than their own
regression, and refused to "fix" it. What I actually measured was `main`, not this branch.

1. **`cd server && bun run typecheck` was RED at this branch's base.** Measured on the opik
   worktree before merging main:
   ```
   src/craft/webapp-proxy.ts(417,7): error TS2322: Type 'Uint8Array<ArrayBufferLike> | undefined'
     is not assignable to type 'BodyInit | null | undefined'.
   src/openmuse-documents/fill.ts(1,34): error TS2307: Cannot find module 'pdf-lib' ...
   src/openmuse-documents/inspect.ts(11,8): error TS2307: Cannot find module 'pdf-lib' ...
   src/openmuse-documents/routes.ts(1,34): error TS2307: Cannot find module 'pdf-lib' ...
   src/openmuse-tasks/runner.ts(87,34): error TS2307: Cannot find module 'pdf-lib' ...
   ```
   Two distinct causes: `webapp-proxy.ts` was genuinely broken at the branch base and had since
   been fixed on `main`; the `pdf-lib` errors were a **stale `node_modules`** — the dependency is
   in `server/package.json` but was not installed in this worktree. Fixed by merging `main` and
   then running `bun install` (40 packages). Both gates are now genuinely green, re-measured.

2. **Repo-wide biome is RED at baseline and is not a usable gate.** Measured on the untouched
   base worktree and independently reproduced by T02 and T06 to the digit:
   ```
   bunx biome lint .    -> Checked 2243 files. Found 74 errors. Found 132 warnings. Found 29 infos.
   bunx biome format .  -> Checked 2222 files. Found 377 errors.
   bunx biome lint --error-on-warnings .  -> non-zero exit ("Some warnings were emitted")
   ```
   **Scope biome to your own changed files.** Never chase repo-wide lint/format noise: it is
   outside every ticket's owned_scope. `docs/tickets/opik-4/manifest.json` has been regenerated
   so all 37 tickets carry scoped biome commands instead of the repo-wide one I first derived.
   T06 also notes the methodological point that `node_modules/.bin/biome` (the locked version)
   and `bunx biome` (which may fetch a different one) can disagree — prefer the locked binary
   when reproducing a baseline number.

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
- **`node_modules` IS installed by Orca setup — but a merge that adds dependencies needs a
  re-install.** `repo show` reports `hookSettings: null`, which is misleading: the
  `worker-start` receipt for the first child worktree shows `setup.hookFound: true`,
  `startupPolicy: wait-for-setup`, `setup.state: succeeded`, and children arrive with
  `node_modules/` and `server/node_modules/` present. However, after this branch merged `main`
  the `pdf-lib` dependency in `server/package.json` was **not** present in `node_modules`, and
  `bun install` (40 packages) was required to make typecheck green. So: dependencies are ready
  on arrival for the base you were given; if you merge or your base gains a dependency, run
  `bun install` and record it.
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

## Child worktree placement (measured on the first dispatch)

Workers are placed as stacked child worktrees of `opik-integration` with an explicit git base:

```
orca orchestration worker-start --run <run_id> --task <task_id> \
  --worktree new-child --repo id:d6edf033-748a-4549-ae5a-e9efd34cef91 \
  --base-branch 1123786563/opik-integration --name opik-t01-module-seam \
  --agent claude --setup run --json
```

Verified on `ctx_ae959c2a4e7b`: child branch `1123786563/opik-t01-module-seam`, based exactly on
the opik tip, carrying this file, the plan and `docs/tickets/opik-4/manifest.json`.
`launch.effective` was `{"agent": "claude", "model": null, "effort": null}` — `--model` is
deliberately omitted so each worker inherits the configured claude default, and the effective
value (not the requested one) is what is recorded.

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
