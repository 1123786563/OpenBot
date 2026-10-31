import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/public";
import type { ThreadIdentity } from "./thread-identity";

const log = getLogger("server");

/**
 * A thread id for a conversation this deployment keeps no channel for.
 *
 * The direct Bot chat is CopilotKit's own component, and left to itself it generates an id in the
 * browser that says nothing about where the conversation came from. Minting it here puts those
 * threads in the same namespace as every channel's, so one project shared by two deployments can
 * still tell whose conversations are whose.
 *
 * Behind the session guard because a thread id is the name of somewhere a conversation will be
 * stored, and there is no reason for anybody signed out to be handed one.
 */

/**
 * Answers whether Intelligence still has a given thread for a given person.
 *
 * Two outcomes only, and deliberately not a third: `"known"` means the thread is there, `"unknown"`
 * means Intelligence has clearly said it is not. A check that failed to get either answer — a
 * timeout, a 5xx, a client that was never configured right — is not a value this type can hold; the
 * function that implements it throws instead, so `GET /:threadId` below can tell "this thread is
 * gone" from "this thread could not be checked" and answer 502 for the second rather than quietly
 * reporting it as gone.
 */
export type ThreadReader = (
  threadId: string,
  userId: string,
) => Promise<"known" | "unknown">;

/**
 * The enterprise parent-root gate for this surface, wired by a deployment that
 * runs the tenancy decision services (T06.02).
 *
 * A thread is a child object: it can only be asked about through the company
 * its parent root (the conversation, or the channel that maps it) belongs to.
 * `deny` must be answered before the reader is consulted — the check is the
 * whole point, and an existence probe that reaches Intelligence has already
 * leaked. `null` says the enterprise registry holds no parent fact for the
 * thread (a scratch thread, or one a different deployment minted), and the
 * route keeps its existing behavior for it.
 *
 * Structurally typed on purpose: this module does not import the tenancy
 * module; the wired implementation satisfies the shape.
 */
export interface ThreadParentActions {
  authorizeThread(
    request: Request,
    threadId: string,
  ): Promise<ThreadParentDecision | null>;
}

export type ThreadParentDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny"; readonly code: "RESOURCE_NOT_FOUND" };

/**
 * A UUID-shaped string, nothing more. Not the format `thread-identity.ts` mints — this route also
 * has to answer for a thread a *different* deployment minted, or one minted before this deployment
 * had a name, and `identity.owns` is false for both of those without either meaning the thread is
 * gone. The only question this route can honestly ask is Intelligence's own; the shape check exists
 * only to keep a string that could not possibly be a thread id from reaching Intelligence at all.
 */
const PLAUSIBLE_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createThreadRoutes(
  identity: ThreadIdentity,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Absent when this deployment has no way to ask Intelligence about a thread — no client, or a
   * caller that chose not to build one. `GET /:threadId` is then not registered at all, rather than
   * registered and answering 502 to everyone: a route that cannot possibly succeed should not exist.
   * `POST /mint` needs no reader and is unaffected either way.
   */
  readThread?: ThreadReader,
  /** The enterprise parent-root gate; absent, this factory is exactly the legacy surface. */
  threadActions?: ThreadParentActions,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/mint", requireUser, (context) =>
    context.json({ threadId: identity.mint() }),
  );

  if (readThread) {
    /*
     * What this buys the browser: proof, before it sends a single message, that a thread id it
     * remembers from last time is one Intelligence still has. If the answer is no, it can start a
     * fresh thread knowing there is provably nothing left in the old one to lose. Without this route
     * that is not what happens — the browser sends anyway, Intelligence silently starts a new, empty
     * thread under the remembered id, and the person is answered as though the conversation were new
     * with nothing on screen to say their history is gone.
     */
    routes.get("/:threadId", requireUser, async (context) => {
      const threadId = context.req.param("threadId");
      if (!PLAUSIBLE_THREAD_ID.test(threadId)) {
        return context.json({ error: "Not a thread id." }, 400);
      }

      /*
       * The enterprise answer first, and before anything is asked upstream: a
       * thread whose parent root belongs to another company (or to another
       * person in the caller's own team) is the same not-found the reader
       * below answers for a thread that is not there, so this route confirms
       * nothing about which threads exist — and the reader is never consulted
       * for it, which is the only way an existence probe is truly refused.
       * null = the registry holds no parent fact for this thread, and the
       * check below stands as-is.
       */
      if (threadActions) {
        const decision = await threadActions.authorizeThread(
          context.req.raw,
          threadId,
        );
        if (decision?.outcome === "deny") {
          return context.json({ error: "Thread not found." }, 404);
        }
      }

      try {
        const status = await readThread(threadId, context.var.actor.id);
        return context.json({ known: status === "known" });
      } catch (error) {
        // The reader throws for everything short of a clean known/unknown answer, and what it threw
        // may name an upstream host or otherwise be unfit for a browser to see, so only its kind is
        // logged, not its content. The browser gets "the check failed", which is exactly as much as
        // it is owed: enough to know not to trust `known: false`, nothing that was not already true
        // before this request.
        log.error(
          {
            type: "thread-status-check-failed",
            errorType: error instanceof Error ? error.name : "unknown",
            note: "Could not determine whether Intelligence still has this thread.",
          },
          "thread-status-check-failed",
        );
        return context.json({ error: "Could not check thread status." }, 502);
      }
    });
  }

  return routes;
}
