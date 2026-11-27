import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `prose` is the default because configuration is mostly reading, and every screen uses it so none is
 * wider than another. It is `max-w-3xl`, 768px: room for a row's label
 * and its control side by side. Page and section descriptions use the column's full width, so they line
 * up with the rows under them.
 *
 * `full` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. The page is exactly the window's height and does not scroll: the title sits
 * at the pane's left edge, lined up with the table's first column rather than centred above a table
 * that is not, and the children fill what is left, so the table can be the one thing that scrolls.
 * It is not a licence for anything else to be wide. It is no column, so `PageShell` draws it itself.
 */
export type ShellWidth = "prose" | "full";

/**
 * The scroller and the centred `prose` column every configuration screen sits in, without the bar. The
 * bar needs the router, so `PageShell` draws it and passes `bar` to say whether it did; this file
 * imports nothing from the router so the extension can render the same column.
 */
export function PageColumn({
  bar,
  children,
  className,
}: {
  bar: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <>
      {/*
       * The scroller. Every shell — app, admin, settings — is exactly the window's height and holds
       * the page in an inset panel that never grows past it, so a page taller than the window
       * scrolls here, inside the panel, and the panel's rounded corners stay on screen.
       *
       * `min-h-0` is the load-bearing half of `min-h-0 flex-1`: a flex item's default `min-height:
       * auto` refuses to shrink below its content, so `flex-1` alone would grow this past the panel
       * and the overflow would be clipped instead of scrolled.
       *
       * Separate from the centred column below so the scrollbar rides the pane's edge instead of
       * appearing inside the measure with content either side of it.
       */}
      <VStack className="min-h-0 flex-1" isScrollable>
        <VStack
          className={cn(
            /*
             * The page's rhythm lives here, so a screen gets it by being a child rather than by
             * choosing a margin. The title block sits 32px above whatever comes first, tighter than
             * the 48px between sections, so the heading reads as part of the page it introduces
             * rather than as one more block at the same distance as all the others. Tabs are the
             * exception: they belong to the title, so they sit 24px under it and the content 32px
             * under them. These outrank the child's own `mt-*`, which is the point: a first section
             * or notice keeps its usual margin everywhere else and loses it only here.
             */
            "mx-auto flex w-full flex-col px-4 pb-16",
            "[&>header+*]:mt-8 [&>header+nav]:mt-6 [&>header+nav+*]:mt-8",
            // Without a bar above it the heading keeps the full original space.
            bar ? "pt-8" : "pt-12",
            "max-w-3xl",
            className,
          )}
        >
          {children}
        </VStack>
      </VStack>
    </>
  );
}

/** The page's title, its one primary action and its description. */
export function PageHeader({
  action,
  description,
  eyebrow,
  headingRef,
  title,
}: {
  action?: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  headingRef?: React.Ref<HTMLHeadingElement>;
  title: string;
}) {
  return (
    <VStack as="header" gap={2} data-slot="page-header">
      {eyebrow}
      <HStack align="center" justify="between" gap={3} wrap="wrap">
        <VStack
          as="h1"
          className="min-w-0 break-words font-heading text-2xl font-semibold tracking-tight"
          data-slot="page-title"
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
        >
          {title}
        </VStack>
        {action}
      </HStack>
      {description ? (
        <Text
          as="p"
          color="secondary"
          textWrap="pretty"
          className="leading-relaxed"
        >
          {description}
        </Text>
      ) : null}
    </VStack>
  );
}

/**
 * A titled group of rows.
 *
 * The gap above a section is deliberately large. These pages are lists of unrelated decisions, and
 * the space is what stops the eye running two of them together — it is doing the work a divider
 * would otherwise do, without drawing a line.
 */
export function PageSection({
  action,
  children,
  className,
  description,
  headingId,
  headingRef,
  id,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  headingId?: string;
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** Where a screen sends the person to this section by name. */
  id?: string;
  title?: string;
}) {
  return (
    <VStack as="section" className={cn("mt-12", className)} id={id}>
      {title ? (
        <HStack
          align="center"
          justify="between"
          gap={3}
          wrap="wrap"
          className="min-h-8"
        >
          {/*
           * Close to body size and lighter than the page title, so the sections read as parts of
           * the page rather than as a second row of titles competing with it.
           */}
          <VStack
            as="h2"
            className={cn(
              "text-balance break-words text-base font-semibold",
              (headingRef || headingId) && "scroll-mt-4",
            )}
            id={headingId}
            ref={headingRef}
            tabIndex={headingRef || headingId ? -1 : undefined}
          >
            {title}
          </VStack>
          {action}
        </HStack>
      ) : null}
      {description ? (
        <Text
          as="p"
          color="secondary"
          textWrap="pretty"
          className="mt-1 leading-relaxed"
        >
          {description}
        </Text>
      ) : null}
      {children}
    </VStack>
  );
}

