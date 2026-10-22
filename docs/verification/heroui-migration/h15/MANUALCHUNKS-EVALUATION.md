# H15 performance item — manualChunks mitigation evaluation (frontend_validator, 2026-10-20)

**Recommendation: DO NOT adopt the manualChunks split at this stage. Keep the W7 gzip ACCEPT as
the terminal ruling; book the idea (or its better variant, dynamic-importing non-first-screen ui
adapters) as a post-delivery performance task with its own review, to be considered only if a
future wave structurally grows the entry again.**

## Measured facts (this wave, `app/dist/assets` = W7's fresh H14 build; closure recomputed)

Sign-page initial-JS closure = 7 files, **476,457 gzip** — independently re-summed and exactly
reproducing H14/W7 (over-budget vs H01 430,849 by **+45,608 / +10.58%**, i.e. **2,523 B** over
the +10% gate):

| chunk | gzip |
| --- | ---: |
| `index-j9rCLhii.js` (entry: shell + shared HeroUI/RAC runtime) | 419,966 |
| `react-CQCoTrUS.js` | 40,136 |
| `client-C696Rr5r.js` | 11,039 |
| `agent-orb-BR2aafH5.js` | 3,292 |
| `route-sign-Dxei_6io.js` | **1,477** |
| `separator-pH03lIvM.js` | 445 |
| `application-config-DU7S_WBW.js` | 102 |

Chat closure = 1,184,734 gzip (+1.41% vs H01, far inside the +116,827 gate). Total CSS = 61,184
gzip (+22.6%, carries the standing H02 ruling + the H03–H13 per-wrapper imports accounted 1:1).

`index.html` references only `index-j9rCLhii.js`; `route-sign` (the entire sign *route* code) is
**1,477 gzip = 0.3% of the page**. 99.8% of the overage lives in the entry, which every route
statically imports — this is the one-time structural cost of "公共控件统一由 HeroUI 承担" (A01),
not sign-page content. W7 reproduced all three totals to the byte and endorsed accepting.

## Why the manualChunks split does not pay for itself here

1. **It does not reduce the metric.** The sign route statically imports the entry (via the shell),
   so the browser downloads entry + vendor chunk regardless; cutting one 1.32 MB-raw chunk into
   two does not shrink the sum of gzip parts — chunk-boundary interop glue and lost gzip
   cross-chunk redundancy usually make it rise (~0.3–1% here ≈ up to +4 KB, i.e. more than the
   entire 2.5 KB overage it is meant to offset). The only benefit that a `vendor-heroui` chunk
   buys is **cross-deploy cache stability** (route-only deploys keep the runtime hash), which is
   a CDN-cache concern, not an initial-JS metric win, and brings no A09/AC5 relief.
2. **The variant that WOULD move the metric is a bigger change.** Making the sign page actually
   download less requires dynamic-importing the non-first-screen ui adapters (dialog/select/
   dropdown/tooltip/sheet/context-menu/combobox overlays hoisted into the entry) so the runtime
   is no longer in the static closure — that changes render timing (extra waterfall for first
   overlay open), touches the shell that all 88 routes share, and re-opens the exact surfaces
   H02–H13 froze and all ten waves' checkpoints pinned. A re-cut of provider-heavy RAC code also
   carries the classic manualChunks circular-init-order hazard (react-aria context providers,
   collection registries are evaluation-order sensitive).
3. **Risk asymmetry at this point in the delivery.** All H01–H14 waves are independently reviewed
   PASS; the ledger's native account is 995/995 EXIT 0 with the current build configuration; the
   gzip numbers are frozen evidence in h01/h02/h14. Adopting a build-config change now would
   invalidate that chain for a 2.5 KB (0.55% of baseline) metric delta that already carries a
   documented, independently reproduced review acceptance (AC5's own requirement — "定位并评审" —
   is fully satisfied: located at 99.8% entry-chunk, mechanism identified, accepted by review).
4. **The budget the overage misses is a self-imposed gate, not a spec ceiling.** Spec A09/AC5
   require explanation + review for >10%, not a hard cap. The explanation exists (H14 §7), was
   independently reproduced (W7 §f), and the residual-optimization option was explicitly booked
   as an H15 evaluation item — discharged by this document.

## If the team still wants the win later

Book as one task, not a config tweak: (a) inventory which of the 14 ui adapters are truly
first-screen; (b) dynamic-import the overlay adapters at their call sites (React `lazy` at the
shell level), measuring render-delay cost on first overlay open; (c) only then consider a
manualChunks cut for the remaining shared runtime, with fresh gzip baselines, a full native+driven
re-run, and an independent review of chunk-load ordering. Expected best case on today's numbers:
sign page back under the +10% gate; chat unchanged. None of this blocks or burdens H15 acceptance.
