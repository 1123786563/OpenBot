import {
  IconChevronRight,
  IconCopy,
  IconEyeOff,
  IconPin,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

/* Key literals stay literal so `t(...)` sees a known key, not `string`. */
const RESET_LINES = {
  conversations: "manage.resetItems.conversations",
  memorySources: "manage.resetItems.memorySources",
  memories: "manage.resetItems.memories",
  routines: "manage.resetItems.routines",
  responsibilities: "manage.resetItems.responsibilities",
  followUps: "manage.resetItems.followUps",
  formedMemories: "manage.resetItems.formedMemories",
  backgroundResearch: "manage.resetItems.backgroundResearch",
  standingApprovals: "manage.resetItems.standingApprovals",
} as const satisfies Partial<Record<keyof ResetPlan, string>>;

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan, t: TFunction<"agents">): string[] {
  return (Object.keys(RESET_LINES) as (keyof typeof RESET_LINES)[])
    .filter((kind) => plan[kind] > 0)
    .map((kind) => t(RESET_LINES[kind], { count: plan[kind] }));
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation("agents");
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data, t) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("manage.reset.title", { name: agent.name })}
          </DialogTitle>
          <DialogDescription>
            {t("manage.reset.description", { name: agent.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {t("manage.reset.countError")}
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">
              {t("manage.reset.done", { name: agent.name })}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{t("manage.reset.nothingToDelete")}</p>
              ) : (
                <>
                  <p>{t("manage.reset.willDelete")}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {t("manage.reset.sharedKept", {
                    count: plan.data.sharedConversationsKept,
                  })}
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {t("manage.reset.ownMemoriesKept")}
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess
              ? t("manage.reset.close")
              : t("manage.reset.cancel")}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending
                ? t("manage.reset.resetting")
                : t("manage.reset.deleteAndReset")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What can be done to a Bot: pin and hide (the person's own list only), duplicate, reset what it
 * has with this person, and — for whoever may manage it — delete it.
 *
 * Navigation is the caller's: hiding and deleting leave the page, duplicating opens the copy.
 */
export function ManageSection({
  agent,
  scope,
  onHidden,
  onDuplicated,
  onDeleted,
}: {
  agent: AgentProfile;
  /** The scope the page read this Bot under; its writes submit under the same one (MT084). */
  scope?: ScopedCache;
  onHidden: () => void;
  onDuplicated: (copyId: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("agents");
  const setPinned = useMutation(
    setAgentPinnedMutationOptions(queryClient, scope),
  );
  const setHidden = useMutation(
    setAgentHiddenMutationOptions(queryClient, scope),
  );
  const duplicate = useMutation(
    duplicateAgentMutationOptions(queryClient, scope),
  );
  const remove = useMutation(
    deleteAgentMutationOptions(queryClient, scope),
  );
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const error = setPinned.error ?? setHidden.error ?? duplicate.error;
  // An administrator put it in this person's list; it stays pinned and cannot be hidden.
  const assigned = agent.assignedToMe === true;

  return (
    <>
      <PageSection title={t("manage.title")}>
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
              <ItemTitle>{t("manage.pinned")}</ItemTitle>
              <ItemDescription>
                {assigned
                  ? t("manage.assignedPinned")
                  : agent.pinned
                    ? t("manage.pinnedDescription")
                    : t("manage.pinDescription")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("manage.pinned")}
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
              <ItemTitle>{t("manage.hidden")}</ItemTitle>
              <ItemDescription>
                {assigned
                  ? t("manage.assignedHidden")
                  : agent.hidden
                    ? t("manage.hiddenDescription")
                    : t("manage.hideDescription")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("manage.hidden")}
                checked={agent.hidden}
                disabled={assigned || setHidden.isPending}
                onCheckedChange={async (hidden) => {
                  await setHidden.mutateAsync({ agentId: agent.id, hidden });
                  if (hidden) onHidden();
                }}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button
                disabled={duplicate.isPending}
                onClick={async () =>
                  onDuplicated((await duplicate.mutateAsync(agent.id)).id)
                }
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconCopy />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("manage.duplicate")}</ItemTitle>
              <ItemDescription>
                {t("manage.duplicateDescription")}
              </ItemDescription>
            </ItemContent>
          </Item>
          <Separator />
          <Item
            render={<button onClick={() => setResetOpen(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconRefresh />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("manage.resetEntry.title")}</ItemTitle>
              <ItemDescription>
                {t("manage.resetEntry.description")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
      {agent.canManage ? (
        <PageSection title={t("manage.deleteTitle", { name: agent.name })}>
          <PageRows>
            <Item
              className="min-h-16"
              render={
                <button onClick={() => setDeleteOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconTrash className="text-destructive" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-destructive">
                  {t("manage.delete")}
                </ItemTitle>
                <ItemDescription>
                  {t("manage.deleteForEveryone")}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="min-h-11 shrink-0">
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      <Dialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("manage.deleteTitle", { name: agent.name })}
            </DialogTitle>
            <DialogDescription>{t("manage.cannotBeUndone")}</DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setDeleteOpen(false)}
              size="sm"
              variant="outline"
            >
              {t("manage.cancel")}
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={async () => {
                await remove.mutateAsync(agent.id);
                onDeleted();
              }}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? t("manage.deleting") : t("manage.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
