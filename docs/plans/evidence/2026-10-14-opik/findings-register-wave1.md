# Frontier wave — complete findings register (all 5 reviews, 22 findings)

Every finding from the five committed review reports, with the coordinator's verification status.
Read this before adjudicating: three items below did not appear in the `worker_done` summaries and
two of those are security-relevant.

Reports live on the review branches:
`opik-review-t01@fdbce7e8`, `opik-review-t02@a1894f6d`, `opik-review-t03@1c1d7617`,
`opik-review-t05@9a2d1ed1`, `opik-review-t06@e1917c2d`, each at
`docs/plans/evidence/2026-10-14-opik/reviews/T0N-review.md`.

Legend — coordinator status: **confirmed** (reproduced from the committed state),
**refuted** (reproduced the opposite), **not yet verified**, **accepted as reported** (evidence in
the report is self-sufficient and re-running adds nothing).

## Blocking

| ID | Ticket | Sev | Finding | Coordinator status |
| --- | --- | --- | --- | --- |
| T05-F1 | #11 | **high** | PEM deny pattern `\b` anchor never matches at line start or after a newline, so a private key passes through on the **default metadata path**. | **confirmed and worse than reported** — measured MISSED on bare PEM, after-space, after-colon and inside JSON metadata; detected only when glued to a word char. |
| T05-AC1 | #11 | — | Acceptance criterion 1 of Issue #11 is therefore **fail (fixable)**, not merely "one finding". | **confirmed** — follows from F1. |
| T05-F5 | #11 | low→**should be raised** | `projectSafeRecord` uses `in`, which walks inherited properties, and `out[key] =` for `__proto__` goes through a setter — a **prototype-pollution path inside the redaction module itself**. | **not yet verified.** Flagged as the highest-priority unverified item: it is a security defect in the component whose whole job is safety, and it was reported as low. |
| T06-F1 | #12 | medium | Delivered branch fails `biome format` at `contracts.ts:71`; checkpoint recorded `FMT_EXIT=0`. | **confirmed** — the implementer ran `--write` and never committed; ` M contracts.ts` proves it. See errata E13. |
| T03-F1 | #9 | **high** (plan, not deliverable) | The plan's `PUBLISHED` regex matches zero lines of the delivered compose, so both port guards pass vacuously; changing a line to `0.0.0.0:…` today would still be green. | **confirmed by mutation test** — 0 matches on the real file, 2 on a mutated copy. Deliverable itself is compliant. Errata E15. |

## Non-blocking, worth fixing in the same pass

| ID | Ticket | Sev | Finding | Coordinator status |
| --- | --- | --- | --- | --- |
| T05-F2 | #11 | medium | The AWS-secret pattern requires a context word *after* the token; with no context word, `allowFreeText: true` passes it through, contradicting the documented promise. | **not yet verified** |
| T05-F3 | #11 | medium | The plan's Self-Review claimed Slack and PEM canary coverage; the test's `CANARIES` dict contains neither. | **confirmed by inspection** — errata E12. |
| T05-F4 | #11 | low | `cutToBytes` can leave a lone surrogate, so the UTF-8 tail becomes U+FFFD bytes; the guard sits at the wrong layer. | **not yet verified** |
| T05-F6 | #11 | low | Arrays/key counts silently truncate at 64 while state stays `projected` — the three-state contract has no representation for silent dropping. | **not yet verified**; note this is the same failure mode as errata S4 (a check that cannot see its own emptiness). |
| T05-F7 | #11 | low | The manifest's `produces` umbrella name "`projectSafe()` 接口" does not correspond to the six functions actually exported. | **accepted as reported** — my manifest text, my defect. |
| T06-F3 | #12 | low | `cacheKey` separator ambiguity **within one scope**, with a measured collision. | **not yet verified**, but a collision in a key-derivation function whose entire purpose is preventing cross-scope reuse deserves a fix rather than a note. |
| T06-F2 | #12 | low | The checkpoint does not explicitly state #17's cursor-invalidation obligation. | **accepted as reported** |
| T06-F4 | #12 | low | The fingerprint fix has no explicit equal-length-separation regression assertion. | **accepted as reported** — the plan now carries one (E7 patch), the deliverable does not. |
| T02-M1 | #8 | medium | The implementer wrote its checkpoint but never committed it, so `manifest.handoff.checkpoint` is empty. | **confirmed** — the coordinator collected the file from the worktree; it must be committed at integration. |
| T01-F1 | #7 | medium | Claimed `index.ts:4788` is an 83-char over-width line the implementer added, the only new violation vs baseline. | **REFUTED** — the line is 81 chars, `4788` appears nowhere in biome's diagnostics, and base-vs-branch violation counts are identical (`index.ts` 1→1, `app.ts` 1→1, zero new). The flagged line 134 is a pre-existing billing import that only shifted. Errata E14. |

