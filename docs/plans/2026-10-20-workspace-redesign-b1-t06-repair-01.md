# T06 Review Repair 01 — Guards, Data Width and Disclosures

- **Source:** `docs/plans/reports/T06-review.md`, findings 1–5. Four medium Spec findings plus one low coverage finding.
- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1.md`, Task 6; P16–P23 and implementation-spec §7; user defers browser acceptance.
- **Goal:** complete P23's direct-route guard, the 1024px width contract for all five data pages, expandable detail access on P17/P21/P23, and source-level regression coverage for P19 dataset-read failure.
- **Constraints:** keep run/sample/export data semantics, API and authorization unchanged; no new dependency; no changes outside named paths; no browser claims or commits.
- **Owner/sequence:** one serial `frontend_implementer`; independent validator and reviewer after implementation.
- **Serial ownership transfer:** `app/src/components/bot-profile/bot-subpage.tsx` from T05 (final source checkpoint `checkpoints/t05-r1/FINAL/`, reviewed POST hash in `POST-manifest.json`) to T06-R1, reason: add the already-designed optional prose/wide width pass-through for observability callers. Allowed change: optional `width` prop only. Review scope: default remains prose for existing configuration callers; only P16/P17/P18/P19/P23 callers request wide. T05 is complete and its writer stopped before transfer.
- **Paths:** `bot-profile/bot-subpage.tsx`; observability sources `runs-list.tsx`, `run-detail.tsx`, `run-steps.tsx`, `evaluations-page.tsx`, `experiments-section.tsx`, `experiment-results.tsx`, `exports-status.tsx`; routes `bots.$agentId.exports.tsx` and `bots.$agentId.datasets.tsx` (already T06-owned); locales `en/zh-CN/ai-observability-runs.json`, `en/zh-CN/ai-observability-evaluations.json`; tests `observability-route-guards.test.tsx`, `ai-observability-runs-list.test.tsx`, `ai-observability-run-detail.test.tsx`, `ai-observability-run-steps.test.tsx`, `ai-observability-routes.test.tsx`, `ai-observability-experiments.test.tsx`, `ai-observability-exports.test.tsx`.
- **PRE:** capture exact bytes/hash of all listed paths, current HEAD/status/full tracked patches under `checkpoints/t06-r1/PRE/` before edits.

## Repair tasks

1. Add `requireBotObservabilityAccess(context.queryClient, params.agentId)` to exports `beforeLoad` and extend direct-route guard tests for deny/allow behavior using existing safe fixtures.
2. Add optional width passthrough to `BotSubpage`, defaulting to prose. Request `wide` for P16 runs, P17 run detail, P18 datasets, P19 evaluations, P23 exports; test class/prop at component or route level. P20–P22 widths from T06 remain intact.
3. P17: keep the step tree's summary scan compact and provide keyboard-operable per-step disclosure for full projected payload/technical content in an internally horizontally scrollable named region; preserve nesting, redaction, missing/truncated semantics. Add interaction test for closed and open states, including keyboard activation.
4. P21: keep sample identity/status/score in summary and move long reason/judge/usage details behind keyboard-operable disclosure; unavailable values remain unavailable and never become zero. Test collapse/expand and missing usage.
5. P23: keep export state/status as summary; allow failure detail expansion via keyboard-operable disclosure. Preserve retries/downloads and test expansion.
6. P19: add a direct test for datasets read error showing unavailable state with no submit action, and an empty-list case preserving empty semantics.
7. Run applicable native/driven suites via ADR0008, Biome only changed source/locale/tests, coverage audit if test manifest changes. Capture exact POST/package hashes; independent validator/reviewer must pass before T07.

## Failure handling

If a test requires a fixture outside the already-safe test harness, do not write business data; report the exact missing fixture. Preserve unrelated baseline edits and avoid broad formatting. Browser geometry, themes, real permission identities and browser focus remain pending user testing.
