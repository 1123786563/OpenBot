import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  createProactiveSetting,
  type ProactiveSetting,
  proactiveKeys,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  removeProactiveSetting,
  resolveSuggestion,
  runProactiveNow,
  updateProactiveSetting,
} from "@/lib/proactive";
import { queryClient } from "@/query-client";

const field = "grid gap-1 text-sm";
const select = "h-9 rounded-md border bg-background px-3 text-sm";
const intervals = [
  { minutes: 60, label: "proactive.interval.hour" },
  { minutes: 240, label: "proactive.interval.fourHours" },
  { minutes: 720, label: "proactive.interval.twiceADay" },
  { minutes: 1440, label: "proactive.interval.daily" },
] as const satisfies readonly { minutes: number; label: string }[];
async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proactiveKeys.settings }),
    queryClient.invalidateQueries({ queryKey: proactiveKeys.suggestions }),
  ]);
}

/** Next steps a Bot proposed from background research: start one as a task, or dismiss it. */
export function SuggestionsInbox() {
  const { t } = useTranslation("agents");
  const dateTime = useDateTime();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "start" | "dismiss" }) =>
      resolveSuggestion(id, action),
    onSuccess: refresh,
  });
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? t("proactive.yourBot");
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">{t("proactive.suggestedTitle")}</h2>
      {suggestions.isPending ? (
        <p>{t("proactive.loading")}</p>
      ) : suggestions.error ? (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {suggestions.error.message}
        </p>
      ) : suggestions.data?.length ? (
        suggestions.data.map((suggestion) => (
          <article
            key={suggestion.id}
            className="grid gap-2 rounded-lg border p-4"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{suggestion.title}</strong>
              <span className="text-xs text-muted-foreground">
                {botName(suggestion.agentId)} ·{" "}
                {dateTime.formatDateTime(suggestion.createdAt)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap">{suggestion.detail}</p>
            {(suggestion.sourceApp || suggestion.sourceLink) && (
              <p className="text-xs text-muted-foreground">
                {t("proactive.from", {
                  source: suggestion.sourceApp ?? t("proactive.aConnectedApp"),
                })}
                {suggestion.sourceLink && (
                  <>
                    {" · "}
                    <a
                      className="text-sm underline-offset-4 hover:underline"
                      href={suggestion.sourceLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("proactive.openRecord")}
                    </a>
                  </>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "start" })
                }
              >
                {t("proactive.startAsTask")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({ id: suggestion.id, action: "dismiss" })
                }
              >
                {t("proactive.dismiss")}
              </Button>
            </div>
          </article>
        ))
      ) : (
        <p className="text-muted-foreground">{t("proactive.none")}</p>
      )}
      {act.error && (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {act.error.message}
        </p>
      )}
    </section>
  );
}

/** Opt a Bot in to read-only background research of the apps it can already read. */
export function ProactiveResearchSettings() {
  const { t } = useTranslation("agents");
  const settings = useQuery(proactiveSettingsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [focus, setFocus] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(240);
  const id = useId();
  const eligibleChannels = (channels.data ?? []).filter(
    (channel) => channel.active && channel.agentIds.includes(agentId),
  );
  const add = useMutation({
    mutationFn: createProactiveSetting,
    onSuccess: async () => {
      setFocus("");
      await refresh();
    },
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">{t("proactive.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("proactive.intro")}</p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate({ agentId, channelId, focus, intervalMinutes });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={field}>
            {t("proactive.botLabel")}
            <select
              required
              className={select}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setChannelId("");
              }}
            >
              <option value="">{t("proactive.chooseBot")}</option>
              {bots.data?.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("proactive.deliverTo")}
            <select
              required
              className={select}
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
            >
              <option value="">{t("proactive.chooseChannel")}</option>
              {eligibleChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("proactive.howOften")}
            <select
              className={select}
              value={intervalMinutes}
              onChange={(event) =>
                setIntervalMinutes(Number(event.target.value))
              }
            >
              {intervals.map((interval) => (
                <option key={interval.minutes} value={interval.minutes}>
                  {t(interval.label)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={field} htmlFor={`${id}-focus`}>
          {t("proactive.focusLabel")}
          <Input
            id={`${id}-focus`}
            maxLength={1000}
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder={t("proactive.focusPlaceholder")}
          />
        </label>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !agentId || !channelId}
        >
          {t("proactive.turnOnResearch")}
        </Button>
        {add.error && (
          <p role="alert" className="mt-2 text-destructive text-sm">
            {add.error.message}
          </p>
        )}
      </form>
      {settings.error && (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {settings.error.message}
        </p>
      )}
      {settings.data?.map((setting) => (
        <SettingRow
          key={setting.id}
          setting={setting}
          botName={
            bots.data?.find((bot) => bot.id === setting.agentId)?.name ??
            setting.agentId
          }
        />
      ))}
    </section>
  );
}

function SettingRow({
  setting,
  botName,
}: {
  setting: ProactiveSetting;
  botName: string;
}) {
  const { t } = useTranslation("agents");
  const dateTime = useDateTime();
  const change = useMutation({
    mutationFn: (
      action:
        | { kind: "toggle" }
        | { kind: "run" }
        | { kind: "remove" }
        | { kind: "interval"; minutes: number },
    ) =>
      action.kind === "run"
        ? runProactiveNow(setting.id)
        : action.kind === "remove"
          ? removeProactiveSetting(setting.id)
          : updateProactiveSetting(
              setting.id,
              action.kind === "toggle"
                ? { enabled: !setting.enabled }
                : { intervalMinutes: action.minutes },
            ),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <strong>{botName}</strong>
        <span className="text-sm text-muted-foreground">
          {!setting.enabled
            ? t("proactive.off")
            : setting.lastStatus === "running"
              ? t("proactive.researchingNow")
              : t("proactive.next", {
                  date: dateTime.formatDateTime(setting.nextRunAt),
                })}
        </span>
      </div>
      {setting.focus && <p className="text-sm">{setting.focus}</p>}
      {setting.lastRunAt && (
        <p className="text-xs text-muted-foreground">
          {t("proactive.lastRan", {
            date: dateTime.formatDateTime(setting.lastRunAt),
          })}
          {setting.lastStatus === "succeeded" ? "" : ` (${setting.lastStatus})`}
        </p>
      )}
      {setting.lastError && (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {setting.lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("proactive.howOften")}
          className={select}
          value={setting.intervalMinutes}
          onChange={(event) =>
            change.mutate({
              kind: "interval",
              minutes: Number(event.target.value),
            })
          }
        >
          {intervals.map((interval) => (
            <option key={interval.minutes} value={interval.minutes}>
              {t(interval.label)}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={!setting.enabled || change.isPending}
          onClick={() => change.mutate({ kind: "run" })}
        >
          {t("proactive.runNow")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "toggle" })}
        >
          {setting.enabled ? t("proactive.turnOff") : t("proactive.turnOn")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={change.isPending}
          onClick={() => change.mutate({ kind: "remove" })}
        >
          {t("proactive.remove")}
        </Button>
      </div>
      {change.error && (
        <p role="alert" className="mt-2 text-destructive text-sm">
          {change.error.message}
        </p>
      )}
    </article>
  );
}