## Informational / process

| ID | Ticket | Finding | Coordinator status |
| --- | --- | --- | --- |
| T01-F2 | #7 | "disabled → 404" is not exercised through the real `createApp`. | accepted; matches the plan's own scope note |
| T01-F3 | #7 | An empty `manifest.handoff.checkpoint` is a convention conflict, not an implementer error. | accepted — my convention said "write the file", the manifest expected a folded value |
| T01-F4 | #7 | The `git stash` violation's recovery is **independently verified clean**; delivery integrity additionally proven by reconstructing all five commits with `git show` and matching the delivered file set. | **confirmed** — matches my own `git stash list` check. This is the evidence for the pending E8 ruling. |
| T02-L1 | #8 | zh-CN titles' mutual distinctness is not guarded (only en is). | not yet verified |
| T02-L2 | #8 | The plan's Task 4 Step 3 lint expectation does not match reality. | accepted — my plan defect, same family as E1 |
| T02-I1 | #8 | `server typecheck` red versus the baseline record = environment drift. | accepted — that is errata E2, since fixed by merging main |
| T02-I2 | #8 | The errata file the coordinator referenced does not exist in the review worktree. | accepted — independently confirms errata E10 |
| T03-F2 | #9 | `image: &minio-image` / `*minio-image` YAML anchors mean the floating-tag scan sees only the anchor name, not minio's real image string. The rendered config confirms the actual value is compliant. | not yet verified; same family as E15 (a scan that cannot see what it scans) |
| T03-F3 | #9 | Minor literal deviations: the compose header comment changed 4 lines rather than "one appended line"; `.env.example` insertion point is after the Sentry block rather than after the TEMPO line. | accepted as reported — cosmetic, same files, no functional effect |
| T03-F4 | #9 | `python-backend` keeps upstream `privileged: true` (needed by its DinD code executor). Not a violation of this ticket, but an inherent upstream attack surface. | **accepted, and must be carried forward** — see below |
| T03-F5 | #9 | Checkpoint says 62 optional `${VAR:-}` variables; the reviewer measured 67. | accepted — counting-basis difference, no impact |

## Two things that must not be lost

**1. `privileged: true` on `python-backend` (T03-F4) belongs in the threat model of #38 and #43.**
It is upstream's design for its code-executor container and this ticket was right to keep it, but it
means a container in the optional stack runs privileged on the host. #38 (control-plane protection)
and #43 (real-instance acceptance) must state explicitly whether that container is required for
OpenBot's use, and if not, disable it. Recorded here because neither ticket's acceptance criteria
currently mention it.

**2. The T01 reviewer's methodology note is reusable.** It ran the locked biome binary
(`node_modules/.bin/biome` 2.5.10) against files materialised in an isolated `/tmp` directory in
**file mode**, and explicitly abandoned `--stdin-file-path` mode after finding it untrustworthy:
identical content came back clean via stdin and dirty via file mode, with no explanation. Any future
format-baseline comparison should use file mode in an isolated directory.

## Verdict roll-up

| Ticket | Reviewer | After coordinator verification | Code fix needed |
| --- | --- | --- | --- |
| T01 #7 | request-changes | **approve** (sole finding refuted) | none |
| T02 #8 | approve | **approve** | none (commit the checkpoint) |
| T03 #9 | approve | **approve** | E15 test fix, can fold into #10 or a follow-up |
| T05 #11 | request-changes | **request-changes** | yes — F1 high, plus F5 which should be raised |
| T06 #12 | request-changes | **request-changes** | yes — one format commit + checkpoint correction |

Three approvals, two request-changes. One of the five verdicts moved under verification, and it moved
toward the implementer.
