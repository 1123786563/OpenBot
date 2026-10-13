import {
  IconBellRinging,
  IconBrandGithub,
  IconBrandSlack,
  IconBug,
  IconListCheck,
  IconMail,
  IconPlus,
  IconWebhook,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
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
import { Switch } from "@/components/ui/switch";
import {
  createTriggerMutationOptions,
  type ResponsibilityRecord,
  removeTriggerMutationOptions,
  revealTriggerSecretMutationOptions,
  setTriggerEnabledMutationOptions,
  setTriggerSecretMutationOptions,
  type TriggerConfig,
  type TriggerKind,
  type TriggerRecord,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

export const KIND_KEYS = {
  webhook: "responsibilities.kind.webhook",
  github: "responsibilities.kind.github",
  linear: "responsibilities.kind.linear",
  sentry: "responsibilities.kind.sentry",
  pagerduty: "responsibilities.kind.pagerduty",
  email: "responsibilities.kind.email",
  slack: "responsibilities.kind.slack",
} as const satisfies Record<TriggerKind, string>;
const KIND_ICON: Record<TriggerKind, typeof IconWebhook> = {
  webhook: IconWebhook,
  github: IconBrandGithub,
  linear: IconListCheck,
  sentry: IconBug,
  pagerduty: IconBellRinging,
  email: IconMail,
  slack: IconBrandSlack,
};
const KIND_HELP_KEYS = {
  webhook: "responsibilities.kindHelp.webhook",
  github: "responsibilities.kindHelp.github",
  linear: "responsibilities.kindHelp.linear",
  sentry: "responsibilities.kindHelp.sentry",
  pagerduty: "responsibilities.kindHelp.pagerduty",
  email: "responsibilities.kindHelp.email",
  slack: "responsibilities.kindHelp.slack",
} as const satisfies Record<TriggerKind, string>;
const VENDOR_SECRET: ReadonlySet<TriggerKind> = new Set([
  "linear",
  "sentry",
  "pagerduty",
]);
const SLACK_MODE_KEYS = {
  mention: "responsibilities.slackMode.mention",
  phrase: "responsibilities.slackMode.phrase",
  reaction: "responsibilities.slackMode.reaction",
  message: "responsibilities.slackMode.message",
} as const;
type SlackMode = keyof typeof SLACK_MODE_KEYS;
const STATUS_KEYS = {
  active: "responsibilities.status.active",
  paused: "responsibilities.status.paused",
  completed: "responsibilities.status.completed",
} as const satisfies Record<ResponsibilityRecord["status"], string>;
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation("routines");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      type="button"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t("responsibilities.triggers.copied") : label}
    </Button>
  );
}

/** A value somebody copies into another product: a URL, an address, a key. */
function Copyable({ children }: { children: string }) {
  return (
    <code className="break-all rounded bg-background px-2 py-1 text-xs">
      {children}
    </code>
  );
}

function describeFilter(t: TFunction<"routines">, config: TriggerConfig) {
  if (config.kind === "slack") {
    const where = config.channels.length
      ? t("responsibilities.filter.inChannels", {
          channels: config.channels.join(", "),
        })
      : t("responsibilities.filter.inEveryChannel");
    const what =
      config.mode === "mention"
        ? t("responsibilities.filter.whenMentioned")
        : config.mode === "message"
          ? t("responsibilities.filter.onAnyMessage")
          : config.mode === "phrase"
            ? t("responsibilities.filter.onPhrases", {
                phrases: config.phrases
                  .map((phrase) => `"${phrase}"`)
                  .join(" or "),
              })
            : t("responsibilities.filter.onReactions") +
              (config.reactions.length
                ? t("responsibilities.filter.reactionsSuffix", {
                    reactions: config.reactions.join(": :"),
                  })
                : "");
    return (
      `${what} ${where}` +
      t("responsibilities.filter.workspaceSuffix", { teamId: config.teamId })
    );
  }
  const parts = [
    config.filter.eventTypes.length
      ? t("responsibilities.filter.events", {
          eventTypes: config.filter.eventTypes.join(", "),
        })
      : t("responsibilities.filter.everyEvent"),
  ];
  if (config.filter.field)
    parts.push(
      t("responsibilities.filter.where", {
        path: config.filter.field.path,
        value: config.filter.field.equals,
      }),
    );
  if (config.kind === "github" && config.repository)
    parts.push(
      t("responsibilities.filter.fromRepo", { repository: config.repository }),
    );
  if (config.kind === "email" && config.allowedSenders.length)
    parts.push(
      t("responsibilities.filter.fromSenders", {
        senders: config.allowedSenders.join(", "),
      }),
    );
  return parts.join(" ");
}

