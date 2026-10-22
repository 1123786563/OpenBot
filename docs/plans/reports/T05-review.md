# T05 independent review — Bot configuration flows

## Scope and checkpoint integrity

Reviewed the T05 brief and review brief, P08–P15 in `route-acceptance.json`, `implementation-spec.md` §§4–8, `implementation-detail.md` §§2, 5–6, `layout-contract.md`, `CONTEXT.md`, ADR 0008, all eight route files and their owned components, and the seven listed behavior tests. This is a source and evidence review; rendered browser acceptance was expressly deferred.

Recomputed SHA-256 over every owned live path and its PRE and POST snapshot. All 28 paths exist and all six values per path (PRE snapshot, POST snapshot, live file, PRE manifest, POST manifest original and POST manifest computed hash) agree. POST manifest SHA-256 is `cbea14a5265998455b61bac8235c5babd35c3c31fb74e85f70f59ea91fcb8e3b`; the delta package lists zero changed paths. Thus there is no hidden T05 owned-path edit. This establishes no T05 source regression, but it does not establish that the unchanged pages satisfy every accepted requirement.

## Findings

### T05-S1 — Medium — background failure replaces previously loaded Bot page

- **Evidence / affected symbol:** `app/src/components/bot-profile/bot-subpage.tsx:25,35–40` renders `children(agent.data)` only when `agent.error` is false. A TanStack Query refetch can have both prior `data` and an `error`; all eight routes use this frame. `implementation-spec.md` §8 and P08–P15 exception criteria require a background failure to retain existing content.
- **Impact:** An intermittent profile refetch failure removes the entire configuration content and its in-progress dialogs even though cached Bot data remains, losing a draft and blocking recovery through the existing controls. This affects each P08–P15 route.
- **Smallest correction:** Render existing data whenever present and show the refresh error alongside it; use the unreachable state only when there is no usable data. Add a behavioral case for successful load followed by failed refetch with draft/content retained.

### T05-S2 — Medium — pending SMS confirmation is not scoped to a Bot

- **Evidence / affected symbol:** `app/src/components/delivery/reaching-you.tsx:65–76,122–130,157–165,280–288,480–493` stores one challenge ID under the constant `openbot.reachability.pendingSms`, regardless of `fixedBot`, then offers that challenge on any Bot's Reach page. The confirmation request carries only `{challengeId, code}`. P09 requires the page to preserve Bot ownership and correct binding context; the T05 brief calls out tenant/resource ownership and privacy.
- **Impact:** A pending verification started for Bot A appears on Bot B's page in the same tab. A user can complete A's challenge while viewing B, and the UI presents misleading Bot context. Server checks may still enforce authorization; the source does not prove a server bypass.
- **Smallest correction:** Persist the challenge together with its Bot and channel identity (and current user/tenant scope if that storage survives identity switches), and show/confirm it only in the matching context. Add a cross-Bot navigation case to `bot-reaching-you.test.tsx`.

### T05-S3 — Medium — routines' secondary actions remain inline

- **Evidence / affected symbol:** P12 `route-acceptance.json` narrow-screen rule says “任务名、调度与状态分层；次要操作放菜单.” `app/src/components/routines/routines-list.tsx:394–450` renders Run now, History, and Delete as adjacent visible buttons in every row. No T05 delta implements the P12 rule.
- **Impact:** The narrow routines row does not meet the accepted information hierarchy; the three actions consume width beside long schedule/status content and can crowd the 390px configuration page. Rendered overflow itself remains unverified.
- **Smallest correction:** Keep the primary action directly accessible and put secondary row actions in an accessible menu while retaining their handlers, delete confirmation, and keyboard behavior. Add a DOM assertion for action availability and menu behavior; verify geometry later in the deferred browser pass.

## Quality and evidence assessment

The shared `BotSubpage` uses the 672px `PageShell` default; the eight route files remain distinct and their source order broadly follows P08–P15. Setup and sharing use `canManage`/`mine` gates; the existing Dialog Select controls, local drafts, callback token one-time display, and routine delete confirmation are present. The seven listed tests exercise representative successful and failed flows, but they do not cover the background profile-refetch case, cross-Bot SMS challenge, or P12 secondary-action menu. `T05-impl.md` records an e2e-driven run with six selected groups passing and no T05 source edits; I did not duplicate that run. ADR 0008 permits the driven partition, including isolated reruns of shared-process failures. No browser, real-identity permission, responsive, contrast, or focus outcome is claimed here.

**Spec verdict:** **Fail at source level** for S1–S3. The no-change decision cannot close P08–P15 source acceptance. Rendered acceptance remains pending by instruction.

**Quality verdict:** **No T05 delta regression; existing quality gaps remain.** The checkpoint package is complete and hash-consistent, but S1–S2 affect data consistency and resource context, and S3 is an unmet layout requirement. No source, test, requirement, or remote issue was changed in this review.
