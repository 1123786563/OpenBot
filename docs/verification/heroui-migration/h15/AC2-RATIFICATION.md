# H15 / F6 — Ticket #457 AC2 ratification note (frontend_validator, 2026-10-20)

Status: **ratified — current state accepted** (validator recommendation for the acceptance record;
final OCR/主控 countersign happens at the final review). This note discharges W7 carry item F6
("spec-owner ratification of the AC2 shadcn retention — record it so the acceptance record does
not silently diverge from the ticket text").

## The deviation being ratified

- Ticket #457 AC2 literal wording (`docs/tickets/heroui-migration/issues/h14.md:30`): 「删除
  shadcn/tailwind.css；shadcn CLI、tw-animate-css、cva 按实际使用决定，未使用才删除。」
- Design doc step (`docs/specs/2026-10-19-heroui-ui-migration-design.md:233`): 「删除
  `@base-ui/react` 直接依赖及 `shadcn/tailwind.css` 后重建」— written under the premise that the
  import was part of the old foundation to be removed.
- H14 outcome: `app/src/styles.css:63` still reads `@import "shadcn/tailwind.css";`. H14 recorded
  AC2 as 「部分达成，偏离有据」. W7 proved the import **exists verbatim at BASE**
  (`git show 203d0f02:app/src/styles.css` line 3 — identical statement): the premise "H02 已删该
  import" was false; the import was never deleted by anyone.

## Why the current state is accepted (evidence recap, independently re-checked this wave)

1. **Load-bearing production input.** `shadcn@4.21.0/dist/tailwind.css` provides the
   `data-open/-closed/-checked/-unchecked/-selected/-disabled/-active/-horizontal/-vertical`
   `@custom-variant` registrations, `@utility no-scrollbar`, the `scroll-fade-*` family and
   `@theme` keyframes. Verified consumers in the migrated ui layer include
   `ui/sidebar.tsx:478` (`no-scrollbar`), `ui/message-scroller.tsx:43` + `app-sidebar.tsx:274`
   (`scroll-fade-b`), `ui/field.tsx:142` (`has-data-checked:`), `ui/questionnaire.tsx:107-108`,
   `ui/context-menu.tsx:808`, `ui/dropdown-menu.tsx:381`, `ui/select.tsx:699`. Deleting the
   import breaks production styles today; deleting the package breaks it at the next install.
2. **Zero theme pollution.** W7 read the preset in full: no `:root`/element-selector
   declarations, no color/token cascade values — only `@theme` keyframes, `@custom-variant` /
   `@utility` registrations and `@property` descriptors (no cascade values). Its sole unlayered
   rule is a `prefers-reduced-motion` branch matching only `.shimmer`, which `app/src` does not
   use (the app's own shimmer lives in `@layer ob-app` with its own reduced-motion branch,
   styles.css:282-288). Consistent with the H02-era precedent
   (`prompt-area/tailwind.css` imported the same way at BASE).
3. **Consistency with AC2's own principle.** AC2's second clause already applies "按实际使用决定，
   未使用才删除" to the sibling packages (CLI / tw-animate-css / cva — all retained with usage
   evidence). The same principle applied to the css export yields "keep".

## Recommended post-delivery edit (spec owner; NOT performed by the validator)

Correct the two stale statements so the record does not re-inject the false premise:

- `docs/specs/2026-10-19-heroui-ui-migration-design.md:233`: change 「删除 `@base-ui/react`
  直接依赖及 `shadcn/tailwind.css` 后重建」 to record that `shadcn/tailwind.css` was audited
  (H14/W7) as a BASE-preexisting production input (data-* variants, `no-scrollbar`,
  `scroll-fade-*`) and **retained**, with the ticket's own "按实际使用决定" principle as the basis.
- `docs/tickets/heroui-migration/issues/h14.md:30` (AC2): annotate — retained under the clause's
  own usage-decision principle; premise "H02 已删该 import" corrected (never deleted; proven at
  BASE by W7, ratified here at H15).

Per H15 scope (validator read-only for production/spec sources) these edits belong to the spec
owner / orchestrator as a post-delivery doc fix, alongside the W7 F3/F5 report-wording items.

## Scope note (provenance nit carried from W7 F5b, recorded here because this note supersedes it)

`ui/select.tsx:699`'s `data-focused:`/`data-hovered:` variants are provided by the
`@heroui/styles/utilities|variants` imports (styles.css:60-61), not by the shadcn preset; the
H14 report's AC2 evidence line over-attributes them to shadcn. This does not affect the verdict —
the shadcn-provided exports listed above are genuinely consumed.
