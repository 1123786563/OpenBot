---
name: OpenBot
description: An operations console for AI bots, wearing HeroUI's native default theme
baseline: "HeroUI native default theme (user decision 2026-10-20, issue #502); supersedes the WorkBuddy-preserved palette"
colors:
  background: "#f5f5f5" # oklch(0.9702 0 0)
  foreground: "#18181b" # oklch(0.2103 0.0059 285.89) — HeroUI "eclipse"
  card: "#ffffff"
  card-foreground: "#18181b"
  popover: "#ffffff"
  popover-foreground: "#18181b"
  primary: "#0485f7" # oklch(0.6204 0.195 253.83) — HeroUI accent (hex approximations throughout)
  primary-foreground: "#fcfcfc" # oklch(0.9911 0 0) — HeroUI "snow"
  secondary: "#ebebec" # oklch(94% 0.001 286.375) — HeroUI "default"
  secondary-foreground: "#18181b"
  muted: "#efeff0" # oklch(0.9524 0.0013 286.37) — quiet surface
  muted-foreground: "#71717a" # oklch(0.5517 0.0138 285.94) — muted text
  accent: "#0485f7"
  accent-foreground: "#fcfcfc"
  brand: "#0485f7" # brand follows the accent blue (issue #502); teal retired
  destructive: "#ff383c" # oklch(0.6532 0.2328 25.74)
  destructive-foreground: "#fcfcfc"
  success: "#17c964" # oklch(0.7329 0.1935 150.81); ink on it is eclipse, not white
  border: "#dedee0" # oklch(90% 0.004 286.32)
  input: "#dedee0" # legacy border-input STROKE = border ladder (R1b); HeroUI field fill itself is borderless white
  ring: "#0485f7"
  sidebar: "#efeff0" # surface-secondary ground in light; in dark the ground is --surface (0.2103) — a deliberate deviation (keeps the sidebar no lighter than cards); accent = surface-tertiary both themes
  sidebar-foreground: "#18181b"
  sidebar-accent: "#eaeaeb" # oklch(0.9373 0.0013 286.37) — one step deeper
  sidebar-accent-foreground: "#18181b"
  sidebar-border: "#dedee0"
  sidebar-ring: "#0485f7"
  chart-1: "#0485f7" # the accent itself
  chart-2: "#c9690c" # oklch(0.62 0.15 55)
  chart-3: "#05893e" # oklch(0.55 0.15 150)
  chart-4: "#8843db" # oklch(0.55 0.22 300)
  chart-5: "#c72da2" # oklch(0.58 0.22 340)
  dark-background: "#060607" # oklch(12% 0.005 285.823)
  dark-foreground: "#fcfcfc"
  dark-card: "#18181b" # oklch(0.2103 0.0059 285.89)
  dark-primary: "#0485f7" # the accent is theme-independent
  dark-primary-foreground: "#fcfcfc"
  dark-accent: "#232325" # oklch(0.257 0.0037 286.14)
  dark-accent-foreground: "#fcfcfc"
  dark-destructive: "#db3b3e" # oklch(0.594 0.1967 24.63)
  dark-success: "#17c964"
  dark-brand: "#0485f7"
  dark-border: "#28282c" # oklch(28% 0.006 286.033)
  dark-input: "#28282c" # stroke ladder in dark (R1b); field fill stays borderless
  dark-ring: "#0485f7"
  dark-sidebar: "#18181b"
  dark-sidebar-accent: "#262728" # oklch(0.2721 0.0024 247.91)
  dark-chart-1: "#0485f7"
  dark-chart-2: "#f0a646" # oklch(0.78 0.14 70)
  dark-chart-3: "#55c975" # oklch(0.75 0.16 150)
  dark-chart-4: "#b180fc" # oklch(0.7 0.18 300)
  dark-chart-5: "#e867c3" # oklch(0.7 0.19 340)
typography:
  display:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.333rem"
    fontWeight: 600
    lineHeight: 1.25
  headline:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "calc(var(--radius) * 0.6)"
  md: "calc(var(--radius) * 0.8)"
  lg: "var(--radius)"
  xl: "calc(var(--radius) * 1.4)"
  2xl: "calc(var(--radius) * 1.8)"
  3xl: "calc(var(--radius) * 2.2)"
  4xl: "calc(var(--radius) * 2.6)"
