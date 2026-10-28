/**
 * This process's tracing registration, evaluated BEFORE anything else it imports (F9A /
 * F8D-1).
 *
 * `index.ts` imports this module first, on purpose. `initProcessTracing` registers the
 * process's tracer provider, the AsyncLocalStorage context manager and the W3C propagator
 * on the OpenTelemetry API's global slots, and the API REFUSES a second registration of any
 * of them — so whichever module registers first wins for the process's whole life. Calling
 * it from the bottom of `index.ts` (its historical home) left the entire LangChain/AG-UI
 * import graph free to evaluate first, and any dependency that ever touched those globals
 * at import time would have had its propagator in place instead of ours: every inbound
 * `traceparent` would then extract to nothing and the run would root a fresh trace. A
 * first-import registration closes that ordering hole in both directions — nobody can
 * register before this module runs, and nobody can override it after.
 *
 * The F8D evidence wave read the same symptom ("a live process ignores a valid
 * `traceparent`") as exactly that preemption; the mechanism it actually observed on the
 * real stack was Opik 2.2.100 silently dropping OTLP spans whose parent id cannot be
 * resolved in the receiving project — see the server's dial-chain anchors
 * (`server/src/copilot.ts`, `postDialChainAnchors`) for the half of the fix that lives on
 * the dialling side. This module is the half that makes the preemption impossible in the
 * first place, and `tests/trace-continuation.test.ts` pins the behaviour end to end against
 * the real process.
 */
import { initProcessTracing } from "../../shared/trace";

initProcessTracing("agent-langgraph", process.env);
