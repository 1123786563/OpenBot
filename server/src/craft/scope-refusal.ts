/**
 * #618: recognize the fail-closed execution-scope refusal in whatever shape a route's
 * catch meets it — the error class itself, or any wrap that carries the refusal
 * structurally as a cause (#656 D3 generalized the original WorkspaceListingError
 * arm to every wrap), with the fixed sentence embedded in the text as the fallback
 * for wraps built before the chain. Born in file-routes.ts for the
 * upload/archive/delete faces (R1-F2/r3) and hoisted here when FR-F1 brought the
 * session-lifecycle entrances (create/snapshot/restore) to the same recognizer, so
 * every craft face answers the one sentence the same way — through the guard below
 * since #656 D2.
 */
import { HTTPException } from "hono/http-exception";
import { WorkspaceListingError } from "./directory-archive";
import { SandboxExecutionScopeUnavailableError } from "./errors";

/**
 * The fixed sentence, matched on and rebuilt from — never carried by a shared Error
 * instance (#618 OCR r2): a matched refusal is rethrown into request chains, and one
 * error-enhancing layer rewriting a shared singleton's message would corrupt the
 * needle this recognizer matches on, silently. Since OCR r4 the structural arm hands
 * back the ORIGINAL refused instance (its stack is the debug trace) — an enhancer may
 * have rewritten that instance's message on the way — so the 503 body is answered from
 * this immutable string, never from `refusal.message` (#618 OCR r4).
 */
const REFUSAL_MESSAGE = new SandboxExecutionScopeUnavailableError().message;

/** How deep into a cause chain the recognizer will look — see the walk below. */
const CAUSE_WALK_MAX_HOPS = 4;

export function sandboxScopeRefusalOf(
  error: unknown,
): SandboxExecutionScopeUnavailableError | null {
  if (error instanceof SandboxExecutionScopeUnavailableError) return error;
  if (error instanceof Error) {
    // Structural first (#618 OCR r2), on ANY wrap (#656 D3): the wrap's own
    // type is not the contract — the archive walk's WorkspaceListingError fold
    // was merely the first shape seen, and a probe wrap (the healthCheck chain)
    // or a future enhancer layer must not re-open the mask. The walk is
    // bounded at CAUSE_WALK_MAX_HOPS cause hops: deeper than any real fold
    // (the walk is one hop, a probe wrap two), and the bound is also the
    // cycle-proofing a looping chain (a wraps b wraps a) needs, so a crafted
    // chain terminates here instead of hanging the route's catch.
    let hop: unknown = error.cause;
    for (
      let depth = 0;
      depth < CAUSE_WALK_MAX_HOPS && hop !== null && hop !== undefined;
      depth += 1
    ) {
      if (hop instanceof SandboxExecutionScopeUnavailableError) {
        // The original instance, not a rebuild (#618 OCR r4): the refusal
        // keeps no log line, so the first throw's stack — minted inside the
        // header assembly, before the wrap folded it — is the only trace an
        // operator gets, and a rebuild discards it. Not the shared singleton
        // OCR r2 barred: each throw site mints its own, so handing one back
        // cannot let an enhancer corrupt the needle the two arms share.
        return hop;
      }
      if (!(hop instanceof Error)) break;
      hop = hop.cause;
    }
    // Fallback: wraps that carry no refusal on the chain still answer by the
    // fixed sentence embedded in the text — the only shape every pre-chain
    // wrap could produce. Kept scoped to the listing wrap: that family is the
    // known pre-chain producer, and widening a text match to every Error
    // would claim refusals nobody minted.
    if (
      error instanceof WorkspaceListingError &&
      error.message.includes(REFUSAL_MESSAGE)
    ) {
      return new SandboxExecutionScopeUnavailableError();
    }
  }
  return null;
}

/**
 * The one guard shape every catch-bearing route face calls on its error (#656
 * D2 collapsed the seven two-line snippets into this): a refusal answers ITSELF
 * — the throw IS the 503, with the fixed sentence as the body and nothing else
 * (no log line: the sentence IS the reason, and it names no value to leak).
 *
 * Because the answer is a throw, not a returned response, the refusal outranks
 * every masking branch the catch carries BY CONSTRUCTION — hono's error chain
 * hands the HTTPException straight to the wire — so "the refusal precedes the
 * mask" is a property of this guard, not an ordering each call site has to
 * remember. The restore entrance keeps its rethrow shape: after the guard
 * passes, it rethrows the original error untouched.
 */
export function assertNotScopeRefusal(error: unknown): void {
  const refusal = sandboxScopeRefusalOf(error);
  if (refusal === null) return;
  // The body is the canonical sentence BY CONSTRUCTION (#618 OCR r4): the
  // recognizer hands back the original instance — the stack an operator needs —
  // and an enhancing layer may have rewritten that instance's message on the
  // way here. Answering REFUSAL_MESSAGE (never refusal.message) keeps the 503
  // body fixed through any rewrite, which is the r2 contract the fresh-instance
  // rebuild used to provide.
  throw new HTTPException(503, {
    res: new Response(JSON.stringify({ error: REFUSAL_MESSAGE }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  });
}
