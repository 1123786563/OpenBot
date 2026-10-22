import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  canSend,
  type Recipient,
  startsGroup,
  toFieldChange,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { Combobox } from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the conversation on first send. One Bot in the To: field is an ordinary channel; two or
 * more are a group, answering in the order they were picked. The first Bot stays in the URL so
 * profile links and reloads preserve the pending recipient without creating an empty channel.
 */
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Agent not found.";

export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation("channels");
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { startChosen, startGroup, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    error: detailFailure,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const chosen =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? t("channelNew.rosterError")
      : urlAgentDetailFailed
        ? /*
           * The server's 404 sentence (agents/routes.ts `mapStoreError`) means this person cannot see
           * the Bot: a shared Team Bot link lands here once it is unpublished or undescribed. Any
           * other failure is a load that can be retried, and says so.
           */
          detailFailure?.message === AGENT_NOT_FOUND
          ? t("channelNew.notAvailable")
          : t("channelNew.detailError")
        : null;
  /** Bots picked in the To: field, in the order they will answer; the URL's Bot until one is picked. */
  const [picked, setPicked] = useState<AgentProfile[] | null>(null);
  const selected = picked ?? (chosen ? [chosen] : []);
  const roster = profiles ?? [];
  const recipients: Recipient[] = selected.map((profile) => ({
    id: profile.id,
    name: profile.name,
  }));
  const group = startsGroup(recipients);
  // A group's first message goes to all of its Bots, so no one Bot's commands are offered.
  const skillCommands = useSkillCommands(
    group ? "" : (recipients[0]?.id ?? ""),
  );

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">
          {t("recipient.to")}
        </span>
        {/* React Aria combobox adapter (multi-select). ESC only dismisses the list — it never
         * clears the selection, so the old Base UI reason:"escape-key" guard simply never fires. */}
        <Combobox
          className="flex-1"
          items={roster}
          getKey={(profile) => profile.id}
          itemLabel={(profile) => profile.name}
          itemSecondary={(profile) => (
            <span className="truncate text-muted-foreground ml-1">{profile.title}</span>
          )}
          chipMedia={(profile) => <ChannelAvatar participantIds={[profile.id]} size={16} />}
          selected={selected}
          onSelectedChange={(ids) => {
            const idSet = new Set(ids);
            const next = roster.filter((profile) => idSet.has(profile.id));
            const ordered = ids
              .map((id) => next.find((profile) => profile.id === id))
              .filter((profile): profile is AgentProfile => profile !== undefined);
            // toFieldChange caps the tail (kept above the pick-order synthesis) and keeps the
            // escape branch documented in compose-state; RAC never produces that reason.
            const kept = toFieldChange(selected, ordered, "select");
            setPicked(kept);
            // The first Bot stays in the URL so a reload keeps the conversation's recipient.
            void navigate({
              replace: true,
              search: kept[0] ? { agent: kept[0].id } : {},
            });
          }}
          emptyText="No Bots found."
          placeholder={
            selected.length ? "Add another Bot for a group…" : "Choose a Bot…"
          }
          defaultOpen={!chosen && !loadError && !waitingForUrlAgent}
        />
      </div>
      <ConversationView
        // Choosing a coworker answers the "To:" field, so the message is what remains: the caret
        // lands in the composer the moment a recipient exists, whether picked here or in the URL.
        autoFocus
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;
          if (group) {
            setError(null);
            try {
              await startGroup(
                recipients.map((entry) => entry.id),
                draft.text,
              );
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start the group.",
              );
              throw caught;
            }
            return;
          }

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // Recorded, then started: a coworker picked here is as much a choice as an `@` on the
            // home screen, and the trail has to say so for both.
            await startChosen(recipient.id, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error ? caught.message : t("new.startError"),
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
