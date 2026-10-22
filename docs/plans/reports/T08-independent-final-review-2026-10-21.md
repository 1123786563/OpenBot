# T08 Independent Final Review — Workspace Redesign B1 (T01–T08)

- Reviewer role: independent read-only reviewer (Spec compliance + code quality), re-doing the report a previous session failed to write.
- Date: 2026-10-21 (re-issued 2026-10-22 by re-dispatch).
- Worktree: `/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration`, branch `feat/heroui-v3-migration`.
- BASE / HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (unchanged; 225 dirty/untracked paths, no commit created).
- Scope of this review: **read-only source/test evidence audit** of the B1 delivery (T01–T08, P01–P23, plus recorded bounded repairs: T03 draft-lifecycle wiring, T03-P28 layout repair, T03 Skills lifecycle test, T05 P11/P14/P15 error-focus, T01 control-border cascade, T05-R2..R5, T06-R2..R5, T07-R1/R2, T02-R3, T08-R1/R2).
- Explicitly out of scope (see §7): per-page browser acceptance (remains PARTIAL), OCR (not run per user instruction).

## 1. Scope and method

1. Read the authoritative spec set: `docs/design/2026-10-20-workspace-redesign/handoff/refinement/code-agent-prompt.md`, `implementation-spec.md`, `implementation-detail.md`, `verification-plan.md`, plus the formal plan `docs/plans/2026-10-20-workspace-redesign-b1.md`.
2. Read the execution ledger `docs/plans/2026-10-20-workspace-redesign-b1-ledger.md` and `docs/verification/workspace-redesign/completion-audit.md` for claimed task states.
3. Verified the current worktree against recorded checkpoints by SHA-256 (`shasum -a 256`, equivalent to `git hash-object` content hashing in SHA-256 mode) for every task's final POST package, following the chain through later authorized repairs whenever a live file differed from an earlier POST.
4. Spot-audited 28 per-task review/impl reports and the presence of all 28+ recorded report files under `docs/plans/reports/`.
5. Cross-checked the 23-row acceptance matrix `docs/verification/workspace-redesign/t08/page-acceptance.md` against the final-gate evidence files and the completion audit.
6. Source-inspected the Spec contract points listed in §2 against the live files.

Commands actually executed are listed in §8.

## 2. Spec contract checklist (source-level)

