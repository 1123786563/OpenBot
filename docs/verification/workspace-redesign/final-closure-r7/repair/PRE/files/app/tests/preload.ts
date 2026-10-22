/**
 * Loaded before any test file, so a component that portals can be rendered at all.
 *
 * Isomorphic libraries decide ONCE, while their module is first evaluated, whether their layout
 * effect is the real thing or a no-op:
 *
 *     exports.useLayoutEffect = typeof document !== 'undefined' ? React.useLayoutEffect : () => {};
 *
 * Every DOM test here registers happy-dom in its own `beforeAll`, which is far too late: bun walks
 * all the test files into one process, so whichever of them imports a route first pulls such a
 * library in while `document` is still undefined, and the no-op is what every later file gets. A
 * portal needs that effect to resolve its container — so an overlay mounts nothing, forever, and a
 * test that opens one is left asserting against an empty `<body>` with no error to explain it.
 *
 * Worse, it decided that by import order. The same test passed on its own and failed in the suite,
 * which is the failure `test-preload.ts` exists to stop in the other direction.
 *
 * So the DOM is registered here, those modules are evaluated against it, and the DOM is taken away
 * again. Nothing else is left holding browser globals: server and worker tests run exactly as
 * before, and each DOM test file still registers and unregisters its own happy-dom.
 *
 * (H14: the warm-up window that existed for `@base-ui/react/dialog` is gone with the dependency —
 * no module under `src/` imports Base UI any more, so there is nothing left to evaluate early.)
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * The native runner (Node) leaves NODE_ENV unset; `bun test` (the driven layer) sets it to "test".
 * `@tanstack/router-core` decides client- vs server-side through the `node` export condition from
 * NODE_ENV at MODULE-EVAL time, so whichever test file first imports the router decides its
 * behavior for the whole shared process. With the variable unset there, the router never mounts
 * its client-side Transitioner and any later `RouterProvider` crashes in Matches ("Cannot read
 * properties of undefined (reading '0')") — the exact signature that routes the repo's other
 * router suites to the driven layer. Stating `test` here — before any test file's own imports
 * evaluate — gives the native layer the same environment the driven layer already runs under, and
 * `computer-driving-local-fields.test.tsx` (the one suite that must stay native) stops depending
 * on its own beforeAll winning a module-eval race. (H14, full-native sweep.)
 */
process.env.NODE_ENV = "test";

/*
 * The one true fetch, captured before any test file has had a chance to stub it. Files that
 * swap `global.fetch` in beforeEach/afterEach pairs restore "the original" — but bun evaluates
 * every test module up front, so a module-level capture can pick up a SIBLING's stub instead
 * (billing-credits-ui's catalog fetch, installed before account-mode-dialog's body runs).
 * Restoring that means installing the sibling's stub for keeps. Any file may restore to this
 * handle instead; see account-mode-dialog.test.tsx.
 */
declare global {
  // eslint-disable-next-line no-var
  var BunTEST_ORIGINAL_FETCH: typeof globalThis.fetch | undefined;
}
globalThis.BunTEST_ORIGINAL_FETCH = globalThis.fetch;

/*
 * Warm React DOM — and with it the scheduler — BEFORE ANY happy-dom window exists, not merely
 * before the next one. `scheduler` decides once, while it is evaluated, where its host callback
 * goes, and react-dom additionally captures `scheduleTimeout` (`setTimeout`) while it loads:
 *
 *     localSetImmediate = typeof setImmediate !== 'undefined' ? setImmediate : null
 *     scheduleTimeout   = "function" === typeof setTimeout ? setTimeout : void 0
 *
 * Evaluating it inside a registered window — or after one has been registered and closed — captures
 * that window's timer functions, which belong to a `Window` this file closes again: every callback
 * React's scheduler posts afterwards lands on a dead window and silently never runs. Closing the
 * window is not enough; happy-dom's unregister does not put Node's timers back on `globalThis`.
 *
 * A render still commits, and an update triggered from an event still flushes because `act`
 * flushes synchronously. What dies is the update React schedules for later: a query resolving, a
 * timer setting state. The DOM then freezes on its loading state forever, and `findBy*` reports
 * "element not found" for content that is already in the query cache. Proven on the native layer
 * (e2e, node target) during H04: with the warm placed after the react-aria window below, every
 * timer-scheduled rerender in every file died; with this import first — before the first
 * `GlobalRegistrator.register()` — they all flush again, and the driven layer's capture is the
 * equally-live global one.
 */
await import("react-dom/client");

/*
 * react-aria makes the same one-shot decision Base UI does, one package further out:
 *
 *     exports.useLayoutEffect = typeof document !== 'undefined' ? React.useLayoutEffect : () => {};
 *
 * Every RAC overlay runs its enter/exit animation inside that effect. With the no-op, a modal whose
 * controlled `isOpen` turns false flips to `exiting` during render and never reaches `closed`, so
 * `<section role="dialog">` stays mounted with `data-exiting="true"` for the rest of the process,
 * and its focus scope leaves `aria-hidden` on every sibling — the next test's dialogs are found but
 * unreadable. `@heroui/react/modal` is the component that pulls react-aria in; it is evaluated in
 * this first, short-lived window, so the real effect is what every later file imports.
 */
GlobalRegistrator.register();
await import("@heroui/react/modal");
GlobalRegistrator.unregister();

/*
 * i18n is initialized while the DOM exists so language detection can read localStorage and
 * navigator, and with `initImmediate: false` it settles synchronously here: every component a
 * test renders afterwards gets real strings, so text-asserting tests keep meaning what they
 * meant before translations existed.
 */
GlobalRegistrator.register();
await import("../src/lib/i18n");
GlobalRegistrator.unregister();
