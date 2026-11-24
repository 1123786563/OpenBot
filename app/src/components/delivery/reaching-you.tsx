import { VStack } from "@astryxdesign/core/VStack";
import {
  IconBrandSlack,
  IconBrandTeams,
  IconChevronRight,
  IconDeviceMobileMessage,
  IconSend,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  ConnectionAction,
  ConnectionDialogContent,
} from "@/components/connections/connection-surface";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ChatLink,
  confirmSmsMutationOptions,
  deliveryKey,
  deliveryQueryOptions,
  type Reachability,
  removeDeliveryBindingMutationOptions,
  startChatLinkMutationOptions,
  startSmsMutationOptions,
} from "@/lib/delivery";
import { queryClient } from "@/query-client";

/**
 * The phone verification waiting for its code, kept for the tab.
 *
 * Only the challenge id lives in the page, and the text with the code arrives on the person's
 * phone a moment after they may have looked away: leaving and coming back used to drop the box to
 * type it into, with no way to confirm the code they had just been sent.
 */
const PENDING_SMS = "openbot.reachability.pendingSms";
function readPending(): string {
  try {
    return sessionStorage.getItem(PENDING_SMS) ?? "";
  } catch {
    return "";
  }
}
function writePending(id: string) {
  try {
    if (id) sessionStorage.setItem(PENDING_SMS, id);
    else sessionStorage.removeItem(PENDING_SMS);
  } catch {
    /* A browser that keeps nothing still confirms within the visit. */
  }
}

type Transport = Reachability["bindings"][number]["transport"];
type ChatPlatform = ChatLink["platform"];
const touchControl = { minBlockSize: "var(--spacing-11)" };

/** A one-time link message, the conversation and Bot it links, and when it stops working. */
type HeldLink = ChatLink & {
  channelId: string;
  conversationName: string;
  agentId: string;
  expiresAt: number;
};

const TRANSPORT: Record<
  Transport,
  { link: string; icon: typeof IconBrandSlack; summary: string }
> = {
  slack: {
    link: "Link Slack",
    icon: IconBrandSlack,
    summary: "Continue a conversation from Slack.",
  },
  teams: {
    link: "Link Microsoft Teams",
    icon: IconBrandTeams,
    summary: "Continue a conversation from Microsoft Teams.",
  },
  sms: {
    link: "Connect a phone",
    icon: IconDeviceMobileMessage,
    summary: "Continue a conversation by text message.",
  },
};

/**
 * Continuing a conversation in Slack, Microsoft Teams or by text message. Given a Bot, only that
 * Bot's conversations and destinations, and no Bot to pick.
 *
 * The destinations already connected are rows with a Disconnect each. Connecting one is a row per
 * transport that opens a dialog, because it is several inputs — a conversation, then an account or
 * a phone number — and the answer is a code to send back.
 */
