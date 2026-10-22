# OCR fix round 2 — F4 (W5, medium) — frontend_implementer report

Branch `feat/heroui-v3-migration`, BASE `203d0f02`, worktree `.worktrees/heroui-migration`.
Deliverable is uncommitted working-tree changes only; nothing committed/pushed/stashed.
Owned files touched (nothing else):

- `app/src/components/computer/demonstration-recorder.tsx`
- `app/tests/computer-driving-local-fields.test.tsx`

`h10/POST-CHECKPOINT.sha256` was NOT edited (not mine to edit). New sha256 to record:

- `app/src/components/computer/demonstration-recorder.tsx` →
  `1c40907150186d1fa8a76dd17cd59b552d318324545d59e90d6fc2cefd21f910`
- `app/tests/computer-driving-local-fields.test.tsx` →
  `3456ec1302f887dff8e3d8e2534e1cd5b9beda9ae458bb9c7f2b69e2dece87b2`

## The fix — restore BASE's re-selectable conversation-only item (F4)

`demonstration-recorder.tsx:161-194` (`ScheduleSkill`'s "report in" Select). Before this round the
H10 migration listed only channel items, so once a channel was picked there was no path back to the
conversation-only state (RAC Select has no deselect; `""` was reachable only initially, via
`value={channelId || null}` plus a placeholder). BASE's data flow is restored exactly:

- `ONLY_CONVERSATION = ""` (`:65`) is BASE's own literal — the sentinel IS the empty string, the
  state the submit spread already keys off (`...(channelId ? { channelId } : {})`, byte-identical to
  BASE `:79`). No new sentinel vocabulary, no coercion.
- `<SelectItem value={ONLY_CONVERSATION}>` (`:184-186`) restores `<option value="">{t("demonstration.onlyConversation")}</option>`
  (BASE `:145`) as a real, re-selectable first item; order matches BASE (conversation item, then
  the Bot's channels).
- `value={channelId}` (`:178`, BASE `:142`) — `""` is a real selected value again (BASE's native
  select showed the empty option as selected); the `|| null` coercion is gone, so the item carries
  the selection checkmark in the open list like BASE did.
- `onValueChange` (`:170-177`) keeps the H05/H06 null guard for its one valid meaning: null =
  closed the list without choosing → keep the draft unchanged. Every real selection, `""`
  included, flows through `setChannelId(value)` — exactly BASE's
  `onChange={(event) => setChannelId(event.target.value)}` (BASE `:143`) minus the event object.
- `items` record (`:164-169`) is the W3B-verified learning.tsx/knowledge.$kbId.tsx convention for
  the same pattern: it labels the closed trigger through the adapter's `resolveSelectedLabel`, so a
  picked channel displays its NAME (`Billing`) as BASE's native select did, not the raw id the
  interim migration showed. The `""` state renders the same sentence through the placeholder
  (`:181`), which is how the adapter renders an empty-string selection (`hasSelectedValue("")` is
  false by design), matching learning.tsx's "`""` kept as a real option with placeholder rendering
  the same text".

Before/after (public seam): pick "Billing" → reopen → BASE/after offers and accepts "This Bot's
only conversation" (trigger shows the sentence again; submit payload has no `channelId`). Before,
the reopened list had no such option and no affordance could produce `""` again.

The cron Select (`:117-146`) is untouched this round: all its BASE options exist as items and its
null guard (null = dismissal, keep the cron) is the correct application of the convention.

## The test — TDD, public seam

`app/tests/computer-driving-local-fields.test.tsx` — new test "a schedule reported to a channel can
go back to this Bot's only conversation" (`:347-386`) renders `DemonstrationRecorder` against
stubs for the channels and demonstrations reads, opens the schedule form for a published recording,
and drives the Select the way the repo's other Select tests do (real user-event clicks: trigger by
role button + accessible name, then option). It asserts the full arc: trigger starts on the
conversation-only sentence, picking "Billing" shows the channel name, the reopened list still
offers the conversation-only option, re-picking it restores the sentence, and the submitted
`POST /api/demonstrations/d1/schedule` body is `{ cron, timezone }` — no `channelId`, exactly the
BASE payload for `""`.

- RED 1 (pre-fix, observed): `expected "ch-billing" to contain "Billing"` (exit 1) — the interim
  migration's closed trigger showed the raw channel id.
- RED 2 (mutation, post-fix): with `<SelectItem value={ONLY_CONVERSATION}>` temporarily removed, the
  suite fails at `Unable to find role="option" and name "This Bot's only conversation"` (exit 1) —
  the F4 defect pinned at its own seam. The component was then restored byte-identical
  (sha256 re-verified `1c409071…`) and the run went green (exit 0, 5/5).

Harness note (why the recorder tests now import through a router): a published recording renders a
tanstack-router `Link`, so the test tree needs router context. Under the native (Node) layer,
`@tanstack/router-core/isServer` resolves through the `node` export condition to a constant read
from `NODE_ENV` at module-eval time; unset, it says "server", the router never mounts its
Transitioner, and `RouterProvider` crashes in Matches with `Cannot read properties of undefined
(reading '0')` — the exact signature the driven manifest cites for `admin-catalog-sync-ui.test.tsx`
(docs/verification/e2e-bun-suites.json:1131), which is how the repo's other router suites ended up
on the driven layer. This suite stays native per its existing routing; `beforeAll` states
`NODE_ENV=test` (bun test does the same on the driven layer) and only then dynamically imports the
router and the recorder, so the router mounts client-side as in the app. Flagged for the
orchestrator: any future native suite that renders the router needs the same fact, or the driven
manifest.

## Layer routing (ADR 0008)

`app/tests/computer-driving-local-fields.test.tsx` is in neither `docs/verification/e2e-bun-suites.json`
nor `docs/verification/e2e-known-broken.json` (grep = 0 hits), so it runs on the native layer only;
the driven layer is not involved. Targeted run via the runner's positional path filter.

## Verification (commands run from the worktree root; real exit codes)

| # | Command | Exit |
|---|---------|------|
| 1 | `cd app && bun run typecheck` | 0 |
| 2 | `E2E_UNIT_OUTPUT=docs/verification/heroui-migration/ocr/fix-round-2-f4-native bunx e2e run --config e2e.unit.config.ts app/tests/computer-driving-local-fields.test.tsx` | 1 pre-fix (RED 1 above) → 1 with empty item mutation-removed (RED 2 above) → **0 (5/5 passed) after fix**, re-run green after biome formatting and after mutation restore |
| 3 | `bunx biome check app/src/components/computer/demonstration-recorder.tsx app/tests/computer-driving-local-fields.test.tsx` | 1 (2 format diagnostics) → `--write` → **0 clean** |
| 4 | `shasum -a 256` after mutation restore | matches pre-mutation values (byte-identical restore) |

Full build not run: no imports changed in production code (`demonstration-recorder.tsx` imports the
same five `ui/select` symbols it already imported; only the test file's import strategy changed,
and tests are outside the app build graph).

Evidence dir `docs/verification/heroui-migration/ocr/fix-round-2-f4-native/` holds the final GREEN
run's `report.json`/results (5/5); RED failure texts are quoted above from the session log.
