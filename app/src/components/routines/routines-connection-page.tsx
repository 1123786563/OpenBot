import { IconChevronRight, IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import { ConnectionPage } from "@/components/connections/connection-surface";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { routinesQueryOptions } from "@/lib/routines/queries";
import { NewRoutineButton } from "./new-routine-button";

/** "No routines yet", "1 routine, on", "3 routines, 2 on". */
function routinesSummary(
  routines: { enabled: boolean }[] | undefined,
): string | null {
  if (!routines) return null;
  if (routines.length === 0) return "No routines yet.";
  const on = routines.filter((routine) => routine.enabled).length;
  const count = `${routines.length} routine${routines.length === 1 ? "" : "s"}`;
  if (routines.length === 1) return `${count}, ${on === 1 ? "on" : "off"}.`;
  return `${count}, ${on} on.`;
}

/**
 * Connections > Routines: what Routines is, and the way to the Routines page.
 *
 * Routines is a built-in tool available to every Bot. This page leads to the person's schedules.
 */
export function RoutinesConnectionPage() {
  const routines = useQuery(routinesQueryOptions());
  const heading = useRef<HTMLHeadingElement>(null);
  const summary = routinesSummary(routines.data?.routines);
  return (
    <ConnectionPage
      action={<NewRoutineButton />}
      backButton={{ label: "Connections", linkProps: { to: "/connections" } }}
      description="Schedule work with the built-in Routines tool. Every Bot can set up a routine for you."
      headingRef={heading}
      title="Routines"
    >
      {/* One destination, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item render={<Link to="/routines" />} size="sm">
            <ItemMedia variant="icon">
              <IconClock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Your routines</ItemTitle>
              <ItemDescription>
                {routines.error
                  ? "Open Routines to see them."
                  : (summary ?? "Open Routines to see them.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        {/*
         * The row above keeps its honest fallback sentence, and the failure itself is said out
         * loud beside it with the same in-place Retry every sibling Connections page offers: a
         * silently different grey sentence read as "no routines exist".
         */}
        {routines.error ? (
          <ReadError
            focusAfterRetry={() => heading.current}
            message="Couldn't load your routines."
            retry={routines.refetch}
            retryBelow
            retrying={routines.isFetching}
          />
        ) : null}
      </PageSection>
    </ConnectionPage>
  );
}