spacing:
  xs: "0.5rem"
  sm: "0.625rem"
  md: "1rem"
  gutter: "1.5rem"
  dialog: "1.25rem"
  section-gap: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.lg}"
    padding: "0.625rem"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "accent mixed 90/10 with snow (HeroUI's --accent-hover)"
  control-checked:
    backgroundColor: "{colors.brand}"
    note: "Switches, checkboxes, radios and progress turn accent blue when ON — HeroUI's native selected state; buttons are the same accent"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.2xl}"
    border: "1px solid {colors.border}"
    shadow: "HeroUI surface-shadow (0 2px 4px / 4% + 0 1px 2px / 6% + 0 0 1px / 6%); none in dark"
  dialog-surface:
    backgroundColor: "{colors.popover}"
    rounded: "{rounded.xl}"
    padding: "1.25rem"
    width: "32rem"
  modal-scrim:
    # As shipped (ui/dialog.tsx, migration-era choice kept in the R wave): 15% black light /
    # 60% dark with a subtle backdrop blur when the browser supports it. HeroUI's own --backdrop
    # (50%/60%, no blur) is NOT applied because the app's Dialog wrapper owns the scrim element.
    backgroundColor: "rgba(0,0,0,.15) light / rgba(0,0,0,.6) dark (app dialog.tsx)"
    blur: "backdrop-blur-xs when supported"
---

# Design System: OpenBot

## Overview

**Creative North Star: HeroUI's own voice, spoken by an operations console.**

