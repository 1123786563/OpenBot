import { Text } from "@astryxdesign/core/Text";
import type {
  LearningSharingMode,
  PersonalLearningSharing,
} from "@openbot/shared/learning";
import {
  IconCheck,
  IconChevronRight,
  IconListCheck,
  IconLock,
  IconSparkles,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { skillTitle } from "@/lib/learning/display";
import {
  requestSkillSharingMutationOptions,
  setLearnedSkillOpenMutationOptions,
  setLearningSharingModeMutationOptions,
} from "@/lib/learning/mutations";
import { personalLearningQueryOptions } from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

/** The three choices, each with the one plain line that says who sees what. */
export const SHARING_CHOICES: {
  mode: LearningSharingMode;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}[] = [
  {
    mode: "closed",
    icon: IconLock,
    title: "Only my Bots",
    description: "Only the Bots you use draw on your skills.",
  },
  {
    mode: "open",
    icon: IconUsersGroup,
    title: "Everyone's Bots",
    description: "Every Bot on OpenBot draws on all of your skills.",
  },
  {
    mode: "choose",
    icon: IconListCheck,
    title: "The skills I choose",
    description:
      "Every Bot draws on the skills you open below; your own Bots use all of them.",
  },
];

/**
 * What the choice says above its rows. While an administrator has not turned on Skill sharing, plainly that, and, when
 * the person chose to share before it was turned off, that their choice is kept for when it is on again.
 */
function choiceSentence(data: PersonalLearningSharing): string {
  if (data.sharingAllowed)
    return "Your own Bots always use every skill learned from your recordings.";
  const off =
    "An admin hasn't turned on sharing skills with every Bot, so only the Bots you use draw on yours.";
  return data.mode === "closed"
    ? off
    : `${off} Your choice below applies again if an admin turns it on.`;
}

/** What the Skills list says when it has none to show. */
function emptySentence(
  data: PersonalLearningSharing,
  mode: LearningSharingMode,
  personal: boolean,
): string {
  if (personal) {
    return "No skills learned from your recordings and conversations yet. Once there are, they show up here.";
  }
  if (data.unavailable === "off")
    return "An admin has turned off automatic learning, so no skills are learned from your recordings.";
  return mode === "choose"
    ? "No Skills learned from your recordings yet. Once there are, each one you open here reaches every Bot."
    : "No Skills learned from your recordings yet. Once there are, they show up here.";
}

/** What the Your Skills section says about who draws on them, in the mode chosen. */
const SKILLS_DESCRIPTION: Record<LearningSharingMode, string> = {
  closed: "Only the Bots you use draw on these skills.",
  open: "Every Bot on OpenBot draws on these skills.",
  choose: "Open a skill to let every Bot on OpenBot use it.",
};

/**
 * Settings, Learning: every recording a person makes goes into their own Learning space, and the Skills learned there
 * reach every Bot they use. Here they choose who else's Bots may draw on them: none (the default), all, or the Skills
 * they open one by one. Each change takes effect when it is made; there is no save. Sharing waits for an administrator
 * (Admin, Automatic learning, Skill sharing): until then nothing can be opened, and what was opened can still be closed.
 */
export function LearningSharing() {
  const sharing = useQuery(personalLearningQueryOptions());
  const setMode = useMutation(
    setLearningSharingModeMutationOptions(queryClient),
  );
  const setOpen = useMutation(setLearnedSkillOpenMutationOptions(queryClient));
  const requestShare = useMutation(
    requestSkillSharingMutationOptions(queryClient),
  );
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const [reading, setReading] = React.useState<string | null>(null);
  const skillsHeading = React.useRef<HTMLHeadingElement>(null);
  const personal = capabilities.data?.edition === "personal";
  if (sharing.isPending || capabilities.isPending || sharing.error) {
    return (
      <PageSection headingRef={skillsHeading} title="Your skills">
        {sharing.error ? (
          <ReadError
            focusAfterRetry={() => skillsHeading.current}
            message="Couldn't load your Learning settings."
            retry={sharing.refetch}
            retryBelow
            retryLabel="Retry your skills"
            retrying={sharing.isFetching}
          />
        ) : (
          <ReadStatus kind="loading" message="Loading your skills…" />
        )}
      </PageSection>
    );
  }
  const data = sharing.data;
  // Shown at once while the save is on its way, as a switch is.
  const mode = (setMode.isPending ? setMode.variables : undefined) ?? data.mode;
  const saving =
    setMode.isPending || setOpen.isPending || requestShare.isPending;
  const skillListError =
    data.skills === null && data.unavailable !== "off" ? (
      <ReadError
        focusAfterRetry={() => skillsHeading.current}
        message="Couldn’t load the skill list"
        description={
          personal ? undefined : "Your sharing choice still applies."
        }
        retry={sharing.refetch}
        retryBelow
        retryLabel="Retry skill list"
        retrying={sharing.isFetching}
      />
    ) : null;
  // The dialog shows the title its row did.
  const readingSkill = data.skills?.find((skill) => skill.name === reading);
  const readingTitle = readingSkill
    ? skillTitle(readingSkill.name, readingSkill.description)
    : undefined;

  if (personal) {
    // One person, one computer: nobody to share with, so every row simply opens its Skill.
    const none = data.skills === null || data.skills.length === 0;
    return (
      <PageSection
        headingRef={skillsHeading}
        title="Your skills"
        // Said only over skills to open: above the empty state it would point at nothing.
        description={none ? undefined : "Open a skill to read what it does."}
      >
        {skillListError ? (
          skillListError
        ) : data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, true)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => (
              <React.Fragment key={skill.name}>
                {index > 0 ? <Separator /> : null}
                <Item
                  size="sm"
                  render={
                    <button
                      onClick={() => setReading(skill.name)}
                      type="button"
                    />
                  }
                >
                  <ItemMedia variant="icon">
                    <IconSparkles />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {skillTitle(skill.name, skill.description)}
                    </ItemTitle>
                    <ItemDescription>{skill.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Item>
              </React.Fragment>
            ))}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
    );
  }

  return (
    <>
      <PageSection
        title="Who else's Bots use your skills"
        description={choiceSentence(data)}
      >
        <PageRows>
          {/* One pressed button of three, as Admin, Boundaries draws its enforcement choice. */}
          {SHARING_CHOICES.map((choice, index) => (
            <React.Fragment key={choice.mode}>
              {index > 0 ? <Separator /> : null}
              <Item
                size="sm"
                render={
                  <button
                    aria-pressed={mode === choice.mode}
                    disabled={!data.sharingAllowed && choice.mode !== "closed"}
                    aria-disabled={
                      saving ||
                      (!data.sharingAllowed && choice.mode !== "closed")
                    }
                    onClick={() => {
                      if (!saving && mode !== choice.mode)
                        setMode.mutate(choice.mode);
                    }}
                    type="button"
                  />
                }
              >
                <ItemMedia variant="icon">
                  <choice.icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{choice.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {choice.description}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {mode === choice.mode ? (
                    <IconCheck
                      aria-hidden="true"
                      className="size-4 text-foreground"
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </React.Fragment>
          ))}
        </PageRows>
        {setMode.error ? (
          <Text
            as="p"
            role="alert"
            size="sm"
            style={{ color: "var(--color-text-error)" }}
          >
            {setMode.error.message}
          </Text>
        ) : null}
      </PageSection>
      <PageSection
        headingRef={skillsHeading}
        title="Your skills"
        description={SKILLS_DESCRIPTION[data.sharingAllowed ? mode : "closed"]}
      >
        {skillListError ? (
          skillListError
        ) : data.skills === null || data.skills.length === 0 ? (
          <PageEmpty>{emptySentence(data, mode, false)}</PageEmpty>
        ) : (
          <PageRows>
            {data.skills.map((skill, index) => {
              const open =
                (setOpen.isPending && setOpen.variables?.name === skill.name
                  ? setOpen.variables.open
                  : undefined) ?? skill.open;
              // A skill the person approved reaches other Bots only once an admin approves sharing it.
              const needsAdmin =
                mode !== "closed" &&
                skill.approvedBy === "person" &&
                skill.sharing !== "approved";
              const requestHere = requestShare.variables === skill.name;
              const failedRequest = requestHere ? requestShare.error : null;
              const openError =
                setOpen.variables?.name === skill.name ? setOpen.error : null;
              const retryRequest =
                Boolean(failedRequest) &&
                data.sharingAllowed &&
                needsAdmin &&
                skill.sharing !== "requested" &&
                (mode !== "choose" || open);
              return (
                <React.Fragment key={skill.name}>
                  {index > 0 ? <Separator /> : null}
                  {mode === "choose" || needsAdmin ? (
                    // The row opens the Skill; the Switch sits beside that button, not inside it.
                    <Item size="sm">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setReading(skill.name)}
                        type="button"
                      >
                        <ItemMedia variant="icon">
                          <IconSparkles />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            {skillTitle(skill.name, skill.description)}
                          </ItemTitle>
                          <ItemDescription>
                            {[
                              needsAdmin ||
                              (mode === "choose" &&
                                !(open && data.sharingAllowed))
                                ? "Only your Bots use it."
                                : mode === "choose"
                                  ? "Every Bot may use it."
                                  : null,
                              skill.description,
                            ]
                              .filter(Boolean)
                              .join(" ")}
                          </ItemDescription>
                        </ItemContent>
                      </button>
                      <ItemActions>
                        {mode === "choose" ? (
                          <>
                            {needsAdmin && skill.sharing === "requested" ? (
                              <span className="text-muted-foreground text-sm">
                                Asked to share
                              </span>
                            ) : null}
                            <Switch
                              aria-label={`Open ${skillTitle(skill.name, skill.description)} to everyone`}
                              checked={open}
                              // An open Skill can always be closed; opening one waits for an admin.
                              disabled={!data.sharingAllowed && !open}
                              aria-disabled={
                                saving || (!data.sharingAllowed && !open)
                              }
                              readOnly={saving}
                              onCheckedChange={(checked) => {
                                if (saving) return;
                                if (!checked && requestHere)
                                  requestShare.reset();
                                if (
                                  checked &&
                                  needsAdmin &&
                                  skill.sharing !== "requested"
                                ) {
                                  // Switching on a skill an admin has yet to approve also asks for that approval.
                                  setOpen
                                    .mutateAsync({
                                      name: skill.name,
                                      open: true,
                                    })
                                    .then(() => requestShare.mutate(skill.name))
                                    .catch(() => {});
                                  return;
                                }
                                setOpen.mutate({
                                  name: skill.name,
                                  open: checked,
                                });
                              }}
                            />
                          </>
                        ) : skill.sharing === "requested" ? (
                          <span className="text-muted-foreground text-sm">
                            Asked to share
                          </span>
                        ) : (
                          <Button
                            disabled={saving}
                            onClick={() => requestShare.mutate(skill.name)}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Ask to share
                          </Button>
                        )}
                      </ItemActions>
                      {requestHere && requestShare.isPending ? (
                        <ItemFooter>
                          <Text as="p" role="status" size="sm">
                            Sending sharing request…
                          </Text>
                        </ItemFooter>
                      ) : null}
                      {openError || failedRequest ? (
                        <ItemFooter style={{ flexWrap: "wrap" }}>
                          <Text
                            as="p"
                            role="alert"
                            size="sm"
                            style={{ color: "var(--color-text-error)" }}
                          >
                            {openError?.message ?? failedRequest?.message}
                          </Text>
                          {retryRequest && mode === "choose" ? (
                            <Button
                              className="confirmation-action"
                              disabled={saving}
                              onClick={(event) => {
                                const row =
                                  event.currentTarget.closest(
                                    "[data-slot=item]",
                                  );
                                requestShare.mutate(skill.name, {
                                  onSuccess: () =>
                                    requestAnimationFrame(() => {
                                      if (
                                        document.activeElement === document.body
                                      ) {
                                        row
                                          ?.querySelector<HTMLElement>(
                                            "[role=switch]",
                                          )
                                          ?.focus();
                                      }
                                    }),
                                });
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Retry sharing request
                            </Button>
                          ) : null}
                        </ItemFooter>
                      ) : null}
                    </Item>
                  ) : (
                    // No switch here, so the whole row opens the Skill.
                    <Item
                      size="sm"
                      render={
                        <button
                          onClick={() => setReading(skill.name)}
                          type="button"
                        />
                      }
                    >
                      <ItemMedia variant="icon">
                        <IconSparkles />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {skillTitle(skill.name, skill.description)}
                        </ItemTitle>
                        <ItemDescription>{skill.description}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <IconChevronRight className="size-4 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                  )}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
        <LearnedSkillDialog
          name={reading}
          title={readingTitle}
          onClose={() => setReading(null)}
          source={{ kind: "personal" }}
        />
      </PageSection>
    </>
  );
}
