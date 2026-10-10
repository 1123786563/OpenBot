---
name: OpenBot
description: A quiet, instrument-grade console for operating AI bots
colors:
  background: "oklch(0.985 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  secondary: "oklch(0.97 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted: "oklch(0.96 0 0)"
  muted-foreground: "oklch(0.5 0 0)"
  accent: "oklch(0.97 0 0)"
  accent-foreground: "oklch(0.205 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  destructive-foreground: "oklch(0.985 0 0)"
  success: "oklch(0.6 0.118 184.704)"
  border: "oklch(0.922 0 0)"
  input: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  sidebar: "oklch(0.97 0 0)"
  sidebar-foreground: "oklch(0.145 0 0)"
  sidebar-accent: "oklch(0.95 0 0)"
  sidebar-accent-foreground: "oklch(0.205 0 0)"
  sidebar-border: "oklch(0.922 0 0)"
  sidebar-primary: "oklch(0.205 0 0)"
  sidebar-primary-foreground: "oklch(0.5 0 0)"
  chart-1: "oklch(0.87 0 0)"
  chart-2: "oklch(0.556 0 0)"
  chart-3: "oklch(0.439 0 0)"
  chart-4: "oklch(0.371 0 0)"
  chart-5: "oklch(0.269 0 0)"
  dark-background: "oklch(0.145 0 0)"
  dark-card: "oklch(0.205 0 0)"
  dark-primary: "oklch(0.922 0 0)"
  dark-border: "oklch(1 0 0 / 10%)"
  dark-sidebar-primary: "oklch(0.488 0.243 264.376)"
typography:
  display:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
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
spacing:
  xs: "0.5rem"
  sm: "0.625rem"
  md: "1rem"
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
    backgroundColor: "oklch(0.205 0 0 / 80%)"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0.625rem"
    height: "2.25rem"
  button-outline-hover:
    backgroundColor: "{colors.muted}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "2.25rem"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
  button-destructive:
    backgroundColor: "oklch(0.577 0.245 27.325 / 10%)"
    textColor: "{colors.destructive}"
    rounded: "{rounded.lg}"
    height: "2.25rem"
  button-destructive-hover:
    backgroundColor: "oklch(0.577 0.245 27.325 / 20%)"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0.25rem 0.625rem"
    height: "2.25rem"
  item-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0.625rem 0.75rem"
  dialog-surface:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.xl}"
    padding: "1.25rem"
    width: "32rem"
---

# Design System: OpenBot

## Overview

**Creative North Star: "The Quiet Control Room"**

OpenBot's browser app is an operations console: administrators decide whether to trust it with credentials, operators watch bots work, and the interface's job is to stay out of the way while state changes underneath it. The visual system answers that with instrument-grade neutrality — ink on paper, a compact 15px root density, and color reserved almost entirely for meaning (danger, success, focus). Nothing decorative survives: no gradient surfaces, no brand illustrations, no chromatic theming. Even the chart palette is a five-step grey ramp.

