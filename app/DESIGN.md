---
name: OpenBot
description: An operations console for AI bots, wearing WorkBuddy's measured palette and layout
colors:
  background: "#f7f7f7"
  foreground: "#171717"
  card: "#ffffff"
  card-foreground: "#171717"
  popover: "#ffffff"
  popover-foreground: "#171717"
  primary: "#171717"
  primary-foreground: "#ffffff"
  secondary: "#f2f2f2"
  secondary-foreground: "#404040"
  muted: "#f2f2f2"
  muted-foreground: "#5c5c5c"
  accent: "#f4f5f5"
  accent-foreground: "#171717"
  brand: "#00c29a"
  destructive: "#b42c3f"
  destructive-foreground: "#ffffff"
  success: "#0a7d47"
  border: "#ebebeb"
  input: "#d9d9d9"
  ring: "#171717"
  sidebar: "#f2f2f2"
  sidebar-foreground: "#171717"
  sidebar-accent: "#e6e6e6"
  sidebar-accent-foreground: "#171717"
  sidebar-border: "#e6e6e6"
  sidebar-ring: "#171717"
  chart-1: "#00c29a"
  chart-2: "#4a90d9"
  chart-3: "#0cbf5b"
  chart-4: "#ff9540"
  chart-5: "#9d7bfa"
  dark-background: "#141414"
  dark-foreground: "#f2f2f2"
  dark-card: "#222222"
  dark-primary: "#f5f5f5"
  dark-primary-foreground: "#171717"
  dark-accent: "#2f2f33"
  dark-accent-foreground: "#f2f2f2"
  dark-destructive: "#f09595"
  dark-success: "#5dcaa5"
  dark-brand: "#3dd9b6"
  dark-border: "rgba(255, 255, 255, 0.12)"
  dark-input: "rgba(255, 255, 255, 0.16)"
  dark-ring: "#f5f5f5"
  dark-sidebar: "#1f1f1f"
  dark-sidebar-accent: "#333333"
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
    backgroundColor: "{colors.primary} at 80%"
  control-checked:
    backgroundColor: "{colors.brand}"
    note: "Switches, checkboxes, radios and progress turn brand teal when ON; buttons stay black"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.2xl}"
    border: "1px solid {colors.border}"
    shadow: "0 4px 12px rgb(0 0 0 / 3%) (none in dark)"
  dialog-surface:
    backgroundColor: "{colors.popover}"
    rounded: "{rounded.xl}"
    padding: "1.25rem"
    width: "32rem"
  modal-scrim:
    backgroundColor: "black/15 (black/60 in dark)"
    blur: "4px where supported"
---

# Design System: OpenBot

## Overview

**Creative North Star: WorkBuddy's own voice, spoken by an operations console.**

OpenBot's browser app is a quiet, instrument-grade console: administrators decide whether to trust
it with credentials, operators watch bots work, and the interface's job is to stay out of the way
while state changes underneath it. That discipline is unchanged. What this revision locks in is the
*voice*: every value below was extracted from the WorkBuddy desktop bundle itself
(`renderer/assets/tokens-*.css`), not approximated from memory — the teal brand ramp, the cool
neutral steps, the black primary button, the 8px control radius, the 264px list column, and the
soft `0 4px 12px` card shadow.

The palette carries a deliberate three-hue division of labor, which is WorkBuddy's own:

- **Black is the interactive layer.** `--primary` is near-black `#171717` (light) / `#f5f5f5`
  (dark, white buttons like WorkBuddy dark). Primary buttons, text buttons, focus rings and the
  active-nav ink are all this layer. WorkBuddy's primary buttons are `black-90`; so are ours.
- **Teal is the identity layer.** `--brand` is `#00c29a` (light) / `#3dd9b6` (dark), WorkBuddy's
  brand-8. It appears exactly where WorkBuddy puts its brand color: the unread dot, controls in
  their ON state, progress fills, chart-1, and the market page. It never paints a large surface.
- **Semantic color stays semantic.** Destructive red `#b42c3f` (WorkBuddy red-9) and success green
  `#0a7d47` keep the tint discipline, and the chart ramp takes WorkBuddy's accent hues (teal, blue,
  green, orange, violet).

