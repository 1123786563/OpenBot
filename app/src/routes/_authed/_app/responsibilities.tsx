import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { PageShell } from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import { markdownComponents } from "@/lib/markdown";
import { sharedUseKeys } from "@/lib/plugins/shared-use";
import {
  createGithubBinding,
  createResponsibility,
  createTrigger,
  githubBindingsQueryOptions,
  type ResponsibilityRecord,
  removeGithubBinding,
  removeTrigger,
  responsibilitiesQueryOptions,
  responsibilityAction,
  responsibilityKeys,
  responsibilityRunsQueryOptions,
  revealTriggerSecret,
  setTriggerEnabled,
  setTriggerSecret,
  type TriggerConfig,
  type TriggerKind,
  type TriggerRecord,
  triggersQueryOptions,
  updateResponsibility,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/responsibilities")({
  component: ResponsibilitiesPage,
});
const fieldClass = "grid gap-1 text-sm";
const selectClass = "h-9 rounded-md border bg-background px-3 text-sm";
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: responsibilityKeys.all });
}

function ResponsibilitiesPage() {
  const { t } = useTranslation("agents");
  const goals = useQuery(responsibilitiesQueryOptions());
  return (
    <PageShell
      title={t("responsibilities.title")}
      description={t("responsibilities.description")}
    >
      <div className="grid gap-6">
        <NewResponsibility />
        {goals.isPending ? (
          <p>{t("responsibilities.loading")}</p>
        ) : goals.error ? (
          <p role="alert" className="text-destructive">
            {goals.error.message}
          </p>
        ) : goals.data?.length ? (
          goals.data.map((goal) => <GoalCard key={goal.id} goal={goal} />)
        ) : (
          <p className="text-muted-foreground">{t("responsibilities.empty")}</p>
        )}
        <GithubSources />
      </div>
    </PageShell>
  );
}

function NewResponsibility() {
  const { t } = useTranslation("agents");
  const formId = useId();
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [channelId, setChannelId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [source, setSource] = useState<
    "none" | ResponsibilityRecord["subscriptions"][number]["source"]
  >("none");
  const [eventType, setEventType] = useState("");
  const selectedChannel = channels.data?.find(
    (channel) => channel.id === channelId,
  );
  const availableBots =
    bots.data?.filter((bot) => selectedChannel?.agentIds.includes(bot.id)) ??
    [];
  const create = useMutation({
    mutationFn: createResponsibility,
    onSuccess: async () => {
      setTitle("");
      setInstruction("");
      setSuccessCriteria("");
      await refresh();
    },
  });
  return (
    <form
      className="grid gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({
          channelId,
          agentId,
          title,
          instruction,
          successCriteria,
          subscriptions: source === "none" ? [] : [{ source, eventType }],
        });
      }}
    >
      <h2 className="font-semibold">{t("responsibilities.new.title")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("responsibilities.new.conversation")}
          <select
            className={selectClass}
            required
            value={channelId}
            onChange={(event) => {
              setChannelId(event.target.value);
              setAgentId("");
            }}
          >
            <option value="">
              {t("responsibilities.new.chooseConversation")}
            </option>
            {channels.data
              ?.filter((channel) => channel.active)
              .map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
          </select>
        </label>
        <label className={fieldClass}>
          {t("responsibilities.new.bot")}
          <select
            className={selectClass}
            required
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">{t("responsibilities.new.chooseBot")}</option>
            {availableBots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {channels.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={() => channels.fetchNextPage()}
        >
          {t("responsibilities.new.loadMore")}
        </Button>
      )}
      {(channels.error || bots.error) && (
        <p role="alert" className="text-destructive">
          {channels.error?.message ?? bots.error?.message}
        </p>
      )}
      <label className={fieldClass} htmlFor={`${formId}-title`}>
        {t("responsibilities.new.titleLabel")}
        <Input
          id={`${formId}-title`}
          required
          maxLength={160}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("responsibilities.new.titlePlaceholder")}
        />
      </label>
      <label className={fieldClass} htmlFor={`${formId}-instruction`}>
        {t("responsibilities.new.instruction")}
        <Textarea
          id={`${formId}-instruction`}
          required
          maxLength={6000}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <label className={fieldClass} htmlFor={`${formId}-criteria`}>
        {t("responsibilities.new.successCriteria")}
        <Textarea
          id={`${formId}-criteria`}
          required
          maxLength={3000}
          value={successCriteria}
          onChange={(event) => setSuccessCriteria(event.target.value)}
          placeholder={t("responsibilities.new.criteriaPlaceholder")}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("responsibilities.new.eventSource")}
          <select
            className={selectClass}
            value={source}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "none" ||
                value === "github" ||
                value === "slack" ||
                value === "connector" ||
                value === "schedule" ||
                value === "manual"
              )
                setSource(value);
            }}
          >
            <option value="none">
              {t("responsibilities.new.source.none")}
            </option>
            <option value="github">GitHub</option>
            <option value="slack">Slack</option>
            <option value="connector">
              {t("responsibilities.new.source.connector")}
            </option>
            <option value="schedule">
              {t("responsibilities.new.source.schedule")}
            </option>
          </select>
        </label>
        {source !== "none" && (
          <label className={fieldClass} htmlFor={`${formId}-event`}>
            {t("responsibilities.new.eventType")}
            <Input
              id={`${formId}-event`}
              required
              maxLength={128}
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              placeholder={
                source === "github"
                  ? "issues.opened"
                  : t("responsibilities.new.eventTypePlaceholder")
              }
            />
          </label>
        )}
      </div>
      {create.error && (
        <p role="alert" className="text-destructive">
          {create.error.message}
        </p>
      )}
      <Button disabled={create.isPending} type="submit">
        {create.isPending
          ? t("responsibilities.new.creating")
          : t("responsibilities.new.create")}
      </Button>
    </form>
  );
}

