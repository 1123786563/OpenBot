# H02 spike triage — two modal tests red only in the shared app tier

**Root cause (a), cross-file module state — not HeroUI behaviour, not in-file ordering.** react-aria decides once, when its `useLayoutEffect` module is first evaluated, whether it exports React's layout effect or `() => {}`. Every RAC overlay animates its exit in that effect. `preload.ts` opens a document only for the FIRST file's import graph in a worker; later files are cached, so `@heroui/react` is evaluated with `document` undefined and the no-op wins process-wide. A modal closed through `isOpen` then flips to `exiting` and never reaches `closed`: `<section role="dialog">` stays mounted with `data-exiting="true"`, and its focus scope leaves `aria-hidden` on siblings — why the nested test finds both dialogs yet cannot read "Outer". Alone, this file is first, so it never sees the no-op.

**Evidence.** alone 15/15 (`alone-fixed/`); `--workers 1 a2ui + spike` = 2 failed (`repro-two-files/`); full tier = same 2 (`full/`); the resolved module prints `()=>{}` in a shared process and `function (create, deps)` alone. A file-local dynamic import (`full-fixed/`) is not enough once a sibling has cached the no-op, so the fix cannot live in the test file.

**Fix.** `preload.ts` imports `@heroui/react/modal` inside its first document window (same seam as Base UI), before the React DOM warm-up. `heroui-spike.test.tsx` also asserts a clean body before each modal test, waits on `onOpenChange(false)` and on dialog removal, and asserts no dialog/backdrop survives. Assertions unchanged in strength.

**Out of scope:** `TextArea …onChange` still fails in the full tier from a different leak; `craft-preview-tab.test.tsx` + spike reproduces it (0 calls).
