import { IconCode, IconTag } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { ComponentPreview } from "@/components/component-preview";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { componentListQueryOptions } from "@/lib/components/queries";
import { galleryComponent } from "@/lib/copilot/gallery-registry";

/** The same way back from every state this route can be in. */
const BACK = {
  label: "Components gallery",
  linkProps: { to: "/settings/components-gallery" },
} as const;

/**
 * One component, drawn as large as this column allows, and nothing to change.
 *
 * Deliberately not the Admin detail page with its controls hidden. That page is built out of four
 * mutations and three kinds of row; threading a read-only flag through all of it would leave every
 * row carrying a branch for a case it mostly does not have.
 */
export const Route = createFileRoute(
  "/_authed/settings/components-gallery/$name",
)({
  component: RouteComponent,
  validateSearch: z.object({ q: z.string().optional().catch(undefined) }),
});

/** A read-only fact: the label on the left, the value against the right. */
function FactRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions className="min-w-0 max-w-full text-muted-foreground text-sm max-sm:basis-full">
        {children}
      </ItemActions>
    </Item>
  );
}

function RouteComponent() {
  const { name } = Route.useParams();
  const q = useSearch({ strict: false, select: (search) => search.q });
  const back = {
    ...BACK,
    linkProps: {
      ...BACK.linkProps,
      search: { q },
      state: { returnGalleryComponent: name },
    },
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const components = useQuery(componentListQueryOptions());
  const component = components.data?.find(
    (entry) => entry.name === name && entry.published,
  );
  const ready = components.isSuccess;
  useLayoutEffect(() => {
    if (ready && document.activeElement === document.body) {
      heading.current?.focus();
    }
  }, [ready]);

  if (components.isPending) {
    return (
      <CapabilityPage
        backButton={back}
        headingRef={heading}
        title="Components gallery"
      >
        <div
          aria-busy="true"
          aria-label="Loading this component"
          role="status"
          className="mt-8"
        >
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
      </CapabilityPage>
    );
  }

  if (components.error) {
    return (
      <CapabilityPage
        backButton={back}
        headingRef={heading}
        title="Components gallery"
      >
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't load this component."
          retry={components.refetch}
          retryBelow
          retryLabel="Retry component"
          retrying={components.isFetching}
        />
      </CapabilityPage>
    );
  }

  /*
   * Unpublished is treated as absent rather than as a component with a notice on it. Nothing can
   * draw one, so from here there is no difference between not published and not there.
   */

  if (!component) {
    return (
      <CapabilityPage
        backButton={back}
        description="There's no component with that name."
        headingRef={heading}
        title="No such component"
      >
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="wrap-anywhere">{name}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              It may have been removed or unpublished.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CapabilityPage>
    );
  }

  const spec = galleryComponent(component.name);
  return (
    <CapabilityPage
      backButton={back}
      headingRef={heading}
      // What it shows, in the person's words; see the gallery's own page for why not the model's.
      description={spec?.summary ?? component.publishedDescription ?? undefined}
      title={component.title}
    >
      <PageSection
        description={
          spec?.preview
            ? "This example uses sample data."
            : spec || component.kind === "sandboxed"
              ? "Bots with access can show this component in a conversation."
              : "This version of OpenBot cannot display a sample for this component."
        }
        title={spec?.preview ? "Preview" : "Preview unavailable"}
      >
        {spec?.preview ? (
          <ComponentPreview
            fullSize
            kind={component.kind}
            name={component.name}
          />
        ) : null}
      </PageSection>

      <PageSection title="Details">
        <PageRows>
          <FactRow icon={<IconTag />} label="Kind">
            {component.kind === "sandboxed"
              ? "Custom component"
              : component.kind}
          </FactRow>
          <Separator />
          <FactRow icon={<IconCode />} label="Component name">
            <code className="min-w-0 wrap-anywhere rounded bg-foreground/5 px-1.5 py-0.5 text-sm">
              {component.name}
            </code>
          </FactRow>
        </PageRows>
      </PageSection>
    </CapabilityPage>
  );
}
