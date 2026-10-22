# H09 · shared controls (sheet + sidebar)

## Mapping
- `sheet.tsx`: Base UI Dialog → HeroUI `Drawer` (Root → `Backdrop` → `Content`=Modal/placement → `Dialog` + `Header`/`Heading`/`Footer`/close).
  Exports unchanged: `Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger`.
  `open`/`isOpen` → root `isOpen`; `onOpenChange` forwarded; `side` → `Content placement`; `className`/`style` on the panel.
  Old close button kept (ghost icon-sm `Button`, `IconX`, sr-only "Close"). `SheetOverlay`/`SheetPortal` were never exported and are gone.
  `modal` accepted and ignored (`@deprecated`): Drawer is modal-only; no call site passes it.
- `sidebar.tsx`: Base UI `useRender`/`mergeProps` replaced by a local `renderSlot` keeping both render forms, the `(props, state)`
  callback, class/style/handler merging and the same `data-slot`/`data-sidebar`/`data-size`/`data-active` output. No Base UI import remains.
  Call sites needed no changes: `detail-panel`, `app-sidebar`, `settings-sidebar`, `admin-sidebar` are untouched by H09.

## Preserved

- Real anchors (clones the caller's `Link`; verified `<a href>` keeps href and merged classes).
- Ctrl/⌘+B via `keyOf`, selected/collapse state, provider and exported API unchanged.
- Mobile drawer stays a `Sheet`: 18rem panel, sr-only title/description, close hidden by `[&>button]:hidden`.
  `max-w-none` added so `.drawer__dialog { max-w:85vw }` cannot clip 288px at 320px.
- HeroUI's drag-to-dismiss would set inline `touch-action:none` over the roster's touch scrolling; `SheetContent` overrides
  the pointer handlers (`undefined`) and restores `touch-action:auto`. Outside-press/Escape still close via `isDismissable`.

## Required CSS (orchestrator adds)

`@import "@heroui/styles/components/drawer.css" layer(components);` — H03 already imports `close-button.css`, `surface.css`,
`description.css`, `button.css`.

## Evidence

- typecheck exit 0; `biome check` clean on both wrappers.
- native (`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h09/native bunx e2e run --config e2e.unit.config.ts …`):
  5 files / 20 tests pass — sidebar-shortcut-layouts 3, channel-unread 8, channel-order 3, channel-search 4, detail-panel 2
  (dialog by name "Computer", close click, unmount).
- driven (`bun test`): channel-pagination + live-screen-app-shortcuts → 7 pass / 0 fail.
- Deleted happy-dom probe: mobile Sidebar opens `role=dialog` labelled by title, Escape closes it, focus returns to the toggle,
  panel style is `touch-action:auto` + 18rem.
- "PressResponder … no pressable child" also appears with the HEAD sidebar (8×) here and is H03's triggerless-overlay warning — not H09.

## Gaps

Browser-only, not exercised (no browser stack): scroll-lock release, outside-press dismissal, portal/z-index, real-layout focus trap, 320px/short-viewport rendering, touch scrolling. `modal={false}` has no Drawer equivalent and is ignored (unused).