The neutrals are WorkBuddy's cool ramp, not warm paper: page `#f7f7f7`, sidebar `#f2f2f2`, card
`#ffffff`, hairlines `#ebebeb`, ink `#171717`. One gray step separates the sidebar from the page
and the card from both — the same "gray canvas, white panes" structure WorkBuddy's home uses.

The system is a vendored shadcn-on-Base-UI kit (primitives in `app/src/components/ui`), driven by a
token sheet in `app/src/styles.css` with a light default and a `.dark` variant. Structure comes from
one layout contract — every configuration screen is `PageShell → PageSection → PageRows`, one
prose-width column of titled card groups — and from spacing that does the work dividers would
otherwise do.

Motion is small and purposeful. State transitions run 150ms ease-out; the sidebar collapses linearly
at 200ms; a running tool line sweeps a subtle shimmer across its own glyphs (1.6s, compositor-only);
lists mount with a 4px staggered rise. That is the entire motion budget.

**Key Characteristics:**

- WorkBuddy-extracted values: teal brand, cool neutrals, black primary, blue-free links (black text
  buttons), 15px root, 8px control radius, 16px cards
- Gray canvas + white cards: the page is one gray step behind its cards, the sidebar one behind them
- Controls turn teal when ON; buttons stay black — WorkBuddy's brand-primary vs. button split
- One layout contract (`PageShell`/`PageSection`/`PageRows`) for every configuration screen
- Sidebar at WorkBuddy's list width: 17.5rem expanded, 3.2rem collapsed (264px / 48px)
- Inter Variable as the single typeface; weight (600/500/400) is the hierarchy instrument

## Colors

### Interactive (black)

- **Ink Button** (`--primary: #171717`): primary buttons, text-button ink, focus rings, and the
  sidebar's active-item foreground in effect. Dark mode inverts to `#f5f5f5` with `#171717` labels —
  WorkBuddy dark's white button. The hover dims to 80% opacity, matching the market's black buttons.

### Identity (teal)

- **Brand Teal** (`--brand: #00c29a`): WorkBuddy brand-8. The unread dot in the conversation list,
  the ON state of every switch/checkbox/radio (`--brand` fill, white glyph), progress bars, chart-1,
  and the market page's accents. Dark mode lifts it to `#3dd9b6` (WorkBuddy's brand-3 territory) to
  hold contrast on the dark ground. It is never body text and never a page-level fill.

### Semantic

- **Ember Red** (`--destructive: #b42c3f`): WorkBuddy red-9, ~5.9:1 on white. Tinted surfaces
  (`/10`, hover `/20`) with solid-red text — destructive buttons are never solid red.
- **Circuit Green** (`--success: #0a7d47`): ~5.1:1 on white, same tint discipline.

### Neutral

- **Canvas** (`#f7f7f7`): the page. `--background` everywhere the app is not a card.
- **Panel** (`--sidebar: #f2f2f2`): the sidebar ground, one gray step deeper than the canvas —
  WorkBuddy's home-list gray against white panes. The selected/hover item steps one deeper still
  (`--sidebar-accent: #e6e6e6`) with full-ink text, WorkBuddy's quiet "selected row" pattern: no
  tint, just gray depth and weight 500.
- **Card White** (`#ffffff`): cards and popovers, raised off the canvas by a hairline plus a
  `0 4px 12px` 3% shadow.
- **Hairline** (`#ebebeb`): borders and strokes; input strokes `#d9d9d9`. In dark mode borders are
  white at 12% and inputs at 16%.
- **Muted Ink** (`--muted-foreground: #5c5c5c`): descriptions and empty states; ~7:1 on white.
- **Focus** (`--ring: #171717`): a black focus halo at 50% plus a border shift — WorkBuddy draws
  focus as a near-black border (`black-75`), not a colored glow.
- **Chart Chroma** (`--chart-1…5`): teal `#00c29a`, blue `#4a90d9`, green `#0cbf5b`, orange
  `#ff9540`, violet `#9d7bfa` — WorkBuddy's accent hues as a data-viz ramp; dark mode uses the
  lifted variants (`#3dd9b6`, `#85b7eb`, `#5dcaa5`, `#ffa760`, `#b79df5`).

### Named Rules

