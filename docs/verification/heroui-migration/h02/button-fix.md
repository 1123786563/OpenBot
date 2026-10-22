# H02 — Button contract fix

## Files changed

Wrapper:

- `app/src/components/ui/button.tsx` — `disabled` → `isDisabled`, React-element `render` adapter, `title`/`role` passthrough.
- `app/src/components/ui/router-link.tsx` (new) — `ButtonLink`, a real TanStack Router `<a>` (or external `<a>` for `href`).
- `app/src/components/ui/checkbox.tsx`, `app/src/components/ui/switch.tsx` — two-line pre-existing type errors (`isDisabled` prop, callable `inputRef`) that blocked `typecheck` exit 0.

Link buttons migrated from `Button render={<Link/>}` / `Button render={(props) => <Link/>}` to `ButtonLink`:

- `app/src/components/agents/agent-card.tsx`, `agent-profile.tsx`
- `app/src/components/ai-observability/run-detail.tsx`, `runs-list.tsx`
- `app/src/components/app-sidebar/app-sidebar.tsx`
- `app/src/components/craft/session-sidebar.tsx`
- `app/src/components/layout/page-shell.tsx`
- `app/src/components/market/connectors-pane.tsx`, `experts-pane.tsx`, `skills-pane.tsx`, `wb.tsx` (`WbPrimaryLink`)
- `app/src/components/passwords/sign-in-form.tsx`
- `app/src/routes/_authed/_app/{bots.index,craft/tasks,skills}.tsx`
- `app/src/routes/_authed/admin/components/$name.tsx`
- `app/src/routes/_authed/settings/components-gallery/$name.tsx`

Tests:

- `app/tests/button-native.test.tsx` — rewritten for the new contract.
- `app/tests/heroui-spike.test.tsx` — Tooltip trigger cast only; assertions unchanged.

## Adapter semantics

`ButtonProps` keeps the app API:

- `disabled?: boolean` is mapped to RAC's `isDisabled` (explicit `isDisabled` wins) and never forwarded.
- `nativeButton` stays accepted-and-ignored.
- `title` / `role` are accepted and forwarded as plain DOM attributes.
- `render` accepts React Aria's function **or** a `ReactElement`.

For an element, `adaptRender` converts it to the function form by cloning the element with merged props:

- `className`: `cn(domProps.className, element.className)` (tailwind-merge resolves conflicts; note `from-*` names share a group).
- `style`: shallow-merged, element wins.
- `ref`: both refs invoked once.
- same-named event handlers: chained, both run once, element handler last.
- all other props: element wins (`href`, `to`, `search`, `params` survive); `children` falls back to React Aria's when the element has none.

The adapter is a compatibility bridge, not link semantics: React Aria still expects a `<button>`, so an anchor stays `role=null` and logs a dev warning. `ButtonLink` is the supported way to draw a link button.

`ButtonLink` renders a real anchor through `Link` (or a plain `<a>` when `href` is set) with `buttonVariants` classes, supports `to`/`params`/`search`/`activeProps`/`inactiveProps` plus normal anchor props, and never nests a button or a second anchor.

## Call sites left on the adapter

- `app/src/components/bot-profile/activity.tsx:137` — `render={link}`, where `linkFor()` returns a `<Link>` element shared with an `Item render={link}` on line 146. Splitting element vs props there is ambiguous, so it stays on the adapter.

## Verification

`bun run --cwd app typecheck` → exit 0 (`tsc --noEmit` printed no diagnostics).

`E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=docs/verification/heroui-migration/h02/button-fix bunx e2e run --config e2e.unit.config.ts app/tests/button-native.test.tsx app/tests/heroui-spike.test.tsx`:

```
 ✓ |node| app/tests/button-native.test.tsx (7 tests) 139ms
 ✓ |node| app/tests/heroui-spike.test.tsx (15 tests) 646ms

 Test Files  2 passed (2)
      Tests  22 passed (22)
```

`button-native` covers: native button; `disabled` → `isDisabled`; element-render adapter (href, merged classes, chained handlers, no button role); RAC function render; `nativeButton`; `ButtonLink` via a real router context (anchor `href="/"`, no role, no nested `button`/`a`); `ButtonLink href` external anchor.
