import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { AdminComponentPreview } from "@/components/component-preview";
import { SettingsItemBackground } from "@/components/settings/background";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { componentListQueryOptions } from "@/lib/components/queries";
import { cn } from "@/lib/utils";

/**
 * The gallery of compiled components. Governance for any one of them is its own page, because a
 * component carries per-Bot grants, per-function grants and an editable description — more than a
 * tile can hold.
 */
export const Route = createFileRoute("/_authed/admin/components/")({
  component: RouteComponent,
});

/** Placeholder tiles while the list loads: the grid's own shape, claiming nothing. */
const LOADING_TILES = ["a", "b", "c", "d"];

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());
  /** Narrows the tiles by title. Shown only once the list is long enough to need it. */
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const listed = (components.data ?? []).filter((component) =>
    `${component.title} ${component.name}`.toLowerCase().includes(needle),
  );

  return (
    <CapabilityPage
      description="Choose which components each Bot can display. Published components are available to all Bots by default. Changes and blocked requests appear in Audit."
      title="UI components"
    >
      {/*
       * Pending, error, empty, rows — in that order. Pending draws the grid's own shape as
       * placeholder tiles rather than nothing, and it has to come first: the empty sentence
       * would otherwise stand there asserting there are no components for as long as the
       * fetch takes.
       */}
      {components.isPending ? (
        <div
          aria-busy="true"
          aria-label="Loading components"
          className="mt-12 grid w-full grid-cols-1 gap-4 md:grid-cols-2"
          role="status"
        >
          {LOADING_TILES.map((key) => (
            <div
              className="aspect-square rounded-lg border border-border"
              key={key}
            >
              <div className="min-h-28 p-4">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="mt-2 h-3 w-48" />
              </div>
              <div className="p-3">
                <Skeleton className="h-[calc(100%-4rem)] w-full rounded-md" />
              </div>
            </div>
          ))}
        </div>
      ) : components.error ? (
        <div className="mt-12 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load components.
          </p>
          <Button
            disabled={components.isFetching}
            onClick={() => void components.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {components.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : components.data?.length === 0 ? (
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>No components yet</EmptyTitle>
            <EmptyDescription className="text-pretty">
              Components your Bots can use will show here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {(components.data?.length ?? 0) > 8 ? (
            <Input
              aria-label="Search components"
              className="mt-12"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by component name"
              value={search}
            />
          ) : null}
          {listed.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground" role="status">
              Nothing matches “{search.trim()}”.
            </p>
          ) : (
            <div className="mt-4 grid w-full grid-cols-1 gap-4 md:grid-cols-2">
              {listed.map((component) => (
            /*
             * A real link rather than a button, so a component can be opened in a new tab the way
             * anything else addressable can. Its name comes from the title and description below:
             * the preview is `aria-hidden`, so nothing inside it reaches the accessible name.
             */
            <Link
              className="astryx-component-tile flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-testid={`component-${component.name}`}
              key={component.name}
              params={{ name: component.name }}
              to="/admin/components/$name"
            >
              <div className="min-h-28 p-4">
                <div className="flex flex-row items-center gap-2">
                  <div
                    className={cn("inline-block size-1.5 rounded-full", {
                      "bg-muted-foreground": !component.published,
                      "bg-success": component.published,
                    })}
                  />
                  <h4 className="line-clamp-1 font-medium text-sm">
                    {component.title}
                  </h4>
                </div>
                <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
                  {component.draftDescription}
                </p>
              </div>
              <div className="relative flex-1">
                {/*
                 * The artwork is sized explicitly. Left to itself it carries a viewBox and no width
                 * or height, which resolves to the full width and a height derived from its 3:2
                 * ratio — taller than this box, and `overflow-hidden` clips at the border rather
                 * than the padding, so it escaped the inset and met the tile's corners square.
                 * `slice` crops it to whatever shape it is given instead.
                 */}
                <div className="absolute top-0 left-0 h-full w-full p-3">
                  <SettingsItemBackground className="h-full w-full rounded-md" />
                </div>
                <div className="absolute top-0 left-0 z-10 h-full w-full p-3">
                  <AdminComponentPreview
                    kind={component.kind}
                    name={component.name}
                  />
                </div>
              </div>
            </Link>
              ))}
            </div>
          )}
        </>
      )}
    </CapabilityPage>
  );
}