**The Three-Layer Color Rule.** Color appears on exactly three layers: the black interactive layer
(buttons, focus, action ink), the teal identity layer (unread, ON-controls, progress, chart-1), and
the semantic layer (destructive, success, the rest of the chart ramp). A new color must justify
itself on one of these layers; "one more hue" is not a layer.

**The Controls-Take-the-Brand Rule.** A control's ON state is teal; a button's resting state is
black. If a switch, checkbox, radio, or progress fill needs a color, it takes `--brand` — never
`--primary` — so a column of settings doesn't read as a column of black pills. The glyph on a
brand fill is `--brand-foreground` (ink, 7.84:1 on teal), never white (2.29:1).

**The Tinted Destruction Rule.** Destructive surfaces are `bg-destructive/10` (hover `/20`) with
solid-red text, never a solid-red fill. Danger reads as a warning label, not an alarm.

## Typography

**Display Font:** Inter Variable (with `Inter, ui-sans-serif, system-ui, sans-serif` fallback)
**Body Font:** Inter Variable — one family for everything; hierarchy is weight and size, never a
second typeface. (The previous revision shipped `font-family: Inter`, which was never a registered
face — every pixel of the app was actually rendering system UI fonts. `"Inter Variable"` is the
registered name and is now load-bearing.)

**Character:** Neutral, engineered, quietly precise. Inter at a 15px root sits inside WorkBuddy's
12/13/14/16/20/24 scale.

### Hierarchy

- **Display** (600, 1.333rem = 20px): the `PageShell` title — WorkBuddy's page-title tier, one per
  screen, action button on its baseline. Weight 600, not 700: titles lead without shouting.
- **Headline** (600, 1.125rem = 16.875px): `PageSection` titles and dialog titles, at WorkBuddy's
  16px tier.
- **Body** (400, 0.875rem = 13.125px, relaxed 1.625): the workhorse. Descriptions, row content,
  buttons, inputs. Measure is capped at `max-w-prose` / `max-w-2xl` (630px).
- **Label** (500, 0.75rem = 11.25px): sidebar group labels, xs controls, timestamps. Buttons and
  item titles are `text-sm` medium (500). There is no letterspaced-caps tier in this system.

### Named Rules

**The 15px Density Rule.** `html { font-size: 15px }` sets the whole rem ladder one notch denser
than default. Never hardcode px sizes that assume a 16px root; size in rem and let the root do the
compacting.

**The Pretty-Wrap Rule.** Descriptions wrap on sense, not on width: `text-wrap: pretty` is applied
globally to `[data-slot="item-description"]` and `text-pretty` on page descriptions.

## Layout

Two scroll regimes, one column contract, WorkBuddy's column widths.

- **The app shell** (`_authed/_app` — bots, chat, routines): one viewport, `h-svh overflow-hidden`;
  the document never scrolls, panes scroll inside it. A collapsible sidebar rides the left edge at
  **17.5rem (264px)**, collapsing to a **3.2rem (48px)** icon rail with a 200ms linear width
  transition — WorkBuddy's own conversation-list widths, measured from its bundle.
- **The document shell** (`_authed` — admin, settings): the document scrolls.
- **PageShell** bridges both: it owns the scroller (`min-h-0 flex-1 overflow-y-auto`) so the same
  screen works under either shell. Content sits in one centered column — `prose` (`max-w-2xl`,
  630px) by default because configuration is mostly reading; `wide` (`max-w-5xl`) exists for
  genuinely tabular content (the audit log) and is not a license for anything else. Horizontal
  padding is **1.5rem (24px)** — WorkBuddy's content gutter — with top 2rem under the 56px utility
  bar and bottom 3rem.
- **Section rhythm:** `PageSection` groups sit `mt-12` (3rem) apart — the space is what stops the
  eye running two groups together, doing a divider's job without drawing a line.
- **PageRows card:** a `rounded-2xl` (16.2px — WorkBuddy's 16px card) white card with a hairline
  border and the resting `shadow-card`; rows inside it are squared off (see Shapes).
- **Density:** compact throughout — default controls are h-9 (33.75px, WorkBuddy's 32-36px control
  band), sm h-7, xs h-6; row padding `0.625rem 0.75rem`; row groups gap at 0.5-0.625rem.
- **Dialogs:** centered, `max-w-lg`, over WorkBuddy's scrim (15% black light / 60% dark, blurred
  where supported), `max-h-[85svh]` with only the body scrolling so footer actions never leave the
  viewport.

