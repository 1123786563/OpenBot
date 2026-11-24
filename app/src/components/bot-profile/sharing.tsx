import {
  IconChevronRight,
  IconLink,
  IconPlus,
  IconShare,
  IconUsers,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import {
  ActionIncomplete,
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ClientError } from "@/lib/client";
import {
  assignTeamBotMutationOptions,
  loadTeamBots,
  publishTeamBotMutationOptions,
  type TeamBot,
  teamBotLink,
  teamBotsQueryOptions,
  unpublishTeamBotMutationOptions,
} from "@/lib/team-bots";
import { queryClient } from "@/query-client";
import { BotDetailDialog, BotDetailFormAction } from "./detail-surface";

const list = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Who else can use this Bot. Its owner publishes it to the whole team or to named people and groups;
 * an administrator can also pin it at the top of a group's Bots lists. Each chat with a published
 * Bot is private to the person having it; its owner cannot read it.
 */
export function SharingSections({ agent }: { agent: AgentProfile }) {
  const data = useQuery(teamBotsQueryOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const unpublish = useMutation(unpublishTeamBotMutationOptions(queryClient));
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const [publishing, setPublishing] = useState(false);
  if (data.isPending) {
    return (
      <>
        {confirmation}
        <ReadStatus kind="loading" message="Loading Bot sharing…" />
      </>
    );
  }
  if (data.error) {
    return (
      <>
        {confirmation}
        <ReadError
          message="Couldn’t load Bot sharing"
          retry={() => data.refetch()}
          retryBelow
          retrying={data.isFetching}
        />
      </>
    );
  }
  const published = data.data.teamBots.find((bot) => bot.id === agent.id);
  const publishable = data.data.publishable.some((bot) => bot.id === agent.id);

  return (
    <>
      {confirmation}
      <PageSection title="Published">
        {published ? (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsersGroup />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="line-clamp-none">
                  {published.audience === "team"
                    ? "To the whole team"
                    : `To ${[...(published.people ?? []), ...(published.groups ?? []).map((group) => `group ${group}`)].join(", ")}`}
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {published.visibleToTeam
                    ? "Each person's conversations with it are private."
                    : "Teammates can't see it until it has a real name and a description."}
                </ItemDescription>
              </ItemContent>
              {agent.mine ? (
                <ItemActions>
                  <Button
                    className="confirmation-action"
                    onClick={(event) =>
                      requestConfirmation({
                        title: `Unpublish ${agent.name}?`,
                        description: `This removes team publishing for ${audienceSummary(published).toLowerCase()}. The Bot’s visibility setting stays the same.`,
                        confirmLabel: "Unpublish Bot",
                        pendingLabel: "Unpublishing…",
                        failureMessage:
                          "Couldn’t unpublish the Bot. Try again.",
                        successMessage: `${agent.name} was unpublished.`,
                        refresh: () => data.refetch(),
                        trigger: event.currentTarget,
                        run: async () => {
                          const latest = await readPublication(agent.id);
                          if (!latest || !sameAudience(published, latest)) {
                            throw new ActionUnavailable(
                              "Publishing has changed. Close this dialog and review the current audience.",
                            );
                          }
                          await unpublish.mutateAsync(agent.id);
                        },
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    Unpublish
                  </Button>
                </ItemActions>
              ) : null}
            </Item>
            <Separator />
            <SharingLink botId={agent.id} />
          </PageRows>
        ) : (
          <PageEmpty
            icon={IconShare}
            title={
              agent.visibility === "public"
                ? "Not published to the team"
                : "Not published"
            }
          >
            {agent.visibility === "public"
              ? "It's public, so everyone on OpenBot can already use it."
              : agent.mine
                ? "Only you can use it."
                : null}
          </PageEmpty>
        )}
      </PageSection>
      {agent.mine && (published || publishable) ? (
        <PageSection
          description="Publishing doesn't change its visibility. You can unpublish at any time."
          title={published ? "Who it is published to" : "Publish"}
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
                <ItemTitle>Audience</ItemTitle>
                <ItemDescription>{audienceSummary(published)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
          {publishing ? (
            <PublishDialog
              botId={agent.id}
              current={published}
              onClose={() => setPublishing(false)}
            />
          ) : null}
        </PageSection>
      ) : null}
      {me?.role === "admin" && published ? (
        <PageSection
          description="Pin this Bot in the Bots list for a group or the whole team."
          title="Assignments"
        >
          <Assignments bot={published} />
        </PageSection>
      ) : null}
    </>
  );
}

async function readPublication(botId: string) {
  try {
    const { teamBots } = await loadTeamBots();
    return teamBots.find((bot) => bot.id === botId);
  } catch (error) {
    if (error instanceof ClientError && error.status < 500) throw error;
    throw new ActionIncomplete(
      "Couldn’t check the current audience. Try again before unpublishing.",
    );
  }
}

function samePeopleOrGroups(previous: string[] = [], current: string[] = []) {
  return (
    previous.length === current.length &&
    previous.every((value) => current.includes(value))
  );
}

function sameAudience(previous: TeamBot, current: TeamBot) {
  return (
    current.mine &&
    previous.publishedAt === current.publishedAt &&
    previous.audience === current.audience &&
    samePeopleOrGroups(previous.people, current.people) &&
    samePeopleOrGroups(previous.groups, current.groups)
  );
}

function SharingLink({ botId }: { botId: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const link = teamBotLink(botId);
  const linkId = useId();
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }

  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconLink />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Link</ItemTitle>
          <ItemDescription className="line-clamp-none" role="status">
            {copyState === "copied"
              ? "Link copied."
              : copyState === "manual"
                ? "Couldn’t copy automatically. Copy the link below."
                : "Opens a private conversation with it."}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            className="confirmation-action"
            onClick={() => void copyLink()}
            size="sm"
            variant="outline"
          >
            Copy link
          </Button>
        </ItemActions>
      </Item>
      {copyState === "manual" ? (
        <Item size="sm">
          <ItemContent>
            <Field>
              <FieldLabel htmlFor={linkId}>Conversation link</FieldLabel>
              <Input
                id={linkId}
                onFocus={(event) => event.target.select()}
                readOnly
                value={link}
              />
            </Field>
          </ItemContent>
        </Item>
      ) : null}
    </>
  );
}

/** The current answer on the Audience row: who it is published to, as a count. */
function audienceSummary(current: TeamBot | undefined): string {
  if (!current) return "Not published";
  if (current.audience === "team") return "The whole team";
  const parts = [
    countLabel(current.people?.length ?? 0, "person", "people", ""),
    countLabel(current.groups?.length ?? 0, "group", "groups", ""),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Specific people or groups";
}

const AUDIENCES = {
  team: "The whole team",
  people: "Specific people or groups",
} as const;

/**
 * Who a Bot is published to: the whole team, or named people and groups. Mounted only while open,
 * so each opening starts from the current answer rather than from an abandoned edit.
 */
function PublishDialog({
  botId,
  current,
  onClose,
}: {
  botId: string;
  current?: TeamBot;
  onClose: () => void;
}) {
  const formId = useId();
  const publish = useMutation(publishTeamBotMutationOptions(queryClient));
  const [audience, setAudience] = useState<"team" | "people">(
    current?.audience ?? "team",
  );
  const [emails, setEmails] = useState((current?.people ?? []).join(", "));
  const [groups, setGroups] = useState((current?.groups ?? []).join(", "));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <BotDetailDialog>
        <DialogHeader>
          <DialogTitle>
            {current ? "Who it is published to" : "Publish"}
          </DialogTitle>
          <DialogDescription>
            Publishing doesn't change its visibility. You can unpublish at any
            time.
          </DialogDescription>
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
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-audience`}>
                  Published to
                </FieldLabel>
                <Select
                  items={AUDIENCES}
                  onValueChange={(value) => {
                    if (value === "team" || value === "people") {
                      setAudience(value);
                    }
                  }}
                  value={audience}
                >
                  <SelectTrigger className="w-full" id={`${formId}-audience`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent {...astryxScope}>
                    {(Object.keys(AUDIENCES) as (keyof typeof AUDIENCES)[]).map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {AUDIENCES[value]}
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
                      People, by email
                    </FieldLabel>
                    <Input
                      id={`${formId}-people`}
                      onChange={(event) => setEmails(event.target.value)}
                      placeholder="Comma separated"
                      value={emails}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${formId}-groups`}>Groups</FieldLabel>
                    <Input
                      id={`${formId}-groups`}
                      onChange={(event) => setGroups(event.target.value)}
                      placeholder="Comma separated"
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
          <BotDetailFormAction
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancel
          </BotDetailFormAction>
          <BotDetailFormAction
            disabled={publish.isPending}
            form={formId}
            type="submit"
          >
            {current ? "Update" : "Publish to team"}
          </BotDetailFormAction>
        </DialogFooter>
      </BotDetailDialog>
    </Dialog>
  );
}

/**
 * The groups an administrator has pinned this Bot for: one row each with a Remove, and a row that
 * opens a dialog to add one.
 */
function Assignments({ bot }: { bot: TeamBot }) {
  const remove = useMutation(assignTeamBotMutationOptions(queryClient));
  const [assigning, setAssigning] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const assigned = bot.assignments ?? [];
  return (
    <>
      {remove.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {remove.error.message}
        </p>
      ) : null}
      {assigned.length === 0 ? (
        <PageEmpty icon={IconUsersGroup} title="Not assigned to any group" />
      ) : null}
      <PageRows>
        {assigned.map((name) => (
          <Fragment key={name}>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUsers />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name === "*" ? "Whole team" : name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={
                    name === "*"
                      ? "Remove whole-team assignment"
                      : `Remove ${name}`
                  }
                  className="min-h-11"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate({ botId: bot.id, group: name, remove: true })
                  }
                  size="sm"
                  variant="outline"
                >
                  Remove
                </Button>
              </ItemActions>
            </Item>
            <Separator />
          </Fragment>
        ))}
        <Item
          render={
            <button
              ref={opener}
              onClick={() => setAssigning(true)}
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconPlus />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Add assignment</ItemTitle>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {assigning ? (
        <AssignDialog
          bot={bot}
          onClose={() => setAssigning(false)}
          opener={opener}
        />
      ) : null}
    </>
  );
}

const ASSIGNMENT_SCOPES = { group: "A group", team: "Whole team" } as const;

function AssignDialog({
  bot,
  onClose,
  opener,
}: {
  bot: TeamBot;
  onClose: () => void;
  opener: React.RefObject<HTMLButtonElement | null>;
}) {
  const formId = useId();
  const assign = useMutation(assignTeamBotMutationOptions(queryClient));
  const submitting = useRef(false);
  const [scope, setScope] = useState<keyof typeof ASSIGNMENT_SCOPES>("group");
  const [group, setGroup] = useState("");
  const wholeTeam = scope === "team";
  const typedWildcard = !wholeTeam && group.trim() === "*";
  const target = wholeTeam ? "*" : group.trim();
  const taken = bot.assignments?.includes(target) ?? false;
  const canAssign =
    Boolean(target) && !typedWildcard && !taken && !assign.isPending;
  return (
    <SettingsDraftDialog
      action={
        <Button
          className="min-h-11"
          disabled={!canAssign}
          form={formId}
          type="submit"
        >
          {assign.isPending
            ? "Assigning…"
            : wholeTeam
              ? "Assign to whole team"
              : "Assign to group"}
        </Button>
      }
      description="This pins the Bot at the top of the selected members’ Bots lists."
      dirty={wholeTeam || group.trim() !== ""}
      guardNavigation={submitting}
      onClose={onClose}
      open
      opener={opener}
      overlay={astryxScope}
      saving={assign.isPending}
      title={`Assign ${bot.name}`}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAssign || submitting.current) return;
          submitting.current = true;
          assign.mutate(
            { botId: bot.id, group: target },
            {
              onSuccess: onClose,
              onSettled: () => {
                submitting.current = false;
              },
            },
          );
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${formId}-scope`}>Assign to</FieldLabel>
            <Select
              disabled={assign.isPending}
              items={ASSIGNMENT_SCOPES}
              onValueChange={(value) => {
                if (value === "group" || value === "team") setScope(value);
              }}
              value={scope}
            >
              <SelectTrigger className="min-h-11" id={`${formId}-scope`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent {...astryxScope}>
                <SelectItem value="group">A group</SelectItem>
                <SelectItem
                  disabled={bot.assignments?.includes("*")}
                  value="team"
                >
                  Whole team
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {wholeTeam ? null : (
            <Field>
              <FieldLabel htmlFor={`${formId}-group`}>Group name</FieldLabel>
              <Input
                aria-describedby={
                  typedWildcard || taken ? `${formId}-group-help` : undefined
                }
                aria-invalid={typedWildcard || taken}
                className="min-h-11"
                id={`${formId}-group`}
                onChange={(event) => setGroup(event.target.value)}
                readOnly={assign.isPending}
                value={group}
              />
              {typedWildcard || taken ? (
                <FieldDescription id={`${formId}-group-help`}>
                  {typedWildcard
                    ? "Choose Whole team from Assign to."
                    : "This Bot is already assigned to this group."}
                </FieldDescription>
              ) : null}
            </Field>
          )}
        </FieldGroup>
      </form>
      {assign.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {assign.error.message}
        </p>
      ) : null}
    </SettingsDraftDialog>
  );
}