/**
 * The card that rows live in.
 *
 * Rows are `<Item size="sm">` with a `<Separator />` between them; this is only the border around
 * them. Rendering nothing when there is nothing is deliberate — an empty bordered box reads as a
 * thing that failed to load, where absence reads as nothing to see yet.
 */
export function PageRows({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    /*
     * The rows are squared off and the card clips them. `Item` carries `rounded-lg` of its own, which
     * inside a card of divided rows painted a hover as a floating pill: a middle row has no corners,
     * and the first and last cannot be concentric with the card while sitting a border inside it.
     *
     * Every row is at least 56px, whatever it holds. A title over a description is 65px; a lone
     * line would be 48px and look stunted beside it, so it is held up to the floor. A description
     * that wraps to a second line still grows the row rather than being clipped.
     */
    <VStack
      className={cn(
        "mt-4 overflow-hidden rounded-lg border border-border bg-card dark:border-transparent",
        "[&_[data-slot=item]]:rounded-none [&_[data-slot=item]]:min-h-14",
        // Dividers stop 16px short of each edge, lined up with the rows' text, as Linear draws them.
        // Any depth: a screen may wrap each row and its divider, as Admin does to stagger them in.
        "[&_[data-slot=separator][data-orientation=horizontal]]:mx-4 [&_[data-slot=separator][data-orientation=horizontal]]:w-auto",
        className,
      )}
    >
      {children}
    </VStack>
  );
}

/**
 * The card a page-sized form sits in: the fields, then its buttons on the right.
 *
 * For a screen that exists to fill something in, reached from a list by its Add button, with
 * `PageShell`'s back button returning to it. The same border and fill as `PageRows`, so a form and
 * a list read as the same kind of surface, padded rather than divided because it holds fields.
 */
export function PageCard({
  children,
  className,
  footer,
}: {
  children: React.ReactNode;
  className?: string;
  /** The form's buttons, Cancel then the primary action. */
  footer?: React.ReactNode;
}) {
  return (
    <VStack
      className={cn(
        "rounded-lg border border-border bg-card p-4 dark:border-transparent",
        className,
      )}
    >
      {children}
      {footer ? (
        <HStack className="mt-6" gap={2} justify="end" wrap="wrap">
          {footer}
        </HStack>
      ) : null}
    </VStack>
  );
}

export function InlineEmpty({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <VStack gap={1} paddingBlock={3}>
      <Text as="p" size="sm" weight="semibold">
        {title}
      </Text>
      <Text as="p" color="secondary" size="sm">
        {children}
      </Text>
    </VStack>
  );
}

/**
 * What a section says when it has nothing to list, drawn as shadcn's empty state.
 *
 * A dashed box where the rows would be, so the section keeps its shape: the icon says what kind of
 * thing would be here, the title says that there is none, the description says how one arrives, and
 * `action` is the button that adds the first one when the page has one to offer.
 *
 * Only the description is required. A section that is empty for a reason rather than because
 * nothing was added yet (a feature turned off, a search with no match) can say just that.
 */
export function PageEmpty({
  action,
  children,
  icon: Icon,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
}) {
  return (
    <VStack
      align="center"
      gap={3}
      data-slot="empty"
      className="relative isolate mt-4 overflow-hidden rounded-xl border border-dashed border-border px-4 py-8 text-center sm:px-8"
    >
      <VStack as="span" aria-hidden="true" className="empty-pattern" />
      {Icon ? (
        <HStack
          align="center"
          justify="center"
          className="size-8 rounded-lg bg-muted [&_svg]:size-4"
          aria-hidden="true"
        >
          <Icon />
        </HStack>
      ) : null}
      {title ? (
        <Text as="p" weight="semibold">
          {title}
        </Text>
      ) : null}
      {children ? (
        <Text
          as="div"
          color="secondary"
          textWrap="balance"
          className="max-w-prose leading-relaxed"
        >
          {children}
        </Text>
      ) : null}
      {action}
    </VStack>
  );
}
