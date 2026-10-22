---
name: OpenBot
description: A modern workspace for operating bots, teams, and model services
baseline: "Workspace theme contract (2026-10-20): app semantic tokens own theme values; HeroUI semantic slots map to them"
colors:
  background: "#F5F7FA"
  foreground: "#192131"
  card: "#FFFFFF"
  card-foreground: "#192131"
  popover: "#FFFFFF"
  popover-foreground: "#192131"
  primary: "#315FCF"
  primary-foreground: "#FFFFFF"
  secondary: "#EEF1F6"
  secondary-foreground: "#192131"
  muted: "#526079"
  muted-foreground: "#526079"
  accent: "#315FCF"
  accent-foreground: "#FFFFFF"
  brand: "#315FCF"
  destructive: "#B32745"
  destructive-foreground: "#FFFFFF"
  success: "#16704D"
  warning: "#8B570B"
  border: "#D8DFE9"
  input: "#7A879B"
  ring: "#315FCF"
  sidebar: "#EEF1F6"
  sidebar-foreground: "#192131"
  sidebar-accent: "#E2E8F2"
  sidebar-accent-foreground: "#192131"
  chart-1: "#315FCF"
  chart-2: "#8B570B"
  chart-3: "#16704D"
  chart-4: "#7040AD"
  chart-5: "#A02C76"
  dark-background: "#111318"
  dark-foreground: "#EBEFF7"
  dark-card: "#191D26"
  dark-primary: "#3D6BDA"
  dark-primary-foreground: "#FFFFFF"
  dark-accent: "#3D6BDA"
  dark-accent-foreground: "#FFFFFF"
  dark-destructive: "#FF9EA7"
  dark-success: "#69D5AC"
  dark-warning: "#F0BE69"
  dark-border: "#303949"
  dark-input: "#68788F"
  dark-ring: "#8DB4FF"
  dark-sidebar: "#0D1015"
  dark-sidebar-accent: "#242B38"
  dark-chart-1: "#8DB4FF"
  dark-chart-2: "#F0BE69"
  dark-chart-3: "#69D5AC"
  dark-chart-4: "#C3A2F2"
  dark-chart-5: "#F09ACB"
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
---

# Design System: OpenBot

## Theme ownership

`app/src/styles/tokens.css` is the only value source for the 39 existing `--ob-*` tokens and the
new semantic and layout tokens. Values are listed in
[`theme-contract.json`](../docs/design/2026-10-20-workspace-redesign/handoff/refinement/theme-contract.json).
It defines light values under `:root` and `[data-theme="light"]`, and dark values under `.dark` and
`[data-theme="dark"]`.

`app/src/styles/heroui-theme.css` maps HeroUI's native semantic variables to those tokens in both
theme scopes. HeroUI `--accent` is the action fill, while `--muted` is muted text. OpenBot's quiet
surface and muted text have distinct names: `--ob-muted-surface` and `--ob-muted-text`. The native
variables are never redeclared in `legacy-ui-bridge.css`.

`app/src/styles/legacy-ui-bridge.css` only maps remaining shadcn names to OpenBot tokens. The legacy
`--input` alias means control border and maps to `--ob-control-border`. The existing `openbot-theme`
preference remains the sole theme storage mechanism; CSS theme selectors do not write preferences.

## Color roles

- **Canvas and surfaces:** light canvas `#F5F7FA`, dark canvas `#111318`; cards use `#FFFFFF` and
  `#191D26`. Overlays have their own surface token. Sidebar, hover, and muted surfaces are distinct
  semantic roles.
- **Text:** foreground is `#192131` light and `#EBEFF7` dark. Muted text is `#526079` light and
  `#A2ACBE` dark. Muted surfaces do not substitute for muted text.
- **Actions and focus:** action fill is `#315FCF` light and `#3D6BDA` dark; its foreground is white.
  Hover values are explicit contract tokens. Focus and accent text use their own tokens.
- **Status:** success, warning, and danger each define foreground pairs and soft surfaces. Use the
  state color with text or an icon; do not encode status only through a fill.
- **Boundaries:** `--ob-border` is for decorative dividers. `--ob-control-border` is for necessary
  control boundaries. `--ob-field-border` aliases the control border; field background remains the
  surface token.
- **Charts:** five distinct series colors are specified separately for light and dark surfaces.

## Typography and shape

Inter Variable is the primary typeface, with platform sans-serif fallbacks. The root font size is
16px. The shared radius is 8px; component radii derive from `--radius` rather than introducing
unrelated values.

## Layout

Layout sizes are semantic tokens: app sidebar 280px, configuration sidebar 256px, collapsed rail
64px, prose maximum 672px, wide content maximum 1024px, chat width 720px, main minimum 480px,
Craft session panel 224px, and Craft output panel 420px. These values describe maximums where the
layout contract says so; narrow viewports remain responsive.

Configuration screens use the existing `PageShell → PageSection → PageRows` structure. Content
panes scroll within the app shell where that layout is already established. Theme work does not
change route structure, component behavior, or user preference storage.
