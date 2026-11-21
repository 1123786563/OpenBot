import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { ComposerDraft } from "@/components/channels/composer";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
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
  finishPendingStart,
  pendingAttachmentRefs,
  readPendingStart,
  savePendingStart,
  type StartRecipient,
  type StartRecord,
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

/**
 * Start a group from a just-submitted first message: create it with the Bots in the order they were
 * picked, give it the message, then open it. Pure so the order can be tested; nothing is sent or
 * opened when the group could not be made.
 *
 * A group exists to hold that first message, so one whose message did not send is discarded rather
 * than left in everybody's roster as an empty conversation. The send's own error is what the caller
 * sees (the composer keeps the draft for another try); a failed discard is swallowed, because the
 * person's problem is the message, and an empty group is the lesser leftover.
 */
export async function startGroupWith(input: {
  agentIds: string[];
  text: string;
  create: (agentIds: string[]) => Promise<{ id: string }>;
  send: (channelId: string, text: string) => Promise<void>;
  discard: (channelId: string) => Promise<void>;
  open: (channelId: string) => Promise<void>;
}): Promise<void> {
  const group = await input.create(input.agentIds);
  try {
    await input.send(group.id, input.text);
  } catch (error) {
    await input.discard(group.id).catch(() => undefined);
    throw error;
  }
  await input.open(group.id);
}

/**
 * Create a conversation, save the model and thinking effort picked for it, then open it with its
 * first message.
 *
 * The pick is saved before the conversation opens, because opening it is what sends the first
 * message, and that message must not run on a model or effort other than the one picked. A pick
 * that cannot be saved discards the conversation, which exists only to hold that message, and the
 * save's own error is what the caller sees, so the composer keeps the draft. Pure so the order can
 * be tested.
 */
export async function startWithModel(input: {
  /** Null, or both halves null, when everything is the default and nothing needs saving. */
  pick: ConversationModel | null;
  create: () => Promise<{ id: string }>;
  save: (channelId: string, pick: ConversationModel) => Promise<unknown>;
  discard: (channelId: string) => Promise<void>;
  open: (channelId: string) => Promise<void>;
}): Promise<void> {
  const channel = await input.create();
  const { pick } = input;
  if (pick && (pick.model !== null || pick.effort !== null)) {
    try {
      await input.save(channel.id, pick);
    } catch (error) {
      await input.discard(channel.id).catch(() => undefined);
      throw error;
    }
  }
  await input.open(channel.id);
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
      if (!group) stashFirstMessage(channel.id, draft.text);
    }
    const channelId = progress.channelId;
    if (!group) return { state: "pending", draft, progress };

    if (progress.phase === "submitted") {
      const current = await queryClient.fetchQuery({
        ...groupQueryOptions(channelId),
        staleTime: 0,
      });
      if (current.messages.some((message) => message.id === id)) {
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
