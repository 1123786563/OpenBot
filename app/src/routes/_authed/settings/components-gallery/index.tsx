import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { ComponentPreview } from "@/components/component-preview";
import { ReadError } from "@/components/layout/read-status";
import { SettingsItemBackground } from "@/components/settings/background";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { componentListQueryOptions } from "@/lib/components/queries";
import { galleryComponent } from "@/lib/copilot/gallery-registry";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What a Bot can draw, for the person it draws for.
 *
 * The same gallery an administrator governs, with none of the governing. Published components only:
 * an unpublished one is not something any Bot can put on screen, so listing it here would describe a
 * capability nobody has.
 *
 * Each card says what the component shows in the person's words, its `summary`. Not the published
 * description: that is written for the model, names other tools and says "deployment", and was shown
 * here until a person on the personal edition read "Show what this deployment has actually been
 * doing" under Activity report. A playground component has no words but the ones its admin
 * published, so it keeps those.
 */
export const Route = createFileRoute("/_authed/settings/components-gallery/")({
  component: RouteComponent,
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
});

declare module "@tanstack/react-router" {
  interface HistoryState {
    returnGalleryComponent?: string;
  }
}

let lastGallerySelection: { entry: string; name: string } | undefined;

/**
 * The intro and the empty state, by edition. The team edition has an admin who publishes components
 * and decides which Bot uses which. The personal edition has no Admin: every component is published
 * when OpenBot starts and every Bot can use all of them, so there is nothing to say an admin does.
 */
const WORDS = {
  team: {
    intro:
      "Browse components that Bots can display in conversations. An admin controls which components each Bot can use.",
    emptyTitle: "Nothing published yet",
    empty: "When an admin publishes a component, it will show up here.",
  },
  personal: {
    intro:
      "Browse the components your Bots can show in conversations. Every Bot can use all of them.",
    emptyTitle: "No components yet",
    empty: "Components show up here once OpenBot has loaded them.",
  },
} as const;

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());
  const q = useSearch({ strict: false, select: (search) => search.q ?? "" });
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const firstMatch = useRef<HTMLAnchorElement>(null);
  const returnedTile = useRef<HTMLAnchorElement>(null);
  const restoredEntry = useRef<string>(undefined);
  const { __TSR_key: entry, returnGalleryComponent } = useLocation({
    select: (location) => location.state,
  });
  const returnName =
    returnGalleryComponent ??
    (lastGallerySelection?.entry === entry
      ? lastGallerySelection?.name
      : undefined);
  // Until the edition is known, the team edition's words, as everywhere else that reads it.
  const edition =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition ?? "team";
  const words = WORDS[edition];
  const published =
    components.data?.filter((component) => component.published) ?? [];
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = published.filter((component) => {
    const summary =
      galleryComponent(component.name)?.summary ??
      component.publishedDescription ??
      "";
    const text =
      `${component.title} ${summary} ${component.name}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
  useLayoutEffect(() => {
    if (
      !entry ||
      !returnName ||
      components.isFetching ||
      components.isPending ||
      restoredEntry.current === entry
    )
      return;
    restoredEntry.current = entry;
    if (lastGallerySelection?.entry === entry) lastGallerySelection = undefined;
    if (document.activeElement === document.body) {
      (returnedTile.current ?? searchInput.current ?? heading.current)?.focus();
    }
  }, [entry, returnName, components.isFetching, components.isPending]);

  return (
    <CapabilityPage
      description={words.intro}
      headingRef={heading}
      title="Components gallery"
    >
      {components.isPending ? (
        /* The grid's own shape while it loads, so the page is never blank. */
        <div
          aria-busy="true"
          aria-label="Loading components"
          role="status"
          className="mt-12 grid w-full grid-cols-1 gap-4 md:grid-cols-2"
        >
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="aspect-square rounded-lg" />
          ))}
        </div>
      ) : components.error ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't load components."
          retry={components.refetch}
          retryBelow
          retryLabel="Retry components gallery"
          retrying={components.isFetching}
        />
      ) : published.length === 0 ? (
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{words.emptyTitle}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              {words.empty}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section
            aria-label="Search published components"
            className="space-y-2"
          >
            <TextInput
              autoComplete="off"
              controlClassName="min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
              hasClear
              hasAutoCorrect={false}
              hasSpellCheck={false}
              label="Find a component"
              onChange={(value) =>
                void navigate({
                  to: "/settings/components-gallery",
                  search: { q: value || undefined },
                  replace: true,
                  resetScroll: false,
                })
              }
              onEnter={() => firstMatch.current?.focus()}
              placeholder="Name or what it shows"
              ref={searchInput}
              size="lg"
              type="search"
              value={q}
              width="100%"
            />
            {terms.length ? (
              <p className="text-muted-foreground text-sm" role="status">
                {matches.length
                  ? `${matches.length} ${matches.length === 1 ? "component" : "components"} found.`
                  : "No matching components."}
              </p>
            ) : null}
          </section>
          {matches.length ? (
            <section
              aria-label="Published components"
              className="mt-4 grid w-full grid-cols-1 gap-4 md:grid-cols-2"
            >
              {matches.map((component, index) => {
                const spec = galleryComponent(component.name);
                return (
                  /*
                   * No status dot, unlike the Admin tiles. Everything listed here is published by
                   * definition, so a dot saying so would be the same mark on every tile.
                   */
                  <Link
                    className="astryx-component-tile flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-left outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    data-testid={`gallery-${component.name}`}
                    key={component.name}
                    onClick={(event) => {
                      if (
                        entry &&
                        event.button === 0 &&
                        !event.altKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey
                      ) {
                        lastGallerySelection = { entry, name: component.name };
                      }
                    }}
                    params={{ name: component.name }}
                    ref={(link) => {
                      if (index === 0) firstMatch.current = link;
                      if (component.name === returnName)
                        returnedTile.current = link;
                    }}
                    search={{ q: q || undefined }}
                    to="/settings/components-gallery/$name"
                  >
                    <header className="p-4">
                      <h2 className="font-medium text-sm wrap-anywhere">
                        {component.title}
                      </h2>
                      <p className="mt-2 text-muted-foreground text-sm wrap-anywhere">
                        {spec?.summary ?? component.publishedDescription}
                      </p>
                    </header>
                    {spec?.preview ? (
                      <div className="relative mt-auto aspect-[3/2]">
                        <div className="absolute top-0 left-0 h-full w-full p-3">
                          <SettingsItemBackground className="h-full w-full rounded-md" />
                        </div>
                        <div className="absolute top-0 left-0 z-10 h-full w-full p-3">
                          <ComponentPreview
                            kind={component.kind}
                            name={component.name}
                          />
                        </div>
                      </div>
                    ) : null}
                  </Link>
                );
              })}
            </section>
          ) : null}
        </>
      )}
    </CapabilityPage>
  );
}
