import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { tryClient } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { newId } from "../new-id";

/**
 * The thread the direct Bot chat talks in.
 *
 * Two things it has to be. Minted by this deployment, so the conversation says where it came from
 * in a project that may hold more than one. And the same one tomorrow, because a chat that takes a
 * new thread on every load has no history to come back to.
 *
 * Kept per Bot: the chat is bound to one Bot at a time, and two Bots sharing a thread would read
 * each other's conversation.
 *
 * OpenBot needs a private channel before its runtime can connect to a thread. Intelligence can
 * start from a deployment-minted ID. Before reusing an ID from localStorage, ask the active
 * runtime whether the thread is still accessible.
 */

const KEY = "openbot.bot-thread";

/** The one place the storage key is built, so the getter and the setter can never drift apart. */
export function botThreadKey(agentId: string): string {
  return `${KEY}.${agentId}`;
}

function remembered(agentId: string): string | null {
  try {
    return window.localStorage.getItem(botThreadKey(agentId));
  } catch {
    // Storage can be unavailable or full. A thread for this visit is better than no chat at all.
    return null;
  }
}

function remember(agentId: string, threadId: string): void {
  try {
    window.localStorage.setItem(botThreadKey(agentId), threadId);
  } catch {
    // As above: the conversation still works, it just will not be here next time.
  }
}

const threadResponse = z.object({ threadId: z.string() });
const knownResponse = z.object({ known: z.boolean() });

type CreatedThread = { threadId: string; persisted: boolean };

async function mint(): Promise<string | null> {
  try {
    const response = await tryClient("/api/threads/mint", { method: "POST" });
    if (!response.ok) return null;
    const parsed = threadResponse.safeParse(await response.json());
    return parsed.success ? parsed.data.threadId : null;
  } catch {
    return null;
  }
}

/**
 * Whether Intelligence still has a remembered thread, and whether the question could even be put
 * to it. Those are separate facts: a 404 on this route means no reader is configured on this
 * deployment at all, which says nothing about the thread and must not be read as bad news, while a
 * 400 or a 502 (or the request simply throwing) means the question was asked and failed to get a
 * clean answer.
 */
async function checkKnown(
  agentId: string,
  threadId: string,
  local: boolean,
): Promise<{ known: boolean | undefined; unavailable: boolean }> {
  try {
    const encodedThread = encodeURIComponent(threadId);
    const response = await tryClient(
      local
        ? `/api/copilotkit/agent/${encodeURIComponent(agentId)}/thread/${encodedThread}`
        : `/api/threads/${encodedThread}`,
    );
    if (!local && response.status === 404) {
      // The route itself is absent, which is what an unconfigured reader looks like server-side.
      // Behave exactly as this hook did before the check existed: nothing was learned, nothing
      // changes.
      return { known: undefined, unavailable: false };
    }
    if (!response.ok) {
      // A 400 means the remembered id was not even a plausible thread id; a 502 means the check
      // itself failed to reach Intelligence. Either way there is no clean answer, and the safer
      // read is "unknown" rather than "gone" — see threadToUse for why.
      return { known: undefined, unavailable: true };
    }
    const parsed = knownResponse.safeParse(await response.json());
    if (!parsed.success) {
      // A 200 that does not carry the shape this hook asked for is not an answer either.
      return { known: undefined, unavailable: true };
    }
    return { known: parsed.data.known, unavailable: false };
  } catch {
    return { known: undefined, unavailable: true };
  }
}

/**
 * Whether to keep the remembered thread id or start over, given what the check above learned.
 *
 * The two ways of not keeping it are not the same mistake. `known: false` is Intelligence saying,
 * plainly, that it has never heard of this id — replacing it loses nothing, because there was
 * never anything there to lose, and keeping it would only mean sending every message into a thread
 * that quietly reopens empty. `known: undefined` is the opposite kind of ignorance: the check
 * failed to get an answer at all, and discarding somebody's conversation on the strength of a
 * network blip is the worse mistake of the two. So only a provable "no" moves this to `"fresh"`;
 * an inconclusive check keeps what was remembered. No remembered id to keep is its own case: with
 * nothing to protect, there is nothing the check could have told us that would change the outcome.
 */
export function threadToUse(input: {
  remembered: string | null;
  known: boolean | undefined;
}): "remembered" | "fresh" {
  if (input.remembered === null) return "fresh";
  return input.known === false ? "fresh" : "remembered";
}

export type BotThread = {
  /** `undefined` until it is known, which is not the same as absent: rendering the chat before
   * then would let it mint an id of its own, and that is the one this deployment would then be
   * stuck with. */
  threadId: string | undefined;
  /**
   * `"unavailable"` means the check that guards a remembered thread failed to get a clean answer,
   * so this render is going ahead on a thread id that history may or may not still exist for and
   * nobody can currently say which. `"ready"` covers every case where that question was either
   * answered or never needed asking.
   */
  history: "ready" | "unavailable" | "missing";
  retryHistory: () => void;
  checkingHistory: boolean;
  /** Mints a fresh thread and starts using it from now on, independent of whatever was
   * remembered. */
  startNew: () => void;
  starting: boolean;
  startFailed: boolean;
};

/**
 * The thread the direct Bot chat talks in, resolved once per `agentId` and re-verified on every
 * mount rather than trusted forever — see the module doc for why a remembered id can go stale.
 */
