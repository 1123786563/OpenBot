import {
  IconBolt,
  IconChevronRight,
  IconFileOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { SkillFields } from "@/components/skills/skill-fields";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
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
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

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
  const { data: agents } = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const { data: hiddenAgents } = useQuery(agentListQueryOptions(true));
  const [error, setError] = useState<string | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  /* The Back trail out of an edited skill asks first, as Cancel does on the New skill page. */
  const leave = () => navigate(paths.skills());
  const guardLeave = (event: {
    preventDefault: () => void;
    currentTarget: HTMLElement;
  }) => {
    if (!draftDirty) return;
    event.preventDefault();
    requestConfirmation({
      title: "Leave without saving?",
      description: "Your edits to this skill are discarded.",
      confirmLabel: "Leave",
      pendingLabel: "Leaving…",
      failureMessage: "Couldn't leave this page. Try again.",
      trigger: event.currentTarget,
      run: async () => {
        await leave();
      },
    });
  };

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
    linkProps: {
      ...paths.skills(),
      onClick: guardLeave,
    },
  };
  const skill = plugins.data?.skills.find(
    (candidate) => candidate.slug === slug,
  );

  /* Placeholder rows while the fetch is open, so no sentence asserts anything mid-read. */
  if (plugins.isPending) {
    return (
      <PageShell backButton={back} title={fallbackTitle(slug)}>
        <div aria-busy="true" aria-label="Loading" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <div key={key}>
                <Item size="sm">
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </ItemContent>
                </Item>
                {index !== LOADING_ROWS.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        </div>
      </PageShell>
    );
  }

  /* A list that could not be read is not a missing skill: `isPending` goes false on a failure too. */
  if (!plugins.data) {
    return (
      <PageShell backButton={back} title={fallbackTitle(slug)}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load this skill.
          </p>
          <Button
            disabled={plugins.isFetching}
            onClick={() => void plugins.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {plugins.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
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
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: skill.grantedTo,
  });

  return (
    <PageShell
      backButton={back}
      {...(skill.summary ? { description: skill.summary } : {})}
      title={skill.title}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={
          <>
            Bots with their switch on offer {skill.title} when someone types{" "}
            <code>/</code>. It takes effect at once.
          </>
        }
        title="Bots"
      >
        {bots.length === 0 ? (
          <PageEmpty icon={IconBolt} title="No Bots yet">
            Create a Bot to offer this skill.
          </PageEmpty>
        ) : (
          <PageRows>
            {bots.map((bot, index) => {
              const held = skill.grantedTo.includes(bot.id);
              return (
                <div key={bot.id}>
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
                       * Disabled only while its own write is in flight, so switching one Bot does
                       * not freeze the rest of the list.
                       */}
                      <Switch
                        aria-label={`${bot.name} offers ${skill.title}`}
                        checked={held}
                        disabled={
                          setGrant.isPending &&
                          setGrant.variables?.agentId === bot.id
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
                </div>
              );
            })}
          </PageRows>
        )}
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
          await saveSkill.mutateAsync({ ...values, global: true });
          /* The saved values are on their way back through the cache, but the guard at the
             top must stop believing there are unsaved edits the moment they are saved. */
          setDraftDirty(false);
          toast.add({ title: "Skill saved", type: "success" });
        }}
        slugLocked
        submitLabel="Save changes"
      />

      {/* A row that opens the confirmation, as deleting a Bot is on its own page. */}
      <PageSection title="Manage">
        <PageRows>
          <Item
            render={
              <button
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
                      await navigate(paths.skills());
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

      {confirmation}
    </PageShell>
  );
}
