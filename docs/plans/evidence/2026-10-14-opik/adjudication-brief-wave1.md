# Frontier wave — coordinator adjudication brief (reviews 1–4 of 5)

Prepared for the human coordinator's ruling. Every row below was re-verified by the coordinator
against the **committed** state; reviewer verdicts were not taken at face value, and neither were
implementer self-reports. Two of the four reviews changed verdict under verification — one in each
direction.

Run `run_5f5dfacf3715`. Reviewer terminals retained pending adjudication.

## Verdicts

| Ticket | Reviewer said | Coordinator verification | Effective verdict |
| --- | --- | --- | --- |
| **T02** #8 | approve | Confirmed. Reviewer re-ran parity (6 pass), app typecheck + build green, scoped biome clean; reproduced both reds (channels.json duplicate key, webapp-proxy TS2322) on the baseline commit; and ran **4 groups of mutation tests in a /tmp clone** to prove the guard tests actually go red. 11 changed files match owned_scope exactly. | **approve** |
| **T01** #7 | request-changes (1 medium) | **Refuted.** The finding was "index.ts:4788 is an 83-char over-width line the implementer added, the only new violation vs baseline." Measured: line 4788 is **81** chars; `4788` does **not appear** in biome's diagnostics at all; and base-vs-branch violation counts are identical for both files (`index.ts` 1→1, `app.ts` 1→1, **0 new**). The flagged `index.ts:134` is a pre-existing billing import that only *shifted* because the implementer added imports above it. | **approve** (finding withdrawn) |
| **T05** #11 | request-changes (1 high, 2 medium, 4 low) | **Confirmed, and the high is worse than reported.** The PEM deny pattern `/\b-----BEGIN [A-Z ]*PRIVATE KEY-----/` is effectively **dead**: `\b` needs a word/non-word transition, `-` is a non-word char, so it only matches when a PEM header is glued to a word character. Empirically MISSED on bare PEM, PEM after a space, PEM after a colon, and PEM inside JSON metadata; DETECTED only on `abc-----BEGIN…`. Also confirmed F3: the plan's test `CANARIES` dict contains **no PEM and no Slack entry**, while the plan's Self-Review claimed both were covered. | **request-changes** |
| **T06** #12 | request-changes (1 medium) | **Confirmed.** Committed branch (`8b231692`) fails `biome format`: `contracts.ts:71` union type not split → exit 1. The implementer's worktree reports exit 0 only because it ran `biome format --write` and **never committed the result** (`git status` shows ` M server/src/ai-observability/contracts.ts`). So the checkpoint's `FMT_EXIT=0` was true of a dirty working tree and false of the delivered branch. | **request-changes** |

T03 #9 review still running. T05's reviewer independently confirmed all five of the implementer's
plan-contradiction adjudications and the `SECRET_CANARIES` non-export decision as correct.

## Systemic findings (these matter more than any single ticket)

### S1 — Gate claims must be verified against the committed tree, not the worker's worktree

T06 passed `biome format` in its own worktree and failed it on its own branch. The coordinator's
first check reproduced the implementer's "clean" result — because it ran inside the dirty worktree.
Verifying where the worker left its files launders exactly the class of error the review exists to
catch.

**Rule for the remaining 32 tickets:** format/lint/typecheck evidence is only valid when produced
from a clean checkout of the delivered commit, or after the worker has committed. A `--write` result
that is not committed does not count, and a checkpoint must state the commit sha its output came
from.

### S2 — Reviewer output needs verification too

One of four reviewers produced a false blocking finding, built on a mis-stated line length (83 vs
81), a line biome never flags, and a baseline violation misattributed through line-number shift.
Reviewers are not oracles. The coordinator re-ran every blocking claim; that is what flipped T01 to
approve and confirmed T06.

**Rule:** no finding is acted on until reproduced from the committed state. Both directions.

### S3 — The plan's own Self-Review is not evidence

Across the wave the plans' Self-Review sections claimed completeness and type consistency and were
wrong every time: five test/implementation contradictions (E5), a locator fingerprint collision
(E7), a test stub that dropped its response (E3), a nonexistent `requireUser` binding (E4), an
unsatisfiable repo-wide biome gate (E1), a baseline measured on the wrong branch (E2), a
digest-retrieval method that hangs (E9), reviewer placement that cannot see coordinator artifacts
(E10), and now a dead security regex plus a false canary-coverage claim (E11/E12).

**Rule:** stop treating Self-Review as a gate. It stays useful as a checklist of what to attack, and
executors found every one of these.

## Required fixes (dispatch targets, not coordinator edits)

A review-only `worker_done` authorizes synthesis, not coordinator file edits, so these go back to
the retained implementer terminals:

1. **T05 (high, security).** Remove the `\b` anchor from the PEM pattern; add PEM and Slack canaries
   to the test's `CANARIES`; add an `allowFreeText: true` variant proving an AWS secret with no
   context word is still refused. Address the four low findings or record why not.
2. **T06 (medium).** Commit the already-applied `biome format --write` result for `contracts.ts` and
   correct the checkpoint's `FMT_EXIT` claim to name the commit sha the output came from.
3. **T01.** No code change. Record the withdrawn finding and the base-vs-branch violation counts so
   the refutation is durable.
4. **T02.** No code change. Its checkpoint was written but never committed — fold it in at
   integration.
5. **Manifest (all 37 tickets).** Change biome commands to the locked binary
   (`node_modules/.bin/biome`, 2.5.10 per `package.json`) rather than `bunx biome`, and add the S1
   rule that gate evidence must come from the delivered commit.

## Open items for the human coordinator

- Rule on T01's self-reported `git stash` violation (E8). Its reviewer independently verified the
  recovery caused no contamination and matches the errata record; the surviving stash list holds
  only the billing workstream's two entries.
- Rule on T03's four files beyond owned_scope (`docker/opik/clickhouse-config/*`,
  `nginx_default_local.conf`). The coordinator's read is that upstream compose mounts these paths, so
  a vendored compose without them cannot pass `docker compose config` — i.e. owned_scope drift like
  T01's missing `server/src/app.ts`, not a violation. T03's reviewer has not yet reported.
- Decide integration order: fix-then-integrate, or integrate-then-fix.
