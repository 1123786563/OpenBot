# T07 independent review — PRE→POST

## Scope and integrity

- Reviewed the T07 parent plan and brief, approved `implementation-spec.md` and `implementation-detail.md`, P01–P05 in `route-acceptance.json`, `CONTEXT.md`, ADR 0008, and the exact checkpoint package under `docs/verification/workspace-redesign/execution/checkpoints/t07/`.
- PRE and POST both list the same 84 owned source/test paths at HEAD `203d0f0244b2f898218fa12027089c631e8448d9`. Comparing manifest byte counts and SHA-256 values yields exactly three changed files: `chat-transcript.tsx`, `conversation-view.tsx`, and `group-chat.tsx`. Every POST path hash matches the live file. POST manifest SHA-256 is `2cad641c00948db33c286e2ea5f365a95aef4e8bc766ea51ac19fb529d275456`; delta patch SHA-256 is `856cb89d9ce5872b19725b20cb0cba95f6061992c3a12955e5aae8fe749dbfd9`. These match the implementation report and checkpoint marker.
- No tests or OCR were run for this independent review. The implementation report records passing targeted native/driven suites, Biome and build, with app typecheck blocked by unrelated test errors. Browser acceptance remains deferred; those reported results were not independently rerun here.

## Spec compliance verdict: **fail — one medium finding**

### T07-S1 — Medium — Home composing column remains 672px

- **Evidence:** The approved `implementation-spec.md` §5 says “聊天消息/输入阅读列=720px”; `verification-plan.md` §3 calls message 720 a max-width, and T07 explicitly covers P01 home plus P02–P05. The delta changes transcript and single/group composer containers to `max-w-[720px]`, but [home route](/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/app/src/routes/_authed/_app/index.tsx:62) still gives the P01 primary `Composer` `max-w-2xl` (672px). Its adjacent hint/error rows remain at 672px. The P01 route is absent from the three-file delta.
- **Impact:** On a wide home view the primary input stays 48px narrower than the approved chat input column and the subsequent conversation composer. The P01 visual acceptance for a consistent 720px chat input column is incomplete. This does not itself show a send or state regression.
- **Smallest defensible correction:** In the T07-owned home route, set the primary composer and its aligned hint/error rows to the 720px cap, retaining the home page's existing responsive outer padding and send behavior. Bind the corrected file to a new checkpoint and review.

The P02/P03 single-chat transcript and composer, and the P04 group transcript and composer, now share a 720px outer cap and `px-4` inner inset. Their existing structure leaves transcript scrolling inside `MessageScrollerViewport`/the group `overflow-y-auto` region while composer containers remain `shrink-0` flex siblings at the bottom. P03's route-backed `settings/watch/workshop`, 400/480px detail widths, and DetailPanel thresholds are untouched by this delta. P05's standalone `/bot` route is also untouched; its packaged `CopilotChat` width needs the deferred runtime geometry check before claiming 720px compliance.

## Code quality verdict: **pass for the three-file delta, subject to the spec finding**

The delta consists solely of four width/inset class changes in three T07-owned components. It adds no data flow, API, permission, URL, timing, or state changes. The same `px-4` adjustment is applied to transcript and composer in single and group chat, avoiding the previous visible inner-inset difference in source. Existing scroll containers, flex sizing, and composer placement remain intact. No correctness, security, concurrency, or data consistency defect is evident in this delta. The absence of a focused geometry assertion is an acceptance evidence gap: the deferred browser check should measure 720px caps, left/right alignment (including scrollbar gutter), narrow viewport overflow, and composer reachability with a soft keyboard. Source inspection cannot certify those rendered conditions.

**Gate:** T07 should remain unverified until T07-S1 is corrected and independently reviewed; browser/runtime acceptance stays pending under the brief.
