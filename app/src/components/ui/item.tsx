import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn(
        "group/item-group flex w-full flex-col gap-4 has-data-[size=sm]:gap-2.5 has-data-[size=xs]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("my-2", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "group/item flex w-full flex-wrap items-center rounded-lg border dark:border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 [a]:transition-colors [a]:hover:bg-ob-hover",
  {
    variants: {
      variant: {
        default: "border-transparent",
        outline: "border-border",
        muted: "border-transparent bg-ob-muted-surface/50",
      },
      size: {
        default: "gap-2.5 px-3 py-2.5",
        sm: "gap-2.5 px-3 py-2.5",
        xs: "gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type PropsRecord = Record<string, unknown>;
type EventHandler = (...args: unknown[]) => void;

const EVENT_PROP = /^on[A-Z]/;

/**
 * Merge the props Item resolves (slot data attributes, variant classes, forwarded props) with the
 * props already on a `render` element. Base UI's `mergeProps` did this implicitly; stating it here
 * keeps the contract visible: the element's props win, classes and styles are combined, and two
 * handlers on the same event both run — the element's first, then Item's.
 */
function mergeItemProps(
  resolved: PropsRecord,
  element: PropsRecord,
): PropsRecord {
  const merged: PropsRecord = { ...resolved, ...element };
  for (const key of new Set([
    ...Object.keys(resolved),
    ...Object.keys(element),
  ])) {
    const ours = resolved[key];
    const theirs = element[key];
    if (key === "className") {
      merged[key] = cn(
        ours as string | undefined,
        theirs as string | undefined,
      );
    } else if (key === "style") {
      merged[key] = {
        ...(ours as React.CSSProperties | undefined),
        ...(theirs as React.CSSProperties | undefined),
      };
    } else if (
      EVENT_PROP.test(key) &&
      typeof ours === "function" &&
      typeof theirs === "function"
    ) {
      merged[key] = (...args: unknown[]) => {
        (theirs as EventHandler)(...args);
        (ours as EventHandler)(...args);
      };
    }
  }
  return merged;
}

type ItemRenderState = {
  slot: "item";
  variant: NonNullable<VariantProps<typeof itemVariants>["variant"]>;
  size: NonNullable<VariantProps<typeof itemVariants>["size"]>;
};

type ItemRenderFunction = (
  props: React.HTMLAttributes<Element>,
  state: ItemRenderState,
) => React.ReactNode;

type ItemProps = React.ComponentProps<"div"> &
  VariantProps<typeof itemVariants> & {
    /**
     * Draw the row as another element, usually the `<button>` that makes a whole row actionable.
     * Item contributes only its layout classes and slot data attributes; the rendered element
     * keeps its own semantics, so there is never an interactive control nested in another one.
     *
     * Both forms Base UI accepted still work, without Base UI: an element is cloned with the
     * explicit merge in `mergeItemProps`, and a function receives the resolved props and state.
     */
    render?: React.ReactElement | ItemRenderFunction;
  };

function Item({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: ItemProps) {
  const resolvedVariant = variant ?? "default";
  const resolvedSize = size ?? "default";
  const resolvedProps = {
    "data-slot": "item",
    "data-variant": resolvedVariant,
    "data-size": resolvedSize,
    ...props,
    className: cn(
      itemVariants({ variant: resolvedVariant, size: resolvedSize }),
      className,
    ),
  };
  const state: ItemRenderState = {
    slot: "item",
    variant: resolvedVariant,
    size: resolvedSize,
  };

  if (typeof render === "function") {
    return render(resolvedProps, state);
  }

  if (render) {
    return React.cloneElement(
      render as React.ReactElement<PropsRecord>,
      mergeItemProps(resolvedProps, render.props as PropsRecord),
    );
  }

  return <div {...resolvedProps} />;
}

const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 group-has-data-[slot=item-description]/item:translate-y-0.5 group-has-data-[slot=item-description]/item:self-start [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "[&_svg:not([class*='size-'])]:size-4",
        image:
          "size-10 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none",
        className,
      )}
      {...props}
    />
  );
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "line-clamp-1 flex w-fit items-center gap-2 text-sm leading-snug font-medium underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "line-clamp-2 text-left text-sm leading-normal font-normal text-muted-foreground group-data-[size=xs]/item:text-xs [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
};