## Elevation & Depth

WorkBuddy separates surfaces two ways at once: a hairline **and** a whisper of shadow. Resting cards
(page rows, the composer) carry `shadow-card` (`0 4px 12px` at 3% black) on top of their border —
the shadow is what makes a white card read as raised off the gray canvas rather than drawn onto it.
Dark mode drops the resting shadow (`dark:shadow-none`) and lets surface lightness steps do the
separating, deleting resting borders as before. Float layers keep their stronger shadows: dialogs
(`shadow-lg`), popovers/selects/dropdowns (`shadow-md`).

### Shadow Vocabulary

- **Rest-card** (`shadow-card`: `0 4px 12px rgb(0 0 0 / 3%)`, WorkBuddy's `#00000008`): cards and
  raised white surfaces at rest. Dark mode: none.
- **Float-large** (`shadow-lg`): dialogs.
- **Float-medium** (`shadow-md`): popovers, selects, dropdowns, sheets.
- Sidebar rail borders are drawn as box-shadow rings (`0 0 0 1px var(--sidebar-border)`) so they can
  flip on hover — the one place "shadow" is a border in disguise.

### Named Rules

**The Card-Floats-Gently Rule.** A white card on the gray canvas gets a hairline plus `shadow-card`.
If it floats over the page it gets `shadow-md`/`shadow-lg`. Nothing else gets either, and nothing
lighter than a card gets a shadow at all.

**The Space-Not-Lines Rule.** Hierarchy between groups is spacing (`mt-12`), not separators.
`Separator` is for inside a card, between rows — and only where the squaring convention doesn't
already divide them.

## Shapes

One radius family off a single token: `--radius: 0.6rem` (9px at the 15px root), with a
multiplicative ladder — sm ×0.6, md ×0.8, lg ×1, xl ×1.4, 2xl ×1.8, 3xl ×2.2, 4xl ×2.6. The ladder
lands on WorkBuddy's actual values: controls at `rounded-lg` (9px ≈ WorkBuddy's 8px), dialogs and
sheets at `rounded-xl` (12.6px ≈ 12px), and cards at `rounded-2xl` (16.2px ≈ 16px). Small buttons
cap their radius (`rounded-[min(var(--radius-md),12px)]`) so tiny heights don't go pill-shaped.

