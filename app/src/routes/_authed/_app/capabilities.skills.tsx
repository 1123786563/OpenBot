import { VStack } from "@astryxdesign/core/VStack";
import { IconDots, IconListSearch, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { z } from "zod";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { StaggerItem } from "@/components/layout/stagger";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { grantRoster, skillHolderSentence } from "@/lib/agents/grant-roster";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  removeSkillMutationOptions,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import {
  type PluginSkill,
  pluginsPageQueryOptions,
  skillsAccessDenied,
} from "@/lib/plugins/queries";
import type { SkillFormValues } from "@/lib/skills/form";

/**
 * Personal `/` skills. They are instructions, not capabilities, and can only be granted to Bots the
 * signed-in user owns.
 */

/**
 * Writing a skill is a search parameter rather than a route, so the list stays on screen behind the
 * panel and the form is linkable, reloadable, and closed by Back — the same contract the agents
 * roster makes.
 */
const skillsSearchSchema = z.object({
  new: z.boolean().optional(),
  /** The slug being edited. Absent means nothing is. */
  edit: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/capabilities/skills")({
  validateSearch: skillsSearchSchema,
  component: SkillsPage,
});

/** Placeholder rows while the list loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

function PersonalSkillEditor({
  slug,
  status,
}: {
  slug: string | undefined;
  status: "loading" | "unavailable" | "ready";
}) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const hasDraft = useRef(false);
  const rememberDraft = useCallback((dirty: boolean) => {
    hasDraft.current = dirty;
  }, []);
  const submitting = useRef(false);

  async function save(values: SkillFormValues) {
    if (submitting.current || status !== "ready") return;
    submitting.current = true;
    try {
      await saveSkill.mutateAsync(values);
      await navigate({ search: {}, ignoreBlocker: true, replace: true });
    } finally {
      submitting.current = false;
    }
  }

  const form = {
    error: saveSkill.error,
    onDirtyChange: rememberDraft,
    onSubmit: save,
    saving: saveSkill.isPending,
  };

  return (
    <>
      {slug === undefined ? (
        <NewSkill {...form} status={status} />
      ) : (
        <EditSkill {...form} slug={slug} />
      )}
      <DraftLeaveConfirmation
        description="The name, instructions, and tools you entered will be lost."
        hasDraft={hasDraft}
        leavesDraft={({ next }) => {
          if (next.routeId !== "/_authed/_app/capabilities/skills") return true;
          if (slug === undefined) return next.search.new !== true;
          return next.search.new === true || next.search.edit !== slug;
        }}
        saving={saveSkill.isPending}
        submitting={submitting}
        title="Discard unsaved skill changes?"
      />
    </>
  );
}

function SkillsPage() {
  const queryClient = useQueryClient();
  const { new: isCreating, edit: editingSlug } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Creating wins if both are somehow set: it is the more recent intent, the same rule the agents
  // roster uses when `new` and `agent` arrive together.
  const showCreate = isCreating === true;
  const showEdit = !showCreate && editingSlug !== undefined;
  const {
    data,
    error: skillsError,
    isPending: skillsPending,
    isFetching: skillsFetching,
    refetch: refetchSkills,
  } = useQuery(pluginsPageQueryOptions());
  const profile = useQuery(currentUserQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a Bot of theirs holding the skill is still named. */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const me = profile.data;
  /*
   * Both, because `mine` is the intersection of the two: until the person is known, nothing matches
   * them and the list is empty for a reason that is not "you have no skills".
   */
  const loading = skillsPending || profile.isPending;
  const denied = skillsAccessDenied(skillsError);
  const cannotIdentifyOwner = !me;
  const readIssue = cannotIdentifyOwner || skillsError !== null;
  const canCreate = !loading && !readIssue;
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const removeSkill = useMutation(removeSkillMutationOptions(queryClient));

  /*
   * The server has ALREADY excluded skills this person may not see — `listSkills` scopes the query
   * to `owner_user_id is null or owner_user_id = me`, so somebody else's private skill is never read
   * into the process. These two lines only sort what arrived into the two things the page draws.
   *
   * ONE CASE FALLS THROUGH ON PURPOSE, FOR NOW: an administrator receives everybody's skills, and
   * another person's lands in neither list. Not a leak, but an administrator cannot see here what
   * they are entitled to. Worth an owner column or a third section before this page is called done.
   */
  const skills = denied || cannotIdentifyOwner ? [] : (data?.skills ?? []);
  const mine = skills.filter((skill) => skill.ownerUserId === me?.id);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);
  const heading = useRef<HTMLHeadingElement>(null);
  /**
   * Which of this person's Bots offer the skill, for the confirmation before deleting it. A personal
   * skill only reaches Bots they own, so the roster is filtered to those; `undefined` is a roster
   * that could not be read, which must never be stated as no Bot.
   */
  const holdersOf = (skill: PluginSkill) =>
    agents.isError ||
    hiddenAgents.isError ||
    agents.isPending ||
    hiddenAgents.isPending
      ? undefined
      : grantRoster({
          roster: (agents.data ?? []).filter((agent) => agent.mine),
          hidden: (hiddenAgents.data ?? []).filter((agent) => agent.mine),
          holders: skill.grantedTo,
        })
          .filter((agent) => skill.grantedTo.includes(agent.id))
          .map((agent) => agent.name);
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? mine.filter(({ title, slug, summary }) => {
        const text = `${title} /${slug} ${summary ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
    : mine;

  return (
    <DetailPanel
      detail={
        showCreate || showEdit ? (
          <PersonalSkillEditor
            key={showCreate ? "new" : `edit:${editingSlug}`}
            slug={showCreate ? undefined : editingSlug}
            status={loading ? "loading" : readIssue ? "unavailable" : "ready"}
          />
        ) : null
      }
      onClose={() => navigate({ search: {} })}
      open={showCreate || showEdit}
    >
      <CapabilitiesShell>
        {confirmation}

        <PageSection
          action={
            canCreate ? (
              <Link
                className={buttonVariants({
                  className: "min-h-11",
                  size: "sm",
                  variant: "ghost",
                })}
                id="new-personal-skill"
                search={{ new: true }}
                to="/capabilities/skills"
              >
                <IconPlus />
                New skill
              </Link>
            ) : undefined
          }
          description={
            <>
              Type <code>/</code> and a skill's name to give a Bot that
              instruction. Only you see yours, and they work on Bots you own.
            </>
          }
          headingRef={heading}
          title="Your skills"
        >
          {!loading && readIssue ? (
            <section className="mt-4">
              <ReadError
                description={
                  skills.length > 0
                    ? "Showing the last loaded skills. Refresh the list to make changes."
                    : denied
                      ? "Check that you still have access, then try again."
                      : undefined
                }
                focusAfterRetry={() => heading.current}
                message={
                  denied
                    ? "Skills access is unavailable."
                    : skills.length > 0
                      ? "Couldn't refresh your skills."
                      : "Couldn't load your skills."
                }
                retry={() =>
                  cannotIdentifyOwner ? profile.refetch() : refetchSkills()
                }
                retryBelow
                retryLabel="Retry skills"
                retrying={
                  cannotIdentifyOwner ? profile.isFetching : skillsFetching
                }
              />
            </section>
          ) : null}
          {!loading && mine.length > 0 ? (
            <Input
              aria-label="Search your skills"
              className="mt-4 min-h-12"
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              placeholder="Search by name, command, or description"
              ref={input}
              type="search"
              value={search}
            />
          ) : null}
          {!loading && mine.length > 0 && words.length > 0 ? (
            <p className="mt-2 text-muted-foreground text-sm" role="status">
              {matches.length} of {mine.length} skills match
            </p>
          ) : null}
          {/*
           * Placeholder rows while the two queries are still in flight: the alternative is the
           * empty state standing there saying this person has written no skills, which is a claim
           * the page has not yet earned.
           *
           * And not after a read that failed, for the same reason: `isPending` goes false on a
           * failed fetch too, and no list is no evidence of no skills. A list already held stays on
           * screen through a failed refetch, because `data` is still there.
           */}
          {loading ? (
            <VStack
              aria-busy="true"
              aria-label="Loading skills"
              className="mt-4"
              role="status"
            >
              <PageRows>
                {LOADING_ROWS.map((key, index) => (
                  <StaggerItem index={index} key={key}>
                    <Item size="sm">
                      <ItemContent className="gap-1.5">
                        <Skeleton className="h-3.5 w-40" />
                        <Skeleton className="h-3 w-64" />
                      </ItemContent>
                    </Item>
                  </StaggerItem>
                ))}
              </PageRows>
            </VStack>
          ) : readIssue && mine.length === 0 ? null : mine.length === 0 ? (
            <Empty className="mt-4 h-45 border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  No skills yet. Write one with New skill.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : matches.length === 0 ? (
            <PageEmpty
              action={
                <Button
                  className="min-h-11"
                  onClick={() => {
                    setSearch("");
                    input.current?.focus();
                  }}
                  variant="outline"
                >
                  Clear search
                </Button>
              }
              icon={IconListSearch}
              title="No matching skills"
            />
          ) : (
            <PageRows>
              {matches.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
                        {skill.title}
                      </ItemTitle>
                      {/*
                       * The name and what it is for. Not the command: the `/` menu finds a skill by
                       * its name, so the command is the skill's key rather than something to read.
                       */}
                      {skill.summary ? (
                        <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                          {skill.summary}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    {readIssue ? null : (
                      <ItemActions>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                aria-label={`Actions for ${skill.title}`}
                                className="min-h-11 min-w-11"
                                id={`skill-actions-${skill.id}`}
                                variant="ghost"
                                size="icon-sm"
                              >
                                <IconDots />
                              </Button>
                            }
                          ></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                              <DropdownMenuItem
                                className="min-h-11"
                                onClick={() =>
                                  navigate({ search: { edit: skill.slug } })
                                }
                              >
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label={`Delete ${skill.title}`}
                                className="min-h-11"
                                onClick={() => {
                                  requestConfirmation({
                                    title: `Delete ${skill.title}?`,
                                    description: `${skillHolderSentence(holdersOf(skill))} Deletion is permanent.`,
                                    confirmLabel: "Delete skill",
                                    pendingLabel: "Deleting…",
                                    failureMessage:
                                      "Couldn't delete this skill. Try again.",
                                    successMessage: "Skill deleted.",
                                    trigger:
                                      document.getElementById(
                                        `skill-actions-${skill.id}`,
                                      ) ?? undefined,
                                    fallbackFocus: () =>
                                      input.current ??
                                      document.getElementById(
                                        "new-personal-skill",
                                      ) ??
                                      heading.current,
                                    refresh: () => refetchSkills(),
                                    run: async () => {
                                      const { data: latest } =
                                        await refetchSkills({
                                          throwOnError: true,
                                        });
                                      const current = latest?.skills.find(
                                        (candidate) =>
                                          candidate.slug === skill.slug,
                                      );
                                      if (
                                        current?.id !== skill.id ||
                                        current.ownerUserId !== me?.id ||
                                        current.title !== skill.title ||
                                        current.instructions !==
                                          skill.instructions
                                      ) {
                                        throw new ActionUnavailable(
                                          "This skill changed or is no longer available. Return to the list to review it.",
                                        );
                                      }
                                      await removeSkill.mutateAsync(skill.slug);
                                    },
                                  });
                                }}
                                variant="destructive"
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </ItemActions>
                    )}
                  </Item>
                  {index !== matches.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          )}
        </PageSection>

        {/*
         * NO MENU ON THESE ROWS, AND THAT IS THE POINT. A workspace skill belongs to the deployment,
         * not to the person reading this page: they cannot edit it, delete it, or choose which Bots
         * carry it. Drawing the same dropdown here and refusing on click would be a worse answer than
         * not offering it — the server refuses either way, and an affordance that only ever fails is
         * a promise the page cannot keep.
         *
         * Hidden entirely when there are none, rather than shown empty: an administrator who has
         * written nothing yet is the normal case, and a permanently empty section reads as broken.
         */}
        {deployment.length > 0 ? (
          <PageSection
            description="An admin writes these for everyone and picks which Bots use them."
            title="Workspace skills"
          >
            <PageRows>
              {deployment.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
                        {skill.title}
                      </ItemTitle>
                      {/*
                       * The name and what it is for. Not the command: the `/` menu finds a skill by
                       * its name, so the command is the skill's key rather than something to read.
                       */}
                      {skill.summary ? (
                        <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                          {skill.summary}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                  </Item>
                  {index !== deployment.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}

        {/*
         * The commented write-a-skill form that used to sit here is gone: the detail panel above is
         * the real one now. `SkillRow` below is still parked, because its per-Bot grant toggles have
         * no equivalent in the redesigned rows yet.
         */}
      </CapabilitiesShell>
    </DetailPanel>
  );
}

/*
 * Parked, not deleted. Its only callers are the commented sections above, and it still holds the
 * per-Bot grant toggles — the one piece of the old page the new one has no equivalent for yet.
 * Whoever adds granting to the redesigned rows should start from this rather than reinvent it.
 *
 * function SkillRow({
 *   skill,
 *   bots,
 *   onToggle,
 *   onDelete,
 * }: {
 *   skill: PluginSkill;
 *   bots: { id: string; name: string }[];
 *   onToggle?: (agentId: string, held: boolean) => void;
 *   onDelete?: () => void;
 * }) {
 *   const held = new Set(skill.grantedTo);
 *
 *   return (
 *     <li className="rounded-xl border border-border p-4">
 *       <div className="flex items-start justify-between gap-4">
 *         <div className="min-w-0">
 *           <div className="flex items-baseline gap-2">
 *             <code className="font-medium">/{skill.slug}</code>
 *             <span className="text-sm text-muted-foreground">{skill.title}</span>
 *           </div>
 *           {skill.summary ? (
 *             <p className="mt-0.5 text-sm text-muted-foreground">
 *               {skill.summary}
 *             </p>
 *           ) : null}
 *         </div>
 *         {onDelete ? (
 *           <Button onClick={onDelete} size="sm" variant="outline">
 *             Delete
 *           </Button>
 *         ) : null}
 *       </div>
 *
 *       {onToggle ? (
 *         <div className="mt-3 flex flex-wrap items-center gap-2">
 *           {bots.length === 0 ? (
 *             <p className="text-sm text-muted-foreground">
 *               You do not own a Bot to put this on yet.
 *             </p>
 *           ) : (
 *             bots.map((bot) => {
 *               const on = held.has(bot.id);
 *               return (
 *                 <button
 *                   className={`rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
 *                     on
 *                       ? "border-primary/40 bg-primary/10 text-foreground"
 *                       : "border-border text-muted-foreground hover:text-foreground"
 *                   }`}
 *                   key={bot.id}
 *                   onClick={() => onToggle(bot.id, on)}
 *                   type="button"
 *                 >
 *                   {on ? "✓ " : ""}
 *                   {bot.name}
 *                 </button>
 *               );
 *             })
 *           )}
 *         </div>
 *       ) : null}
 *     </li>
 *   );
 * }
 */
