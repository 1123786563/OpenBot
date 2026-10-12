/**
 * The caller's origin, carried to usage facts (2026-10-13 audit, F6): a usage row's `client`
 * column must name the surface the call really came from, not a hardcoded guess. The origin is
 * read once where the request is still known (the model wrapper's doStream, the metering
 * reporter, the session middleware that fronts every API surface) and travels the ambient
 * store from there, the same pattern ./telemetry/request-tracking.ts uses for request ids —
 * a parameter threaded through the runtime's provider chain would cross module boundaries the
 * billing seam deliberately does not own.
 *
 * Controlled vocabulary, enforced at the two doors that set it:
 * - `web`  — a signed-in person's session (the session middleware sets this for every /api/*
 *   request it fronts);
 * - `api`  — an internal bearer-token surface (the routines worker dispatch);
 * - `unknown` — no origin was established (a path with no request context behind it, or a
 *   future CLI/token surface that has not named itself yet). A named unknown, never a wrong
 * `web`: misattribution is a billing-report bug that outlives the call.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type UsageOrigin = "web" | "api" | "unknown";

const originStore = new AsyncLocalStorage<{ origin: UsageOrigin }>();

/** Run `fn` (and everything it awaits) as work that came from `origin`. */
export function withUsageOrigin<T>(
  origin: Exclude<UsageOrigin, "unknown">,
  fn: () => Promise<T>,
): Promise<T> {
  return originStore.run({ origin }, fn);
}

/**
 * The origin to write on a usage fact: the innermost established one, or `unknown` when no
 * surface claimed the call. Nested calls override, so an internal dispatch named `api` under
 * the session middleware's `web` stays `api`.
 */
export function currentUsageOrigin(): UsageOrigin {
  return originStore.getStore()?.origin ?? "unknown";
}
