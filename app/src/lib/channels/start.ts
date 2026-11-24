import type { Attachment } from "@copilotkit/react-core/v2";
import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ComposerDraft } from "@/components/channels/composer";
import type { StoredThread } from "@/lib/copilot/thread-messages";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  createGroupMutationOptions,
  groupQueryOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { saveConversationModel } from "@/lib/models/mutations";
import type { ConversationModel } from "@/lib/models/queries";
import { newId } from "@/lib/new-id";
import {
  createChannelMutationOptions,
  deleteChannelMutationOptions,
} from "./mutations";
import {
  claimFirstSend,
  finishPendingStart,
  pendingAttachmentRefs,
  readPendingStart,
  restorePendingAttachments,
  type StartRecipient,
  type StartRecord,
  savePendingStart,
} from "./pending-start";
import { channelKeys } from "./queries";
import { CoworkerRoutingRefusedError, routeMessage } from "./route";

/**
 * Start a channel with a coworker the person chose themselves, and say so first.
 *
 * A conversation that was routed has a `channel.routed` row saying where it went and why; one whose
 * coworker the person picked must have one too, or the trail reads as if the row failed to write.
 * The home composer told the server about an `@` choice; a coworker picked in the To: field of
 * `/channel/new` — the sidebar's +, a coworker's card, its profile — was never told to anybody. The
 * two screens now share this one sequence: record, then start.
 *
 * The record is sent before the channel is asked for, the way the routed path records before a
 * channel is pinned, and its answer is thrown away: the person already decided and nothing here may
 * change that. Failing to write the row must not stop the conversation, so a rejection is swallowed
 * whole. And because nothing waits on its answer, nothing waits on it at all: it used to be awaited,
 * which put a whole round trip between send and the conversation opening for a row nobody reads.
 * Pure so the sequence can be tested; the hook below binds it to the real calls.
 */
export async function startWithChosen(input: {
  agentId: string;
  text: string;
  record: (text: string, agentId: string) => Promise<unknown>;
  start: (agentId: string, text: string) => Promise<void>;
}): Promise<void> {
  void input.record(input.text, input.agentId).catch(() => undefined);
  await input.start(input.agentId, input.text);
}

/** Persist before leaving the composer so even an interrupted navigation is recoverable. */
export function useSubmitConversationStart(owner: string | undefined) {
  const navigate = useNavigate();
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (
    draft: ComposerDraft,
    recipient: StartRecipient,
    model: ConversationModel | null = null,
    onSaved?: () => void,
  ) => {
    if (!owner || submitting.current) return;
    submitting.current = true;
    setError(null);
    try {
      const id = newId();
      const attachments = pendingAttachmentRefs(draft.attachments);
      savePendingStart(owner, id, {
        state: "pending",
        progress: { phase: "creating" },
        draft: {
          text: draft.text,
          commandIds: draft.commandIds,
          attachments,
          recipient,
          model,
        },
      });
      onSaved?.();

      const open = () =>
        navigate({ to: "/start/$startId", params: { startId: id } });
      if (recipient.kind === "direct") {
        await startWithChosen({
          text: draft.text,
          agentId: recipient.agentId,
          record: routeMessage,
          start: open,
        });
      } else {
        await open();
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t save your message. Try again.",
      );
      throw cause;
    } finally {
      submitting.current = false;
    }
  };
  return { submit, error };
}

type ProgressUpdate = (start: StartRecord) => void;
const startsInProgress = new Map<string, Promise<StartRecord>>();

/** Same-tab mounts share the handoff. Across refreshes, creation and group sends reuse their IDs. */
export function resumeConversationStart(
  queryClient: QueryClient,
  owner: string,
  id: string,
  update: ProgressUpdate,
): Promise<StartRecord> {
  const key = JSON.stringify([owner, id]);
  const existing = startsInProgress.get(key);
  if (existing) return existing;

  const work = async (): Promise<StartRecord> => {
    const start = readPendingStart(owner, id);
    if (!start)
      throw new Error("Your saved message is unavailable in this browser.");
    if (start.state === "finished") return start;
    const save = (next: StartRecord) => {
      savePendingStart(owner, id, next);
      update(next);
    };
    let { draft, progress } = start;
    if (draft.recipient.kind === "route") {
      let agentId: string | undefined;
      try {
        agentId = (await routeMessage(draft.text, undefined, draft.commandIds))
          .agentId;
      } catch (error) {
        if (
          draft.commandIds.length ||
          error instanceof CoworkerRoutingRefusedError
        )
          throw error;
        agentId = draft.recipient.fallbackId;
      }
      if (!agentId)
        throw new Error("No Bot is available to receive your message.");
      draft = { ...draft, recipient: { kind: "direct", agentId } };
      save({ state: "pending", draft, progress });
    }
    const target = draft.recipient;
    if (target.kind === "route") throw new Error("A Bot is required.");
    const group = target.kind === "group";
    if (progress.phase === "creating") {
      // A delayed tab must not undo progress already saved by a second tab.
      const channel = await new MutationObserver(
        queryClient,
        group
          ? createGroupMutationOptions(queryClient)
          : createChannelMutationOptions(queryClient),
      ).mutate({
        requestId: id,
        agentIds: group ? target.agentIds : [target.agentId],
      });
      const pick = draft.model;
      if (!group && pick && (pick.model !== null || pick.effort !== null)) {
        try {
          await saveConversationModel(channel.id, pick);
        } catch (error) {
          await new MutationObserver(
            queryClient,
            deleteChannelMutationOptions(queryClient, true),
          )
            .mutate(channel.id)
            .catch(() => undefined);
          throw error;
        }
      }
      const latest = readPendingStart(owner, id);
      if (latest?.state === "finished") return latest;
      progress =
        latest?.state === "pending" && latest.progress.phase !== "creating"
          ? latest.progress
          : { phase: "ready", channelId: channel.id };
      save({ state: "pending", draft, progress });
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
    }
    const channelId = progress.channelId;
    if (!group) return { state: "pending", draft, progress };

    if (progress.phase === "submitted") {
      const current = await queryClient.fetchQuery({
        ...groupQueryOptions(channelId),
        staleTime: 0,
      });
      if (current?.messages.some((message) => message.id === id)) {
        finishPendingStart(owner, id, channelId, true);
        return { state: "finished", channelId, group: true };
      }
    } else {
      save({
        state: "pending",
        draft,
        progress: { phase: "submitted", channelId },
      });
    }
    await new MutationObserver(
      queryClient,
      sendGroupMessageMutationOptions(queryClient, channelId),
    ).mutate({ id, text: draft.text, agentId: target.addressedAgentId });
    finishPendingStart(owner, id, channelId, true);
    return { state: "finished", channelId, group: true };
  };

  // Web Locks serialize the stored handoff across tabs even while a routing request is in flight.
  const run = (async () =>
    navigator.locks
      ? navigator.locks.request(`openbot:start:${key}`, work)
      : work())().finally(() => startsInProgress.delete(key));
  startsInProgress.set(key, run);
  return run;
}

