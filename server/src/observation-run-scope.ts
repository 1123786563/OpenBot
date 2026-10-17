/**
 * The ambient observation scope of the builtin run currently executing
 * (T-final M1 — the run-association threading the T37 review registered).
 *
 * The builtin execution path's facts (model spans, tool steps, retrievals)
 * are emitted from deep inside the run — stream taps, provider doStream, tool
 * executes — where no parameter can carry the caller's identity. This module
 * is the one ambient carrier, on the same footing as `usage-origin.ts` and
 * `enterprise/runs/request-context.ts`: an AsyncLocalStorage established once
 * where the run starts and read wherever a fact is emitted.
 *
 * Deliberately STRUCTURAL: the stored value is `unknown` here because the
 * modules that establish and the modules that read it must not import the
 * observability module a deployment may not have. `copilot.ts` establishes it
 * with whatever the boot wiring handed it; `index.ts`'s adapters cast it back,
 * and the cast is safe because the ONLY writer is the boot wiring's own
 * `resolveObservationScope` call — a scope this process actually issued (T06's
 * WeakSet trust), never a wire value.
 *
 * Nothing here falls back: outside a threaded run the read answers undefined,
 * and a scope-less observation submits nothing upstream — the exact honest
 * no-op the recorders already implement.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<Readonly<{ scope: unknown }>>();

/** Establish the executing run's observation scope for the duration of `fn`. */
export function withRunObservationScope<T>(scope: unknown, fn: () => T): T {
  return store.run({ scope }, fn);
}

/** The executing run's observation scope, or undefined outside a threaded run. */
export function currentRunObservationScope(): unknown {
  return store.getStore()?.scope;
}
