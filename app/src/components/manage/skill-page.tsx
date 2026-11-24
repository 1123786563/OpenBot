import { Stack } from "@astryxdesign/core/Stack";
import {
  IconBolt,
  IconChevronRight,
  IconFileOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SkillFields } from "@/components/skills/skill-fields";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { grantRoster } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useManagePaths } from "@/lib/manage-paths";
import {
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  pluginsPageQueryOptions,
  skillsAccessDenied,
} from "@/lib/plugins/queries";

/**
 * One of the deployment's skills: which Bots offer it, what it says, and removing it.
 *
 * Bots first, because a skill no Bot offers does nothing, and that is the decision made most often
 * here. Each Bot is one row with one switch, as on a tool's page (`plugin-tool-page.tsx`), where the
 * list used to draw a chip per Bot inside every skill's row.
 *
 * Editing saves the same way creating does: `POST /api/plugins/skills` upserts on the slug and
 * leaves the owner alone, so the command is fixed here (`slugLocked`).
 */
/** Placeholder rows while the page loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

export function SkillPage({ slug }: { slug: string }) {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const botsHeading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const submitting = useRef(false);
  const { requestConfirmation, confirmation } = useActionConfirmation();

  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: () =>
      setError("Couldn't change which Bots offer this skill. Try again."),
  });
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const removeSkill = useMutation(removeSkillMutationOptions(queryClient));

  /** "weekly-digest" -> "Weekly digest": the page's own name while the read is out. */
  const fallbackTitle = (key: string) =>
    key
      .split("-")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

  const back = {
    label: "Skills",
    linkProps: paths.skills(),
  };
  const skill = plugins.data?.skills.find(
    (candidate) => candidate.slug === slug,
  );
  const stale = plugins.isError;
  const denied = skillsAccessDenied(plugins.error);
  const retrySkill = () => plugins.refetch();

  /* Placeholder rows while the fetch is open, so no sentence asserts anything mid-read. */
  if (plugins.isPending) {
    return (
      <PageShell backButton={back} title={fallbackTitle(slug)}>
        <Stack aria-busy="true" aria-label="Loading skill" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <Fragment key={key}>
                <Item size="sm">
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </ItemContent>
                </Item>
                {index !== LOADING_ROWS.length - 1 && <Separator />}
              </Fragment>
            ))}
          </PageRows>
        </Stack>
      </PageShell>
    );
  }

  /* A list that could not be read is not a missing skill: `isPending` goes false on a failure too. */
  if (denied || (stale && !skill)) {
    return (
      <PageShell backButton={back} title={fallbackTitle(slug)}>
        <ReadError
          description={
            denied
              ? "Check that you still have access, then try again."
              : undefined
          }
          focusAfterRetry={() => botsHeading.current}
          message={
            denied
              ? "Skill access is unavailable."
              : "Couldn't load this skill."
          }
          retry={retrySkill}
          retryBelow
          retryLabel="Retry skill"
          retrying={plugins.isFetching}
        />
      </PageShell>
    );
  }

  if (!skill) {
    return (
      <PageShell backButton={back} title={fallbackTitle(slug)}>
        <PageEmpty icon={IconFileOff} title="Skill not found">
          It may have been deleted. Go back to Skills to see the ones there are.
        </PageEmpty>
      </PageShell>
    );
  }

  const bots = grantRoster({
    roster: agents.isError ? [] : (agents.data ?? []),
    hidden: hiddenAgents.isError ? [] : (hiddenAgents.data ?? []),
    holders: skill.grantedTo,
  });
  const rosterFailed = agents.isError || hiddenAgents.isError;
  const rosterLoading = agents.isPending || hiddenAgents.isPending;
  const retryBots = () =>
    Promise.all([
      agents.isError && agents.refetch(),
      hiddenAgents.isError && hiddenAgents.refetch(),
    ]);

  return (
    <PageShell
      backButton={back}
      {...(skill.summary ? { description: skill.summary } : {})}
      title={skill.title}
    >
      {stale ? (
        <ReadError
          description="Your draft is still here. Refresh before saving, changing which Bots offer this skill, or deleting it."
          focusAfterRetry={() => botsHeading.current}
          message="Couldn't refresh this skill."
          retry={retrySkill}
          retryBelow
          retryLabel="Retry skill"
          retrying={plugins.isFetching}
        />
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description="These switches update the / menu immediately. The form below saves the skill’s content separately."
        headingRef={botsHeading}
        title="Bots"
      >
        {rosterFailed ? (
          <ReadError
            description="Refresh the Bot list before changing who offers this skill."
            focusAfterRetry={() => botsHeading.current}
            message="Couldn't load every Bot."
            retry={retryBots}
            retryBelow
            retryLabel="Retry Bots"
            retrying={agents.isFetching || hiddenAgents.isFetching}
          />
        ) : rosterLoading ? (
          <ReadStatus kind="loading" message="Loading Bots…" />
        ) : null}
        {bots.length === 0 && !rosterFailed && !rosterLoading ? (
          <PageEmpty icon={IconBolt} title="No Bots yet">
            Create a Bot to offer this skill.
          </PageEmpty>
        ) : bots.length > 0 ? (
          <PageRows>
            {bots.map((bot, index) => {
              const held = skill.grantedTo.includes(bot.id);
              return (
                <Fragment key={bot.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{bot.name}</ItemTitle>
                      <ItemDescription>
                        {bot.hidden ? "Hidden from your roster. " : ""}
                        {held
                          ? "Offers this skill."
                          : "Doesn't offer this skill."}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Binary and immediate: it takes effect when switched and there is no save.
                       * A write in flight only disables its own switch.
                       */}
                      <Switch
                        aria-label={`${bot.name} offers ${skill.title}`}
                        checked={held}
                        disabled={
                          stale ||
                          rosterFailed ||
                          rosterLoading ||
                          (setGrant.isPending &&
                            setGrant.variables?.agentId === bot.id)
                        }
                        onCheckedChange={(next) => {
                          setError(null);
                          setGrant.mutate({
                            agentId: bot.id,
                            granted: next,
                            kind: "skill",
                            ref: skill.slug,
                          });
                        }}
                      />
                    </ItemActions>
                  </Item>
                  {index !== bots.length - 1 && <Separator />}
                </Fragment>
              );
            })}
          </PageRows>
        ) : null}
      </PageSection>

      <SkillFields
        // No Cancel: the Bots above save on their own, and Back is the way out.
        sections={{}}
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // A skill written before this field existed opens with nothing ticked.
          tools: skill.tools ?? [],
        }}
        error={saveSkill.error}
        onDirtyChange={setDraftDirty}
        // Remounted after a save, so the form starts again from what the server now holds.
        key={`${skill.title}\u0000${skill.summary}\u0000${skill.instructions}`}
        onSubmit={async (values) => {
          if (submitting.current) return;
          submitting.current = true;
          try {
            await saveSkill.mutateAsync({ ...values, global: true });
            setDraftDirty(false);
            toast.add({ title: "Skill saved", type: "success" });
          } finally {
            submitting.current = false;
          }
        }}
        saveDisabled={stale}
        saving={saveSkill.isPending}
        slugLocked
        submitLabel="Save changes"
      />

      {/* A row that opens the confirmation, as deleting a Bot is on its own page. */}
      {!stale ? (
        <PageSection title="Manage">
          <PageRows>
            <Item
              render={
                <button
                  disabled={saveSkill.isPending}
                  onClick={(event) =>
                    requestConfirmation({
                      title: `Delete ${skill.title}?`,
                      description:
                        "Everyone who could run this skill will lose access to it, and no Bot will offer it. Deletion is permanent.",
                      confirmLabel: "Delete",
                      pendingLabel: "Deleting…",
                      failureMessage: "Couldn't delete this skill. Try again.",
                      trigger: event.currentTarget,
                      refresh: () => plugins.refetch(),
                      run: async () => {
                        const { data } = await plugins.refetch({
                          throwOnError: true,
                        });
                        const current = data?.skills.find(
                          (candidate) => candidate.slug === skill.slug,
                        );
                        if (
                          current?.id !== skill.id ||
                          current.title !== skill.title ||
                          current.instructions !== skill.instructions ||
                          current.ownerUserId !== skill.ownerUserId
                        ) {
                          throw new ActionUnavailable(
                            "This skill changed or is no longer available. Return to Skills to review it.",
                          );
                        }
                        await removeSkill.mutateAsync(skill.slug);
                        await navigate({
                          ...paths.skills(),
                          ignoreBlocker: true,
                        });
                      },
                    })
                  }
                  type="button"
                />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Delete</ItemTitle>
                <ItemDescription>
                  People can't run it any more, and no Bot offers it. You can't
                  undo this.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}

      {confirmation}
      <DraftLeaveConfirmation
        description="The changes to the skill’s name, instructions, and tools will be lost."
        hasDraft={draftDirty}
        saving={saveSkill.isPending}
        submitting={submitting}
        title="Discard this skill draft?"
      />
    </PageShell>
  );
}