export type FirstMessageRecovery = {
  action: "retry" | "check" | "resend" | "connect";
  message: string;
};

export function discardDirectFirstMessage(
  owner: string,
  id: string,
  channelId: string,
) {
  finishPendingStart(owner, id, channelId, false);
}

/** Continue a direct start once its live Thread can send the first message. */
export async function resumeDirectFirstMessage({
  queryClient,
  owner,
  id,
  channelId,
  resend,
  isCurrent,
  readHistory,
  onDelivered,
  send,
}: {
  queryClient: QueryClient;
  owner: string;
  id: string;
  channelId: string;
  resend: boolean;
  isCurrent: () => boolean;
  readHistory: () => Promise<StoredThread>;
  onDelivered: (history: StoredThread) => void;
  send: (
    text: string,
    attachments: Attachment[],
    beforeSend: () => Promise<void>,
  ) => Promise<void>;
}): Promise<"finished" | "inactive" | FirstMessageRecovery> {
  if (!isCurrent()) return "inactive";
  const start = readPendingStart(owner, id);
  if (!start || start.state === "finished") return "finished";
  if (
    start.draft.recipient.kind !== "direct" ||
    start.progress.phase === "creating" ||
    start.progress.channelId !== channelId
  )
    return "inactive";

  const verify = async (): Promise<
    "finished" | "inactive" | FirstMessageRecovery
  > => {
    const history = await readHistory();
    if (!isCurrent()) return "inactive";
    if (
      history.availability === "ready" &&
      history.messages.some(
        (message) => message.id === id && message.role === "user",
      )
    ) {
      onDelivered(history);
      finishPendingStart(owner, id, channelId, false);
      return "finished";
    }
    const historyChecked =
      history.availability === "ready" && history.unreadable === 0;
    const canResend =
      historyChecked &&
      start.draft.attachments.length === 0 &&
      start.draft.text.trim().length > 0 &&
      (await queryClient
        .fetchQuery({
          ...deploymentCapabilitiesQueryOptions(),
          staleTime: 0,
          retry: false,
        })
        .then((capabilities) => capabilities.directMessageReplay === true)
        .catch(() => false));
    if (!isCurrent()) return "inactive";
    return {
      action: canResend ? "resend" : "check",
      message: canResend
        ? "The message hasn’t appeared in this conversation. Resending uses the original message so it appears only once."
        : !historyChecked
          ? "The full conversation couldn’t load. Check for the message again to see whether it arrived."
          : "Check this conversation again before sending another copy. Your browser has saved the message.",
    };
  };

  const replaying = start.progress.phase === "submitted";
  if (replaying) {
    const result = await verify();
    if (!resend || typeof result === "string" || result.action !== "resend")
      return result;
  }
  let submitted = replaying;
  try {
    await send(
      start.draft.text,
      restorePendingAttachments(start.draft),
      async () => {
        if (!isCurrent()) throw new Error("The conversation was closed.");
        const latest = readPendingStart(owner, id);
        if (
          latest?.state === "pending" &&
          latest.progress.phase !== "creating" &&
          latest.progress.channelId === channelId &&
          (replaying
            ? latest.progress.phase === "submitted"
            : latest.progress.phase === "ready")
        ) {
          if (replaying) return;
          const claimed = await claimFirstSend(owner, id);
          submitted = true;
          const beforeSend = readPendingStart(owner, id);
          if (
            beforeSend?.state === "pending" &&
            beforeSend.progress.phase === "ready" &&
            beforeSend.progress.channelId === channelId
          ) {
            savePendingStart(owner, id, {
              ...beforeSend,
              progress: { phase: "submitted", channelId },
            });
          }
          if (
            claimed &&
            beforeSend?.state === "pending" &&
            beforeSend.progress.phase !== "creating" &&
            beforeSend.progress.channelId === channelId &&
            isCurrent()
          )
            return;
        }
        submitted = true;
        throw new Error("The message is already being checked.");
      },
    );
    finishPendingStart(owner, id, channelId, false);
    return "finished";
  } catch {
    if (!isCurrent()) return "inactive";
    const latest = readPendingStart(owner, id);
    if (latest?.state === "finished") return "finished";
    if (submitted || latest?.progress.phase === "submitted") return verify();
    return {
      action: "retry",
      message:
        "Your browser has saved the message. You can try sending it now.",
    };
  }
}
