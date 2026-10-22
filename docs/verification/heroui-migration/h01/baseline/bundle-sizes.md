# Baseline bundle sizes (pre-HeroUI)

Measured 2026-10-19 after `bun run --cwd app build` at BASE `203d0f0244b2f898218fa12027089c631e8448d9`
(worktree clean apart from untracked plan/verification docs). Build log:
`baseline/build.log` (`EXIT:0`, `✓ built in 1m 7s`). Vite 7.3.6, 405 JS assets, 3 CSS assets.

## Entry identification (evidence)

- `app/dist/index.html` loads exactly one module script and one stylesheet:
  - `/assets/index-CqOktgGQ.js`
  - `/assets/index-BaxBj2Ps.css`
- `app/vite.config.ts` `selectOpenBotManualChunk` names the route chunks: `sign.tsx` → `route-sign`,
  `_authed.tsx` / `_authed/_app.tsx` / `_authed/_app/channel/*` → `route-chat-core`,
  `_authed/admin/*` → `route-admin`, `_authed/settings/*` → `route-settings`.
- The sign-in screen itself lives in `route-sign-CoJ-Dutw.js`: its first line imports the entry chunk
  and the shared chunks below (`index`, `react`, `client`, `agent-orb`, `separator`, `application-config`).
- Chat's route shell lives in `route-chat-core-BtYhcyp6.js`; its static import graph is listed below.
  Chat content continues into dynamic message/renderer chunks, which are *not* counted here.

Because the router lazy-loads route components, "initial JS" is measured as the **static import
closure** of `index-*.js` plus the relevant route chunk (regular `import ... from "./x.js"` only;
`import("./x.js")` dynamic edges are excluded). Per-file numbers are `gzip -c` (default level).

## Top-level entry chunk (always loaded)

| File | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `index-CqOktgGQ.js` | 1,160,940 | 374,460 |

## Sign-in initial JS closure (7 files)

| File | Raw | Gzip |
| --- | ---: | ---: |
| `index-CqOktgGQ.js` | 1,160,940 | 374,460 |
| `react-CjmPtrug.js` | 122,931 | 40,196 |
| `client-DYRaSs6x.js` | 29,531 | 11,075 |
| `agent-orb-CxpAMgpM.js` | 8,939 | 3,277 |
| `route-sign-CoJ-Dutw.js` | 3,626 | 1,449 |
| `separator-w55Qz2DV.js` | 528 | 321 |
| `application-config-DU7S_WBW.js` | 51 | 71 |
| **Total** | **1,326,546** | **430,849** |

## Chat initial JS closure (20 files)

| File | Raw | Gzip |
| --- | ---: | ---: |
| `mermaid-VLURNSYL-l9LeqfcE.js` | 1,799,037 | 511,551 |
| `index-CqOktgGQ.js` | 1,160,940 | 374,460 |
| `mermaid-HWGCJPDP-DMjXy-B0.js` | 300,029 | 95,528 |
| `combobox-ChfCD5Wb.js` | 223,896 | 72,460 |
| `react-CjmPtrug.js` | 122,931 | 40,196 |
| `abstract-avatar-Bm6Kmbwj.js` | 74,391 | 21,065 |
| `select-DKTE_T2O.js` | 42,197 | 15,587 |
| `skip-to-content-CX4rfq9q.js` | 45,346 | 14,096 |
| `team-bots-D3dOBR5l.js` | 37,780 | 12,733 |
| `route-chat-core-BtYhcyp6.js` | 6,716 | 2,795 |
| `checkbox-Dns2FWDB.js` | 5,518 | 2,637 |
| `sign-in-form-CfcVIJXN.js` | 4,712 | 1,740 |
| `item-BibFhSSZ.js` | 2,555 | 954 |
| `mutations-BWWwLsxA.js` | 2,132 | 843 |
| `useAriaLabelledBy-98RvrXMs.js` | 800 | 501 |
| `separator-w55Qz2DV.js` | 528 | 321 |
| `IconKey-DtMwiEKi.js` | 502 | 305 |
| `iso-BDwbgJ1O.js` | 422 | 273 |
| `IconCheck-BoEzdQYg.js` | 144 | 152 |
| `application-config-DU7S_WBW.js` | 51 | 71 |
| **Total** | **3,830,627** | **1,168,268** |

Observation for A09: the chat closure is dominated by mermaid (511,551 gz, 44% of the chat closure)
and the shared entry chunk (374,460 gz). Any HeroUI CSS/JS added to the entry chunk moves both
numbers; route-level additions move only chat.

## Frontend performance threshold per spec §7

- Sign-in initial JS gzip: **430,849 B** → 10% budget = **+43,085 B**.
- Chat initial JS gzip: **1,168,268 B** → 10% budget = **+116,827 B**.
- Total CSS gzip: **49,906 B** (sum of the three emitted files) → 10% budget = **+4,991 B**.

## CSS

| File | Raw | Gzip |
| --- | ---: | ---: |
| `index-BaxBj2Ps.css` | 263,907 | 41,280 |
| `combobox-DT0DV3PI.css` | 1,310 | 541 |
| `katex-BYZTj3zW.css` | 29,288 | 8,085 |
| **Sum** | **294,505** | **49,906** |
| Concatenated then gzipped | — | 50,061 |

`index-BaxBj2Ps.css` is the only stylesheet linked from `index.html`; `combobox-*.css` and
`katex-*.css` are pulled by lazily loaded chunks. Tailwind + `shadcn/tailwind.css` +
`prompt-area/tailwind.css` + `tw-animate-css` are all inside the main stylesheet today.

## Commands used

```sh
bun run --cwd app build
# entry evidence
cat app/dist/index.html
ls -l app/dist/assets/route-sign-* app/dist/assets/route-chat-core-*
# per-file
gzip -c app/dist/assets/<file> | wc -c
# static import closure (regular imports only) computed with a Node one-liner over
# /from"\.\/([^"]+\.js)"/ edges, then gzip level 6 per file and summed
```
