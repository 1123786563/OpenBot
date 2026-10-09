import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelAvatar } from "@/components/channels/avatar";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  assignTeamBotMutationOptions,
  clearTeamBotConsentsMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";

/**
 * Team Bots: find the Bots teammates published, publish your own to the team or to named people and
 * groups, and (administrators) put one in a group's sidebars. A chat with a Team Bot is always the
 * teammate's own; its owner cannot read it.
 */
export const Route = createFileRoute("/_authed/_app/team-bots")({
  component: TeamBotsPage,
});

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function TeamBotsPage() {
  const { t } = useTranslation("agents");
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  const bots = data.data?.teamBots ?? [];
  const shared = bots.filter((bot) => !bot.mine);
  const mine = bots.filter((bot) => bot.mine);

  return (
    <PageShell
      description={t("teamBots.description")}
      title={t("teamBots.title")}
      width="wide"
    >
      {data.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {data.error.message}
        </p>
      ) : null}
      <PageSection title={t("teamBots.available")}>
        {shared.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("teamBots.nonePublished")}
          </p>
        ) : (
          shared.map((bot) => <TeamBotRow bot={bot} key={bot.id} />)
        )}
      </PageSection>
      <PageSection title={t("teamBots.yours")}>
        {mine.map((bot) => (
          <div className="flex flex-col gap-2" key={bot.id}>
            <TeamBotRow bot={bot} />
            <PublishForm botId={bot.id} current={bot} />
          </div>
        ))}
        {(data.data?.publishable ?? []).length ? (
          <PublishNew publishable={data.data?.publishable ?? []} />
        ) : mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("teamBots.noneToPublish")}
          </p>
        ) : null}
      </PageSection>
      {me?.role === "admin" ? (
        <PageSection title={t("teamBots.assignTitle")}>
          <p className="text-sm text-muted-foreground">
            {t("teamBots.assignDescription")}
          </p>
          {bots.map((bot) => (
            <Assignments bot={bot} key={bot.id} />
          ))}
        </PageSection>
      ) : null}
      <PageSection title={t("teamBots.accounts")}>
        <p className="text-sm text-muted-foreground">
          {t("teamBots.accountsDescription")}
        </p>
        <div className="flex items-center gap-2">
          <Button
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
            size="sm"
            variant="outline"
          >
            {t("teamBots.clearPreferences")}
          </Button>
          {clear.isSuccess ? (
            <span className="text-sm text-muted-foreground" role="status">
              {t("teamBots.cleared")}
            </span>
          ) : null}
        </div>
      </PageSection>
    </PageShell>
  );
}

function TeamBotRow({ bot }: { bot: TeamBot }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
      data-team-bot={bot.id}
    >
      <ChannelAvatar participantIds={[bot.id]} size={28} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{bot.name}</span>
        <span className="truncate text-sm text-muted-foreground">
          {bot.title}
          {bot.assigned ? t("teamBots.row.assignedToYou") : ""}
          {bot.mine && !bot.visibleToTeam
            ? t("teamBots.row.hiddenFromTeammates")
            : ""}
          {bot.mine
            ? bot.audience === "team"
              ? t("teamBots.row.publishedToTeam")
              : t("teamBots.row.publishedTo", {
                  list: [
                    ...(bot.people ?? []),
                    ...(bot.groups ?? []).map((group) =>
                      t("teamBots.row.groupLabel", { group }),
                    ),
                  ].join(", "),
                })
            : ""}
        </span>
      </div>
      <Button
        render={(props) => (
          <Link {...props} search={{ agent: bot.id }} to="/channel/new" />
        )}
        size="sm"
      >
        {t("teamBots.row.startPrivateChat")}
      </Button>
      <Button
        onClick={() =>
          void navigator.clipboard
            .writeText(teamBotLink(bot.id))
            .then(() => setCopied(true))
        }
        size="sm"
        variant="outline"
      >
        {copied ? t("teamBots.row.copied") : t("teamBots.row.copyLink")}
      </Button>
      {bot.mine ? (
        <Button
          disabled={unpublish.isPending}
          onClick={() => unpublish.mutate(bot.id)}
          size="sm"
          variant="ghost"
        >
          {t("teamBots.row.unpublish")}
        </Button>
      ) : null}
    </div>
  );
}

function PublishNew({
  publishable,
}: {
  publishable: { id: string; name: string }[];
}) {
  const { t } = useTranslation("agents");
  const [botId, setBotId] = useState(publishable[0]?.id ?? "");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <label className="grid gap-1 text-sm">
        {t("teamBots.publishNew")}
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          onChange={(event) => setBotId(event.target.value)}
          value={botId}
        >
          {publishable.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {botId ? <PublishForm botId={botId} key={botId} /> : null}
    </div>
  );
}

/** Who a Bot is published to: the whole team, or named people and groups. */
function PublishForm({ botId, current }: { botId: string; current?: TeamBot }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const publish = useMutation(publishTeamBotMutationOptions(queryClient));
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        publish.mutate({
          botId,
          audience,
          emails: audience === "people" ? list(emails) : [],
          groups: audience === "people" ? list(groups) : [],
        });
      }}
    >
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "team"}
            name={`audience-${botId}`}
            onChange={() => setAudience("team")}
            type="radio"
          />
          {t("teamBots.publishForm.wholeTeam")}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            checked={audience === "people"}
            name={`audience-${botId}`}
            onChange={() => setAudience("people")}
            type="radio"
          />
          {t("teamBots.publishForm.specificPeople")}
        </label>
      </div>
      {audience === "people" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            aria-label={t("teamBots.publishForm.peopleAria")}
            onChange={(event) => setEmails(event.target.value)}
            placeholder={t("teamBots.publishForm.peoplePlaceholder")}
            value={emails}
          />
          <Input
            aria-label={t("teamBots.publishForm.groupsAria")}
            onChange={(event) => setGroups(event.target.value)}
            placeholder={t("teamBots.publishForm.groupsPlaceholder")}
            value={groups}
          />
        </div>
      ) : null}
      <SharedAppNotice botId={botId} reason="publish" />
      <div className="flex items-center gap-2">
        <Button disabled={publish.isPending} size="sm" type="submit">
          {current
            ? t("teamBots.publishForm.update")
            : t("teamBots.publishForm.publish")}
        </Button>
        {publish.error ? (
          <span className="text-sm text-destructive" role="alert">
            {publish.error.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function Assignments({ bot }: { bot: TeamBot }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const [group, setGroup] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{bot.name}</span>
      {(bot.assignments ?? []).map((name) => (
        <Button
          aria-label={t("teamBots.assignments.removeAria", { name })}
          key={name}
          onClick={() =>
            assign.mutate({ botId: bot.id, group: name, remove: true })
          }
          size="sm"
          variant="outline"
        >
          {name === "*" ? t("teamBots.assignments.wholeTeam") : name} ×
        </Button>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          assign.mutate(
            { botId: bot.id, group },
            { onSuccess: () => setGroup("") },
          );
        }}
      >
        <Input
          aria-label={t("teamBots.assignments.assignAria", { bot: bot.name })}
          className="w-40"
          onChange={(event) => setGroup(event.target.value)}
          placeholder={t("teamBots.assignments.groupPlaceholder")}
          value={group}
        />
        <Button
          disabled={!group.trim() || assign.isPending}
          size="sm"
          type="submit"
        >
          {t("teamBots.assignments.assign")}
        </Button>
      </form>
      {assign.error ? (
        <span className="text-destructive" role="alert">
          {assign.error.message}
        </span>
      ) : null}
    </div>
  );
}