export function ReachingYou({ agentId: fixedBot }: { agentId?: string }) {
  const reach = useQuery(deliveryQueryOptions());
  const deliveryCache = useQueryClient();
  const disconnect = useActionConfirmation();
  // People read Bots by name; the id is what the list used to show.
  const botName = useBotNames();
  const [challengeId, setChallengeId] = useState(readPending);
  useEffect(() => writePending(challengeId), [challengeId]);
  const [connecting, setConnecting] = useState<Transport | null>(null);
  /*
   * The last link message per platform, held here rather than in the dialog: the dialog unmounts
   * when it closes, and the code is only useful once it has been sent from Slack or Teams, which is
   * exactly when somebody closes it to go and do that. Dropped once it has expired.
   */
  const [links, setLinks] = useState<Partial<Record<ChatPlatform, HeldLink>>>(
    {},
  );
  const heldLink = (transport: Transport) => {
    if (transport === "sms") return undefined;
    const held = links[transport];
    return held &&
      held.expiresAt > Date.now() &&
      (fixedBot === undefined || held.agentId === fixedBot)
      ? held
      : undefined;
  };
  const remove = useMutation(
    removeDeliveryBindingMutationOptions(deliveryCache),
  );
  const destinations = reach.data?.bindings.filter(
    (binding) =>
      binding.enabled &&
      (fixedBot === undefined || binding.agentId === fixedBot),
  );
  /*
   * A transport the deployment cannot reach is a row that says why rather than one that opens a
   * dialog whose every button is disabled. A phone with a code already on its way stays reachable,
   * so the code can still be confirmed.
   */
  const open = (transport: Transport) =>
    !!reach.data?.available[transport] ||
    (transport === "sms" && challengeId !== "");
  const summary = (transport: Transport) => {
    if (transport === "sms" && challengeId) {
      return "A verification code is on its way. Enter it to finish.";
    }
    if (heldLink(transport)) {
      return "Your link code is ready to send. Open this to see it again.";
    }
    if (open(transport)) return TRANSPORT[transport].summary;
    return transport === "sms"
      ? "Text messages aren't set up yet. An admin has to turn them on first."
      : "Not set up yet. An admin has to turn on Slack and Teams first.";
  };

  return (
    <>
      {fixedBot === undefined ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Your devices, recent deliveries, and where each kind of update goes
          are in{" "}
          <Link
            className="underline underline-offset-4"
            to="/settings/notifications"
          >
            Settings → Notifications
          </Link>
          .
        </p>
      ) : null}
      <PageSection title="Connected destinations">
        {disconnect.confirmation}
        {reach.error ? (
          <ReadError
            message="Couldn’t load connected destinations"
            retry={() => reach.refetch()}
            retryBelow
            retrying={reach.isFetching}
          />
        ) : null}
        {reach.isPending ? (
          <ReadStatus
            kind="loading"
            message="Loading connected destinations…"
          />
        ) : !destinations ? null : destinations.length === 0 && !reach.error ? (
          <PageEmpty icon={IconSend} title="No destinations connected" />
        ) : (
          <PageRows>
            {destinations.map((binding, index) => {
              const Icon = TRANSPORT[binding.transport].icon;
              const destination =
                binding.transport === "slack"
                  ? "Slack"
                  : binding.transport === "teams"
                    ? "Microsoft Teams"
                    : binding.address;
              const bot = botName(binding.agentId) || "This Bot";
              const effect =
                binding.transport === "sms"
                  ? `${bot} will stop sending text messages to ${destination}.`
                  : `${bot} will stop sending messages to this ${destination} connection.`;
              return (
                <Fragment key={binding.id}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{destination}</ItemTitle>
                      <ItemDescription>
                        {botName(binding.agentId)}
                        {binding.optedOutAt
                          ? " · You texted STOP. Text START to resume."
                          : null}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <ConnectionAction
                        aria-label={`Disconnect ${destination}`}
                        className="confirmation-action"
                        onClick={({ currentTarget }) =>
                          disconnect.requestConfirmation({
                            title: `Disconnect ${destination}?`,
                            description: `${effect} You can connect it again from this page.`,
                            trigger: currentTarget,
                            confirmLabel: "Disconnect",
                            pendingLabel: "Disconnecting…",
                            failureMessage: `Couldn’t disconnect ${destination}. Try again.`,
                            successMessage: `${destination} disconnected.`,
                            run: async () => {
                              const current = deliveryCache
                                .getQueryData<Reachability>(deliveryKey)
                                ?.bindings.find(({ id }) => id === binding.id);
                              if (
                                !current?.enabled ||
                                current.agentId !== binding.agentId ||
                                current.channelId !== binding.channelId ||
                                current.address !== binding.address
                              ) {
                                throw new ActionUnavailable(
                                  "This connection changed. Close this dialog and review the destinations.",
                                );
                              }
                              await remove.mutateAsync(binding.id);
                            },
                          })
                        }
                        variant="outline"
                      >
                        Disconnect
                      </ConnectionAction>
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
      <PageSection
        description="In a Slack or Teams channel that others can read, the Bot replies to you in a direct message."
        title="Connect a conversation"
      >
        {reach.data ? (
          <PageRows>
            {(Object.keys(TRANSPORT) as Transport[]).map((transport, index) => {
              const Icon = TRANSPORT[transport].icon;
              const opens = open(transport);
              return (
                <Fragment key={transport}>
                  {index > 0 ? <Separator /> : null}
                  <Item
                    render={
                      opens ? (
                        <button
                          onClick={() => setConnecting(transport)}
                          type="button"
                        />
                      ) : undefined
                    }
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{TRANSPORT[transport].link}</ItemTitle>
                      <ItemDescription>{summary(transport)}</ItemDescription>
                    </ItemContent>
                    {opens ? (
                      <ItemActions>
                        <IconChevronRight className="size-4 text-muted-foreground" />
                      </ItemActions>
                    ) : null}
                  </Item>
                </Fragment>
              );
            })}
          </PageRows>
        ) : null}
      </PageSection>
      {connecting && reach.data ? (
        <ConnectDialog
          available={reach.data.available}
          botName={botName}
          challengeId={challengeId}
          fixedBot={fixedBot}
          linked={heldLink(connecting)}
          onChallenge={setChallengeId}
          onClose={() => setConnecting(null)}
          onLinked={(link) =>
            setLinks((prior) => ({ ...prior, [link.platform]: link }))
          }
          transport={connecting}
        />
      ) : null}
    </>
  );
}

/**
 * Choose the conversation, then link an account or verify a phone. Linking an account answers with a
 * one-time `link <code>` message to send to the OpenBot app; a phone answers with a text carrying a
 * code to type back here.
 */
function ConnectDialog({
  transport,
  available,
  fixedBot,
  botName,
  challengeId,
  linked,
  onChallenge,
  onLinked,
  onClose,
}: {
  transport: Transport;
  available: Reachability["available"];
  fixedBot: string | undefined;
  botName: (id: string) => string;
  challengeId: string;
  /** The link message this platform last answered with, while it still works. */
  linked: HeldLink | undefined;
  onChallenge: (id: string) => void;
  onLinked: (link: HeldLink) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // Reopened with a link message still held, the dialog shows the conversation it links.
  const [channelId, setChannelId] = useState(linked?.channelId ?? "");
  const [pickedBot, setAgentId] = useState(linked?.agentId ?? "");
  const agentId = fixedBot ?? pickedBot;
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const link = useMutation(startChatLinkMutationOptions());
  const sms = useMutation(startSmsMutationOptions());
  const confirm = useMutation(confirmSmsMutationOptions(queryClient));
  const conversations =
    channels.data?.filter(
      (channel) =>
        channel.active &&
        (fixedBot === undefined || channel.agentIds.includes(fixedBot)),
    ) ?? [];
  const selected = conversations.find((channel) => channel.id === channelId);
  const chosen = channels.isSuccess && selected?.agentIds.includes(agentId);
  const currentLink =
    linked?.channelId === channelId && linked.agentId === agentId
      ? linked
      : null;
  const error = channels.error ?? link.error ?? sms.error ?? confirm.error;

  function startLink(platform: ChatPlatform) {
    if (!selected || !chosen || !available[platform] || link.isPending) return;
    link.mutate(
      { channelId, agentId, platform },
      {
        onSuccess: (result) => {
          onLinked({
            ...result,
            channelId,
            conversationName: conversationLabel(selected),
            agentId,
            expiresAt: Date.now() + result.expiresInMinutes * 60_000,
          });
        },
      },
    );
  }
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <ConnectionDialogContent>
        <DialogHeader>
          <DialogTitle>{TRANSPORT[transport].link}</DialogTitle>
          <DialogDescription>
            Each account or phone number works with one conversation at a time.
            Linking it here moves it from the one it's linked to now.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor={`${formId}-conversation`}>
              Conversation
            </FieldLabel>
            <Select
              items={Object.fromEntries(
                conversations.map((channel) => [
                  channel.id,
                  conversationLabel(channel),
                ]),
              )}
              onValueChange={(next) => {
                setChannelId(typeof next === "string" ? next : "");
                if (fixedBot === undefined) setAgentId("");
              }}
              value={channelId || null}
            >
              <SelectTrigger
                className="w-full"
                id={`${formId}-conversation`}
                style={touchControl}
              >
                <SelectValue placeholder="Choose a conversation" />
              </SelectTrigger>
              <SelectContent>
                {conversations.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {conversationLabel(channel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {fixedBot === undefined ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-bot`}>Bot</FieldLabel>
              <Select
                items={Object.fromEntries(
                  (selected?.agentIds ?? []).map((id) => [id, botName(id)]),
                )}
                onValueChange={(next) =>
                  setAgentId(typeof next === "string" ? next : "")
                }
                value={pickedBot || null}
              >
                <SelectTrigger
                  className="w-full"
                  id={`${formId}-bot`}
                  style={touchControl}
                >
                  <SelectValue placeholder="Choose a Bot" />
                </SelectTrigger>
                <SelectContent>
                  {selected?.agentIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {botName(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {channels.hasNextPage ? (
            <ConnectionAction
              className="justify-self-start"
              onClick={() => channels.fetchNextPage()}
              variant="outline"
            >
              Load more conversations
            </ConnectionAction>
          ) : null}
          {transport === "sms" ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!chosen || !available.sms || sms.isPending) return;
                  sms.mutate(
                    { channelId, agentId, phone },
                    { onSuccess: onChallenge },
                  );
                }}
              >
                <Field>
                  <FieldLabel htmlFor={`${formId}-phone`}>
                    Phone number
                  </FieldLabel>
                  <VStack align="stretch" gap={2}>
                    <Input
                      id={`${formId}-phone`}
                      onChange={(event) => setPhone(event.target.value)}
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+15551234567"
                      required
                      style={touchControl}
                      type="tel"
                      value={phone}
                    />
                    <ConnectionAction
                      className="self-start"
                      disabled={!chosen || !available.sms || sms.isPending}
                      type="submit"
                      variant={challengeId ? "outline" : "default"}
                    >
                      Send verification code
                    </ConnectionAction>
                  </VStack>
                </Field>
              </form>
              {challengeId ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    confirm.mutate(
                      { challengeId, code },
                      {
                        onSuccess: () => {
                          onChallenge("");
                          setCode("");
                          onClose();
                        },
                      },
                    );
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor={`${formId}-code`}>
                      Verification code
                    </FieldLabel>
                    <VStack align="stretch" gap={2}>
                      <Input
                        autoComplete="one-time-code"
                        id={`${formId}-code`}
                        onChange={(event) => setCode(event.target.value)}
                        required
                        style={touchControl}
                        value={code}
                      />
                      <ConnectionAction
                        className="self-start"
                        disabled={confirm.isPending}
                        type="submit"
                      >
                        Confirm phone
                      </ConnectionAction>
                    </VStack>
                  </Field>
                </form>
              ) : null}
            </>
          ) : currentLink ? (
            <LinkCommand key={currentLink.code} link={currentLink} />
          ) : null}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <ConnectionAction onClick={onClose} variant="outline">
            Close
          </ConnectionAction>
          {/* A phone's two steps each submit their own field, beside it. */}
          {transport === "sms" ? null : (
            <ConnectionAction
              disabled={!chosen || !available[transport] || link.isPending}
              onClick={() => startLink(transport)}
            >
              {TRANSPORT[transport].link}
            </ConnectionAction>
          )}
        </DialogFooter>
      </ConnectionDialogContent>
    </Dialog>
  );
}

function LinkCommand({ link }: { link: HeldLink }) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState("");
  return (
    <Field>
      <p style={{ overflowWrap: "anywhere" }}>
        Send this command to the OpenBot app in a direct message in{" "}
        {link.platform === "teams" ? "Microsoft Teams" : "Slack"} within{" "}
        {Math.ceil((link.expiresAt - Date.now()) / 60_000)} minutes. It links
        the account to “{link.conversationName}”.
      </p>
      <FieldLabel htmlFor={id}>Link command</FieldLabel>
      <Input
        id={id}
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        ref={field}
        style={touchControl}
        value={link.command}
      />
      <ConnectionAction
        className="self-start"
        onClick={async (event) => {
          const trigger = event.currentTarget;
          try {
            if (navigator.clipboard) {
              await navigator.clipboard.writeText(link.command);
              setFeedback("Link command copied.");
              return;
            }
          } catch {
            // The field remains available when the browser declines clipboard access.
          }
          setFeedback("Select and copy the link command.");
          if (document.activeElement === trigger) field.current?.focus();
        }}
        variant="outline"
      >
        Copy
      </ConnectionAction>
      {feedback ? <p role="status">{feedback}</p> : null}
    </Field>
  );
}
