import {
  IconChevronRight,
  IconLink,
  IconPlus,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Fragment, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import { countLabel } from "@/lib/agents/bot-summaries";
import type { AgentProfile } from "@/lib/agents/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  assignTeamBotMutationOptions,
  publishTeamBotMutationOptions,
  type TeamBot,
  type TeamBotsData,
  teamBotLink,
  scopedTeamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Who else can use this Bot. Its owner publishes it to the whole team or to named people and groups;
 * an administrator can also pin it at the top of a group's Bots lists. Each chat with a published
 * Bot is private to the person having it; its owner cannot read it.
 *
 * Every action here is offered because the SERVER says this person may take it (MT085): the
 * publication rows carry `canUnpublish` and `canAssign`, the publish list (`publishable`) is the
 * server's own answer, and the audience choices are the ranges the server names. No gate in this
 * file re-derives permission from an ownership flag or a role — a capability the server did not
 * answer does not exist here.
 */
export function SharingSections({ agent }: { agent: AgentProfile }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const data = useQuery(scopedTeamBotsQueryOptions(queryClient, scope));
  const unpublish = useMutation(
    unpublishTeamBotMutationOptions(queryClient, scope),
  );
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  if (data.isPending) return null;
  if (data.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {data.error.message}
      </p>
    );
  }
  const published = data.data.teamBots.find((bot) => bot.id === agent.id);
  const publishable = data.data.publishable.some((bot) => bot.id === agent.id);
  // Who may change the publication at all: the server's own answers — an unpublished Bot of this
  // person's (the publishable list), or a published one this person may re-aim. An administrator
  // who may only retire a publication does not get an aim of their own.
  const mayPublish = publishable || published?.canEditPublication === true;

  return (
    <>
      <PageSection title={t("sharing.publishedTitle")}>
        {unpublish.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {unpublish.error.message}
          </p>
        ) : null}
        {published ? (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsersGroup />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {published.audience === "team"
                    ? t("sharing.toWholeTeam")
                    : t("sharing.toList", {
                        list: [
                          ...(published.people ?? []),
                          ...(published.groups ?? []).map((group) =>
                            t("teamBots.row.groupLabel", { group }),
                          ),
                        ].join(", "),
                      })}
                </ItemTitle>
                <ItemDescription>
                  {published.visibleToTeam
                    ? t("sharing.privateChats")
                    : t("sharing.hiddenDraft")}
                </ItemDescription>
              </ItemContent>
              {published.canUnpublish ? (
                <ItemActions>
                  <Button
                    disabled={unpublish.isPending}
                    onClick={() => unpublish.mutate(agent.id)}
                    size="sm"
                    variant="outline"
                  >
                    {t("teamBots.row.unpublish")}
                  </Button>
                </ItemActions>
              ) : null}
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconLink />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("sharing.link")}</ItemTitle>
                <ItemDescription>
                  {t("sharing.linkDescription")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(teamBotLink(agent.id))
                      .then(() => setCopied(true))
                  }
                  size="sm"
                  variant="outline"
                >
                  {copied
                    ? t("teamBots.row.copied")
                    : t("teamBots.row.copyLink")}
                </Button>
              </ItemActions>
            </Item>
          </PageRows>
        ) : (
          <PageEmpty>
            {agent.visibility === "public"
              ? t("sharing.notPublishedPublic")
              : agent.mine
                ? t("sharing.notPublishedMine")
                : t("sharing.notPublished")}
          </PageEmpty>
        )}
      </PageSection>
      {mayPublish ? (
        <PageSection
          description={t("sharing.publishNote")}
          title={
            published ? t("sharing.publishedToTitle") : t("sharing.publish")
          }
        >
          {/* More than one value — an audience, then people and groups — so a summary row and a
              dialog rather than a form on the page. */}
          <PageRows>
            <Item
              render={
                <button onClick={() => setPublishing(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconUsersGroup />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("sharing.audience")}</ItemTitle>
                <ItemDescription>
                  {audienceSummary(published, t)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
          {publishing ? (
            <PublishDialog
              audiences={data.data.publishAudiences}
              botId={agent.id}
              current={published}
              onClose={() => setPublishing(false)}
            />
          ) : null}
        </PageSection>
      ) : null}
      {published?.canAssign === true ? (
        <PageSection
          description={t("sharing.assignDescription")}
          title={t("teamBots.assignTitle")}
        >
          <Assignments bot={published} />
        </PageSection>
      ) : null}
    </>
  );
}

/** The current answer on the Audience row: who it is published to, as a count. */
function audienceSummary(
  current: TeamBot | undefined,
  t: TFunction<"agents">,
): string {
  if (!current) return t("sharing.notPublished");
  if (current.audience === "team") return t("teamBots.publishForm.wholeTeam");
  const parts = [
    countLabel(
      current.people?.length ?? 0,
      t("sharing.person"),
      t("sharing.people"),
      "",
    ),
    countLabel(
      current.groups?.length ?? 0,
      t("sharing.group"),
      t("sharing.groups"),
      "",
    ),
  ].filter(Boolean);
  return parts.length
    ? parts.join(", ")
    : t("teamBots.publishForm.specificPeople");
}

/**
 * Who a Bot is published to: the whole team, or named people and groups. Mounted only while open,
 * so each opening starts from the current answer rather than from an abandoned edit.
 *
 * The choices offered are the ranges the server named in the list answer — never a wider set of
 * this file's own invention, and never a cross-company one, which the design does not have (MT085
 * AC2). A stored audience the server no longer offers falls back to the first range it does.
 */
function PublishDialog({
  audiences: offered,
  botId,
  current,
  onClose,
}: {
  audiences: TeamBotsData["publishAudiences"];
  botId: string;
  current?: TeamBot;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const formId = useId();
  const audiences = Object.fromEntries(
    offered.map((value) => [
      value,
      value === "team"
        ? t("teamBots.publishForm.wholeTeam")
        : t("teamBots.publishForm.specificPeople"),
    ]),
  ) as Record<string, string>;
  const publish = useMutation(
    publishTeamBotMutationOptions(queryClient, scope),
  );
  const [audience, setAudience] = useState<"team" | "people">(
    offered.includes(current?.audience ?? "team")
      ? (current?.audience ?? "team")
      : (offered[0] ?? "team"),
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {current ? t("sharing.publishedToTitle") : t("sharing.publish")}
          </DialogTitle>
          <DialogDescription>{t("sharing.publishNote")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              publish.mutate(
                {
                  botId,
                  audience,
                  emails: audience === "people" ? list(emails) : [],
                  groups: audience === "people" ? list(groups) : [],
                },
                {
                  onError: () => {
                    requestAnimationFrame(() =>
                      audienceTrigger.current?.focus(),
                    );
                  },
                  onSuccess: onClose,
                },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-audience`}>
                  {t("sharing.publishedToLabel")}
                </FieldLabel>
                <Select
                  items={audiences}
                  onValueChange={(value) => {
                    // Only a range the server named may be chosen; anything else is not a value
                    // this form knows, so it changes nothing.
                    if (value === "team" || value === "people") {
                      if (offered.includes(value)) setAudience(value);
                    }
                  }}
                  value={audience}
                >
                  <SelectTrigger
                    className="w-full"
                    id={`${formId}-audience`}
                    ref={audienceTrigger}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(audiences) as (keyof typeof audiences)[]).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {audiences[value]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </Field>
              {audience === "people" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-people`}>
                      {t("teamBots.publishForm.peopleAria")}
                    </FieldLabel>
                    <Input
                      id={`${formId}-people`}
                      onChange={(event) => setEmails(event.target.value)}
                      placeholder={t("sharing.commaSeparated")}
                      value={emails}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-groups`}>
                      {t("teamBots.publishForm.groupsAria")}
                    </FieldLabel>
                    <Input
                      id={`${formId}-groups`}
                      onChange={(event) => setGroups(event.target.value)}
                      placeholder={t("sharing.commaSeparated")}
                      value={groups}
                    />
                  </Field>
                </>
              ) : null}
              <SharedAppNotice botId={botId} reason="publish" />
            </FieldGroup>
          </form>
          {publish.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {publish.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("sharing.cancel")}
          </Button>
          <Button
            disabled={publish.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {current
              ? t("teamBots.publishForm.update")
              : t("teamBots.publishForm.publish")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The groups an administrator has pinned this Bot for: one row each with a Remove, and a row that
 * opens a dialog to add one.
 */
function Assignments({ bot }: { bot: TeamBot }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const remove = useMutation(
    assignTeamBotMutationOptions(queryClient, scope),
  );
  const [assigning, setAssigning] = useState(false);
  const assigned = bot.assignments ?? [];
  return (
    <>
      {remove.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}
      {assigned.length === 0 ? (
        <PageEmpty>{t("sharing.notAssigned")}</PageEmpty>
      ) : null}
      <PageRows>
        {assigned.map((name) => (
          <Fragment key={name}>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsers />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {name === "*" ? t("teamBots.assignments.wholeTeam") : name}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={t("teamBots.assignments.removeAria", { name })}
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({ botId: bot.id, group: name, remove: true })
                  }
                  size="sm"
                  variant="outline"
                >
                  {t("sharing.remove")}
                </Button>
              </ItemActions>
            </Item>
            <Separator />
          </Fragment>
        ))}
        <Item
          render={<button onClick={() => setAssigning(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconPlus />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("sharing.assignTo")}</ItemTitle>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {assigning ? (
        <AssignDialog bot={bot} onClose={() => setAssigning(false)} />
      ) : null}
    </>
  );
}

/** One group to pin this Bot for, or * for the whole team. */
function AssignDialog({ bot, onClose }: { bot: TeamBot; onClose: () => void }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const formId = useId();
  const assign = useMutation(
    assignTeamBotMutationOptions(queryClient, scope),
  );
  const [group, setGroup] = useState("");
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("sharing.assignDialog", { name: bot.name })}
          </DialogTitle>
          <DialogDescription>
            {t("sharing.assignDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              assign.mutate({ botId: bot.id, group }, { onSuccess: onClose });
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-group`}>
                {t("teamBots.assignments.groupPlaceholder")}
              </FieldLabel>
              <Input
                id={`${formId}-group`}
                onChange={(event) => setGroup(event.target.value)}
                placeholder={t("sharing.wholeTeamPlaceholder")}
                value={group}
              />
            </Field>
          </form>
          {assign.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {assign.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("sharing.cancel")}
          </Button>
          <Button
            disabled={!group.trim() || assign.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {t("teamBots.assignments.assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