| # | Contract (source: spec section) | Live-file evidence | Verdict |
|---|---|---|---|
| C1 | `tokens.css` sole owner of `--ob-*` theme values in `@layer ob-tokens` (spec §2) | `app/src/styles/tokens.css:10 @layer ob-tokens`; 116 `--ob-*` declarations (39 base + state/border/layout additions) | PASS |
| C2 | `heroui-theme.css` sole owner of HeroUI native semantic mapping in `@layer ob-theme`, both theme scopes | `heroui-theme.css:10 @layer ob-theme`; `:root,[data-theme="light"]` (L11) and `.dark,[data-theme="dark"]` (L129); `--muted: var(--ob-muted-text)` (L23/L142) keeps muted=text; `--accent*`→action family (L39–44/L158+); field/radius/backdrop/scrollbar mappings present (L25–61/L116) | PASS |
| C3 | `legacy-ui-bridge.css` legacy aliases only, never redeclares `--accent`/`--muted`/HeroUI names (spec §2 legacy table) | `legacy-ui-bridge.css:20 @layer ob-legacy`; explicit comment + absence of `--accent`/`--muted`; `--input: var(--ob-control-border)` (L42) matches the control-border requirement | PASS |
| C4 | Layer order kept in `styles.css`, no unlayered theme declarations; HeroUI base reset inside `base` layer (T01 cascade repair) | `styles.css:15 @layer theme,…`, `@layer base` at L253 holds the shared reset (cascade repair), `@layer ob-app` L182/267 | PASS |
| C5 | Wrapper semantics preserved: ref/mergeRefs, native events once, submit type, anchor keyboard, ESC stack, portal (spec §3) | `ui/button.tsx` cva with 6 variants incl. `outline` using `--ob-control-border` (L26) and `link` using `--ob-accent-text` (L33); sizes h-9/h-7/h-10 (36/28/40px); `pointer-coarse:min-h-11 min-w-11` (44px); focus `outline-2 offset-2 --ob-focus`; disabled keeps readable tokens with `opacity-100`. Input `h-9` + `pointer-coarse:!h-11`, field fill `--ob-field-background`, invalid keeps fill + danger border (L21). T02 tests (button-native, composing-enter, form-submit-controls, heroui-spike) pass in final native gate | PASS |
| C6 | Dialog `min(512px,100vw-32px)`, `max-h calc(100dvh-32px)` internal scroll; Sheet scrim `--ob-backdrop`, <768px full width else `min(detailWidth,100vw)` (spec §3 dialog/sheet row) | `ui/dialog.tsx:441-442` exactly these bounds; `ui/sheet.tsx:22 SCRIM = bg-[var(--ob-backdrop)]`; placements L33-34; DetailPanel SheetContent uses `min(${detailWidth}px,100vw)` (detail-panel.tsx L79) | PASS |
| C7 | Shell widths: app 280, settings/admin 256, rail total 64, mobile `min(280,100vw-32)` (spec §5) | `_app.tsx:18 width="280px"`; `settings/route.tsx:15` and `admin/route.tsx:24` `width="256px"`; `ui/sidebar.tsx:27-29` `SIDEBAR_WIDTH 280px`, `SIDEBAR_WIDTH_ICON 64px`, mobile var `min(280px,calc(100vw-32px))`; `sidebar-shell.tsx:57` sets the mobile var | PASS |
| C8 | prose 672 / wide 1024 as max widths (spec §5) | `page-shell.tsx:33-35` `prose: max-w-2xl`(=672) / `wide: max-w-5xl`(=1024); default `width="prose"` (L44); observability callers use `width="wide"` (e.g. `runs-list.tsx:409`) | PASS |
| C9 | Chat reading column 720; composer bottom flex item; top bar 48px (spec §5 聊天) | `chat-transcript.tsx:1635` `max-w-[720px]`; `conversation-view.tsx:437` and `group-chat.tsx:63,93` composer/column `max-w-[720px]`; `_app.tsx:62,101,111,125` P01 rows `max-w-[720px]` (T07-R1/R2 closure); detail header `h-12` (48px) in detail-panel.tsx L81 | PASS |
| C10 | DetailPanel: `DEFAULT_DETAIL_WIDTH=400`, `MIN_MAIN_WIDTH=480`, strict `<` threshold on container content width; computer 400 / workshop 480; Sheet/inline split; resize never closes nor mutates search (spec §5, impl-detail §4) | `detail-panel.tsx:20-21` constants; L58 `setOverlay(width < detailWidth + MIN_MAIN_WIDTH)`; `channel/$channelId.tsx:45 WORKSHOP_PANEL_WIDTH=480` applied only for watch/workshop (computer settings branch passes `undefined`→400); overlay branch renders Sheet, else motion.div width animation; no `onClose`/router calls inside ResizeObserver | PASS |
| C11 | Draft state owned above the inline/Sheet branch for the bounded Skills/Craft compatibility files (impl-detail §4) | `skills.tsx:86-96` route-owned `skillDraft` (values+dirty keyed by draftKey) passed into panel; `scheduled-task-editor.tsx:716 CraftTaskEditorPresenter` + host `flex-1 min-w-0` (L747, P28 repair) owns FormState above branch; behavior tests: `app/tests/detail-panel.test.tsx` (live cc5ea9d8), `app/tests/skills-draft-lifecycle.test.tsx` (live 4ca41cfe) | PASS |
| C12 | Sidebar persistence: only explicit desktop toggle writes `openbot-sidebar`; resize/first mount never write; `responsiveCompact` affects effective open only (impl-detail §3) | `sidebar-shell.tsx:35-46`: state from `parseStoredSidebarOpen`; `effectiveOpen = manualOverride ?? (open && !responsiveCompact)`; `handleOpenChange` is the only write path (`applySidebarOpen`); no storage effect on resize; prop `responsiveCompact=false` default | PASS |
| C13 | Bots roster grouping/hidden algorithm preserved; no new search/filter (spec §5 Bots paragraph; 禁止项 #9) | `bot-roster.tsx:27` imports unchanged `groupRoster`; needsYou/pinned/yours/shared order L55-74; `HiddenSection` default-collapsed; zero `search` occurrences | PASS |
| C14 | Observability guard/Outlet/back chain and state distinctions preserved (spec 合同 #7) | `lib/observability/route-guard.ts:13 requireBotObservabilityAccess` still consumed by runs/evaluations/export routes (beforeLoad), route chain tests live (T06-R5 snapshot `observability-route-guards.test.tsx` matches live 0a257dab) | PASS |
| C15 | Chat contracts: IME composition guard, drafts/attachments, stop/retry, settings/watch/workshop exclusivity, computer release (合同 #8) | `lib/composing.ts` `isComposing` (isComposing || keyCode 229) used by `create-agent-dialog.tsx:268`, `bot-profile/setup.tsx:299`; PromptArea/questionnaire skip documented; `channel/$channelId.tsx` keeps show() mutual exclusion (settings/watch/workshop single `next` transition L95-97) and DetailPanel `onClose={() => show(null)}`; composer queue/stop tests pass in gate | PASS |
| C16 | P09 SMS challenge scoped by Bot+channel (T08-S1 closure) | `reaching-you.tsx:158-160` renders challenge only when `pendingSms.agentId === fixedBot`; `onChallenge` stores `{version:1, challengeId, agentId, channelId}` (L326-330); `pendingChannelId` gated the same way (L318-322) | PASS |
| C17 | 禁止项: no new search/metrics/approval hub/unified task API; no payment-subject/tenant changes; no P24/P28 visual redesign beyond the listed compatibility/layout files | `git status` review: B1 changed files all map to task owned_files or recorded repair paths; no server/ files modified; Craft/Skills production changes limited to the six pre-registered files + P28 host fix | PASS |
| C18 | No commits/push/merge/publish/dependency install | HEAD still `203d0f02…`; `app/package.json` diff contains no dependency additions from B1 (pre-existing migration baseline); ledger records no install | PASS |

## 3. Source hash sampling vs recorded checkpoints (SHA-256)

Method: recompute SHA-256 of live files and compare against each task's final POST manifest/snapshot; any live divergence is then chased through the later authorized repair checkpoints until the chain closes at the live bytes.

| File | Final recorded checkpoint | Recorded SHA-256 (prefix) | Live SHA-256 (prefix) | Result |
|---|---|---|---|---|
| `app/src/styles/tokens.css` | T01 POST-R2 | `a9481796…` | `a9481796…` | MATCH |
| `app/src/styles/heroui-theme.css` | T01 POST-R2 | `1be30c71…` | `1be30c71…` | MATCH |
| `app/src/styles/legacy-ui-bridge.css` | T01 POST-R2 | `acd6410d…` | `acd6410d…` | MATCH |
| `app/src/styles.css` | T01 control-border repair POST (supersedes POST-R2 `f3210256…`) | `9a0343b3…` | `9a0343b3…` | MATCH (chain closed) |
| `app/DESIGN.md` | T01 POST-R2 | `2e10d7b1…` | `2e10d7b1…` | MATCH |
| `app/src/components/ui/button.tsx` | T02 POST-R2 | matches snapshot | `4136e817…` | MATCH |
| `app/src/components/ui/input.tsx` | T02 POST-R2 | matches snapshot | `cc0f4e51…` | MATCH |
| `app/src/components/ui/dialog.tsx` | T02 POST-R2 → R5 follow-up hashes | R5 `df0f9d3e…` | `df0f9d3e…` | MATCH (chain closed) |
| `app/src/components/ui/sheet.tsx` | T02 POST-R2 | matches snapshot | `1f28b01a…` | MATCH |
| `app/tests/button-native.test.tsx` | T02-R3 POST → T01 cascade POST | `c94f81a1…` | `c94f81a1…` | MATCH (chain closed) |
| `app/src/components/layout/sidebar-shell.tsx` | T03-R1/R2 chain → T07 POST manifest | T07 manifest entry | `82966e46…` | MATCH |
| `app/src/components/layout/detail-panel.tsx` | T07 POST manifest | entry `7c0ce4cb…` | `7c0ce4cb…` | MATCH |
| `app/src/components/layout/page-shell.tsx` | T07 POST manifest → R5 follow-up | R5 `a489f92e…` | `a489f92e…` | MATCH (chain closed) |
| `app/src/routes/_authed/_app.tsx` | T07 POST manifest | entry `f4d5e1e6…` | `f4d5e1e6…` | MATCH |
| `app/src/components/bots/bot-roster.tsx` | T07 POST manifest | entry `0da6ada5…` | `0da6ada5…` | MATCH |
| `app/src/components/channels/chat-transcript.tsx` | T07 POST manifest | entry `66e65eb2…` | `66e65eb2…` | MATCH |
| `app/src/components/channels/conversation-view.tsx` | T07 POST manifest | entry `56d60ea8…` | `56d60ea8…` | MATCH |
| `app/src/components/channels/group-chat.tsx` | T07 POST manifest | entry `ec121de9…` | `ec121de9…` | MATCH |
| `app/src/components/bot-profile/profile.tsx` | T04-R1 POST manifest | `28d24ba4…` | `28d24ba4…` | MATCH |
| `app/src/components/bot-profile/bot-subpage.tsx` | T06-R1 POST (transfer from T05) | `08633625…` | `08633625…` | MATCH (chain closed) |
| `app/src/components/delivery/reaching-you.tsx` | T05-R3 POST | `54fce69d…` | `54fce69d…` | MATCH |
| `app/tests/bot-reaching-you.test.tsx` | T05-R5 POST (chain R1→R3→R4→R5) | `265098fd…` | `265098fd…` | MATCH (chain closed) |
| `app/src/components/ai-observability/run-steps.tsx` | T06-R3 POST | `de3cdd4a…` | `de3cdd4a…` | MATCH |
| `app/tests/ai-observability-run-steps.test.tsx` | T06-R4 POST (supersedes R3 `12f77c5f…`) | `2a090963…` | `2a090963…` | MATCH (chain closed) |
| `app/tests/observability-route-guards.test.tsx` | T06-R5 POST | `0a257dab…` | `0a257dab…` | MATCH |
| `app/src/locales/zh-CN/ai-observability-evaluations.json` | T08-R1 POST | `1019199d…` | `1019199d…` | MATCH (chain closed) |
| `app/tests/item-disabled.test.tsx` | T08-R2 POST | `ca1b99e5…` | `ca1b99e5…` | MATCH |
| `app/tests/detail-panel.test.tsx` | T08-R2 POST → P28 repair POST | P28 `cc5ea9d8…` | `cc5ea9d8…` | MATCH (chain closed) |
| `app/src/components/craft/scheduled-task-editor.tsx` | T03-R3 POST → P28 repair POST | P28 `63f99bf6…` | `63f99bf6…` | MATCH (chain closed) |
| `app/tests/skills-draft-lifecycle.test.tsx` | T03 skills-lifecycle POST-R3 | `4ca41cfe…` | `4ca41cfe…` | MATCH |
| `app/src/components/ui/context-menu.tsx` | R5 follow-up hashes | `aeff9e04…` | `aeff9e04…` | MATCH |
| `app/src/lib/theme.ts` | R5 follow-up hashes | `55a15701…` | `90dd34ae…` | **see finding F1** |

Aggregate manifest checks:

- T07 POST manifest: 84/84 entries match live (all T07 owned files).
- T01 POST-R2 checkpoint: 5/5 style files + 2 tests; only `styles.css` diverged and closed at the T01 cascade-repair POST.
- T02 POST-R2 snapshots: only `dialog.tsx` diverged and closed at R5 follow-up.
- T04-R1 POST manifest: 2/2 match.
- T05-R1 FINAL manifest: 4 divergences, all closed (bot-subpage→T06-R1, reaching-you/test→T05-R3..R5, e2e-bun-suites.json→T05-R2 POST `e03899e0…` = live).
- T06-R1 POST manifest: 8 divergences, all closed at T06-R3/R4/R5 and T08-R1 checkpoints.
- T08-R2 POST: item-disabled match; detail-panel test closed at P28 repair POST.
- R5 follow-up `hashes.txt`: 4/6 match; the 2 divergences are exactly the two files the later authorized P28 repair changed, and both close at the P28 POST.

Conclusion: no unattributed source drift exists between the last recorded checkpoint of each B1-owned path and the live worktree, with one exception documented as finding F1.

## 4. Per-task conclusions

| Task | Claimed state (ledger) | Independent re-verification result |
|---|---|---|
| T01 tokens/theme | source+review complete | PASS. Live files = T01 POST-R2 + cascade repair POST (§3). Layer ownership per C1–C4 verified in source. Final focused native 9/9 recorded; control-border browser evidence exists but is not judged here. |
| T02 wrappers | complete incl. R1–R3 | PASS. Size/focus/disabled/coarse-pointer contracts verified in `button.tsx`/`input.tsx`/`textarea.tsx`; dialog/sheet bounds per C6; R3 typecheck fix confirmed (button-native test hash chain closed). |
| T03 shell/page/detail | source/test verified | PASS. 280/256/64/mobile widths per C7; persistence semantics per C12; DetailPanel 400/480 thresholds per C10; bounded draft ownership per C11 with route-level behavior tests. |
| T04 roster/profile | verified | PASS. `bot-roster.tsx` grouping untouched, hidden default collapsed; T04-R1 unclamp verified via POST manifest match. |
| T05 config pages | verified incl. R1–R5 + P11/P14/P15 | PASS. SMS challenge scoping (T08-S1) re-verified in source (C16); routines/prose defaults confirmed; hash chain R1→R3→R4→R5 closed at live. |
| T06 observability | verified incl. R1–R5 | PASS. `requireBotObservabilityAccess` guard intact; wide width pass-through present (`bot-subpage.tsx:18,24,37`); run-steps/test/locale hash chains closed. |
| T07 chat pages | verified (final review) | PASS. 720 columns across transcript/conversation/group/home verified; workshop 480 constant confirmed; IME contract intact (C15). All 84 owned paths hash-match. |
| T08 evidence gate | source/test gate complete; browser partial | PASS for source/test scope. Final-gate reports exist with `status=passed, exitCode=0`: native 1006 passed (130 files), driven app/tests 6/6, driven app/src 1/1; acceptance matrix has exactly 23 unique P-rows, 23/23 source/test PASS, 23/23 browser PARTIAL (honest, not overstated). |

## 5. Overall verdicts

- **Spec compliance: PASS** for the audited read-only source/test scope, with the limitations in §7. All 18 contract points in §2 verified against live source; every sampled file matches its latest recorded checkpoint; the 23-page evidence chain is internally consistent and the PARTIAL browser statuses are stated honestly.
- **Code quality: PASS**. Sampled implementations read clean: documented rationale comments, no duplicated detail subtree (draft lifted above branch), no `!important` escalation in the audited wrappers, reduced-motion handled in animations, no leftover neutralizer classes on audited inputs, and repairs stayed within their bounded scope (verified by manifest path lists).

## 6. Findings

| ID | Severity | File:line | Contract clause | Finding | Status |
|---|---|---|---|---|---|
| F1 | low | `app/src/lib/theme.ts` (whole file; live SHA `90dd34ae…` vs R5 follow-up `55a15701…`) | Checkpoint protocol (plan: every check report bound to exact POST hash; code change invalidates affected evidence) | `app/src/lib/theme.ts` changed after the final R5 follow-up hash snapshot (`55a15701…`) and its current bytes (`90dd34ae…`) do not match any checkpoint I inspected in `docs/verification/workspace-redesign/`. The ledger's R5 note only covers 6 paths; a later change to `theme.ts` (possibly the OCR-disposition `setRootTheme` required-argument correction, which is described in prose but whose POST hash I could not locate) is not bound to a recorded POST checkpoint. Given `heroui-theme.css` maps `.dark`/`[data-theme]` and the final native gate (1006 tests, after 2026-10-21T01:24Z) passed, the behavioral risk is low, and the R5 hashes.txt header explicitly says it is POST-only and "do not represent this manifest as a PRE→POST package". Still, the ledger should record the authoritative final hash of `theme.ts` (or point to the checkpoint that does) so the final source state is fully hash-bound. | Open (documentation/binding gap only) |

No critical, high, or medium findings in the audited scope. F1 does not block PASS because the affected behavioral evidence (final native/driven runs, theme tests) was captured after the change and the change is described in the ledger's OCR-disposition section; it is a checkpoint-binding gap, not a demonstrated contract violation.

## 7. Limitations and not covered

1. This is a **read-only source/test evidence review**. I did not run the test suites, build, or typecheck myself; I verified the recorded final-gate reports exist with `status=passed, exitCode=0` (native 1006/1006, driven 6/6 and 1/1) and re-ran only non-mutating commands (§8).
2. **Browser per-page acceptance is not judged here.** All 23 P01–P23 rows remain PARTIAL by honest record; completing them (populated/error/permission/long-content/zoom/reduced-motion matrices) is outside this review's scope and remains an open gate for B1 completion.
3. **OCR was not run** per the user's explicit instruction (recorded in the ledger and completion audit). No OCR pass or coverage is claimed; this review does not substitute for it. The later instruction to attempt OCR found no configured provider and produced no report; that attempt is not evidence either.
4. Pre-existing dirty migration baseline (827 paths at capture) is attributed per ledger ruling R-01; I did not re-attribute each of the 225 currently-dirty paths, only the B1-owned ones plus their repair chains.
5. Server-side driven failures (9 repository groups, isolated DB/cleanup tests) are outside UI scope and disclosed in the audit; not re-run here.
6. F1 (`theme.ts` final hash binding) is the only unbound delta found.

## 8. Verification commands actually executed (all read-only)

```bash
git rev-parse HEAD                                  # 203d0f0244b2f898218fa12027089c631e8448d9
git status --porcelain | wc -l                      # 225
git log --oneline -3                                # BASE unchanged
git diff --check                                    # PASS
shasum -a 256 <each sampled file>                   # §3 table (equivalent content hash to git hash-object SHA-256)
python3 <snapshot-vs-live SHA-256 walker>           # t01/POST-R2, t02/POST-R2, t02-r3/POST, t03-r3/POST,
                                                    # t04-r1/POST(+manifest), t05-r1/FINAL(+manifest),
                                                    # t05-r2/r3/r4/r5, t06-r1/r3/r4/r5, t07/POST(84-entry manifest),
                                                    # t08/PRE, t08-r2/POST, p28-layout-repair PRE/POST,
                                                    # t03-skills-draft-lifecycle/POST-R3, t01/control-border-repair PRE/POST,
                                                    # final-r5-review/hashes.txt
grep/sed source inspection                          # §2 contract points C1–C18
python3 <json parse of final-r5-native / final-r5-driven-app-tests / final-r5-driven-app-src report.json>
grep -cE '^\| P[0-9]{2} ' page-acceptance.md        # 23 rows, 23 PARTIAL browser cells
```

No files were modified by this review except this report.