/**
 * What starts a responsibility from outside: one muted row per trigger inside the responsibility's
 * dialog, and a stacked dialog to add one. A fresh key is held here, keyed by trigger, so it survives
 * the list refetching after the write that produced it.
 */
export function Triggers({ goal }: { goal: ResponsibilityRecord }) {
  const { t } = useTranslation("routines");
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const [adding, setAdding] = useState(false);
  const [freshSecret, setFreshSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">
          {t("responsibilities.triggers.title")}
        </h3>
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => setAdding(true)}
        >
          <IconPlus />
          {t("responsibilities.triggers.add")}
        </Button>
      </div>
      {goal.status !== "active" && (
        <p className="text-muted-foreground text-xs">
          {t("responsibilities.triggers.statusNote", {
            status: t(STATUS_KEYS[goal.status]),
          })}
        </p>
      )}
      {triggers.error && (
        <p role="alert" className="text-destructive text-sm">
          {triggers.error.message}
        </p>
      )}
      {triggers.data?.length === 0 && (
        <p className="text-muted-foreground text-xs">
          {t("responsibilities.triggers.none")}
        </p>
      )}
      {triggers.data?.length ? (
        <div className="overflow-hidden rounded-lg">
          {triggers.data.map((trigger, index) => (
            <Fragment key={trigger.id}>
              {index > 0 ? <Separator /> : null}
              <TriggerRow
                trigger={trigger}
                freshSecret={
                  freshSecret?.id === trigger.id ? freshSecret.secret : null
                }
                onChanged={(secret) => {
                  if (secret) setFreshSecret({ id: trigger.id, secret });
                }}
              />
            </Fragment>
          ))}
        </div>
      ) : null}
      {adding ? (
        <NewTriggerDialog
          goalId={goal.id}
          botId={goal.agentId}
          onClose={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            if (created.secret)
              setFreshSecret({
                id: created.trigger.id,
                secret: created.secret,
              });
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * One trigger. On or off is binary and immediate, so it is a Switch; what it takes to wire the
 * trigger up — its URL, its key, the vendor's signing secret — sits in the footer beneath, where it
 * has the row's whole width.
 */
function TriggerRow({
  trigger,
  freshSecret,
  onChanged,
}: {
  trigger: TriggerRecord;
  freshSecret: string | null;
  /** A write that produced a new key; the triggers list itself refetches from the write. */
  onChanged: (secret: string | null) => void;
}) {
  const { t } = useTranslation("routines");
  const [secret, setSecret] = useState<string | null>(freshSecret);
  const [pasted, setPasted] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const shown = freshSecret ?? secret;
  const reveal = useMutation(revealTriggerSecretMutationOptions());
  const rotate = useMutation(setTriggerSecretMutationOptions(queryClient));
  const remove = useMutation(removeTriggerMutationOptions(queryClient));
  const toggle = useMutation(setTriggerEnabledMutationOptions(queryClient));
  const rotateSecret = () =>
    rotate.mutate(
      {
        trigger,
        secret: VENDOR_SECRET.has(trigger.kind) ? pasted : undefined,
      },
      {
        onSuccess: (result) => {
          setPasted("");
          setSecret(result.secret);
          onChanged(result.secret);
        },
      },
    );
  const url = trigger.path ? `${window.location.origin}${trigger.path}` : null;
  const generated = trigger.kind === "webhook" || trigger.kind === "github";
  const Icon = KIND_ICON[trigger.kind];
  return (
    <Item size="sm" variant="muted">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t(KIND_KEYS[trigger.kind])}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {describeFilter(t, trigger.config)}
          {trigger.enabled
            ? ""
            : t("responsibilities.triggers.pausedSuffix")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {confirmRemove ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(trigger)}
            >
              {t("responsibilities.triggers.removeForGood")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(false)}
            >
              {t("responsibilities.triggers.keep")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
            >
              {t("responsibilities.triggers.remove")}
            </Button>
            <Switch
              aria-label={t("responsibilities.triggers.runOnAria", {
                kind: t(KIND_KEYS[trigger.kind]),
              })}
              checked={trigger.enabled}
              disabled={toggle.isPending}
              onCheckedChange={() =>
                toggle.mutate({ trigger, enabled: !trigger.enabled })
              }
            />
          </>
        )}
      </ItemActions>
      <ItemFooter className="flex-col items-stretch">
        <p className="text-muted-foreground text-xs">
          {t(KIND_HELP_KEYS[trigger.kind])}
        </p>
        {url && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">
              {t("responsibilities.triggers.postTo")}
            </span>
            <Copyable>{url}</Copyable>
            <CopyButton
              value={url}
              label={t("responsibilities.triggers.copyUrl")}
            />
          </div>
        )}
        {trigger.kind === "email" &&
          (trigger.address ? (
            <div className="flex flex-wrap items-center gap-2">
              <Copyable>{trigger.address}</Copyable>
              <CopyButton
                value={trigger.address}
                label={t("responsibilities.triggers.copyAddress")}
              />
            </div>
          ) : (
            <p className="text-amber-600 text-xs dark:text-amber-500">
              {t("responsibilities.triggers.inboundEmailWarning")}
            </p>
          ))}
        {generated && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">
              {t("responsibilities.triggers.key")}
            </span>
            {shown ? (
              <>
                <Copyable>{shown}</Copyable>
                <CopyButton
                  value={shown}
                  label={t("responsibilities.triggers.copyKey")}
                />
                {trigger.kind === "webhook" && (
                  <CopyButton
                    value={`Authorization: Bearer ${shown}`}
                    label={t("responsibilities.triggers.copyHeader")}
                  />
                )}
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={reveal.isPending}
                onClick={() =>
                  reveal.mutate(trigger.id, { onSuccess: setSecret })
                }
              >
                {t("responsibilities.triggers.showKey")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={rotate.isPending}
              onClick={rotateSecret}
            >
              {t("responsibilities.triggers.rotateKey")}
            </Button>
          </div>
        )}
        {trigger.kind === "webhook" && shown && (
          <Copyable>{`Authorization: Bearer ${shown}`}</Copyable>
        )}
        {VENDOR_SECRET.has(trigger.kind) && (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              rotateSecret();
            }}
          >
            <span
              className={
                trigger.hasSecret
                  ? "text-xs"
                  : "text-amber-600 text-xs dark:text-amber-500"
              }
            >
              {trigger.hasSecret
                ? t("responsibilities.triggers.secretStored")
                : t("responsibilities.triggers.secretWaiting")}
            </span>
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("responsibilities.triggers.signingSecret")}
                type="password"
                autoComplete="new-password"
                placeholder={
                  trigger.hasSecret
                    ? t("responsibilities.triggers.pasteNewSecret")
                    : t("responsibilities.triggers.pasteSecret")
                }
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                required
              />
              <Button size="sm" type="submit" disabled={rotate.isPending}>
                {t("responsibilities.triggers.saveSecret")}
              </Button>
            </div>
          </form>
        )}
        {(reveal.error || rotate.error || remove.error || toggle.error) && (
          <p role="alert" className="text-destructive text-xs">
            {reveal.error?.message ??
              rotate.error?.message ??
              remove.error?.message ??
              toggle.error?.message}
          </p>
        )}
      </ItemFooter>
    </Item>
  );
}

/**
 * A new trigger, in a dialog stacked over the responsibility's own. The fields follow the kind: Slack
 * is a workspace, a mode and channels; every other kind is an event filter, plus a repository for
 * GitHub, senders for email, and a signing secret for the vendors that issue their own.
 */
function NewTriggerDialog({
  goalId,
  botId,
  onClose,
  onCreated,
}: {
  goalId: string;
  botId: string;
  onClose: () => void;
  onCreated: (created: {
    trigger: TriggerRecord;
    secret: string | null;
  }) => void;
}) {
  const { t } = useTranslation("routines");
  const id = useId();
  const [kind, setKind] = useState<TriggerKind>("webhook");
  const [eventTypes, setEventTypes] = useState("");
  const [fieldPath, setFieldPath] = useState("");
  const [fieldEquals, setFieldEquals] = useState("");
  const [repository, setRepository] = useState("");
  const [senders, setSenders] = useState("");
  const [secret, setSecret] = useState("");
  const [teamId, setTeamId] = useState("");
  const [mode, setMode] = useState<SlackMode>("mention");
  const [phrases, setPhrases] = useState("");
  const [reactions, setReactions] = useState("");
  const [channels, setChannels] = useState("");
  const config = (): TriggerConfig => {
    if (kind === "slack")
      return {
        kind,
        teamId: teamId.trim(),
        mode,
        phrases: list(phrases),
        reactions: list(reactions).map((reaction) =>
          reaction.replace(/:/g, ""),
        ),
        channels: list(channels),
      };
    const filter = {
      eventTypes: list(eventTypes),
      ...(fieldPath.trim() && fieldEquals.trim()
        ? { field: { path: fieldPath.trim(), equals: fieldEquals.trim() } }
        : {}),
    };
    if (kind === "github")
      return {
        kind,
        filter,
        ...(repository.trim() ? { repository: repository.trim() } : {}),
      };
    if (kind === "email")
      return { kind, filter, allowedSenders: list(senders) };
    return { kind, filter };
  };
  // The triggers list and the shared-app requests both refetch from the write itself.
  const create = useMutation(createTriggerMutationOptions(queryClient));
  const placeholder: Record<TriggerKind, string> = {
    webhook: "deploy.finished (blank: any)",
    github: "issues.opened, pull_request",
    linear: "Issue.create, Comment",
    sentry: "issue.created, event_alert.triggered",
    pagerduty: "incident.triggered",
    email: "received",
    slack: "",
  };
  const kindItems = Object.fromEntries(
    (Object.keys(KIND_KEYS) as TriggerKind[]).map((value) => [
      value,
      t(KIND_KEYS[value]),
    ]),
  );
  const slackModeItems = Object.fromEntries(
    (Object.keys(SLACK_MODE_KEYS) as SlackMode[]).map((value) => [
      value,
      t(SLACK_MODE_KEYS[value]),
    ]),
  );
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      {/* The heavier backdrop, forced: this stacks over the responsibility's dialog, and Base UI
          would otherwise render a nested dialog with no backdrop at all. */}
      <DialogContent overlayClassName="bg-black/20 supports-backdrop-filter:backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle>{t("responsibilities.triggers.add")}</DialogTitle>
          <DialogDescription>
            {t("responsibilities.triggers.addDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={`${id}-form`}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                {
                  responsibilityId: goalId,
                  input: {
                    config: config(),
                    ...(VENDOR_SECRET.has(kind) && secret ? { secret } : {}),
                  },
                },
                { onSuccess: onCreated },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${id}-kind`}>
                  {t("responsibilities.triggers.triggerField")}
                </FieldLabel>
                <Select
                  items={kindItems}
                  onValueChange={(value) => {
                    if (value) setKind(value as TriggerKind);
                  }}
                  value={kind}
                >
                  <SelectTrigger className="w-full" id={`${id}-kind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_KEYS) as TriggerKind[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {kindItems[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{t(KIND_HELP_KEYS[kind])}</FieldDescription>
              </Field>
              {kind === "slack" ? (
                <FieldGroup className="sm:grid sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor={`${id}-team`}>
                      {t("responsibilities.triggers.slackTeamId")}
                    </FieldLabel>
                    <Input
                      id={`${id}-team`}
                      required
                      placeholder="T0123ABCD"
                      value={teamId}
                      onChange={(event) => setTeamId(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-mode`}>
                      {t("responsibilities.triggers.fireOn")}
                    </FieldLabel>
                    <Select
                      items={slackModeItems}
                      onValueChange={(value) => {
                        if (value) setMode(value as SlackMode);
                      }}
                      value={mode}
                    >
                      <SelectTrigger className="w-full" id={`${id}-mode`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(SLACK_MODE_KEYS) as SlackMode[]).map(
                          (value) => (
                            <SelectItem key={value} value={value}>
                              {slackModeItems[value]}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </Field>
                  {mode === "phrase" && (
                    <Field>
                      <FieldLabel htmlFor={`${id}-phrases`}>
                        {t("responsibilities.triggers.phrases")}
                      </FieldLabel>
                      <Input
                        id={`${id}-phrases`}
                        required
                        value={phrases}
                        onChange={(event) => setPhrases(event.target.value)}
                      />
                    </Field>
                  )}
                  {mode === "reaction" && (
                    <Field>
                      <FieldLabel htmlFor={`${id}-reactions`}>
                        {t("responsibilities.triggers.reactions")}
                      </FieldLabel>
                      <Input
                        id={`${id}-reactions`}
                        placeholder="eyes, rotating_light"
                        value={reactions}
                        onChange={(event) => setReactions(event.target.value)}
                      />
                    </Field>
                  )}
                  <Field>
                    <FieldLabel htmlFor={`${id}-channels`}>
                      {t("responsibilities.triggers.channelIds")}
                    </FieldLabel>
                    <Input
                      id={`${id}-channels`}
                      placeholder="C0123ABCD"
                      value={channels}
                      onChange={(event) => setChannels(event.target.value)}
                    />
                  </Field>
                </FieldGroup>
              ) : (
                <FieldGroup className="sm:grid sm:grid-cols-2">
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor={`${id}-types`}>
                      {t("responsibilities.triggers.eventTypes")}
                    </FieldLabel>
                    <Input
                      id={`${id}-types`}
                      placeholder={placeholder[kind]}
                      value={eventTypes}
                      onChange={(event) => setEventTypes(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-path`}>
                      {t("responsibilities.triggers.onlyWhenField")}
                    </FieldLabel>
                    <Input
                      id={`${id}-path`}
                      placeholder="data.team.key"
                      value={fieldPath}
                      onChange={(event) => setFieldPath(event.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-equals`}>
                      {t("responsibilities.triggers.equals")}
                    </FieldLabel>
                    <Input
                      id={`${id}-equals`}
                      placeholder="ENG"
                      value={fieldEquals}
                      onChange={(event) => setFieldEquals(event.target.value)}
                    />
                  </Field>
                  {kind === "github" && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`${id}-repo`}>
                        {t("responsibilities.triggers.repository")}
                      </FieldLabel>
                      <Input
                        id={`${id}-repo`}
                        placeholder="owner/name"
                        value={repository}
                        onChange={(event) => setRepository(event.target.value)}
                      />
                    </Field>
                  )}
                  {kind === "email" && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`${id}-senders`}>
                        {t("responsibilities.triggers.allowedSenders")}
                      </FieldLabel>
                      <Input
                        id={`${id}-senders`}
                        placeholder="ops@example.com, example.com"
                        value={senders}
                        onChange={(event) => setSenders(event.target.value)}
                      />
                    </Field>
                  )}
                  {VENDOR_SECRET.has(kind) && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor={`${id}-secret`}>
                        {t("responsibilities.triggers.signingSecretLater")}
                      </FieldLabel>
                      <Input
                        id={`${id}-secret`}
                        type="password"
                        autoComplete="new-password"
                        value={secret}
                        onChange={(event) => setSecret(event.target.value)}
                      />
                    </Field>
                  )}
                </FieldGroup>
              )}
            </FieldGroup>
          </form>
          <SharedAppNotice botId={botId} reason="trigger" />
          {create.error && (
            <p role="alert" className="text-destructive text-sm">
              {create.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("responsibilities.triggers.cancel")}
          </Button>
          <Button
            disabled={create.isPending}
            form={`${id}-form`}
            size="sm"
            type="submit"
          >
            {create.isPending
              ? t("responsibilities.triggers.adding")
              : t("responsibilities.triggers.addKind", {
                  kind: t(KIND_KEYS[kind]),
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
