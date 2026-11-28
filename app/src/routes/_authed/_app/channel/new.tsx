import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  canSend,
  type Recipient,
  startsGroup,
  toFieldChange,
} from "@/components/channels/compose-state";
import {
  Composer,
  type ComposerDraft,
  toAgentOptions,
} from "@/components/channels/composer";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { PageHeader } from "@/components/layout/page-parts";
import { ReadStatus } from "@/components/layout/read-status";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { attachmentUrl } from "@/lib/channels/attachments";
import {
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { readPendingFile } from "@/lib/channels/pending-files";
import { readPendingStart } from "@/lib/channels/pending-start";
import { useSubmitConversationStart } from "@/lib/channels/start";
import { ClientError, client } from "@/lib/client";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { useDraftModel } from "@/lib/models/run-model";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { searchTextEntry } from "@/lib/search-text";
import { newId } from "../../../../lib/new-id";

/**
 * Creates the conversation on first send. One Bot in the To: field is an ordinary channel; two or
 * more are a group, answering in the order they were picked. The first Bot stays in the URL so
 * profile links and reloads preserve the pending recipient without creating an empty channel.
 */
/** What `GET /api/agents/:id` answers for a Bot this person cannot see. */
const AGENT_NOT_FOUND = "Couldn't find that Bot.";
const recipientIds = z.array(z.string());

export const Route = createFileRoute("/_authed/_app/channel/new")({
  /*
   * The pending recipient's id, read as text whatever the router parsed it into (`searchText`):
   * search values are JSON-parsed, so a Bot id made of digits would otherwise arrive as a number
   * and the link would open an empty composer instead of the one it names.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; new?: true } => ({
    ...searchTextEntry("agent", search.agent),
    ...(search.new === true ? { new: true } : {}),
  }),
  /*
   * Which new conversation this is. Every arrival here that this page did not make itself is a
   * fresh one: the + button (pressed once or many times), a Bot's profile link, Back to an earlier
   * draft. Each is given its own id here, in history state. The page's own navigations (a Bot
   * picked or removed, a Bot made from the picker) carry the id forward, so they keep the draft
   * they belong to.
   *
   * WHY NOT JUST THE URL: the picked Bots and the typed message live in this page, not the URL, and
   * a second visit to the same route does not remount it. Pressing + while a Bot was already picked
   * dropped `?agent=` from the URL but left the Bot in To: and the message in the box, so the screen
   * and the URL disagreed and a reload changed who the message would go to.
   *
   * WHY NOT THE HISTORY ENTRY'S OWN KEY: the router makes no history entry for a navigation to the
   * location it is already on. A second press of + on an untouched new conversation was exactly
   * that, so nothing remounted, and the first press had already closed the To: picker as a click
   * outside it and left focus on +. An arrival without an id is now always a different location
   * from one with an id, so every press is a new entry and a fresh page.
   *
   * WHY CONTEXT AND NOT THE LOCATION: the router publishes a new location before the route's search
   * catches up, so a page keyed on the location remounted once with the new key and the old
   * `?agent=`, and handed the caret to the composer. Context commits with the search.
   */
  beforeLoad: ({ location }) => {
    const composition = location.state.newConversation;
    if (!composition) {
      throw redirect({
        replace: true,
        search: location.search,
        state: ownedBy(newId()),
        to: "/channel/new",
      });
    }
    return {
      composition,
      copiedFromHome: location.state.copiedFromHome,
      copiedFromStart: location.state.copiedFromStart,
      copiedStartId: location.state.copiedStartId,
    };
  },
  component: RouteComponent,
});

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set by `/channel/new` on its own navigations: which new conversation they belong to. */
    newConversation?: string;
    copiedFromHome?: true;
    /** Set when a refused `/start/$startId` hands its text over as a copy. */
    copiedFromStart?: true;
    /** Owner-scoped start to copy attachments from, when the person asks. */
    copiedStartId?: string;
  }
}

/** History state marking a navigation as this page's own. */
function ownedBy(composition: string) {
  return { newConversation: composition };
}

function RouteComponent() {
  const { composition, copiedFromHome, copiedFromStart, copiedStartId } =
    Route.useRouteContext();
  const { data: user } = useQuery(currentUserQueryOptions());
  const owner = user?.id;
  return (
    <NewConversation
      composition={composition}
      copiedFromHome={copiedFromHome}
      copiedFromStart={copiedFromStart}
      copiedStartId={copiedStartId}
      owner={owner}
      key={JSON.stringify([owner, composition])}
    />
  );
}

