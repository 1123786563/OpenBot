/**
 * Loaded before any test file, so a component that portals can be rendered at all.
 *
 * Base UI decides ONCE, while its module is first evaluated, whether its isomorphic layout effect
 * is `useLayoutEffect` or a no-op:
 *
 *     export const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : noop;
 *
 * Every DOM test here registers happy-dom in its own `beforeAll`, which is far too late: bun walks
 * all the test files into one process, so whichever of them imports a route first pulls Base UI in
 * while `document` is still undefined, and the no-op is what every later file gets. A portal needs
 * that effect to resolve its container — so `Dialog` mounts nothing, forever, and a test that opens
 * one is left asserting against an empty `<body>` with no error to explain it.
 *
 * Worse, it decided that by import order. The same test passed on its own and failed in the suite,
 * which is the failure `test-preload.ts` exists to stop in the other direction.
 *
 * So the DOM is registered here, that one module is evaluated against it, and the DOM is taken away
 * again. Nothing else is left holding browser globals: server and worker tests run exactly as
 * before, and each DOM test file still registers and unregisters its own happy-dom.
 */

import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

GlobalRegistrator.register();
/* `@base-ui/utils` is not a dependency of this package; the react package that owns it is. */
await import("@base-ui/react/dialog");
/*
 * i18n is initialized while the DOM exists so language detection can read localStorage and
 * navigator, and with `initImmediate: false` it settles synchronously here: every component a
 * test renders afterwards gets real strings, so text-asserting tests keep meaning what they
 * meant before translations existed.
 */
await import("../src/lib/i18n");
GlobalRegistrator.unregister();

/**
 * `markFor` globs the vendored brand marks, and `import.meta.glob` is Vite's — under `bun test` it
 * is undefined and calling it throws. Anything that renders the New Bot dialog imports it
 * transitively, so without this every such file would need its own stub, and two of them passed
 * only because a stub in a *different* file leaked process-wide: exactly the walk-order dependency
 * the note above exists to stop.
 *
 * Null for every brand, which is a real state — four rows have no mark. A file that needs a mark
 * drawn calls `mock.module` itself and wins, because a later registration replaces this one.
 */
mock.module("../src/lib/marks", () => ({ markFor: () => null }));
