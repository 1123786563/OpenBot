## H02 — form primitives (input, textarea, label, separator, skeleton)
Base UI / plain shadcn replaced with HeroUI v3.2.6 primitives. No call site, `styles.css` or
`package.json` touched; no `@base-ui/react` import remains in these files.

| File | Primitive | Prop plumbing |
| --- | --- | --- |
| `input.tsx` | `Input` (React Aria `<input>`) | API unchanged (`ComponentProps<"input">`, ref-as-prop). `type`, `value`/`defaultValue`, `onChange` (one native event per keystroke), `name`, `placeholder`, `readOnly`, `required`, `aria-invalid` pass through. RAC's input takes native `disabled`, not `isDisabled`, so nothing is remapped and nothing leaks to the DOM. |
| `textarea.tsx` | `TextArea` | Same passthrough; `field-sizing-content` + `min-h-16` resize/floor kept. |
| `label.tsx` | `Label` | `htmlFor` and all label attributes forwarded; `className` merged. |
| `separator.tsx` | `Separator` | `orientation` kept (horizontal `<hr>`, vertical `<div role="separator">`). The element carries `data-orientation`, so the thin-line utilities moved from Base UI's `data-horizontal:`/`data-vertical:` to `data-[orientation=…]:`; the 1px `bg-border` look is unchanged. |
| `skeleton.tsx` | `Skeleton` | No `animationType`, so HeroUI adds only `.skeleton`; `animate-pulse`, `bg-ob-muted-surface`, `data-slot` and call-site sizing unchanged. |

Class strings are otherwise the old ones: HeroUI's CSS lands in `@layer components`, below Tailwind's
`utilities`, so density, radius and colour stay with the app. Input/textarea gained four neutralisers
(`shadow-none`, `hover:bg-transparent`, `focus:bg-transparent`, `aria-invalid:bg-transparent`) because
HeroUI's base adds a field shadow and fills the surface on hover/focus/invalid.

### Verification

- Typecheck: `bun run --cwd app typecheck` → exit 0, no diagnostics (`form-primitives-typecheck.log`).
- No test imports textarea/label/separator/skeleton directly; `bot-sharing.test.tsx` imports `Input`.
  Driven suites per ADR 0008 (`bun test`): bot-sharing 7/7, github-sources-settings 2/2, bot-memory
  5/5, bot-responsibilities 2/2 (types into `Textarea`), admin-gateway-readiness 4/4 — 20 tests, 0 fail.
- `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=… bunx e2e run --config e2e.unit.config.ts app/tests/composer-attachment-strip.test.tsx`
  → 8/8 passed (Skeleton while an upload is in flight).

### Left

- `craft-preview-tab.test.tsx` fails 66/79 here, stuck on "Checking for a web app…"; that pane
  imports only `Button` and its source is modified by another stream — not these files.