function NewConversation({
  composition,
  copiedFromHome,
  copiedFromStart,
  copiedStartId,
  owner,
}: {
  composition: string;
  copiedFromHome: true | undefined;
  copiedFromStart: true | undefined;
  copiedStartId: string | undefined;
  owner: string | undefined;
}) {
  // The page's own navigations keep the original start available when choosing a Bot.
  const historyState = {
    ...ownedBy(composition),
    copiedFromHome,
    copiedFromStart,
    copiedStartId,
  };
  const { agent: urlAgent, new: creatingBot } = Route.useSearch();
  const original =
    owner && copiedStartId ? readPendingStart(owner, copiedStartId) : null;
  const originalFiles =
    original?.state === "pending" ? original.draft.attachments : [];
  async function loadOriginalFiles() {
    const source =
      owner && copiedStartId ? readPendingStart(owner, copiedStartId) : null;
    if (source?.state !== "pending") {
      throw new Error("The original message is no longer available.");
    }
    return Promise.all(
      source.draft.attachments.map(async (reference) => {
        if ("localFileKey" in reference)
          return readPendingFile(reference.localFileKey);
        const response = await client(attachmentUrl(reference.attachmentId), {
          fallback: `Couldn't read ${reference.name} from the original message.`,
        });
        const blob = await response.blob();
        return new File([blob], reference.name, {
          type: reference.mimeType ?? blob.type,
        });
      }),
    );
  }
  const messageKey = composeDraftKey(owner, composition, "message");
  const recipientsKey = composeDraftKey(owner, composition, "recipients");
  const modelKey = composeDraftKey(owner, composition, "model");
  const [savedRecipients] = useState(() =>
    readComposeDraft(recipientsKey, recipientIds),
  );
  const [picked, setPicked] = useState<AgentProfile[] | null>(null);
  const agent =
    picked === null && savedRecipients ? savedRecipients[0] : urlAgent;
  const chooseRecipients = (next: AgentProfile[]) => {
    setPicked(next);
    writeComposeDraft(
      recipientsKey,
      next.map(({ id }) => id),
    );
  };
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState<boolean | undefined>(undefined);
  const [recipientFilter, setRecipientFilter] = useState("");
  const [focusMessageAfterPick, setFocusMessageAfterPick] = useState(false);
  const navigate = Route.useNavigate();
  const closeBotCreation = () =>
    void navigate({
      replace: true,
      resetScroll: false,
      search: (previous) => ({ ...previous, new: undefined }),
      state: historyState,
    });
  const { submit: submitStart, error: saveError } =
    useSubmitConversationStart(owner);
  const roster = useQuery(agentListQueryOptions());
  const profiles = roster.data;

  const [error, setError] = useState<string | null>(null);
  /** Enter or Send was pressed with nobody in To:. Said until a Bot is chosen. */
  const [askedForBot, setAskedForBot] = useState(false);
  const pickerInput = useRef<HTMLInputElement>(null);
  const newBotButton = useRef<HTMLButtonElement>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const detail = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const {
    data: fetched,
    isError: detailError,
    error: detailFailure,
    isPending: detailPending,
  } = detail;
  /*
   * The URL names a recipient up front (a Bot's own Message link). Without one, To: starts empty
   * with the Bot menu open, in either edition and however many Bots there are: + is a question,
   * who is this for, and the menu is the answer to pick from. A Bot picked on the person's behalf
   * was one they had to notice and remove.
   *
   * FOUND ON WINDOWS: a message typed with nobody in To: once went nowhere. The open menu says
   * from the start that a Bot is needed, and Send with nobody picked says "Choose a Bot first."
   * and opens it again, keeping the message.
   */
  const chosen = listed ?? (fetched?.id === agent ? fetched : undefined);
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const rosterFailed = roster.isError && profiles === undefined;
  const rosterDenied =
    rosterFailed &&
    roster.error instanceof ClientError &&
    roster.error.status === 403;
  const recipientUnavailable =
    urlAgentDetailFailed &&
    (detailFailure?.message === AGENT_NOT_FOUND ||
      (detailFailure instanceof ClientError &&
        [403, 404].includes(detailFailure.status)));
  const loadError = rosterDenied
    ? "You don’t have access to the Bots in this workspace. Ask a workspace administrator for access."
    : rosterFailed
      ? "Couldn’t load your Bots."
      : recipientUnavailable
        ? "This Bot isn’t available to you. Choose another Bot to continue."
        : urlAgentDetailFailed
          ? "Couldn’t load that Bot."
          : null;
  const loading = roster.isPending || waitingForUrlAgent;
  const restored = savedRecipients?.flatMap((id) => {
    const profile =
      id === chosen?.id ? chosen : profiles?.find((bot) => bot.id === id);
    return profile ? [profile] : [];
  });
  const selected = picked ?? restored ?? (chosen ? [chosen] : []);
  const availableRecipients =
    profiles?.filter(
      (profile) => !selected.some(({ id }) => id === profile.id),
    ) ?? [];
  const missingSavedRecipient =
    !loading &&
    !loadError &&
    picked === null &&
    savedRecipients !== undefined &&
    selected.length < savedRecipients.length;
  const recipients: Recipient[] = selected.map((profile) => ({
    id: profile.id,
    name: profile.name,
  }));
  const group = startsGroup(recipients);
  const missingRecipient = askedForBot && recipients.length === 0;
  const emptyRoster =
    profiles?.length === 0 && selected.length === 0 && !loading && !loadError;
  const pickerVisible =
    Boolean(profiles) &&
    !emptyRoster &&
    !loading &&
    !loadError &&
    (pickerOpen ?? !chosen);
  useEffect(() => {
    if (pickerVisible && selected.length === 0) pickerInput.current?.focus();
  }, [pickerVisible, selected.length]);
  /*
   * A model can be picked before the first message when the conversation is with one Bot that runs
   * on OpenBot's own model. The pick is saved with the conversation, before the message runs.
   */
  const pickable =
    !group && selected.length === 1 && selected[0]?.runsOnOpenBotModel === true;
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: pickable,
  });
  const draftModel = useDraftModel(
    pickable ? models.data : undefined,
    modelKey,
  );
  // A group's first message goes to all of its Bots, so no one Bot's commands are offered.
  const skillCommands = useSkillCommands(
    group ? "" : (recipients[0]?.id ?? ""),
  );

  const submit = async (draft: ComposerDraft, fromComposer = false) => {
    const recipient = recipients[0];
    if (
      loading ||
      loadError ||
      missingSavedRecipient ||
      !recipient ||
      (!canSend(recipients, draft.text) &&
        (group || draft.attachments.length === 0))
    )
      return;
    setError(null);
    await submitStart(
      draft,
      group
        ? {
            kind: "group",
            agentIds: recipients.map(({ id }) => id),
            addressedAgentId: draft.agentId,
          }
        : { kind: "direct", agentId: recipient.id },
      group ? null : draftModel.requested,
      fromComposer
        ? () => {
            writeComposeDraft(messageKey);
            writeComposeDraft(recipientsKey);
            writeComposeDraft(modelKey);
          }
        : undefined,
    );
  };

  return (
    <VStack
      gap={4}
      maxWidth="48rem"
      width="100%"
      isScrollable
      className="mx-auto min-h-0 px-4 pt-8 pb-6"
    >
      <PageHeader title="New conversation" />
      <VStack gap={2} data-slot="conversation-header">
        <HStack align="center" justify="between">
          <label
            className="text-sm font-medium"
            htmlFor="conversation-recipients"
          >
            To
          </label>
          {profiles && !loading && !loadError ? (
            <Button
              label="New Bot"
              size="sm"
              variant="ghost"
              className="max-md:min-h-11 pointer-coarse:min-h-11"
              ref={newBotButton}
              onClick={() => {
                setPickerOpen(false);
                void navigate({
                  replace: true,
                  resetScroll: false,
                  search: (previous) => ({ ...previous, new: true }),
                  state: historyState,
                });
              }}
            />
          ) : null}
        </HStack>
        <Combobox
          // Do not auto-open when a recipient is already chosen; the field is already answered.
          open={pickerVisible}
          disabled={!profiles || emptyRoster || loading || Boolean(loadError)}
          onOpenChange={(open, details) => {
            if (!open && details.reason === "item-press") {
              details.cancel();
              return;
            }
            setPickerOpen(open);
          }}
          inputValue={recipientFilter}
          onInputValueChange={(value, details) => {
            setRecipientFilter(value);
            if (details.reason === "input-change") setPickerOpen(true);
          }}
          autoHighlight
          inline={pickerVisible}
          multiple
          items={availableRecipients}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next: AgentProfile[], details) => {
            const kept = toFieldChange(selected, next, details.reason);
            chooseRecipients(kept);
            setAskedForBot(false);
            if (details.reason === "item-press") {
              setPickerOpen(!askedForBot);
              setFocusMessageAfterPick(askedForBot);
              setRecipientFilter("");
              if (!askedForBot) pickerInput.current?.focus();
            }
            // The first Bot stays in the URL so a reload keeps the conversation's recipient; the
            // group order is restored from the current tab's draft.
            void navigate({
              replace: true,
              search: kept[0] ? { agent: kept[0].id } : {},
              state: historyState,
            });
          }}
          value={selected}
        >
          <ComboboxChips className="min-h-10">
            {selected.map((profile) => (
              <ComboboxChip
                className="h-auto min-h-7 max-w-full min-w-0 justify-start gap-1.5 pl-1 whitespace-normal"
                key={profile.id}
                removeLabel={`Remove ${profile.name}`}
              >
                <ChannelAvatar participantIds={[profile.id]} size={16} />
                <strong className="min-w-0 break-all font-medium">
                  {profile.name}
                </strong>
              </ComboboxChip>
            ))}
            <ComboboxChipsInput
              id="conversation-recipients"
              ref={pickerInput}
              onKeyDown={(event) => {
                if (event.key === "Escape" && pickerVisible) {
                  event.preventDefault();
                  event.stopPropagation();
                  setPickerOpen(false);
                }
              }}
              className="placeholder:text-foreground/75"
              placeholder={selected.length ? "Add Bot" : "Choose a Bot…"}
            />
          </ComboboxChips>
          {pickerVisible ? (
            <VStack
              style={{
                border: "thin solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                minWidth: 0,
              }}
            >
              {missingRecipient ? (
                <HStack paddingInline={3} paddingBlock={2}>
                  <p className="text-sm" role="status">
                    Choose a Bot first.
                  </p>
                </HStack>
              ) : null}
              <ComboboxList style={{ maxHeight: "calc(6 * var(--spacing-8))" }}>
                {(item: AgentProfile) => (
                  <ComboboxItem key={item.id} value={item} className="min-h-10">
                    <ChannelAvatar participantIds={[item.id]} size={24} />
                    <VStack gap={0} style={{ minWidth: 0 }}>
                      <strong className="truncate font-medium">
                        {item.name}
                      </strong>
                      {item.title ? (
                        <small className="truncate text-sm text-muted-foreground">
                          {item.title}
                        </small>
                      ) : null}
                    </VStack>
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty style={{ display: "block", padding: 0 }}>
                <p style={{ paddingBlock: "var(--spacing-2)" }}>
                  {availableRecipients.length === 0
                    ? "All available Bots are already in To."
                    : "No Bots match your search."}
                </p>
              </ComboboxEmpty>
            </VStack>
          ) : null}
        </Combobox>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {waitingForUrlAgent
              ? "Loading the selected Bot…"
              : "Loading your Bots…"}
          </p>
        ) : null}
        {loadError ? (
          <VStack gap={2} align="start">
            {rosterDenied || recipientUnavailable ? (
              <p className="text-sm text-destructive" role="alert">
                {loadError}
              </p>
            ) : (
              <ReadStatus
                kind="error"
                message={loadError}
                retry={() =>
                  rosterFailed ? roster.refetch() : detail.refetch()
                }
              />
            )}
            {urlAgentDetailFailed && (
              <Button
                label="Choose another Bot"
                size="sm"
                onClick={() => {
                  chooseRecipients([]);
                  setPickerOpen(true);
                  void navigate({
                    replace: true,
                    search: {},
                    state: historyState,
                  }).then(() => pickerInput.current?.focus());
                }}
              />
            )}
          </VStack>
        ) : missingSavedRecipient ? (
          <VStack gap={2}>
            <p className="text-sm" role="alert">
              A Bot in your draft is no longer available. Review the recipients
              before sending.
            </p>
            <Button
              label="Review recipients"
              size="sm"
              onClick={() => {
                chooseRecipients(selected);
                setPickerOpen(true);
                void navigate({
                  replace: true,
                  search: selected[0] ? { agent: selected[0].id } : {},
                  state: historyState,
                }).then(() => pickerInput.current?.focus());
              }}
            />
          </VStack>
        ) : emptyRoster ? (
          <p className="text-sm text-muted-foreground">
            No Bots are available. Create a Bot to send your message.
          </p>
        ) : group ? (
          <p className="text-sm text-muted-foreground">
            Bots reply in the order you add them.
          </p>
        ) : !loading &&
          !copiedFromHome &&
          !missingRecipient &&
          recipients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Choose a Bot to send your message.
          </p>
        ) : null}
      </VStack>
      <NewBotSheet
        finalFocus={() =>
          emptyRoster ? newBotButton.current : pickerInput.current
        }
        leavesDraft={({ next }) =>
          next.pathname !== "/channel/new" || next.search.new !== true
        }
        open={creatingBot === true}
        onClose={closeBotCreation}
        onCreated={(agentId) => {
          closeBotCreation();
          void queryClient
            .fetchQuery(agentQueryOptions(agentId))
            .then((profile) => {
              if (!selected.some((bot) => bot.id === profile.id))
                chooseRecipients([...selected, profile]);
              if (selected.length === 0)
                void navigate({
                  replace: true,
                  search: { agent: agentId },
                  state: historyState,
                });
            })
            .catch(() => {
              setError(
                "Your Bot was created, but could not be selected. Choose it from the recipient list.",
              );
            });
        }}
      />
      <section
        aria-labelledby="new-message-heading"
        data-slot="composer-column"
        onFocus={(event) => {
          if (event.target.isContentEditable) setPickerOpen(false);
        }}
      >
        <VStack gap={2}>
          <h2 id="new-message-heading" className="text-sm font-medium">
            Message
          </h2>
          {error || saveError ? (
            <p className="text-sm text-destructive" role="alert">
              {error ?? saveError}
            </p>
          ) : missingRecipient && !pickerVisible && !emptyRoster ? (
            <p className="text-sm text-muted-foreground" role="status">
              Choose a Bot first.
            </p>
          ) : null}
          {pickable && models.isError && !models.data ? (
            <p className="text-sm text-muted-foreground" role="status">
              Model choices couldn’t load. This conversation will use the
              default model.
            </p>
          ) : null}
          {group && originalFiles.length > 0 ? (
            <Text as="p" color="secondary" size="sm">
              Choose one Bot to add the original attachments.
            </Text>
          ) : null}
          <Composer
            allowFirstMessageAttachments={!group}
            originalFiles={
              originalFiles.length > 0
                ? {
                    names: originalFiles.map(({ name }) => name),
                    load: loadOriginalFiles,
                  }
                : undefined
            }
            draftStorageKey={messageKey}
            restoredDraftMessage={
              copiedFromStart
                ? "Your original message stays saved. Review who will receive this copy in To."
                : copiedFromHome
                  ? "Original draft kept on Home. Review who will receive this copy in To."
                  : undefined
            }
            agents={toAgentOptions(selected)}
            autoFocus={
              recipients.length > 0 &&
              (picked === null || focusMessageAfterPick)
            }
            commands={skillCommands}
            compact
            modelPicker={
              <ModelPicker
                catalogue={pickable ? models.data : undefined}
                onChange={draftModel.choose}
                value={draftModel.value}
              />
            }
            disabled={Boolean(loadError) || loading || missingSavedRecipient}
            {...(recipients.length === 0
              ? {
                  heldSendLabel: emptyRoster
                    ? "Create a Bot first"
                    : "Choose a Bot to send",
                  onSendHeld: () => {
                    if (emptyRoster) {
                      newBotButton.current?.focus();
                      return;
                    }
                    setAskedForBot(true);
                    setPickerOpen(true);
                    pickerInput.current?.focus();
                  },
                }
              : {})}
            onSubmit={(draft) => submit(draft, true)}
          />
          {!group && recipients.length > 0 ? (
            <StarterSuggestions
              agentId={recipients[0]?.id}
              disabled={Boolean(loadError) || loading || missingSavedRecipient}
              onSelect={(text) =>
                submit({
                  text,
                  commandIds: [],
                  attachments: [],
                  agentId: recipients[0]?.id ?? null,
                  isEmpty: false,
                })
              }
            />
          ) : null}
        </VStack>
      </section>
    </VStack>
  );
}
