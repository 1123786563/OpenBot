import { IconCode, IconTag } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { ComponentPreview } from "@/components/component-preview";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
import { Button } from "@/components/ui/button";
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
      <ItemActions className="text-muted-foreground text-sm">
        {children}
      </ItemActions>
    </Item>
  );
}

function RouteComponent() {
  const { name } = Route.useParams();
  const components = useQuery(componentListQueryOptions());

  if (components.isPending) {
    return (
      <CapabilityPage backButton={BACK} title="Components gallery">
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
      <CapabilityPage backButton={BACK} title="Components gallery">
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load this component.
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
      </CapabilityPage>
    );
  }

  /*
   * Unpublished is treated as absent rather than as a component with a notice on it. Nothing can
   * draw one, so from here there is no difference between not published and not there.
   */
  const component = components.data?.find(
    (entry) => entry.name === name && entry.published,
  );

  if (!component) {
    return (
      <CapabilityPage
        backButton={BACK}
        description="There's no component with that name."
        title="No such component"
      >
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{name}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              It may have been removed or unpublished.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            render={<Link to="/settings/components-gallery" />}
            size="sm"
            variant="outline"
          >
            Back to the gallery
          </Button>
        </Empty>
      </CapabilityPage>
    );
  }

  return (
    <CapabilityPage
      backButton={BACK}
      // What it shows, in the person's words; see the gallery's own page for why not the model's.
      description={
        galleryComponent(component.name)?.summary ??
        component.publishedDescription ??
        undefined
      }
      title={component.title}
    >
      <div className="relative mt-8 aspect-[2/1] overflow-hidden rounded-lg border border-border bg-card">
        <div className="absolute inset-0">
          <SettingsItemBackground className="h-full w-full" />
        </div>
        <div className="absolute inset-0 z-10">
          <ComponentPreview kind={component.kind} name={component.name} />
        </div>
      </div>

      <PageSection title="Details">
        <PageRows>
          <FactRow icon={<IconTag />} label="Kind">
            {component.kind}
          </FactRow>
          <Separator />
          <FactRow icon={<IconCode />} label="Called as">
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs">
              {component.name}
            </code>
          </FactRow>
        </PageRows>
      </PageSection>
    </CapabilityPage>
  );
}