The system is a vendored shadcn-on-Base-UI kit (the primitives live in `app/src/components/ui` and are the repository's own), driven by an OKLCH token sheet in `app/src/styles.css` with a light default and a `.dark` variant. Structure comes from a strict layout contract — every configuration screen is `PageShell → PageSection → PageRows`, one prose-width column with titled groups of bordered rows — and from deliberate spacing that does the work dividers would otherwise do. Depth is honest: resting surfaces carry borders, never shadows; shadows exist only on things that float.

Motion is small and purposeful. State transitions run 150ms ease-out; the sidebar collapses linearly at 200ms; a running tool line sweeps a subtle shimmer across its own glyphs (1.6s, compositor-only); lists mount with a 4px staggered rise. That is the entire motion budget.

**Key Characteristics:**

- Near-monochrome OKLCH palette; the only chromatic tokens are destructive red, success teal, and a dark-mode-only indigo sidebar accent
- 15px root font size — a compact, information-dense operating rhythm (all `rem` below compute against it)
- Borders for resting depth, shadows only for floating layers (dialogs, popovers, selects)
- One layout contract (`PageShell`/`PageSection`/`PageRows`) for every configuration screen
- Space, not lines, separates sections; sentences, not illustrations, fill empty states
- Inter Variable as the single typeface; weight (700/500/400) is the hierarchy instrument

## Colors

A neutral-temperature paper-and-ink palette where every token except three carries zero chroma; color appears only to carry state.

### Primary

- **Ink** (`oklch(0.205 0 0)`): The primary *action* color in light mode is near-black ink — primary buttons, links, and the one emphasized verb per screen. In dark mode the role inverts to pale paper (`oklch(0.922 0 0)`). There is no brand hue; contrast itself is the accent.

### Secondary

- **Field Tint** (`oklch(0.97 0 0)`): Secondary surfaces — secondary buttons, subtle fills, sidebar ground in light mode.
- **Quiet Fill** (`oklch(0.96 0 0)`): Muted background for hover states, ghost fills, and code-ish insets; **Half-Ink** (`oklch(0.5 0 0)`, `--muted-foreground`) renders every description and empty-state sentence.

### Tertiary

- **Ember Red** (`oklch(0.577 0.245 27.325)`): The destructive token. Always used as a tint (10–20% backgrounds) with the solid color reserved for text and borders — destructive buttons are never solid red.
- **Circuit Teal** (`oklch(0.6 0.118 184.704)`): Success state, same tint discipline.
- **Indigo Signal** (`oklch(0.488 0.243 264.376)`): Dark mode only — the sidebar's active-item mark in `--sidebar-primary`. The single blue value in the entire token sheet.

### Neutral

- **Paper** (`oklch(0.985 0 0)`): App background — off-white by exactly one lightness step; never pure white.
- **Card White** (`oklch(1 0 0)`): Cards and popovers sit one step brighter than the page.
- **Hairline** (`oklch(0.922 0 0)`): Borders and input strokes in light mode; in dark mode borders become white at 10% (`oklch(1 0 0 / 10%)`) and resting cards drop their border entirely (`dark:border-transparent`).
- **Graphite** (`oklch(0.145 0 0)`): Dark mode background and light mode foreground text — the same value, which is the palette's symmetry in one line.
- **Focus Grey** (`oklch(0.708 0 0)`): The `--ring` token; focus is a neutral halo, not a brand glow.
- **Chart Greys** (`--chart-1…5`, `oklch(0.87…0.269 0 0)`): A five-step monochrome ramp for data viz. Charts stay grey like everything else.

### Named Rules

**The Meaning-Only Color Rule.** Chromatic color may appear only where it carries state: destructive, success, or the dark sidebar's active mark. A new chromatic token needs a state to justify it; "brand pop" is not a state.

**The Tinted Destruction Rule.** Destructive surfaces are `bg-destructive/10` (hover `/20`) with solid-red text, never a solid-red fill. Danger reads as a warning label, not an alarm.

## Typography

**Display Font:** Inter Variable (with `Inter, ui-sans-serif, system-ui, sans-serif` fallback)
**Body Font:** Inter Variable — one family for everything; hierarchy is weight and size, never a second typeface.

**Character:** Neutral, engineered, quietly precise. Inter at a 15px root is the typographic equivalent of the grey palette: it declines to have an opinion so the content can.

### Hierarchy

- **Display** (700, 1.5rem = 22.5px, ~1.2): The `PageShell` title — one per screen, top of the column, action button on its baseline.
- **Headline** (700, 1.125rem = 16.875px): `PageSection` titles and dialog titles.
- **Body** (400, 0.875rem = 13.125px, relaxed 1.625): The workhorse. Descriptions, row content, buttons, inputs. Measure is capped at `max-w-prose` / `max-w-2xl` (630px).
- **Label** (500, 0.75rem = 11.25px): Sidebar group labels, xs controls, timestamps. Buttons and item titles are `text-sm` medium (500) rather than uppercase — there is no letterspaced-caps tier in this system.

### Named Rules

**The 15px Density Rule.** `html { font-size: 15px }` sets the whole rem ladder one notch denser than default. Never hardcode px sizes that assume a 16px root; size in rem and let the root do the compacting.

**The Pretty-Wrap Rule.** Descriptions wrap on sense, not on width: `text-wrap: pretty` is applied globally to `[data-slot="item-description"]` and `text-pretty` on page descriptions.

## Layout

Two scroll regimes, one column contract.

- **The app shell** (`_authed/_app` — bots, chat, routines): one viewport, `h-svh overflow-hidden`; the document never scrolls, panes scroll inside it. A collapsible sidebar (width from `--sidebar-width`, collapsing to an icon rail with a 200ms linear width transition) rides the left edge.
- **The document shell** (`_authed` — admin, settings): the document scrolls.
- **PageShell** bridges both: it owns the scroller (`min-h-0 flex-1 overflow-y-auto`) so the same screen works under either shell. Content sits in one centered column — `prose` (`max-w-2xl`, 630px) by default because configuration is mostly reading; `wide` (`max-w-5xl`) exists for one page (the audit log table) and is not a license for anything else. Horizontal padding `1rem`, bottom `3rem`, top `2rem` under a 56px utility bar (sidebar toggle + back link).
- **Section rhythm:** `PageSection` groups sit `mt-12` (3rem) apart — the space is what stops the eye running two groups together, doing a divider's job without drawing a line.
- **PageRows card:** a `rounded-lg` bordered card (`bg-card`) that clips its rows; rows inside it are squared off (see Shapes).
- **Density:** compact throughout — default controls are h-9 (2.25rem = 33.75px), sm h-7, xs h-6; row padding `0.625rem 0.75rem`; row groups gap at 0.5–0.625rem.
- **Dialogs:** centered, `max-w-lg` (480px), `w-[calc(100%-2rem)]`, `max-h-[85svh]` with only the body scrolling so footer actions never leave the viewport.

## Elevation & Depth

Flat by construction. Resting depth is a 1px Hairline border, never a shadow; dark mode deletes resting borders (`dark:border-transparent`) and lets surface lightness steps do the separating instead. Shadows appear only on layers that float above the page — dialogs (`shadow-lg`), popovers/selects/dropdowns (`shadow-md`) — and the modal overlay is a 10% black wash with a hair-thin backdrop blur (`bg-black/10 supports-backdrop-filter:backdrop-blur-xs`). Focus depth is a neutral 3px ring at half opacity (`ring-3 ring-ring/50` plus a `border-ring` shift), identical on every interactive primitive.

### Shadow Vocabulary

- **Float-large** (`shadow-lg`, Tailwind default: `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): Dialogs.
- **Float-medium** (`shadow-md`: `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): Popovers, selects, dropdowns, sheets.
- Sidebar rail borders are drawn as box-shadow rings (`0 0 0 1px var(--sidebar-border)`) so they can flip on hover — the one place "shadow" is a border in disguise.

### Named Rules

**The Border-Not-Shadow Rule.** If it sits on the page, it gets a border. If it floats over the page, it gets a shadow. Nothing else gets either.

**The Space-Not-Lines Rule.** Hierarchy between groups is spacing (`mt-12`), not separators. `Separator` is for inside a card, between rows — and only where the squaring convention doesn't already divide them.

## Shapes

One radius family off a single token: `--radius: 0.55rem` (8.25px at the 15px root), with a multiplicative ladder — sm ×0.6, md ×0.8, lg ×1, xl ×1.4, 2xl ×1.8. Controls and rows take `rounded-lg`; dialogs, sheets, and gallery frames take `rounded-xl`; small buttons cap their radius (`rounded-[min(var(--radius-md),12px)]`) so tiny heights don't go pill-shaped.

The form language is rounded-rectangle, softened, never circular — pills appear nowhere. The signature silhouette is the **squared row inside a rounded card**: `PageRows` sets `[&_[data-slot=item]]:rounded-none` because a middle row has no corners and a rounded end-row cannot sit concentric with the card one border inside it; the card clips, the rows fill. Icons are Tabler line icons, defaulting to 16px (`size-4`), one weight, no filled variants. The scrollbar is a 5px hairline thumb colored by `--border`.

## Components

### Buttons

Character: restrained and quick — small state deltas (opacity, one-step bg shift, 1px press), 150ms ease-out.

- **Shape:** `rounded-lg` (0.55rem)
- **Primary:** Ink fill, paper text, `h-9 px-2.5 text-sm font-medium`; hover dims to 80% ink.
- **Hover / Focus:** neutral `ring-3 ring-ring/50` + border shift; `active` translates 1px down (`translate-y-px`) for a physical press.
- **Outline:** Hairline border on background, fills Quiet Grey on hover/expanded.
- **Ghost:** transparent until hover; the sidebar-toggle and back-link voice.
- **Destructive:** Ember tint per the Tinted Destruction Rule.
- **Link variant:** plain text underline on hover only.

### Chips

Composer chips (prompt-area) theme themselves off the same tokens — muted fills, Hairline borders, `rounded-md`. No filter-chip vocabulary with checkmarks beyond the standard select/menu items.

### Cards / Containers

- **Corner Style:** `rounded-lg` (PageRows) or `rounded-xl` (dialog, gallery frames)
- **Background:** Card White; in dark mode Graphite-dark (`oklch(0.205 0 0)`) with the border removed
- **Shadow Strategy:** none at rest — see Elevation
- **Border:** Hairline, light mode only
- **Internal Padding:** rows `0.625rem 0.75rem`; dialogs `1.25rem`; gallery frames own their insets

### Inputs / Fields

- **Style:** `h-9`, `rounded-lg`, Hairline `border-input`, transparent in light / `input/30` tint in dark, `text-base md:text-sm`
- **Focus:** same neutral ring-3 contract as buttons; aria-invalid swaps to the destructive tint ring
- **Disabled:** `input/50` fill at 50% opacity

### Navigation

Sidebar: `bg-sidebar` ground (Field Tint in light, Graphite-dark in dark), `h-8` group labels at `text-xs` with 70% foreground, items hover to `sidebar-accent` with the Indigo Signal primary mark in dark mode. Collapse to icon rail animates `width` at 200ms ease-linear. In-app back navigation is a ghost button with a chevron on the 56px utility bar.

### Settings Row (signature)

The system's characteristic unit: an `Item` (`rounded-lg`, `px-3 py-2.5`) carrying `ItemMedia` (16px icon or 40px image), `ItemContent` (medium `text-sm` title + muted `line-clamp-2` description that wraps pretty), and `ItemActions` — usually a chevron. The canonical interaction: a summary row that opens a dialog. In a `PageRows` card the row squares off and the whole card reads as one instrument.

### Tool Line (signature)

A running tool call in the transcript: its own muted text with a light band sweeping left-to-right across the glyphs (`background-clip: text`, only `background-position` animates, 1.6s linear), disabled wholesale under `prefers-reduced-motion`. It is the app's only ambient motion and signals exactly one thing: work in progress.

## Do's and Don'ts

### Do:

- **Do** build every configuration screen from `PageShell` → `PageSection` → `PageRows`; the column contract is the system.
- **Do** default to the `prose` width (630px); reserve `wide` for genuinely tabular content.
- **Do** express hierarchy with weight (700 → 500 → 400) and the muted-foreground token, not new sizes or colors.
- **Do** size in `rem` — the 15px root is the density dial and px hardcodes break it.
- **Do** write empty states as a muted sentence (`PageEmpty`); "nothing here yet" is a fact, not an event.
- **Do** keep focus treatment identical everywhere: `ring-3 ring-ring/50` + border shift.

### Don't:

- **Don't** add a chromatic color without a state to justify it (Meaning-Only Color Rule).
- **Don't** put a shadow on anything that rests on the page (Border-Not-Shadow Rule).
- **Don't** hand-draw buttons, inputs, or cards outside `components/ui` — three of the original admin pages did and read as a different application.
- **Don't** use a solid destructive fill; danger is a tint.
- **Don't** round rows inside a `PageRows` card; the card clips, the rows fill.
- **Don't** add illustrations, spot art, or celebratory empties; the console stays quiet.
