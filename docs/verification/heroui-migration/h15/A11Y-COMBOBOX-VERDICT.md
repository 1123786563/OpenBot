# H15 a11y verdict — HeroUI Select trigger without `role="combobox"` (frontend_validator, 2026-10-20)

**Verdict: ACCEPT — no remediation required for the migration.** The trigger as shipped (a real
`<button>` exposing `aria-haspopup="listbox"`, `aria-expanded`, an accessible name, and the
selected value as its text content) is conformant under WCAG 4.1.2. Recommend keeping the
current implementation; fix the stale adapter comment when the frozen file is next touched
(already booked as W3A F4 → post-delivery doc fix by the H03 owner).

## Facts (established by prior waves, re-checked this wave)

- The adapter forwards `role="combobox"` (`app/src/components/ui/select.tsx` `SelectTrigger`,
  `TriggerWithRole`), but the chain HeroUI `SelectTrigger` → RAC `Button` → `useButton` →
  react-aria `filterDOMProps` (allowlist without `role`; `propRe=/^data-.*$/`) **drops the
  attribute** — W3A proved this at package level; live DOM dumps during the CDP runs confirm the
  rendered trigger has `role=""`/absent, `aria-haspopup="listbox"`, `aria-expanded`, and the
  value/placeholder as its text content.
- All test call sites were adapted (H04/H06/H07/H09): `getByRole("combobox")` →
  `getByRole("button", { name })` with the same accessible names — W3A verified the swaps are
  equal-or-stronger (role **and** name), with clicks/reads targeting the same control and option
  queries unchanged (RAC `ListBoxItem` keeps `role="option"`).

## Why this is conformant (WCAG 4.1.2 Name/Role/Value)

4.1.2 requires that the role, states and value of UI components be programmatically determinable
and that change notifications be available to user agents (including assistive technologies). It
does **not** mandate any specific role for a given control — only that the role exposed be
accurate for the actual behavior:

- **Name**: the trigger carries an accessible name at every call site (label association via
  `FieldLabel`↔`id` chains or `aria-label`), kept intact through the migration (H04/H07 waves).
- **Role**: the control's actual contract is "a button that opens a listbox" — exactly what
  `role=button` + `aria-haspopup="listbox"` + `aria-expanded` declares. This is the classic
  disclosure-button form of the "button + listbox" interaction; the ARIA Authoring Practices
  Guide presents the select-only combobox as *one* pattern, and WCAG conformance does not
  require adopting it when an alternative, accurately-declared pattern is used. Forcing
  `role="combobox"` would *import* the ARIA 1.2 combobox pattern's additional obligations
  (`aria-controls`, `aria-activedescendant`, combobox keyboard contract with the focus/typing
  model) that this implementation deliberately does not follow — a mis-declared role would be
  the non-conformant direction, not the fix.
- **Value**: the selected value is rendered as the button's visible text content (with a
  `data-placeholder` state when empty), so the current value is determinable and its changes are
  announced with the accessible-name updates.
- **State**: `aria-expanded`, `aria-disabled` (via RAC), focus-visible styling and
  `data-focused`/`data-selected` on options provide the remaining state exposure; keyboard
  operation (Enter/Space/ArrowDown to open, roving focus in the listbox, ESC to close with focus
  return) was verified by trusted CDP input in h01 RUN / h10 CDP and re-verified this wave.

## Residual notes (non-blocking, booked)

1. **Stale comment** (`ui/select.tsx` ~:515-519, "restoring the role keeps the public contract")
   is factually wrong — the role does not survive. Fix when the frozen adapter is next touched;
   until then the accurate record is this file + W3A F4 + h03/REPORT.md:9.
2. **Screen-reader UX delta**: NVDA/JAWS announce "button, popup listbox" rather than "combobox
   collapsed" — a behavioral difference from the Base-UI era, not a conformance failure. If a
   future wave wants closer parity, the correct route is adopting the full ARIA 1.2 combobox
   pattern (or an `aria-live` value announcement), a product-level decision outside this
   migration's contract.
3. **Same ruling applies to the combobox adapter** (H03's RAC-native ComboBox chips input +
   popover): the chips input is a real text input (role `textbox`/searchbox semantics with
   `aria-haspopup` from RAC) — accurately declared, conformant.
