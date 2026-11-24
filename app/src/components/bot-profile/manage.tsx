import { Text } from "@astryxdesign/core/Text";
import {
  IconChevronRight,
  IconCopy,
  IconEyeOff,
  IconPin,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionIncomplete,
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
import { Switch } from "@/components/ui/switch";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPinnedMutationOptions,
} from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { resetBotMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { ClientError } from "@/lib/client";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";

/**
 * Whether this is the personal edition, where one person uses OpenBot. Nobody else has a Bots list
 * or a conversation with a Bot there, so the rows below say nothing about other people.
 */
function usePersonal(): boolean {
  return (
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal"
  );
}

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "goal", "goals"],
    [plan.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [plan.formedMemories, "memory it formed", "memories it formed"],
    [plan.backgroundResearch, "background research", "background research"],
    [plan.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

function useResetConfirmation(
  agent: AgentProfile,
  personal: boolean,
  memory: boolean,
) {
  const [open, setOpen] = useState(false);
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  const kept = plan.data?.sharedConversationsKept ?? 0;
  const { confirmation, requestConfirmation } = useActionConfirmation({
    ready: plan.isSuccess && plan.fetchStatus === "idle" && lines.length > 0,
    onClose: () => setOpen(false),
    content:
      plan.fetchStatus === "paused" ? (
        <ReadStatus
          kind="loading"
          message="Reconnect to check what a reset would delete."
        />
      ) : plan.isPending || plan.isFetching ? (
        <ReadStatus
          kind="loading"
          message="Checking what a reset would delete…"
        />
      ) : plan.isError ? (
        <ReadError
          message="Couldn’t check what a reset would delete"
          retry={() => plan.refetch()}
          retryBelow
          retryLabel="Check again"
        />
      ) : (
        <>
          {lines.length === 0 ? (
            <Text as="p">There’s nothing of yours to delete.</Text>
          ) : (
            <>
              <Text as="p">This will delete:</Text>
              <ul
                style={{
                  listStyle: "disc",
                  paddingInlineStart: "var(--spacing-5)",
                }}
              >
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          {kept > 0 ? (
            <Text as="p" color="secondary">
              {kept === 1
                ? "1 shared conversation will be kept."
                : `${kept} shared conversations will be kept.`}
            </Text>
          ) : null}
          {memory ? (
            <Text as="p" color="secondary">
              Memories you told the Bot yourself will be kept.
            </Text>
          ) : null}
        </>
      ),
  });
  return {
    confirmation,
    reviewReset: (trigger: HTMLButtonElement) => {
      setOpen(true);
      requestConfirmation({
        title: `Reset ${agent.name}?`,
        description: personal
          ? `This permanently deletes the data listed below.`
          : `This permanently deletes your data listed below. Other people keep their conversations and data.`,
        confirmLabel: "Delete and reset",
        pendingLabel: "Resetting…",
        failureMessage: "Couldn’t confirm the reset.",
        successMessage: `${agent.name} starts fresh with you.`,
        trigger,
        run: async () => {
          try {
            await reset.mutateAsync(agent.id);
          } catch (error) {
            if (
              error instanceof ClientError &&
              [401, 403, 404, 409].includes(error.status)
            )
              throw error;
            await plan.refetch();
            throw new ActionIncomplete(
              "Couldn’t confirm the reset. Check the list before trying again.",
            );
          }
        },
      });
    },
  };
}

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and, for whoever may manage it, delete it. The personal edition has one
 * person, so there the rows don't mention anybody else's list or conversations.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  const setPinned = useMutation(setAgentPinnedMutationOptions(queryClient));
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const duplicate = useMutation(duplicateAgentMutationOptions(queryClient));
  const duplicating = useRef(false);
  const remove = useMutation(deleteAgentMutationOptions(queryClient));
  const heading = useRef<HTMLHeadingElement>(null);
  const deletion = useActionConfirmation();
  const memory = useOffersMemory();
  const personal = usePersonal();
  // Said only where somebody else has a list of their own.
  const reset = useResetConfirmation(agent, personal, memory);
  const onlyYours = personal ? "" : " Only your list changes.";
  const error = setPinned.error ?? setHidden.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <>
      <PageSection title="Your Bots list">
        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error.message}
          </p>
        ) : null}
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPin />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Pinned</ItemTitle>
              <ItemDescription>
                {assigned
                  ? "An admin assigned it to you. It stays at the top of your Bots list."
                  : agent.pinned
                    ? `At the top of your Bots list.${onlyYours}`
                    : `Keep it at the top of your Bots list.${onlyYours}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Pinned"
                checked={agent.pinned || assigned}
                disabled={assigned || setPinned.isPending}
                onCheckedChange={(pinned) =>
                  setPinned.mutate({ agentId: agent.id, pinned })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconEyeOff />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Hidden</ItemTitle>
              <ItemDescription>
                {assigned
                  ? "An admin assigned it to you. You can't hide it."
                  : agent.hidden
                    ? `Under Hidden on your Bots list.${onlyYours}`
                    : `Take it off your Bots list.${onlyYours}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Hidden"
                checked={agent.hidden}
                disabled={assigned || setHidden.isPending}
                onCheckedChange={async (hidden) => {
                  await setHidden.mutateAsync({ agentId: agent.id, hidden });
                  if (hidden) onHidden();
                }}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      <PageSection headingRef={heading} title="Manage">
        <PageRows>
          <Item
            render={
              <button
                aria-disabled={duplicate.isPending || duplicate.isSuccess}
                onClick={() => {
                  if (duplicating.current) return;
                  duplicating.current = true;
                  duplicate.mutate(agent.id, {
                    onSuccess: (copy) => onDuplicated(copy.id),
                    onError: () => {
                      duplicating.current = false;
                    },
                  });
                }}
                style={{ minBlockSize: "var(--spacing-11)" }}
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconCopy />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {duplicate.isPending
                  ? "Duplicating…"
                  : duplicate.isSuccess
                    ? "Opening copy…"
                    : duplicate.isError
                      ? "Try duplicating again"
                      : "Duplicate"}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                Make your own copy. Its conversations and keys aren't copied.
              </ItemDescription>
            </ItemContent>
          </Item>
          {duplicate.isError ? (
            <Item size="sm">
              <ItemDescription
                className="line-clamp-none text-destructive"
                role="alert"
              >
                {duplicate.error.message}
              </ItemDescription>
            </Item>
          ) : null}
          <Separator />
          <Item
            render={
              <button
                onClick={(event) => reset.reviewReset(event.currentTarget)}
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconRefresh />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Reset your data</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {/* Where memory isn't offered a Bot remembers nothing to delete (see `offersMemory`). */}
                {memory
                  ? "Delete your conversations with it, what it remembers for you, and its scheduled work. You'll see the list first."
                  : "Delete your conversations with it and its scheduled work. You'll see the list first."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {agent.canManage ? (
            <>
              <Separator />
              <Item
                render={
                  <button
                    onClick={(event) =>
                      deletion.requestConfirmation({
                        title: `Delete ${agent.name}?`,
                        description: personal
                          ? "You can still read your conversations with it, but it can't reply. You can't undo this."
                          : "It's deleted for everyone. You can't undo this.",
                        confirmLabel: "Delete Bot",
                        pendingLabel: "Deleting…",
                        failureMessage:
                          "Couldn't delete this Bot. Try again or cancel to review it.",
                        successMessage: "Bot deleted.",
                        trigger: event.currentTarget,
                        fallbackFocus: () => heading.current,
                        run: async () => {
                          await remove.mutateAsync(agent.id);
                          onDeleted();
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
                  <ItemTitle>Delete Bot</ItemTitle>
                  <ItemDescription>
                    {/* A deleted Bot's conversations stay readable (channel-chat.tsx says so there). */}
                    {personal
                      ? "Deletes it. You can still read your conversations with it. You can't undo this."
                      : "Deletes it for everyone. You can't undo this."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
        {reset.confirmation}
        {deletion.confirmation}
      </PageSection>
    </>
  );
}
