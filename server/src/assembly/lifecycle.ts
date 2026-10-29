/**
 * MOD03 (#623): the runtime's explicit resource lifecycle.
 *
 * The deployment assembly used to hold every long-lived resource in module
 * scope and hard-code the shutdown sequence inside an inline SIGINT/SIGTERM
 * handler. This module replaces that scatter with one registry: resources are
 * `hold()`-ed as they are created (an optional capability that is switched off
 * never creates its resource, so it never registers — the `?.` of the old
 * handler), and `stopRegistered()` replays the registry in registration order.
 *
 * The registry is deliberately DUMB — it composes, it does not decide:
 *
 *   - `stopRegistered()` invokes every held `stop` synchronously in order and
 *     NEVER awaits between stops — exactly like the inline handler it replaces,
 *     which fired each stop and only waited for the final listener group.
 *     `isolate` entries get their own try/catch (the billing sweeps' contract:
 *     one throwing stop must not block the rest); a non-isolated stop that
 *     throws aborts the remaining sequence and propagates — also what the
 *     inline handler did.
 *   - The RETURN value is the last entry's completion (today: the
 *     listener/retention `Promise.allSettled` group). Callers that want the
 *     process to exit afterwards attach their own `.finally(() =>
 *     process.exit(0))` — see installSignalShutdown. The exit deliberately
 *     does NOT live inside stopRegistered, so a failed-startup rollback
 *     (assembleRuntime's catch) can drain the registry and still rethrow with
 *     a NON-ZERO exit instead of being swallowed by exit(0).
 *   - `installSignalShutdown` adds the once guard the inline handler lacked:
 *     a second signal must not replay the stop sequence (no duplicate side
 *     effects — #623 acceptance 3).
 *
 * Self-contained by contract: no imports, no module state, no listeners at
 * import time (MOD03 plan W5) — importing this file is side-effect free.
 */

export interface HeldResource {
  /** Diagnostic identity: the name the stop-order pin and shutdown logs use. */
  name: string;
  /** Stops the resource. Return a promise only when the caller should wait on it. */
  stop: (() => void) | (() => Promise<unknown>);
  /**
   * Independent try/catch around this stop (the billing sweeps' per-stop
   * isolation): a throw is swallowed so the remaining stops still run.
   */
  isolate?: boolean;
}

export function createRuntimeLifecycle() {
  const resources: HeldResource[] = [];

  function hold(resource: HeldResource): void {
    resources.push(resource);
  }

  function stopRegistered(): Promise<unknown> {
    let completion: unknown;
    for (const resource of resources) {
      if (resource.isolate) {
        try {
          completion = resource.stop();
        } catch {
          // Deliberately swallowed (HeldResource.isolate): the remaining stops
          // and the listener shutdown still run.
        }
      } else {
        completion = resource.stop();
      }
    }
    return Promise.resolve(completion);
  }

  /**
   * Installs one shutdown handler for each signal. The handler runs the
   * registered stop sequence ONCE — the once guard means a second signal is
   * acknowledged but never replays the sequence. When the sequence completes
   * (the final allSettled group settles) the process exits 0, exactly where
   * the inline handler's `.finally` used to fire. A stop that throws
   * synchronously escapes the handler instead: no exit(0), the same way the
   * inline handler died mid-sequence.
   *
   * Returns a disposer that removes the installed listeners (tests use it so
   * probe signals never leak into the runner).
   */
  function installSignalShutdown(signals: readonly string[]): () => void {
    let handled = false;
    const shutdown = () => {
      if (handled) {
        // Once guard: the stop sequence must not run twice (no duplicate side
        // effects on a double Ctrl-C).
        return;
      }
      handled = true;
      const completion = stopRegistered();
      void Promise.resolve(completion).finally(() => process.exit(0));
    };
    for (const signal of signals) {
      process.on(signal as NodeJS.Signals, shutdown);
    }
    return () => {
      for (const signal of signals) {
        process.removeListener(signal as NodeJS.Signals, shutdown);
      }
    };
  }

  return { hold, stopRegistered, installSignalShutdown };
}
