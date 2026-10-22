# H02 — app composites (item, input-group, empty, field)

Scope: `app/src/components/ui/{item,input-group,empty,field}.tsx`. Route/component call sites, styles.css, package.json and tests untouched.

## What changed

- `item.tsx` — was the only file importing `@base-ui/react` (`useRender`, `mergeProps`). Replaced with plain JSX: `render` still accepts an element or a function; the element form goes through a documented `mergeItemProps` (element props win, classes/styles combined, handlers chained element-first, matching Base UI's `mergeProps` order). `data-slot="item"`, `data-variant`, `data-size` (Base UI generated these from `state`) are rendered explicitly.
- `field.tsx` — `Field` owns an `errorId` (via `useId`) and passes it through context; `FieldError` uses it as `id` and keeps `role="alert"`; when `data-invalid` is true the field group references the message with `aria-describedby` (merged with any caller value). Invalid state is carried by message text + `data-invalid`, not only colour.
- `input-group.tsx`, `empty.tsx` — already Base UI-free; kept as plain composition. HeroUI `InputGroup`/`EmptyState`/`Description`/`FieldError` were checked and rejected: their contexts (RAC `Group`/TextField, HeroUI base classes) do not match these app-owned parts or would need call-site/API changes. HeroUI `Label` is already reached through `FieldLabel` → `ui/label`.
- Zero `@base-ui/react` imports across all four files (`rg` exit 1).

## API preserved

All existing exports, props and variants unchanged; `Item.render` keeps both forms (function form is used at `routes/_authed/admin/index.tsx`), `InputGroup*` ref forwarding untouched, `Empty*` structure/copy untouched, `Field*` exports unchanged.

## Evidence

- `bun run --cwd app typecheck` → exit 0; full log `h02/composites-typecheck.log`.
- `bunx e2e run --config e2e.unit.config.ts app/tests/item-disabled.test.tsx` → 1 file / 1 test passed (run 01a1546b, output `h02/composites/`). Only test referencing these wrappers.

## Left

- Per-control `aria-describedby`/`aria-invalid` still belongs to call sites (e.g. `admin/gateway.tsx` passes `data-invalid` but no control association); wiring controls automatically would require call-site edits, out of scope.
- `Item`'s element form does not chain a `ref` when both Item and the rendered element have one; no call site passes a ref to `Item`.
