# H03 (#446) — Dialog: Base UI → HeroUI v3.2.6 Modal
`dialog.tsx` keeps every export and prop. Call-site fixes: chat-transcript (trigger `render` in
function form, lightbox `size="full"`), routines-list + triggers (nested scrim `!`). styles.css adds
`@heroui/styles/components/modal.css` and `.../close-button.css`.
## Mapping
- `Dialog`→`Modal.Root` (`open`→`isOpen`, `onOpenChange` kept); `DialogContent`→`Backdrop` ›
  `Container(placement=center, scroll=inside, size=lg)` › `Dialog`; `DialogOverlay`→
  `Modal.Backdrop` (`variant="transparent"`, scrim from classes); `DialogPortal`→passthrough.
- `DialogTrigger`→`Pressable`+real `<button>`; `DialogClose`→`Button slot="close"`; built-in close→
  `Modal.CloseTrigger` (`<button>`, aria-label "Close" + sr-only, top-right); Title/Description→
  `Modal.Heading` / `Description`; Header/Body/Footer stay plain divs (HeroUI slots collide).

## Preserved
- `max-h-[85svh]!` (HeroUI's scroll-inside preset sets `max-height:100%`); body keeps
  `flex-1 min-h-0 overflow-y-auto`, header/footer pinned. `size="full"` is the viewport exception.
- Esc, backdrop dismissal, focus trap/scroll lock/return are React Aria's; probe confirms Esc,
  backdrop click and a real button trigger.
- `aria-labelledby` via the Heading slot. `aria-describedby` is added by `DialogContent` because RAC
  publishes `contentProps.id` only for `role="alertdialog"` (useDialog.mjs:29); the description
  registers its id, and no dangling reference is emitted when there is none.

## Nested backdrop
RAC never skips nested backdrops — each goes through `Overlay`, which always portals and renders.
Probed: two stacked dialogs = 2 overlays, inner backdrop wrapping the inner dialog. No shim; the
caller only re-colours it. `overlayClassName` replaces (not stacks) the scrim; nested sites use
`bg-black/20!` because component CSS is unlayered.

## Evidence
- typecheck: only `select.tsx` (another agent's in-flight wrapper).
- e2e native: shared-grant-dialog 3/3; billing-credits-ui 10p/8f, personal-credits-ui 3p/5f —
  identical counts with the HEAD dialog restored (`baseline-*`), so not caused by this change.
- bun-driven: account-mode-dialog 3/3, admin-credit-grant 7/7, admin-gateway-readiness 4/4,
  admin-catalog-sync 4/4. Temporary probe (deleted) 4/4: labelled+described, Close name, Esc,
  backdrop click, nested overlays.

## Gaps
- Browser-only: focus return, scroll lock, portal stacking, 200% zoom / short viewports.
- HeroUI CSS is imported unlayered, so `p-6`/`rounded`/`max-w-md`/backdrop fill beat call-site
  utilities (market `max-w-[640px]`, upgrade-dialog `max-w-2xl`). `layer(components)` fixes H02+H03.
- Dev-only RAC warning "PressResponder rendered without a pressable child" (triggerless dialogs).
