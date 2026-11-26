import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { InlineEmpty } from "@/components/layout/page-parts";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { useTranslation } from "@/i18n";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { canKeepCachedRead } from "@/lib/client";
import {
  changeProactiveSettingMutationOptions,
  createProactiveSettingMutationOptions,
  type LastCheckIn,
  type ProactiveSetting,
  type ProactiveSuggestion,
  proactiveAllowedQueryOptions,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { relativeTime } from "@/lib/relative-time";
import { useUserPreferences } from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { SuggestionRow } from "./suggestion-row";

const intervals = [
  { minutes: 60, label: "Every hour" },
  { minutes: 240, label: "Every 4 hours" },
  { minutes: 720, label: "Twice a day" },
  { minutes: 1440, label: "Once a day" },
];
/** The label map, so a closed trigger says "Every 4 hours" rather than 240. */
const intervalItems = intervals.map((interval) => ({
  value: interval.minutes,
  label: interval.label,
}));
const intervalLabel = (minutes: number) =>
  intervals.find((interval) => interval.minutes === minutes)?.label ??
  `Every ${minutes} minutes`;
/** How many suggestions show before the rest fold behind "Show more". */
const SUGGESTIONS_SHOWN = 3;

function searchableText(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * What the person's Bots found in their check-ins, each with why, its source and its Bot, to Start
 * as a task or Hide. Ideas and Up next present these suggestions on their own.
 */
export function SuggestionsInbox({
  agentId,
  showEmpty = false,
  searchable = false,
}: {
  agentId?: string;
  showEmpty?: boolean;
  searchable?: boolean;
} = {}) {
  const { t } = useTranslation();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const readable = canKeepCachedRead(suggestions.error);
  const scoped = (readable ? (suggestions.data ?? []) : []).filter(
    (suggestion) => agentId === undefined || suggestion.agentId === agentId,
  );
  const bots = useQuery(agentListQueryOptions());
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dismiss = useMutation(resolveSuggestionMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const words = searchableText(search.trim()).split(/\s+/).filter(Boolean);
  const filtering = words.length > 0;
  const shown = filtering
    ? scoped.filter(({ title, detail, sourceApp }) => {
        const content = searchableText(`${title} ${detail} ${sourceApp ?? ""}`);
        return words.every((word) => content.includes(word));
      })
    : scoped;
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? "Your Bot";

  function confirmDismiss(
    suggestion: ProactiveSuggestion,
    trigger: HTMLButtonElement,
  ) {
    requestConfirmation({
      title: `Dismiss ${suggestion.title}?`,
      description:
        "This removes the idea and tells your Bot to skip similar ideas in check-ins for 30 days.",
      confirmLabel: "Dismiss idea",
      pendingLabel: "Dismissing…",
      failureMessage: "Couldn’t dismiss this idea. Try again.",
      successMessage: `Dismissed ${suggestion.title}.`,
      trigger,
      fallbackFocus: () => searchInput.current ?? heading.current,
      run: async () => {
        const latest = await suggestions.refetch({ throwOnError: true });
        if (!latest.data?.some(({ id }) => id === suggestion.id)) {
          throw new ActionUnavailable("This idea is no longer in the list.");
        }
        await dismiss.mutateAsync({ id: suggestion.id, action: "dismiss" });
      },
    });
  }
  if (
    !showEmpty &&
    agentId !== undefined &&
    !suggestions.isError &&
    shown.length === 0
  ) {
    return null;
  }
  /*
   * The newest few, the rest a click away. Each suggestion is a paragraph with two buttons, and a
   * Bot that had piled up sixty of them made its own page 8,000px of suggestions with its settings
   * somewhere underneath. The list arrives newest first.
   */
  const hidden =
    expanded || filtering ? 0 : Math.max(0, shown.length - SUGGESTIONS_SHOWN);
  const visible = hidden ? shown.slice(0, SUGGESTIONS_SHOWN) : shown;
  return (
    <PageSection
      description={
        scoped.length > 0 && suggestions.isSuccess
          ? t(
              "ideas.actionConsequences",
              "Work on it starts a task. Dismiss tells check-ins to skip similar ideas for 30 days.",
            )
          : undefined
      }
      headingRef={heading}
      title="Suggested next steps"
    >
      {confirmation}
      {suggestions.isPending ? (
        <ReadStatus kind="loading" message="Loading suggested next steps…" />
      ) : null}
      {suggestions.isError ? (
        <ReadError
          description={
            scoped.length ? "Showing the last loaded suggestions." : undefined
          }
          focusAfterRetry={() => heading.current}
          message={
            scoped.length
              ? "Couldn’t refresh suggested next steps"
              : "Couldn’t load suggested next steps"
          }
          retry={suggestions.refetch}
          retryBelow
          retrying={suggestions.isFetching}
        />
      ) : null}
      {searchable && (scoped.length > 0 || search) ? (
        <Stack gap={2} className="mt-3">
          <Field>
            <FieldLabel htmlFor={searchId}>Search suggestions</FieldLabel>
            <Stack direction="horizontal" align="center" gap={2} wrap="wrap">
              <Input
                className="min-h-11 w-full sm:max-w-sm"
                id={searchId}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Title, details or source"
                ref={searchInput}
                type="search"
                value={search}
              />
              {search ? (
                <Button
                  className="min-h-11"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setSearch("");
                    searchInput.current?.focus();
                  }}
                >
                  Clear search
                </Button>
              ) : null}
            </Stack>
          </Field>
          <Text as="p" color="secondary" role="status" size="sm">
            {filtering && suggestions.isSuccess
              ? shown.length
                ? `${shown.length} matching ${shown.length === 1 ? "suggestion" : "suggestions"}`
                : "No matching suggestions"
              : ""}
          </Text>
          {!filtering && scoped.length > SUGGESTIONS_SHOWN ? (
            <Button
              aria-expanded={expanded}
              className="min-h-11 self-start"
              variant="outline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? `Show ${SUGGESTIONS_SHOWN} newest suggestions`
                : `Show all ${scoped.length} suggestions`}
            </Button>
          ) : null}
        </Stack>
      ) : null}
      {shown.length ? (
        <PageRows>
          {visible.map((suggestion, index) => (
            <Fragment key={suggestion.id}>
              {index > 0 ? <Separator /> : null}
              <SuggestionRow
                botName={botName(suggestion.agentId)}
                canAct={!suggestions.isError}
                onDismiss={(trigger) => confirmDismiss(suggestion, trigger)}
                suggestion={suggestion}
              />
            </Fragment>
          ))}
          {hidden && !searchable ? (
            <>
              <Separator />
              <Item
                className="min-h-11"
                render={<button type="button" />}
                onClick={() => setExpanded(true)}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle className="text-muted-foreground">
                    Show {hidden} more
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <IconChevronDown className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      ) : suggestions.isSuccess && !filtering ? (
        <InlineEmpty title="Nothing needs you right now">
          When a Bot's check-in finds something that needs you, it shows up
          here.
        </InlineEmpty>
      ) : null}
    </PageSection>
  );
}

/**
 * Why no Bot checks in for this person whatever its own setting says, or null when they do: an
 * admin turned check-ins off for them, or they turned them off for all their Bots.
 */
function useCheckInsBlocked(): string | null {
  const allowed = useQuery(proactiveAllowedQueryOptions());
  const preferences = useUserPreferences();
  if (allowed.data === false) return "Turned off by your admin";
  if (preferences.data?.proactive === "off") return "Off for all your Bots";
  return null;
}

/**
 * A Bot's check-ins: it reads the apps it can already read, quietly, and tells the person when
 * something needs them. Read-only.
 *
 * Each Bot's check-ins are a row stating its current answer; it opens a dialog to change how often,
 * run one now, turn it off or remove it. Turning it on is a dialog behind the section's action,
 * offered only for a Bot with none: one that has them turns them on and off from its own row, and a
 * second would only be refused.
 *
 * When an admin or the person turned check-ins off for all their Bots, each row says so in place of
 * when it runs next, since none will run whatever the row's own switch says.
 */
export function ProactiveResearchSettings({
  agentId: fixedBot,
  showIdeasLink = true,
}: {
  /** Only this Bot's check-ins, and a new one is this Bot's without asking. */
  agentId?: string;
  showIdeasLink?: boolean;
} = {}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const blocked = useCheckInsBlocked();
  const [adding, setAdding] = useState(false);
  const shown = (settings.data ?? []).filter(
    (setting) => fixedBot === undefined || setting.agentId === fixedBot,
  );
  const canAdd =
    settings.isSuccess &&
    (fixedBot === undefined ? shown.length > 0 : shown.length === 0);
  return (
    <PageSection
      action={
        canAdd ? (
          <Button
            className={fixedBot === undefined ? undefined : "min-h-11"}
            onClick={() => setAdding(true)}
            size={fixedBot === undefined ? "sm" : "default"}
            variant={fixedBot === undefined ? "ghost" : "outline"}
          >
            {fixedBot === undefined ? <IconPlus /> : null}
            Turn on check-ins
          </Button>
        ) : null
      }
      description="Your Bot checks for changes on a schedule and flags what needs you. Check-ins are read-only."
      title="Check-ins"
    >
      {showIdeasLink ? (
        <Link
          className="text-sm underline underline-offset-4"
          search={{ agent: fixedBot }}
          to="/ideas"
        >
          Open Ideas
        </Link>
      ) : null}
      {blocked ? (
        <p className="mt-1 max-w-prose text-muted-foreground text-sm">
          {blocked === "Off for all your Bots" ? (
            <>
              You turned off check-ins for all your Bots in{" "}
              <Link
                className="underline underline-offset-4"
                to="/settings/notifications"
              >
                Notifications
              </Link>
              .
            </>
          ) : (
            "Your admin turned off check-ins for you."
          )}
        </p>
      ) : null}
      {settings.isPending ? (
        <ReadStatus kind="loading" message="Loading check-ins…" />
      ) : settings.error ? (
        <ReadStatus
          kind="error"
          message="Couldn’t load check-ins"
          retry={settings.refetch}
        />
      ) : shown.length === 0 && fixedBot !== undefined ? (
        <p className="mt-3 text-muted-foreground text-sm">No check-ins yet</p>
      ) : shown.length === 0 ? (
        <PageEmpty
          action={
            <Button
              className="min-h-11"
              onClick={() => setAdding(true)}
              size="sm"
              variant="outline"
            >
              <IconPlus />
              Turn on check-ins
            </Button>
          }
          icon={IconRadar}
          title="No check-ins yet"
        />
      ) : (
        <PageRows>
          {shown.map((setting, index) => (
            <Fragment key={setting.id}>
              {index > 0 ? <Separator /> : null}
              <SettingRow
                blocked={blocked}
                setting={setting}
                botName={
                  bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
                  setting.agentId
                }
              />
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? (
        <TurnOnResearchDialog
          fixedBot={fixedBot}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </PageSection>
  );
}

/**
 * Which Bot, which conversation it checks from, how often, and what to look for. Only Bots without
 * check-ins, and only the person's own conversations with the Bot: a task's conversation holds one
 * piece of work, and is no place for check-ins to reach them.
 */
function TurnOnResearchDialog({
  fixedBot,
  onClose,
}: {
  fixedBot?: string;
  onClose: () => void;
}) {
  const settings = useQuery(proactiveSettingsQueryOptions());
  const allBots = useQuery(agentListQueryOptions());
  const bots = {
    data: allBots.data?.filter(
      (bot) => !settings.data?.some((setting) => setting.agentId === bot.id),
    ),
  };
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  // Hourly, the most often a Bot checks and the default for a new Bot.
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) =>
      channel.active && !channel.task && channel.agentIds.includes(agentId),
  );
  const add = useMutation(createProactiveSettingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent {...astryxScope}>
        <DialogHeader>
          <DialogTitle>Turn on check-ins</DialogTitle>
          <DialogDescription>
            It reads the apps it can use in this conversation and tells you when
            something needs you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={id}
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate(
                { agentId, channelId, focus, intervalMinutes },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              {fixedBot === undefined ? (
                <Field>
                  <FieldLabel htmlFor={`${id}-bot`}>Bot</FieldLabel>
                  <Select
                    items={bots.data?.map((bot) => ({
                      value: bot.id,
                      label: bot.name,
                    }))}
                    onValueChange={(value) => {
                      setAgentId(value ?? "");
                      setChannelId("");
                    }}
                    required
                    value={agentId || null}
                  >
                    <SelectTrigger className="w-full" id={`${id}-bot`}>
                      <SelectValue placeholder="Choose a Bot" />
                    </SelectTrigger>
                    <SelectContent>
                      {bots.data?.map((bot) => (
                        <SelectItem key={bot.id} value={bot.id}>
                          {bot.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${id}-channel`}>Conversation</FieldLabel>
                <Select
                  items={eligibleChannels.map((channel) => ({
                    value: channel.id,
                    label: conversationLabel(channel),
                  }))}
                  onValueChange={(value) => setChannelId(value ?? "")}
                  required
                  value={channelId || null}
                >
                  <SelectTrigger className="w-full" id={`${id}-channel`}>
                    <SelectValue placeholder="Choose a conversation" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleChannels.map((channel) => (
                      <SelectItem key={channel.id} value={channel.id}>
                        {conversationLabel(channel)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-interval`}>How often</FieldLabel>
                <Select
                  items={intervalItems}
                  onValueChange={(value) => {
                    if (value !== null) setIntervalMinutes(value);
                  }}
                  value={intervalMinutes}
                >
                  <SelectTrigger className="w-full" id={`${id}-interval`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {intervals.map((interval) => (
                      <SelectItem
                        key={interval.minutes}
                        value={interval.minutes}
                      >
                        {interval.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-focus`}>
                  What to look for (optional)
                </FieldLabel>
                <Input
                  id={`${id}-focus`}
                  maxLength={1000}
                  value={focus}
                  onChange={(event) => setFocus(event.target.value)}
                  placeholder="Open issues assigned to me and questions waiting on me"
                />
              </Field>
            </FieldGroup>
          </form>
          {add.error && (
            <p role="alert" className="text-destructive text-sm">
              {add.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4 flex-wrap">
          <Button onClick={onClose} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={add.isPending || !agentId || !channelId}
            form={id}
            size="sm"
            type="submit"
          >
            Turn on check-ins
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Whether it is on, and when it runs next. Stated rather than captured, so it follows the query.
 * While check-ins are off for all the person's Bots, that is the answer, whatever this one says.
 */
function checkInStatus(setting: ProactiveSetting, blocked: string | null) {
  return !setting.enabled
    ? "Off"
    : blocked
      ? blocked
      : setting.lastStatus === "running"
        ? "Checking now"
        : `Next ${new Date(setting.nextRunAt).toLocaleString()}`;
}

/** When a check-in happened, as its line says it: "just now" for the moment after a Run now. */
const sinceThen = (iso: string) =>
  Date.now() - Date.parse(iso) < 60_000 ? "just now" : relativeTime(iso);

/**
 * What the Bot's last check-in did, in a sentence: found nothing, found something, was skipped and
 * why, or couldn't finish and why. The why is the server's, written for the person. Null before the
 * first one.
 */
export function lastCheckInLine(run: LastCheckIn | null | undefined) {
  if (!run) return null;
  const when = sinceThen(run.startedAt);
  switch (run.outcome) {
    case "running":
      return `Started ${when}.`;
    case "quiet":
      return `Checked ${when}. Nothing needed you.`;
    case "raised":
      return `Checked ${when}. Found ${run.itemsRaised === 1 ? "1 thing" : `${run.itemsRaised} things`} for you.`;
    case "failed":
      return `Checked ${when}. ${run.why ?? "Couldn't finish."}`;
    case "skipped":
      return run.why ? `Skipped ${when}. ${run.why}` : `Skipped ${when}.`;
  }
}

/**
 * One Bot's check-ins: a summary of its current answer and a chevron, opening a dialog that changes
 * it. The dialog is the row's sibling, not its child, so a click inside it does not bubble back to
 * the row and reopen it.
 *
 * The summary leads with how often and when it runs next, which always fits. A last check-in that
 * was skipped or couldn't finish says why on a line of its own, since that is something to act on,
 * and the focus, in the person's own words and often long, comes last on one line.
 */
function SettingRow({
  setting,
  botName,
  blocked,
}: {
  setting: ProactiveSetting;
  botName: string;
  blocked: string | null;
}) {
  // Subscribes this row to the interface language, so choosing another one redraws its time in place.
  useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const summary = `${intervalLabel(setting.intervalMinutes)} · ${checkInStatus(setting, blocked)}`;
  const last = lastCheckInLine(setting.lastRun);
  const outcome = setting.lastRun?.outcome;
  /*
   * Run now was queued and nothing has started since: say it is on its way until the check-in it
   * queued shows up as the last one, so the press is never followed by nothing.
   */
  const queuedAt =
    change.isSuccess && change.data?.queued ? change.submittedAt : null;
  const onItsWay =
    queuedAt !== null &&
    !(setting.lastRun && Date.parse(setting.lastRun.startedAt) >= queuedAt);
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              // Opening starts clean: the last change's failure is not this visit's.
              change.reset();
              setOpen(true);
            }}
            type="button"
          />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconRadar />
        </ItemMedia>
        <ItemContent>
          {/* What it watches leads, where it watches one thing; the Bot is who watches it. */}
          <ItemTitle>{setting.subject || botName}</ItemTitle>
          <ItemDescription>
            {setting.subject ? `${botName} · ${summary}` : summary}
          </ItemDescription>
          {last && (outcome === "skipped" || outcome === "failed") ? (
            <ItemDescription
              className={outcome === "failed" ? "text-destructive" : undefined}
            >
              {last}
            </ItemDescription>
          ) : null}
          {setting.focus ? (
            <ItemDescription className="line-clamp-1">
              Looks for: {setting.focus}
            </ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent {...astryxScope}>
          <DialogHeader>
            <DialogTitle>Check-ins</DialogTitle>
            <DialogDescription>
              {[botName, setting.subject, setting.focus]
                .filter(Boolean)
                .join(" · ")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Item size="sm" variant="muted">
              <ItemMedia variant="icon">
                <IconClock />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{checkInStatus(setting, blocked)}</ItemTitle>
                {onItsWay ? (
                  <ItemDescription>
                    Queued. It checks in within a minute.
                  </ItemDescription>
                ) : last ? (
                  <ItemDescription
                    className={cn(
                      "line-clamp-none",
                      outcome === "failed" && "text-destructive",
                    )}
                  >
                    {last}
                  </ItemDescription>
                ) : null}
              </ItemContent>
            </Item>
            <Field>
              <FieldLabel htmlFor={`${id}-interval`}>How often</FieldLabel>
              {/* Writes on pick: one value, no draft worth holding. */}
              <Select
                disabled={change.isPending}
                items={intervalItems}
                onValueChange={(minutes) => {
                  if (minutes !== null && minutes !== setting.intervalMinutes)
                    change.mutate({
                      setting,
                      change: { kind: "interval", minutes },
                    });
                }}
                value={setting.intervalMinutes}
              >
                <SelectTrigger className="w-full" id={`${id}-interval`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervals.map((interval) => (
                    <SelectItem key={interval.minutes} value={interval.minutes}>
                      {interval.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {change.error && (
              <p role="alert" className="text-destructive text-sm">
                {change.error.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-4 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { setting, change: { kind: "remove" } },
                  { onSuccess: () => setOpen(false) },
                )
              }
            >
              Remove
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() =>
                change.mutate({ setting, change: { kind: "toggle" } })
              }
            >
              {setting.enabled ? "Turn off" : "Turn on"}
            </Button>
            <Button
              size="sm"
              disabled={!setting.enabled || !!blocked || change.isPending}
              onClick={() =>
                change.mutate({ setting, change: { kind: "run" } })
              }
            >
              {change.isPending && change.variables.change.kind === "run"
                ? "Starting…"
                : "Run now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