function GoalCard({ goal }: { goal: ResponsibilityRecord }) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  const [editing, setEditing] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [instruction, setInstruction] = useState(goal.instruction);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const action = useMutation({
    mutationFn: (value: "pause" | "resume" | "complete" | "run") =>
      responsibilityAction(goal.id, value),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: () =>
      updateResponsibility(goal.id, { title, instruction, successCriteria }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const runs = useQuery({
    ...responsibilityRunsQueryOptions(goal.id),
    enabled: showRuns,
  });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{goal.title}</h2>
        <span className="rounded bg-muted px-2 py-1 text-xs capitalize">
          {goal.status}
        </span>
      </div>
      {editing ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate();
          }}
        >
          <label className={fieldClass} htmlFor={`${goal.id}-title`}>
            {t("responsibilities.card.title")}
            <Input
              id={`${goal.id}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={160}
            />
          </label>
          <label className={fieldClass} htmlFor={`${goal.id}-instruction`}>
            {t("responsibilities.card.instruction")}
            <Textarea
              id={`${goal.id}-instruction`}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              required
              maxLength={6000}
            />
          </label>
          <label className={fieldClass} htmlFor={`${goal.id}-criteria`}>
            {t("responsibilities.card.successCriteria")}
            <Textarea
              id={`${goal.id}-criteria`}
              value={successCriteria}
              onChange={(event) => setSuccessCriteria(event.target.value)}
              required
              maxLength={3000}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={edit.isPending}>
              {t("responsibilities.card.save")}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => setEditing(false)}
            >
              {t("responsibilities.card.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">{goal.instruction}</p>
          <p className="text-sm text-muted-foreground">
            {t("responsibilities.card.success", {
              criteria: goal.successCriteria,
            })}
          </p>
        </>
      )}
      {goal.progress && (
        <div className="text-sm">
          <span className="font-medium">
            {t("responsibilities.card.progress")}
          </span>
          <RunMarkdown>{goal.progress}</RunMarkdown>
        </div>
      )}
      {goal.lastResult && (
        <div className="rounded bg-muted p-3 text-sm">
          <RunMarkdown>{goal.lastResult}</RunMarkdown>
        </div>
      )}
      {goal.subscriptions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("responsibilities.card.events", {
            events: goal.subscriptions
              .map(
                (subscription) =>
                  `${subscription.source} · ${subscription.eventType}`,
              )
              .join(", "),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(!editing)}
        >
          {t("responsibilities.card.edit")}
        </Button>
        {goal.status === "active" && (
          <>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => {
                setShowRuns(true);
                action.mutate("run");
              }}
              title={t("responsibilities.card.runNowTitle")}
            >
              {t("responsibilities.card.runNow")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => action.mutate("pause")}
            >
              {t("responsibilities.card.pause")}
            </Button>
          </>
        )}
        {goal.status === "paused" && (
          <Button
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate("resume")}
          >
            {t("responsibilities.card.resume")}
          </Button>
        )}
        {goal.status !== "completed" && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate("complete")}
          >
            {t("responsibilities.card.complete")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowRuns(!showRuns)}
        >
          {showRuns
            ? t("responsibilities.card.hideRuns")
            : t("responsibilities.card.viewRuns")}
        </Button>
        <Link
          to="/channel/$channelId"
          params={{ channelId: goal.channelId }}
          className="self-center text-sm underline"
        >
          {t("responsibilities.card.openConversation")}
        </Link>
      </div>
      {(action.error || edit.error) && (
        <p role="alert" className="text-destructive">
          {action.error?.message ?? edit.error?.message}
        </p>
      )}
      <Triggers goal={goal} />
      {showRuns && (
        <div className="grid gap-2 border-t pt-3">
          {runs.isPending ? (
            <p>{t("responsibilities.runs.loading")}</p>
          ) : runs.error ? (
            <p role="alert">{runs.error.message}</p>
          ) : runs.data?.length ? (
            runs.data.map((run) => (
              <div key={run.id} className="text-sm">
                <p>
                  <span className={runStatusClass(run.status)}>
                    {t(RUN_LABEL[run.status])}
                  </span>{" "}
                  · {formatDateTime(run.createdAt)} ·{" "}
                  <Link
                    to="/channel/$channelId"
                    params={{ channelId: goal.channelId }}
                    className="underline"
                  >
                    {t("responsibilities.runs.openThread")}
                  </Link>
                </p>
                {run.waiting && (
                  <p>
                    {t("responsibilities.runs.waitingFor", {
                      kind: run.waiting.kind,
                    })}
                  </p>
                )}
                {run.error && (
                  <p className="text-muted-foreground">{run.error}</p>
                )}
                {run.replyText && <RunMarkdown>{run.replyText}</RunMarkdown>}
              </div>
            ))
          ) : (
            <p>{t("responsibilities.runs.none")}</p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * A Bot's own words, drawn the way the conversation draws them.
 *
 * Progress, the last result and each run's reply are the Bot's markdown, and shown as plain text
 * they read as literal asterisks and backticks. Same renderer and components as the transcript, kept
 * to the row's size: no heading scale, tight paragraph and list spacing.
 */
function RunMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      mode="static"
    >
      {children}
    </Streamdown>
  );
}

function GithubSources() {
  const { t } = useTranslation("agents");
  const formId = useId();
  const bindings = useQuery(githubBindingsQueryOptions());
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation({
    mutationFn: () => createGithubBinding(repository, secret),
    onSuccess: async () => {
      setSecret("");
      setRepository("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: removeGithubBinding,
    onSuccess: refresh,
  });
  return (
    <section className="grid gap-3 rounded-lg border p-4">
      <h2 className="font-semibold">{t("responsibilities.github.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("responsibilities.github.description")}
      </p>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <label className={fieldClass} htmlFor={`${formId}-repository`}>
          {t("responsibilities.github.repository")}
          <Input
            id={`${formId}-repository`}
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository"
            required
          />
        </label>
        <label className={fieldClass} htmlFor={`${formId}-secret`}>
          {t("responsibilities.github.webhookSecret")}
          <Input
            id={`${formId}-secret`}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
        </label>
        <Button type="submit" className="self-end" disabled={create.isPending}>
          {t("responsibilities.github.connectEvents")}
        </Button>
      </form>
      {(bindings.error || create.error || remove.error) && (
        <p role="alert" className="text-destructive">
          {bindings.error?.message ??
            create.error?.message ??
            remove.error?.message}
        </p>
      )}
      {bindings.data?.map((binding) => (
        <div
          key={binding.id}
          className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
        >
          <div>
            <p className="text-sm">{binding.repository}</p>
            <code className="break-all text-xs">
              {window.location.origin}/api/events/github/{binding.id}
            </code>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate(binding.id)}
          >
            {t("responsibilities.github.disconnect")}
          </Button>
        </div>
      ))}
    </section>
  );
}

const RUN_LABEL = {
  queued: "responsibilities.runStatus.queued",
  running: "responsibilities.runStatus.running",
  waiting: "responsibilities.runStatus.waiting",
  succeeded: "responsibilities.runStatus.succeeded",
  failed: "responsibilities.runStatus.failed",
  skipped: "responsibilities.runStatus.skipped",
} as const satisfies Record<string, string>;
function runStatusClass(status: string) {
  return status === "failed"
    ? "text-destructive"
    : status === "succeeded"
      ? "text-emerald-600 dark:text-emerald-500"
      : "text-muted-foreground";
}

const KIND_LABEL = {
  webhook: "responsibilities.kind.webhook",
  github: "responsibilities.kind.github",
  linear: "responsibilities.kind.linear",
  sentry: "responsibilities.kind.sentry",
  pagerduty: "responsibilities.kind.pagerduty",
  email: "responsibilities.kind.email",
  slack: "responsibilities.kind.slack",
} as const satisfies Record<TriggerKind, string>;
const KIND_HELP = {
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
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation("agents");
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
      {copied ? t("responsibilities.copy.copied") : label}
    </Button>
  );
}

function describeFilter(t: TFunction<"agents">, config: TriggerConfig) {
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
                  .join(t("responsibilities.filter.or")),
              })
            : t("responsibilities.filter.onReactions", {
                list: config.reactions.length
                  ? ` :${config.reactions.join(": :")}:`
                  : "",
              });
    return t("responsibilities.filter.summary", {
      what,
      where,
      teamId: config.teamId,
    });
  }
  const parts = [
    config.filter.eventTypes.length
      ? t("responsibilities.filter.events", {
          events: config.filter.eventTypes.join(", "),
        })
      : t("responsibilities.filter.everyEvent"),
  ];
  if (config.filter.field)
    parts.push(
      t("responsibilities.filter.where", {
        path: config.filter.field.path,
        equals: config.filter.field.equals,
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

function Triggers({ goal }: { goal: ResponsibilityRecord }) {
  const { t } = useTranslation("agents");
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const [adding, setAdding] = useState(false);
  const [freshSecret, setFreshSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const reload = () =>
    queryClient.invalidateQueries({
      queryKey: responsibilityKeys.triggers(goal.id),
    });
  return (
    <section className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">
          {t("responsibilities.triggers.title")}
        </h3>
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => setAdding(!adding)}
        >
          {adding
            ? t("responsibilities.triggers.cancel")
            : t("responsibilities.triggers.addTrigger")}
        </Button>
      </div>
      {goal.status !== "active" && (
        <p className="text-muted-foreground text-xs">
          {t("responsibilities.triggers.inactiveNote", {
            status: goal.status,
          })}
        </p>
      )}
      {adding && (
        <NewTrigger
          goalId={goal.id}
          botId={goal.agentId}
          onCreated={async (created) => {
            setAdding(false);
            if (created.secret)
              setFreshSecret({
                id: created.trigger.id,
                secret: created.secret,
              });
            await reload();
          }}
        />
      )}
      {triggers.error && (
        <p role="alert" className="text-destructive text-sm">
          {triggers.error.message}
        </p>
      )}
      {triggers.data?.length === 0 && !adding && (
        <p className="text-muted-foreground text-xs">
          {t("responsibilities.triggers.none")}
        </p>
      )}
      {triggers.data?.map((trigger) => (
        <TriggerRow
          key={trigger.id}
          trigger={trigger}
          freshSecret={
            freshSecret?.id === trigger.id ? freshSecret.secret : null
          }
          onChanged={async (secret) => {
            if (secret) setFreshSecret({ id: trigger.id, secret });
            await reload();
          }}
        />
      ))}
    </section>
  );
}

function TriggerRow({
  trigger,
  freshSecret,
  onChanged,
}: {
  trigger: TriggerRecord;
  freshSecret: string | null;
  onChanged: (secret: string | null) => Promise<void>;
}) {
  const { t } = useTranslation("agents");
  const [secret, setSecret] = useState<string | null>(freshSecret);
  const [pasted, setPasted] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const shown = freshSecret ?? secret;
  const reveal = useMutation({
    mutationFn: () => revealTriggerSecret(trigger.id),
    onSuccess: setSecret,
  });
  const rotate = useMutation({
    mutationFn: () =>
      setTriggerSecret(
        trigger.id,
        VENDOR_SECRET.has(trigger.kind) ? pasted : undefined,
      ),
    onSuccess: async (result) => {
      setPasted("");
      setSecret(result.secret);
      await onChanged(result.secret);
    },
  });
  const remove = useMutation({
    mutationFn: () => removeTrigger(trigger.id),
    onSuccess: () => onChanged(null),
  });
  const toggle = useMutation({
    mutationFn: () => setTriggerEnabled(trigger.id, !trigger.enabled),
    onSuccess: () => onChanged(null),
  });
  const url = trigger.path ? `${window.location.origin}${trigger.path}` : null;
  const generated = trigger.kind === "webhook" || trigger.kind === "github";
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-medium">{t(KIND_LABEL[trigger.kind])}</span>{" "}
          <span className="text-muted-foreground">
            {describeFilter(t, trigger.config)}
          </span>
          {!trigger.enabled && (
            <span className="ml-2 rounded bg-background px-1.5 py-0.5 text-xs">
              {t("responsibilities.triggers.paused")}
            </span>
          )}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {trigger.enabled
            ? t("responsibilities.triggers.pause")
            : t("responsibilities.triggers.resume")}
        </Button>
        {confirmRemove ? (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
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
          </span>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
          >
            {t("responsibilities.triggers.remove")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t(KIND_HELP[trigger.kind])}
      </p>
      {url && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">
            {t("responsibilities.triggers.postTo")}
          </span>
          <code className="break-all rounded bg-background px-2 py-1 text-xs">
            {url}
          </code>
          <CopyButton value={url} label={t("responsibilities.copy.url")} />
        </div>
      )}
      {trigger.kind === "email" &&
        (trigger.address ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-background px-2 py-1 text-xs">
              {trigger.address}
            </code>
            <CopyButton
              value={trigger.address}
              label={t("responsibilities.copy.address")}
            />
          </div>
        ) : (
          <p className="text-amber-600 text-xs dark:text-amber-500">
            {t("responsibilities.triggers.emailUnconfigured")}
          </p>
        ))}
      {generated && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs">{t("responsibilities.triggers.key")}</span>
          {shown ? (
            <>
              <code className="break-all rounded bg-background px-2 py-1 text-xs">
                {shown}
              </code>
              <CopyButton
                value={shown}
                label={t("responsibilities.copy.key")}
              />
              {trigger.kind === "webhook" && (
                <CopyButton
                  value={`Authorization: Bearer ${shown}`}
                  label={t("responsibilities.copy.header")}
                />
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={reveal.isPending}
              onClick={() => reveal.mutate()}
            >
              {t("responsibilities.triggers.showKey")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {t("responsibilities.triggers.rotateKey")}
          </Button>
        </div>
      )}
      {trigger.kind === "webhook" && shown && (
        <code className="break-all rounded bg-background px-2 py-1 text-xs">
          Authorization: Bearer {shown}
        </code>
      )}
      {VENDOR_SECRET.has(trigger.kind) && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rotate.mutate();
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
              : t("responsibilities.triggers.waitingSecret")}
          </span>
          <Input
            className="h-8 max-w-64"
            type="password"
            autoComplete="new-password"
            placeholder={
              trigger.hasSecret
                ? t("responsibilities.triggers.newSecretPlaceholder")
                : t("responsibilities.triggers.secretPlaceholder")
            }
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            required
          />
          <Button size="sm" type="submit" disabled={rotate.isPending}>
            {t("responsibilities.triggers.saveSecret")}
          </Button>
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
    </div>
  );
}

function NewTrigger({
  goalId,
  botId,
  onCreated,
}: {
  goalId: string;
  botId: string;
  onCreated: (created: {
    trigger: TriggerRecord;
    secret: string | null;
  }) => Promise<void>;
}) {
  const { t } = useTranslation("agents");
  const id = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TriggerKind>("webhook");
  const [eventTypes, setEventTypes] = useState("");
  const [fieldPath, setFieldPath] = useState("");
  const [fieldEquals, setFieldEquals] = useState("");
  const [repository, setRepository] = useState("");
  const [senders, setSenders] = useState("");
  const [secret, setSecret] = useState("");
  const [teamId, setTeamId] = useState("");
  const [mode, setMode] = useState<
    "mention" | "phrase" | "reaction" | "message"
  >("mention");
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
  const create = useMutation({
    mutationFn: () =>
      createTrigger(goalId, {
        config: config(),
        ...(VENDOR_SECRET.has(kind) && secret ? { secret } : {}),
      }),
    onSuccess: async (created) => {
      await onCreated(created);
      /* A new trigger is a new way the shared app gets called, so the approval it needs may
       * have changed: refresh the inbox and this Bot's shared-app notice alongside it. */
      await queryClient.invalidateQueries({
        queryKey: sharedUseKeys.requests(),
      });
    },
  });
  const placeholder = {
    webhook: "responsibilities.placeholder.webhook",
    github: "responsibilities.placeholder.github",
    linear: "responsibilities.placeholder.linear",
    sentry: "responsibilities.placeholder.sentry",
    pagerduty: "responsibilities.placeholder.pagerduty",
    email: "responsibilities.placeholder.email",
    slack: "responsibilities.placeholder.slack",
  } as const satisfies Record<TriggerKind, string>;
  return (
    <form
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <label className={fieldClass}>
        {t("responsibilities.newTrigger.trigger")}
        <select
          className={selectClass}
          value={kind}
          onChange={(event) => setKind(event.target.value as TriggerKind)}
        >
          {(Object.keys(KIND_LABEL) as TriggerKind[]).map((value) => (
            <option key={value} value={value}>
              {t(KIND_LABEL[value])}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-xs">{t(KIND_HELP[kind])}</p>
      {kind === "slack" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={fieldClass} htmlFor={`${id}-team`}>
            {t("responsibilities.newTrigger.teamId")}
            <Input
              id={`${id}-team`}
              required
              placeholder="T0123ABCD"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            {t("responsibilities.newTrigger.fireOn")}
            <select
              className={selectClass}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="mention">
                {t("responsibilities.newTrigger.mode.mention")}
              </option>
              <option value="phrase">
                {t("responsibilities.newTrigger.mode.phrase")}
              </option>
              <option value="reaction">
                {t("responsibilities.newTrigger.mode.reaction")}
              </option>
              <option value="message">
                {t("responsibilities.newTrigger.mode.message")}
              </option>
            </select>
          </label>
          {mode === "phrase" && (
            <label className={fieldClass} htmlFor={`${id}-phrases`}>
              {t("responsibilities.newTrigger.phrases")}
              <Input
                id={`${id}-phrases`}
                required
                value={phrases}
                onChange={(event) => setPhrases(event.target.value)}
              />
            </label>
          )}
          {mode === "reaction" && (
            <label className={fieldClass} htmlFor={`${id}-reactions`}>
              {t("responsibilities.newTrigger.reactions")}
              <Input
                id={`${id}-reactions`}
                placeholder="eyes, rotating_light"
                value={reactions}
                onChange={(event) => setReactions(event.target.value)}
              />
            </label>
          )}
          <label className={fieldClass} htmlFor={`${id}-channels`}>
            {t("responsibilities.newTrigger.channels")}
            <Input
              id={`${id}-channels`}
              placeholder="C0123ABCD"
              value={channels}
              onChange={(event) => setChannels(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={fieldClass} htmlFor={`${id}-types`}>
            {t("responsibilities.newTrigger.eventTypes")}
            <Input
              id={`${id}-types`}
              placeholder={t(placeholder[kind])}
              value={eventTypes}
              onChange={(event) => setEventTypes(event.target.value)}
            />
          </label>
          <label className={fieldClass} htmlFor={`${id}-path`}>
            {t("responsibilities.newTrigger.field")}
            <Input
              id={`${id}-path`}
              placeholder="data.team.key"
              value={fieldPath}
              onChange={(event) => setFieldPath(event.target.value)}
            />
          </label>
          <label className={fieldClass} htmlFor={`${id}-equals`}>
            {t("responsibilities.newTrigger.equals")}
            <Input
              id={`${id}-equals`}
              placeholder="ENG"
              value={fieldEquals}
              onChange={(event) => setFieldEquals(event.target.value)}
            />
          </label>
          {kind === "github" && (
            <label className={fieldClass} htmlFor={`${id}-repo`}>
              {t("responsibilities.newTrigger.repository")}
              <Input
                id={`${id}-repo`}
                placeholder="owner/name"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
          )}
          {kind === "email" && (
            <label className={fieldClass} htmlFor={`${id}-senders`}>
              {t("responsibilities.newTrigger.senders")}
              <Input
                id={`${id}-senders`}
                placeholder="ops@example.com, example.com"
                value={senders}
                onChange={(event) => setSenders(event.target.value)}
              />
            </label>
          )}
          {VENDOR_SECRET.has(kind) && (
            <label className={fieldClass} htmlFor={`${id}-secret`}>
              {t("responsibilities.newTrigger.signingSecret")}
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
          )}
        </div>
      )}
      <SharedAppNotice botId={botId} reason="trigger" />
      {create.error && (
        <p role="alert" className="text-destructive text-sm">
          {create.error.message}
        </p>
      )}
      <Button type="submit" disabled={create.isPending}>
        {create.isPending
          ? t("responsibilities.newTrigger.adding")
          : t("responsibilities.newTrigger.addKind", {
              kind: t(KIND_LABEL[kind]),
            })}
      </Button>
    </form>
  );
}