The form language is rounded-rectangle, softened, never circular — pills appear nowhere outside
toggles and dots. The signature silhouette is the **squared row inside a rounded card**: `PageRows`
sets `[&_[data-slot=item]]:rounded-none` because a middle row has no corners and a rounded end-row
cannot sit concentric with the card one border inside it; the card clips, the rows fill. Icons are
Tabler line icons, defaulting to 16px (`size-4`), one weight, no filled variants. The scrollbar is a
5px hairline thumb colored by `--border` (WorkBuddy's 4px `black-10`, same whisper).

## Components

### Buttons

Character: restrained and quick — small state deltas (opacity, one-step bg shift, 1px press), 150ms
ease-out.

- **Shape:** `rounded-lg` (9px), heights h-9/h-7/h-6 — inside WorkBuddy's 32px control band.
- **Primary:** Ink `#171717` fill, white text, `text-sm font-medium`; hover dims to 80% opacity.
  Dark mode: white fill, ink text.
- **Hover / Focus:** `ring-3 ring-ring/50` (black at half) + border shift; `active` translates 1px
  down for a physical press.
- **Outline:** hairline border on background, fills Quiet Gray on hover/expanded.
- **Ghost:** transparent until hover; the sidebar-toggle and back-link voice.
- **Destructive:** Ember tint per the Tinted Destruction Rule.
- **Link variant:** ink text, underline on hover only — WorkBuddy's text buttons are ink, not blue.

### Controls (switch / checkbox / radio)

The Controls-Take-the-Brand Rule lives here: `data-checked:bg-brand` with a white glyph, unchecked
`bg-input`. The switch is 32×18px, WorkBuddy's small-control size.

### Chips

Composer chips (prompt-area) theme themselves off the same tokens — muted fills, hairline borders,
`rounded-md`. WorkBuddy's category chips are h-32px/r-6; OpenBot's badge scale matches at the 15px
root.

### Cards / Containers

- **Corner Style:** `rounded-2xl` (PageRows, 16.2px) or `rounded-xl` (dialogs, gallery frames)
- **Background:** Card White; dark mode `#222222` with the border removed
- **Shadow Strategy:** hairline + `shadow-card` at rest; see Elevation
- **Internal Padding:** rows `0.625rem 0.75rem`; dialogs `1.25rem`; gallery frames own their insets

### Inputs / Fields

- **Style:** `h-9`, `rounded-lg`, `border-input` (`#d9d9d9`), transparent in light / `input/30`
  tint in dark, `text-base md:text-sm`
- **Focus:** same black ring contract as buttons; aria-invalid swaps to the destructive tint ring
- **Disabled:** `input/50` fill at 50% opacity

### Navigation

Sidebar: `bg-sidebar` ground (Panel gray `#f2f2f2` light, `#1f1f1f` dark — WorkBuddy's dark
home-list), 264px wide, collapsing to the 48px icon rail. Group labels sit at `text-xs` with 70%
foreground; items hover and select to `sidebar-accent` (the deeper gray step) with full-ink
`font-medium` labels — WorkBuddy's selected row is gray depth plus weight, not a tint. In-app back
navigation is a ghost button with a chevron on the 56px utility bar. The unread dot in the
conversation list is Brand Teal.

### Menu Highlights

Dropdown, select, and combobox options highlight on `bg-accent text-accent-foreground` — the quiet
`#f4f5f5` gray with full ink, matching WorkBuddy's `item-selected`. Because `--accent` is neutral,
every floating menu inherited the change with no per-component edits.

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
  `mt-12` rhythm, empty states as a muted sentence. Only the paddings (24px) and the card recipe
  (16px + shadow) moved to WorkBuddy's values.
- **The 15px root and the rem-only sizing discipline.**
- **Weight-driven hierarchy** (600/500/400, no letterspaced caps), already WorkBuddy's scale.
- **The tinted destruction discipline** and the quiet chat area: user bubbles are `muted`, Bot
  bubbles are `ghost` — no brand color inside the conversation.
- **The tool-line shimmer** and the entire small motion budget, reduced-motion respected.
- **Squared rows inside a rounded card**, the signature silhouette.
- **Tabler line icons at one weight, 16px default**, and the 5px hairline scrollbar.
- **`prefers-reduced-motion`, visible keyboard focus (ring-3), and ARIA states** on every
  interactive primitive.
- The market page keeps its WorkBuddy-derived card recipe (48px icon slots, 16px radius, 20px
  padding) — this revision brings the rest of the app up to the same source.

## Do's and Don'ts

### Do:

- **Do** build every configuration screen from `PageShell` → `PageSection` → `PageRows`; the column
  contract is the system.
- **Do** default to the `prose` width (630px); reserve `wide` for genuinely tabular content.
- **Do** express hierarchy with weight (600 → 500 → 400) and the muted-foreground token, not new
  sizes or colors.
- **Do** size in `rem` — the 15px root is the density dial and px hardcodes break it.
- **Do** reach for `--brand` when a control turns ON or something is unread/running; reach for
  `--primary` when something is clickable.
- **Do** write empty states as a muted sentence (`PageEmpty`); "nothing here yet" is a fact, not an
  event.
- **Do** keep focus treatment identical everywhere: `ring-3 ring-ring/50` + border shift.

### Don't:

- **Don't** add a color that doesn't fit the Three-Layer Color Rule (black interactive / teal
  identity / semantic).
- **Don't** put teal on large surfaces, body text, or inside the chat transcript — it is a dot, a
  control state, a progress fill, a chart series; never a background for reading.
- **Don't** drop the resting card shadow in light mode or add one in dark mode (Card-Floats-Gently
  Rule).
- **Don't** hand-draw buttons, inputs, or cards outside `components/ui`.
- **Don't** use a solid destructive fill; danger is a tint.
- **Don't** round rows inside a `PageRows` card; the card clips, the rows fill.
- **Don't** add illustrations, spot art, or celebratory empties; the console stays quiet.