export function useBotThread(agentId: string): BotThread {
  const queryClient = useQueryClient();
  const { mutateAsync: createChannel } = useMutation(
    createChannelMutationOptions(queryClient),
  );
  const localRuntime = useCallback(async () => {
    const capabilities = await queryClient.fetchQuery(
      deploymentCapabilitiesQueryOptions(),
    );
    return capabilities.mode === "openbot";
  }, [queryClient]);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<BotThread["history"]>("ready");
  const [checkingHistory, setCheckingHistory] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  // Mirrors the effect's own `current` flag so `startNew` — which runs from an event handler, not
  // from the effect — can tell whether it is still safe to touch state: the agent may have changed
  // or the component may have unmounted while its mint was in flight.
  const mountedRef = useRef(true);
  // Share an in-flight creation across effect replays and reuse its request ID after a failure.
  const creationRef = useRef<{
    agentId: string;
    requestId: string;
    pending?: Promise<CreatedThread | null>;
  }>(undefined);
  const createThread = useCallback(
    (allowLegacyFallback = false) => {
      const creation =
        creationRef.current?.agentId === agentId
          ? creationRef.current
          : { agentId, requestId: newId() };
      creationRef.current = creation;
      creation.pending ??= (async () => {
        const local = await localRuntime();
        const minted = local
          ? (
              await createChannel({
                agentIds: [agentId],
                requestId: creation.requestId,
              })
            ).threadId
          : await mint();
        if (minted) return { threadId: minted, persisted: true };
        if (!local && allowLegacyFallback)
          return { threadId: newId(), persisted: false };
        return null;
      })()
        .catch(() => null)
        .then((next) => {
          creation.pending = undefined;
          if (next && creationRef.current === creation)
            creationRef.current = undefined;
          return next;
        });
      return creation.pending;
    },
    [agentId, createChannel, localRuntime],
  );
  const checkThread = useCallback(
    async (id: string) => {
      try {
        return await checkKnown(agentId, id, await localRuntime());
      } catch {
        return { known: undefined, unavailable: true };
      }
    },
    [agentId, localRuntime],
  );
  // Set once `startNew` has taken over, so the mount-time check that is still in flight does not
  // then overwrite the fresh thread with the remembered one.
  const startedNewRef = useRef(false);

  useEffect(() => {
    let current = true;
    mountedRef.current = true;
    // A new agent resolves from scratch, so any earlier `startNew` no longer speaks for this one.
    startedNewRef.current = false;
    setThreadId(undefined);
    setHistory("ready");
    setStartFailed(false);

    const adoptFresh = (history: BotThread["history"] = "ready") => {
      void createThread(true).then((next) => {
        if (!current) return;
        if (!next) {
          setStartFailed(true);
          return;
        }
        if (next.persisted) remember(agentId, next.threadId);
        setThreadId(next.threadId);
        setHistory(history);
      });
    };

    const existing = remembered(agentId);
    if (!existing) {
      // Nothing remembered means nothing the check could protect — minting straight away is both
      // faster and exactly as safe as asking Intelligence about an id that was never assigned.
      adoptFresh();
    } else {
      void checkThread(existing).then((outcome) => {
        // `startedNewRef` as well as `current`: the agent may have changed (which `current` catches),
        // or the person may have pressed New chat while this check was in flight, and a check about
        // the thread they just left must not put it back.
        if (!current || startedNewRef.current) return;
        const decision = threadToUse({
          remembered: existing,
          known: outcome.known,
        });
        if (decision === "remembered") {
          setThreadId(existing);
          setHistory(outcome.unavailable ? "unavailable" : "ready");
        } else {
          adoptFresh("missing");
        }
      });
    }

    return () => {
      current = false;
      mountedRef.current = false;
    };
  }, [agentId, checkThread, createThread]);

  const startNew = useCallback(() => {
    if (creationRef.current?.pending) return;
    setStarting(true);
    setStartFailed(false);
    void createThread().then((minted) => {
      if (!mountedRef.current) return;
      setStarting(false);
      // Leaving the current thread alone here matters: a person pressing "New chat" should never
      // end up worse off — mid-conversation and suddenly unable to send — than before they pressed
      // it.
      if (!minted) {
        setStartFailed(true);
        return;
      }
      /*
       * Latched here rather than at the press, and the difference is a blank screen.
       *
       * Set on the press, a mint that then fails leaves the mount-time check disarmed with nothing
       * having replaced the thread: `bot.tsx` renders the chat only when there is one, so the person
       * is left looking at an empty pane with no message and no way back but a reload. Set here, a
       * failed mint disarms nothing and the remembered thread is still restored.
       *
       * This is not a weaker guard. Assignment and the check below both run to completion on one
       * thread, so a `checkKnown` that resolves after this sees it, and one that resolves before it
       * has already restored a thread that this line is about to replace — which is what the person
       * asked for.
       */
      startedNewRef.current = true;
      remember(agentId, minted.threadId);
      setThreadId(minted.threadId);
      setHistory("ready");
    });
  }, [agentId, createThread]);

  const retryHistory = () => {
    if (!threadId || checkingHistory) return;
    const checkedThread = threadId;
    setCheckingHistory(true);
    void checkThread(checkedThread).then(({ known, unavailable }) => {
      if (!mountedRef.current) return;
      setCheckingHistory(false);
      if (remembered(agentId) !== checkedThread || unavailable) return;
      setHistory(known === false ? "missing" : "ready");
    });
  };

  return {
    threadId,
    history,
    startNew,
    retryHistory,
    checkingHistory,
    starting,
    startFailed,
  };
}
