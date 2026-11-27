import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { IconRadar } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deploymentCapabilitiesQueryOptions,
  offersMemory,
} from "@/lib/deployment/queries";
import { proactiveAllowedQueryOptions } from "@/lib/proactive";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

/**
 * The person's own switch for every one of their Bots' check-ins at once. Off stops every Bot's
 * background checks for them before any model call; each Bot's own setting is kept, so turning this
 * back on restores them as they were.
 *
 * When an admin turned check-ins off for this person, the switch is off and cannot be changed, and
 * says who turned it off. Their own choice is kept underneath for when the admin turns it back on.
 */
export function CheckInsSection({
  compact = false,
}: {
  compact?: boolean;
} = {}) {
  const preferences = useUserPreferences();
  const allowed = useQuery(proactiveAllowedQueryOptions());
  // Each Bot's own check-ins are on its Memory page, or on What it can do where there is no memory.
  const botPage = offersMemory(
    useQuery(deploymentCapabilitiesQueryOptions()).data,
  )
    ? "Memory"
    : "What it can do";
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  // The switch follows the press while the save is out, and the stored answer after.
  const chosen =
    (save.isPending ? save.variables?.proactive : undefined) ??
    preferences.data?.proactive;
  const byAdmin = allowed.data === false;
  const on = chosen === "on" && !byAdmin;
  const setCheckIns = (next: boolean) =>
    save.mutate({ proactive: next ? "on" : "off" });
  return (
    <PageSection
      description={
        compact
          ? undefined
          : "Your Bots check the apps they can read and tell you when something needs you, at most once an hour. They never act without asking."
      }
      title={compact ? undefined : "Check-ins"}
    >
      {preferences.isPending ? (
        <div aria-busy="true" aria-label="Loading check-ins" role="status">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <Skeleton className="size-full" />
              </ItemMedia>
              <ItemContent className="gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-56" />
              </ItemContent>
            </Item>
          </PageRows>
        </div>
      ) : preferences.error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load your check-ins.
          </p>
          <Button
            disabled={preferences.isFetching || allowed.isFetching}
            onClick={() => {
              void preferences.refetch();
              void allowed.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {preferences.isFetching || allowed.isFetching
              ? "Retrying…"
              : "Retry"}
          </Button>
        </div>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconRadar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {compact ? "Check-ins from all your Bots" : "All your Bots"}
              </ItemTitle>
              <ItemDescription>
                {byAdmin
                  ? "Turned off by your admin."
                  : on
                    ? compact
                      ? "On. Your Bots check what they can read and tell you when something needs you, at most once an hour."
                      : `On. Each Bot's own check-ins are on its ${botPage} page.`
                    : "Off. None of your Bots check in for you."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <AstryxSwitch
                disabledMessage={
                  byAdmin ? "Turned off by your admin." : undefined
                }
                isDisabled={byAdmin}
                isLabelHidden
                isLoading={save.isPending}
                label="Check-ins for all your Bots"
                onChange={setCheckIns}
                value={on}
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
      {save.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
    </PageSection>
  );
}