> **2026-10-20 (issue #502):** this revision supersedes the WorkBuddy-preserved palette. After the
> HeroUI v3 migration delivered, the user reviewed a preview of the library's native default theme
> and chose it over the preserved WorkBuddy look. Because the migration had routed every colour
> through `app/src/styles/tokens.css`, the redesign was a two-file swap: token values + one root
> font-size change. No component, route or test file was edited. Hex values above are sRGB
> approximations of the oklch tokens; `variables.css` in `@heroui/styles` is the ground truth.

OpenBot's browser app is a quiet, instrument-grade console: administrators decide whether to trust
it with credentials, operators watch bots work, and the interface's job is to stay out of the way
while state changes underneath it. That discipline is unchanged. What changed with issue #502 is
the *voice*: every value now comes from HeroUI's native default theme
(`@heroui/styles/dist/themes/default/variables.css`), not from WorkBuddy's bundle — the blue
accent, the cool zinc-family neutrals, the 16px root, the 8px control radius, and HeroUI's
whisper-easy surface shadow.

The palette carries a deliberate division of labor, now HeroUI's own:

- **Blue is the interactive layer.** The action colour is HeroUI's accent
  `oklch(0.6204 0.195 253.83)` — the same in light and dark. Primary buttons, text buttons, focus
  rings, and the active-nav ink are all this layer, with snow `oklch(0.9911 0 0)` as the ink on it.
- **Blue is also the identity layer.** The WorkBuddy teal brand is retired (issue #502): brand
  follows the accent everywhere — unread dots, running marks, controls in their ON state, progress
  fills, chart-1. There is no second brand hue any more.
- **Semantic color stays semantic.** HeroUI's danger `oklch(0.6532 0.2328 25.74)` and success
  `oklch(0.7329 0.1935 150.81)` keep the tint discipline, and the chart ramp takes the accent blue
  plus amber, green, violet and rose (see Charts).

The neutrals are HeroUI's zinc-family ramp, not warm paper: canvas `oklch(0.9702 0 0)`, sidebar and
quiet surfaces `oklch(0.9524 0.0013 286.37)`, cards white, hairlines `oklch(90% 0.004 286.32)`, ink
`oklch(0.2103 0.0059 285.89)` ("eclipse"). One gray step separates the sidebar from its selected
row and the canvas from its cards — the same "gray canvas, white panes" structure, at HeroUI's
lightnesses. Dark mode runs canvas `oklch(12% 0.005 285.823)` under surfaces `oklch(0.2103 0.0059
285.89)`.

The system is HeroUI v3 (components) driven by a token sheet — `app/src/styles/tokens.css` for the
`--ob-*` values, `styles.css` for layers/utilities — with a light default and a `.dark` variant.
Structure comes from one layout contract — every configuration screen is `PageShell →
PageSection → PageRows`, one prose-width column of titled card groups — and from spacing that does
the work dividers would otherwise do.

Motion is small and purposeful. State transitions run 150ms ease-out; the sidebar collapses linearly
at 200ms; a running tool line sweeps a subtle shimmer across its own glyphs (1.6s, compositor-only);
lists mount with a 4px staggered rise. That is the entire motion budget.

**Key Characteristics:**

- HeroUI-native values: accent blue, zinc neutrals, snow-on-accent buttons, 16px root, 8px control
  radius, no field strokes (fields are white fills), HeroUI surface shadows
- Gray canvas + white cards: the page is one gray step behind its cards, the sidebar at the
  hover-surface step, its selected row one deeper
- One accent for buttons AND controls' ON state — the WorkBuddy "black buttons vs teal controls"
  split is retired (issue #502)
- One layout contract (`PageShell`/`PageSection`/`PageRows`) for every configuration screen
- Sidebar at the familiar widths: 17.5rem expanded, 3.2rem collapsed (280px / 51px at the 16px root)
- Inter Variable as the single typeface; weight (600/500/400) is the hierarchy instrument

## Colors

### Interactive (accent blue)

- **Accent Button** (`--primary: oklch(0.6204 0.195 253.83)`): primary buttons, text-button ink in
  accents, focus rings, and the sidebar's active-item emphasis. The accent is theme-independent:
  blue buttons in light AND dark. Hover mixes 90/10 with snow (HeroUI's `--accent-hover`).

### Identity (also blue)

- **Brand = Accent** (`--brand: oklch(0.6204 0.195 253.83)`): the unread dot in the conversation
  list, the ON state of every switch/checkbox/radio, progress bars, chart-1, and the market page's
  accents. Ink on the blue fill is snow (HeroUI's pairing). Retiring the teal was the point of
  issue #502: one hue now says "this system acts", everywhere.

### Semantic

- **Danger** (`--destructive: oklch(0.6532 0.2328 25.74)`, dark `oklch(0.594 0.1967 24.63)`):
  3.6:1 on white — HeroUI's own baseline, kept as-is per the user decision (the old WorkBuddy red
  was 5.9:1). Tinted surfaces (`/10`, hover `/20`) with snow ink on solid fills; destructive buttons
  are never solid red.
- **Success** (`--success: oklch(0.7329 0.1935 150.81)`): HeroUI pairs it with dark ink
  (`oklch(0.2103 …)`, 8.1:1 on the green), never white (1.9:1).

### Neutral

- **Canvas** (`oklch(0.9702 0 0)`): the page. `--background` everywhere the app is not a card.
- **Panel** (`--sidebar: oklch(0.9524 0.0013 286.37)`): the sidebar ground, HeroUI's
  `--surface-secondary`. The selected/hover item steps one deeper still (`--sidebar-accent:
  oklch(0.9373 0.0013 286.37)`) with full-ink text — the quiet "selected row" pattern: no tint,
  just gray depth and weight 500.
- **Card White** (`#ffffff`): cards and popovers, raised off the canvas by a hairline plus HeroUI's
  `surface-shadow` (`0 2px 4px / 4%`, `0 1px 2px / 6%`, `0 0 1px / 6%`).
- **Hairline** (`oklch(90% 0.004 286.32)`): borders and strokes; dark `oklch(28% 0.006 286.033)`.
  Form fields have NO stroke — `--field-border: transparent` with `--field-border-width: 0`; the
  white fill (dark: surface fill) is the field's boundary.
- **Muted Ink** (`--muted-foreground: oklch(0.5517 0.0138 285.94)`): descriptions and empty states;
  4.8:1 on white, 6.7:1 on the dark surface (dark: `oklch(70.5% 0.015 286.067)`).
- **Focus** (`--ring: oklch(0.6204 0.195 253.83)`): the accent — HeroUI draws focus as the accent
  colour (`--focus: var(--accent)`), not a black halo.
- **Chart Chroma** (`--chart-1…5`): accent blue, amber `oklch(0.62 0.15 55)`, green
  `oklch(0.55 0.15 150)`, violet `oklch(0.55 0.22 300)`, rose `oklch(0.58 0.22 340)`; dark mode
  lifts each hue to clear 3:1 on the dark surface. All ten values clear 3:1 against their ground
  (see Charts).

### Named Rules

**The Two-Layer Color Rule.** Color appears on the accent layer (buttons, focus, ON-controls,
unread, running, progress, chart-1) and the semantic layer (danger, success, the rest of the chart
ramp). The old third layer — a separate brand teal — is retired; a new colour must justify itself
on one of these two layers or it does not go in.

**The Controls-Take-the-Accent Rule.** A control's ON state and a button's resting state are the
same accent blue — HeroUI's native pairing. Do not re-introduce a second identity hue for controls;
the glyph on an accent fill is snow (`--brand-foreground`), never dark ink.

**The Tinted Destruction Rule.** Destructive surfaces are `bg-destructive/10` (hover `/20`) with
solid-red text, never a solid-red fill. Danger reads as a warning label, not an alarm.

## Typography

**Display Font:** Inter Variable (with `Inter, ui-sans-serif, system-ui, sans-serif` fallback)
**Body Font:** Inter Variable — one family for everything; hierarchy is weight and size, never a
second typeface. The CJK fallback chain (PingFang SC, HarmonyOS Sans SC, Microsoft YaHei) is part
of the contract and does not change with the theme.

**Character:** Neutral, engineered, quietly precise. Inter at a 16px root (the browser default,
issue #502) sits at HeroUI's intended density.

### Hierarchy

- **Display** (600, 1.333rem = 21.3px): the `PageShell` title — one per screen, action button on
  its baseline. Weight 600, not 700: titles lead without shouting.
- **Headline** (600, 1.125rem = 18px): `PageSection` titles and dialog titles.
- **Body** (400, 0.875rem = 14px, relaxed 1.625): the workhorse. Descriptions, row content,
  buttons, inputs. Measure is capped at `max-w-2xl` (672px at the 16px root).
- **Label** (500, 0.75rem = 12px): sidebar group labels, xs controls, timestamps. Buttons and
  item titles are `text-sm` medium (500). There is no letterspaced-caps tier in this system.

### Named Rules

**The 16px Root Rule.** `html { font-size: 16px }` — HeroUI's default density, restored by issue
#502 from WorkBuddy's 15px. Never hardcode px sizes that assume a specific root; size in rem and
let the root do the scaling.

**The Pretty-Wrap Rule.** Descriptions wrap on sense, not on width: `text-wrap: pretty` is applied
globally to `[data-slot="item-description"]` and `text-pretty` on page descriptions.

## Layout

Two scroll regimes, one column contract, the same skeleton HeroUI renders into.

- **The app shell** (`_authed/_app` — bots, chat, routines): one viewport, `h-svh overflow-hidden`;
  the document never scrolls, panes scroll inside it. A collapsible sidebar rides the left edge at
  **17.5rem (280px)**, collapsing to a **3.2rem (51px)** icon rail with a 200ms linear width
  transition.
- **The document shell** (`_authed` — admin, settings): the document scrolls.
- **PageShell** bridges both: it owns the scroller (`min-h-0 flex-1 overflow-y-auto`) so the same
  screen works under either shell. Content sits in one centered column — `prose` (`max-w-2xl`,
  672px) by default because configuration is mostly reading; `wide` (`max-w-5xl`) exists for
  genuinely tabular content (the audit log) and is not a license for anything else. Horizontal
  padding is **1.5rem (24px)** with top 2rem under the 56px utility bar and bottom 3rem.
- **Section rhythm:** `PageSection` groups sit `mt-12` (3rem) apart — the space is what stops the
  eye running two groups together, doing a divider's job without drawing a line.
- **PageRows card:** a `rounded-2xl` (14.4px at the 16px root) white card with a hairline
  border and the resting `shadow-card`; rows inside it are squared off (see Shapes).
- **Density:** compact throughout — default controls are h-9 (36px), sm h-7 (28px), xs h-6 (24px);
  row padding `0.625rem 0.75rem`; row groups gap at 0.5-0.625rem. (All rem values unchanged from
  the previous revision; their px equivalents shifted with the root.)
- **Dialogs:** centered, `max-w-lg`, over the app scrim (15% black light / 60% dark, subtle blur — the wrapper's own element, not HeroUI's --backdrop),
  `max-h-[85svh]` with only the body scrolling so footer actions never leave the viewport.

## Elevation & Depth

HeroUI separates surfaces two ways at once: a hairline **and** a whisper of shadow. Resting cards
(page rows, the composer) carry `shadow-card` — HeroUI's `surface-shadow` (three layers, max 6%
black) — on top of their border; the shadow is what makes a white card read as raised off the gray
canvas rather than drawn onto it. Dark mode drops the resting shadow (HeroUI's dark
`surface-shadow` is fully transparent) and lets surface lightness steps do the separating, deleting
resting borders as before. Float layers keep HeroUI's own `overlay-shadow`: dialogs, popovers,
selects, dropdowns.

### Shadow Vocabulary

- **Rest-card** (`shadow-card` = HeroUI `surface-shadow`): cards and raised white surfaces at rest.
  Dark mode: none.
- **Float layers** (HeroUI `overlay-shadow`): dialogs, popovers, selects, dropdowns, sheets.
- Sidebar rail borders are drawn as box-shadow rings (`0 0 0 1px var(--sidebar-border)`) so they can
  flip on hover — the one place "shadow" is a border in disguise.

### Named Rules

**The Card-Floats-Gently Rule.** A white card on the gray canvas gets a hairline plus
`shadow-card`. If it floats over the page it gets HeroUI's overlay shadow. Nothing else gets
either, and nothing lighter than a card gets a shadow at all.

**The Space-Not-Lines Rule.** Hierarchy between groups is spacing (`mt-12`), not separators.
`Separator` is for inside a card, between rows — and only where the squaring convention doesn't
already divide them.

## Shapes

One radius family off a single token: `--radius: 0.5rem` (8px at the 16px root — HeroUI's default),
with a multiplicative ladder — sm ×0.6, md ×0.8, lg ×1, xl ×1.4, 2xl ×1.8, 3xl ×2.2, 4xl ×2.6. The
ladder lands on: controls at `rounded-lg` (8px), dialogs and sheets at `rounded-xl` (11.2px), and
cards at `rounded-2xl` (14.4px). Form fields derive `--field-radius` from the same token (HeroUI's
×1.5 = 12px). Small buttons cap their radius (`rounded-[min(var(--radius-md),12px)]`) so tiny
heights don't go pill-shaped.

The form language is rounded-rectangle, softened, never circular — pills appear nowhere outside
toggles and dots. The signature silhouette is the **squared row inside a rounded card**: `PageRows`
sets `[&_[data-slot=item]]:rounded-none` because a middle row has no corners and a rounded end-row
cannot sit concentric with the card one border inside it; the card clips, the rows fill. Icons are
Tabler line icons, defaulting to 16px (`size-4`), one weight, no filled variants. The scrollbar is a
5px hairline thumb colored by `--border`.

## Components

### Buttons

Character: restrained and quick — small state deltas (the 90/10 hover mix, 1px press), 150ms
ease-out.

- **Shape:** `rounded-lg` (8px), heights h-9/h-7/h-6.
- **Primary:** accent fill `oklch(0.6204 0.195 253.83)`, snow text, `text-sm font-medium`; hover
  mixes 90/10 toward snow. Same in dark — the accent is theme-independent.
- **Hover / Focus:** the accent focus ring (`--focus` = accent); `active` translates 1px down for a
  physical press.
- **Outline:** hairline border on background, fills the hover surface on hover/expanded.
- **Ghost:** transparent until hover; the sidebar-toggle and back-link voice.
- **Destructive:** Ember tint per the Tinted Destruction Rule.
- **Link variant:** foreground ink, underline on hover only (HeroUI's `--link: var(--foreground)`).

### Controls (switch / checkbox / radio)

HeroUI's native geometry and colors, unreplaced: the ON state is the accent fill with snow ink on
every control (switch track, checkbox, radio, progress). Unchecked fields are fill-defined — white
in light, surface in dark — with no stroke. The old WorkBuddy 32×18.4 switch and 16px teal checkbox
restatements were deleted with the theme bridge (issue #502).

### Chips

Composer chips (prompt-area) theme themselves off the same tokens — muted fills, hairline borders,
`rounded-md`.

### Cards / Containers

- **Corner Style:** `rounded-2xl` (PageRows, 14.4px) or `rounded-xl` (dialogs, gallery frames)
- **Background:** Card White; dark mode `oklch(0.2103 0.0059 285.89)` with the border removed
- **Shadow Strategy:** hairline + `shadow-card` at rest; see Elevation
- **Internal Padding:** rows `0.625rem 0.75rem`; dialogs `1.25rem`; gallery frames own their insets

### Inputs / Fields

- **Style:** fill-defined — white in light, surface in dark, no border (`--field-border:
  transparent`, `--field-border-width: 0`), `text-base md:text-sm`, HeroUI's `field-radius`
- **Focus:** the accent focus contract; aria-invalid swaps to the danger treatment
- **Disabled:** 50% opacity (HeroUI's `--disabled-opacity`)

### Navigation

Sidebar: `bg-sidebar` ground (`oklch(0.9524 0.0013 286.37)` light, `oklch(0.2103 0.0059 285.89)`
dark — secondary-surface ladder in light; surface ground with tertiary accent in dark), 280px wide, collapsing to the 51px icon rail. Group
labels sit at `text-xs` with muted foreground; items hover and select to `sidebar-accent` (the
deeper gray step) with full-ink `font-medium` labels — the selected row is gray depth plus weight,
not a tint. In-app back navigation is a ghost button with a chevron on the 56px utility bar. The
unread dot in the conversation list is the accent blue.

### Menu Highlights

Dropdown, select, and combobox options highlight with HeroUI's native selection treatment —
accent-soft fills with accent-tinted foreground, HeroUI's own emphasis vocabulary (the old neutral
`#f4f5f5` highlight was the WorkBuddy choice, retired in issue #502).

### Settings Row (signature)

The system's characteristic unit: an `Item` (`rounded-lg`, `px-3 py-2.5`) carrying `ItemMedia`
(16px icon or 40px image), `ItemContent` (medium `text-sm` title + muted `line-clamp-2` description
that wraps pretty), and `ItemActions` — usually a chevron. The canonical interaction: a summary row
that opens a dialog. In a `PageRows` card the row squares off and the whole card reads as one
instrument.

### Tool Line (signature)

A running tool call in the transcript: its own muted text with a light band sweeping left-to-right
across the glyphs (`background-clip: text`, only `background-position` animates, 1.6s linear),
disabled wholesale under `prefers-reduced-motion`. It is the app's only ambient motion and signals
exactly one thing: work in progress.

## Preserved from the previous system

- **The PageShell → PageSection → PageRows column contract** — one prose column, titled groups,
  `mt-12` rhythm, empty states as a muted sentence.
- **The rem-only sizing discipline** (root now 16px) and the spacing vocabulary.
- **Weight-driven hierarchy** (600/500/400, no letterspaced caps).
- **The tinted destruction discipline** and the quiet chat area: user bubbles are `muted`, Bot
  bubbles are `ghost` — no brand color inside the conversation.
- **The tool-line shimmer** and the entire small motion budget, reduced-motion respected.
- **Squared rows inside a rounded card**, the signature silhouette.
- **Tabler line icons at one weight, 16px default**, and the 5px hairline scrollbar.
- **`prefers-reduced-motion`, visible keyboard focus, and ARIA states** on every interactive
  primitive.
- The CJK font stack: Inter Variable + PingFang SC + HarmonyOS Sans SC + Microsoft YaHei, so zh-CN
  renders with the same hierarchy as en.

## Do's and Don'ts

### Do:

- **Do** build every configuration screen from `PageShell` → `PageSection` → `PageRows`; the column
  contract is the system.
- **Do** default to the `prose` width (672px); reserve `wide` for genuinely tabular content.
- **Do** express hierarchy with weight (600 → 500 → 400) and the muted-foreground token, not new
  sizes or colors.
- **Do** size in `rem` — the 16px root is the density dial and px hardcodes break it.
- **Do** reach for the accent when a control turns ON, something is unread/running, or something is
  clickable — it is one hue doing all three jobs.
- **Do** write empty states as a muted sentence (`PageEmpty`); "nothing here yet" is a fact, not an
  event.
- **Do** keep focus treatment identical everywhere: the accent focus ring.

### Don't:

- **Don't** add a color that doesn't fit the Two-Layer Color Rule (accent / semantic).
- **Don't** reintroduce the WorkBuddy teal (`#00c29a` / `#3dd9b6`) or a black/white primary — they
  were retired by user decision (issue #502); grep for them when reviewing.
- **Don't** put the accent on large reading surfaces or body text — it is a button, a control
  state, a dot, a ring, a chart series; never a background for reading.
- **Don't** drop the resting card shadow in light mode or add one in dark mode (Card-Floats-Gently
  Rule).
- **Don't** hand-draw buttons, inputs, or cards outside `components/ui`.
- **Don't** use a solid destructive fill; danger is a tint.
- **Don't** round rows inside a `PageRows` card; the card clips, the rows fill.
- **Don't** add illustrations, spot art, or celebratory empties; the console stays quiet.
